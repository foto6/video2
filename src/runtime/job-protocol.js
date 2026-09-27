import { isTerminalRenderStatus } from "./lifecycle.js";
import { runtimeError } from "./errors.js";

export const MEDIA_JOB_CONTRACT_VERSION = "media.job.v1";

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

  async handle(message) {
    requireObject(message, "media.job.v1 message");
    if (message.contractVersion !== MEDIA_JOB_CONTRACT_VERSION) {
      throw runtimeError("invalid_request", `contractVersion must be ${MEDIA_JOB_CONTRACT_VERSION}`);
    }

    switch (message.action) {
      case "submit": {
        if (typeof message.idempotencyKey !== "string" || message.idempotencyKey.length === 0) {
          throw runtimeError("invalid_request", "submit requires idempotencyKey");
        }
        requireObject(message.request, "submit.request");
        const result = this.runtime.submit(message.request, { idempotencyKey: message.idempotencyKey });
        return {
          ...publicJobSnapshot(result.job),
          duplicate: result.duplicate
        };
      }
      case "get":
        return publicJobSnapshot(this.runtime.observe(message.jobId, "get"));
      case "status":
        return publicJobSnapshot(this.runtime.observe(message.jobId, "status"));
      case "cancel":
        return publicJobSnapshot(this.runtime.cancel(message.jobId, message.reason ?? "cancelled_by_creator"));
      case "resume_or_poll":
        return publicJobSnapshot(await this.runtime.resumeOrPoll(message.jobId));
      default:
        throw runtimeError("invalid_request", `unsupported media.job.v1 action: ${message.action}`);
    }
  }
}
