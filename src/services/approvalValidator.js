/**
 * Approval Validator — Groq-backed intent classifier for milestone approvals.
 *
 * Uses Groq API (fast, cheap) to independently validate whether a user's
 * chat message means "approve and proceed to next milestone". This prevents
 * the primary LLM (0G Compute) from misclassifying or fabricating approvals.
 *
 * Dual-layer security:
 *   1. Primary LLM (0G Compute) classifies intent first
 *   2. Groq cross-validates — only proceeds if BOTH agree on APPROVED
 */

import OpenAI from "openai";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_APPROVAL_MODEL || "llama-3.3-70b-versatile";

/**
 * Classify whether a user message constitutes milestone approval.
 * Uses Groq API for fast, independent validation.
 *
 * @param {string} userMessage - The user's chat message
 * @param {string} milestoneSummary - Summary of the milestone output
 * @param {number} milestoneIndex - Current milestone index (0-based)
 * @param {number} totalMilestones - Total number of milestones
 * @returns {Promise<{ approved: boolean, reason: string, confidence: number }>}
 */
export async function validateApproval(userMessage, milestoneSummary, milestoneIndex, totalMilestones) {
  if (!GROQ_API_KEY) {
    // No Groq key — fall back to keyword-based validation
    return keywordFallback(userMessage);
  }

  try {
    const groqClient = new OpenAI({
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: GROQ_API_KEY,
    });

    const prompt = `You are an impartial approval validator for a decentralized freelance platform.

A freelancer (AI agent) has completed milestone ${milestoneIndex + 1} of ${totalMilestones} and posted this summary:
"${milestoneSummary.slice(0, 400)}"

The client responded with:
"${userMessage}"

Determine if the client's message clearly indicates they are SATISFIED and want to APPROVE the milestone and proceed.

Consider these as APPROVAL signals:
- Explicit approval: "approve", "approved", "looks good", "great work", "perfect", "I'm satisfied"
- Proceeding: "continue", "next milestone", "move on", "let's go", "proceed", "release payment"
- Positive acknowledgment with intent to continue: "good job, continue", "nice, next please", "well done, let's move forward"
- Button click acknowledgment: "clicked", "done", "ok"

Consider these as NOT approval (revision requests):
- Specific change requests: "change X", "fix Y", "make it Z"
- Negative feedback: "not good", "needs work", "incomplete"
- Questions without approval: "can you explain?", "what about...?"
- Ambiguous messages that don't clearly indicate satisfaction

Reply with STRICT JSON ONLY (no markdown, no prose):
{
  "approved": true or false,
  "reason": "brief explanation of your decision",
  "confidence": 0.0 to 1.0 (how confident you are)
}`;

    const completion = await groqClient.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.1,
    });

    const raw = completion.choices[0]?.message?.content || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`[ApprovalValidator] Groq response not JSON — falling back to keywords`);
      return keywordFallback(userMessage);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`[ApprovalValidator] Groq validation: approved=${parsed.approved}, confidence=${parsed.confidence}, reason=${parsed.reason}`);

    return {
      approved: !!parsed.approved,
      reason: parsed.reason || "",
      confidence: Number(parsed.confidence) || 0,
    };
  } catch (err) {
    console.log(`[ApprovalValidator] Groq API error: ${err.message} — falling back to keywords`);
    return keywordFallback(userMessage);
  }
}

/**
 * Keyword-based fallback when Groq API is unavailable.
 * More sophisticated than the original hardcoded list — uses pattern matching.
 */
function keywordFallback(userMessage) {
  const lower = userMessage.toLowerCase().trim();

  // Strong approval patterns (high confidence)
  const strongApproval = [
    /^approve[d]?$/i,
    /^approved?[\s!.,]+/i,
    /looks?\s*(really\s+)?good/i,
    /great\s*(work|job)?/i,
    /perfect/i,
    /i'?m\s*(very\s+)?satisfied/i,
    /well\s*done/i,
    /nice\s*(work|job)?/i,
    /proceed/i,
    /continue/i,
    /next\s*(milestone|step|one)?/i,
    /move\s*(on|forward)/i,
    /let'?s?\s*(go|proceed|continue|move)/i,
    /release\s*(payment)?/i,
    /go\s*ahead/i,
    /good\s*(to\s*go|enough|job|work)/i,
    /les?goo?\s*(to)?/i,
    /good\s*boy/i,
  ];

  // Revision/negative patterns
  const revisionPatterns = [
    /change\s/i,
    /fix\s/i,
    /not\s*(good|right|what|enough|satisfied)/i,
    /needs?\s*(work|improvement|changes?)/i,
    /incomplete/i,
    /missing/i,
    /redo/i,
    /revise/i,
    /try\s*(again|differently)/i,
    /can\s*you/i,
    /what\s*about/i,
    /how\s*about/i,
    /but\s/i,
    /however/i,
    /instead/i,
  ];

  // Check revision first — if it looks like a revision request, definitely not approval
  if (revisionPatterns.some(p => p.test(lower))) {
    return { approved: false, reason: "Message contains revision/negative signals", confidence: 0.8 };
  }

  // Check strong approval
  if (strongApproval.some(p => p.test(lower))) {
    return { approved: true, reason: "Message matches approval pattern", confidence: 0.9 };
  }

  // Default: treat ambiguous messages as NOT approved (safe default)
  return { approved: false, reason: "Message is ambiguous — not clearly an approval", confidence: 0.3 };
}
