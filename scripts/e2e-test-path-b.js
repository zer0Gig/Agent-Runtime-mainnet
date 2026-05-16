/**
 * E2E Integration Test for Path B (Platform-Managed Agent)
 * 
 * This script simulates the full job lifecycle:
 * 1. Client posts a job
 * 2. Agent owner submits proposal
 * 3. Client accepts proposal with payment
 * 4. Client defines milestones
 * 5. Platform dispatcher picks up and processes the job
 */

import 'dotenv/config';
import { ethers } from 'ethers';

// Contract ABIs (minimal)
const ESCROW_ABI = [
  'function postJob(string calldata jobDataCID, bytes32 skillId) external returns (uint256 jobId)',
  'function submitProposal(uint256 jobId, uint256 agentId, uint256 proposedRateWei, string calldata descriptionCID) external',
  'function acceptProposal(uint256 jobId, uint256 proposalIndex) external payable',
  'function defineMilestones(uint256 jobId, uint8[] calldata percentages, bytes32[] calldata criteriaHashes) external',
  'function getJob(uint256 jobId) external view returns (tuple(uint256 jobId, address client, uint256 agentId, address agentWallet, uint256 totalBudgetWei, uint256 releasedWei, uint8 status, tuple(uint8 percentage, uint256 amountWei, uint8 status, bytes32 criteriaHash, string outputCID, uint256 alignmentScore, uint256 retryCount, uint256 submittedAt, uint256 completedAt)[] milestones, uint256 createdAt, string jobDataCID, bytes32 skillId))',
  'function totalJobs() external view returns (uint256)',
  'event JobPosted(uint256 indexed jobId, address indexed client, bytes32 skillId, string jobDataCID)',
  'event ProposalSubmitted(uint256 indexed jobId, uint256 proposalIndex, uint256 indexed agentId, uint256 proposedRateWei)',
  'event ProposalAccepted(uint256 indexed jobId, uint256 proposalIndex, uint256 indexed agentId, uint256 budgetWei)',
  'event MilestoneDefined(uint256 indexed jobId, uint8 milestoneCount)',
  'event MilestoneApproved(uint256 indexed jobId, uint8 indexed milestoneIndex, uint256 amountWei, uint256 alignmentScore)',
];

const AGENT_REGISTRY_ABI = [
  'function getAgentProfile(uint256 agentId) external view returns (tuple(address owner, address agentWallet, bytes eciesPublicKey, bytes32 capabilityHash, string capabilityCID, string profileCID, uint256 overallScore, uint256 totalJobsCompleted, uint256 totalJobsAttempted, uint256 totalEarningsWei, uint256 defaultRate, uint256 createdAt, bool isActive))',
];

// Config
const RPC_URL = process.env.OG_RPC_URL || process.env.OG_NEWTON_RPC || 'https://evmrpc.0g.ai';
const ESCROW_ADDRESS = process.env.PROGRESSIVE_ESCROW_ADDRESS;
const AGENT_REGISTRY_ADDRESS = process.env.AGENT_REGISTRY_ADDRESS;

// We use the platform wallet as both client and agent owner for testing
const PLATFORM_KEY = process.env.PLATFORM_PRIVATE_KEY;
const AGENT_ID = parseInt(process.env.PLATFORM_AGENT_IDS?.split(',')[0] || '2');

// Test parameters
const JOB_BUDGET = ethers.parseEther('0.001'); // 0.001 OG for test
const JOB_DATA_CID = 'test:e2e-path-b-' + Date.now(); // Inline test data

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  E2E Integration Test - Path B (Platform-Managed Agent)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Setup provider and signer
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PLATFORM_KEY, provider);
  
  console.log('[Setup] Network:', RPC_URL);
  console.log('[Setup] Test Wallet:', signer.address);
  
  const balance = await provider.getBalance(signer.address);
  console.log('[Setup] Balance:', ethers.formatEther(balance), 'OG');
  
  if (balance < JOB_BUDGET * 2n) {
    throw new Error('Insufficient balance for test. Need at least 0.002 OG');
  }

  // Connect to contracts
  const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, signer);
  const registry = new ethers.Contract(AGENT_REGISTRY_ADDRESS, AGENT_REGISTRY_ABI, provider);

  // Verify agent exists
  console.log('\n[Step 0] Verifying Agent', AGENT_ID, 'exists...');
  const agent = await registry.getAgentProfile(AGENT_ID);
  console.log('  Agent Owner:', agent.owner);
  console.log('  Agent Wallet:', agent.agentWallet);
  console.log('  Is Active:', agent.isActive);
  
  if (!agent.isActive) {
    throw new Error('Agent is not active');
  }
  
  // Verify we own the agent
  if (agent.owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log('  WARNING: Test wallet is not the agent owner.');
    console.log('  Agent owner:', agent.owner);
    console.log('  Test wallet:', signer.address);
    console.log('  For this test, we need to be the agent owner to submit proposals.');
    throw new Error('Test wallet must be agent owner');
  }

  // Step 1: Post a job
  console.log('\n[Step 1] Posting job...');
  const skillId = ethers.ZeroHash; // General job, no specific skill
  const tx1 = await escrow.postJob(JOB_DATA_CID, skillId);
  const receipt1 = await tx1.wait();
  
  const jobPostedEvent = receipt1.logs
    .map(log => { try { return escrow.interface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === 'JobPosted');
  
  const jobId = jobPostedEvent.args.jobId;
  console.log('  Job ID:', jobId.toString());
  console.log('  TX:', tx1.hash);

  // Step 2: Submit proposal
  console.log('\n[Step 2] Submitting proposal...');
  const proposalDescCID = 'test:proposal-' + Date.now();
  const tx2 = await escrow.submitProposal(jobId, AGENT_ID, JOB_BUDGET, proposalDescCID);
  const receipt2 = await tx2.wait();
  
  const proposalEvent = receipt2.logs
    .map(log => { try { return escrow.interface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === 'ProposalSubmitted');
  
  const proposalIndex = proposalEvent.args.proposalIndex;
  console.log('  Proposal Index:', proposalIndex.toString());
  console.log('  TX:', tx2.hash);

  // Step 3: Accept proposal
  console.log('\n[Step 3] Accepting proposal with', ethers.formatEther(JOB_BUDGET), 'OG deposit...');
  const tx3 = await escrow.acceptProposal(jobId, proposalIndex, { value: JOB_BUDGET });
  const receipt3 = await tx3.wait();
  console.log('  TX:', tx3.hash);

  // Step 4: Define milestones
  console.log('\n[Step 4] Defining milestones (100% single milestone)...');
  const criteriaHash = ethers.keccak256(ethers.toUtf8Bytes('Complete the E2E test task'));
  const tx4 = await escrow.defineMilestones(jobId, [100], [criteriaHash]);
  const receipt4 = await tx4.wait();
  console.log('  TX:', tx4.hash);

  // Verify job state
  console.log('\n[Step 5] Verifying job state...');
  const job = await escrow.getJob(jobId);
  console.log('  Job Status:', ['OPEN', 'PENDING_MILESTONES', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PARTIALLY_DONE'][job.status]);
  console.log('  Agent ID:', job.agentId.toString());
  console.log('  Agent Wallet:', job.agentWallet);
  console.log('  Total Budget:', ethers.formatEther(job.totalBudgetWei), 'OG');
  console.log('  Milestones:', job.milestones.length);

  if (job.status !== 2n) { // IN_PROGRESS = 2
    throw new Error('Job should be IN_PROGRESS but is: ' + job.status);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Job Created Successfully!');
  console.log('  Job ID:', jobId.toString());
  console.log('  ');
  console.log('  The Platform Dispatcher should now:');
  console.log('  1. Detect the job assignment');
  console.log('  2. Call 0G Compute to process the job');
  console.log('  3. Submit milestone with alignment score');
  console.log('  4. Call releaseMilestone on-chain');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Wait for dispatcher to process (optional polling)
  console.log('[Monitoring] Waiting for Platform Dispatcher to process...');
  console.log('  (Polling job status every 10 seconds, max 2 minutes)\n');

  const startTime = Date.now();
  const maxWait = 120000; // 2 minutes
  
  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, 10000));
    
    const currentJob = await escrow.getJob(jobId);
    const statusNames = ['OPEN', 'PENDING_MILESTONES', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PARTIALLY_DONE'];
    const statusName = statusNames[Number(currentJob.status)];
    
    console.log(`  [${Math.round((Date.now() - startTime) / 1000)}s] Status: ${statusName}, Released: ${ethers.formatEther(currentJob.releasedWei)} OG`);
    
    if (currentJob.status === 3n) { // COMPLETED
      console.log('\n✅ SUCCESS! Job completed by Platform Dispatcher!');
      console.log('  Released to Agent:', ethers.formatEther(currentJob.releasedWei), 'OG');
      
      // Check milestone details
      if (currentJob.milestones.length > 0) {
        const m = currentJob.milestones[0];
        console.log('  Milestone 0:');
        console.log('    Status:', ['PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETRYING'][m.status]);
        console.log('    Alignment Score:', m.alignmentScore.toString());
        console.log('    Output CID:', m.outputCID);
      }
      return;
    }
    
    if (currentJob.status === 4n || currentJob.status === 5n) { // CANCELLED or PARTIALLY_DONE
      console.log('\n❌ Job ended with status:', statusName);
      return;
    }
  }
  
  console.log('\n⚠️ Timeout: Job did not complete within 2 minutes.');
  console.log('  The Platform Dispatcher may not be running or encountered an error.');
  console.log('  Check platform-dispatcher.log for details.');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
