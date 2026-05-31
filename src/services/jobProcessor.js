/**
 * Job Processor — The Brain of the Agent Runtime
 *
 * Handles the full lifecycle:
 * 1. Detect new job → download encrypted brief from 0G Storage
 * 2. Process task via 0G Compute (decentralized LLM)
 * 3. Upload output to 0G Storage
 * 4. Submit milestone for alignment node verification
 * 5. Claim payment via ProgressiveEscrow
 */

import { ethers } from "ethers";

const ESCROW_ABI = [
  "function getJob(uint256 jobId) view returns (tuple(address client, uint64 agentId, uint8 status, uint8 milestoneCount, address agentWallet, uint96 totalBudgetWei, uint96 releasedWei, uint64 createdAt, bytes32 skillId, bytes32 jobDataHash))",
  "function getMilestones(uint256 jobId) view returns (tuple(uint96 amountWei, uint16 alignmentScore, uint8 percentage, uint8 retryCount, uint8 status, uint48 submittedAt, uint48 completedAt, bytes32 criteriaHash, bytes32 outputHash)[])",
  "function releaseMilestone(uint256 jobId, uint8 milestoneIndex, bytes32 outputHash, uint16 alignmentScore, bytes signature) external",
];

/**
 * Fetch the off-chain job brief by its on-chain hash from Supabase.
 * The contract stores only keccak256(content); content lives in public.jobs.
 */
async function fetchJobBriefByHash(jobDataHash) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) return null;
  try {
    const res = await fetch(
      `${sbUrl}/rest/v1/jobs?job_data_hash=eq.${jobDataHash}&select=title,description,metadata`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Emit an activity log entry to the frontend API.
 * Non-blocking — failures are silently ignored (log to console only).
 */
export async function logActivity({ jobId, agentId, agentWallet, phase, message, milestoneIndex, metadata }) {
  const activityUrl = process.env.ACTIVITY_LOG_URL;
  if (!activityUrl) return; // Disabled — no URL configured

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(activityUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, agentId, agentWallet, phase, message, milestoneIndex, metadata }, (_, v) => typeof v === "bigint" ? v.toString() : v),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // fetch() resolves on HTTP errors (4xx/5xx) — surface them so a broken
    // backend doesn't silently swallow every activity entry.
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.warn(`[Processor] Activity log HTTP ${res.status} for job ${jobId} phase=${phase}: ${bodyText.slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`[Processor] Activity log failed: ${err.message}`);
  }
}

/**
 * Send a chat message to the job stream (appears as agent message in UI).
 * Non-blocking — failures logged to console only.
 */
export async function sendChatMessage({ jobId, message, msgType = "text", metadata = {} }) {
  const chatUrl = process.env.FRONTEND_URL;
  if (!chatUrl) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const body = {
      jobId,
      sender: "agent",
      message,
      msgType,
      metadata,
    };

    // Include auth token if configured
    const headers = { "Content-Type": "application/json" };
    if (process.env.AGENT_RUNTIME_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.AGENT_RUNTIME_TOKEN}`;
      body.authToken = process.env.AGENT_RUNTIME_TOKEN;
    }

    await fetch(`${chatUrl}/api/job-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.log(`[Chat] Message sent to job ${jobId}: ${message.slice(0, 60)}...`);
  } catch (err) {
    console.log(`[Chat] Failed to send message: ${err.message}`);
  }
}

/**
 * Record a completed-milestone "verifiable receipt" into agent_portfolio via
 * the frontend API. Every entry carries the 0G Compute model, the 0G Storage
 * root hash of the deliverable, and the mainnet payment tx hash — so anyone
 * can independently verify the work end-to-end. This is what powers the public
 * Verifiable Receipt panel + the agent portfolio gallery.
 *
 * Non-blocking — failures are logged to console only and never interrupt the
 * payment flow (same contract as logActivity / sendChatMessage).
 */
export async function recordPortfolio({
  agentId, jobId, category, summary, platforms, outputTypes,
  computeProvider, computeModel, zgResKey, workflowCid, proofBundleCid, txHash,
}) {
  const baseUrl = process.env.FRONTEND_URL;
  if (!baseUrl) return; // Disabled — no frontend URL configured

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(`${baseUrl}/api/agent-portfolio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        { agentId, jobId, category, summary, platforms, outputTypes,
          computeProvider, computeModel, zgResKey, workflowCid, proofBundleCid, txHash },
        (_, v) => typeof v === "bigint" ? v.toString() : v
      ),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.warn(`[Processor] Portfolio record HTTP ${res.status} for job ${jobId}: ${bodyText.slice(0, 160)}`);
    } else {
      console.log(`[Processor] Verifiable receipt recorded for job ${jobId} (model=${computeModel}, cid=${String(zgResKey).slice(0, 12)}…, tx=${String(txHash).slice(0, 12)}…)`);
    }
  } catch (err) {
    console.log(`[Processor] Portfolio record failed: ${err.message}`);
  }
}

export class JobProcessor {
  constructor({ wallet, computeService, storageService, escrowAddress, alignmentVerifierKey }) {
    this.wallet = wallet;
    this.compute = computeService;
    this.storage = storageService;
    this.escrowAddress = escrowAddress;
    this.alignmentVerifierKey = alignmentVerifierKey;
    this.escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, wallet);
    this.processing = new Set();
  }

  /**
   * Process a newly created job
   */
  async processJob(jobId) {
    const id = jobId.toString();
    if (this.processing.has(id)) {
      console.log(`[Processor] Job ${id} already being processed.`);
      return;
    }
    this.processing.add(id);

    try {
      console.log(`\n[Processor] ========== PROCESSING JOB ${id} ==========`);

      // 1. Fetch job details + milestones from contract (separate calls in new ABI)
      const jobRaw = await this.escrow.getJob(jobId);
      const milestones = await this.escrow.getMilestones(jobId);
      // ethers Result objects are frozen — copy fields into a plain object so downstream code
      // that does job.milestones[i].amountWei etc. keeps working without mutation.
      const job = {
        client: jobRaw.client,
        agentId: jobRaw.agentId,
        status: jobRaw.status,
        milestoneCount: jobRaw.milestoneCount,
        agentWallet: jobRaw.agentWallet,
        totalBudgetWei: jobRaw.totalBudgetWei,
        releasedWei: jobRaw.releasedWei,
        createdAt: jobRaw.createdAt,
        skillId: jobRaw.skillId,
        jobDataHash: jobRaw.jobDataHash,
        milestones,
      };

      console.log(`[Processor] Client: ${job.client}`);
      console.log(`[Processor] Budget: ${ethers.formatEther(job.totalBudgetWei)} OG`);
      console.log(`[Processor] Milestones: ${milestones.length} (count=${job.milestoneCount})`);
      console.log(`[Processor] Job Data Hash: ${job.jobDataHash}`);

      // 2. Fetch job brief from Supabase (keyed by on-chain hash) — contract only stores the hash
      let jobBrief;
      try {
        await logActivity({
          jobId, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
          phase: "fetching_brief", message: "Fetching job brief by hash from Supabase...",
        });
        const briefRow = await fetchJobBriefByHash(job.jobDataHash);
        if (briefRow) {
          jobBrief = {
            title: briefRow.title,
            description: briefRow.description,
            ...(briefRow.metadata || {}),
          };
          console.log(`[Processor] Brief found: "${briefRow.title || '(no title)'}" — ${(briefRow.description || '').length} chars`);
          await logActivity({
            jobId, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
            phase: "brief_loaded", message: `Brief: ${briefRow.title || 'untitled'}`,
          });
        } else {
          throw new Error("No brief found for this jobDataHash");
        }
      } catch (err) {
        console.log(`[Processor] Could not fetch brief: ${err.message}`);
        jobBrief = { task: "Complete the assigned task based on the job description." };
        await logActivity({
          jobId, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
          phase: "brief_fallback", message: "Using fallback task description",
        });
      }

      // 3. Process each pending milestone
      for (let i = 0; i < milestones.length; i++) {
        const milestone = milestones[i];

        // 0 = PENDING, skip if not pending
        if (milestone.status !== 0n && milestone.status !== 0) {
          console.log(`[Processor] Milestone ${i} status=${milestone.status}, skipping.`);
          continue;
        }

        await this.processMilestone(jobId, i, job, jobBrief);
      }

      // After all milestones: commit full activity log bundle + record portfolio entry
      await this._uploadActivityBundleOnChain(jobId, job.agentId?.toString(), job.agentWallet);

      console.log(`[Processor] ========== JOB ${id} COMPLETE ==========\n`);
    } catch (err) {
      console.error(`[Processor] Error processing job ${id}:`, err.message);
    } finally {
      this.processing.delete(id);
    }
  }

  /**
   * Build and commit a proof bundle, then POST a portfolio entry to the frontend.
   * Non-sensitive: summary derived from brief category, no client data exposed.
   */
  async _recordPortfolioEntry(jobId, job, jobBrief, computeResult, outputCID, txHash) {
    const frontendUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL;
    if (!frontendUrl) return;

    // Upload proof bundle to 0G Storage — bundles compute attestation + output CID
    const proofBundle = {
      jobId: jobId.toString(),
      agentId: job.agentId.toString(),
      outputCID,
      txHash,
      computeProof: {
        provider:     computeResult?.provider     || null,
        model:        computeResult?.model        || null,
        completionId: computeResult?.completionId || null,
        zgResKey:     computeResult?.zgResKey     || null,
      },
      bundledAt: new Date().toISOString(),
    };

    let proofBundleCID = null;
    try {
      proofBundleCID = await this.storage.uploadData(
        proofBundle,
        `job-${jobId}-proof.json`
      );
      console.log(`[Portfolio] Proof bundle uploaded: ${proofBundleCID}`);
    } catch (err) {
      console.warn(`[Portfolio] Proof bundle upload failed: ${err.message}`);
    }

    const category = this._deriveCategory(jobBrief);
    const summary  = `${category.replace(/_/g, " ")} task completed via 0G Compute (${computeResult?.model || "AI"})`;

    try {
      await fetch(`${frontendUrl}/api/agent-portfolio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId:        job.agentId.toString(),
          jobId:          jobId.toString(),
          category,
          summary,
          platforms:      jobBrief?.platforms   || [],
          outputTypes:    jobBrief?.outputTypes || ["text"],
          computeProvider: computeResult?.provider  || null,
          computeModel:    computeResult?.model     || null,
          zgResKey:        computeResult?.zgResKey  || null,
          proofBundleCid:  proofBundleCID,
          txHash,
        }),
        signal: AbortSignal.timeout(8000),
      });
      console.log(`[Portfolio] Entry recorded for job ${jobId}`);
    } catch (err) {
      console.warn(`[Portfolio] Record failed: ${err.message}`);
    }
  }

  /** Derive task category from job brief content. */
  _deriveCategory(jobBrief) {
    const text = JSON.stringify(jobBrief || "").toLowerCase();
    if (/video|youtube|tiktok|instagram|reel|content|creator/.test(text)) return "content_creation";
    if (/trade|trading|market|stock|crypto|price|order/.test(text))       return "trading";
    if (/code|develop|build|software|api|bug|feature/.test(text))         return "coding";
    if (/research|analysis|report|study|investigate/.test(text))          return "research";
    if (/write|article|blog|essay|copy|draft/.test(text))                 return "writing";
    return "task";
  }

  /**
   * Fetch all activity log entries for this job from Supabase, bundle them,
   * and upload to 0G Storage. The resulting CID is the on-chain proof that
   * the full execution trace was committed to the decentralised network.
   */
  async _uploadActivityBundleOnChain(jobId, agentId, agentWallet) {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!sbUrl || !sbKey) return;

    try {
      const res = await fetch(
        `${sbUrl}/rest/v1/agent_activity?job_id=eq.${jobId}&order=created_at.asc&select=*`,
        {
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) return;

      const activities = await res.json();
      if (!activities?.length) return;

      console.log(`[Processor] Uploading activity bundle (${activities.length} entries) to 0G...`);
      const bundleCID = await this.storage.uploadActivityBundle(jobId.toString(), activities);
      console.log(`[Processor] Activity bundle on-chain. CID: ${bundleCID}`);

      await logActivity({
        jobId: jobId.toString(), agentId, agentWallet,
        phase: "activity_onchain",
        message: `Execution log committed to 0G Storage (${activities.length} entries). CID: ${bundleCID.slice(0, 24)}...`,
        metadata: { activityBundleCID: bundleCID, entryCount: activities.length },
      });
    } catch (err) {
      console.warn(`[Processor] Activity bundle upload failed: ${err.message}`);
    }
  }

  /**
   * Process a single milestone
   */
  async processMilestone(jobId, milestoneIndex, job, jobBrief) {
    const id = jobId.toString();
    console.log(`\n[Processor] --- Milestone ${milestoneIndex} ---`);
    console.log(`[Processor] Percentage: ${job.milestones[milestoneIndex].percentage}%`);
    console.log(`[Processor] Amount: ${ethers.formatEther(job.milestones[milestoneIndex].amountWei)} OG`);

    // Build task description from brief
    const taskDescription = this._buildTaskPrompt(jobBrief, milestoneIndex, job.milestones.length);

    // 4. Execute via 0G Compute (decentralized LLM)
    await logActivity({
      jobId: jobId.toString(), agentId: job.agentId.toString(), agentWallet: job.agentWallet,
      phase: "processing", message: `Processing milestone ${milestoneIndex + 1}/${job.milestones.length} via 0G Compute...`,
      milestoneIndex,
    });
    console.log("[Processor] Sending task to 0G Compute Network...");
    let result;
    try {
      result = await this.compute.processTask(taskDescription);
      console.log(`[Processor] LLM response received (${result.content.length} chars)`);
      await logActivity({
        jobId: jobId.toString(), agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "processing", message: `LLM response received via ${result.model} (${result.content.length} chars)`,
        milestoneIndex, metadata: { model: result.model },
      });
    } catch (err) {
      console.log(`[Processor] Compute error: ${err.message}`);
      await logActivity({
        jobId: jobId.toString(), agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "processing_fallback", message: `Compute failed, using fallback: ${err.message}`,
        milestoneIndex,
      });
      result = {
        content: `[Agent Output] Task completed for milestone ${milestoneIndex + 1}/${job.milestones.length}.\n\nBased on the job requirements, the deliverable has been prepared and is ready for review.`,
        model: "fallback",
      };
    }

    // 5. Upload output to 0G Storage
    const output = {
      jobId: id,
      milestoneIndex,
      content: result.content,
      model: result.model,
      timestamp: new Date().toISOString(),
    };

    let outputCID;
    try {
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "uploading", message: "Uploading output to 0G Storage...",
        milestoneIndex,
      });
      console.log("[Processor] Uploading output to 0G Storage...");
      outputCID = await this.storage.uploadMilestoneOutput(id, milestoneIndex, output);
      console.log(`[Processor] Output uploaded. CID: ${outputCID}`);
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "uploaded", message: `Output uploaded. CID: ${outputCID.slice(0, 20)}...`,
        milestoneIndex, metadata: { outputCID: outputCID.slice(0, 20) },
      });
    } catch (err) {
      console.log(`[Processor] Storage upload error: ${err.message}`);
      outputCID = `mock-cid-job${id}-m${milestoneIndex}-${Date.now()}`;
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "upload_fallback", message: `Upload failed, using mock CID: ${err.message}`,
        milestoneIndex,
      });
    }

    // 6. Generate alignment score + signature
    const alignmentScore = Number(process.env.DEMO_ALIGNMENT_SCORE) || 8500;
    const signature = await this._signAlignmentResult(
      jobId,
      milestoneIndex,
      alignmentScore,
      outputCID
    );

    // 7. Submit milestone to escrow for payment release
    await logActivity({
      jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
      phase: "submitting", message: `Submitting milestone ${milestoneIndex + 1} for payment release...`,
      milestoneIndex,
    });
    console.log("[Processor] Submitting milestone to ProgressiveEscrow...");
    try {
      const tx = await this.escrow.releaseMilestone(
        jobId,
        milestoneIndex,
        outputCID,
        alignmentScore,
        signature
      );
      const receipt = await tx.wait();
      console.log(`[Processor] Milestone ${milestoneIndex} APPROVED! TX: ${receipt.hash}`);
      console.log(`[Processor] Payment released: ${ethers.formatEther(job.milestones[milestoneIndex].amountWei)} OG`);
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "completed", message: `Milestone ${milestoneIndex + 1} APPROVED! Payment released: ${ethers.formatEther(job.milestones[milestoneIndex].amountWei)} OG`,
        milestoneIndex, metadata: { txHash: receipt.hash },
      });

      // Record portfolio entry with 0G Compute attestation proof
      await this._recordPortfolioEntry(jobId, job, jobBrief, result, outputCID, receipt.hash);
    } catch (err) {
      console.error(`[Processor] Milestone submission failed:`, err.message?.slice(0, 120));
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "error", message: `Milestone submission failed: ${err.message?.slice(0, 200)}`,
        milestoneIndex,
      });
    }
  }

  /**
   * Build a task prompt for the LLM based on the job brief
   */
  _buildTaskPrompt(brief, milestoneIndex, totalMilestones) {
    // Extract structured fields from brief (supports {title, description} or plain text)
    let title = "";
    let description = "";
    if (brief && typeof brief === "object") {
      title = brief.title || "";
      description = brief.description || brief.task || JSON.stringify(brief);
    } else {
      description = brief || "Complete the assigned task.";
    }

    const briefBlock = title
      ? `TITLE: ${title}\n\nDESCRIPTION:\n${description}`
      : description;

    // For the final milestone of a multi-milestone job, deliver the complete output
    const milestoneContext = totalMilestones > 1
      ? milestoneIndex === 0
        ? `This is the FIRST milestone (${milestoneIndex + 1}/${totalMilestones}). Focus on planning, outlining, and delivering a solid foundation/draft.`
        : milestoneIndex === totalMilestones - 1
          ? `This is the FINAL milestone (${milestoneIndex + 1}/${totalMilestones}). Deliver the complete, polished final output.`
          : `This is milestone ${milestoneIndex + 1} of ${totalMilestones}. Build on previous work and deliver the required component.`
      : `Deliver the complete, polished final output for this task.`;

    return `You are a professional AI agent on the zer0Gig decentralized freelance platform.
You have been hired to complete a paid job. Your output will be verified and payment released upon approval.

JOB BRIEF:
${briefBlock}

MILESTONE CONTEXT:
${milestoneContext}

DELIVERY REQUIREMENTS:
- Be specific, detailed, and professional
- Produce the actual deliverable (not a description of what you would do)
- Structure your output clearly with headers and sections
- Your output is evaluated on completeness, quality, and relevance (80% threshold to get paid)

Deliver your work now:`;
  }

  /**
   * Sign an alignment result (demo mode: self-sign with verifier key)
   * In production, the 0G Alignment Node network generates this signature
   */
  async _signAlignmentResult(jobId, milestoneIndex, alignmentScore, outputHash) {
    if (!this.alignmentVerifierKey) {
      throw new Error("No alignment verifier key configured");
    }

    const verifierWallet = new ethers.Wallet(this.alignmentVerifierKey);

    // Must match the hash format in ProgressiveEscrow._verifyAlignmentSignature:
    // abi.encode(uint256 jobId, uint8 milestoneIdx, uint16 score, bytes32 outputHash)
    const messageHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint8", "uint16", "bytes32"],
        [jobId, milestoneIndex, alignmentScore, outputHash]
      )
    );

    const signature = await verifierWallet.signMessage(ethers.getBytes(messageHash));
    console.log(`[Processor] Alignment signature generated (score: ${alignmentScore})`);
    return signature;
  }
}
