import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { tempOutputPath } from "./atomic-output.js";
import {
  MediaJobProtocolHarness,
  validateMediaJobPublicResponse
} from "./job-conformance.js";
import { MediaJobProtocolV1, publicJobSnapshot } from "./job-protocol.js";
import { PersistentRenderJobStore } from "./job-store.js";
import { isTerminalRenderStatus } from "./lifecycle.js";
import { RetryPolicy } from "./retry.js";
import { RenderRuntimeV2 } from "./runtime.js";

export const SOAK_SCENARIOS = Object.freeze([
  "normal",
  "duplicate_submit",
  "caller_timeout",
  "process_failure",
  "process_timeout",
  "probe_transient",
  "qa_failure",
  "cancel_before_render",
  "cancel_during_render",
  "restart_rendering",
  "restart_probing",
  "restart_qa",
  "restart_retry_wait",
  "uncertain_render_outcome",
  "dry_run"
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`soak invariant failed: ${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function xorshift32(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function shuffle(values, seed) {
  const random = xorshift32(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function successProbe() {
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

function makeRequest(jobId, scenario) {
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
    dryRun: scenario === "dry_run"
  };
}

function sumCounters(jobs, selector) {
  return jobs.reduce((total, job) => total + selector(job), 0);
}

function scenarioCounts(assignments) {
  const counts = Object.fromEntries(SOAK_SCENARIOS.map((scenario) => [scenario, 0]));
  for (const value of assignments.values()) counts[value] += 1;
  return counts;
}

function assertIdempotencyBindings(store) {
  for (const [key, record] of Object.entries(store.state.idempotency)) {
    const job = store.state.jobs[record.jobId];
    invariant(Boolean(job), `idempotency ${key} references missing job`);
    invariant(
      record.workSignature === job.workSignature,
      `idempotency ${key} workSignature drifted`
    );
  }
}

function assertPublicJob(job) {
  const response = publicJobSnapshot(job);
  validateMediaJobPublicResponse(response, { action: "status" });
  const wire = JSON.stringify(response);
  invariant(!wire.includes(".partial"), `${job.id} leaked partial path`);
  invariant(!/publish/i.test(wire), `${job.id} leaked publishing state`);

  if (job.status === "succeeded" && !job.dryRun) {
    invariant(response.finalArtifact !== null, `${job.id} succeeded live without artifact`);
    invariant(
      job.telemetry.sideEffects.successfulFinalizations === 1,
      `${job.id} succeeded live without exactly one successful finalization`
    );
  }
  if (job.status === "failed" || job.status === "cancelled" || job.dryRun) {
    invariant(response.finalArtifact === null, `${job.id} exposed forbidden final artifact`);
  }
}

function attachInvariantStore(store, state) {
  const originalCreate = store.create.bind(store);
  const originalPut = store.put.bind(store);

  for (const job of store.list()) {
    if (isTerminalRenderStatus(job.status)) state.terminalStatuses.set(job.id, job.status);
    assertPublicJob(job);
  }
  assertIdempotencyBindings(store);

  store.create = (job, options) => {
    const result = originalCreate(job, options);
    assertIdempotencyBindings(store);
    assertPublicJob(result.job);
    state.transitionChecks += 1;
    return result;
  };

  store.put = (job) => {
    const previous = store.get(job.id);
    const terminal = state.terminalStatuses.get(job.id);
    if (terminal) {
      invariant(job.status === terminal, `${job.id} left terminal status ${terminal}`);
    }
    if (previous && isTerminalRenderStatus(previous.status)) {
      invariant(job.status === previous.status, `${job.id} terminal state regressed`);
    }

    const saved = originalPut(job);
    if (isTerminalRenderStatus(saved.status)) state.terminalStatuses.set(saved.id, saved.status);
    assertIdempotencyBindings(store);
    assertPublicJob(saved);

    if (isTerminalRenderStatus(saved.status) && saved.resolvedOutputPath) {
      invariant(
        !existsSync(tempOutputPath(saved.resolvedOutputPath, saved.id)),
        `${saved.id} left orphan temp output after terminal cleanup`
      );
    }

    state.transitionChecks += 1;
    return saved;
  };

  return store;
}

class SoakExecutor {
  constructor(state, assignments, renderLimit) {
    this.state = state;
    this.assignments = assignments;
    this.renderLimit = renderLimit;
    this.active = 0;
    this.maxActive = 0;
    this.activeJobs = new Set();
    this.seenTokens = new Set();
    this.callsByJob = new Map();
    this.started = new Map();
    this.releases = new Map();
  }

  seedAttempt(token) {
    invariant(!this.seenTokens.has(token), `duplicate seeded attempt token ${token}`);
    this.seenTokens.add(token);
  }

  #jobForOutput(outputPath) {
    return this.state.store.list().find((job) => job.tempOutputPath === outputPath);
  }

  waitStarted(jobId) {
    if (!this.started.has(jobId)) this.started.set(jobId, deferred());
    return this.started.get(jobId).promise;
  }

  release(jobId) {
    this.releases.get(jobId)?.resolve();
  }

  async run(command, { signal } = {}) {
    const outputPath = command.args.at(-1);
    const job = this.#jobForOutput(outputPath);
    invariant(Boolean(job), `executor could not resolve job for ${outputPath}`);
    invariant(!job.reconciliation?.required, `${job.id} spawned executor while reconciliation-required`);

    const token = job.currentAttempt?.token;
    invariant(typeof token === "string" && token.length > 0, `${job.id} missing attempt token`);
    invariant(!this.seenTokens.has(token), `${job.id} duplicated executor attempt token ${token}`);
    invariant(!this.activeJobs.has(job.id), `${job.id} has more than one active render attempt`);

    this.seenTokens.add(token);
    this.activeJobs.add(job.id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    invariant(this.active <= this.renderLimit, `render slots exceeded ${this.renderLimit}`);

    const call = (this.callsByJob.get(job.id) ?? 0) + 1;
    this.callsByJob.set(job.id, call);
    const scenario = this.assignments.get(job.id);
    if (!this.started.has(job.id)) this.started.set(job.id, deferred());
    this.started.get(job.id).resolve();

    try {
      if (scenario === "caller_timeout") {
        if (!this.releases.has(job.id)) this.releases.set(job.id, deferred());
        await this.releases.get(job.id).promise;
      } else if (scenario === "cancel_during_render") {
        if (!signal?.aborted) {
          await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        }
        return {
          ok: false, code: null, signal: "SIGTERM", timedOut: false, cancelled: true,
          stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1
        };
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      if (scenario === "process_failure" && call === 1) {
        return {
          ok: false, code: 23, signal: null, timedOut: false, cancelled: false,
          stdout: "", stderr: "injected process failure",
          stdoutTruncated: false, stderrTruncated: false, durationMs: 1
        };
      }
      if (scenario === "process_timeout" && call === 1) {
        return {
          ok: false, code: null, signal: "SIGTERM", timedOut: true, cancelled: false,
          stdout: "", stderr: "injected process timeout",
          stdoutTruncated: false, stderrTruncated: false, durationMs: 1
        };
      }

      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `soak:${job.id}:${token}\n`, "utf8");
      return {
        ok: true, code: 0, signal: null, timedOut: false, cancelled: false,
        stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1
      };
    } finally {
      this.active -= 1;
      this.activeJobs.delete(job.id);
    }
  }
}

class SoakProbe {
  constructor(state, assignments, probeLimit) {
    this.state = state;
    this.assignments = assignments;
    this.probeLimit = probeLimit;
    this.active = 0;
    this.maxActive = 0;
    this.callsByJob = new Map();
  }

  #jobForOutput(outputPath) {
    return this.state.store.list().find((job) => job.tempOutputPath === outputPath);
  }

  async inspect(outputPath) {
    const job = this.#jobForOutput(outputPath);
    invariant(Boolean(job), `probe could not resolve job for ${outputPath}`);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    invariant(this.active <= this.probeLimit, `probe slots exceeded ${this.probeLimit}`);
    const call = (this.callsByJob.get(job.id) ?? 0) + 1;
    this.callsByJob.set(job.id, call);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (this.assignments.get(job.id) === "probe_transient" && call === 1) {
        throw new Error("injected transient probe failure");
      }
      if (this.assignments.get(job.id) === "qa_failure") {
        return { ...successProbe(), width: 65 };
      }
      return successProbe();
    } finally {
      this.active -= 1;
    }
  }
}

function makeAssignments(seed, jobCount) {
  invariant(jobCount >= 100, "jobCount must be at least 100");
  invariant(jobCount % SOAK_SCENARIOS.length === 0, "jobCount must be divisible by scenario count");
  const repeats = jobCount / SOAK_SCENARIOS.length;
  const scenarios = [];
  for (let index = 0; index < repeats; index += 1) scenarios.push(...SOAK_SCENARIOS);
  const shuffled = shuffle(scenarios, seed);
  const assignments = new Map();
  shuffled.forEach((scenario, index) => {
    assignments.set(`soak-${seed}-${String(index).padStart(3, "0")}`, scenario);
  });
  return assignments;
}

function syntheticProcessResult() {
  return {
    ok: true, code: 0, signal: null, timedOut: false, cancelled: false,
    stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1
  };
}

function injectRestartState(store, executor, jobId, scenario) {
  let job = store.get(jobId);
  invariant(job?.status === "queued", `${jobId} must be queued before restart injection`);
  const telemetry = clone(job.telemetry);
  telemetry.sideEffects.executorInvocations = 1;
  const token = `${jobId}:render:1`;
  executor.seedAttempt(token);
  const partial = tempOutputPath(job.resolvedOutputPath, job.id);

  if (scenario !== "restart_retry_wait") {
    mkdirSync(path.dirname(partial), { recursive: true });
    writeFileSync(partial, `pre-restart:${jobId}\n`, "utf8");
  }

  const common = {
    ...job,
    attempts: 1,
    currentAttempt: {
      token,
      renderInvocation: 1,
      state: scenario === "restart_rendering" || scenario === "uncertain_render_outcome"
        ? "started"
        : "rendered",
      startedAtMs: 1
    },
    telemetry
  };

  if (scenario === "restart_rendering" || scenario === "uncertain_render_outcome") {
    job = {
      ...common,
      status: "rendering",
      tempOutputPath: partial
    };
  } else if (scenario === "restart_probing") {
    job = {
      ...common,
      status: "probing",
      tempOutputPath: partial,
      processResult: syntheticProcessResult()
    };
  } else if (scenario === "restart_qa") {
    telemetry.sideEffects.probeInvocations = 1;
    job = {
      ...common,
      status: "qa",
      tempOutputPath: partial,
      processResult: syntheticProcessResult(),
      probe: successProbe(),
      telemetry
    };
  } else if (scenario === "restart_retry_wait") {
    telemetry.retries = 1;
    job = {
      ...common,
      status: "retry_wait",
      retryStage: "queued",
      tempOutputPath: null,
      failure: {
        code: "process_timeout",
        category: "process",
        message: "known timeout before restart",
        retryable: true,
        details: null
      },
      telemetry
    };
  } else {
    throw new Error(`unsupported restart scenario ${scenario}`);
  }
  store.put(job);
}

export function buildDeterministicSoakPlan({ seed, jobCount = 105 } = {}) {
  const assignments = makeAssignments(seed, jobCount);
  return {
    seed,
    jobCount,
    injectedEventCount: jobCount * 2,
    scenarioCounts: scenarioCounts(assignments),
    order: shuffle([...assignments.keys()], seed ^ 0xa5a5a5a5).map((jobId) => ({
      jobId,
      scenario: assignments.get(jobId)
    }))
  };
}

export async function runDeterministicMediaSoak({
  root,
  seed,
  jobCount = 105,
  workerSlots = 6,
  renderSlots = 3,
  probeSlots = 2
} = {}) {
  invariant(typeof root === "string" && root.length > 0, "root is required");
  const plan = buildDeterministicSoakPlan({ seed, jobCount });
  const assignments = new Map(plan.order.map(({ jobId, scenario }) => [jobId, scenario]));
  const originalAssignments = makeAssignments(seed, jobCount);
  for (const [jobId, scenario] of originalAssignments) assignments.set(jobId, scenario);

  const state = {
    store: null,
    terminalStatuses: new Map(),
    transitionChecks: 0,
    restartCount: 0,
    workerActive: 0,
    maxWorkerActive: 0
  };
  const storePath = path.join(root, "jobs.json");
  mkdirSync(root, { recursive: true });

  const executor = new SoakExecutor(state, assignments, renderSlots);
  const probe = new SoakProbe(state, assignments, probeSlots);

  let runtime;
  let harness;
  let store;

  const rebuild = ({ recover = true, countRestart = true } = {}) => {
    store = attachInvariantStore(new PersistentRenderJobStore({ filePath: storePath }), state);
    state.store = store;
    runtime = new RenderRuntimeV2({
      store,
      executor,
      probe,
      sandboxRoot: root,
      liveExecutionEnabled: true,
      maxConcurrency: workerSlots,
      resourceLimits: { render: renderSlots, probe: probeSlots },
      retryPolicy: new RetryPolicy({ maxAttempts: 3 })
    });
    harness = new MediaJobProtocolHarness(new MediaJobProtocolV1(runtime));
    if (recover) runtime.recoverInterruptedJobs();
    if (countRestart) state.restartCount += 1;
  };

  rebuild({ recover: false, countRestart: false });

  const requests = new Map();
  const idempotencyKeys = new Map();
  for (const [jobId, scenario] of originalAssignments) {
    const request = makeRequest(jobId, scenario);
    const idempotencyKey = `creator:soak:${seed}:${jobId}`;
    requests.set(jobId, request);
    idempotencyKeys.set(jobId, idempotencyKey);
    const response = await harness.exchange({
      contractVersion: "media.job.v1",
      action: "submit",
      idempotencyKey,
      request
    });
    invariant(response.accepted === true && response.jobId === jobId, `${jobId} submit failed`);
  }

  for (const [jobId, scenario] of originalAssignments) {
    if (scenario === "duplicate_submit") {
      const duplicates = await Promise.all(
        Array.from({ length: 4 }, () => harness.exchange({
          contractVersion: "media.job.v1",
          action: "submit",
          idempotencyKey: idempotencyKeys.get(jobId),
          request: requests.get(jobId)
        }))
      );
      invariant(duplicates.every((item) => item.duplicate === true), `${jobId} duplicate submit drifted`);

      const conflicting = {
        ...clone(requests.get(jobId)),
        outputPath: `outputs/${jobId}-conflict.mp4`
      };
      const conflict = await harness.exchange({
        contractVersion: "media.job.v1",
        action: "submit",
        idempotencyKey: idempotencyKeys.get(jobId),
        request: conflicting
      });
      invariant(conflict.accepted === false && conflict.error.code === "idempotency_conflict", `${jobId} conflict did not fail closed`);
    }
    if (scenario === "cancel_before_render") {
      const cancelled = await harness.exchange({
        contractVersion: "media.job.v1",
        action: "cancel",
        jobId,
        reason: "soak_cancel_before_render"
      });
      invariant(cancelled.status === "cancelled", `${jobId} cancel-before did not terminate`);
    }
    if (scenario.startsWith("restart_") || scenario === "uncertain_render_outcome") {
      injectRestartState(store, executor, jobId, scenario);
    }
  }

  rebuild();
  rebuild();
  rebuild();

  for (const [jobId, scenario] of originalAssignments) {
    if (scenario === "restart_rendering") {
      invariant(store.get(jobId).reconciliation?.required === true, `${jobId} lost rendering reconciliation barrier`);
      runtime.reconcileAttempt(jobId, { outcome: "not_running" });
    }
    if (scenario === "uncertain_render_outcome") {
      const before = executor.callsByJob.get(jobId) ?? 0;
      const blocked = await harness.exchange({
        contractVersion: "media.job.v1",
        action: "resume_or_poll",
        jobId
      });
      invariant(blocked.reconciliation.required === true, `${jobId} uncertain outcome was not blocked`);
      runtime.reconcileAttempt(jobId, { outcome: "unknown" });
      const stillBlocked = await harness.exchange({
        contractVersion: "media.job.v1",
        action: "status",
        jobId
      });
      invariant(stillBlocked.reconciliation.required === true, `${jobId} unknown reconciliation cleared barrier`);
      invariant((executor.callsByJob.get(jobId) ?? 0) === before, `${jobId} executor spawned while uncertain`);
      runtime.reconcileAttempt(jobId, { outcome: "not_running" });
    }
  }

  const callerJobs = [...originalAssignments]
    .filter(([, scenario]) => scenario === "caller_timeout")
    .map(([jobId]) => jobId);
  for (const jobId of callerJobs) {
    const running = runtime.runAcceptedJob(jobId);
    await executor.waitStarted(jobId);
    const before = executor.callsByJob.get(jobId);
    const duplicate = await harness.exchange({
      contractVersion: "media.job.v1",
      action: "submit",
      idempotencyKey: idempotencyKeys.get(jobId),
      request: requests.get(jobId)
    });
    invariant(duplicate.duplicate === true && duplicate.jobId === jobId, `${jobId} caller-timeout duplicate changed identity`);
    invariant(executor.callsByJob.get(jobId) === before, `${jobId} caller timeout multiplied executor`);
    executor.release(jobId);
    const done = await running;
    invariant(done.status === "succeeded", `${jobId} caller-timeout did not complete`);
  }

  const cancelDuringJobs = [...originalAssignments]
    .filter(([, scenario]) => scenario === "cancel_during_render")
    .map(([jobId]) => jobId);
  for (const jobId of cancelDuringJobs) {
    const running = harness.exchange({
      contractVersion: "media.job.v1",
      action: "resume_or_poll",
      jobId
    });
    await executor.waitStarted(jobId);
    await harness.exchange({
      contractVersion: "media.job.v1",
      action: "cancel",
      jobId,
      reason: "soak_cancel_during_render"
    });
    const done = await running;
    invariant(done.status === "cancelled", `${jobId} cancel-during did not terminate`);
    invariant((executor.callsByJob.get(jobId) ?? 0) === 1, `${jobId} cancel-during multiplied executor`);
  }

  rebuild();

  const runnable = shuffle(
    store.list()
      .filter((job) => !isTerminalRenderStatus(job.status))
      .map((job) => job.id),
    seed ^ 0x5f3759df
  );

  const drive = async (jobId) => {
    state.workerActive += 1;
    state.maxWorkerActive = Math.max(state.maxWorkerActive, state.workerActive);
    invariant(state.workerActive <= workerSlots, `worker slots exceeded ${workerSlots}`);
    try {
      for (let guard = 0; guard < 10; guard += 1) {
        const before = store.get(jobId);
        if (!before || isTerminalRenderStatus(before.status) || before.reconciliation?.required) return before;
        await runtime.runAcceptedJob(jobId);
      }
      throw new Error(`soak job ${jobId} exceeded direct-drive retry guard`);
    } finally {
      state.workerActive -= 1;
    }
  };

  let chunks = 0;
  for (let offset = 0; offset < runnable.length; offset += workerSlots) {
    const batch = runnable.slice(offset, offset + workerSlots);
    await Promise.all(batch.map(drive));
    chunks += 1;
    if (chunks % 3 === 0 && offset + workerSlots < runnable.length) rebuild();
  }

  rebuild();

  const jobs = store.list();
  invariant(jobs.length === jobCount, `expected ${jobCount} jobs, found ${jobs.length}`);
  for (const job of jobs) assertPublicJob(job);

  const terminalCounts = { succeeded: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) {
    invariant(isTerminalRenderStatus(job.status), `${job.id} remained nonterminal at soak end`);
    terminalCounts[job.status] += 1;
  }

  const counts = scenarioCounts(originalAssignments);
  const repeats = jobCount / SOAK_SCENARIOS.length;
  invariant(terminalCounts.succeeded === repeats * 12, "unexpected succeeded count");
  invariant(terminalCounts.failed === repeats, "unexpected failed count");
  invariant(terminalCounts.cancelled === repeats * 2, "unexpected cancelled count");
  invariant(executor.maxActive <= renderSlots, "render resource bound exceeded");
  invariant(probe.maxActive <= probeSlots, "probe resource bound exceeded");
  invariant(state.maxWorkerActive <= workerSlots, "worker resource bound exceeded");

  const summary = {
    seed,
    jobCount,
    injectedEventCount: plan.injectedEventCount,
    scenarioCounts: counts,
    terminalCounts,
    restartCount: state.restartCount,
    transitionChecks: state.transitionChecks,
    resources: {
      workerLimit: workerSlots,
      maxWorkerActive: state.maxWorkerActive,
      renderLimit: renderSlots,
      maxRenderActive: executor.maxActive,
      probeLimit: probeSlots,
      maxProbeActive: probe.maxActive
    },
    sideEffects: {
      executorInvocationsPersisted: sumCounters(jobs, (job) => job.telemetry.sideEffects.executorInvocations),
      executorCallsObserved: [...executor.callsByJob.values()].reduce((a, b) => a + b, 0),
      probeInvocationsPersisted: sumCounters(jobs, (job) => job.telemetry.sideEffects.probeInvocations),
      probeCallsObserved: [...probe.callsByJob.values()].reduce((a, b) => a + b, 0),
      successfulFinalizations: sumCounters(jobs, (job) => job.telemetry.sideEffects.successfulFinalizations)
    }
  };

  return summary;
}

export function cleanupSoakRoot(root) {
  rmSync(root, { recursive: true, force: true });
}
