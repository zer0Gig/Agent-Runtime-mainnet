// BigInt serialization polyfill — MUST be first. The @0gfoundation/0g-compute-ts-sdk
// (transitively via ethers v6) calls JSON.stringify on receipt/error objects that
// contain BigInt fields, which throws "Do not know how to serialize a BigInt" and
// blocks ledger.transferFund. Patching toJSON globally is JSON.stringify's documented
// backdoor for unsupported types. Must run before any SDK import.
if (!('toJSON' in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function () { return this.toString(); },
    writable: false, configurable: false, enumerable: false,
  });
}

/**
 * zer0Gig — Agent Runtime
 *
 * A fully decentralized AI agent powered by:
 * - 0G Compute Network → Decentralized LLM inference
 * - 0G Storage → Decentralized file storage
 * - 0G Chain → Smart contract escrow + agent identity
 * - 0G Alignment Nodes → Decentralized quality verification
 */

import "dotenv/config";
import http from "http";
import { ethers } from "ethers";
import { ComputeService } from "./services/computeService.js";
import { StorageService } from "./services/storageService.js";
import { JobProcessor } from "./services/jobProcessor.js";
import { StateManager } from "./services/stateManager.js";
import { AlertDelivery } from "./services/alertDelivery.js";
import { setSubscriptionEscrow } from "./services/eventListener.js";
import { AgentScheduler } from "./services/scheduler.js";

// Minimal ABIs for event listening
const ESCROW_EVENTS_ABI = [
  "event JobCreated(uint256 indexed jobId, address indexed client, uint256 indexed agentId, uint256 totalBudgetWei, string jobDataCID)",
  "event MilestoneDefined(uint256 indexed jobId, uint8 milestoneCount)",
  "event MilestoneApproved(uint256 indexed jobId, uint8 indexed milestoneIndex, uint256 amountWei, uint256 alignmentScore)",
  "event JobCompleted(uint256 indexed jobId, uint256 totalReleasedWei)",
];

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  zer0Gig — Agent Runtime v2.0                    ║");
  console.log("║  Powered by 0G Compute + 0G Storage + 0G Chain  ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── Validate config ──────────────────────────────────────────
  const requiredEnv = [
    "PROGRESSIVE_ESCROW_ADDRESS",
  ];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      console.error(`[Runtime] Missing required env: ${key}`);
      process.exit(1);
    }
  }

  // Warn if Subscription Escrow address is missing (falls back to Progressive Escrow)
  if (!process.env.SUBSCRIPTION_ESCROW_ADDRESS) {
    console.warn("[Runtime] SUBSCRIPTION_ESCROW_ADDRESS not set. Falling back to PROGRESSIVE_ESCROW_ADDRESS.");
  }

  // ── Setup provider & wallet ──────────────────────────────────
  const rpcUrl = process.env.OG_RPC_URL || process.env.OG_NEWTON_RPC || "https://evmrpc.0g.ai";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  // Platform wallet — used for reading chain state and platform-level operations.
  // Agent-specific signing uses dynamically loaded wallet keys from Supabase (ECIES).
  let wallet;
  if (process.env.PLATFORM_PRIVATE_KEY) {
    wallet = new ethers.Wallet(process.env.PLATFORM_PRIVATE_KEY, provider);
  } else {
    // Read-only mode — no platform wallet. Agent operations still work via dynamic keys.
    wallet = null;
    console.log("[Runtime] PLATFORM_PRIVATE_KEY not set — running in read-only mode for platform operations.");
  }

  if (wallet) {
    const blockNumber = await provider.getBlockNumber();
    const balance = await provider.getBalance(wallet.address);

    console.log(`[Runtime] Chain RPC:     ${rpcUrl}`);
    console.log(`[Runtime] Platform Wallet: ${wallet.address}`);
    console.log(`[Runtime] Balance:       ${ethers.formatEther(balance)} OG`);
    console.log(`[Runtime] Block:         ${blockNumber}`);
  } else {
    console.log(`[Runtime] Chain RPC:     ${rpcUrl}`);
    console.log(`[Runtime] Platform Wallet: (read-only mode)`);
  }
  console.log();

  // ── Initialize 0G Services ──────────────────────────────────
  console.log("[Runtime] Initializing 0G services...\n");

  // 0G Storage — Decentralized file storage (needs signer for uploads)
  const storage = wallet ? new StorageService(wallet) : null;

  // State Manager — Orchestrates checkpoint persistence
  if (storage) {
    const stateManager = new StateManager(storage);
    stateManager.startBackgroundSync();

    // Process Exit Handlers for StateManager
    const shutdown = async () => {
      console.log("\n[Runtime] Shutting down... syncing pending state.");
      await stateManager.forceSync();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  // Alert Delivery System — Handles real-time notifications
  const alertDelivery = new AlertDelivery({
    wallet: wallet || provider,
    escrowAddress: process.env.SUBSCRIPTION_ESCROW_ADDRESS || process.env.PROGRESSIVE_ESCROW_ADDRESS,
    storageService: storage,
  });

  // Agent Scheduler — Handles recurring subscription jobs
  const scheduler = new AgentScheduler({ alertDelivery, storageService: storage });

  // ── Listen for blockchain events ─────────────────────────────
  const progressiveEscrowAddress = process.env.PROGRESSIVE_ESCROW_ADDRESS;
  const subscriptionEscrowAddress = process.env.SUBSCRIPTION_ESCROW_ADDRESS || progressiveEscrowAddress; // Fallback
  const escrow = new ethers.Contract(progressiveEscrowAddress, ESCROW_EVENTS_ABI, provider);
  const myAgentId = BigInt(process.env.AGENT_ID);

  // Initialize subscription escrow contract for alert delivery
  const SUBSCRIPTION_ESCROW_ABI = [
    "function drainPerAlert(uint256 subscriptionId, bytes calldata alertData) external",
    // OKX APP session-voucher schema (preview) — names cosmetic, storage slots unchanged; see docs/contracts/OKX_session_voucher_design.md
    "function getSubscription(uint256 subscriptionId) view returns (tuple(uint256 subscriptionId, address client, uint256 agentId, address agentWallet, string taskDescription, uint256 intervalSeconds, uint8 intervalMode, uint256 checkInRate, uint256 alertRate, uint256 balance, uint256 totalDrained, uint8 status, uint256 createdAt, uint256 lastCheckIn, uint256 pausedAt, uint256 gracePeriodEnds, uint256 gracePeriodSeconds, bool sessionVoucherEnabled, uint8 voucherMode, bytes clientVoucherSig, string webhookUrl, uint256 proposedInterval))",
    "event AlertFired(uint256 indexed subscriptionId, uint256 indexed agentId, uint256 timestamp, bytes alertData, uint256 amountDrained)",
    // Subscription events (BUG-3 FIX: add missing event signatures)
    "event SubscriptionCreated(uint256 indexed subscriptionId, uint256 indexed agentId, address client, uint256 budget)",
    "event SubscriptionPaused(uint256 indexed subscriptionId, string reason)",
    "event SubscriptionCancelled(uint256 indexed subscriptionId, string reason, uint256 refund)",
  ];
  
  // BUG-2 FIX: Use wallet (signer) for state-changing transactions, or provider for read-only
  const subscriptionEscrow = wallet
    ? new ethers.Contract(subscriptionEscrowAddress, SUBSCRIPTION_ESCROW_ABI, wallet)
    : new ethers.Contract(subscriptionEscrowAddress, SUBSCRIPTION_ESCROW_ABI, provider);

  console.log(`[Runtime] Listening for events on ProgressiveEscrow: ${progressiveEscrowAddress}`);
  console.log(`[Runtime] SubscriptionEscrow: ${subscriptionEscrowAddress}`);
  console.log(`[Runtime] Filtering for Agent ID: ${myAgentId}\n`);

  // Initialize alert delivery system
  await alertDelivery.initialize(subscriptionEscrow);
  setSubscriptionEscrow(subscriptionEscrow);  // BUG-1 FIX: Initialize event listener contract
  console.log("[Runtime] Alert delivery system initialized.");

  // New job created → check if it's for us
  escrow.on("JobCreated", async (jobId, client, agentId, totalBudgetWei, jobDataCID) => {
    console.log(`[Event] JobCreated #${jobId} | Agent: ${agentId} | Budget: ${ethers.formatEther(totalBudgetWei)} OG`);

    if (agentId === myAgentId) {
      console.log(`[Event] This job is for us! Waiting for milestones to be defined...`);
    }
  });

  // Milestones defined → start working
  escrow.on("MilestoneDefined", async (jobId, milestoneCount) => {
    console.log(`[Event] MilestoneDefined #${jobId} | ${milestoneCount} milestones`);

    // Check if this job belongs to our agent
    try {
      const jobContract = new ethers.Contract(
        progressiveEscrowAddress,
        ["function getJob(uint256) view returns (tuple(uint256,address,uint256,address,uint256,uint256,uint8,tuple(uint8,uint256,uint8,bytes32,string,uint256,uint256,uint256,uint256)[],uint256,string,bytes32))"],
        provider
      );
      const job = await jobContract.getJob(jobId);
      if (job[2] === myAgentId) { // agentId is at index 2
        console.log(`[Event] Our job! Starting processing...`);
        // Small delay to ensure chain state is settled
        setTimeout(() => processor.processJob(jobId), 3000);
      }
    } catch (err) {
      console.log(`[Event] Could not check job: ${err.message?.slice(0, 80)}`);
    }
  });

  // Milestone approved → log earnings
  escrow.on("MilestoneApproved", (jobId, milestoneIndex, amountWei, alignmentScore) => {
    console.log(`[Event] MilestoneApproved #${jobId} M${milestoneIndex} | +${ethers.formatEther(amountWei)} OG | Score: ${alignmentScore}`);
  });

  // Job completed
  escrow.on("JobCompleted", (jobId, totalReleasedWei) => {
    console.log(`[Event] JobCompleted #${jobId} | Total earned: ${ethers.formatEther(totalReleasedWei)} OG`);
  });

  // ── Listen for SubscriptionEscrow events ───────────────────────────────────
  console.log(`[Runtime] Listening for events on SubscriptionEscrow: ${subscriptionEscrowAddress}`);
  
  // New subscription created → schedule recurring job
  subscriptionEscrow.on("SubscriptionCreated", async (subscriptionId, agentId, client, budget) => {
    console.log(`[Event] SubscriptionCreated #${subscriptionId} | Agent: ${agentId} | Budget: ${ethers.formatEther(budget)} OG`);
    
    if (agentId.toString() === myAgentId.toString()) {
      console.log(`[Event] This subscription is for us! Setting up scheduler...`);
      await handleSubscription(subscriptionId, storage, scheduler, alertDelivery, wallet, myAgentId, subscriptionEscrow);
    }
  });
  
  // Subscription paused → log and potentially notify
  subscriptionEscrow.on("SubscriptionPaused", async (subscriptionId, reason) => {
    console.log(`[Event] SubscriptionPaused #${subscriptionId} | Reason: ${reason}`);
    
    // Send alert about subscription pause
    await alertDelivery.sendBalanceLow(
      subscriptionId.toString(),
      myAgentId.toString(),
      0, // current balance (not available in event)
      0  // threshold (not available in event)
    );
  });
  
  // Subscription cancelled → cleanup
  subscriptionEscrow.on("SubscriptionCancelled", async (subscriptionId, reason, refund) => {
    console.log(`[Event] SubscriptionCancelled #${subscriptionId} | Reason: ${reason} | Refund: ${ethers.formatEther(refund)} OG`);
    
    // Cancel the scheduled job
    await scheduler.cancelJob(`sub-${subscriptionId}`);
  });

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Agent is LIVE. Waiting for jobs and subscriptions... ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // Start auto-persist for scheduler state
  scheduler.startAutoPersist();

  // Recover existing subscriptions from on-chain
  await recoverSubscriptions(subscriptionEscrow, scheduler, myAgentId);

  startHealthCheck();
}

async function handleSubscription(subscriptionId, storageService, schedulerInstance, alertDeliveryInstance, walletInstance, agentId, subscriptionEscrowContract) {
  try {
    const sub = await subscriptionEscrowContract.getSubscription(subscriptionId);
    const subAgentId = Number(sub.agentId);

    if (subAgentId !== agentId) {
      console.log(`[Sub] Skipping subscription ${subscriptionId} — not my agent`);
      return;
    }

    if (Number(sub.status) === 3) {
      console.log(`[Sub] Skipping subscription ${subscriptionId} — cancelled`);
      return;
    }

    const cronExpr = _intervalToCron(Number(sub.intervalSeconds));
    if (!cronExpr) {
      console.warn(`[Sub] Unsupported interval: ${sub.intervalSeconds}s for sub ${subscriptionId}`);
      return;
    }

    console.log(`[Sub] New subscription ${subscriptionId}: "${sub.taskDescription}" → ${cronExpr}`);

    // Log event to 0G if storage available
    if (storageService?.appendEscrowEvent) {
      await storageService.appendEscrowEvent("SubscriptionEscrow", "SubscriptionCreated", {
        subscriptionId: subscriptionId.toString(),
        agentId: subAgentId,
        taskDescription: sub.taskDescription,
        intervalSeconds: Number(sub.intervalSeconds),
      });
    }

    // Schedule the job
    await schedulerInstance.scheduleJob(
      subscriptionId.toString(),
      cronExpr,
      async (checkpoint) => {
        const result = await _executeMonitoringTask(sub, checkpoint);

        if (_detectAnomaly(result, sub)) {
          await alertDeliveryInstance?.sendAnomalyDetected(
            subscriptionId.toString(),
            agentId.toString(),
            sub.taskDescription,
            result.threshold || 0,
            result.value || 0
          );
        }

        return result;
      },
      {
        subscriptionId: subscriptionId.toString(),
        agentId: agentId.toString(),
        taskDescription: sub.taskDescription,
      }
    );

    // Log execution to 0G
    if (storageService?.appendExecutionLog) {
      await storageService.appendExecutionLog(subscriptionId.toString(), {
        phase: "scheduled",
        agentId: agentId.toString(),
        input: {
          taskDescription: sub.taskDescription,
          intervalSeconds: Number(sub.intervalSeconds),
          cronExpression: cronExpr,
        },
        timestamp: Math.floor(Date.now() / 1000),
      });
    }

    console.log(`[Sub] Successfully scheduled subscription ${subscriptionId}`);
  } catch (err) {
    console.error(`[Sub] Failed to handle subscription ${subscriptionId}: ${err.message}`);
  }
}

async function recoverSubscriptions(subscriptionEscrowContract, schedulerInstance, agentId) {
  console.log("[Recovery] Scanning for existing subscriptions...");

  try {
    const total = await subscriptionEscrowContract.totalSubscriptions();
    console.log(`[Recovery] Found ${total} total subscriptions on-chain`);

    let recovered = 0;

    for (let i = 1; i <= Number(total); i++) {
      try {
        const sub = await subscriptionEscrowContract.getSubscription(i);
        const subAgentId = Number(sub.agentId);

        if (subAgentId !== agentId) continue;
        if (Number(sub.status) === 3) continue;

        const cronExpr = _intervalToCron(Number(sub.intervalSeconds));
        if (!cronExpr) {
          console.warn(`[Recovery] Unsupported interval for sub ${i}: ${sub.intervalSeconds}s`);
          continue;
        }

        schedulerInstance.scheduleJob(
          i.toString(),
          cronExpr,
          async (checkpoint) => {
            return await _executeMonitoringTask(sub, checkpoint);
          },
          {
            subscriptionId: i.toString(),
            agentId: agentId.toString(),
            taskDescription: sub.taskDescription,
          }
        );

        recovered++;
        console.log(`[Recovery] Recovered subscription ${i}: "${sub.taskDescription}" (${cronExpr})`);
      } catch (err) {
        console.warn(`[Recovery] Failed to recover subscription ${i}: ${err.message?.slice(0, 80)}`);
      }
    }

    console.log(`[Recovery] Done. Recovered ${recovered} subscription(s).`);
  } catch (err) {
    console.error(`[Recovery] Failed to scan subscriptions: ${err.message}`);
  }
}

function startHealthCheck(port = parseInt(process.env.PORT || "10000")) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "zer0gig-runtime-path-a" }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not found" }));
    }
  });

  server.listen(port, () => {
    console.log(`[HealthCheck] Listening on port ${port}`);
  });

  return server;
}

// Helper function to convert interval seconds to cron expression
function _intervalToCron(intervalSeconds) {
  if (intervalSeconds === 0n || intervalSeconds === 0) {
    // Should not happen - this should be handled by interval approval
    return null;
  }
  
  if (intervalSeconds === BigInt(2)**BigInt(256) - BigInt(1)) {
    // AUTO mode - use a reasonable default (every 5 minutes for demo)
    return '*/5 * * * *';
  }
  
  const interval = Number(intervalSeconds);
  
  // Handle common intervals
  if (interval === 60) return '* * * * *';           // Every minute
  if (interval === 300) return '*/5 * * * *';        // Every 5 minutes  
  if (interval === 600) return '*/10 * * * *';       // Every 10 minutes
  if (interval === 900) return '*/15 * * * *';       // Every 15 minutes
  if (interval === 1800) return '*/30 * * * *';      // Every 30 minutes
  if (interval === 3600) return '0 * * * *';         // Hourly
  if (interval === 7200) return '0 */2 * * *';       // Every 2 hours
  if (interval === 14400) return '0 */4 * * *';      // Every 4 hours
  if (interval === 28800) return '0 */8 * * *';      // Every 8 hours
  if (interval === 43200) return '0 */12 * * *';     // Every 12 hours
  if (interval === 86400) return '0 0 * * *';        // Daily
  
  // For other intervals, approximate to nearest supported cron
  if (interval < 60) return '* * * * *';             // Less than 1 min → every minute
  if (interval < 300) return '*/5 * * * *';          // Less than 5 min → every 5 min
  if (interval < 900) return '*/15 * * * *';         // Less than 15 min → every 15 min
  if (interval < 3600) return '0 */1 * * *';         // Less than 1 hour → hourly
  if (interval < 86400) return '0 0 * * *';          // Less than 1 day → daily
  
  return '0 0 * * *'; // Default to daily for very long intervals
}

// Helper function to execute monitoring task
async function _executeMonitoringTask(subscription, checkpoint) {
  console.log(`[Scheduler] Executing monitoring task for subscription ${subscription.subscriptionId}`);
  
  // This is where the actual AI agent logic would go
  // For demo purposes, we'll simulate different types of monitoring
  
  const taskDescription = subscription.taskDescription.toLowerCase();
  
  if (taskDescription.includes('wallet') || taskDescription.includes('balance')) {
    // Simulate wallet balance monitoring
    const currentBalance = Math.random() * 20; // Random balance 0-20 OG
    const threshold = 10; // Alert if below 10 OG
    
    return {
      type: 'wallet_balance',
      value: currentBalance,
      threshold: threshold,
      timestamp: Date.now(),
      description: `Wallet balance is ${currentBalance.toFixed(2)} OG`
    };
  }
  
  if (taskDescription.includes('price') || taskDescription.includes('btc')) {
    // Simulate price monitoring
    const currentPrice = Math.random() * 150000; // Random price 0-150k
    const threshold = 100000; // Alert if above 100k
    
    return {
      type: 'price_monitoring',
      value: currentPrice,
      threshold: threshold,
      timestamp: Date.now(),
      description: `BTC price is $${currentPrice.toFixed(2)}`
    };
  }
  
  // Default generic monitoring
  return {
    type: 'generic_monitoring',
    value: Math.random(),
    threshold: 0.5,
    timestamp: Date.now(),
    description: `Generic monitoring result for: ${subscription.taskDescription}`
  };
}

// Helper function to detect anomalies
function _detectAnomaly(result, subscription) {
  // Simple anomaly detection based on result type
  if (result.type === 'wallet_balance') {
    return result.value < result.threshold; // Alert if balance below threshold
  }
  
  if (result.type === 'price_monitoring') {
    return result.value > result.threshold; // Alert if price above threshold
  }
  
  // For generic monitoring, randomly trigger anomalies for demo
  return Math.random() < 0.3; // 30% chance of anomaly
}

main().catch((err) => {
  console.error("[Runtime] Fatal error:", err);
  process.exit(1);
});
