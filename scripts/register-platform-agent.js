/**
 * Register a Platform-Managed Agent for E2E Testing
 * 
 * Usage: node scripts/register-platform-agent.js
 */

import "dotenv/config";
import { ethers } from "ethers";
import { buildCapabilityManifest, RUNTIME_TYPES, LLM_PROVIDERS } from "../src/schemas/capabilitySchema.js";

const AGENT_REGISTRY_ABI = [
  "function mintAgent(uint256 defaultRate, string calldata profileCID, string calldata capabilityCID, bytes32[] calldata skillIds, address agentWallet, bytes calldata eciesPublicKey) external returns (uint256 agentId)",
  "function getAgentProfile(uint256 agentId) view returns (tuple(address owner, address agentWallet, bytes eciesPublicKey, bytes32 capabilityHash, string capabilityCID, string profileCID, uint256 overallScore, uint256 totalJobsCompleted, uint256 totalJobsAttempted, uint256 totalEarningsWei, uint256 defaultRate, uint256 createdAt, bool isActive))",
  "function totalAgents() view returns (uint256)"
];

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  zer0Gig — Register Platform-Managed Agent       ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const rpcUrl = process.env.OG_RPC_URL || process.env.OG_NEWTON_RPC || "https://evmrpc.0g.ai";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(process.env.PLATFORM_PRIVATE_KEY, provider);

  console.log(`[Register] Wallet: ${wallet.address}`);
  console.log(`[Register] Balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} OG`);
  console.log(`[Register] Registry: ${process.env.AGENT_REGISTRY_ADDRESS}\n`);

  // Build capability manifest
  const manifest = buildCapabilityManifest({
    model: "qwen-2.5-7b",
    skills: ["web_search"],
    runtimeMode: RUNTIME_TYPES.PLATFORM,
    platformConfig: {
      llmProvider: LLM_PROVIDERS.ZERO_G,
      systemPrompt: "You are a professional AI freelance agent on zer0Gig. Deliver high-quality work."
    },
    tools: [],
    webhooks: {}
  });

  console.log("[Register] Capability Manifest:");
  console.log(JSON.stringify(manifest, null, 2));
  console.log();

  // Encode manifest as inline base64 with pm: prefix
  const base64 = Buffer.from(JSON.stringify(manifest)).toString("base64");
  const capabilityCID = `pm:${base64}`;
  console.log(`[Register] Capability CID (pm: prefix): ${capabilityCID.slice(0, 60)}...\n`);

  // Use the AGENT_PRIVATE_KEY from .env for the agent wallet
  // This way we have the private key to sign milestone releases
  const agentWalletSigner = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY);
  const agentWallet = agentWalletSigner.address;
  console.log(`[Register] Agent Wallet: ${agentWallet}`);
  console.log(`[Register] (Using AGENT_PRIVATE_KEY from .env)`);

  // ECIES public key (dummy for demo)
  const eciesPublicKey = "0x0400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001";

  // Skill IDs (using a simple bytes32 for web_search)
  const skillIds = [ethers.id("web_search")];

  // Default rate: 0.001 OG in wei
  const defaultRate = ethers.parseEther("0.001");

  // Profile CID (dummy for demo)
  const profileCID = `profile-${Date.now()}`;

  // Connect to registry
  const registry = new ethers.Contract(process.env.AGENT_REGISTRY_ADDRESS, AGENT_REGISTRY_ABI, wallet);

  console.log("\n[Register] Sending mintAgent transaction...");
  console.log(`  defaultRate: ${ethers.formatEther(defaultRate)} OG`);
  console.log(`  agentWallet: ${agentWallet}`);
  console.log(`  capabilityCID: pm:${base64.slice(0, 30)}...`);

  try {
    const tx = await registry.mintAgent(
      defaultRate,
      profileCID,
      capabilityCID,
      skillIds,
      agentWallet,
      eciesPublicKey
    );

    console.log(`[Register] TX sent: ${tx.hash}`);
    console.log("[Register] Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log(`[Register] TX confirmed in block ${receipt.blockNumber}`);

    // Get agentId from event
    const event = receipt.logs.find(log => {
      try {
        const parsed = registry.interface.parseLog(log);
        return parsed && parsed.name === "AgentMinted";
      } catch {
        return false;
      }
    });

    let agentId;
    if (event) {
      const parsed = registry.interface.parseLog(event);
      agentId = parsed.args.agentId.toString();
    } else {
      // Fallback: query totalAgents
      agentId = await registry.totalAgents();
      agentId = agentId.toString();
    }

    console.log(`\n✅ Agent registered successfully!`);
    console.log(`   Agent ID: ${agentId}`);
    console.log(`   Agent Wallet: ${agentWallet}`);
    console.log(`   Capability CID: ${capabilityCID.slice(0, 60)}...`);
    console.log(`\n   Update .env with: PLATFORM_AGENT_IDS=${agentId}`);

  } catch (error) {
    console.error(`\n❌ Registration failed: ${error.message?.slice(0, 200) || error}`);
    process.exit(1);
  }
}

main();
