import { existsSync } from "node:fs";

import { compileFfmpegCommand } from "../ffmpeg.js";
import { buildRenderPlan } from "../plan.js";
import { evaluateRenderQa } from "../qa.js";
import { fingerprint } from "../stable.js";
import { canonicalizeTimeline } from "../timeline.js";
import {
  atomicFinalize,
  cleanupTempOutput,
  outputDigest,
  prepareTempOutput
} from "./atomic-output.js";
import { RenderRuntimeError, runtimeError } from "./errors.js";
import { isTerminalRenderStatus, transitionRuntimeJob } from "./lifecycle.js";
import { validateRuntimePaths } from "./path-policy.js";
import {
  DurableFairScheduler,
  buildSchedulerDiagnostics,
  deriveSchedulingProfile,
  isSchedulerRunnable
} from "./resource-scheduler.js";
import { ResourceController } from "./resources.js";
import { RetryPolicy } from "./retry.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw runtimeError("invalid_request", "render request must be an object");
  }
  if (request.contractVersion !== undefined && request.contractVersion !== "media.render.v1") {
    throw runtimeError("invalid_request", "unsupported media render contract version");
  }
  if (typeof request.jobId !== "string" || request.jobId.length === 0) {
    throw runtimeError("invalid_request", "jobId is required");
  }
  if (!request.timeline || typeof request.timeline !== "object") {
    throw runtimeError("invalid_request", "timeline is required");
  }
  if (
    request.exportSpec !== undefined &&
    (request.exportSpec === null || typeof request.exportSpec !== "object" || Array.isArray(request.exportSpec))
  ) {
    throw runtimeError("invalid_request", "exportSpec must be an object");
  }
  if (typeof request.outputPath !== "string" || request.outputPath.length === 0) {
    throw runtimeError("invalid_request", "outputPath is required");
  }
  if (typeof request.dryRun !== "boolean") {
    throw runtimeError("invalid_request", "dryRun must be boolean");
  }
}

function phaseDuration(clock, started) {
  return Math.max(0, clock() - started);
}

function processSnapshot(result) {
  return {
    ok: result.ok === true,
    code: result.code ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    cancelled: result.cancelled === true,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    durationMs: result.durationMs ?? null
  };
}

function withFailure(error, decision) {
  return {
    code: decision.code,
    category: decision.category,
    message: error?.message ?? String(error),
    retryable: decision.retryable,
    details: error instanceof RenderRuntimeError ? error.details : null
  };
}

function schedulerTelemetry(input = {}) {
  return {
    queueAgeMs: input.queueAgeMs ?? 0,
    resourceWaitMs: input.resourceWaitMs ?? 0,
    dispatches: input.dispatches ?? 0,
    starvationCount: input.starvationCount ?? 0
  };
}

function normalizedTelemetry(telemetry = {}) {
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
    },
    scheduler: schedulerTelemetry(telemetry.scheduler)
  };
}

function updateCounter(job, section, name, delta = 1) {
  const telemetry = normalizedTelemetry(job.telemetry);
  telemetry[section][name] = (telemetry[section][name] ?? 0) + delta;
  return { ...job, telemetry };
}

export class RenderRuntimeV2 {
  constructor({
    store,
    executor,
    probe,
    sandboxRoot = process.cwd(),
    liveExecutionEnabled = false,
    maxConcurrency = 2,
    resourceLimits = { render: 1, probe: 1 },
    retryPolicy = new RetryPolicy(),
    processTimeoutMs = 120000,
    clock = () => Date.now(),
    attemptReconciler = null,
    queueLimit = 1024,
    schedulerOptions = {},
    schedulerPollDispatchLimit = null
  } = {}) {
    if (!store) throw new TypeError("store is required");
    if (!executor || typeof executor.run !== "function") throw new TypeError("executor.run is required");
    if (!probe || typeof probe.inspect !== "function") throw new TypeError("probe.inspect is required");
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new TypeError("maxConcurrency must be positive");
    if (!Number.isInteger(queueLimit) || queueLimit < 1) throw new TypeError("queueLimit must be positive");
    if (attemptReconciler !== null && typeof attemptReconciler.reconcile !== "function") {
      throw new TypeError("attemptReconciler.reconcile is required");
    }

    this.store = store;
    this.executor = executor;
    this.probe = probe;
    this.sandboxRoot = sandboxRoot;
    this.liveExecutionEnabled = liveExecutionEnabled;
    this.maxConcurrency = maxConcurrency;
    this.clock = clock;
    this.resources = new ResourceController(resourceLimits, { clock });
    this.retryPolicy = retryPolicy;
    this.processTimeoutMs = processTimeoutMs;
    this.attemptReconciler = attemptReconciler;
    this.queueLimit = queueLimit;
    this.scheduler = new DurableFairScheduler({
      store,
      clock,
      ...schedulerOptions
    });
    this.schedulerPollDispatchLimit = schedulerPollDispatchLimit ??
      Math.max(2, this.scheduler.priorityWheel.length);
    if (!Number.isInteger(this.schedulerPollDispatchLimit) || this.schedulerPollDispatchLimit < 1) {
      throw new TypeError("schedulerPollDispatchLimit must be positive");
    }
    this.active = new Map();
    this.inflightRuns = new Map();
  }

  #prepareSubmission(request) {
    validateRequest(request);
    if (!request.dryRun && !this.liveExecutionEnabled) {
      throw runtimeError("live_execution_disabled", "live rendering is disabled for this runtime");
    }

    const planningStarted = this.clock();
    const timeline = canonicalizeTimeline(request.timeline);
    const exportSpec = clone(request.exportSpec ?? {});
    const paths = validateRuntimePaths(timeline, request.outputPath, { sandboxRoot: this.sandboxRoot });
    const plan = buildRenderPlan(timeline, exportSpec);
    compileFfmpegCommand(timeline, exportSpec, paths.outputPath);
    const schedulingProfile = deriveSchedulingProfile(timeline, exportSpec, request.dryRun);
    for (const requirements of Object.values(schedulingProfile.requirements)) {
      this.resources.assertFitsBudget(requirements);
    }
    const plannedAtMs = this.clock();
    const workSignature = fingerprint({
      jobId: request.jobId,
      renderFingerprint: plan.fingerprint,
      outputPath: request.outputPath,
      dryRun: request.dryRun
    });

    return {
      timeline,
      exportSpec,
      paths,
      plan,
      schedulingProfile,
      planningStarted,
      plannedAtMs,
      workSignature
    };
  }

  #pendingCount() {
    return this.store.list().filter((job) => !isTerminalRenderStatus(job.status)).length;
  }

  #ensureScheduling(job) {
    if (job.scheduling?.enqueueSequence !== undefined) {
      return {
        ...job,
        telemetry: normalizedTelemetry(job.telemetry)
      };
    }

    const profile = deriveSchedulingProfile(job.timeline, job.exportSpec ?? {}, job.dryRun === true);
    for (const requirements of Object.values(profile.requirements)) {
      this.resources.assertFitsBudget(requirements);
    }
    const schedulerState = this.store.getSchedulerState();
    const sequence = this.store.allocateEnqueueSequence();
    const updated = {
      ...job,
      scheduling: {
        profile: profile.profile,
        priorityClass: profile.priorityClass,
        enqueueSequence: sequence,
        enqueuedDispatchSequence: schedulerState.dispatchSequence,
        enqueuedAtMs: job.queuedAtMs ?? job.createdAtMs ?? this.clock(),
        lastDispatchSequence: null,
        lastDispatchAtMs: null,
        requirements: profile.requirements,
        reservation: null
      },
      telemetry: normalizedTelemetry(job.telemetry)
    };
    return this.store.put(updated);
  }

  #markDuplicate(existing) {
    let job = updateCounter(existing, "protocol", "submitCount");
    job = updateCounter(job, "protocol", "duplicateSubmits");
    return this.store.put(job);
  }

  submit(request, { idempotencyKey = null } = {}) {
    const prepared = this.#prepareSubmission(request);

    if (idempotencyKey) {
      const record = this.store.getIdempotencyRecord(idempotencyKey);
      if (record) {
        if (record.jobId !== request.jobId || record.workSignature !== prepared.workSignature) {
          throw runtimeError("idempotency_conflict", "idempotency key is already bound to different render work");
        }
        const existing = this.store.get(record.jobId);
        if (!existing) throw runtimeError("state_corrupt", "idempotency record references a missing job");
        return { job: this.#markDuplicate(existing), duplicate: true };
      }
    }

    const existingById = this.store.get(request.jobId);
    if (existingById) {
      if (existingById.workSignature !== prepared.workSignature) {
        throw runtimeError("job_conflict", "logical render job id is already bound to different render work");
      }
      if (idempotencyKey) {
        this.store.bindIdempotency(idempotencyKey, existingById.id, prepared.workSignature);
      }
      return { job: this.#markDuplicate(existingById), duplicate: true };
    }

    if (this.#pendingCount() >= this.queueLimit) {
      throw runtimeError(
        "queue_saturated",
        `render queue is saturated at configured limit ${this.queueLimit}`
      );
    }

    const schedulerState = this.store.getSchedulerState();
    const enqueueSequence = this.store.allocateEnqueueSequence();
    let job = {
      schemaVersion: 2,
      id: request.jobId,
      idempotencyKey,
      workSignature: prepared.workSignature,
      status: "planned",
      dryRun: request.dryRun,
      timeline: prepared.timeline,
      exportSpec: prepared.exportSpec,
      outputPath: request.outputPath,
      resolvedOutputPath: prepared.paths.outputPath,
      tempOutputPath: null,
      renderFingerprint: prepared.plan.fingerprint,
      attempts: 0,
      maxAttempts: this.retryPolicy.maxAttempts,
      retryStage: null,
      cancellationRequested: false,
      reconciliation: { required: false },
      currentAttempt: null,
      processResult: null,
      probe: null,
      qa: null,
      failure: null,
      createdAtMs: prepared.planningStarted,
      queuedAtMs: null,
      scheduling: {
        profile: prepared.schedulingProfile.profile,
        priorityClass: prepared.schedulingProfile.priorityClass,
        enqueueSequence,
        enqueuedDispatchSequence: schedulerState.dispatchSequence,
        enqueuedAtMs: prepared.plannedAtMs,
        lastDispatchSequence: null,
        lastDispatchAtMs: null,
        requirements: prepared.schedulingProfile.requirements,
        reservation: null
      },
      history: [{ from: null, to: "planned", reason: "submit", atMs: prepared.plannedAtMs }],
      telemetry: {
        planningMs: Math.max(0, prepared.plannedAtMs - prepared.planningStarted),
        queueWaitMs: 0,
        renderMs: 0,
        probeMs: 0,
        qaMs: 0,
        retries: 0,
        outputSize: null,
        outputSha256: null,
        sideEffects: {
          executorInvocations: 0,
          probeInvocations: 0,
          qaEvaluations: 0,
          finalizeInvocations: 0,
          successfulFinalizations: 0
        },
        protocol: {
          submitCount: 1,
          duplicateSubmits: 0,
          pollCount: 0,
          resumeCount: 0,
          cancelRequests: 0,
          reconciliations: 0
        },
        scheduler: schedulerTelemetry()
      }
    };

    const created = this.store.create(job, {
      idempotencyKey,
      workSignature: prepared.workSignature
    });
    if (created.duplicate) return { job: this.#markDuplicate(created.job), duplicate: true };

    const queuedAtMs = this.clock();
    job = transitionRuntimeJob(job, "queued", {
      reason: "planned",
      atMs: queuedAtMs,
      patch: {
        queuedAtMs,
        scheduling: {
          ...job.scheduling,
          enqueuedAtMs: queuedAtMs
        }
      }
    });
    this.store.put(job);
    return { job, duplicate: false };
  }

  observe(jobId, _kind = "status") {
    let job = this.store.get(jobId);
    if (!job) throw runtimeError("job_not_found", `unknown job: ${jobId}`);
    job = updateCounter(job, "protocol", "pollCount");
    return this.store.put(job);
  }

  cancel(jobId, reason = "cancelled_by_request") {
    let job = this.store.get(jobId);
    if (!job) throw runtimeError("job_not_found", `unknown job: ${jobId}`);
    job = updateCounter(job, "protocol", "cancelRequests");
    if (isTerminalRenderStatus(job.status)) return this.store.put(job);

    job = { ...job, cancellationRequested: true };
    this.store.put(job);

    const activeController = this.active.get(jobId);
    if (activeController) {
      activeController.abort(reason);
      return this.store.get(jobId);
    }

    if (job.status === "rendering") {
      job = {
        ...this.store.get(jobId),
        reconciliation: {
          required: true,
          reason: "cancel_uncertain_render",
          sinceMs: this.clock()
        }
      };
      return this.store.put(job);
    }

    if (job.status === "planned" || job.status === "queued" || job.status === "retry_wait") {
      if (job.reconciliation?.required) return this.store.put(job);
      cleanupTempOutput(job.tempOutputPath);
      job = transitionRuntimeJob(job, "cancelled", {
        reason,
        atMs: this.clock(),
        patch: {
          scheduling: {
            ...(job.scheduling ?? {}),
            reservation: null
          }
        }
      });
      return this.store.put(job);
    }

    if (job.status === "probing" || job.status === "qa") {
      cleanupTempOutput(job.tempOutputPath);
      job = transitionRuntimeJob(job, "cancelled", {
        reason,
        atMs: this.clock(),
        patch: {
          scheduling: {
            ...(job.scheduling ?? {}),
            reservation: null
          }
        }
      });
      return this.store.put(job);
    }

    return this.store.put(job);
  }

  #restoreUncertainRenderReservation(job) {
    const requirements = job.scheduling?.requirements?.render ??
      deriveSchedulingProfile(job.timeline, job.exportSpec ?? {}, job.dryRun === true).requirements.render;
    const token = job.scheduling?.reservation?.token ??
      job.currentAttempt?.token ??
      `${job.id}:render:${job.telemetry?.sideEffects?.executorInvocations ?? job.attempts ?? 1}`;

    this.resources.reserveExternal(token, requirements);
    return {
      ...job,
      scheduling: {
        ...(job.scheduling ?? {}),
        reservation: {
          token,
          stage: "render",
          requirements,
          external: true,
          uncertain: true
        }
      }
    };
  }

  #releaseExternalReservation(job) {
    const reservation = job.scheduling?.reservation;
    if (reservation?.external && reservation.token) {
      this.resources.releaseExternal(reservation.token);
    }
    return {
      ...job,
      scheduling: {
        ...(job.scheduling ?? {}),
        reservation: null
      }
    };
  }

  recoverInterruptedJobs() {
    const recovered = [];
    for (let job of this.store.list()) {
      if (isTerminalRenderStatus(job.status)) continue;
      job = this.#ensureScheduling(job);
      job = { ...job, telemetry: normalizedTelemetry(job.telemetry) };

      if (job.reconciliation?.required) {
        job = this.#restoreUncertainRenderReservation(job);
        recovered.push(this.store.put(job));
        continue;
      }

      if (job.status === "planned") {
        job = transitionRuntimeJob(job, "queued", {
          reason: "restart_requeue_planned",
          atMs: this.clock(),
          patch: { queuedAtMs: job.queuedAtMs ?? this.clock() }
        });
        recovered.push(this.store.put(job));
        continue;
      }

      if (job.status === "rendering") {
        job = this.#restoreUncertainRenderReservation(job);
        job = transitionRuntimeJob(job, "retry_wait", {
          reason: "restart_interrupted",
          atMs: this.clock(),
          patch: {
            retryStage: "queued",
            reconciliation: {
              required: true,
              reason: "uncertain_render_attempt",
              sinceMs: this.clock(),
              attemptToken: job.currentAttempt?.token ?? null
            },
            failure: {
              code: "interrupted_restart",
              category: "recovery",
              message: "render attempt outcome is uncertain after restart",
              retryable: true,
              details: null
            },
            telemetry: {
              ...job.telemetry,
              retries: job.telemetry.retries + 1
            }
          }
        });
        recovered.push(this.store.put(job));
        continue;
      }

      if (job.scheduling?.reservation) {
        job = {
          ...job,
          scheduling: {
            ...job.scheduling,
            reservation: null
          }
        };
      }

      if (job.cancellationRequested) {
        cleanupTempOutput(job.tempOutputPath);
        if (job.status === "queued" || job.status === "retry_wait" || job.status === "probing" || job.status === "qa") {
          job = transitionRuntimeJob(job, "cancelled", {
            reason: "restart_cancelled",
            atMs: this.clock()
          });
          recovered.push(this.store.put(job));
        }
        continue;
      }

      if (job.status === "probing" || job.status === "qa") {
        job = {
          ...job,
          recovery: {
            resumedStage: job.status,
            recoveredAtMs: this.clock()
          }
        };
        recovered.push(this.store.put(job));
      } else if (job.status === "retry_wait") {
        recovered.push(this.store.put(job));
      }
    }
    return recovered;
  }

  reconcileAttempt(jobId, { outcome } = {}) {
    let job = this.store.get(jobId);
    if (!job) throw runtimeError("job_not_found", `unknown job: ${jobId}`);
    if (!job.reconciliation?.required) return job;

    job = updateCounter(job, "protocol", "reconciliations");

    if (outcome === "still_running" || outcome === "unknown") {
      job = {
        ...job,
        reconciliation: {
          ...job.reconciliation,
          required: true,
          lastOutcome: outcome,
          checkedAtMs: this.clock()
        }
      };
      return this.store.put(job);
    }

    job = this.#releaseExternalReservation(job);

    if (outcome === "render_complete") {
      if (!job.tempOutputPath || !existsSync(job.tempOutputPath)) {
        throw runtimeError("reconciliation_missing_output", "reconciled render has no temporary output");
      }
      if (job.cancellationRequested) {
        cleanupTempOutput(job.tempOutputPath);
        job = transitionRuntimeJob(job, "cancelled", {
          reason: "reconciled_cancelled",
          atMs: this.clock(),
          patch: {
            reconciliation: { required: false },
            scheduling: { ...job.scheduling, reservation: null }
          }
        });
      } else {
        job = transitionRuntimeJob(job, "probing", {
          reason: "reconciled_render_complete",
          atMs: this.clock(),
          patch: {
            reconciliation: { required: false },
            retryStage: null,
            scheduling: { ...job.scheduling, reservation: null },
            currentAttempt: {
              ...(job.currentAttempt ?? {}),
              state: "rendered_reconciled",
              reconciledAtMs: this.clock()
            }
          }
        });
      }
      return this.store.put(job);
    }

    if (outcome === "not_running") {
      cleanupTempOutput(job.tempOutputPath);
      if (job.cancellationRequested) {
        job = transitionRuntimeJob(job, "cancelled", {
          reason: "reconciled_not_running_cancelled",
          atMs: this.clock(),
          patch: {
            reconciliation: { required: false },
            tempOutputPath: null,
            scheduling: { ...job.scheduling, reservation: null }
          }
        });
      } else {
        job = {
          ...job,
          reconciliation: { required: false },
          tempOutputPath: null,
          retryStage: "queued",
          scheduling: { ...job.scheduling, reservation: null },
          currentAttempt: {
            ...(job.currentAttempt ?? {}),
            state: "reconciled_not_running",
            reconciledAtMs: this.clock()
          }
        };
      }
      return this.store.put(job);
    }

    throw runtimeError("invalid_reconciliation", "reconciliation outcome must be still_running, unknown, render_complete, or not_running");
  }

  #selectRunnable(limit) {
    const jobs = this.store.list().map((job) =>
      isSchedulerRunnable(job) ? this.#ensureScheduling(job) : job
    );
    return this.scheduler.select(jobs, limit, new Set(this.inflightRuns.keys()));
  }

  async resumeOrPoll(jobId) {
    let job = this.store.get(jobId);
    if (!job) throw runtimeError("job_not_found", `unknown job: ${jobId}`);
    job = updateCounter(job, "protocol", "pollCount");
    job = updateCounter(job, "protocol", "resumeCount");
    this.store.put(job);

    if (job.reconciliation?.required) {
      if (!this.attemptReconciler) return this.store.get(jobId);
      const result = await this.attemptReconciler.reconcile(clone(job));
      job = this.reconcileAttempt(jobId, result);
      if (job.reconciliation?.required || isTerminalRenderStatus(job.status)) return job;
    }

    const existing = this.inflightRuns.get(jobId);
    if (existing) {
      await existing;
      return this.store.get(jobId);
    }

    for (let dispatch = 0; dispatch < this.schedulerPollDispatchLimit; dispatch += 1) {
      const current = this.store.get(jobId);
      if (!current || isTerminalRenderStatus(current.status) || current.reconciliation?.required) return current;

      const selected = this.#selectRunnable(1);
      if (selected.length === 0) return current;
      await this.runAcceptedJob(selected[0].id);

      const after = this.store.get(jobId);
      if (!after || isTerminalRenderStatus(after.status) || after.reconciliation?.required) return after;
    }
    return this.store.get(jobId);
  }

  async #retryOrFail(job, error, stage) {
    const telemetry = normalizedTelemetry(job.telemetry);
    const stageAttempts = {
      render: telemetry.sideEffects.executorInvocations,
      probing: telemetry.sideEffects.probeInvocations,
      qa: telemetry.sideEffects.qaEvaluations,
      finalize: telemetry.sideEffects.finalizeInvocations
    };
    const decision = this.retryPolicy.decide(error, stageAttempts[stage] ?? job.attempts ?? 0);

    const clearedScheduling = {
      ...(job.scheduling ?? {}),
      reservation: null
    };

    if (decision.code === "cancelled" || job.cancellationRequested) {
      cleanupTempOutput(job.tempOutputPath);
      job = transitionRuntimeJob(job, "cancelled", {
        reason: decision.code,
        atMs: this.clock(),
        patch: {
          failure: withFailure(error, decision),
          cancellationRequested: true,
          tempOutputPath: null,
          scheduling: clearedScheduling
        }
      });
      return this.store.put(job);
    }

    if (decision.retry) {
      const retryStage = stage === "render" ? "queued" : stage === "probing" ? "probing" : "qa";
      if (retryStage === "queued") {
        cleanupTempOutput(job.tempOutputPath);
      }
      job = transitionRuntimeJob(job, "retry_wait", {
        reason: decision.code,
        atMs: this.clock(),
        patch: {
          retryStage,
          tempOutputPath: retryStage === "queued" ? null : job.tempOutputPath,
          failure: withFailure(error, decision),
          scheduling: clearedScheduling,
          telemetry: { ...telemetry, retries: telemetry.retries + 1 }
        }
      });
      return this.store.put(job);
    }

    cleanupTempOutput(job.tempOutputPath);
    job = transitionRuntimeJob(job, "failed", {
      reason: decision.code,
      atMs: this.clock(),
      patch: {
        failure: withFailure(error, decision),
        tempOutputPath: null,
        scheduling: clearedScheduling
      }
    });
    return this.store.put(job);
  }

  #advanceRetryWait(job) {
    if (job.reconciliation?.required) return job;
    const target = job.retryStage ?? "queued";
    const patch = { retryStage: null };
    if (target === "queued") patch.queuedAtMs = this.clock();
    else patch.attempts = (job.attempts ?? 0) + 1;
    job = transitionRuntimeJob(job, target, {
      reason: `retry_${target}`,
      atMs: this.clock(),
      patch
    });
    return this.store.put(job);
  }

  #cancelStage(job, reason) {
    cleanupTempOutput(job.tempOutputPath);
    job = transitionRuntimeJob(job, "cancelled", {
      reason,
      atMs: this.clock(),
      patch: {
        cancellationRequested: true,
        tempOutputPath: null,
        scheduling: {
          ...(job.scheduling ?? {}),
          reservation: null
        }
      }
    });
    return this.store.put(job);
  }

  #addResourceWait(job, waitMs) {
    const telemetry = normalizedTelemetry(job.telemetry);
    telemetry.scheduler.resourceWaitMs += waitMs;
    return { ...job, telemetry };
  }

  #clearReservation(jobId, token) {
    const current = this.store.get(jobId);
    if (!current) return null;
    if (current.scheduling?.reservation?.token !== token) return current;
    return this.store.put({
      ...current,
      scheduling: {
        ...current.scheduling,
        reservation: null
      }
    });
  }

  async #executeQueued(job, controller) {
    if (job.cancellationRequested) return this.#cancelStage(job, "cancelled_before_start");
    const queueWaitMs = Math.max(0, this.clock() - (job.queuedAtMs ?? this.clock()));

    if (job.dryRun) {
      const telemetry = normalizedTelemetry(job.telemetry);
      telemetry.queueWaitMs += queueWaitMs;
      telemetry.scheduler.queueAgeMs = Math.max(telemetry.scheduler.queueAgeMs, queueWaitMs);
      job = transitionRuntimeJob(job, "succeeded", {
        reason: "dry_run_plan_only",
        atMs: this.clock(),
        patch: { telemetry }
      });
      return this.store.put(job);
    }

    if (!this.liveExecutionEnabled) {
      job = transitionRuntimeJob(job, "failed", {
        reason: "live_execution_disabled",
        atMs: this.clock(),
        patch: {
          failure: {
            code: "live_execution_disabled",
            category: "policy",
            message: "live rendering is disabled for this runtime",
            retryable: false,
            details: null
          }
        }
      });
      return this.store.put(job);
    }

    const requirements = job.scheduling.requirements.render;
    let lease;
    try {
      lease = await this.resources.acquire(requirements, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || error?.code === "cancelled") {
        return this.#cancelStage(this.store.get(job.id), "cancelled_waiting_for_render_resources");
      }
      throw error;
    }

    if (controller.signal.aborted || this.store.get(job.id)?.cancellationRequested) {
      lease.release();
      return this.#cancelStage(this.store.get(job.id), "cancelled_after_render_resource_acquire");
    }

    const tempPath = prepareTempOutput(job.resolvedOutputPath, job.id);
    let telemetry = normalizedTelemetry(this.store.get(job.id).telemetry);
    telemetry.queueWaitMs += queueWaitMs;
    telemetry.scheduler.queueAgeMs = Math.max(telemetry.scheduler.queueAgeMs, queueWaitMs);
    telemetry.scheduler.resourceWaitMs += lease.waitMs;
    telemetry.sideEffects.executorInvocations += 1;
    const invocation = telemetry.sideEffects.executorInvocations;
    const startedAtMs = this.clock();
    const token = `${job.id}:render:${invocation}`;

    job = transitionRuntimeJob(this.store.get(job.id), "rendering", {
      reason: "worker_start",
      atMs: startedAtMs,
      patch: {
        attempts: (job.attempts ?? 0) + 1,
        tempOutputPath: tempPath,
        processResult: null,
        probe: null,
        qa: null,
        failure: null,
        telemetry,
        scheduling: {
          ...job.scheduling,
          reservation: {
            token,
            stage: "render",
            requirements,
            external: false,
            uncertain: false
          }
        },
        currentAttempt: {
          token,
          renderInvocation: invocation,
          state: "started",
          startedAtMs
        }
      }
    });
    this.store.put(job);

    const command = compileFfmpegCommand(job.timeline, job.exportSpec, tempPath);
    const renderStarted = this.clock();
    let processResult = null;
    let executionError = null;
    try {
      processResult = await this.executor.run(command, {
        signal: controller.signal,
        timeoutMs: this.processTimeoutMs
      });
    } catch (error) {
      executionError = error;
    } finally {
      lease.release();
      this.#clearReservation(job.id, token);
    }

    job = this.store.get(job.id);
    telemetry = normalizedTelemetry(job.telemetry);
    telemetry.renderMs += phaseDuration(this.clock, renderStarted);

    if (executionError) {
      job = { ...job, telemetry };
      this.store.put(job);
      if (controller.signal.aborted) {
        return this.#retryOrFail(job, runtimeError("cancelled", "render process was cancelled"), "render");
      }
      return this.#retryOrFail(job, runtimeError("spawn_failed", executionError.message), "render");
    }

    job = {
      ...job,
      processResult: processSnapshot(processResult),
      telemetry,
      currentAttempt: {
        ...(job.currentAttempt ?? {}),
        state: "process_complete",
        completedAtMs: this.clock()
      }
    };
    this.store.put(job);

    if (controller.signal.aborted || processResult.cancelled) {
      return this.#retryOrFail(job, runtimeError("cancelled", "render process was cancelled"), "render");
    }
    if (processResult.timedOut) {
      return this.#retryOrFail(job, runtimeError("process_timeout", "render process timed out", processSnapshot(processResult)), "render");
    }
    if (!processResult.ok) {
      return this.#retryOrFail(
        job,
        runtimeError("process_failed", `render process exited with code ${processResult.code}`, processSnapshot(processResult)),
        "render"
      );
    }

    job = transitionRuntimeJob(job, "probing", {
      reason: "render_complete",
      atMs: this.clock(),
      patch: {
        currentAttempt: {
          ...(job.currentAttempt ?? {}),
          state: "rendered"
        }
      }
    });
    return this.store.put(job);
  }

  async #executeProbing(job, controller) {
    if (job.cancellationRequested) return this.#cancelStage(job, "cancelled_before_probe");

    const requirements = job.scheduling.requirements.probe;
    let lease;
    try {
      lease = await this.resources.acquire(requirements, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || error?.code === "cancelled") {
        return this.#cancelStage(this.store.get(job.id), "cancelled_waiting_for_probe_resources");
      }
      throw error;
    }

    let telemetry = normalizedTelemetry(this.store.get(job.id).telemetry);
    telemetry.scheduler.resourceWaitMs += lease.waitMs;
    telemetry.sideEffects.probeInvocations += 1;
    const token = `${job.id}:probe:${telemetry.sideEffects.probeInvocations}`;
    job = {
      ...this.store.get(job.id),
      telemetry,
      scheduling: {
        ...job.scheduling,
        reservation: {
          token,
          stage: "probe",
          requirements,
          external: false,
          uncertain: false
        }
      }
    };
    this.store.put(job);

    const probeStarted = this.clock();
    let probe = null;
    let probeError = null;
    try {
      probe = await this.probe.inspect(job.tempOutputPath, { signal: controller.signal });
    } catch (error) {
      probeError = error;
    } finally {
      lease.release();
      this.#clearReservation(job.id, token);
    }

    job = this.store.get(job.id);
    telemetry = normalizedTelemetry(job.telemetry);
    telemetry.probeMs += phaseDuration(this.clock, probeStarted);
    job = { ...job, telemetry };
    this.store.put(job);

    if (probeError) {
      if (controller.signal.aborted) {
        return this.#retryOrFail(job, runtimeError("cancelled", "probe was cancelled"), "probing");
      }
      return this.#retryOrFail(job, runtimeError("probe_failed", `probe failed: ${probeError.message}`), "probing");
    }

    job = transitionRuntimeJob(job, "qa", {
      reason: "probe_complete",
      atMs: this.clock(),
      patch: { probe: clone(probe) }
    });
    return this.store.put(job);
  }

  async #executeQa(job, controller) {
    if (controller.signal.aborted || job.cancellationRequested) return this.#cancelStage(job, "cancelled_before_qa");

    const requirements = job.scheduling.requirements.qa;
    let lease;
    try {
      lease = await this.resources.acquire(requirements, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || error?.code === "cancelled") {
        return this.#cancelStage(this.store.get(job.id), "cancelled_waiting_for_qa_resources");
      }
      throw error;
    }

    let telemetry = normalizedTelemetry(this.store.get(job.id).telemetry);
    telemetry.scheduler.resourceWaitMs += lease.waitMs;
    telemetry.sideEffects.qaEvaluations += 1;
    const token = `${job.id}:qa:${telemetry.sideEffects.qaEvaluations}`;
    job = {
      ...this.store.get(job.id),
      telemetry,
      scheduling: {
        ...job.scheduling,
        reservation: {
          token,
          stage: "qa",
          requirements,
          external: false,
          uncertain: false
        }
      }
    };
    this.store.put(job);

    const qaStarted = this.clock();
    let qa;
    try {
      qa = evaluateRenderQa(job.timeline, job.probe);
    } finally {
      lease.release();
      this.#clearReservation(job.id, token);
    }

    job = this.store.get(job.id);
    telemetry = normalizedTelemetry(job.telemetry);
    telemetry.qaMs += phaseDuration(this.clock, qaStarted);
    job = { ...job, qa: clone(qa), telemetry };
    this.store.put(job);

    if (!qa.passed) {
      return this.#retryOrFail(job, runtimeError("qa_failed", "render QA failed", qa), "qa");
    }

    telemetry = normalizedTelemetry(job.telemetry);
    telemetry.sideEffects.finalizeInvocations += 1;
    job = { ...job, telemetry };
    this.store.put(job);

    try {
      atomicFinalize(job.tempOutputPath, job.resolvedOutputPath);
    } catch (error) {
      return this.#retryOrFail(this.store.get(job.id), error, "finalize");
    }

    const digest = await outputDigest(job.resolvedOutputPath);
    job = this.store.get(job.id);
    telemetry = normalizedTelemetry(job.telemetry);
    telemetry.outputSize = digest.size;
    telemetry.outputSha256 = digest.sha256;
    telemetry.sideEffects.successfulFinalizations += 1;
    job = transitionRuntimeJob(job, "succeeded", {
      reason: "qa_passed",
      atMs: this.clock(),
      patch: {
        failure: null,
        tempOutputPath: null,
        reconciliation: { required: false },
        telemetry,
        scheduling: {
          ...job.scheduling,
          reservation: null
        },
        currentAttempt: {
          ...(job.currentAttempt ?? {}),
          state: "finalized",
          finalizedAtMs: this.clock()
        }
      }
    });
    return this.store.put(job);
  }

  async #driveJob(jobId) {
    const controller = new AbortController();
    this.active.set(jobId, controller);
    try {
      for (let guard = 0; guard < 100; guard += 1) {
        let job = this.store.get(jobId);
        if (!job || isTerminalRenderStatus(job.status)) return job;
        if (job.reconciliation?.required) return job;
        job = this.#ensureScheduling(job);

        if (job.status === "retry_wait") {
          job = this.#advanceRetryWait(job);
          if (job.reconciliation?.required) return job;
          continue;
        }
        if (job.status === "queued") {
          const result = await this.#executeQueued(job, controller);
          if (result?.status === "retry_wait") return result;
          continue;
        }
        if (job.status === "probing") {
          const result = await this.#executeProbing(job, controller);
          if (result?.status === "retry_wait") return result;
          continue;
        }
        if (job.status === "qa") {
          const result = await this.#executeQa(job, controller);
          if (result?.status === "retry_wait") return result;
          continue;
        }
        if (job.status === "rendering") return job;
        return job;
      }
      throw runtimeError("state_loop_guard", `job ${jobId} exceeded runtime transition guard`);
    } finally {
      this.active.delete(jobId);
    }
  }

  runAcceptedJob(jobId) {
    const existing = this.inflightRuns.get(jobId);
    if (existing) return existing;
    const promise = this.#driveJob(jobId).finally(() => {
      if (this.inflightRuns.get(jobId) === promise) this.inflightRuns.delete(jobId);
    });
    this.inflightRuns.set(jobId, promise);
    return promise;
  }

  async drain() {
    const completed = [];
    for (;;) {
      const selected = this.#selectRunnable(this.maxConcurrency);
      if (selected.length === 0) break;
      const results = await Promise.all(selected.map((job) => this.runAcceptedJob(job.id)));
      completed.push(...results);
    }
    return completed;
  }

  getSchedulerDiagnostics() {
    return buildSchedulerDiagnostics({
      jobs: this.store.list(),
      queueLimit: this.queueLimit,
      resourceSnapshot: this.resources.snapshot(),
      schedulerState: this.store.getSchedulerState(),
      nowMs: this.clock()
    });
  }
}
