/**
 * Agent Registration Script
 *
 * Registers a new platform-managed agent on AgentRegistry (ERC-7857).
 * Uses AGENT_PRIVATE_KEY as signer, generates a fresh agentWallet.
 * After success, prints the new agentId and agentWallet private key.
 *
 * Usage: node src/register-agent.js
 */

import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

dotenv.config();

const __dir   = dirname(fileURLToPath(import.meta.url));
const ABI_PATH = join(__dir, "../../frontend/src/lib/abis/AgentRegistry.json");

// ── Skill IDs (must match frontend's skillIdsToBytes32) ─────────────────────

const SKILL_IDS = {
  web_search:       "0x5c6b7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e00",
  code_execution:   "0x3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d00",
  data_analysis:    "0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a00",
  content_writing:  "0x6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f00",
  solidity_dev:     "0x8a35acfbc15ff81a39ae7d344fd709f28e8600b4aa8c65c6b64bfe7fe36bd19b",
  frontend_dev:     "0x2c5d2e1e0b72e9f9f6c3e0c1d2a1b0a9f8e7d6c5b4a392817060504030201000",
};

// Skills for this platform agent
const AGENT_SKILLS = [
  SKILL_IDS.web_search,
  SKILL_IDS.content_writing,
  SKILL_IDS.code_execution,
  SKILL_IDS.data_analysis,
];

// ── Capability manifest builder ───────────────────────────────────────────────

function buildCapabilityManifest(skills, llmProvider = "groq", model = "llama-3.3-70b-versatile") {
  const manifest = {
    version: "v2.0.0",
    agentId: 0,             // will be set after mint
    runtimeMode: "platform",
    model,
    skills,
    platformConfig: {
      llmProvider,
      model,
      encryptedApiKey: null,
      systemPrompt: "You are a professional AI freelance agent on the zer0Gig platform. Deliver high-quality, complete work. Your output will be verified by 0G Alignment Nodes.",
      maxTokens: 4096,
      temperature: 0.7,
    },
    tools: [],
    prebuiltSkills: [],
    skillConfigs: {},
    updatedAt: Math.floor(Date.now() / 1000),
  };
  // Match frontend format: "pm:<base64>"
  const base64 = Buffer.from(JSON.stringify(manifest)).toString("base64");
  return `pm:${base64}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const RPC_URL      = process.env.OG_RPC_URL || process.env.OG_NEWTON_RPC || "https://evmrpc.0g.ai";
  const AGENT_KEY    = process.env.AGENT_PRIVATE_KEY;
  const ECIES_PUBKEY = process.env.AGENT_ECIES_PUBLIC_KEY;
  // ⚠️ Mainnet: AGENT_REGISTRY_ADDRESS env var REQUIRED — no safe default.
  const REGISTRY     = process.env.AGENT_REGISTRY_ADDRESS;
  if (!REGISTRY) {
    console.error("AGENT_REGISTRY_ADDRESS missing — deploy the mainnet AgentRegistry first and set the env var.");
    process.exit(1);
  }

  if (!AGENT_KEY) { console.error("AGENT_PRIVATE_KEY not set in .env"); process.exit(1); }

  const provider  = new ethers.JsonRpcProvider(RPC_URL);
  const signerKey = AGENT_KEY.startsWith("0x") ? AGENT_KEY : `0x${AGENT_KEY}`;
  const signer    = new ethers.Wallet(signerKey, provider);

  console.log("═══════════════════════════════════════════════");
  console.log("  Agent Registration — zer0Gig");
  console.log("═══════════════════════════════════════════════\n");
  console.log(`  Contract : ${REGISTRY}`);
  console.log(`  RPC      : ${RPC_URL}`);
  console.log(`  Owner    : ${signer.address}  (msg.sender)`);

  const bal = await provider.getBalance(signer.address);
  console.log(`  Balance  : ${ethers.formatEther(bal)} OG\n`);

  if (bal < ethers.parseEther("0.05")) {
    console.error("  ✗ Balance too low — need at least 0.05 OG for gas");
    process.exit(1);
  }

  // Generate fresh agentWallet (must != msg.sender per contract rule)
  const freshWallet = ethers.Wallet.createRandom();
  console.log(`  agentWallet (fresh): ${freshWallet.address}`);
  console.log(`  agentWallet key    : ${freshWallet.privateKey}  ← SAVE THIS\n`);

  // Build params
  const eciesPubKey    = ECIES_PUBKEY || ("0x" + "04" + "00".repeat(64));
  const defaultRateWei = ethers.parseEther("0.01");
  const defaultRate    = Number(defaultRateWei / BigInt(10_000_000_000)); // uint32 in 1e10 units
  const profileStr     = `profile-${signer.address.toLowerCase()}-${Date.now()}`;
  const profileHash    = ethers.keccak256(ethers.toUtf8Bytes(profileStr));
  const manifest       = buildCapabilityManifest(
    Object.keys(SKILL_IDS).slice(0, 4), // label names for manifest
    "groq",
    "llama-3.3-70b-versatile"
  );
  const capabilityHash = ethers.keccak256(ethers.toUtf8Bytes(manifest));

  console.log(`  defaultRate      : ${defaultRate}  (${ethers.formatEther(defaultRateWei)} OG)`);
  console.log(`  profileHash      : ${profileHash}`);
  console.log(`  capabilityHash   : ${capabilityHash}`);
  console.log(`  skills           : ${AGENT_SKILLS.length} skills`);
  console.log(`  eciesPubKey      : ${eciesPubKey.slice(0, 20)}... (${Math.floor((eciesPubKey.length - 2) / 2)} bytes)`);

  const artifact = JSON.parse(readFileSync(ABI_PATH, "utf8"));
  const registry  = new ethers.Contract(REGISTRY, artifact.abi, signer);

  // Dry-run first
  console.log("\n  Dry-run (eth_call)...");
  try {
    await provider.call({
      from: signer.address,
      to: REGISTRY,
      data: registry.interface.encodeFunctionData("mintAgent", [
        defaultRate, profileHash, capabilityHash,
        AGENT_SKILLS, freshWallet.address, eciesPubKey, "0x01",
      ]),
    });
    console.log("  ✓ eth_call succeeded — sending real tx...\n");
  } catch (err) {
    const data = err?.data || err?.info?.error?.data || "";
    const sel  = typeof data === "string" ? data.slice(0, 10) : "";
    const ERRS = {
      "0xd92e233d": "ZeroAddress() — agentWallet == msg.sender or zero",
      "0x6f483d09": "EmptyEciesKey() — eciesPubKey is empty",
      "0x3a3a0058": "EmptySealedKey()",
    };
    console.error(`  ✗ Dry-run FAILED: ${ERRS[sel] || data || err.message?.slice(0, 200)}`);
    process.exit(1);
  }

  // Real transaction
  try {
    const tx = await registry.mintAgent(
      defaultRate,
      profileHash,
      capabilityHash,
      AGENT_SKILLS,
      freshWallet.address,
      eciesPubKey,
      "0x01",
      { gasLimit: 2_000_000 }
    );
    console.log(`  TX submitted : ${tx.hash}`);
    process.stdout.write("  Waiting for confirmation");
    const receipt = await tx.wait();
    process.stdout.write("\n");
    console.log(`  ✓ Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed})`);

    // Decode AgentMinted event
    const mintedLog = receipt.logs
      .map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
      .find(e => e?.name === "AgentMinted");

    if (!mintedLog) { console.error("  ✗ AgentMinted event not found"); process.exit(1); }

    const agentId     = mintedLog.args.agentId;
    const ownerAddr   = mintedLog.args.owner;
    const agentWallet = mintedLog.args.agentWallet;
    const rate        = mintedLog.args.defaultRate;

    console.log("\n╔═══════════════════════════════════════════════════╗");
    console.log("║  ✓ AGENT REGISTERED SUCCESSFULLY                  ║");
    console.log("╠═══════════════════════════════════════════════════╣");
    console.log(`║  agentId      : ${String(agentId).padEnd(33)}║`);
    console.log(`║  owner        : ${ownerAddr.slice(0, 33)}║`);
    console.log(`║  agentWallet  : ${agentWallet.slice(0, 33)}║`);
    console.log(`║  defaultRate  : ${String(rate).padEnd(33)}║`);
    console.log("╚═══════════════════════════════════════════════════╝");

    console.log("\n  ┌─ SAVE THIS INFO ────────────────────────────────────┐");
    console.log(`  │ agentId            : ${agentId}`);
    console.log(`  │ agentWallet addr   : ${agentWallet}`);
    console.log(`  │ agentWallet key    : ${freshWallet.privateKey}`);
    console.log("  │");
    console.log("  │ Update .env:");
    console.log(`  │   AGENT_ID=${agentId}`);
    console.log(`  │   AGENT_PRIVATE_KEY=${freshWallet.privateKey.replace("0x", "")}`);
    console.log(`  │   PLATFORM_AGENT_IDS=${agentId}`);
    console.log("  └─────────────────────────────────────────────────────┘\n");

    // Auto-patch .env
    const envPath = join(__dir, "../.env");
    let envContent = readFileSync(envPath, "utf8");
    envContent = envContent.replace(/^AGENT_ID=.*/m, `AGENT_ID=${agentId}`);
    envContent = envContent.replace(/^PLATFORM_AGENT_IDS=.*/m, `PLATFORM_AGENT_IDS=${agentId}`);
    writeFileSync(envPath, envContent, "utf8");
    console.log("  ✓ .env patched: AGENT_ID and PLATFORM_AGENT_IDS updated");
    console.log("  ⚠  .env NOT patched for AGENT_PRIVATE_KEY (security — do it manually)");

  } catch (err) {
    console.error(`  ✗ Transaction failed: ${err.message?.slice(0, 300)}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
