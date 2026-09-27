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
  DeterministicProcessExecutor,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  RetryPolicy,
  buildRenderPlan,
  handleMediaRenderRequest,
  tempOutputPath
} from "../src/index.js";

const fixtureUrl = new URL("../fixtures/runtime-v2/full-pipeline.request.json", import.meta.url);
const probeUrl = new URL("../fixtures/runtime-v2/probe-success.json", import.meta.url);

function fixtureRequest() {
  return JSON.parse(readFileSync(fixtureUrl, "utf8"));
}

function probeSuccess() {
  return JSON.parse(readFileSync(probeUrl, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), "media-runtime-v2-"));
}

function makeStore(root, name = "jobs.json") {
  return new PersistentRenderJobStore({ filePath: path.join(root, name) });
}

function fakeSuccessfulExecutor({ onRun = null, content = "fake-render-output" } = {}) {
  return {
    async run(command) {
      onRun?.(command);
      writeFileSync(command.args.at(-1), content);
      return {
        ok: true,
        code: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdout: "render ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1
      };
    }
  };
}

test("runtime fixture preserves media.render.v1 fingerprint semantics and covers full pipeline operations", () => {
  const request = fixtureRequest();
  const direct = buildRenderPlan(request.timeline, request.exportSpec);
  const v1 = handleMediaRenderRequest(request);
  assert.equal(v1.renderFingerprint, direct.fingerprint);

  const reordered = clone(request);
  reordered.timeline.tracks.reverse();
  for (const track of reordered.timeline.tracks) track.items.reverse();
  assert.equal(buildRenderPlan(reordered.timeline, reordered.exportSpec).fingerprint, direct.fingerprint);

  const operationTypes = new Set(direct.operations.map((operation) => operation.type));
  for (const expected of [
    "clip.extract",
    "caption.render",
    "video.reframe",
    "audio.mix",
    "transition.apply",
    "overlay.compose"
  ]) {
    assert.equal(operationTypes.has(expected), true, `missing operation ${expected}`);
  }
});

test("hard dry-run gate succeeds without invoking executor or probe", async () => {
  const root = tempRoot();
  try {
    let executorCalls = 0;
    let probeCalls = 0;
    const runtime = new RenderRuntimeV2({
      store: makeStore(root),
      executor: { async run() { executorCalls += 1; throw new Error("must not run"); } },
      probe: { async inspect() { probeCalls += 1; throw new Error("must not probe"); } },
      sandboxRoot: root,
      liveExecutionEnabled: true
    });

    const submitted = runtime.submit(fixtureRequest(), { idempotencyKey: "dry-run-1" });
    assert.equal(submitted.job.status, "queued");
    await runtime.drain();

    const job = runtime.store.get("runtime-v2-full-pipeline");
    assert.equal(job.status, "succeeded");
    assert.equal(job.attempts, 0);
    assert.equal(executorCalls, 0);
    assert.equal(probeCalls, 0);
    assert.equal(existsSync(job.resolvedOutputPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live fake executor renders to temp, probes, QA-checks, atomically finalizes and records telemetry", async () => {
  const root = tempRoot();
  try {
    const request = fixtureRequest();
    request.dryRun = false;
    const seenOutputs = [];
    const runtime = new RenderRuntimeV2({
      store: makeStore(root),
      executor: fakeSuccessfulExecutor({ onRun: (command) => seenOutputs.push(command.args.at(-1)) }),
      probe: { async inspect() { return probeSuccess(); } },
      sandboxRoot: root,
      liveExecutionEnabled: true
    });

    runtime.submit(request);
    await runtime.drain();
    const job = runtime.store.get(request.jobId);

    assert.equal(job.status, "succeeded");
    assert.equal(job.attempts, 1);
    assert.equal(existsSync(job.resolvedOutputPath), true);
    assert.equal(seenOutputs.length, 1);
    assert.equal(seenOutputs[0], tempOutputPath(job.resolvedOutputPath, job.id));
    assert.equal(existsSync(seenOutputs[0]), false);
    assert.equal(job.telemetry.retries, 0);
    assert.equal(job.telemetry.outputSize > 0, true);
    assert.match(job.telemetry.outputSha256, /^[a-f0-9]{64}$/);
    for (const metric of ["planningMs", "queueWaitMs", "renderMs", "probeMs", "qaMs"]) {
      assert.equal(Number.isFinite(job.telemetry[metric]), true);
      assert.equal(job.telemetry[metric] >= 0, true);
    }
    assert.equal(JSON.stringify(job).includes("publish"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded worker and render-resource concurrency are enforced", async () => {
  const root = tempRoot();
  try {
    let active = 0;
    let maxActive = 0;
    const executor = {
      async run(command) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        writeFileSync(command.args.at(-1), "concurrent-render");
        active -= 1;
        return {
          ok: true, code: 0, signal: null, timedOut: false, cancelled: false,
          stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 25
        };
      }
    };
    const runtime = new RenderRuntimeV2({
      store: makeStore(root),
      executor,
      probe: { async inspect() { return probeSuccess(); } },
      sandboxRoot: root,
      liveExecutionEnabled: true,
      maxConcurrency: 2,
      resourceLimits: { render: 2, probe: 2 }
    });

    for (let index = 0; index < 3; index += 1) {
      const request = fixtureRequest();
      request.jobId = `concurrency-${index}`;
      request.outputPath = `outputs/concurrency-${index}.mp4`;
      request.dryRun = false;
      runtime.submit(request);
    }
    await runtime.drain();

    assert.equal(maxActive, 2);
    assert.deepEqual(
      runtime.store.list().map((job) => job.status).sort(),
      ["succeeded", "succeeded", "succeeded"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout/process failures retry within bounds and preserve retry_wait history", async () => {
  const root = tempRoot();
  try {
    let calls = 0;
    const executor = {
      async run(command) {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false, code: null, signal: "SIGTERM", timedOut: true, cancelled: false,
            stdout: "", stderr: "timeout", stdoutTruncated: false, stderrTruncated: false, durationMs: 10
          };
        }
        writeFileSync(command.args.at(-1), "retry-success");
        return {
          ok: true, code: 0, signal: null, timedOut: false, cancelled: false,
          stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1
        };
      }
    };
    const runtime = new RenderRuntimeV2({
      store: makeStore(root),
      executor,
      probe: { async inspect() { return probeSuccess(); } },
      sandboxRoot: root,
      liveExecutionEnabled: true,
      retryPolicy: new RetryPolicy({ maxAttempts: 2 })
    });
    const request = fixtureRequest();
    request.jobId = "retry-job";
    request.outputPath = "outputs/retry.mp4";
    request.dryRun = false;

    runtime.submit(request);
    await runtime.drain();
    const job = runtime.store.get(request.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.attempts, 2);
    assert.equal(job.telemetry.retries, 1);
    assert.equal(job.history.some((entry) => entry.to === "retry_wait" && entry.reason === "process_timeout"), true);
    assert.equal(calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probe failures retry while QA failures are classified and fail closed by default", async () => {
  const root = tempRoot();
  try {
    let probeCalls = 0;
    const probe = {
      async inspect() {
        probeCalls += 1;
        if (probeCalls === 1) throw new Error("transient ffprobe failure");
        return probeSuccess();
      }
    };
    const runtime = new RenderRuntimeV2({
      store: makeStore(root, "probe.json"),
      executor: fakeSuccessfulExecutor(),
      probe,
      sandboxRoot: root,
      liveExecutionEnabled: true,
      retryPolicy: new RetryPolicy({ maxAttempts: 2 })
    });
    const request = fixtureRequest();
    request.jobId = "probe-retry";
    request.outputPath = "outputs/probe-retry.mp4";
    request.dryRun = false;
    runtime.submit(request);
    await runtime.drain();

    const retried = runtime.store.get(request.jobId);
    assert.equal(retried.status, "succeeded");
    assert.equal(retried.attempts, 2);
    assert.equal(retried.telemetry.retries, 1);

    const badRuntime = new RenderRuntimeV2({
      store: makeStore(root, "qa.json"),
      executor: fakeSuccessfulExecutor(),
      probe: { async inspect() { return { ...probeSuccess(), width: 999 }; } },
      sandboxRoot: root,
      liveExecutionEnabled: true,
      retryPolicy: new RetryPolicy({ maxAttempts: 3 })
    });
    const bad = fixtureRequest();
    bad.jobId = "qa-fail";
    bad.outputPath = "outputs/qa-fail.mp4";
    bad.dryRun = false;
    badRuntime.submit(bad);
    await badRuntime.drain();

    const failed = badRuntime.store.get(bad.jobId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure.code, "qa_failed");
    assert.equal(failed.failure.category, "qa");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.telemetry.retries, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery requeues planned jobs and moves interrupted jobs through retry_wait", () => {
  const root = tempRoot();
  try {
    const store = makeStore(root);
    const base = {
      schemaVersion: 2,
      dryRun: false,
      timeline: fixtureRequest().timeline,
      exportSpec: {},
      outputPath: "outputs/recover.mp4",
      resolvedOutputPath: path.join(root, "outputs", "recover.mp4"),
      renderFingerprint: "f".repeat(64),
      attempts: 1,
      maxAttempts: 3,
      cancellationRequested: false,
      processResult: null,
      probe: null,
      qa: null,
      failure: null,
      createdAtMs: 1,
      queuedAtMs: 1,
      history: [],
      telemetry: {
        planningMs: 0, queueWaitMs: 0, renderMs: 0, probeMs: 0, qaMs: 0,
        retries: 0, outputSize: null, outputSha256: null
      }
    };
    store.create({ ...clone(base), id: "interrupted", status: "rendering" });
    store.create({ ...clone(base), id: "planned", status: "planned", attempts: 0 });

    const runtime = new RenderRuntimeV2({
      store,
      executor: fakeSuccessfulExecutor(),
      probe: { async inspect() { return probeSuccess(); } },
      sandboxRoot: root,
      liveExecutionEnabled: true,
      retryPolicy: new RetryPolicy({ maxAttempts: 3 })
    });
    runtime.recoverInterruptedJobs();

    const interrupted = store.get("interrupted");
    const planned = store.get("planned");
    assert.equal(interrupted.status, "retry_wait");
    assert.equal(interrupted.failure.code, "interrupted_restart");
    assert.equal(interrupted.telemetry.retries, 1);
    assert.equal(planned.status, "queued");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent store recovers corrupt root state and quarantines invalid job status", () => {
  const root = tempRoot();
  try {
    const filePath = path.join(root, "jobs.json");
    writeFileSync(filePath, "{ definitely not json", "utf8");
    const recovered = new PersistentRenderJobStore({ filePath, recoverCorrupt: true });
    assert.equal(recovered.list().length, 0);
    assert.equal(recovered.recoveryEvents().some((entry) => entry.type === "store_reset_corrupt"), true);
    assert.equal(existsSync(`${filePath}.corrupt`), true);

    writeFileSync(filePath, JSON.stringify({
      version: 2,
      jobs: {
        bad: { id: "bad", status: "teleported", history: [] }
      },
      idempotency: { stale: "missing" },
      recoveryEvents: []
    }), "utf8");
    const sanitized = new PersistentRenderJobStore({ filePath });
    assert.equal(sanitized.get("bad").status, "failed");
    assert.equal(sanitized.get("bad").failure.code, "state_corrupt");
    assert.equal(sanitized.findByIdempotencyKey("stale"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate jobs and idempotency keys are deterministic", () => {
  const root = tempRoot();
  try {
    const runtime = new RenderRuntimeV2({
      store: makeStore(root),
      executor: fakeSuccessfulExecutor(),
      probe: { async inspect() { return probeSuccess(); } },
      sandboxRoot: root
    });
    const first = fixtureRequest();
    const a = runtime.submit(first, { idempotencyKey: "idem-1" });
    const b = runtime.submit(clone(first), { idempotencyKey: "idem-1" });
    const c = runtime.submit(clone(first));

    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(c.duplicate, true);
    assert.equal(b.job.id, first.jobId);
    assert.equal(c.job.id, first.jobId);

    const conflict = fixtureRequest();
    conflict.jobId = "different-job";
    conflict.outputPath = "outputs/different.mp4";
    assert.throws(
      () => runtime.submit(conflict, { idempotencyKey: "idem-1" }),
      /idempotency key is already bound to different render work/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime sandbox rejects protected and escaping paths before executor use", () => {
  const root = tempRoot();
  try {
    let calls = 0;
    const runtime = new RenderRuntimeV2({
      store: makeStore(root),
      executor: { async run() { calls += 1; } },
      probe: { async inspect() { throw new Error("must not probe"); } },
      sandboxRoot: root,
      liveExecutionEnabled: true
    });

    const protectedOutput = fixtureRequest();
    protectedOutput.outputPath = "E:\\manhwa\\render.mp4";
    assert.throws(() => runtime.submit(protectedOutput), /protected/i);

    const protectedSource = fixtureRequest();
    protectedSource.timeline.tracks[1].items[0].source.uri = "file:///E:/manhwa/audio.wav";
    assert.throws(() => runtime.submit(protectedSource), /protected/i);

    const escape = fixtureRequest();
    escape.outputPath = "../escape.mp4";
    assert.throws(() => runtime.submit(escape), /escapes the runtime sandbox/);
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live execution is disabled unless explicitly enabled", () => {
  const root = tempRoot();
  try {
    const runtime = new RenderRuntimeV2({
      store: makeStore(root),
      executor: fakeSuccessfulExecutor(),
      probe: { async inspect() { return probeSuccess(); } },
      sandboxRoot: root
    });
    const request = fixtureRequest();
    request.dryRun = false;
    assert.throws(() => runtime.submit(request), /live rendering is disabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DeterministicProcessExecutor captures bounded output and timeout/cancellation results", async () => {
  const executor = new DeterministicProcessExecutor({ defaultTimeoutMs: 2000, maxOutputBytes: 64 });

  const captured = await executor.run({
    binary: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(4096))"]
  });
  assert.equal(captured.ok, true);
  assert.equal(Buffer.byteLength(captured.stdout) <= 64, true);
  assert.equal(captured.stdoutTruncated, true);

  const timeout = await executor.run({
    binary: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"]
  }, { timeoutMs: 40 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timedOut, true);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const cancelled = await executor.run({
    binary: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"]
  }, { timeoutMs: 2000, signal: controller.signal });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);
});
