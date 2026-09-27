import {
  existsSync,
  mkdirSync,
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
  MediaJobProtocolV1,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  RetryPolicy,
  buildRenderPlan,
  tempOutputPath
} from "../src/index.js";

const consumerFixtureUrl = new URL("../fixtures/creator-media/media.job.v1.consumer.json", import.meta.url);
const runtimeFixtureUrl = new URL("../fixtures/runtime-v2/full-pipeline.request.json", import.meta.url);
const probeFixtureUrl = new URL("../fixtures/runtime-v2/probe-success.json", import.meta.url);

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function root() {
  return mkdtempSync(path.join(os.tmpdir(), "creator-media-protocol-"));
}

function store(dir, name = "jobs.json") {
  return new PersistentRenderJobStore({ filePath: path.join(dir, name) });
}

function goodProbe() {
  return readJson(probeFixtureUrl);
}

function liveRequest(jobId, outputPath) {
  const request = readJson(runtimeFixtureUrl);
  request.jobId = jobId;
  request.outputPath = outputPath;
  request.dryRun = false;
  return request;
}

function successfulExecutor(counter, content = "rendered") {
  return {
    async run(command) {
      counter.count += 1;
      writeFileSync(command.args.at(-1), content);
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
  };
}

test("consumer fixture uses stable media.job.v1 submit and poll contract", async () => {
  const dir = root();
  try {
    const fixture = readJson(consumerFixtureUrl);
    let executorCalls = 0;
    const runtime = new RenderRuntimeV2({
      store: store(dir),
      executor: { async run() { executorCalls += 1; throw new Error("dry run must not execute"); } },
      probe: { async inspect() { throw new Error("dry run must not probe"); } },
      sandboxRoot: dir,
      liveExecutionEnabled: true
    });
    const protocol = new MediaJobProtocolV1(runtime);

    const first = await protocol.handle(fixture.submit);
    const duplicate = await protocol.handle(clone(fixture.submit));
    const directFingerprint = buildRenderPlan(
      fixture.submit.request.timeline,
      fixture.submit.request.exportSpec
    ).fingerprint;

    assert.equal(first.contractVersion, MEDIA_JOB_CONTRACT_VERSION);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(first.jobId, fixture.submit.request.jobId);
    assert.equal(duplicate.jobId, first.jobId);
    assert.equal(first.renderFingerprint, directFingerprint);
    assert.equal(duplicate.renderFingerprint, directFingerprint);
    assert.equal(duplicate.telemetry.protocol.submitCount, 2);
    assert.equal(duplicate.telemetry.protocol.duplicateSubmits, 1);

    const completed = await protocol.handle(fixture.poll);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.retryOwner, "media");
    assert.equal(completed.finalArtifact, null);
    assert.equal(completed.telemetry.sideEffects.executorInvocations, 0);
    assert.equal(executorCalls, 0);
    assert.doesNotMatch(JSON.stringify(completed), /publish/i);
    assert.doesNotMatch(JSON.stringify(completed), /partial/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conflicting duplicate idempotency keys fail closed", async () => {
  const dir = root();
  try {
    const fixture = readJson(consumerFixtureUrl);
    const runtime = new RenderRuntimeV2({
      store: store(dir),
      executor: successfulExecutor({ count: 0 }),
      probe: { async inspect() { return goodProbe(); } },
      sandboxRoot: dir,
      liveExecutionEnabled: true
    });
    const protocol = new MediaJobProtocolV1(runtime);
    await protocol.handle(fixture.submit);

    const conflict = clone(fixture.submit);
    conflict.request.jobId = "creator-conflict";
    conflict.request.outputPath = "outputs/creator/conflict.mp4";

    await assert.rejects(
      () => protocol.handle(conflict),
      (error) => error.code === "idempotency_conflict"
    );
    assert.equal(runtime.store.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get/status/cancel/resume_or_poll are transport-neutral and expose no partial output", async () => {
  const dir = root();
  try {
    const fixture = readJson(consumerFixtureUrl);
    const runtime = new RenderRuntimeV2({
      store: store(dir),
      executor: successfulExecutor({ count: 0 }),
      probe: { async inspect() { return goodProbe(); } },
      sandboxRoot: dir,
      liveExecutionEnabled: true
    });
    const protocol = new MediaJobProtocolV1(runtime);
    await protocol.handle(fixture.submit);

    const got = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "get",
      jobId: fixture.submit.request.jobId
    });
    const status = await protocol.handle(fixture.status);
    assert.equal(got.status, "queued");
    assert.equal(status.status, "queued");
    assert.equal(got.finalArtifact, null);
    assert.equal(Object.hasOwn(got, "tempOutputPath"), false);
    assert.equal(Object.hasOwn(got, "resolvedOutputPath"), false);

    const cancelled = await protocol.handle(fixture.cancel);
    assert.equal(cancelled.status, "cancelled");
    const polled = await protocol.handle(fixture.poll);
    assert.equal(polled.status, "cancelled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caller timeout and duplicate resume calls share one accepted render execution", async () => {
  const dir = root();
  try {
    let executorCalls = 0;
    let release;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const releasePromise = new Promise((resolve) => { release = resolve; });
    const executor = {
      async run(command) {
        executorCalls += 1;
        started();
        await releasePromise;
        writeFileSync(command.args.at(-1), "caller-timeout-render");
        return {
          ok: true, code: 0, signal: null, timedOut: false, cancelled: false,
          stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1
        };
      }
    };
    const runtime = new RenderRuntimeV2({
      store: store(dir),
      executor,
      probe: { async inspect() { return goodProbe(); } },
      sandboxRoot: dir,
      liveExecutionEnabled: true
    });
    const protocol = new MediaJobProtocolV1(runtime);
    const request = liveRequest("caller-timeout", "outputs/caller-timeout.mp4");
    const submit = {
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "creator:caller-timeout",
      request
    };

    await protocol.handle(submit);
    await protocol.handle(clone(submit));
    const firstPoll = protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId: request.jobId
    });
    await startedPromise;
    const retryPoll = protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId: request.jobId
    });

    assert.equal(executorCalls, 1);
    release();
    const [a, b] = await Promise.all([firstPoll, retryPoll]);
    assert.equal(a.status, "succeeded");
    assert.equal(b.status, "succeeded");
    assert.equal(executorCalls, 1);
    assert.equal(b.telemetry.sideEffects.executorInvocations, 1);
    assert.equal(b.telemetry.protocol.submitCount, 2);
    assert.equal(b.telemetry.protocol.resumeCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Media owns process timeout retry without caller resubmission", async () => {
  const dir = root();
  try {
    let calls = 0;
    const runtime = new RenderRuntimeV2({
      store: store(dir),
      executor: {
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
      },
      probe: { async inspect() { return goodProbe(); } },
      sandboxRoot: dir,
      liveExecutionEnabled: true,
      retryPolicy: new RetryPolicy({ maxAttempts: 2 })
    });
    const protocol = new MediaJobProtocolV1(runtime);
    const request = liveRequest("process-retry", "outputs/process-retry.mp4");
    await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "creator:process-retry",
      request
    });

    const result = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId: request.jobId
    });
    assert.equal(result.status, "succeeded");
    assert.equal(calls, 2);
    assert.equal(result.telemetry.sideEffects.executorInvocations, 2);
    assert.equal(result.telemetry.retries, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe retry reuses the same render output and does not multiply process execution", async () => {
  const dir = root();
  try {
    const exec = { count: 0 };
    let probes = 0;
    const runtime = new RenderRuntimeV2({
      store: store(dir),
      executor: successfulExecutor(exec, "probe-retry-output"),
      probe: {
        async inspect() {
          probes += 1;
          if (probes === 1) throw new Error("probe unavailable");
          return goodProbe();
        }
      },
      sandboxRoot: dir,
      liveExecutionEnabled: true,
      retryPolicy: new RetryPolicy({ maxAttempts: 2 })
    });
    const protocol = new MediaJobProtocolV1(runtime);
    const request = liveRequest("probe-same-render", "outputs/probe-same-render.mp4");
    await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "creator:probe-same-render",
      request
    });
    const result = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId: request.jobId
    });

    assert.equal(result.status, "succeeded");
    assert.equal(exec.count, 1);
    assert.equal(probes, 2);
    assert.equal(result.telemetry.sideEffects.executorInvocations, 1);
    assert.equal(result.telemetry.sideEffects.probeInvocations, 2);
    assert.equal(result.telemetry.retries, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QA failure never exposes partial output as a final artifact", async () => {
  const dir = root();
  try {
    const exec = { count: 0 };
    const runtime = new RenderRuntimeV2({
      store: store(dir),
      executor: successfulExecutor(exec, "bad-qa-output"),
      probe: { async inspect() { return { ...goodProbe(), width: 999 }; } },
      sandboxRoot: dir,
      liveExecutionEnabled: true
    });
    const protocol = new MediaJobProtocolV1(runtime);
    const request = liveRequest("qa-no-artifact", "outputs/qa-no-artifact.mp4");
    await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "creator:qa-no-artifact",
      request
    });
    const result = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId: request.jobId
    });

    assert.equal(result.status, "failed");
    assert.equal(result.failure.code, "qa_failed");
    assert.equal(result.finalArtifact, null);
    assert.equal(result.telemetry.sideEffects.executorInvocations, 1);
    assert.equal(result.telemetry.sideEffects.finalizeInvocations, 0);
    assert.equal(existsSync(path.join(dir, request.outputPath)), false);
    assert.equal(existsSync(tempOutputPath(path.join(dir, request.outputPath), request.jobId)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart leaves uncertain accepted render reconciliation-blocked until Media reconciles it", async () => {
  const dir = root();
  try {
    const firstStore = store(dir);
    const seedRuntime = new RenderRuntimeV2({
      store: firstStore,
      executor: successfulExecutor({ count: 0 }),
      probe: { async inspect() { return goodProbe(); } },
      sandboxRoot: dir,
      liveExecutionEnabled: true
    });
    const request = liveRequest("restart-uncertain", "outputs/restart-uncertain.mp4");
    seedRuntime.submit(request, { idempotencyKey: "creator:restart-uncertain" });

    let persisted = firstStore.get(request.jobId);
    const partial = tempOutputPath(persisted.resolvedOutputPath, persisted.id);
    mkdirSync(path.dirname(partial), { recursive: true });
    writeFileSync(partial, "uncertain-partial");
    persisted = {
      ...persisted,
      status: "rendering",
      attempts: 1,
      tempOutputPath: partial,
      currentAttempt: {
        token: `${persisted.id}:render:1`,
        renderInvocation: 1,
        state: "started",
        startedAtMs: 1
      },
      telemetry: {
        ...persisted.telemetry,
        sideEffects: {
          ...persisted.telemetry.sideEffects,
          executorInvocations: 1
        }
      }
    };
    firstStore.put(persisted);

    const exec = { count: 0 };
    const restarted = new RenderRuntimeV2({
      store: new PersistentRenderJobStore({ filePath: firstStore.filePath }),
      executor: successfulExecutor(exec, "after-reconcile"),
      probe: { async inspect() { return goodProbe(); } },
      sandboxRoot: dir,
      liveExecutionEnabled: true
    });
    restarted.recoverInterruptedJobs();
    await restarted.drain();

    let blocked = restarted.store.get(request.jobId);
    assert.equal(blocked.status, "retry_wait");
    assert.equal(blocked.reconciliation.required, true);
    assert.equal(exec.count, 0);
    assert.equal(blocked.telemetry.sideEffects.executorInvocations, 1);

    blocked = await restarted.resumeOrPoll(request.jobId);
    assert.equal(blocked.reconciliation.required, true);
    assert.equal(exec.count, 0);

    restarted.reconcileAttempt(request.jobId, { outcome: "not_running" });
    await restarted.drain();
    const final = restarted.store.get(request.jobId);
    assert.equal(final.status, "succeeded");
    assert.equal(exec.count, 1);
    assert.equal(final.telemetry.sideEffects.executorInvocations, 2);
    assert.equal(final.telemetry.protocol.reconciliations, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancellation races do not multiply render execution or surface a final artifact", async () => {
  const dir = root();
  try {
    let calls = 0;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const runtime = new RenderRuntimeV2({
      store: store(dir),
      executor: {
        async run(_command, { signal }) {
          calls += 1;
          started();
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return {
            ok: false, code: null, signal: "SIGTERM", timedOut: false, cancelled: true,
            stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1
          };
        }
      },
      probe: { async inspect() { throw new Error("cancelled render must not probe"); } },
      sandboxRoot: dir,
      liveExecutionEnabled: true
    });
    const protocol = new MediaJobProtocolV1(runtime);
    const request = liveRequest("cancel-race", "outputs/cancel-race.mp4");
    await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "creator:cancel-race",
      request
    });

    const running = protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId: request.jobId
    });
    await startedPromise;
    await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "cancel",
      jobId: request.jobId,
      reason: "creator_cancel"
    });
    await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "cancel",
      jobId: request.jobId,
      reason: "creator_cancel_retry"
    });
    const result = await running;

    assert.equal(result.status, "cancelled");
    assert.equal(result.finalArtifact, null);
    assert.equal(calls, 1);
    assert.equal(result.telemetry.sideEffects.executorInvocations, 1);
    assert.equal(result.telemetry.protocol.cancelRequests, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only QA-passing atomic output is exposed as final artifact", async () => {
  const dir = root();
  try {
    const exec = { count: 0 };
    const runtime = new RenderRuntimeV2({
      store: store(dir),
      executor: successfulExecutor(exec, "final-artifact"),
      probe: { async inspect() { return goodProbe(); } },
      sandboxRoot: dir,
      liveExecutionEnabled: true
    });
    const protocol = new MediaJobProtocolV1(runtime);
    const request = liveRequest("final-artifact", "outputs/final-artifact.mp4");
    const accepted = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "submit",
      idempotencyKey: "creator:final-artifact",
      request
    });
    assert.equal(accepted.finalArtifact, null);

    const result = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId: request.jobId
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.finalArtifact.outputPath, request.outputPath);
    assert.equal(result.finalArtifact.size > 0, true);
    assert.match(result.finalArtifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.telemetry.sideEffects.successfulFinalizations, 1);
    assert.equal(existsSync(path.join(dir, request.outputPath)), true);
    assert.doesNotMatch(JSON.stringify(result), /\.partial/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
