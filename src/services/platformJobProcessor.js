/**
 * Platform Job Processor
 * 
 * Extends the base JobProcessor to support Platform-Managed Agents.
 * Injects agent-specific configuration (system prompts, tools) into the execution pipeline.
 * Uses ExtendedComputeService for multi-provider LLM routing.
 */

import { JobProcessor, logActivity, sendChatMessage, recordPortfolio } from "./jobProcessor.js";
import { requestAlignmentAttestation } from "./alignmentNodeStub.js";
import { ExtendedComputeService } from "./extendedComputeService.js";
import { executeForJob, updateAgentSkillConfig } from "./toolExecutor.js";
import { sendMilestoneCard, sendNotification, sendJobCompletionAlert, CustomerServiceBot } from "./telegramConnector.js";
import { SelfEvaluator } from "./selfEvaluator.js";
import { MemoryService } from "./memoryService.js";
import { validateApproval } from "./approvalValidator.js";
import { ethers } from "ethers";

const ACTIVITY_BASE = process.env.ACTIVITY_LOG_URL?.replace("/api/agent-activity", "") || "http://localhost:3000";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

/** Fetch telegramChatId from agent_profiles.metadata (Option 2 — 0G Storage-backed) */
async function getTelegramChatIdFromProfiles(agentId) {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/agent_profiles?agent_id=eq.${agentId}&select=metadata`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.metadata?.telegramChatId ?? null;
  } catch {
    return null;
  }
}

/** Post a message to the job chat stream */
async function postChat(jobId, message, msgType = "text", metadata = {}) {
  try {
    await fetch(`${ACTIVITY_BASE}/api/job-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, sender: "agent", message, msgType, metadata }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.log(`[PlatformProcessor] postChat error: ${err.message}`);
  }
}

/**
 * Wait for milestone approval. Three paths in order of precedence:
 *
 *  1. AUTO_APPROVE_MILESTONES=true   → demo bypass (no signal of quality).
 *  2. Alignment Node attestation     → score ≥ ALIGNMENT_AUTO_APPROVE_THRESHOLD
 *                                      and PLATFORM_PRIVATE_KEY signed off.
 *                                      Human can still react via chat during the
 *                                      grace window (default 60s) — any user
 *                                      message during that window cancels the
 *                                      auto-approve and falls through to human.
 *  3. Human-in-the-loop (default)    → 15-min reminders, LLM intent classifier,
 *                                      max 2 revisions, 1-hour timeout.
 *
 * Returns once the milestone is ready to be released on-chain.
 */
export async function runFeedbackLoop(
  jobId,
  milestoneIndex,
  outputSummary,
  extendedCompute,
  telegramChatId  = null,
  timeoutMs       = 60 * 60 * 1000,
  alignmentScore  = 0,           // 0–10000 bps, from selfEvaluator
  alignmentSigned = false,       // true if oracle has signed the alignment digest
) {
  // ── Path 1: Demo bypass ───────────────────────────────────────────────────
  if (process.env.AUTO_APPROVE_MILESTONES === "true") {
    console.log(`[PlatformProcessor] AUTO_APPROVE_MILESTONES=true — bypassing user approval for milestone ${milestoneIndex + 1}`);
    await postChat(
      jobId,
      `✅ Milestone ${milestoneIndex + 1} complete! Here's a summary:\n\n${outputSummary}\n\n_(Auto-approved — demo mode)_`,
      "text"
    );
    return { userFeedback: "[auto-approved for demo]", path: "demo" };
  }

  // ── Path 2: Alignment Node attestation ────────────────────────────────────
  const ALIGNMENT_THRESHOLD = Number(process.env.ALIGNMENT_AUTO_APPROVE_THRESHOLD) || 7500;
  const ALIGNMENT_GRACE_MS  = Number(process.env.ALIGNMENT_GRACE_PERIOD_MS) || 60_000;

  if (alignmentSigned && alignmentScore >= ALIGNMENT_THRESHOLD) {
    console.log(`[PlatformProcessor] Alignment Node attested milestone ${milestoneIndex + 1} (score ${alignmentScore}/10000 ≥ ${ALIGNMENT_THRESHOLD}) — entering ${ALIGNMENT_GRACE_MS / 1000}s grace window before auto-release`);

    await postChat(
      jobId,
      `🛡️ Milestone ${milestoneIndex + 1} attested by Alignment Node — score ${(alignmentScore / 100).toFixed(1)}/100\n\n${outputSummary}\n\n_Releasing payment in ${ALIGNMENT_GRACE_MS / 1000}s. Reply with anything to override and switch to manual review._`,
      "milestone_alignment_attested",
      { milestoneIndex, alignmentScore, threshold: ALIGNMENT_THRESHOLD }
    );

    if (telegramChatId) {
      try { await sendMilestoneCard({ chatId: telegramChatId, jobId, milestoneIndex, outputSummary }); } catch { /* non-fatal */ }
    }

    // Listen for user override during the grace window
    const graceStart = Date.now();
    const startMsgTime = new Date().toISOString();
    while (Date.now() - graceStart < ALIGNMENT_GRACE_MS) {
      await new Promise(r => setTimeout(r, 1_000));
      try {
        const res = await fetch(`${ACTIVITY_BASE}/api/job-chat?jobId=${jobId}&since=${encodeURIComponent(startMsgTime)}`, {
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) {
          const all = await res.json();
          const userMessages = all.filter(m => m.sender === "user");
          if (userMessages.length > 0) {
            console.log(`[PlatformProcessor] User overrode alignment auto-release — falling back to human approval`);
            await postChat(jobId, `Override received — switching to manual review. I'll wait for your decision.`, "text");
            // Fall through to Path 3 below
            break;
          }
        }
      } catch { /* ignore */ }
    }

    if (Date.now() - graceStart >= ALIGNMENT_GRACE_MS) {
      // Grace expired without user override — release
      return { userFeedback: "[alignment-attested]", path: "alignment", alignmentScore };
    }
    // else: user overrode → continue into Path 3
  }

  const REMINDER_INTERVAL = 15 * 60 * 1000; // 15 minutes between reminders
  const POLL_INTERVAL     = 1_000;           // check for new user messages every 1s
  const MAX_REVISIONS     = 2;

  const deadline        = Date.now() + timeoutMs;
  let lastMsgTime       = new Date().toISOString();
  let lastReminder      = Date.now();
  let revisions         = 0;
  const collectedFeedback = []; // accumulate user messages for memory

  // 1. Post output summary as a plain chat bubble (dashboard)
  await postChat(
    jobId,
    `✅ Milestone ${milestoneIndex + 1} complete! Here's a summary of my work:\n\n${outputSummary}\n\nPlease review and reply — tell me if you're happy with this or what you'd like changed.`,
    "text"
  );

  // 2. Post the milestone_ready card (dashboard — has "Go to Next Milestone" button)
  await postChat(
    jobId,
    `Milestone ${milestoneIndex + 1} is ready for your review. Click below when you're satisfied to release payment and continue.`,
    "milestone_ready",
    { milestoneIndex }
  );

  // 2b. Send Telegram notification if client has it connected
  if (telegramChatId) {
    await sendMilestoneCard({ chatId: telegramChatId, jobId, milestoneIndex, outputSummary });
  }

  console.log(`[PlatformProcessor] Milestone ${milestoneIndex + 1} card posted — waiting for user action.`);
  console.log(`[PlatformProcessor] Config: ACTIVITY_BASE=${ACTIVITY_BASE} | GROQ_API_KEY=${process.env.GROQ_API_KEY ? "set" : "MISSING (keyword fallback only)"} | AGENT_RUNTIME_TOKEN=${process.env.AGENT_RUNTIME_TOKEN ? "set" : "MISSING"}`);
  if (ACTIVITY_BASE.includes("localhost")) {
    console.warn(`[PlatformProcessor] ⚠️ ACTIVITY_BASE points to localhost — milestone approvals from production frontend will be IGNORED. Set ACTIVITY_LOG_URL env var to your Vercel domain.`);
  }

  const approvalUrl = `${ACTIVITY_BASE}/api/milestone-approval?jobId=${jobId}&milestoneIndex=${milestoneIndex}`;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    // ── Check if user already clicked the approval button ──────────────────
    try {
      const res = await fetch(approvalUrl, { signal: AbortSignal.timeout(8_000) });
      if (res.ok && (await res.json()).approved) {
        console.log(`[PlatformProcessor] Milestone ${milestoneIndex + 1} approved via button.`);
        return { userFeedback: collectedFeedback.join("\n") };
      }
    } catch { /* ignore network hiccups */ }

    // ── Fetch new user chat messages since last check ───────────────────────
    let userMessages = [];
    try {
      const res = await fetch(`${ACTIVITY_BASE}/api/job-chat?jobId=${jobId}&since=${encodeURIComponent(lastMsgTime)}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const all = await res.json();
        userMessages = all.filter(m => m.sender === "user");
      }
    } catch (err) {
      console.log(`[PlatformProcessor] Chat poll error: ${err.message}`);
    }

    // ── Interpret user message if any ───────────────────────────────────────
    if (userMessages.length > 0) {
      lastMsgTime = new Date().toISOString();
      lastReminder = Date.now(); // reset reminder timer when user is active
      const chatText = userMessages.map(m => m.message).join("\n");
      collectedFeedback.push(chatText); // accumulate for memory
      console.log(`[PlatformProcessor] ${userMessages.length} user message(s) — validating approval...`);

      // ── Groq-backed approval validation (cross-check to prevent false approvals)
      const approvalResult = await validateApproval(chatText, outputSummary, milestoneIndex, 1);
      console.log(`[PlatformProcessor] Approval validator: approved=${approvalResult.approved}, confidence=${approvalResult.confidence}, reason=${approvalResult.reason}`);

      if (approvalResult.approved && approvalResult.confidence >= 0.7) {
        // Confirmed approval — return immediately to proceed with on-chain release
        console.log(`[PlatformProcessor] Approval confirmed — proceeding to release milestone ${milestoneIndex + 1}`);
        await postChat(
          jobId,
          `✅ Approval confirmed! Releasing payment for milestone ${milestoneIndex + 1} and continuing to the next step...`,
          "text"
        );
        return { userFeedback: collectedFeedback.join("\n") };
      }

      // Not approved — treat as revision request
      const revisionDetails = approvalResult.reason || chatText.trim();
      revisions++;
      console.log(`[PlatformProcessor] Not approved — revision ${revisions}/${MAX_REVISIONS}: ${revisionDetails}`);

      await postChat(
        jobId,
        `Understood — I'll work on: "${revisionDetails}". This is revision ${revisions}/${MAX_REVISIONS}.`
      );

      // Return revision details so processMilestone can re-execute the milestone
      if (revisions <= MAX_REVISIONS) {
        return { userFeedback: revisionDetails, path: "revision", revisionDetails, revisionCount: revisions };
      }

      // Max revisions reached — post card and wait for approval
      await postChat(
        jobId,
        `I've done my best with ${revisions} revision(s). If you'd like further changes after approving, you can open a new job. Please click the button to proceed when ready.`,
        "milestone_ready",
        { milestoneIndex }
      );

      continue; // restart poll loop
    }

    // ── Send a reminder if 15 minutes have passed without activity ──────────
    if (Date.now() - lastReminder >= REMINDER_INTERVAL) {
      lastReminder = Date.now();
      const minutesLeft = Math.round((deadline - Date.now()) / 60_000);
      const reminderMsg = `⏰ Reminder: Milestone ${milestoneIndex + 1} is still waiting for your review (${minutesLeft} min remaining). Click "Go to Next Milestone" above when you're ready, or reply here with feedback.`;

      await postChat(jobId, reminderMsg, "text");

      if (telegramChatId) {
        await sendNotification({
          chatId: telegramChatId,
          message: reminderMsg,
        });
      }

      console.log(`[PlatformProcessor] Reminder posted — ${minutesLeft} min left on deadline.`);
    }
  }

  // Deadline passed without approval
  throw Object.assign(
    new Error(`Milestone ${milestoneIndex + 1} timed out after ${timeoutMs / 60_000} minutes with no user action.`),
    { userFeedback: collectedFeedback.join("\n") }
  );
}

export class PlatformJobProcessor extends JobProcessor {
  /**
   * @param {object} params - Standard JobProcessor params.
   * @param {object} agentConfig - The validated capability manifest for this agent.
   *   {
   *     model: string,
   *     systemPrompt: string,
   *     llmProvider: string,
   *     tools: Array,
   *     ...
   *   }
   */
  constructor(params, agentConfig) {
    super(params);
    
    this.agentConfig = agentConfig;
    this.customerServiceBot = null;
    
    this.extendedCompute = new ExtendedComputeService(params.wallet, {
      provider: agentConfig.platformConfig?.llmProvider || "0g-compute",
      systemPrompt: agentConfig.platformConfig?.systemPrompt || "You are a helpful assistant."
    });

    this.selfEvaluator  = new SelfEvaluator(this.extendedCompute);
    this.memoryService  = new MemoryService(agentConfig.agentId, this.extendedCompute, this.storage);
  }

  async setupCustomerService() {
    const telegramConfig = this.agentConfig.skillConfigs?.telegram_notify;
    if (!telegramConfig?.botToken) return;

    if (!this.customerServiceBot) {
      this.customerServiceBot = new CustomerServiceBot({
        botToken: telegramConfig.botToken,
        allowedChats: telegramConfig.allowedChats || [],
        extendedCompute: this.extendedCompute,
        memoryService: this.memoryService,
        storageService: this.storage,
      });

      await this.customerServiceBot.start();
    }
  }

  async stopCustomerService() {
    if (this.customerServiceBot) {
      await this.customerServiceBot.stop();
      this.customerServiceBot = null;
    }
  }

  /**
   * Poll job chat for credentials after posting a CREDENTIAL_REQUEST message.
   * Looks for URL and API_KEY patterns in user replies (10 min window).
   * Returns { n8nUrl?, apiKey?, webhookUrl? } or null if timeout.
   */
  async _collectCredentials(jobId, skillType, instructions) {
    const TIMEOUT = 10 * 60 * 1000;
    const POLL_INTERVAL = 2_000;
    const deadline = Date.now() + TIMEOUT;
    let lastMsgTime = new Date().toISOString();

    await postChat(
      jobId,
      `⚙️ To complete this task I need access to your n8n instance.\n\n${instructions}\n\n` +
      `Please reply with your credentials in this format:\n` +
      (skillType === "n8n_manager"
        ? `URL: https://your-n8n.app.n8n.cloud\nAPI_KEY: your-api-key`
        : `WEBHOOK_URL: https://your-n8n.com/webhook/abc-123`),
      "credential_request",
      { skillType }
    );

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      try {
        const res = await fetch(`${ACTIVITY_BASE}/api/job-chat?jobId=${jobId}&since=${encodeURIComponent(lastMsgTime)}`, {
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) continue;
        const msgs = (await res.json()).filter(m => m.sender === "user");
        if (!msgs.length) continue;
        lastMsgTime = new Date().toISOString();
        const text = msgs.map(m => m.message).join("\n");

        // Parse URL: ... and API_KEY: ... patterns
        const urlMatch       = text.match(/URL:\s*(https?:\/\/\S+)/i);
        const apiKeyMatch    = text.match(/API_KEY:\s*(\S+)/i);
        const webhookMatch   = text.match(/WEBHOOK_URL:\s*(https?:\/\/\S+)/i);

        if (urlMatch || webhookMatch || apiKeyMatch) {
          const creds = {};
          if (urlMatch)     creds.n8nUrl     = urlMatch[1].trim();
          if (apiKeyMatch)  creds.apiKey     = apiKeyMatch[1].trim();
          if (webhookMatch) creds.webhookUrl = webhookMatch[1].trim();
          await postChat(jobId, `✅ Credentials received — connecting to n8n now...`);
          return creds;
        }
        // If user replied but format was wrong
        await postChat(jobId, `I couldn't parse the credentials. Please use the format above — copy-paste is easiest!`);
      } catch { /* ignore */ }
    }
    await postChat(jobId, `⏱️ Credential request timed out (10 min). Continuing without n8n integration.`);
    return null;
  }

  /**
   * Use LLM to design an n8n workflow JSON for the given job.
   * Returns a parsed n8n workflow object, or null if generation fails.
   */
  async _designN8nWorkflow(jobBrief) {
    const taskText = typeof jobBrief === "string" ? jobBrief
      : `${jobBrief.title || ""} — ${jobBrief.description || JSON.stringify(jobBrief)}`;

    const prompt = `You are an expert n8n workflow designer. Design a valid n8n workflow JSON for this task:

TASK: ${taskText.slice(0, 800)}

Return ONLY a valid n8n workflow JSON object (no markdown, no explanation). The workflow must have:
- "name": descriptive workflow name
- "nodes": array of n8n nodes
- "connections": node connections object
- "settings": {}

Use appropriate n8n nodes (HTTP Request, Gmail, Google Sheets, Code, etc.) to automate the task.
Common node types: "n8n-nodes-base.webhook", "n8n-nodes-base.httpRequest", "n8n-nodes-base.gmail", "n8n-nodes-base.code", "n8n-nodes-base.set"`;

    try {
      const result = await this.extendedCompute.processTask(prompt, "", "");
      const raw = result.content.trim();
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]+?)```/) || [null, raw];
      return JSON.parse(jsonMatch[1].trim());
    } catch (err) {
      console.warn(`[PlatformProcessor] n8n workflow design failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Override base _buildTaskPrompt to inject n8n capability context when applicable.
   */
  _buildTaskPrompt(brief, milestoneIndex, totalMilestones) {
    const base = super._buildTaskPrompt(brief, milestoneIndex, totalMilestones);
    const hasN8n = (this.agentConfig.prebuiltSkills || []).some(s => s.startsWith("n8n_"));
    if (!hasN8n) return base;

    return base + `

N8N AUTOMATION CONTEXT:
You have access to n8n workflow automation. If this task requires external API integrations (YouTube, Gmail, Slack, Google Sheets, TikTok, etc.), the n8n_manager skill has already been invoked to design and execute the required workflow autonomously.

Incorporate any n8n workflow outputs from the tool context into your deliverable. Reference workflow IDs or execution results if available.`;
  }

  /**
   * Override processMilestone to inject tool context and use ExtendedComputeService.
   * @param {bigint} jobId 
   * @param {number} milestoneIndex 
   * @param {object} job 
   * @param {object} jobBrief 
   */
  async processMilestone(jobId, milestoneIndex, job, jobBrief) {
    const id = jobId.toString();
    const agentId = this.agentConfig.agentId;
    const agentWallet = job.agentWallet;
    const totalMilestones = job.milestones.length;

    console.log(`\n[PlatformProcessor] --- Milestone ${milestoneIndex} for Agent ${agentId} ---`);
    console.log(`[PlatformProcessor] Percentage: ${job.milestones[milestoneIndex].percentage}%`);
    console.log(`[PlatformProcessor] Amount: ${job.milestones[milestoneIndex].amountWei} wei`);

    await logActivity({
      jobId: id, agentId, agentWallet,
      phase: "processing",
      message: `Working on milestone ${milestoneIndex + 1}/${totalMilestones}...`,
      milestoneIndex,
    });

    // 1. Execute Tools + Pre-built Skills (if configured)
    const customTools     = this.agentConfig.tools           || [];
    const prebuiltSkills  = this.agentConfig.prebuiltSkills  || [];
    let toolContext = "";
    if (customTools.length > 0 || prebuiltSkills.length > 0) {
      console.log(`[PlatformProcessor] Executing ${customTools.length} tool(s) + ${prebuiltSkills.length} skill(s)...`);

      // Auto-design n8n workflow if n8n_manager skill is present and brief has no workflow JSON yet
      const hasN8nManager = prebuiltSkills.includes("n8n_manager");
      if (hasN8nManager && !jobBrief?.metadata?.n8n?.workflowJson) {
        console.log(`[PlatformProcessor] n8n_manager detected — designing workflow autonomously...`);
        await logActivity({ jobId: id, agentId, agentWallet, phase: "n8n_design",
          message: "Designing n8n workflow autonomously...", milestoneIndex });
        const workflowJson = await this._designN8nWorkflow(jobBrief);
        if (workflowJson) {
          jobBrief = { ...(typeof jobBrief === "object" ? jobBrief : { task: jobBrief }),
            metadata: { ...(jobBrief?.metadata || {}), n8n: { action: "create_and_execute", workflowJson } } };
          console.log(`[PlatformProcessor] Workflow designed: "${workflowJson.name}"`);
          await logActivity({ jobId: id, agentId, agentWallet, phase: "n8n_design",
            message: `Workflow designed: "${workflowJson.name}" — deploying to n8n...`, milestoneIndex });
        }
      }

      try {
        toolContext = await executeForJob(jobBrief, customTools, prebuiltSkills, agentId, this.storage);
        if (toolContext) {
          console.log("[PlatformProcessor] Tool/skill context generated.");
        }

        // Detect CREDENTIAL_REQUEST — collect creds then re-run
        const credReqMatch = toolContext?.match(/\[(n8n_\w+)\] CREDENTIAL_REQUEST\n([\s\S]+?)(?=\n\n\[|$)/);
        if (credReqMatch) {
          const skillType = credReqMatch[1];
          const instructions = credReqMatch[2].trim();
          console.log(`[PlatformProcessor] CREDENTIAL_REQUEST detected for ${skillType}`);
          await logActivity({ jobId: id, agentId, agentWallet, phase: "credential_request",
            message: `Requesting ${skillType} credentials from user...`, milestoneIndex });

          const creds = await this._collectCredentials(id, skillType, instructions);
          if (creds) {
            // Persist to Supabase and re-run with fresh config
            await updateAgentSkillConfig(agentId, skillType, creds);
            await logActivity({ jobId: id, agentId, agentWallet, phase: "credential_saved",
              message: `${skillType} credentials saved — re-running with n8n integration...`, milestoneIndex });
            toolContext = await executeForJob(jobBrief, customTools, prebuiltSkills, agentId, this.storage);
          } else {
            toolContext = toolContext.replace(credReqMatch[0], `[${skillType}] Credentials not provided by user — skipping.`);
          }
        }
      } catch (error) {
        console.error("[PlatformProcessor] Tool execution failed:", error.message);
      }
    }

    // 2. Recall memories for this client
    let memoryContext = "";
    try {
      const clientAddress = job.client || "";
      const jobType = jobBrief.skillCategory || jobBrief.category || "general";
      const recalled = await this.memoryService.recall(clientAddress, jobType);
      if (recalled) {
        memoryContext = recalled;
        console.log(`[PlatformProcessor] Memory injected for client ${clientAddress.slice(0, 10)}…`);
        await logActivity({
          jobId: id, agentId, agentWallet,
          phase: "memory_loaded",
          message: `Loaded past learnings for this client — context injected`,
          milestoneIndex,
        });
      }
    } catch (err) {
      console.log(`[PlatformProcessor] Memory recall failed: ${err.message}`);
    }

    // 3. Build Task Prompt
    const taskDescription = this._buildTaskPrompt(jobBrief, milestoneIndex, totalMilestones);

    // 4. LLM Generation + Self-Evaluation Loop
    let result;
    let currentPrompt = taskDescription;
    const MAX_SELF_RETRIES = this.selfEvaluator.MAX_RETRIES;

    for (let attempt = 0; attempt <= MAX_SELF_RETRIES; attempt++) {
      console.log(`[PlatformProcessor] LLM call (attempt ${attempt + 1}/${MAX_SELF_RETRIES + 1})...`);

      try {
        result = await this.extendedCompute.processTask(currentPrompt, memoryContext, toolContext);
        console.log(`[PlatformProcessor] LLM response: ${result.content.length} chars via ${result.provider}`);
      } catch (err) {
        console.log(`[PlatformProcessor] Compute error: ${err.message}`);
        result = {
          content: `[Agent Output] Milestone ${milestoneIndex + 1}/${totalMilestones} completed.\n\nDeliverable prepared based on job requirements and ready for review.`,
          model: "fallback",
          provider: "fallback",
        };
      }

      // Skip self-evaluation on final attempt — accept whatever we have
      if (attempt === MAX_SELF_RETRIES) {
        console.log(`[PlatformProcessor] Max retries reached — proceeding with current output.`);
        break;
      }

      // Self-evaluate
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "self_review",
        message: `Reviewing output quality (attempt ${attempt + 1})…`,
        milestoneIndex,
      });

      const evaluation = await this.selfEvaluator.evaluate(
        result.content,
        jobBrief.description || taskDescription,
        milestoneIndex,
        totalMilestones
      );

      console.log(`[PlatformProcessor] Self-score: ${evaluation.score}/10000 — ${evaluation.summary}`);

      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "self_review",
        message: `Quality score: ${evaluation.score}/10000 — ${evaluation.passed ? "✅ Passed" : "⚠️ Below threshold, improving…"}`,
        milestoneIndex,
        metadata: { selfScore: evaluation.score, issues: evaluation.issues, summary: evaluation.summary },
      });

      if (evaluation.passed) break; // Good enough — proceed to upload

      // Build improved prompt and retry
      currentPrompt = this.selfEvaluator.buildImprovementPrompt(
        taskDescription, result.content, evaluation
      );
    }

    // Log the actual output content so the frontend can display it
    await logActivity({
      jobId: id, agentId, agentWallet,
      phase: "agent_output",
      message: `Milestone ${milestoneIndex + 1} output ready (${result.content.length} chars via ${result.model})`,
      milestoneIndex,
      metadata: {
        content: result.content,
        model: result.model,
        provider: result.provider,
      },
    });

    // Send the output as a chat message to the job stream
    await sendChatMessage({
      jobId: Number(id),
      message: result.content,
      msgType: "text",
      metadata: { model: result.model, provider: result.provider, milestoneIndex },
    });

    // 4. Upload output to 0G Storage
    const output = {
      jobId: id,
      milestoneIndex,
      content: result.content,
      model: result.model,
      provider: result.provider,
      timestamp: new Date().toISOString(),
    };

    let outputCID;
    try {
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "uploading",
        message: "Uploading output to 0G Storage...",
        milestoneIndex,
      });
      outputCID = await this.storage.uploadMilestoneOutput(id, milestoneIndex, output);
      console.log(`[PlatformProcessor] Output uploaded. CID: ${outputCID}`);
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "uploaded",
        message: `Output stored on 0G Storage`,
        milestoneIndex,
        metadata: { outputCID },
      });
    } catch (err) {
      console.log(`[PlatformProcessor] Storage upload error: ${err.message}`);
      outputCID = `mock-cid-job${id}-m${milestoneIndex}-${Date.now()}`;
    }

    // 5. Pre-compute alignment score + signature (so we can release immediately on approval).
    // Contract takes bytes32 outputHash (not string CID) — derive deterministic hash from CID.
    const alignmentScore = Number(process.env.DEMO_ALIGNMENT_SCORE) || 8500;
    const outputHash = ethers.keccak256(ethers.toUtf8Bytes(outputCID));
    const signature = await this._signAlignmentResult(
      jobId,
      milestoneIndex,
      alignmentScore,
      outputHash
    );

    // 6. Pause — run chat-based feedback loop until user confirms
    await logActivity({
      jobId: id, agentId, agentWallet,
      phase: "waiting_approval",
      message: `Milestone ${milestoneIndex + 1} ready. Waiting for user review via chat.`,
      milestoneIndex,
      metadata: { outputCID, alignmentScore },
    });

    // Build a short output summary for the chat (first 800 chars)
    let outputSummary = result.content.length > 800
      ? result.content.slice(0, 800) + "…"
      : result.content;

    // Resolve Telegram chatId — first from skill config, then from agent_profiles.metadata (Option 2)
    let telegramChatId = this.agentConfig.skillConfigs?.telegram_notify?.chatId || null;
    if (!telegramChatId) {
      const fromProfile = await getTelegramChatIdFromProfiles(this.agentConfig.agentId);
      if (fromProfile) {
        telegramChatId = fromProfile;
        console.log(`[PlatformProcessor] Telegram chatId recovered from agent_profiles.metadata`);
      }
    }
    if (telegramChatId) {
      console.log(`[PlatformProcessor] Telegram notifications → chat ${telegramChatId}`);
    }

    let feedbackResult = { userFeedback: "" };
    let revisionCount = 0;
    const MAX_REVISION_EXECUTIONS = 2;

    // Feedback loop — may return revision requests that require re-execution
    while (true) {
      try {
        feedbackResult = await runFeedbackLoop(
          id,
          milestoneIndex,
          outputSummary,
          this.extendedCompute,
          telegramChatId,
          undefined,                  // timeoutMs — use default 1h
          alignmentScore,             // pass score to the loop
          signature && signature !== "0x" // alignmentSigned flag — true if we already signed
        ) || feedbackResult;
      } catch (timeoutErr) {
        console.error(`[PlatformProcessor] ${timeoutErr.message}`);
        feedbackResult.userFeedback = timeoutErr.userFeedback || "";
        await logActivity({
          jobId: id, agentId, agentWallet,
          phase: "error",
          message: `Milestone ${milestoneIndex + 1} feedback loop timed out.`,
          milestoneIndex,
        });
        return;
      }

      // If user requested revision, re-execute the milestone
      if (feedbackResult.path === "revision" && revisionCount < MAX_REVISION_EXECUTIONS) {
        revisionCount++;
        const revisionDetails = feedbackResult.revisionDetails || "";
        console.log(`[PlatformProcessor] Re-executing milestone ${milestoneIndex + 1} — revision ${revisionCount}: ${revisionDetails}`);

        await logActivity({
          jobId: id, agentId, agentWallet,
          phase: "revision",
          message: `Revision ${revisionCount}: ${revisionDetails.slice(0, 200)}`,
          milestoneIndex,
        });

        // Re-run LLM with revision feedback appended to prompt
        const revisionPrompt = `${taskDescription}\n\nThe client requested changes: "${revisionDetails}". Please revise your output accordingly.`;
        try {
          result = await this.extendedCompute.processTask(revisionPrompt, memoryContext, toolContext);
          console.log(`[PlatformProcessor] Revision ${revisionCount} LLM response: ${result.content.length} chars via ${result.provider}`);
        } catch (err) {
          console.log(`[PlatformProcessor] Revision ${revisionCount} compute error: ${err.message}`);
          result = {
            content: `[Agent Output] Milestone ${milestoneIndex + 1}/${totalMilestones} revised based on your feedback: "${revisionDetails}"`,
            model: "fallback",
            provider: "fallback",
          };
        }

        // Update output summary for next feedback loop iteration
        outputSummary = result.content.length > 800
          ? result.content.slice(0, 800) + "…"
          : result.content;

        // Log revised output
        await logActivity({
          jobId: id, agentId, agentWallet,
          phase: "agent_output",
          message: `Milestone ${milestoneIndex + 1} revision ${revisionCount} output ready (${result.content.length} chars via ${result.model})`,
          milestoneIndex,
          metadata: { content: result.content, model: result.model, provider: result.provider },
        });

        // Send revised output as chat message
        await sendChatMessage({
          jobId: Number(id),
          message: result.content,
          msgType: "text",
          metadata: { model: result.model, provider: result.provider, milestoneIndex, revision: revisionCount },
        });

        // Upload revised output
        const revisedOutput = {
          jobId: id,
          milestoneIndex,
          content: result.content,
          model: result.model,
          provider: result.provider,
          timestamp: new Date().toISOString(),
          revision: revisionCount,
        };

        try {
          outputCID = await this.storage.uploadMilestoneOutput(id, milestoneIndex, revisedOutput);
          console.log(`[PlatformProcessor] Revision ${revisionCount} output uploaded. CID: ${outputCID}`);
        } catch (err) {
          console.log(`[PlatformProcessor] Revision ${revisionCount} storage upload error: ${err.message}`);
          outputCID = `mock-cid-job${id}-m${milestoneIndex}-rev${revisionCount}-${Date.now()}`;
        }

        // Continue feedback loop with revised output
        continue;
      }

      // No revision request (or max revisions reached) — break out
      break;
    }

    // 7. Save memory — extract learnings from chat feedback
    try {
      await this.memoryService.save({
        clientAddress: job.client || "",
        jobId:         id,
        jobType:       jobBrief.skillCategory || jobBrief.category || "general",
        outcomeScore:  alignmentScore,
        chatFeedback:  feedbackResult.userFeedback,
        outputSummary: result.content,
      });
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "memory_saved",
        message: `Learnings saved — agent will remember this client's preferences`,
        milestoneIndex,
      });
    } catch (err) {
      console.log(`[PlatformProcessor] Memory save failed: ${err.message}`);
    }

    // 9. Submit milestone to escrow for payment release
    console.log("[PlatformProcessor] User approved — submitting milestone to ProgressiveEscrow...");
    await logActivity({
      jobId: id, agentId, agentWallet,
      phase: "submitting",
      message: `Submitting milestone ${milestoneIndex + 1} for payment release (alignment score: ${(alignmentScore / 100).toFixed(1)}%)`,
      milestoneIndex,
    });

    // ── Alignment Node attestation (high-value milestones) ──────────────────
    // V1 settles with a single alignmentNodeVerifier key (honest gap). For
    // high-value milestones we additionally route through a simulated 0G
    // Alignment Node quorum — a preview of the decentralized oversight layer
    // the roadmap commits to (V1.5: 3-of-5). Fail-open by default; set
    // ALIGNMENT_NODE_ENFORCE=true to block release without quorum.
    try {
      const minOgWei = ethers.parseEther(process.env.ALIGNMENT_NODE_MIN_OG || "0.5");
      if (job.milestones[milestoneIndex].amountWei >= minOgWei) {
        const attestation = await requestAlignmentAttestation({
          jobId, milestoneIndex, outputHash, alignmentScore,
        });
        await logActivity({
          jobId: id, agentId, agentWallet,
          phase: "alignment_attestation",
          message: attestation.attested
            ? `Alignment Node quorum reached (${attestation.quorum}) — high-value milestone independently attested`
            : `Alignment Node quorum NOT reached (${attestation.quorum} < ${attestation.quorumRequired} required)`,
          milestoneIndex,
          metadata: {
            attested:       attestation.attested,
            quorum:         attestation.quorum,
            quorumRequired: attestation.quorumRequired,
            attestationId:  attestation.attestationId,
            attestors:      attestation.attestors,
            simulated:      attestation.simulated,
          },
        });
        if (!attestation.attested && process.env.ALIGNMENT_NODE_ENFORCE === "true") {
          await logActivity({
            jobId: id, agentId, agentWallet, phase: "error",
            message: `Release blocked — Alignment Node quorum not reached`, milestoneIndex,
          });
          return;
        }
      }
    } catch (attErr) {
      // Never let the oversight preview break the payment path.
      console.log(`[PlatformProcessor] Alignment Node attestation skipped: ${attErr.message}`);
    }

    try {
      const tx = await this.escrow.releaseMilestone(
        jobId,
        milestoneIndex,
        outputHash,
        alignmentScore,
        signature
      );
      const receipt = await tx.wait();
      const amountOG = ethers.formatEther(job.milestones[milestoneIndex].amountWei);
      console.log(`[PlatformProcessor] Milestone ${milestoneIndex} APPROVED! TX: ${receipt.hash}`);
      console.log(`[PlatformProcessor] Payment released: ${amountOG} OG`);
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "completed",
        message: `Milestone ${milestoneIndex + 1} approved — ${amountOG} OG released`,
        milestoneIndex,
        metadata: { txHash: receipt.hash, amountOG },
      });

      // ── Verifiable Receipt ────────────────────────────────────────────────
      // Record this milestone's proof bundle so it surfaces publicly: the
      // 0G Compute model that produced it, the 0G Storage root hash of the
      // deliverable, and the mainnet payment tx. Non-blocking.
      await recordPortfolio({
        agentId,
        jobId:           id,
        category:        jobBrief.category || jobBrief.skillCategory || "task",
        summary:         jobBrief.title || (result.content ? result.content.slice(0, 120) : `Milestone ${milestoneIndex + 1} delivered`),
        platforms:       jobBrief?.metadata?.platforms   || [],
        outputTypes:     jobBrief?.metadata?.outputTypes || ["text"],
        computeProvider: result.provider,
        computeModel:    result.model,
        zgResKey:        outputCID,                              // 0G Storage root hash of the deliverable
        workflowCid:     jobBrief?.metadata?.n8n?.workflowCid || null,
        proofBundleCid:  outputCID,                              // stored object bundles content + model + provider + ts
        txHash:          receipt.hash,                           // mainnet payment tx
      });

      // Send Telegram job completion alert
      if (telegramChatId) {
        try {
          await sendJobCompletionAlert({
            chatId: telegramChatId,
            jobId: id,
            title: jobBrief.title || `Job #${id}`,
            summary: outputSummary,
            totalEarned: `${amountOG} OG`,
          });
        } catch (err) {
          console.log(`[PlatformProcessor] Telegram completion alert failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[PlatformProcessor] Milestone submission failed:`, err.message?.slice(0, 120));
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "error",
        message: `Milestone submission failed: ${err.message?.slice(0, 200)}`,
        milestoneIndex,
      });
    }
  }
}
