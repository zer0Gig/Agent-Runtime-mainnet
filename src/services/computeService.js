/**
 * 0G Compute Service — Decentralized LLM Inference
 *
 * Uses 0G Compute Network's serving broker to call LLMs
 * via an OpenAI-compatible API running on decentralized GPUs.
 */

import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import OpenAI from "openai";

// Testnet providers
const TESTNET_PROVIDERS = {
  "qwen-2.5-7b": "0xa48f01287233509FD694a22Bf840225062E67836",
  "gpt-oss-20b": "0x8e60d466FD16798Bec4868aa4CE38586D5590049",
  "gemma-3-27b": "0x69Eb5a0BD7d0f4bF39eD5CE9Bd3376c61863aE08",
};

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

    const providerAddress =
      options.provider || TESTNET_PROVIDERS["qwen-2.5-7b"];

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
