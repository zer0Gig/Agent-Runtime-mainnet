import cron from "node-cron";

class AgentScheduler {
  constructor({ storageService, alertDelivery } = {}) {
    this.jobs = new Map(); // jobId → { cronJob, lastRun, config }
    this.storage = storageService; // Store storage service instance
    this.alertDelivery = alertDelivery;
    this._listeners = new Map();
    this.runningJobs = new Set(); // Track concurrently executing jobs (prevent overlapping ticks)
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
  }

  emit(event, ...args) {
    const fns = this._listeners.get(event) || [];
    fns.forEach((fn) => fn(...args));
  }

  /**
   * Register a new recurring job
   * @param {string} jobId - Unique job identifier
   * @param {string} intervalCron - Cron expression (e.g., '0 * * * *' = hourly)
   * @param {Function} taskFn - Async function to execute on each tick
   * @param {object} config - Job config (subscriptionId, agentId, etc.)
   */
  async scheduleJob(jobId, intervalCron, taskFn, config = {}) {
    // Stop existing cron for this jobId to prevent duplicate schedules
    const existing = this.jobs.get(jobId);
    if (existing) {
      existing.cronJob.stop();
      console.log(`[Scheduler] Stopped existing cron for ${jobId} before re-schedule`);
    }

    // Create cron job
    const cronJob = cron.schedule(intervalCron, async () => {
      // Skip if this job is already running (prevent overlapping ticks)
      if (this.runningJobs.has(jobId)) {
        console.log(`[Scheduler] Job ${jobId} still running — skipping overlapping tick`);
        return;
      }

      this.runningJobs.add(jobId);
      console.log(`[Scheduler] Executing job ${jobId}...`);
      
      try {
        // Read checkpoint FRESH each tick; default {} to prevent null-spread crash
        const checkpoint = await this.storage?.readCheckpoint(jobId) || {};
        
        // Execute task with fresh checkpoint
        const result = await taskFn(checkpoint);
        
        // Save new checkpoint with updated state
        await this.storage?.saveCheckpoint(jobId, {
          ...checkpoint,
          lastRun: Date.now(),
          lastResult: result,
        });
        
        // Check for anomaly → trigger alert
        if (this._detectAnomaly(result, config)) {
          await this._triggerAlert(jobId, result, config);
        }
        
      } catch (error) {
        console.error(`[Scheduler] Job ${jobId} failed:`, error);
        // Read current checkpoint to preserve existing state; default {} not null
        const checkpoint = await this.storage?.readCheckpoint(jobId) || {};
        // Save error state
        await this.storage?.saveCheckpoint(jobId, {
          ...checkpoint,
          lastError: error.message,
          errorTimestamp: Date.now(),
        });
      } finally {
        this.runningJobs.delete(jobId);
      }
    }, {
      scheduled: true,
      timezone: 'UTC',
    });

    // Store job reference
    this.jobs.set(jobId, {
      cronJob,
      config,
      createdAt: Date.now(),
    });

    console.log(`[Scheduler] Job ${jobId} scheduled with cron "${intervalCron}"`);
  }

  /**
   * Stop and remove a job
   */
  async cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job) {
      job.cronJob.stop();
      this.jobs.delete(jobId);
      console.log(`[Scheduler] Job ${jobId} cancelled`);
    }
  }

  /**
   * Get job status
   * Note: node-cron doesn't expose a getStatus() method, so we track running state manually
   */
  getJobStatus(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    
    return {
      jobId,
      running: true, // Cron task is active (node-cron doesn't expose status API)
      config: job.config,
      createdAt: job.createdAt,
    };
  }

  /**
   * Get all active jobs
   */
  getAllJobs() {
    return Array.from(this.jobs.entries()).map(([jobId, job]) => ({
      jobId,
      ...this.getJobStatus(jobId),
    }));
  }

  /**
   * Persist scheduler state to 0G Storage.
   *
   * Skips upload when:
   *   1. No jobs in the scheduler (empty state = wasted gas on mainnet)
   *   2. Schedule hash matches the last successfully persisted hash (no change)
   *
   * Each Flow.submit() call costs ~0.001-0.002 OG in gas on mainnet, so
   * persisting empty/unchanged state every 5 min would drain the operator
   * wallet by ~1 OG per day for nothing.
   */
  async persistSchedule() {
    if (!this.storage) return;

    try {
      const schedule = [];
      for (const [jobId, entry] of this.jobs.entries()) {
        schedule.push({
          jobId,
          config: entry.config,
          createdAt: entry.createdAt,
        });
      }

      // Skip empty state — nothing to persist, just burns gas on the Flow contract
      if (schedule.length === 0) return;

      // Skip unchanged state — compare against last persisted snapshot hash
      const snapshotHash = JSON.stringify(schedule);
      if (snapshotHash === this._lastSnapshotHash) return;

      const rootHash = await this.storage.uploadData(
        schedule,
        `scheduler-state-${Date.now()}.json`
      );

      await this.storage.setKey("scheduler:latest", rootHash);
      this._lastSnapshotHash = snapshotHash;
      console.log(`[Scheduler] Schedule persisted to 0G: ${rootHash?.slice(0, 12)}... (${schedule.length} job(s))`);
    } catch (err) {
      console.warn(`[Scheduler] Failed to persist schedule: ${err.message}`);
    }
  }

  /**
   * Load scheduler state from 0G Storage
   */
  async loadSchedule() {
    if (!this.storage) return;

    try {
      const rootHash = await this.storage.getKey("scheduler:latest");
      if (!rootHash) return;

      const schedule = await this.storage.downloadData(rootHash);
      if (!Array.isArray(schedule)) return;

      let restored = 0;
      for (const entry of schedule) {
        if (entry.jobId && entry.config) {
          this.emit("restore", entry);
          restored++;
        }
      }

      console.log(`[Scheduler] Schedule restored from 0G: ${restored} job(s)`);
    } catch (err) {
      console.warn(`[Scheduler] Failed to restore schedule: ${err.message}`);
    }
  }

  /**
   * Auto-persist scheduler state every N milliseconds
   */
  startAutoPersist(intervalMs = 5 * 60 * 1000) {
    this._persistInterval = setInterval(() => this.persistSchedule(), intervalMs);
    console.log(`[Scheduler] Auto-persist enabled (every ${intervalMs / 1000 / 60} min)`);
  }

  stopAutoPersist() {
    if (this._persistInterval) {
      clearInterval(this._persistInterval);
      this._persistInterval = null;
    }
  }

  /**
   * Pause a job (stop cron but keep in Map)
   */
  async pauseJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job && job.cronJob) {
      job.cronJob.stop();
      job.paused = true;
      console.log(`[Scheduler] Job ${jobId} paused`);
    }
  }

  /**
   * Resume a paused job
   */
  async resumeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job && job.paused) {
      job.cronJob.start();
      job.paused = false;
      console.log(`[Scheduler] Job ${jobId} resumed`);
    }
  }

  // Private helpers
  _detectAnomaly(result, config) {
    // Implement anomaly detection logic based on config
    // Example: if result.value < config.threshold → anomaly
    return false; // Placeholder
  }

  async _triggerAlert(jobId, result, config) {
    if (!this.alertDelivery) {
      console.warn(`[Scheduler] No alert delivery system configured for job ${jobId}`);
      return;
    }

    try {
      // Extract subscription ID from job ID (format: sub-{subscriptionId})
      const subscriptionId = jobId.startsWith('sub-') ? jobId.substring(4) : jobId;

      // Send anomaly detected alert
      await this.alertDelivery.sendAnomalyDetected(
        subscriptionId,
        config.agentId || 'unknown',
        result.type || 'monitoring',
        result.threshold || 0,
        result.value || 0
      );

      console.log(`[Scheduler] Alert successfully delivered for job ${jobId}`);
    } catch (error) {
      console.error(`[Scheduler] Failed to deliver alert for job ${jobId}:`, error.message);
    }
  }
}

export { AgentScheduler };