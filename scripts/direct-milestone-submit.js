/**
 * Direct Milestone Submission Test
 * 
 * This script directly submits a milestone for Job 2, bypassing the LLM call,
 * to verify the escrow contract flow works correctly.
 */

import 'dotenv/config';
import { ethers } from 'ethers';

// Config
const RPC_URL = process.env.OG_RPC_URL || process.env.OG_NEWTON_RPC || 'https://evmrpc.0g.ai';
const ESCROW_ADDRESS = process.env.PROGRESSIVE_ESCROW_ADDRESS;
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY; // Agent wallet key
const ALIGNMENT_VERIFIER_KEY = process.env.ALIGNMENT_VERIFIER_KEY; // For signing

const ESCROW_ABI = [
  'function releaseMilestone(uint256 jobId, uint8 milestoneIndex, string calldata outputCID, uint256 alignmentScore, bytes calldata signature) external',
  'function getJob(uint256 jobId) external view returns (tuple(uint256 jobId, address client, uint256 agentId, address agentWallet, uint256 totalBudgetWei, uint256 releasedWei, uint8 status, tuple(uint8 percentage, uint256 amountWei, uint8 status, bytes32 criteriaHash, string outputCID, uint256 alignmentScore, uint256 retryCount, uint256 submittedAt, uint256 completedAt)[] milestones, uint256 createdAt, string jobDataCID, bytes32 skillId))',
];

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Direct Milestone Submission Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  // Agent wallet signs the releaseMilestone transaction
  const agentWallet = new ethers.Wallet(AGENT_PRIVATE_KEY, provider);
  console.log('[Setup] Agent Wallet:', agentWallet.address);
  
  // Alignment verifier signs the score
  const verifierWallet = new ethers.Wallet(ALIGNMENT_VERIFIER_KEY.replace('0x', ''), provider);
  console.log('[Setup] Verifier Wallet:', verifierWallet.address);
  
  const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, agentWallet);

  const jobId = 2n;
  const milestoneIndex = 0;
  const outputCID = 'test:milestone-output-' + Date.now();
  const alignmentScore = 8500; // 85% - above 80% threshold

  // Check job state first
  console.log('\n[Step 1] Checking job state...');
  const job = await escrow.getJob(jobId);
  console.log('  Job Status:', ['OPEN', 'PENDING_MILESTONES', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PARTIALLY_DONE'][job.status]);
  console.log('  Agent Wallet from contract:', job.agentWallet);
  console.log('  Our Agent Wallet:', agentWallet.address);
  
  if (job.agentWallet.toLowerCase() !== agentWallet.address.toLowerCase()) {
    throw new Error('Agent wallet mismatch! Cannot submit milestone.');
  }

  // Generate alignment signature
  console.log('\n[Step 2] Generating alignment signature...');
  const messageHash = ethers.keccak256(
    ethers.solidityPacked(
      ['uint256', 'uint8', 'uint256', 'string'],
      [jobId, milestoneIndex, alignmentScore, outputCID]
    )
  );
  console.log('  Message Hash:', messageHash);
  
  // Sign as ETH signed message
  const signature = await verifierWallet.signMessage(ethers.getBytes(messageHash));
  console.log('  Signature:', signature.slice(0, 20) + '...');

  // Submit milestone
  console.log('\n[Step 3] Submitting milestone...');
  try {
    const tx = await escrow.releaseMilestone(
      jobId,
      milestoneIndex,
      outputCID,
      alignmentScore,
      signature
    );
    console.log('  TX Hash:', tx.hash);
    
    const receipt = await tx.wait();
    console.log('  Confirmed in block:', receipt.blockNumber);
    console.log('  Gas used:', receipt.gasUsed.toString());

    // Check final state
    console.log('\n[Step 4] Verifying final state...');
    const finalJob = await escrow.getJob(jobId);
    const statusNames = ['OPEN', 'PENDING_MILESTONES', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PARTIALLY_DONE'];
    const mStatusNames = ['PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETRYING'];
    
    console.log('  Job Status:', statusNames[Number(finalJob.status)]);
    console.log('  Released:', ethers.formatEther(finalJob.releasedWei), 'OG');
    console.log('  Milestone 0:');
    console.log('    Status:', mStatusNames[Number(finalJob.milestones[0].status)]);
    console.log('    Alignment Score:', finalJob.milestones[0].alignmentScore.toString());

    if (finalJob.status === 3n) {
      console.log('\n✅ SUCCESS! Job 2 completed!');
      console.log('  Payment of', ethers.formatEther(finalJob.releasedWei), 'OG released to agent.');
    }

  } catch (err) {
    console.error('\n❌ Transaction failed:', err.message);
    // Try to decode revert reason
    if (err.data) {
      console.error('  Revert data:', err.data);
    }
  }
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
