import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { isRenderJobStatus } from "./lifecycle.js";
import { runtimeError } from "./errors.js";

const STORE_VERSION = 2;

function schedulerStateDefaults() {
  return {
    nextEnqueueSequence: 1,
    fairCursor: 0,
    dispatchSequence: 0
  };
}

function emptyState() {
  return {
    version: STORE_VERSION,
    jobs: {},
    idempotency: {},
    recoveryEvents: [],
    scheduler: schedulerStateDefaults()
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedIdempotencyRecord(value, jobs) {
  if (typeof value === "string" && jobs[value]) {
    return { jobId: value, workSignature: jobs[value].workSignature ?? null };
  }
  if (
    value &&
    typeof value === "object" &&
    typeof value.jobId === "string" &&
    jobs[value.jobId]
  ) {
    return {
      jobId: value.jobId,
      workSignature: typeof value.workSignature === "string"
        ? value.workSignature
        : jobs[value.jobId].workSignature ?? null
    };
  }
  return null;
}

function maxPersistedEnqueueSequence(jobs) {
  let max = 0;
  for (const job of Object.values(jobs)) {
    const value = job?.scheduling?.enqueueSequence;
    if (Number.isInteger(value) && value > max) max = value;
  }
  return max;
}

function sanitizeSchedulerState(rawScheduler, jobs) {
  const minimumNext = maxPersistedEnqueueSequence(jobs) + 1;
  if (rawScheduler === undefined) {
    return {
      ...schedulerStateDefaults(),
      nextEnqueueSequence: Math.max(1, minimumNext)
    };
  }
  if (!rawScheduler || typeof rawScheduler !== "object" || Array.isArray(rawScheduler)) {
    throw runtimeError("state_corrupt", "render job store scheduler state is invalid");
  }

  const allowed = new Set(["nextEnqueueSequence", "fairCursor", "dispatchSequence"]);
  const extra = Object.keys(rawScheduler).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw runtimeError("state_corrupt", `render job store scheduler state has unknown fields: ${extra.join(", ")}`);
  }

  const values = {
    nextEnqueueSequence: rawScheduler.nextEnqueueSequence,
    fairCursor: rawScheduler.fairCursor,
    dispatchSequence: rawScheduler.dispatchSequence
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isInteger(value) || value < 0) {
      throw runtimeError("state_corrupt", `render job store scheduler.${key} is invalid`);
    }
  }
  if (values.nextEnqueueSequence < minimumNext) {
    throw runtimeError("state_corrupt", "render job store scheduler sequence regressed behind persisted jobs");
  }
  return values;
}

function sanitizeState(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== STORE_VERSION || typeof raw.jobs !== "object") {
    throw runtimeError("state_corrupt", "render job store root is invalid");
  }

  const state = emptyState();
  for (const [key, job] of Object.entries(raw.jobs)) {
    if (!job || typeof job !== "object" || typeof job.id !== "string" || job.id !== key) {
      state.recoveryEvents.push({ type: "job_dropped", key });
      continue;
    }
    if (!isRenderJobStatus(job.status)) {
      state.jobs[key] = {
        ...job,
        status: "failed",
        failure: { code: "state_corrupt", message: "invalid persisted job status" },
        history: Array.isArray(job.history) ? job.history : []
      };
      state.recoveryEvents.push({ type: "job_failed_corrupt_status", key });
      continue;
    }
    state.jobs[key] = job;
  }

  if (raw.idempotency && typeof raw.idempotency === "object") {
    for (const [key, value] of Object.entries(raw.idempotency)) {
      const record = normalizedIdempotencyRecord(value, state.jobs);
      if (record) state.idempotency[key] = record;
    }
  }
  if (Array.isArray(raw.recoveryEvents)) state.recoveryEvents.unshift(...raw.recoveryEvents);
  state.scheduler = sanitizeSchedulerState(raw.scheduler, state.jobs);
  return state;
}

export class PersistentRenderJobStore {
  constructor({ filePath, recoverCorrupt = false } = {}) {
    if (!filePath) throw new TypeError("filePath is required");
    this.filePath = path.resolve(filePath);
    this.tmpPath = `${this.filePath}.tmp`;
    this.corruptPath = `${this.filePath}.corrupt`;
    this.recoverCorrupt = recoverCorrupt;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.state = this.#load();
  }

  #parseFile(filePath) {
    return sanitizeState(JSON.parse(readFileSync(filePath, "utf8")));
  }

  #load() {
    if (!existsSync(this.filePath) && existsSync(this.tmpPath)) {
      try {
        const recovered = this.#parseFile(this.tmpPath);
        renameSync(this.tmpPath, this.filePath);
        recovered.recoveryEvents.push({ type: "temp_store_promoted" });
        return recovered;
      } catch (error) {
        if (!this.recoverCorrupt) {
          throw runtimeError(
            "state_corrupt",
            "temporary render job store is corrupt; refusing implicit reset",
            { filePath: this.tmpPath, cause: error?.message ?? String(error) }
          );
        }
        unlinkSync(this.tmpPath);
      }
    }

    if (!existsSync(this.filePath)) {
      const state = emptyState();
      this.#persist(state);
      return state;
    }

    try {
      return this.#parseFile(this.filePath);
    } catch (error) {
      if (!this.recoverCorrupt) {
        throw runtimeError(
          "state_corrupt",
          "render job store is corrupt; refusing implicit reset",
          { filePath: this.filePath, cause: error?.message ?? String(error) }
        );
      }
      if (existsSync(this.corruptPath)) unlinkSync(this.corruptPath);
      renameSync(this.filePath, this.corruptPath);
      const state = emptyState();
      state.recoveryEvents.push({ type: "store_reset_corrupt" });
      this.#persist(state);
      return state;
    }
  }

  #persist(state = this.state) {
    writeFileSync(this.tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(this.tmpPath, this.filePath);
  }

  get(jobId) {
    const job = this.state.jobs[jobId];
    return job ? clone(job) : null;
  }

  list() {
    return Object.values(this.state.jobs).map(clone);
  }

  getIdempotencyRecord(key) {
    if (!key) return null;
    const record = this.state.idempotency[key];
    return record ? clone(record) : null;
  }

  findByIdempotencyKey(key) {
    const record = this.getIdempotencyRecord(key);
    return record ? this.get(record.jobId) : null;
  }

  bindIdempotency(key, jobId, workSignature) {
    if (!key) return;
    const existing = this.state.idempotency[key];
    if (existing) {
      if (existing.jobId !== jobId || existing.workSignature !== workSignature) {
        throw runtimeError("idempotency_conflict", "idempotency key is already bound to different work");
      }
      return;
    }
    if (!this.state.jobs[jobId]) throw runtimeError("job_not_found", `unknown job: ${jobId}`);
    this.state.idempotency[key] = { jobId, workSignature };
    this.#persist();
  }

  create(job, { idempotencyKey = null, workSignature = job.workSignature ?? null } = {}) {
    const existingJob = this.state.jobs[job.id];
    if (existingJob) {
      if (workSignature && existingJob.workSignature === workSignature) {
        if (idempotencyKey) this.bindIdempotency(idempotencyKey, existingJob.id, workSignature);
        return { job: clone(existingJob), duplicate: true };
      }
      throw runtimeError("job_conflict", `job id is already bound to different work: ${job.id}`);
    }

    if (idempotencyKey && this.state.idempotency[idempotencyKey]) {
      const record = this.state.idempotency[idempotencyKey];
      if (record.workSignature === workSignature && record.jobId === job.id) {
        return { job: this.get(record.jobId), duplicate: true };
      }
      throw runtimeError("idempotency_conflict", "idempotency key is already bound to different work");
    }

    this.state.jobs[job.id] = clone(job);
    if (idempotencyKey) {
      this.state.idempotency[idempotencyKey] = { jobId: job.id, workSignature };
    }
    this.#persist();
    return { job: clone(job), duplicate: false };
  }

  put(job) {
    if (!this.state.jobs[job.id]) throw runtimeError("job_not_found", `unknown job: ${job.id}`);
    this.state.jobs[job.id] = clone(job);
    this.#persist();
    return clone(job);
  }

  allocateEnqueueSequence() {
    const sequence = this.state.scheduler.nextEnqueueSequence;
    this.state.scheduler.nextEnqueueSequence += 1;
    this.#persist();
    return sequence;
  }

  getSchedulerState() {
    return clone(this.state.scheduler);
  }

  updateSchedulerState(patch) {
    const next = { ...this.state.scheduler, ...patch };
    for (const key of ["nextEnqueueSequence", "fairCursor", "dispatchSequence"]) {
      if (!Number.isInteger(next[key]) || next[key] < 0) {
        throw runtimeError("state_corrupt", `invalid scheduler state field: ${key}`);
      }
    }
    if (next.nextEnqueueSequence < this.state.scheduler.nextEnqueueSequence) {
      throw runtimeError("state_corrupt", "nextEnqueueSequence cannot move backwards");
    }
    if (next.dispatchSequence < this.state.scheduler.dispatchSequence) {
      throw runtimeError("state_corrupt", "dispatchSequence cannot move backwards");
    }
    this.state.scheduler = next;
    this.#persist();
    return clone(next);
  }

  recoveryEvents() {
    return clone(this.state.recoveryEvents);
  }
}
