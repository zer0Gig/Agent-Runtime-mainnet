/**
 * 0G Compute one-time setup.
 *
 * Use after funding the agent wallet with at least 4 OG. This script:
 *   1. Verifies the agent wallet has sufficient balance
 *   2. Creates a 0G Compute ledger (deposit OG_COMPUTE_LEDGER_DEPOSIT, default 3)
 *   3. Acknowledges the configured provider (default: qwen-2.5-7b)
 *   4. Transfers OG_COMPUTE_PROVIDER_DEPOSIT (default 1) to the provider sub-account
 *
 * After this runs successfully, the runtime will use 0G Compute as the primary
 * inference path and only fall back to Groq if a per-call inference fails.
 *
 * Usage:
 *   node src/setup-compute.js               # uses qwen-2.5-7b
 *   node src/setup-compute.js gpt-oss-20b   # picks a different provider
 */
// BigInt serialization polyfill — must run BEFORE SDK import (see src/index.js)
if (!('toJSON' in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function () { return this.toString(); },
    writable: false, configurable: false, enumerable: false,
  });
}

import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// 0G Aristotle Mainnet (chain 16661) — Foundation-owned providers
// Source: Docs/0G-REFERENCES/0G-compute-infrerences.md (May 2026 catalog)
const MAINNET_PROVIDERS = {
  "deepseek-v3.1":         "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C",  // 0.49/M in, 0.15/M out — recommended default
  "deepseek-chat-v3-0324": "0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0",  // 0.30/M in, 1.00/M out — fast conversational
  "gpt-oss-120b":          "0xBB3f5b0b5062CB5B3245222C5917afD1f6e13aF6",  // 0.10/M in, 0.49/M out — large open-source
  "gpt-oss-20b":           "0x44ba5021daDa2eDc84b4f5FC170b85F7bC51ef64",  // 0.05/M in, 0.11/M out — CHEAPEST
  "qwen3-vl-30b":          "0x4415ef5CBb415347bb18493af7cE01f225Fc0868",  // 0.49/M in, 0.49/M out — multimodal
};

// Galileo testnet (chain 16602) — kept for cross-network testing
const TESTNET_PROVIDERS = {
  "qwen-2.5-7b": "0xa48f01287233509FD694a22Bf840225062E67836",
  "gpt-oss-20b-testnet": "0x8e60d466FD16798Bec4868aa4CE38586D5590049",
  "gemma-3-27b": "0x69Eb5a0BD7d0f4bF39eD5CE9Bd3376c61863aE08",
};

const PROVIDERS = { ...MAINNET_PROVIDERS, ...TESTNET_PROVIDERS };

const ledgerDeposit   = Number(process.env.OG_COMPUTE_LEDGER_DEPOSIT) || 3;
const providerDeposit = Number(process.env.OG_COMPUTE_PROVIDER_DEPOSIT) || 1;
// Default: deepseek-v3.1 (most reliable Foundation-owned provider on mainnet)
const providerKey     = process.argv[2] || "deepseek-v3.1";
const providerAddr    = PROVIDERS[providerKey];

const fmt = (w) => ethers.formatEther(w) + " OG";

async function main() {
  console.log("\n╔" + "═".repeat(58) + "╗");
  console.log("║  0G Compute Setup                                        ║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  if (!providerAddr) {
    console.error(`Unknown provider key: ${providerKey}. Choices: ${Object.keys(PROVIDERS).join(", ")}`);
    process.exit(1);
  }

  if (!process.env.AGENT_PRIVATE_KEY) {
    console.error("AGENT_PRIVATE_KEY missing in .env");
    process.exit(1);
  }

  const rpc = process.env.OG_RPC_URL || process.env.OG_NEWTON_RPC || "https://evmrpc.0g.ai";
  const provider = new ethers.JsonRpcProvider(rpc);
  const pk = process.env.AGENT_PRIVATE_KEY.startsWith("0x")
    ? process.env.AGENT_PRIVATE_KEY
    : `0x${process.env.AGENT_PRIVATE_KEY}`;
  const wallet = new ethers.Wallet(pk, provider);

  // ─── Step 1: balance check ─────────────────────────────────────────────
  console.log("[1/4] Wallet balance check");
  const balance = await provider.getBalance(wallet.address);
  const balanceOG = Number(ethers.formatEther(balance));
  const required = ledgerDeposit + providerDeposit + 0.1; // +0.1 for gas
  console.log(`     Wallet:   ${wallet.address}`);
  console.log(`     Balance:  ${fmt(balance)}`);
  console.log(`     Required: ${required} OG (ledger ${ledgerDeposit} + provider ${providerDeposit} + gas 0.1)`);

  if (balanceOG < required) {
    console.error(`\n  ✗ Insufficient balance. Need ${(required - balanceOG).toFixed(4)} OG more.`);
    console.error(`     Mainnet has NO public faucet — buy 0G on a CEX (Binance/KuCoin) and`);
    console.error(`     withdraw to ${wallet.address} on the 0G Aristotle network.`);
    process.exit(1);
  }
  console.log("     ✓ sufficient balance\n");

  // ─── Step 2: broker init ───────────────────────────────────────────────
  console.log("[2/4] Initializing 0G Compute broker");
  const broker = await createZGComputeNetworkBroker(wallet);
  console.log("     ✓ broker created\n");

  // ─── Step 3: ledger ────────────────────────────────────────────────────
  console.log("[3/4] Ledger");
  let ledgerExists = false;
  try {
    const ledger = await broker.ledger.getLedger();
    ledgerExists = true;
    console.log(`     ✓ ledger exists — balance: ${ledger.balance?.toString() || "(unknown)"}`);
  } catch {
    console.log(`     no ledger yet — creating with ${ledgerDeposit} OG deposit...`);
  }

  if (!ledgerExists) {
    try {
      await broker.ledger.addLedger(ledgerDeposit);
      console.log(`     ✓ ledger created with ${ledgerDeposit} OG`);
    } catch (err) {
      console.error(`     ✗ addLedger failed: ${err.message}`);
      process.exit(1);
    }
  }
  console.log();

  // ─── Step 4: provider ──────────────────────────────────────────────────
  console.log(`[4/4] Provider: ${providerKey} (${providerAddr})`);

  try {
    await broker.inference.acknowledgeProviderSigner(providerAddr);
    console.log("     ✓ provider acknowledged");
  } catch (err) {
    if (err.message?.includes("already")) {
      console.log("     ✓ provider already acknowledged");
    } else {
      console.error(`     ✗ acknowledge failed: ${err.message}`);
      process.exit(1);
    }
  }

  try {
    await broker.ledger.transferFund(
      providerAddr,
      "inference",
      ethers.parseEther(String(providerDeposit))
    );
    console.log(`     ✓ ${providerDeposit} OG transferred to provider sub-account`);
  } catch (err) {
    if (err.message?.includes("already") || err.message?.includes("sufficient")) {
      console.log(`     ✓ provider already funded`);
    } else {
      console.log(`     ⚠ transferFund: ${err.message?.slice(0, 100)}`);
    }
  }

  // ─── Verify ────────────────────────────────────────────────────────────
  try {
    const services = await broker.inference.listService();
    const match = services.find(s => s.provider?.toLowerCase() === providerAddr.toLowerCase());
    if (match) {
      console.log(`\n  ✓ Provider live — model: ${match.model}, endpoint: ${match.url}`);
    }
  } catch { /* non-fatal */ }

  const finalBalance = await provider.getBalance(wallet.address);
  console.log(`\n  Wallet balance after setup: ${fmt(finalBalance)}\n`);

  console.log("═".repeat(60));
  console.log("  Setup complete. Runtime can now use 0g-compute as primary.");
  console.log("═".repeat(60) + "\n");
}

main().catch(err => {
  console.error("\nFatal:", err);
  process.exit(1);
});
