/**
 * Complete E2E Test - Path B with Direct Milestone Submission
 * 
 * Tests the full flow:
 * 1. Post job
 * 2. Submit proposal with Agent 2
 * 3. Accept proposal
 * 4. Define milestones
 * 5. Directly submit milestone (bypassing 0G Compute for reliability)
 * 6. Verify payment release
 */

import 'dotenv/config';
import { ethers } from 'ethers';

// Config
const RPC_URL = process.env.OG_RPC_URL || process.env.OG_NEWTON_RPC || 'https://evmrpc.0g.ai';
const ESCROW_ADDRESS = process.env.PROGRESSIVE_ESCROW_ADDRESS;
const AGENT_REGISTRY_ADDRESS = process.env.AGENT_REGISTRY_ADDRESS;
const PLATFORM_KEY = process.env.PLATFORM_PRIVATE_KEY;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const ALIGNMENT_KEY = process.env.ALIGNMENT_VERIFIER_KEY?.replace('0x', '');
const AGENT_ID = 2; // Use newly registered Agent 2

const JOB_BUDGET = ethers.parseEther('0.001');

// ABIs
const ESCROW_ABI = [
  'function postJob(string calldata jobDataCID, bytes32 skillId) external returns (uint256 jobId)',
  'function submitProposal(uint256 jobId, uint256 agentId, uint256 proposedRateWei, string calldata descriptionCID) external',
  'function acceptProposal(uint256 jobId, uint256 proposalIndex) external payable',
  'function defineMilestones(uint256 jobId, uint8[] calldata percentages, bytes32[] calldata criteriaHashes) external',
  'function releaseMilestone(uint256 jobId, uint8 milestoneIndex, string calldata outputCID, uint256 alignmentScore, bytes calldata signature) external',
  'function getJob(uint256 jobId) external view returns (tuple(uint256 jobId, address client, uint256 agentId, address agentWallet, uint256 totalBudgetWei, uint256 releasedWei, uint8 status, tuple(uint8 percentage, uint256 amountWei, uint8 status, bytes32 criteriaHash, string outputCID, uint256 alignmentScore, uint256 retryCount, uint256 submittedAt, uint256 completedAt)[] milestones, uint256 createdAt, string jobDataCID, bytes32 skillId))',
  'event JobPosted(uint256 indexed jobId, address indexed client, bytes32 skillId, string jobDataCID)',
  'event ProposalSubmitted(uint256 indexed jobId, uint256 proposalIndex, uint256 indexed agentId, uint256 proposedRateWei)',
];

const AGENT_REGISTRY_ABI = [
  'function getAgentProfile(uint256 agentId) external view returns (tuple(address owner, address agentWallet, bytes eciesPublicKey, bytes32 capabilityHash, string capabilityCID, string profileCID, uint256 overallScore, uint256 totalJobsCompleted, uint256 totalJobsAttempted, uint256 totalEarningsWei, uint256 defaultRate, uint256 createdAt, bool isActive))',
];

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  E2E Integration Test - Path B (Complete Flow with Agent 2)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  // Platform wallet (owner of Agent 2, also acts as client)
  const platformWallet = new ethers.Wallet(PLATFORM_KEY, provider);
  console.log('[Setup] Platform Wallet:', platformWallet.address);
  console.log('[Setup] Balance:', ethers.formatEther(await provider.getBalance(platformWallet.address)), 'OG');
  
  // Agent wallet (for signing milestone releases)
  const agentWallet = new ethers.Wallet(AGENT_KEY, provider);
  console.log('[Setup] Agent Wallet:', agentWallet.address);
  
  // Verifier wallet (must match contract's alignmentNodeVerifier - it's the platform wallet)
  const verifierWallet = platformWallet; // Contract expects platform wallet as verifier
  console.log('[Setup] Verifier Wallet:', verifierWallet.address);

  // Contracts
  const escrowAsPlatform = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, platformWallet);
  const escrowAsAgent = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, agentWallet);
  const registry = new ethers.Contract(AGENT_REGISTRY_ADDRESS, AGENT_REGISTRY_ABI, provider);

  // Verify Agent 2
  console.log('\n[Step 0] Verifying Agent 2...');
  const agent = await registry.getAgentProfile(AGENT_ID);
  console.log('  Owner:', agent.owner);
  console.log('  AgentWallet:', agent.agentWallet);
  console.log('  IsActive:', agent.isActive);
  
  if (agent.agentWallet.toLowerCase() !== agentWallet.address.toLowerCase()) {
    throw new Error(`Agent wallet mismatch! Expected ${agentWallet.address}, got ${agent.agentWallet}`);
  }
  console.log('  ✓ Agent wallet matches AGENT_PRIVATE_KEY');

  // Step 1: Post job
  console.log('\n[Step 1] Posting job...');
  const jobDataCID = 'test:e2e-complete-' + Date.now();
  const skillId = ethers.ZeroHash;
  const tx1 = await escrowAsPlatform.postJob(jobDataCID, skillId);
  const receipt1 = await tx1.wait();
  
  const jobPostedEvent = receipt1.logs
    .map(log => { try { return escrowAsPlatform.interface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === 'JobPosted');
  const jobId = jobPostedEvent.args.jobId;
  console.log('  Job ID:', jobId.toString());
  console.log('  TX:', tx1.hash);

  // Step 2: Submit proposal
  console.log('\n[Step 2] Submitting proposal...');
  const tx2 = await escrowAsPlatform.submitProposal(jobId, AGENT_ID, JOB_BUDGET, 'test:proposal');
  const receipt2 = await tx2.wait();
  
  const proposalEvent = receipt2.logs
    .map(log => { try { return escrowAsPlatform.interface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === 'ProposalSubmitted');
  const proposalIndex = proposalEvent.args.proposalIndex;
  console.log('  Proposal Index:', proposalIndex.toString());
  console.log('  TX:', tx2.hash);

  // Step 3: Accept proposal
  console.log('\n[Step 3] Accepting proposal...');
  const tx3 = await escrowAsPlatform.acceptProposal(jobId, proposalIndex, { value: JOB_BUDGET });
  await tx3.wait();
  console.log('  TX:', tx3.hash);

  // Step 4: Define milestones
  console.log('\n[Step 4] Defining milestones...');
  const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes('Complete the test task'));
  const tx4 = await escrowAsPlatform.defineMilestones(jobId, [100], [criteriaHash]);
  await tx4.wait();
  console.log('  TX:', tx4.hash);

  // Step 5: Submit milestone (as agent)
  console.log('\n[Step 5] Submitting milestone...');
  const milestoneIndex = 0;
  const outputCID = 'test:output-' + Date.now();
  const alignmentScore = 8500; // 85% - above threshold

  // Sign alignment result
  const messageHash = ethers.keccak256(
    ethers.solidityPacked(
      ['uint256', 'uint8', 'uint256', 'string'],
      [jobId, milestoneIndex, alignmentScore, outputCID]
    )
  );
  const signature = await verifierWallet.signMessage(ethers.getBytes(messageHash));

  console.log('  Output CID:', outputCID);
  console.log('  Alignment Score:', alignmentScore);
  console.log('  Signature:', signature.slice(0, 20) + '...');

  const tx5 = await escrowAsAgent.releaseMilestone(
    jobId,
    milestoneIndex,
    outputCID,
    alignmentScore,
    signature
  );
  const receipt5 = await tx5.wait();
  console.log('  TX:', tx5.hash);
  console.log('  Gas used:', receipt5.gasUsed.toString());

  // Step 6: Verify final state
  console.log('\n[Step 6] Verifying final state...');
  const finalJob = await escrowAsPlatform.getJob(jobId);
  const statusNames = ['OPEN', 'PENDING_MILESTONES', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PARTIALLY_DONE'];
  const mStatusNames = ['PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETRYING'];
  
  console.log('  Job Status:', statusNames[Number(finalJob.status)]);
  console.log('  Total Budget:', ethers.formatEther(finalJob.totalBudgetWei), 'OG');
  console.log('  Released:', ethers.formatEther(finalJob.releasedWei), 'OG');
  console.log('  Milestone 0:');
  console.log('    Status:', mStatusNames[Number(finalJob.milestones[0].status)]);
  console.log('    Alignment Score:', finalJob.milestones[0].alignmentScore.toString());
  console.log('    Output CID:', finalJob.milestones[0].outputCID);

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  if (finalJob.status === 3n) { // COMPLETED
    console.log('  ✅ E2E TEST PASSED!');
    console.log('');
    console.log('  Summary:');
    console.log('  - Job ID:', jobId.toString());
    console.log('  - Agent ID:', AGENT_ID);
    console.log('  - Budget:', ethers.formatEther(finalJob.totalBudgetWei), 'OG');
    console.log('  - Payment Released:', ethers.formatEther(finalJob.releasedWei), 'OG');
    console.log('  - Alignment Score:', finalJob.milestones[0].alignmentScore.toString(), '(threshold: 8000)');
    console.log('');
    console.log('  All transactions verified on 0G Newton Testnet (Chain ID: 16602)');
  } else {
    console.log('  ❌ E2E TEST FAILED');
    console.log('  Job status:', statusNames[Number(finalJob.status)]);
  }
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
