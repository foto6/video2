import { runtimeError } from "./errors.js";

export const RENDER_JOB_STATUSES = Object.freeze([
  "planned",
  "queued",
  "rendering",
  "probing",
  "qa",
  "succeeded",
  "retry_wait",
  "cancelled",
  "failed"
]);

const STATUS_SET = new Set(RENDER_JOB_STATUSES);
const TRANSITIONS = Object.freeze({
  planned: new Set(["queued", "cancelled", "failed"]),
  queued: new Set(["rendering", "succeeded", "cancelled", "failed"]),
  rendering: new Set(["probing", "retry_wait", "cancelled", "failed"]),
  probing: new Set(["qa", "retry_wait", "cancelled", "failed"]),
  qa: new Set(["succeeded", "retry_wait", "cancelled", "failed"]),
  retry_wait: new Set(["queued", "cancelled", "failed"]),
  succeeded: new Set(),
  cancelled: new Set(),
  failed: new Set()
});

export function isRenderJobStatus(value) {
  return STATUS_SET.has(value);
}

export function isTerminalRenderStatus(value) {
  return value === "succeeded" || value === "cancelled" || value === "failed";
}

export function transitionRuntimeJob(job, nextStatus, { reason = null, atMs = Date.now(), patch = {} } = {}) {
  if (!job || !isRenderJobStatus(job.status)) {
    throw runtimeError("state_corrupt", "render job has invalid current status");
  }
  if (!isRenderJobStatus(nextStatus)) {
    throw runtimeError("state_invalid_transition", `unknown render job status: ${nextStatus}`);
  }
  if (!TRANSITIONS[job.status].has(nextStatus)) {
    throw runtimeError("state_invalid_transition", `invalid render job transition: ${job.status} -> ${nextStatus}`);
  }

  return {
    ...job,
    ...patch,
    status: nextStatus,
    history: [
      ...(Array.isArray(job.history) ? job.history : []),
      { from: job.status, to: nextStatus, reason, atMs }
    ]
  };
}
