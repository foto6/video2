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

function emptyState() {
  return { version: STORE_VERSION, jobs: {}, idempotency: {}, recoveryEvents: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
    for (const [key, jobId] of Object.entries(raw.idempotency)) {
      if (typeof jobId === "string" && state.jobs[jobId]) state.idempotency[key] = jobId;
    }
  }
  if (Array.isArray(raw.recoveryEvents)) state.recoveryEvents.unshift(...raw.recoveryEvents);
  return state;
}

export class PersistentRenderJobStore {
  constructor({ filePath, recoverCorrupt = true } = {}) {
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
      } catch {
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
      if (!this.recoverCorrupt) throw error;
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

  findByIdempotencyKey(key) {
    if (!key) return null;
    const jobId = this.state.idempotency[key];
    return jobId ? this.get(jobId) : null;
  }

  create(job, { idempotencyKey = null } = {}) {
    if (this.state.jobs[job.id]) throw runtimeError("duplicate_job", `job already exists: ${job.id}`);
    if (idempotencyKey && this.state.idempotency[idempotencyKey]) {
      return { job: this.get(this.state.idempotency[idempotencyKey]), duplicate: true };
    }
    this.state.jobs[job.id] = clone(job);
    if (idempotencyKey) this.state.idempotency[idempotencyKey] = job.id;
    this.#persist();
    return { job: clone(job), duplicate: false };
  }

  put(job) {
    if (!this.state.jobs[job.id]) throw runtimeError("job_not_found", `unknown job: ${job.id}`);
    this.state.jobs[job.id] = clone(job);
    this.#persist();
    return clone(job);
  }

  recoveryEvents() {
    return clone(this.state.recoveryEvents);
  }
}
