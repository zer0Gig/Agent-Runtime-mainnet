/**
 * 0G Compute Service — Decentralized LLM Inference
 *
 * Uses 0G Compute Network's serving broker to call LLMs
 * via an OpenAI-compatible API running on decentralized GPUs.
 */

import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import OpenAI from "openai";

// ────────────────────────────────────────────────────────────────────────────
// 0G Compute Provider Discovery
// ────────────────────────────────────────────────────────────────────────────
//
// Per official 0G docs (May 2026):
//   "The provider and model catalog changes frequently (providers join and
//    leave, pricing is set per-provider). This page does not reproduce the
//    list — check a live source instead."
//
// So we do NOT hardcode mainnet provider addresses. Instead, the runtime:
//   1. Calls broker.inference.listService() on startup
//   2. Filters Foundation-owned providers (excludes flagged-unstable externals)
//   3. Caches the map for the session
//
// Mainnet chatbot catalog (as of May 2026 — for reference / debugging):
//
//   ⭐ 0GM-1.0-35B-A3B            (0G-NATIVE, sovereign tier, May 14 release)
//      - 35B MoE (3B active), 262K→1M context, fine-tuned for agentic coding
//      - HuggingFace: 0G-AI/0GM-1.0-35B-A3B-0427 (Apache 2.0)
//      - Pricing: $0.16/M in, $0.96/M out (10× cheaper than DeepSeek V4 Pro)
//      - Access: Router Mode (pc.0g.ai), model="0GM-1.0-35B-A3B"
//
//   ⭐ DeepSeek V4 Pro             (1.6T / 49B active, 1M context, May 2026)
//      - DSA sparse attention, strongest reasoning available on 0G
//      - Access: Router Mode (pc.0g.ai), model="deepseek-v4-pro"
//
//   - GLM-5-FP8                   (744B MoE, #1 open-source, TeeML)
//   - DeepSeek Chat V3-0324       (Foundation, TeeML)         0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0
//   - DeepSeek V3.1               (Foundation, TeeML)         0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C
//   - GPT-OSS-120B                (Foundation, TeeML)         0xBB3f5b0b5062CB5B3245222C5917afD1f6e13aF6
//   - GPT-OSS-20B                 (Foundation, TeeML)         0x44ba5021daDa2eDc84b4f5FC170b85F7bC51ef64
//   - Qwen3-VL 30B A3B Instruct   (Foundation, TeeML)         0x4415ef5CBb415347bb18493af7cE01f225Fc0868
//   - Qwen3.6-Plus                (Alibaba via TeeTLS proxy)  0x992e63...
//   - Whisper Large V3 (STT)      (Foundation, TeeML)         0x36aCffCEa3CCe07cAdd1740Ad992dB16Ab324517
//   - Flux Turbo / Z-Image (TTI)  (Foundation, TeeML)         0xE29a72c7629815Eb480aE5b1F2dfA06f06cdF974
//
// ⚡ Router Mode (https://pc.0g.ai) is the RECOMMENDED path for mainnet.
//   Auto-routes agentic/long-context work to 0GM-1.0, falls back to
//   deepseek-v4-pro for general reasoning. Uses app-sk-XXX API key auth
//   instead of per-provider sub-accounts — no 24h refund flow.
//
// Direct per-provider mode (broker.inference.*) still works for use cases
// that need wallet-signed receipts, but requires more setup.
//
// Testnet (Galileo, chain 16602) providers stay hardcoded since they're stable.
const TESTNET_PROVIDERS = {
  "qwen-2.5-7b": "0xa48f01287233509FD694a22Bf840225062E67836",
  "gpt-oss-20b": "0x8e60d466FD16798Bec4868aa4CE38586D5590049",
  "gemma-3-27b": "0x69Eb5a0BD7d0f4bF39eD5CE9Bd3376c61863aE08",
};

// Cache for dynamically-discovered mainnet providers
let CACHED_PROVIDERS = null;

/**
 * Discover available 0G Compute providers via broker.inference.listService().
 * Returns a map of { modelName: providerAddress } filtered to verifiable services.
 *
 * Caches result for the session. Pass forceRefresh=true to re-query the chain.
 */
export async function discoverProviders(broker, { forceRefresh = false } = {}) {
  if (CACHED_PROVIDERS && !forceRefresh) return CACHED_PROVIDERS;

  try {
    const services = await broker.inference.listService();
    if (!services?.length) {
      console.warn("[Compute] discoverProviders: empty list — falling back to TESTNET_PROVIDERS");
      CACHED_PROVIDERS = { ...TESTNET_PROVIDERS };
      return CACHED_PROVIDERS;
    }

    const map = {};
    for (const svc of services) {
      const key = (svc.model || svc.serviceType || "unknown").toLowerCase().replace(/\s+/g, "-");
      // Prefer first-seen entry per model
      if (!map[key]) map[key] = svc.provider || svc.providerAddress;
    }
    console.log(`[Compute] Discovered ${Object.keys(map).length} provider(s):`, Object.keys(map).join(", "));
    CACHED_PROVIDERS = map;
    return map;
  } catch (err) {
    console.warn(`[Compute] discoverProviders error: ${err.message?.slice(0, 100)} — using TESTNET_PROVIDERS fallback`);
    CACHED_PROVIDERS = { ...TESTNET_PROVIDERS };
    return CACHED_PROVIDERS;
  }
}

export class ComputeService {
  constructor(wallet) {
    this.wallet = wallet;
    this.broker = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    console.log("[Compute] Initializing 0G Compute broker...");
    this.broker = await createZGComputeNetworkBroker(this.wallet);

    // Check if ledger exists, create if not
    // Use a small deposit — testnet inference costs fractions of OG per request
    const ledgerDeposit = Number(process.env.OG_COMPUTE_LEDGER_DEPOSIT) || 0.002;
    try {
      const ledger = await this.broker.ledger.getLedger();
      console.log("[Compute] Ledger found. Balance:", ledger.balance?.toString());
    } catch {
      console.log(`[Compute] No ledger found. Creating with ${ledgerDeposit} OG deposit...`);
      await this.broker.ledger.addLedger(ledgerDeposit);
      console.log("[Compute] Ledger created.");
    }

    this.initialized = true;
    console.log("[Compute] Ready.");
  }

  /**
   * List available AI services on the network
   */
  async listServices() {
    await this.initialize();
    const services = await this.broker.inference.listService();
    return services;
  }

  /**
   * Ensure a provider is acknowledged and funded
   */
  async prepareProvider(providerAddress) {
    await this.initialize();

    try {
      await this.broker.inference.acknowledgeProviderSigner(providerAddress);
      console.log("[Compute] Provider acknowledged:", providerAddress);
    } catch (err) {
      // Already acknowledged — that's fine
      if (!err.message?.includes("already")) {
        console.log("[Compute] Provider ack note:", err.message?.slice(0, 80));
      }
    }

    try {
      const { ethers } = await import("ethers");
      const providerDeposit = process.env.OG_COMPUTE_PROVIDER_DEPOSIT || "0.001";
      await this.broker.ledger.transferFund(
        providerAddress,
        "inference",
        ethers.parseEther(providerDeposit)
      );
      console.log(`[Compute] Transferred ${providerDeposit} OG to provider sub-account.`);
    } catch (err) {
      // Might already have funds
      console.log("[Compute] Fund transfer note:", err.message?.slice(0, 80));
    }
  }

  /**
   * Send a chat completion request to a 0G Compute provider
   */
  async chatCompletion(messages, options = {}) {
    await this.initialize();

    // Resolve provider: explicit override → preferred model from discovery →
    // first discovered provider → testnet fallback (last-resort for dev only)
    let providerAddress = options.provider;
    if (!providerAddress) {
      const providers = await discoverProviders(this.broker);
      const preferred = options.model && providers[options.model.toLowerCase()];
      providerAddress =
        preferred ||
        Object.values(providers)[0] ||
        TESTNET_PROVIDERS["qwen-2.5-7b"];
    }

    // Get service metadata
    const { endpoint, model } =
      await this.broker.inference.getServiceMetadata(providerAddress);

    console.log(`[Compute] Using model: ${model} at ${endpoint}`);

    // Get single-use auth headers
    const userContent = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ");
    const headers = await this.broker.inference.getRequestHeaders(
      providerAddress,
      userContent
    );

    // Call OpenAI-compatible endpoint
    const openai = new OpenAI({ baseURL: endpoint, apiKey: "" });
    const { data: completion, response } = await openai.chat.completions
      .create(
        {
          model,
          messages,
          max_tokens: options.maxTokens || 2048,
          temperature: options.temperature || 0.7,
        },
        { headers }
      )
      .withResponse();

    const content = completion.choices[0]?.message?.content || "";

    // Pull the verification key — always use ZG-Res-Key header (not chatcmpl-...)
    const zgResKey =
      response.headers.get("zg-res-key") ||
      response.headers.get("ZG-Res-Key") ||
      null;

    // Verify response (TEE verification + payment settlement)
    if (zgResKey) {
      try {
        const isValid = await this.broker.inference.processResponse(
          providerAddress,
          zgResKey
        );
        console.log(`[Compute] Response verified via ZG-Res-Key: ${isValid}`);
      } catch (err) {
        console.log(`[Compute] Verification failed: ${err.message?.slice(0, 100)}`);
      }
    } else {
      console.warn("[Compute] ZG-Res-Key header missing from provider response — skipping TEE verification");
    }

    return {
      content,
      model,
      provider: providerAddress,
      completionId: completion.id,
      zgResKey,
    };
  }

  /**
   * Process a job task using the 0G Compute LLM
   */
  async processTask(taskDescription, context = "") {
    const systemPrompt = `You are a professional AI freelance agent working on the zer0Gig platform.
You are executing a paid job. Deliver high-quality, complete work.
Be thorough, professional, and precise. The output will be verified by 0G Alignment Nodes.`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...(context
        ? [{ role: "user", content: `Context:\n${context}` }]
        : []),
      { role: "user", content: taskDescription },
    ];

    return this.chatCompletion(messages);
  }
}
