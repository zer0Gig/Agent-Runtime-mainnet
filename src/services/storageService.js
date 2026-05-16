/**
 * 0G Storage Service — Decentralized File & KV Storage
 *
 * Uses 0G Storage SDK for uploading/downloading job data,
 * agent outputs, and capability manifests.
 */

import { Indexer, ZgFile, Batcher, KvClient, getFlowContract } from "@0gfoundation/0g-ts-sdk";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { keccak256, toUtf8Bytes, encodeBase64 } from "ethers";

/**
 * JSON replacer that converts BigInt values to strings.
 * Prevents "Do not know how to serialize a BigInt" errors when
 * uploading blockchain data (block numbers, balances, etc.) to 0G Storage.
 */
function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

// Defaults point to 0G Aristotle Mainnet (chain 16661). Override via env to
// run against Galileo testnet (chain 16602) or any other 0G network.
const INDEXER_RPC =
  process.env.OG_INDEXER_RPC ||
  "https://indexer-storage-turbo.0g.ai";
const EVM_RPC =
  process.env.OG_RPC_URL ||
  process.env.OG_NEWTON_RPC ||
  "https://evmrpc.0g.ai";

// 0G KV Node endpoint — provides cross-restart persistent KV layer (Option B).
// If unreachable, existing in-memory Map fallback continues to work.
const KV_NODE_RPC =
  process.env.OG_KV_NODE_RPC ||
  "http://3.101.147.150:6789";

// Flow contract address — required for KV writes via Batcher.
// If not set, will be resolved dynamically from indexer.selectNodes() status.
const FLOW_ADDRESS_OVERRIDE = process.env.OG_FLOW_ADDRESS || null;

// Supabase — used as a reliable fallback layer for KV pointers when the
// 0G KV Node hasn't synced yet or is unavailable. The agent_kv_index table
// stores (stream_id, key) → value mappings. Writes go to BOTH 0G KV Node
// AND Supabase; reads prefer 0G KV Node and fall back to Supabase.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export class StorageService {
  constructor(signer) {
    this.signer = signer;
    this.indexer = new Indexer(INDEXER_RPC);
    // Use OS temp dir so it works on Railway (ephemeral /app) and locally
    this.tmpDir = process.env.TMP_DIR || join(tmpdir(), "zer0gig");

    // In-memory KV index — fast local reads within process lifetime
    this._kvIndex = new Map();
    // Per-key locks for appendExecutionLog — prevents concurrent write race conditions
    this._appendLocks = new Map();

    // 0G KV Node — persistent layer that survives restarts (Option B).
    // Initialized lazily on first use. Falls back silently if unreachable.
    this._kvClient = null;    // KvClient for reads
    this._kvBatcher = null;   // Batcher for writes (needs StorageNode[] + FlowContract)
    this._kvInitPromise = null; // Deduplicate concurrent init attempts

    // Circuit breaker — three states (closed | open | half-open). Each open
    // doubles the cooldown window (5m → 10m → 20m), capped at 30m, so a
    // permanently down KV Node doesn't waste retries. After cooldown, the
    // next request is a probe; success closes the circuit, failure re-opens
    // with the next-step cooldown.
    this._kvNodeState           = "closed";  // "closed" | "open" | "half-open"
    this._kvNodeFailures        = 0;
    this._kvNodeDisabledUntil   = 0;          // Unix ms timestamp
    this._kvNodeCooldownMs      = 5 * 60 * 1000;
    this._kvNodeOpenCount       = 0;          // tracks consecutive open cycles
    this._kvNodeLastError       = null;
    this._kvNodeLastSuccessAt   = 0;
    this._KV_NODE_FAILURE_THRESHOLD  = 2;
    this._KV_NODE_BASE_COOLDOWN_MS   = 5 * 60 * 1000;
    this._KV_NODE_MAX_COOLDOWN_MS    = 30 * 60 * 1000;
    this._KV_NODE_CALL_TIMEOUT_MS    = 3000;
    this._KV_NODE_RETRY_DELAYS_MS    = [200, 800];  // 1 retry @200ms, 2nd @800ms

    if (!existsSync(this.tmpDir)) {
      mkdirSync(this.tmpDir, { recursive: true });
    }

    console.log("[Storage] Initialized with indexer:", INDEXER_RPC);
    console.log("[Storage] KV Node endpoint:", KV_NODE_RPC);
  }

  // ─── 0G KV NODE INTEGRATION (Option B — cross-restart persistence) ─────
  //
  // The existing in-memory _kvIndex Map provides fast session-local lookup,
  // but is lost on process restart. The 0G KV Node (Batcher + KvClient) is
  // the proper 0G-native KV layer that persists across restarts.
  //
  // Strategy: ADDITIVE layering — existing Map + log-layer fallback stays
  // untouched. KV Node is a secondary layer consulted only when the Map
  // misses. If KV Node is unreachable, graceful degrade to existing behavior.

  /**
   * Lazy-initialize the 0G KV Node client and batcher.
   * Safe to call repeatedly — only connects once per process.
   * Returns false if KV Node is unavailable; existing flows still work.
   */
  async _initKvNode() {
    if (this._kvClient && this._kvBatcher) return true;
    if (this._kvInitPromise) return this._kvInitPromise;

    this._kvInitPromise = (async () => {
      try {
        // Read client works with just the RPC endpoint
        this._kvClient = new KvClient(KV_NODE_RPC);

        // Write client (Batcher) needs storage nodes + flow contract
        const [nodes, nodeErr] = await this.indexer.selectNodes(1);
        if (nodeErr || !nodes || nodes.length === 0) {
          console.warn(`[KV Node] Could not select storage nodes: ${nodeErr || "empty list"}`);
          this._kvBatcher = null; // reads still work
          return true;
        }

        // Flow address: use env override or fetch from first node's networkIdentity
        let flowAddress = FLOW_ADDRESS_OVERRIDE;
        if (!flowAddress) {
          try {
            const status = await Promise.race([
              nodes[0].getStatus(),
              new Promise((_, rej) => setTimeout(() => rej(new Error("getStatus timeout")), 3000)),
            ]);
            flowAddress = status?.networkIdentity?.flowAddress;
          } catch (err) {
            console.warn(`[KV Node] getStatus failed: ${err.message}`);
          }
        }

        if (!flowAddress) {
          console.warn(`[KV Node] No flow address available — writes disabled, reads still work`);
          this._kvBatcher = null;
          return true;
        }

        const flow = getFlowContract(flowAddress, this.signer);
        this._kvBatcher = new Batcher(1, nodes, flow, EVM_RPC);
        console.log(`[KV Node] Write client initialized (flow=${flowAddress.slice(0, 10)}...)`);
        return true;
      } catch (err) {
        console.warn(`[KV Node] Initialization failed: ${err.message} — falling back to in-memory only`);
        this._kvClient = null;
        this._kvBatcher = null;
        return false;
      }
    })();

    return this._kvInitPromise;
  }

  /**
   * Convert a human-readable streamId string into the 32-byte hex format
   * required by the 0G KV Node. Deterministic — same string → same streamId.
   */
  _toStreamId(streamIdString) {
    return keccak256(toUtf8Bytes(streamIdString || "default"));
  }

  /**
   * Returns true when the caller should skip the KV Node entirely.
   * In "half-open" state we let a single probe through (returns false) but
   * subsequent concurrent calls still skip until the probe resolves.
   */
  _kvNodeCircuitOpen() {
    if (this._kvNodeState === "closed") return false;
    if (this._kvNodeState === "open") {
      if (Date.now() >= this._kvNodeDisabledUntil) {
        // Cooldown expired — promote to half-open so the NEXT call can probe
        this._kvNodeState = "half-open";
        console.log(`[KV Node] Circuit HALF-OPEN — next call will probe the KV Node`);
        return false;
      }
      return true;
    }
    // half-open — let one through; concurrent callers still skip
    return false;
  }

  /**
   * Record a KV Node failure. Threshold + escalating cooldown.
   */
  _kvNodeRecordFailure(reason) {
    this._kvNodeLastError = reason;
    this._kvNodeFailures += 1;

    // If we were probing (half-open) and failed, jump straight back to open
    const shouldOpen =
      this._kvNodeState === "half-open" ||
      (this._kvNodeState === "closed" && this._kvNodeFailures >= this._KV_NODE_FAILURE_THRESHOLD);

    if (shouldOpen) {
      this._kvNodeState = "open";
      this._kvNodeOpenCount += 1;
      // Exponential backoff capped: 5m → 10m → 20m → 30m (max)
      this._kvNodeCooldownMs = Math.min(
        this._KV_NODE_BASE_COOLDOWN_MS * Math.pow(2, this._kvNodeOpenCount - 1),
        this._KV_NODE_MAX_COOLDOWN_MS
      );
      this._kvNodeDisabledUntil = Date.now() + this._kvNodeCooldownMs;
      console.warn(
        `[KV Node] Circuit OPEN (cycle ${this._kvNodeOpenCount}, reason: ${reason}) — ` +
        `cooldown ${(this._kvNodeCooldownMs / 1000).toFixed(0)}s. ` +
        `Runtime continues with in-memory + Supabase fallback.`
      );
    }
  }

  /**
   * Record a KV Node success — close the circuit, reset counters.
   */
  _kvNodeRecordSuccess() {
    if (this._kvNodeState !== "closed") {
      console.log(`[KV Node] Circuit CLOSED — KV Node is healthy again`);
    }
    this._kvNodeState         = "closed";
    this._kvNodeFailures      = 0;
    this._kvNodeDisabledUntil = 0;
    this._kvNodeOpenCount     = 0;
    this._kvNodeCooldownMs    = this._KV_NODE_BASE_COOLDOWN_MS;
    this._kvNodeLastError     = null;
    this._kvNodeLastSuccessAt = Date.now();
  }

  /**
   * Public health snapshot — used by the runtime /health endpoint.
   */
  getKvHealth() {
    const now = Date.now();
    return {
      state:           this._kvNodeState,
      failures:        this._kvNodeFailures,
      openCount:       this._kvNodeOpenCount,
      cooldownMs:      this._kvNodeCooldownMs,
      reopensInMs:     this._kvNodeState === "open" ? Math.max(0, this._kvNodeDisabledUntil - now) : 0,
      lastError:       this._kvNodeLastError,
      lastSuccessAgoMs: this._kvNodeLastSuccessAt ? now - this._kvNodeLastSuccessAt : null,
    };
  }

  /**
   * Run an async fn against KV Node with bounded retries + exponential backoff.
   * Used by both kvNodeRead and kvNodeWrite to absorb transient blips before
   * counting against the circuit breaker.
   */
  async _withRetry(fn, label) {
    const attempts = this._KV_NODE_RETRY_DELAYS_MS.length + 1;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < this._KV_NODE_RETRY_DELAYS_MS.length) {
          const delay = this._KV_NODE_RETRY_DELAYS_MS[i];
          console.log(`[KV Node] ${label} attempt ${i + 1}/${attempts} failed (${err.message}) — retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Race a promise against a timeout. If the promise doesn't settle within
   * timeoutMs, rejects with a timeout error so the caller never blocks.
   */
  _withTimeout(promise, timeoutMs, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /**
   * Write a key-value pair to the 0G KV Node (persistent cross-restart).
   * Non-blocking for callers — wraps errors so failures don't break the flow.
   * Respects circuit breaker and applies aggressive timeout to prevent
   * blocking the Telegraf polling loop.
   * @param {string} streamIdString - Human-readable namespace
   * @param {string} keyString      - Human-readable key
   * @param {string} valueString    - String value to store
   * @returns {Promise<boolean>} true if persisted, false on any failure
   */
  async _kvNodeWrite(streamIdString, keyString, valueString) {
    if (this._kvNodeCircuitOpen()) return false;

    try {
      await this._withTimeout(this._initKvNode(), this._KV_NODE_CALL_TIMEOUT_MS, "KV init");
      if (!this._kvBatcher) return false;

      const streamId   = this._toStreamId(streamIdString);
      const keyBytes   = new Uint8Array(Buffer.from(keyString, "utf-8"));
      const valueBytes = new Uint8Array(Buffer.from(valueString, "utf-8"));

      const tx = await this._withRetry(async () => {
        this._kvBatcher.streamDataBuilder.set(streamId, keyBytes, valueBytes);
        const [resTx, err] = await this._withTimeout(
          this._kvBatcher.exec(),
          this._KV_NODE_CALL_TIMEOUT_MS,
          `KV write ${keyString}`
        );
        if (err) throw new Error(err.message || String(err));
        return resTx;
      }, `write ${streamIdString}/${keyString}`);

      this._kvNodeRecordSuccess();
      console.log(`[KV Node] Wrote ${streamIdString}/${keyString} (tx=${tx?.txHash?.slice(0, 10) || "?"}...)`);
      return true;
    } catch (err) {
      console.warn(`[KV Node] Write failed for ${streamIdString}/${keyString} after retries: ${err.message}`);
      this._kvNodeRecordFailure(err.message);
      return false;
    }
  }

  /**
   * Read a value from the 0G KV Node by streamId + key.
   * Returns null on any failure (caller should fall back to existing behavior).
   * Respects circuit breaker and applies aggressive timeout to prevent
   * blocking the Telegraf polling loop.
   * @param {string} streamIdString - Human-readable namespace
   * @param {string} keyString      - Human-readable key
   * @returns {Promise<string|null>} The stored string value, or null
   */
  async _kvNodeRead(streamIdString, keyString) {
    if (this._kvNodeCircuitOpen()) return null;

    try {
      await this._withTimeout(this._initKvNode(), this._KV_NODE_CALL_TIMEOUT_MS, "KV init");
      if (!this._kvClient) return null;

      const streamId = this._toStreamId(streamIdString);
      const keyBytes = new Uint8Array(Buffer.from(keyString, "utf-8"));
      // KV Node RPC requires the key as a base64-encoded string
      // (Uint8Array serializes to {0:..,1:..} which the server rejects).
      const keyB64 = encodeBase64(keyBytes);

      const value = await this._withRetry(
        () => this._withTimeout(
          this._kvClient.getValue(streamId, keyB64),
          this._KV_NODE_CALL_TIMEOUT_MS,
          `KV read ${keyString}`
        ),
        `read ${streamIdString}/${keyString}`
      );

      if (!value || !value.data) {
        this._kvNodeRecordSuccess(); // reached the node, just no data
        return null;
      }

      const bytes = typeof value.data === "string"
        ? Buffer.from(value.data.replace(/^0x/, ""), "hex")
        : Buffer.from(value.data);
      this._kvNodeRecordSuccess();
      return bytes.toString("utf-8");
    } catch (err) {
      console.warn(`[KV Node] Read failed for ${streamIdString}/${keyString} after retries: ${err.message}`);
      this._kvNodeRecordFailure(err.message);
      return null;
    }
  }

  // ─── SUPABASE FALLBACK LAYER ────────────────────────────────────────────
  //
  // Secondary persistence layer for KV pointers. The primary layer remains
  // 0G KV Node — this only kicks in when 0G KV Node returns null (miss or
  // not synced yet). Writes go to BOTH layers independently; reads prefer
  // 0G KV Node and fall back here.
  //
  // Stores only small key→value pointers. Actual memory content lives on
  // 0G Storage (immutable log layer via uploadData).

  /**
   * Write a key-value pair to the Supabase fallback table.
   * Uses service role key to bypass RLS. Fire-and-forget; errors never
   * propagate to the caller.
   */
  async _kvSupabaseWrite(streamIdString, keyString, valueString) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/agent_kv_index`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          stream_id: streamIdString,
          key: keyString,
          value: valueString,
          updated_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[KV Supabase] Write ${streamIdString}/${keyString} failed: HTTP ${res.status} ${body.slice(0, 100)}`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[KV Supabase] Write exception for ${streamIdString}/${keyString}: ${err.message}`);
      return false;
    }
  }

  /**
   * Read a value from the Supabase fallback table.
   * Returns null on miss or any error (caller already has other fallbacks).
   */
  async _kvSupabaseRead(streamIdString, keyString) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
    try {
      const url = `${SUPABASE_URL}/rest/v1/agent_kv_index?stream_id=eq.${encodeURIComponent(streamIdString)}&key=eq.${encodeURIComponent(keyString)}&select=value`;
      const res = await fetch(url, {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      if (!rows?.length) return null;
      return rows[0].value ?? null;
    } catch (err) {
      console.warn(`[KV Supabase] Read exception for ${streamIdString}/${keyString}: ${err.message}`);
      return null;
    }
  }

  /**
   * Upload a string/JSON to 0G Storage, returns the root hash (CID)
   */
  async uploadData(data, filename = "output.json") {
    const filePath = join(this.tmpDir, filename);

    // Write data to temp file
    const content = typeof data === "string" ? data : JSON.stringify(data, bigintReplacer, 2);
    writeFileSync(filePath, content, "utf-8");

    console.log(`[Storage] Uploading ${filename} (${content.length} bytes)...`);

    // Create ZgFile and upload
    const file = await ZgFile.fromFilePath(filePath);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr) {
      await file.close();
      throw new Error(`Merkle tree error: ${treeErr}`);
    }

    const rootHash = tree.rootHash();
    console.log(`[Storage] Root hash: ${rootHash}`);

    const [tx, uploadErr] = await this.indexer.upload(
      file,
      EVM_RPC,
      this.signer
    );
    await file.close();

    if (uploadErr) {
      throw new Error(`Upload error: ${uploadErr}`);
    }

    console.log(`[Storage] Upload successful! TX: ${tx}`);
    return rootHash;
  }

  /**
   * Download data from 0G Storage by root hash
   */
  async downloadData(rootHash, filename = "download.json") {
    // Inline-encoded brief (txt:base64) — decode directly, no network call needed
    if (rootHash && rootHash.startsWith("txt:")) {
      console.log(`[Storage] Decoding inline txt brief...`);
      const text = Buffer.from(rootHash.slice(4), "base64").toString("utf-8");
      try {
        return JSON.parse(text);
      } catch {
        return { task: text };
      }
    }

    const outputPath = join(this.tmpDir, filename);

    // 0G SDK requires output path to NOT exist — delete stale file if present
    if (existsSync(outputPath)) {
      try { unlinkSync(outputPath); } catch { /* ignore */ }
    }

    console.log(`[Storage] Downloading ${rootHash}...`);

    const err = await this.indexer.download(rootHash, outputPath, true);
    if (err) {
      throw new Error(`Download error: ${err}`);
    }

    const content = readFileSync(outputPath, "utf-8");
    console.log(`[Storage] Downloaded ${content.length} bytes.`);

    // Try parsing as JSON, fallback to raw string
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  /**
   * Upload agent capability manifest to 0G Storage
   */
  async uploadCapabilityManifest(agentId, manifest) {
    return this.uploadData(manifest, `agent-${agentId}-capabilities.json`);
  }

  /**
   * Upload agent profile to 0G Storage
   */
  async uploadProfile(agentId, profile) {
    return this.uploadData(profile, `agent-${agentId}-profile.json`);
  }

  /**
   * Upload milestone output to 0G Storage
   */
  async uploadMilestoneOutput(jobId, milestoneIndex, output) {
    return this.uploadData(
      output,
      `job-${jobId}-milestone-${milestoneIndex}-output.json`
    );
  }

  /**
   * Upload a binary file (MP3, MP4, PDF, etc.) to 0G Storage.
   * @param {Buffer} buffer - Raw file bytes
   * @param {string} filename - e.g. "output.mp4"
   * @returns {Promise<string>} root hash (CID)
   */
  async uploadBinaryFile(buffer, filename) {
    const filePath = join(this.tmpDir, filename);
    writeFileSync(filePath, buffer);
    console.log(`[Storage] Uploading binary file ${filename} (${buffer.length} bytes)...`);

    const file = await ZgFile.fromFilePath(filePath);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr) {
      await file.close();
      throw new Error(`Merkle tree error: ${treeErr}`);
    }

    const rootHash = tree.rootHash();
    const [, uploadErr] = await this.indexer.upload(file, EVM_RPC, this.signer);
    await file.close();
    if (uploadErr) throw new Error(`Upload error: ${uploadErr}`);

    console.log(`[Storage] Binary file uploaded. CID: ${rootHash}`);
    return rootHash;
  }

  /**
   * Bundle all activity log entries for a job and upload to 0G Storage.
   * Call this at job completion to commit the full execution trace on-chain.
   * @param {string} jobId
   * @param {Array}  activities - Array of activity log rows from Supabase
   * @returns {Promise<string>} root hash (CID)
   */
  async uploadActivityBundle(jobId, activities) {
    return this.uploadData(
      { jobId, bundledAt: new Date().toISOString(), count: activities.length, activities },
      `job-${jobId}-activity-bundle.json`
    );
  }

  // ─── CHECKPOINT METHODS (for scheduler persistence) ─────────────────────

  /**
   * Save checkpoint state for a subscription/scheduled job
   * Key pattern: checkpoint:{subscriptionId}
   * Stores the root hash in KV index for retrieval
   * @param {string} subscriptionId - The subscription/job identifier
   * @param {object} state - Checkpoint state (lastCheckedBlock, lastAlertTimestamp, context, etc.)
   * @returns {Promise<string>} CID of the uploaded checkpoint
   */
  async saveCheckpoint(subscriptionId, state) {
    const checkpoint = {
      ...state,
      subscriptionId,
      savedAt: Math.floor(Date.now() / 1000),
      version: "1.0",
    };
    const rootHash = await this.uploadData(checkpoint, `checkpoint-${subscriptionId}.json`);
    // CRIT-2 FIX: Store the real root hash in KV index
    await this.setKey(`checkpoint:${subscriptionId}`, rootHash);
    return rootHash;
  }

  /**
   * Read checkpoint state for a subscription/scheduled job
   * @param {string} subscriptionId - The subscription/job identifier
   * @returns {Promise<object|null>} Checkpoint state or null if not found
   */
  async readCheckpoint(subscriptionId) {
    try {
      // CRIT-2 FIX: Get the real root hash from KV index
      const rootHash = await this._getCheckpointRootHash(subscriptionId);
      if (!rootHash) {
        console.log(`[Storage] No checkpoint hash stored for ${subscriptionId}, starting fresh.`);
        return null;
      }
      const data = await this.downloadData(rootHash, `checkpoint-${subscriptionId}.json`);
      return data;
    } catch (err) {
      // First run — no checkpoint exists yet
      if (err.message?.includes("not found") || err.message?.includes("404")) {
        console.log(`[Storage] No checkpoint found for ${subscriptionId}, starting fresh.`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Check if a checkpoint exists for a subscription
   * @param {string} subscriptionId - The subscription/job identifier
   * @returns {Promise<boolean>}
   */
  async hasCheckpoint(subscriptionId) {
    const checkpoint = await this.readCheckpoint(subscriptionId);
    return checkpoint !== null;
  }

  /**
   * Get the storage root hash for a checkpoint
   * Retrieves from KV index where it was stored by saveCheckpoint
   * @param {string} subscriptionId - The subscription identifier
   * @returns {Promise<string|null>} Root hash or null if not found
   */
  async _getCheckpointRootHash(subscriptionId) {
    // CRIT-2 FIX: Retrieve the real root hash from KV index
    return this.getKey(`checkpoint:${subscriptionId}`);
  }

  // ─── TASK #4 SPEC FUNCTIONS ────────────────────────────────────────────
  // Simplified wrappers for job output storage (as per Task #4 specification)

  /**
   * Upload job output data to 0G Storage
   * Stores CID in KV index for retrieval by downloadOutput
   * @param {string} jobId - The job identifier
   * @param {any} data - JSON-serializable data to upload
   * @returns {Promise<string>} Storage CID
   */
  async uploadOutput(jobId, data) {
    console.log(`[Storage] Uploading output for job ${jobId}...`);
    const rootHash = await this.uploadData(data, `output-${jobId}.json`);
    // MED-2 FIX: Store the CID in KV index for retrieval
    await this.setKey(`output:${jobId}`, rootHash);
    return rootHash;
  }

  /**
   * Download job output data from 0G Storage
   * @param {string} jobId - The job identifier
   * @returns {Promise<object|null>} Parsed data or null if not found
   */
  async downloadOutput(jobId) {
    console.log(`[Storage] Downloading output for job ${jobId}...`);
    try {
      // In production, we'd query a KV index to get the CID by jobId
      // For now, use a deterministic pattern
      const cid = await this._getOutputCID(jobId);
      if (!cid) return null;
      return await this.downloadData(cid, `output-${jobId}.json`);
    } catch (err) {
      if (err.message?.includes("not found") || err.message?.includes("404")) {
        console.log(`[Storage] No output found for job ${jobId}`);
        return null;
      }
      throw err;
    }
  }

  // ─── INDEX / KV HELPERS ────────────────────────────────────────────────

  /**
   * Store a key-value mapping for quick lookups
   * Uses in-memory Map for fast retrieval (demo mode)
   * Also uploads to 0G Storage for persistence (best effort)
   * @param {string} key - Human-readable key (e.g., "agent:7:resume")
   * @param {string} cid - The 0G Storage CID
   * @returns {Promise<string>} CID of the index entry
   */
  async setKey(key, cid) {
    // NEW-2 FIX: Store in memory for immediate retrieval
    this._kvIndex.set(key, cid);

    // Also upload to 0G Storage for persistence (best effort)
    const indexEntry = {
      key,
      cid,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const rootHash = await this.uploadData(indexEntry, `kv-${key.replace(/:/g, "-")}.json`);

    // Option B: persist pointer to 0G KV Node for cross-restart recovery.
    // Non-blocking and non-throwing — existing Map + log-layer flow above
    // continues to work even if KV Node write fails.
    this._kvNodeWrite("zer0gig:kv", key, cid).catch(() => {});

    // Supabase fallback layer (Option B hybrid): mirror the pointer to
    // agent_kv_index so cross-restart reads still resolve when 0G KV Node
    // hasn't synced yet. Fire-and-forget; independent of KV Node success.
    this._kvSupabaseWrite("zer0gig:kv", key, cid).catch(() => {});

    return rootHash;
  }

  /**
   * Get CID by key from KV index
   * Uses in-memory Map for fast retrieval (demo mode)
   * @param {string} key - Human-readable key
   * @returns {Promise<string|null>} CID or null if not found
   */
  async getKey(key) {
    // NEW-2 FIX: Retrieve from in-memory Map (works within process lifetime)
    const cid = this._kvIndex.get(key);
    if (cid) {
      return cid;
    }

    // Option B fallback: look up pointer from 0G KV Node (cross-restart recovery).
    // If KV Node returns a value, hydrate the in-memory Map so subsequent
    // lookups are fast. If KV Node is unreachable, returns null (existing behavior).
    const kvNodeCid = await this._kvNodeRead("zer0gig:kv", key);
    if (kvNodeCid) {
      this._kvIndex.set(key, kvNodeCid);
      console.log(`[KV Node] Hydrated key=${key} from 0G KV Node`);
      return kvNodeCid;
    }

    // Supabase fallback: query agent_kv_index when KV Node misses.
    // This guarantees cross-restart recovery even while KV Node is still
    // syncing the chain or is unavailable. Hydrate Map on hit.
    const supaCid = await this._kvSupabaseRead("zer0gig:kv", key);
    if (supaCid) {
      this._kvIndex.set(key, supaCid);
      console.log(`[KV Supabase] Hydrated key=${key} from Supabase fallback`);
      return supaCid;
    }

    // Fallback: try to load from 0G Storage (not implemented for demo)
    // In production, this would query an on-chain KV index
    return null;
  }

  /**
   * Get the storage CID for a job output
   * In production, this queries a KV index or on-chain registry
   * For hackathon demo, uses deterministic pattern
   * @param {string} jobId - The job identifier
   * @returns {Promise<string|null>} CID or null if not found
   */
  async _getOutputCID(jobId) {
    // Try to fetch from KV index first
    const key = `output:${jobId}`;
    const cid = await this.getKey(key);
    if (cid) return cid;

    // Fallback: return deterministic pattern (for demo/testing)
    // In production, this would be stored on-chain or in a proper KV index
    return null;
  }

  /**
   * List all uploads for an agent (from local index)
   * This is a helper for dashboard display
   */
  async listAgentUploads(agentId) {
    // In production, this would query an on-chain index or KV store
    // For now, return the expected file patterns
    return {
      resume: `agent-${agentId}-profile.json`,
      capabilities: `agent-${agentId}-capabilities.json`,
      outputs: `agent-${agentId}-outputs.json`,
    };
  }

  // ─── PHASE 1: 0G KV LAYER ──────────────────────────────────────────────

  /**
   * Store a key-value pair in 0G KV layer via Batcher.
   * Also mirrors to in-memory KV for fast local retrieval.
   *
   * @param {string} streamId - The KV stream namespace (e.g., "agent:7:memories")
   * @param {string} key      - Human-readable key
   * @param {any}    value    - JSON-serializable value
   * @returns {Promise<string>} CID of the index entry
   */
  async kvSet(streamId, key, value) {
    // Mirror to in-memory for fast local reads
    const memKey = `kv:${streamId}:${key}`;
    this._kvIndex.set(memKey, value);

    // Upload a structured KV entry to 0G immutable log
    const entry = {
      streamId,
      key,
      value,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const rootHash = await this.uploadData(entry, `kv-${streamId.replace(/:/g, "-")}-${key.replace(/:/g, "-")}.json`);

    // Update the index for this stream
    const index = await this.kvListIndex(streamId);
    index[key] = rootHash;
    const indexRootHash = await this.uploadData(index, `kv-index-${streamId.replace(/:/g, "-")}.json`);

    // Store the index's own root hash so kvListIndex can find it after restart
    this._kvIndex.set(`kv_index_root:${streamId}`, indexRootHash);

    // Option B: persist the full KV entry to 0G KV Node for cross-restart recovery.
    // We store the entry JSON directly (not just a CID pointer) so kvGet can
    // retrieve the value without needing to download from the log layer.
    // Non-blocking — existing flow above is unchanged.
    try {
      const serialized = JSON.stringify(entry);
      this._kvNodeWrite(streamId, key, serialized).catch(() => {});
      // Also persist the index root hash so kvListIndex can recover on restart
      this._kvNodeWrite(`${streamId}:__index__`, "root", indexRootHash).catch(() => {});

      // Supabase fallback: mirror full entry + index root hash.
      // Reliable cross-restart recovery when 0G KV Node isn't synced yet.
      this._kvSupabaseWrite(streamId, key, serialized).catch(() => {});
      this._kvSupabaseWrite(`${streamId}:__index__`, "root", indexRootHash).catch(() => {});
    } catch { /* never let KV Node errors break kvSet */ }

    return rootHash;
  }

  /**
   * Retrieve a value from 0G KV layer.
   * Checks in-memory cache first, then downloads from 0G.
   *
   * @param {string} streamId - The KV stream namespace
   * @param {string} key      - Human-readable key
   * @returns {Promise<any>} Stored value or null
   */
  async kvGet(streamId, key) {
    // Check in-memory cache first
    const memKey = `kv:${streamId}:${key}`;
    const cached = this._kvIndex.get(memKey);
    if (cached !== undefined) return cached;

    // Option B: try 0G KV Node first (persistent across restarts).
    // If found, rehydrate the in-memory cache and return quickly.
    const kvNodeRaw = await this._kvNodeRead(streamId, key);
    if (kvNodeRaw) {
      try {
        const parsed = JSON.parse(kvNodeRaw);
        const value = parsed?.value ?? parsed;
        this._kvIndex.set(memKey, value);
        console.log(`[KV Node] kvGet hydrated ${streamId}/${key} from 0G KV Node`);
        return value;
      } catch {
        // Fall through to Supabase fallback → existing log-layer path
      }
    }

    // Supabase fallback: reliable cross-restart recovery when 0G KV Node
    // hasn't synced yet. Stores the same serialized entry format as above.
    const supaRaw = await this._kvSupabaseRead(streamId, key);
    if (supaRaw) {
      try {
        const parsed = JSON.parse(supaRaw);
        const value = parsed?.value ?? parsed;
        this._kvIndex.set(memKey, value);
        console.log(`[KV Supabase] kvGet hydrated ${streamId}/${key} from Supabase fallback`);
        return value;
      } catch {
        // Fall through to existing log-layer path
      }
    }

    // Try to get from 0G via index
    try {
      const index = await this.kvListIndex(streamId);
      const rootHash = index[key];
      if (!rootHash) return null;

      const data = await this.downloadData(rootHash, `kv-${streamId.replace(/:/g, "-")}-${key.replace(/:/g, "-")}.json`);
      const value = data?.value ?? data; // handle both wrapped and raw formats

      // Cache for next time
      if (value !== null) this._kvIndex.set(memKey, value);

      return value;
    } catch (err) {
      console.warn(`[Storage] kvGet failed for ${streamId}:${key}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get the KV index for a stream from 0G Storage.
   */
  async kvListIndex(streamId) {
    try {
      // Use the stored root hash — NOT the filename (filename isn't a valid 0G hash)
      let indexRootHash = this._kvIndex.get(`kv_index_root:${streamId}`);

      // Option B: if not in memory, try 0G KV Node (cross-restart recovery)
      if (!indexRootHash) {
        indexRootHash = await this._kvNodeRead(`${streamId}:__index__`, "root");
        if (indexRootHash) {
          // Rehydrate the in-memory cache so subsequent reads are fast
          this._kvIndex.set(`kv_index_root:${streamId}`, indexRootHash);
          console.log(`[KV Node] Index hydrated for stream ${streamId}`);
        }
      }

      // Supabase fallback for the index root hash itself
      if (!indexRootHash) {
        indexRootHash = await this._kvSupabaseRead(`${streamId}:__index__`, "root");
        if (indexRootHash) {
          this._kvIndex.set(`kv_index_root:${streamId}`, indexRootHash);
          console.log(`[KV Supabase] Index hydrated for stream ${streamId} from fallback`);
        }
      }

      if (!indexRootHash) return {}; // No index uploaded yet

      const data = await this.downloadData(indexRootHash, `kv-index-${streamId.replace(/:/g, "-")}.json`);
      return data || {};
    } catch {
      return {};
    }
  }

  // ─── PHASE 2: SUBSCRIPTION EXECUTION LOGS ──────────────────────────────

  /**
   * Append an execution log entry to 0G immutable log layer.
   * Each entry is stored independently with a Merkle root hash for verification.
   *
   * @param {string} subscriptionId - The subscription/job identifier
   * @param {object} logEntry       - Log data (phase, input, output, tools, etc.)
   * @returns {Promise<string>} Root hash (CID) of the uploaded log entry
   */
  async appendExecutionLog(subscriptionId, logEntry) {
    // Serialize index updates per subscriptionId — prevents concurrent write race conditions
    // that cause "data hash mismatch" errors on 0G Storage
    const lockKey = `log-lock:${subscriptionId}`;
    const prev = this._appendLocks.get(lockKey) || Promise.resolve();

    const next = prev.then(async () => {
      const entry = {
        ...logEntry,
        subscriptionId,
        loggedAt: Math.floor(Date.now() / 1000),
        version: "1.0",
      };

      const filename = `sub-${subscriptionId}-log-${entry.loggedAt}-${Math.random().toString(36).slice(2, 8)}.json`;
      const rootHash = await this.uploadData(entry, filename);

      // Read → modify → write index exclusively (no other appends for this sub can run here)
      const index = await this.listExecutionLogs(subscriptionId);
      index.push({ rootHash, timestamp: entry.loggedAt, phase: entry.phase });
      const indexRootHash = await this.uploadData(index, `sub-${subscriptionId}-log-index.json`);
      // Cache the index root hash so listExecutionLogs can find it
      this._kvIndex.set(`log-index-root:${subscriptionId}`, indexRootHash);

      console.log(`[Storage] Execution log appended: sub=${subscriptionId} rootHash=${rootHash.slice(0, 12)}…`);
      return rootHash;
    });

    this._appendLocks.set(lockKey, next.catch(() => {})); // keep lock chain even on error
    return next;
  }

  /**
   * List all execution logs for a subscription.
   * Returns array of { rootHash, timestamp, phase } sorted by timestamp.
   *
   * @param {string} subscriptionId - The subscription/job identifier
   * @returns {Promise<Array>} Array of log metadata
   */
  async listExecutionLogs(subscriptionId) {
    try {
      // Use the cached index root hash — NOT the filename as a hash
      const indexRootHash = this._kvIndex.get(`log-index-root:${subscriptionId}`);
      if (!indexRootHash) return [];

      const data = await this.downloadData(indexRootHash, `sub-${subscriptionId}-log-index.json`);
      if (Array.isArray(data)) {
        return data.sort((a, b) => a.timestamp - b.timestamp);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Get the latest execution result for a subscription.
   * Downloads the full log entry from 0G Storage.
   *
   * @param {string} subscriptionId - The subscription/job identifier
   * @returns {Promise<object|null>} Full log entry or null
   */
  async getLatestExecution(subscriptionId) {
    const logs = await this.listExecutionLogs(subscriptionId);
    if (logs.length === 0) return null;

    const latest = logs[logs.length - 1];
    try {
      return await this.downloadData(latest.rootHash, `latest-sub-${subscriptionId}.json`);
    } catch (err) {
      console.warn(`[Storage] getLatestExecution failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Get the full execution history for a subscription.
   * Downloads all log entries from 0G Storage.
   *
   * @param {string} subscriptionId - The subscription/job identifier
   * @param {number} limit          - Max entries to return (default: 20)
   * @returns {Promise<Array>} Array of full log entries
   */
  async getExecutionHistory(subscriptionId, limit = 20) {
    const logs = await this.listExecutionLogs(subscriptionId);
    const recent = logs.slice(-limit);
    const results = [];

    for (const log of recent) {
      try {
        const entry = await this.downloadData(log.rootHash, `hist-sub-${subscriptionId}-${log.timestamp}.json`);
        results.push(entry);
      } catch {
        results.push({ rootHash: log.rootHash, phase: log.phase, timestamp: log.timestamp, error: "Download failed" });
      }
    }

    return results;
  }

  // ─── PHASE 3: ESCROW EVENT HISTORY ─────────────────────────────────────

  /**
   * Append an escrow event to 0G immutable log layer.
   * Events from ProgressiveEscrow and SubscriptionEscrow are stored separately.
   *
   * @param {string} contractType - "ProgressiveEscrow" or "SubscriptionEscrow"
   * @param {string} eventType    - e.g., "MilestoneReleased", "SubscriptionCreated"
   * @param {object} data         - Event-specific data (jobId, amount, txHash, etc.)
   * @returns {Promise<string>} Root hash (CID) of the uploaded event
   */
  async appendEscrowEvent(contractType, eventType, data) {
    const entry = {
      contractType,
      eventType,
      ...data,
      loggedAt: Math.floor(Date.now() / 1000),
      version: "1.0",
    };

    const filename = `event-${contractType}-${eventType}-${entry.loggedAt}-${Math.random().toString(36).slice(2, 6)}.json`;
    const rootHash = await this.uploadData(entry, filename);

    // Update event index
    const index = await this.listEscrowEvents(contractType);
    index.push({
      rootHash,
      eventType,
      timestamp: entry.loggedAt,
    });
    await this.uploadData(index, `event-index-${contractType}.json`);

    console.log(`[Storage] Escrow event logged: ${contractType}.${eventType} rootHash=${rootHash.slice(0, 12)}…`);
    return rootHash;
  }

  /**
   * List all escrow events for a contract type.
   *
   * @param {string} contractType - "ProgressiveEscrow" or "SubscriptionEscrow"
   * @returns {Promise<Array>} Array of { rootHash, eventType, timestamp }
   */
  async listEscrowEvents(contractType) {
    try {
      const data = await this.downloadData(`event-index-${contractType}.json`);
      if (Array.isArray(data)) {
        return data.sort((a, b) => a.timestamp - b.timestamp);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Get events filtered by job or subscription ID.
   *
   * @param {string} contractType - "ProgressiveEscrow" or "SubscriptionEscrow"
   * @param {string} targetId     - Job ID or Subscription ID to filter by
   * @returns {Promise<Array>} Array of full event entries
   */
  async getEventsForJob(contractType, targetId) {
    const events = await this.listEscrowEvents(contractType);
    const results = [];
    const targetStr = targetId.toString();

    for (const event of events) {
      try {
        const data = await this.downloadData(event.rootHash, `event-${contractType}-${event.timestamp}.json`);
        // Match by any of these fields
        if (
          data.jobId === targetStr ||
          data.subscriptionId === targetStr ||
          String(data.jobId) === targetStr ||
          String(data.subscriptionId) === targetStr
        ) {
          results.push(data);
        }
      } catch {
        // Skip corrupted entries
      }
    }

    return results;
  }

  /**
   * Get the latest N events of a specific type.
   *
   * @param {string} contractType - "ProgressiveEscrow" or "SubscriptionEscrow"
   * @param {string} eventType    - e.g., "MilestoneReleased"
   * @param {number} limit        - Max events to return
   * @returns {Promise<Array>} Array of full event entries
   */
  async getLatestEvents(contractType, eventType, limit = 10) {
    const events = await this.listEscrowEvents(contractType);
    const matching = events.filter(e => e.eventType === eventType).slice(-limit);
    const results = [];

    for (const event of matching) {
      try {
        const data = await this.downloadData(event.rootHash, `event-${eventType}-${event.timestamp}.json`);
        results.push(data);
      } catch {
        // Skip corrupted entries
      }
    }

    return results;
  }
}
