import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_JOB_CONTRACT_VERSION,
  MEDIA_SCHEDULER_DIAGNOSTICS_VERSION,
  MediaJobProtocolHarness,
  MediaJobProtocolV1,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  runResourceSchedulerSoak
} from "../src/index.js";

const reportUrl = new URL("../reports/WAVE6_RESOURCE_SCHEDULER.json", import.meta.url);

function tempRoot(prefix = "media-wave6-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function request(jobId, {
  runtimeProfile = "standard",
  durationMs = 300,
  dryRun = false,
  extraExport = {}
} = {}) {
  return {
    contractVersion: "media.render.v1",
    jobId,
    timeline: {
      id: jobId,
      version: 1,
      canvas: { width: 64, height: 64, fps: 10, durationMs },
      tracks: []
    },
    exportSpec: {
      videoCodec: "libx264",
      audioCodec: "aac",
      videoBitrate: "250k",
      audioBitrate: "64k",
      pixelFormat: "yuv420p",
      runtimeProfile,
      ...extraExport
    },
    outputPath: `outputs/${jobId}.mp4`,
    dryRun
  };
}

function goodProbe(durationMs = 300) {
  return {
    hasVideo: true,
    hasAudio: false,
    width: 64,
    height: 64,
    fps: 10,
    durationMs,
    videoCodec: "h264",
    audioCodec: null,
    blackFrameRatio: 0.01
  };
}

test("Wave 6 mixed scheduler soak proves fairness, restart ordering, backpressure resources and side-effect uniqueness", async () => {
  const report = JSON.parse(readFileSync(reportUrl, "utf8"));
  const root = tempRoot("media-wave6-soak-");
  try {
    const summary = await runResourceSchedulerSoak({
      root,
      seed: report.seed,
      jobCount: report.jobCount,
      maxConcurrency: report.maxConcurrency,
      resourceLimits: report.resourceBudgets
    });

    assert.equal(summary.seed, report.seed);
    assert.equal(summary.jobCount, report.jobCount);
    assert.equal(summary.jobCount >= 500, true);
    assert.equal(summary.longJobs, report.expectedWorkload.longJobs);
    assert.equal(summary.shortJobs, report.expectedWorkload.shortJobs);
    assert.equal(summary.dryRuns, report.expectedWorkload.dryRuns);
    assert.equal(summary.duplicateSubmits, report.expectedWorkload.duplicateSubmitDeliveries);
    assert.equal(summary.cancelledQueued, report.expectedWorkload.cancelledQueued);
    assert.equal(summary.uncertainRestartJobs, report.expectedWorkload.uncertainRestartJobs);
    assert.deepEqual(summary.profileCounts, report.expectedWorkload.profileCounts);
    assert.deepEqual(summary.priorityCounts, report.expectedWorkload.priorityCounts);
    assert.deepEqual(summary.terminalCounts, report.expectedResults.terminalCounts);
    assert.equal(summary.sideEffects.executorCallsObserved, report.expectedResults.executorCallsObserved);
    assert.equal(summary.sideEffects.executorInvocationsPersisted, report.expectedResults.executorInvocationsPersisted);
    assert.equal(summary.sideEffects.probeCallsObserved, report.expectedResults.probeCallsObserved);
    assert.equal(summary.fairness.lowPriorityJobsDispatched, report.expectedResults.lowPriorityJobsDispatched);
    assert.equal(summary.fairness.finalDispatchSequence, report.expectedResults.finalDispatchSequence);
    assert.equal(summary.fairness.starvationTelemetryCount > 0, true);
    assert.equal(summary.resources.maxUsed.cpu <= report.resourceBudgets.cpu, true);
    assert.equal(summary.resources.maxUsed.gpu <= report.resourceBudgets.gpu, true);
    assert.equal(summary.resources.maxUsed.render <= report.resourceBudgets.render, true);
    assert.equal(summary.resources.maxUsed.probe <= report.resourceBudgets.probe, true);
    assert.equal(summary.resources.maxUsed.qa <= report.resourceBudgets.qa, true);
    assert.equal(summary.throughput.terminalJobs, report.jobCount);
    assert.equal(summary.throughput.jobsPerSecond > 0, true);
    assert.equal(summary.waits.maxQueueAgeMs >= 0, true);
    assert.equal(summary.waits.maxResourceWaitMs >= 0, true);

    const diagnosticsWire = JSON.stringify({
      waits: summary.waits,
      throughput: summary.throughput,
      resources: summary.resources,
      fairness: summary.fairness
    });
    assert.doesNotMatch(diagnosticsWire, /jobId|outputPath|idempotencyKey|publish/i);

    console.log("WAVE6_SCHEDULER_SUMMARY", JSON.stringify(summary));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queue saturation fails safe while identical duplicate submit remains accepted and side-effect free", async () => {
  const root = tempRoot("media-wave6-backpressure-");
  try {
    let executorCalls = 0;
    const runtime = new RenderRuntimeV2({
      store: new PersistentRenderJobStore({ filePath: path.join(root, "jobs.json") }),
      executor: { async run() { executorCalls += 1; throw new Error("must not execute"); } },
      probe: { async inspect() { throw new Error("must not probe"); } },
      sandboxRoot: root,
      liveExecutionEnabled: true,
      queueLimit: 2
    });
    const protocol = new MediaJobProtocolV1(runtime);
    const first = request("backpressure-1", { dryRun: true });
    const second = request("backpressure-2", { dryRun: true });
    const third = request("backpressure-3", { dryRun: true });

    const a = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "backpressure:1",
      request: first
    });
    await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "backpressure:2",
      request: second
    });
    const duplicate = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "backpressure:1",
      request: first
    });

    assert.equal(a.status, "queued");
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.jobId, a.jobId);
    assert.equal(executorCalls, 0);

    assert.throws(
      () => runtime.submit(third, { idempotencyKey: "backpressure:3" }),
      (error) => error.code === "queue_saturated"
    );

    runtime.cancel(second.jobId, "free_queue_capacity");
    const acceptedAfterCancel = runtime.submit(third, { idempotencyKey: "backpressure:3" });
    assert.equal(acceptedAfterCancel.job.status, "queued");
    assert.equal(executorCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource profile derives bounded requirements and never trusts arbitrary client slot numbers", () => {
  const root = tempRoot("media-wave6-profile-");
  try {
    const runtime = new RenderRuntimeV2({
      store: new PersistentRenderJobStore({ filePath: path.join(root, "jobs.json") }),
      executor: { async run() { throw new Error("unused"); } },
      probe: { async inspect() { throw new Error("unused"); } },
      sandboxRoot: root,
      liveExecutionEnabled: true,
      resourceLimits: { cpu: 2, gpu: 0, render: 1, probe: 1, qa: 1 }
    });

    const malicious = request("bounded-client-numbers", {
      extraExport: {
        resourceRequirements: {
          cpu: 999999,
          gpu: 999999,
          render: 999999,
          probe: 999999,
          qa: 999999
        }
      }
    });
    const accepted = runtime.submit(malicious, { idempotencyKey: "bounded-client-numbers" });
    assert.equal(accepted.job.scheduling.requirements.render.cpu, 1);
    assert.equal(accepted.job.scheduling.requirements.render.gpu, 0);
    assert.equal(accepted.job.scheduling.requirements.render.render, 1);

    assert.throws(
      () => runtime.submit(request("invalid-profile", { runtimeProfile: "priority-999" }), {
        idempotencyKey: "invalid-profile"
      }),
      (error) => error.code === "invalid_request"
    );

    assert.throws(
      () => runtime.submit(request("gpu-without-budget", { runtimeProfile: "gpu" }), {
        idempotencyKey: "gpu-without-budget"
      }),
      (error) => error.code === "resource_profile_unavailable"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queued, running and retry_wait cancellation release scheduler resources exactly once", async () => {
  const root = tempRoot("media-wave6-cancel-");
  try {
    let runningStarted;
    const runningStartedPromise = new Promise((resolve) => { runningStarted = resolve; });
    let attempts = 0;

    const runtime = new RenderRuntimeV2({
      store: new PersistentRenderJobStore({ filePath: path.join(root, "jobs.json") }),
      executor: {
        async run(command, { signal }) {
          attempts += 1;
          const jobId = path.basename(command.args.at(-1)).includes("running-cancel")
            ? "running-cancel"
            : "retry-cancel";
          if (jobId === "running-cancel") {
            runningStarted();
            await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
            return {
              ok: false, code: null, signal: "SIGTERM", timedOut: false, cancelled: true,
              stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1
            };
          }
          return {
            ok: false, code: null, signal: "SIGTERM", timedOut: true, cancelled: false,
            stdout: "", stderr: "timeout", stdoutTruncated: false, stderrTruncated: false, durationMs: 1
          };
        }
      },
      probe: { async inspect() { return goodProbe(); } },
      sandboxRoot: root,
      liveExecutionEnabled: true,
      maxConcurrency: 2,
      resourceLimits: { cpu: 2, gpu: 0, render: 1, probe: 1, qa: 1 }
    });

    const queued = runtime.submit(request("queued-cancel"), { idempotencyKey: "queued-cancel" }).job;
    runtime.cancel(queued.id, "queued_cancel");
    assert.equal(runtime.store.get(queued.id).status, "cancelled");
    assert.deepEqual(runtime.getSchedulerDiagnostics().resources.used, {
      cpu: 0, gpu: 0, render: 0, probe: 0, qa: 0
    });

    const running = runtime.submit(request("running-cancel"), { idempotencyKey: "running-cancel" }).job;
    const runningPromise = runtime.runAcceptedJob(running.id);
    await runningStartedPromise;
    runtime.cancel(running.id, "running_cancel");
    runtime.cancel(running.id, "running_cancel_duplicate");
    const runningResult = await runningPromise;
    assert.equal(runningResult.status, "cancelled");
    assert.deepEqual(runtime.getSchedulerDiagnostics().resources.used, {
      cpu: 0, gpu: 0, render: 0, probe: 0, qa: 0
    });

    const retry = runtime.submit(request("retry-cancel"), { idempotencyKey: "retry-cancel" }).job;
    const retryWait = await runtime.runAcceptedJob(retry.id);
    assert.equal(retryWait.status, "retry_wait");
    assert.deepEqual(runtime.getSchedulerDiagnostics().resources.used, {
      cpu: 0, gpu: 0, render: 0, probe: 0, qa: 0
    });
    const cancelled = runtime.cancel(retry.id, "retry_wait_cancel");
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(runtime.getSchedulerDiagnostics().resources.used, {
      cpu: 0, gpu: 0, render: 0, probe: 0, qa: 0
    });
    assert.equal(attempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduler diagnostics are versioned aggregate-only telemetry", async () => {
  const root = tempRoot("media-wave6-diagnostics-");
  try {
    const runtime = new RenderRuntimeV2({
      store: new PersistentRenderJobStore({ filePath: path.join(root, "jobs.json") }),
      executor: {
        async run(command) {
          writeFileSync(command.args.at(-1), "diagnostics", "utf8");
          return {
            ok: true, code: 0, signal: null, timedOut: false, cancelled: false,
            stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1
          };
        }
      },
      probe: { async inspect() { return goodProbe(); } },
      sandboxRoot: root,
      liveExecutionEnabled: true
    });
    runtime.submit(request("diagnostics-job"), { idempotencyKey: "diagnostics-job" });
    const queued = runtime.getSchedulerDiagnostics();
    assert.equal(queued.contractVersion, MEDIA_SCHEDULER_DIAGNOSTICS_VERSION);
    assert.equal(queued.queue.depth, 1);
    await runtime.drain();
    const done = runtime.getSchedulerDiagnostics();
    assert.equal(done.queue.depth, 0);
    assert.equal(done.throughput.terminalJobs, 1);
    assert.equal(done.resources.used.render, 0);
    assert.doesNotMatch(JSON.stringify(done), /diagnostics-job|outputPath|idempotencyKey|publish/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
