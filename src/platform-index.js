// BigInt serialization polyfill — MUST be first. See src/index.js for rationale.
if (!('toJSON' in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function () { return this.toString(); },
    writable: false, configurable: false, enumerable: false,
  });
}

/**
 * Platform Dispatcher Entry Point (Path B)
 *
 * Runs the Platform Dispatcher which manages jobs for multiple registered agents.
 * This is an alternative to `index.js` (Path A - Self-Hosted).
 *
 * Usage:
 *   npm run start:platform
 */

import "dotenv/config";
import http from "http";
import { ethers } from "ethers";
import { PlatformDispatcher } from "./services/platformDispatcher.js";
import { initTelegram, getBotStatus } from "./services/telegramConnector.js";

// ── In-memory log buffer (circular, last 2000 entries) ──────────────────────
const LOG_BUFFER = [];
const LOG_MAX = 2000;
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
const _origInfo = console.info;

function _pushLog(level, args) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "),
  };
  LOG_BUFFER.push(entry);
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
}

console.log = (...args) => { _pushLog("info", args); _origLog.apply(console, args); };
console.warn = (...args) => { _pushLog("warn", args); _origWarn.apply(console, args); };
console.error = (...args) => { _pushLog("error", args); _origError.apply(console, args); };
console.info = (...args) => { _pushLog("info", args); _origInfo.apply(console, args); };

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  zer0Gig Platform Dispatcher (Path B)            ║");
  console.log("║  Managing Platform-Managed Agents                ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── Validate config ──────────────────────────────────────────
  const requiredEnv = [
    "PLATFORM_PRIVATE_KEY",
    "AGENT_REGISTRY_ADDRESS",
    "PROGRESSIVE_ESCROW_ADDRESS"
  ];

  for (const key of requiredEnv) {
    const val = process.env[key];
    if (!val) {
      console.error(`[Platform] Missing required env: ${key}`);
      process.exit(1);
    }
    // Debug: show length and first/last chars without leaking full key
    const mask = val.length > 8 ? `${val.slice(0,4)}...${val.slice(-4)}` : "(too short)";
    console.log(`[Platform] ${key} loaded: length=${val.length} value=${mask}`);
  }

  // PLATFORM_AGENT_IDS is optional — auto-discovery will find agents
  const managedIds = process.env.PLATFORM_AGENT_IDS
    ? process.env.PLATFORM_AGENT_IDS.split(",")
    : [];

  // Parse AGENT_WALLET_KEYS — format "agentId:privKey,agentId:privKey"
  // Each agent's privKey signs releaseMilestone (contract requires msg.sender == job.agentWallet).
  const agentWalletKeys = {};
  if (process.env.AGENT_WALLET_KEYS) {
    for (const entry of process.env.AGENT_WALLET_KEYS.split(",")) {
      const [id, key] = entry.trim().split(":");
      if (id && key) {
        // Railway sometimes reverts env vars to placeholder text — skip those
        if (key.includes("your_") || key.includes("placeholder") || key.includes("<UNKNOWN>")) {
          console.warn(`[Platform] Skipping placeholder key for agent ${id}`);
          continue;
        }
        agentWalletKeys[id.trim()] = key.trim();
      }
    }
  }

  // ── Setup provider & wallet ──────────────────────────────────
  const rpcUrl = process.env.OG_RPC_URL || process.env.OG_NEWTON_RPC || "https://evmrpc.0g.ai";
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Validate private key format before creating wallet
  const pk = process.env.PLATFORM_PRIVATE_KEY;
  if (pk.includes("<UNKNOWN>") || pk.includes("your_") || pk.includes("placeholder")) {
    console.error("[Platform] PLATFORM_PRIVATE_KEY contains placeholder text!");
    console.error(`[Platform] Current value starts with: "${pk.slice(0,20)}..."`);
    console.error("[Platform] Please set the real private key in Railway Dashboard → Variables");
    process.exit(1);
  }

  const wallet = new ethers.Wallet(pk, provider);

  const blockNumber = await provider.getBlockNumber();
  const balance = await provider.getBalance(wallet.address);

  console.log(`[Platform] Chain RPC:         ${rpcUrl}`);
  console.log(`[Platform] Operator Wallet:   ${wallet.address}`);
  console.log(`[Platform] Balance:           ${ethers.formatEther(balance)} OG`);
  console.log(`[Platform] Block:             ${blockNumber}`);
  console.log(`[Platform] Managed Agents:    ${managedIds.length > 0 ? managedIds.join(", ") : "(auto-discover)"}`);
  console.log(`[Platform] Agent Wallet Keys: ${Object.keys(agentWalletKeys).length > 0 ? Object.keys(agentWalletKeys).join(", ") : "(NONE — agents must register with encrypted wallet keys in Supabase)"}`);
  console.log(`[Platform] ProgressiveEscrow: ${process.env.PROGRESSIVE_ESCROW_ADDRESS}`);
  console.log(`[Platform] SubscriptionEscrow:${process.env.SUBSCRIPTION_ESCROW_ADDRESS || "(fallback to ProgressiveEscrow)"}`);
  console.log();

  // ── Initialize Telegram Bot (if token configured) ────────────
  const tgBot = initTelegram();
  if (tgBot) {
    console.log(`[Platform] Telegram: bot active (${process.env.TELEGRAM_WEBHOOK_URL ? "webhook" : "polling"} mode)`);
  } else {
    console.log(`[Platform] Telegram: disabled (set TELEGRAM_BOT_TOKEN to enable)`);
  }
  console.log();

  // ── Initialize Dispatcher ────────────────────────────────────
  const dispatcher = new PlatformDispatcher({
    wallet,
    rpcUrl,
    registryAddress: process.env.AGENT_REGISTRY_ADDRESS,
    escrowAddress: process.env.PROGRESSIVE_ESCROW_ADDRESS,
    subscriptionEscrowAddress: process.env.SUBSCRIPTION_ESCROW_ADDRESS,
    managedAgentIds: managedIds,
    agentWalletKeys
  });

  // ── Start Listening ──────────────────────────────────────────
  try {
    await dispatcher.start();
  } catch (error) {
    console.error("[Platform] Fatal error:", error);
    process.exit(1);
  }

  // ── Graceful Shutdown ────────────────────────────────────────
  const shutdown = async (signal) => {
    console.log(`\n[Platform] ${signal} received — shutting down...`);
    await dispatcher.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  startHealthCheck(undefined, dispatcher);
}

function startHealthCheck(port = parseInt(process.env.PORT || "10000"), dispatcher = null) {
  const bot           = process.env.TELEGRAM_WEBHOOK_URL ? initTelegram() : null;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || null;

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      Promise.resolve(bot ? getBotStatus() : { active: false, mode: null }).then((tg) => {
        const kv = dispatcher?.storage?.getKvHealth ? dispatcher.storage.getKvHealth() : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          service: "zer0gig-runtime-platform",
          telegram: tg,
          kvNode: kv,
        }));
      }).catch(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "zer0gig-runtime-platform" }));
      });
      return;
    }

    // Debug endpoint — exposes runtime state for troubleshooting
    if (req.url === "/debug/status" && req.method === "GET") {
      const schedulerJobs = dispatcher?.scheduler ? dispatcher.scheduler.getAllJobs() : [];
      const agentWallets = dispatcher ? Array.from(dispatcher.agentWallets.keys()) : [];
      const computeServices = dispatcher ? Array.from(dispatcher.computeServices.keys()) : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        managedAgents: dispatcher ? Array.from(dispatcher.managedAgentIds) : [],
        agentConfigsLoaded: dispatcher ? Array.from(dispatcher.agentConfigs.keys()) : [],
        agentWalletsLoaded: agentWallets,
        computeServicesCached: computeServices,
        activeCsBots: dispatcher ? Array.from(dispatcher.customerServiceBots.keys()) : [],
        runningBotTokens: dispatcher ? Array.from(dispatcher._runningBotTokens) : [],
        eventWatchersCount: dispatcher ? dispatcher._eventWatchers.length : 0,
        registryAddress: dispatcher?.registryAddress,
        escrowAddress: dispatcher?.escrowAddress,
        subscriptionEscrowAddress: dispatcher?.subscriptionEscrowAddress,
        schedulerJobs: schedulerJobs.map(j => ({ jobId: j.jobId, cron: j.cron, metadata: j.metadata })),
        env: {
          hasSupabase: !!process.env.SUPABASE_URL,
          hasPlatformKey: !!process.env.PLATFORM_PRIVATE_KEY,
          hasEncryptionKey: !!process.env.PLATFORM_ENCRYPTION_PRIVATE_KEY,
          hasAgentWalletsLoaded: dispatcher?.agentWallets?.size || 0,
          hasAgentWalletKeys: !!process.env.AGENT_WALLET_KEYS,
          hasTelegramToken: !!process.env.TELEGRAM_BOT_TOKEN,
          rpcUrl: process.env.OG_NEWTON_RPC || "default",
        },
      }, null, 2));
      return;
    }

    // Trigger recovery — force re-scan on-chain for missed jobs/subscriptions
    if (req.url === "/debug/trigger-recover" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const params = body ? JSON.parse(body) : {};
          const results = {};

          if (dispatcher) {
            if (params.jobs !== false) {
              await dispatcher._recoverJobs();
              results.jobs = "recovered";
            }
            if (params.subscriptions !== false) {
              await dispatcher._recoverSubscriptions();
              results.subscriptions = "recovered";
            }
            results.managedAgents = Array.from(dispatcher.managedAgentIds);
            results.walletsLoaded = Array.from(dispatcher.agentWallets.keys());
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", results }, null, 2));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: err.message }, null, 2));
        }
      });
      return;
    }

    // Recent logs endpoint — returns in-memory log buffer
    if (req.url && req.url.startsWith("/debug/logs") && req.method === "GET") {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
      const level = url.searchParams.get("level") || null;
      const search = url.searchParams.get("q") || null;

      let logs = LOG_BUFFER.slice(-limit);
      if (level) logs = logs.filter(l => l.level === level);
      if (search) {
        const re = new RegExp(search, "i");
        logs = logs.filter(l => re.test(l.msg));
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        total: LOG_BUFFER.length,
        returned: logs.length,
        filter: { level, search, limit },
        logs,
      }, null, 2));
      return;
    }

    // Telegram webhook endpoint — only active when TELEGRAM_WEBHOOK_URL is set
    if (req.url === "/telegram-webhook" && req.method === "POST" && bot) {
      // Validate secret token (Telegram sends it as X-Telegram-Bot-Api-Secret-Token)
      if (webhookSecret) {
        const got = req.headers["x-telegram-bot-api-secret-token"];
        if (got !== webhookSecret) {
          res.writeHead(401).end("unauthorized");
          return;
        }
      }

      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const update = JSON.parse(body);
          bot.handleUpdate(update)
            .then(() => { res.writeHead(200).end("ok"); })
            .catch((err) => {
              console.error(`[Telegram] handleUpdate error: ${err.message}`);
              res.writeHead(500).end("error");
            });
        } catch {
          res.writeHead(400).end("bad request");
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "not found" }));
  });

  server.listen(port, () => {
    console.log(`[HealthCheck] Listening on port ${port}`);
    if (process.env.TELEGRAM_WEBHOOK_URL) {
      console.log(`[Telegram] Webhook endpoint: POST ${process.env.TELEGRAM_WEBHOOK_URL}/telegram-webhook`);
    }
  });

  return server;
}

main();
