import {
  existsSync,
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
  MediaJobProtocolHarness,
  MediaJobProtocolV1,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  buildDeterministicSoakPlan,
  runDeterministicMediaSoak
} from "../src/index.js";

const reportUrl = new URL("../reports/ROUND2_WAVE5_MEDIA_SOAK.json", import.meta.url);

function tempRoot(prefix = "media-wave5-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tinyRequest(jobId) {
  return {
    contractVersion: "media.render.v1",
    jobId,
    timeline: {
      id: jobId,
      version: 1,
      canvas: { width: 64, height: 64, fps: 10, durationMs: 300 },
      tracks: []
    },
    exportSpec: {
      videoCodec: "libx264",
      audioCodec: "aac",
      videoBitrate: "250k",
      audioBitrate: "64k",
      pixelFormat: "yuv420p"
    },
    outputPath: `outputs/${jobId}.mp4`,
    dryRun: false
  };
}

function successfulProbe() {
  return {
    hasVideo: true,
    hasAudio: false,
    width: 64,
    height: 64,
    fps: 10,
    durationMs: 300,
    videoCodec: "h264",
    audioCodec: null,
    blackFrameRatio: 0.05
  };
}

test("Wave 5 seeded crash/concurrency soak matches deterministic report across fixed permutations", async () => {
  const report = JSON.parse(readFileSync(reportUrl, "utf8"));
  assert.equal(report.jobsPerSeed >= 100, true);
  assert.equal(report.totalLogicalJobRuns, report.jobsPerSeed * report.seeds.length);
  assert.equal(report.totalInjectedEvents, report.injectedEventsPerSeed * report.seeds.length);

  for (const seed of report.seeds) {
    const root = tempRoot(`media-wave5-${seed}-`);
    try {
      const summary = await runDeterministicMediaSoak({
        root,
        seed,
        jobCount: report.jobsPerSeed,
        workerSlots: report.resourceLimits.worker,
        renderSlots: report.resourceLimits.render,
        probeSlots: report.resourceLimits.probe
      });

      assert.equal(summary.seed, seed);
      assert.equal(summary.jobCount, report.jobsPerSeed);
      assert.equal(summary.injectedEventCount, report.injectedEventsPerSeed);
      assert.deepEqual(summary.scenarioCounts, report.scenarioCountsPerSeed);
      assert.deepEqual(summary.terminalCounts, report.expectedPerSeed.terminalCounts);
      assert.equal(summary.restartCount, report.expectedPerSeed.restartCount);
      assert.equal(
        summary.sideEffects.executorInvocationsPersisted,
        report.expectedPerSeed.sideEffects.executorInvocationsPersisted
      );
      assert.equal(
        summary.sideEffects.executorCallsObserved,
        report.expectedPerSeed.sideEffects.executorCallsObserved
      );
      assert.equal(
        summary.sideEffects.probeInvocationsPersisted,
        report.expectedPerSeed.sideEffects.probeInvocationsPersisted
      );
      assert.equal(
        summary.sideEffects.probeCallsObserved,
        report.expectedPerSeed.sideEffects.probeCallsObserved
      );
      assert.equal(
        summary.sideEffects.successfulFinalizations,
        report.expectedPerSeed.sideEffects.successfulFinalizations
      );
      assert.equal(summary.resources.maxWorkerActive <= report.resourceLimits.worker, true);
      assert.equal(summary.resources.maxRenderActive <= report.resourceLimits.render, true);
      assert.equal(summary.resources.maxProbeActive <= report.resourceLimits.probe, true);
      assert.equal(summary.transitionChecks > report.jobsPerSeed * 3, true);

      console.log("WAVE5_SOAK_SUMMARY", JSON.stringify(summary));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("fixed seeds produce deterministic but distinct property-style event orders", () => {
  const report = JSON.parse(readFileSync(reportUrl, "utf8"));
  const first = buildDeterministicSoakPlan({
    seed: report.seeds[0],
    jobCount: report.jobsPerSeed
  });
  const repeated = buildDeterministicSoakPlan({
    seed: report.seeds[0],
    jobCount: report.jobsPerSeed
  });
  const second = buildDeterministicSoakPlan({
    seed: report.seeds[1],
    jobCount: report.jobsPerSeed
  });

  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.order, second.order);
  assert.deepEqual(first.scenarioCounts, report.scenarioCountsPerSeed);
  assert.deepEqual(second.scenarioCounts, report.scenarioCountsPerSeed);
});

test("corrupt primary and torn orphan temp stores fail closed by default", () => {
  const root = tempRoot("media-wave5-corrupt-");
  try {
    const filePath = path.join(root, "jobs.json");
    writeFileSync(filePath, "{ torn primary", "utf8");

    assert.throws(
      () => new PersistentRenderJobStore({ filePath }),
      (error) => error.code === "state_corrupt" && /refusing implicit reset/.test(error.message)
    );
    assert.equal(existsSync(filePath), true);
    assert.equal(existsSync(`${filePath}.corrupt`), false);

    rmSync(filePath, { force: true });
    writeFileSync(`${filePath}.tmp`, "{ torn temp", "utf8");

    assert.throws(
      () => new PersistentRenderJobStore({ filePath }),
      (error) => error.code === "state_corrupt" && /temporary render job store/.test(error.message)
    );
    assert.equal(existsSync(`${filePath}.tmp`), true);
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent identical submits converge and concurrent resume_or_poll shares one render attempt", async () => {
  const root = tempRoot("media-wave5-concurrent-");
  try {
    const store = new PersistentRenderJobStore({ filePath: path.join(root, "jobs.json") });
    let executorCalls = 0;
    let startedResolve;
    let releaseResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const release = new Promise((resolve) => { releaseResolve = resolve; });

    const runtime = new RenderRuntimeV2({
      store,
      executor: {
        async run(command) {
          executorCalls += 1;
          startedResolve();
          await release;
          writeFileSync(command.args.at(-1), "concurrent-resume", "utf8");
          return {
            ok: true,
            code: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1
          };
        }
      },
      probe: { async inspect() { return successfulProbe(); } },
      sandboxRoot: root,
      liveExecutionEnabled: true,
      maxConcurrency: 4,
      resourceLimits: { render: 2, probe: 2 }
    });
    const harness = new MediaJobProtocolHarness(new MediaJobProtocolV1(runtime));
    const request = tinyRequest("concurrent-identical");
    const submit = {
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "creator:concurrent-identical",
      request
    };

    const submits = await Promise.all(
      Array.from({ length: 16 }, () => harness.exchange(submit))
    );
    assert.equal(submits.filter((item) => item.accepted && item.duplicate === false).length, 1);
    assert.equal(submits.filter((item) => item.accepted && item.duplicate === true).length, 15);
    assert.deepEqual(new Set(submits.map((item) => item.jobId)), new Set([request.jobId]));
    assert.equal(executorCalls, 0);

    const polls = Array.from({ length: 16 }, () => harness.exchange({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId: request.jobId
    }));
    await started;
    assert.equal(executorCalls, 1);
    releaseResolve();

    const results = await Promise.all(polls);
    assert.equal(results.every((item) => item.status === "succeeded"), true);
    assert.equal(results.every((item) => item.jobId === request.jobId), true);
    assert.equal(executorCalls, 1);
    assert.equal(results.at(-1).telemetry.sideEffects.executorInvocations, 1);
    assert.equal(results.at(-1).telemetry.sideEffects.successfulFinalizations, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
