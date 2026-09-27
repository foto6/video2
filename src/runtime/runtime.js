import { compileFfmpegCommand } from "../ffmpeg.js";
import { buildRenderPlan } from "../plan.js";
import { evaluateRenderQa } from "../qa.js";
import { canonicalizeTimeline } from "../timeline.js";
import {
  atomicFinalize,
  cleanupTempOutput,
  outputDigest,
  prepareTempOutput,
  tempOutputPath
} from "./atomic-output.js";
import { RenderRuntimeError, runtimeError } from "./errors.js";
import { isTerminalRenderStatus, transitionRuntimeJob } from "./lifecycle.js";
import { validateRuntimePaths } from "./path-policy.js";
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
  if (request.exportSpec !== undefined && (request.exportSpec === null || typeof request.exportSpec !== "object" || Array.isArray(request.exportSpec))) {
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
    clock = () => Date.now()
  } = {}) {
    if (!store) throw new TypeError("store is required");
    if (!executor || typeof executor.run !== "function") throw new TypeError("executor.run is required");
    if (!probe || typeof probe.inspect !== "function") throw new TypeError("probe.inspect is required");
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new TypeError("maxConcurrency must be positive");

    this.store = store;
    this.executor = executor;
    this.probe = probe;
    this.sandboxRoot = sandboxRoot;
    this.liveExecutionEnabled = liveExecutionEnabled;
    this.maxConcurrency = maxConcurrency;
    this.resources = new ResourceController(resourceLimits);
    this.retryPolicy = retryPolicy;
    this.processTimeoutMs = processTimeoutMs;
    this.clock = clock;
    this.active = new Map();
  }

  submit(request, { idempotencyKey = null } = {}) {
    if (idempotencyKey) {
      const existing = this.store.findByIdempotencyKey(idempotencyKey);
      if (existing) return { job: existing, duplicate: true };
    }

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
    const plannedAtMs = this.clock();

    let job = {
      schemaVersion: 2,
      id: request.jobId,
      status: "planned",
      dryRun: request.dryRun,
      timeline,
      exportSpec,
      outputPath: request.outputPath,
      resolvedOutputPath: paths.outputPath,
      renderFingerprint: plan.fingerprint,
      attempts: 0,
      maxAttempts: this.retryPolicy.maxAttempts,
      cancellationRequested: false,
      processResult: null,
      probe: null,
      qa: null,
      failure: null,
      createdAtMs: planningStarted,
      queuedAtMs: null,
      history: [{ from: null, to: "planned", reason: "submit", atMs: plannedAtMs }],
      telemetry: {
        planningMs: Math.max(0, plannedAtMs - planningStarted),
        queueWaitMs: 0,
        renderMs: 0,
        probeMs: 0,
        qaMs: 0,
        retries: 0,
        outputSize: null,
        outputSha256: null
      }
    };

    const created = this.store.create(job, { idempotencyKey });
    if (created.duplicate) return created;

    job = transitionRuntimeJob(job, "queued", {
      reason: "planned",
      atMs: this.clock(),
      patch: { queuedAtMs: this.clock() }
    });
    this.store.put(job);
    return { job, duplicate: false };
  }

  cancel(jobId, reason = "cancelled_by_request") {
    let job = this.store.get(jobId);
    if (!job) throw runtimeError("job_not_found", `unknown job: ${jobId}`);
    if (isTerminalRenderStatus(job.status)) return job;

    if (job.status === "planned" || job.status === "queued" || job.status === "retry_wait") {
      job = transitionRuntimeJob(job, "cancelled", {
        reason,
        atMs: this.clock(),
        patch: { cancellationRequested: true }
      });
      return this.store.put(job);
    }

    job = { ...job, cancellationRequested: true };
    this.store.put(job);
    this.active.get(jobId)?.abort(reason);
    return this.store.get(jobId);
  }

  recoverInterruptedJobs() {
    const recovered = [];
    for (let job of this.store.list()) {
      if (isTerminalRenderStatus(job.status)) continue;

      if (job.cancellationRequested) {
        job = transitionRuntimeJob(job, "cancelled", {
          reason: "restart_cancelled",
          atMs: this.clock()
        });
        recovered.push(this.store.put(job));
        continue;
      }

      if (job.resolvedOutputPath) {
        cleanupTempOutput(tempOutputPath(job.resolvedOutputPath, job.id));
      }

      if (job.status === "planned") {
        job = transitionRuntimeJob(job, "queued", {
          reason: "restart_requeue_planned",
          atMs: this.clock(),
          patch: { queuedAtMs: this.clock() }
        });
        recovered.push(this.store.put(job));
        continue;
      }

      if (job.status === "rendering" || job.status === "probing" || job.status === "qa") {
        if ((job.attempts ?? 0) < (job.maxAttempts ?? this.retryPolicy.maxAttempts)) {
          job = transitionRuntimeJob(job, "retry_wait", {
            reason: "restart_interrupted",
            atMs: this.clock(),
            patch: {
              failure: {
                code: "interrupted_restart",
                category: "recovery",
                message: "job was interrupted by runtime restart",
                retryable: true,
                details: null
              },
              telemetry: {
                ...job.telemetry,
                retries: (job.telemetry?.retries ?? 0) + 1
              }
            }
          });
        } else {
          job = transitionRuntimeJob(job, "failed", {
            reason: "restart_attempts_exhausted",
            atMs: this.clock(),
            patch: {
              failure: {
                code: "interrupted_restart",
                category: "recovery",
                message: "interrupted job exhausted retry attempts",
                retryable: false,
                details: null
              }
            }
          });
        }
        recovered.push(this.store.put(job));
      }
    }
    return recovered;
  }

  async #runJob(jobId) {
    let job = this.store.get(jobId);
    if (!job || isTerminalRenderStatus(job.status)) return job;

    if (job.status === "retry_wait") {
      job = transitionRuntimeJob(job, "queued", {
        reason: "retry_ready",
        atMs: this.clock(),
        patch: { queuedAtMs: this.clock() }
      });
      this.store.put(job);
    }
    if (job.status !== "queued") return job;

    if (job.cancellationRequested) return this.cancel(jobId, "cancelled_before_start");

    const queueWaitMs = Math.max(0, this.clock() - (job.queuedAtMs ?? this.clock()));

    if (job.dryRun) {
      job = transitionRuntimeJob(job, "succeeded", {
        reason: "dry_run_plan_only",
        atMs: this.clock(),
        patch: {
          telemetry: { ...job.telemetry, queueWaitMs: job.telemetry.queueWaitMs + queueWaitMs }
        }
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

    const controller = new AbortController();
    this.active.set(jobId, controller);
    const tempPath = prepareTempOutput(job.resolvedOutputPath, job.id);

    try {
      job = transitionRuntimeJob(job, "rendering", {
        reason: "worker_start",
        atMs: this.clock(),
        patch: {
          attempts: (job.attempts ?? 0) + 1,
          telemetry: { ...job.telemetry, queueWaitMs: job.telemetry.queueWaitMs + queueWaitMs }
        }
      });
      this.store.put(job);

      const command = compileFfmpegCommand(job.timeline, job.exportSpec, tempPath);
      const renderStarted = this.clock();
      const processResult = await this.resources.withResource("render", controller.signal, () =>
        this.executor.run(command, { signal: controller.signal, timeoutMs: this.processTimeoutMs })
      );
      job = this.store.get(jobId);
      job = {
        ...job,
        processResult: processSnapshot(processResult),
        telemetry: { ...job.telemetry, renderMs: job.telemetry.renderMs + phaseDuration(this.clock, renderStarted) }
      };
      this.store.put(job);

      if (controller.signal.aborted || processResult.cancelled) {
        throw runtimeError("cancelled", "render process was cancelled");
      }
      if (processResult.timedOut) {
        throw runtimeError("process_timeout", "render process timed out", processSnapshot(processResult));
      }
      if (!processResult.ok) {
        throw runtimeError("process_failed", `render process exited with code ${processResult.code}`, processSnapshot(processResult));
      }

      job = transitionRuntimeJob(job, "probing", { reason: "render_complete", atMs: this.clock() });
      this.store.put(job);

      const probeStarted = this.clock();
      let probe;
      try {
        probe = await this.resources.withResource("probe", controller.signal, () =>
          this.probe.inspect(tempPath, { signal: controller.signal })
        );
      } catch (error) {
        if (controller.signal.aborted) throw runtimeError("cancelled", "probe was cancelled");
        throw runtimeError("probe_failed", `probe failed: ${error.message}`);
      }

      job = this.store.get(jobId);
      job = transitionRuntimeJob(job, "qa", {
        reason: "probe_complete",
        atMs: this.clock(),
        patch: {
          probe: clone(probe),
          telemetry: { ...job.telemetry, probeMs: job.telemetry.probeMs + phaseDuration(this.clock, probeStarted) }
        }
      });
      this.store.put(job);

      if (controller.signal.aborted) throw runtimeError("cancelled", "render job was cancelled");

      const qaStarted = this.clock();
      const qa = evaluateRenderQa(job.timeline, probe);
      job = this.store.get(jobId);
      job = {
        ...job,
        qa: clone(qa),
        telemetry: { ...job.telemetry, qaMs: job.telemetry.qaMs + phaseDuration(this.clock, qaStarted) }
      };
      this.store.put(job);
      if (!qa.passed) throw runtimeError("qa_failed", "render QA failed", qa);

      atomicFinalize(tempPath, job.resolvedOutputPath);
      const digest = await outputDigest(job.resolvedOutputPath);
      job = this.store.get(jobId);
      job = transitionRuntimeJob(job, "succeeded", {
        reason: "qa_passed",
        atMs: this.clock(),
        patch: {
          failure: null,
          telemetry: {
            ...job.telemetry,
            outputSize: digest.size,
            outputSha256: digest.sha256
          }
        }
      });
      return this.store.put(job);
    } catch (error) {
      cleanupTempOutput(tempPath);
      job = this.store.get(jobId);
      if (!job || isTerminalRenderStatus(job.status)) return job;

      const decision = this.retryPolicy.decide(error, job.attempts ?? 0);
      if (decision.code === "cancelled" || job.cancellationRequested) {
        job = transitionRuntimeJob(job, "cancelled", {
          reason: decision.code,
          atMs: this.clock(),
          patch: { failure: withFailure(error, decision), cancellationRequested: true }
        });
      } else if (decision.retry) {
        job = transitionRuntimeJob(job, "retry_wait", {
          reason: decision.code,
          atMs: this.clock(),
          patch: {
            failure: withFailure(error, decision),
            telemetry: { ...job.telemetry, retries: job.telemetry.retries + 1 }
          }
        });
      } else {
        job = transitionRuntimeJob(job, "failed", {
          reason: decision.code,
          atMs: this.clock(),
          patch: { failure: withFailure(error, decision) }
        });
      }
      return this.store.put(job);
    } finally {
      this.active.delete(jobId);
    }
  }

  async drain() {
    const completed = [];
    for (;;) {
      const runnable = this.store.list()
        .filter((job) => job.status === "queued" || job.status === "retry_wait")
        .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0) || a.id.localeCompare(b.id));

      if (runnable.length === 0) break;
      const batch = runnable.slice(0, this.maxConcurrency);
      const results = await Promise.all(batch.map((job) => this.#runJob(job.id)));
      completed.push(...results);
    }
    return completed;
  }
}
