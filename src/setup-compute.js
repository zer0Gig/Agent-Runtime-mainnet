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
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const PROVIDERS = {
  "qwen-2.5-7b": "0xa48f01287233509FD694a22Bf840225062E67836",
  "gpt-oss-20b": "0x8e60d466FD16798Bec4868aa4CE38586D5590049",
  "gemma-3-27b": "0x69Eb5a0BD7d0f4bF39eD5CE9Bd3376c61863aE08",
};

const ledgerDeposit   = Number(process.env.OG_COMPUTE_LEDGER_DEPOSIT) || 3;
const providerDeposit = Number(process.env.OG_COMPUTE_PROVIDER_DEPOSIT) || 1;
const providerKey     = process.argv[2] || "qwen-2.5-7b";
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
    console.error(`\n  ✗ Insufficient balance. Need ${required - balanceOG} OG more.`);
    console.error(`     Faucet: https://faucet.0g.ai (request to ${wallet.address})`);
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
