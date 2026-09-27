import { isTerminalRenderStatus } from "./lifecycle.js";
import { runtimeError } from "./errors.js";
import {
  MEDIA_JOB_CONTRACT_VERSION,
  parseMediaJobEnvelope,
  validateMediaJobPublicResponse
} from "./job-conformance.js";

export { MEDIA_JOB_CONTRACT_VERSION } from "./job-conformance.js";

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError("invalid_request", `${label} must be an object`);
  }
}

function publicTelemetry(job) {
  const telemetry = job.telemetry ?? {};
  return {
    planningMs: telemetry.planningMs ?? 0,
    queueWaitMs: telemetry.queueWaitMs ?? 0,
    renderMs: telemetry.renderMs ?? 0,
    probeMs: telemetry.probeMs ?? 0,
    qaMs: telemetry.qaMs ?? 0,
    retries: telemetry.retries ?? 0,
    outputSize: telemetry.outputSize ?? null,
    outputSha256: telemetry.outputSha256 ?? null,
    sideEffects: {
      executorInvocations: telemetry.sideEffects?.executorInvocations ?? 0,
      probeInvocations: telemetry.sideEffects?.probeInvocations ?? 0,
      qaEvaluations: telemetry.sideEffects?.qaEvaluations ?? 0,
      finalizeInvocations: telemetry.sideEffects?.finalizeInvocations ?? 0,
      successfulFinalizations: telemetry.sideEffects?.successfulFinalizations ?? 0
    },
    protocol: {
      submitCount: telemetry.protocol?.submitCount ?? 0,
      duplicateSubmits: telemetry.protocol?.duplicateSubmits ?? 0,
      pollCount: telemetry.protocol?.pollCount ?? 0,
      resumeCount: telemetry.protocol?.resumeCount ?? 0,
      cancelRequests: telemetry.protocol?.cancelRequests ?? 0,
      reconciliations: telemetry.protocol?.reconciliations ?? 0
    }
  };
}

export function publicJobSnapshot(job) {
  if (!job) return null;
  const succeededArtifact = job.status === "succeeded" && !job.dryRun && job.telemetry?.outputSha256
    ? {
        outputPath: job.outputPath,
        size: job.telemetry.outputSize,
        sha256: job.telemetry.outputSha256
      }
    : null;

  return {
    contractVersion: MEDIA_JOB_CONTRACT_VERSION,
    accepted: true,
    jobId: job.id,
    idempotencyKey: job.idempotencyKey ?? null,
    status: job.status,
    terminal: isTerminalRenderStatus(job.status),
    dryRun: job.dryRun === true,
    renderFingerprint: job.renderFingerprint,
    retryOwner: "media",
    reconciliation: job.reconciliation?.required
      ? { required: true, reason: job.reconciliation.reason ?? "uncertain_attempt" }
      : { required: false },
    failure: job.failure ?? null,
    finalArtifact: succeededArtifact,
    telemetry: publicTelemetry(job)
  };
}

export class MediaJobProtocolV1 {
  constructor(runtime) {
    if (!runtime) throw new TypeError("runtime is required");
    this.runtime = runtime;
  }

  async handle(input) {
    const message = parseMediaJobEnvelope(input);

    switch (message.action) {
      case "submit": {
        if (typeof message.idempotencyKey !== "string" || message.idempotencyKey.length === 0) {
          throw runtimeError("invalid_request", "submit requires idempotencyKey");
        }
        requireObject(message.request, "submit.request");
        const result = this.runtime.submit(message.request, { idempotencyKey: message.idempotencyKey });
        return validateMediaJobPublicResponse({
          ...publicJobSnapshot(result.job),
          duplicate: result.duplicate
        }, { action: "submit" });
      }
      case "get":
        return validateMediaJobPublicResponse(
          publicJobSnapshot(this.runtime.observe(message.jobId, "get")),
          { action: "get" }
        );
      case "status":
        return validateMediaJobPublicResponse(
          publicJobSnapshot(this.runtime.observe(message.jobId, "status")),
          { action: "status" }
        );
      case "cancel":
        return validateMediaJobPublicResponse(
          publicJobSnapshot(this.runtime.cancel(message.jobId, message.reason ?? "cancelled_by_creator")),
          { action: "cancel" }
        );
      case "resume_or_poll":
        return validateMediaJobPublicResponse(
          publicJobSnapshot(await this.runtime.resumeOrPoll(message.jobId)),
          { action: "resume_or_poll" }
        );
      default:
        throw runtimeError("invalid_request", `unsupported media.job.v1 action: ${message.action}`);
    }
  }
}
