import {
  existsSync,
  mkdirSync,
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
import { RenderRuntimeV2 } from "./runtime.js";

const PROFILES = Object.freeze(["interactive", "standard", "background", "gpu"]);

function invariant(condition, message) {
  if (!condition) throw new Error(`scheduler soak invariant failed: ${message}`);
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

function shuffled(values, seed) {
  const random = xorshift32(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requestFor(spec) {
  return {
    contractVersion: "media.render.v1",
    jobId: spec.jobId,
    timeline: {
      id: spec.jobId,
      version: 1,
      canvas: {
        width: 64,
        height: 64,
        fps: 10,
        durationMs: spec.long ? 60000 : 300
      },
      tracks: []
    },
    exportSpec: {
      videoCodec: "libx264",
      audioCodec: "aac",
      videoBitrate: "250k",
      audioBitrate: "64k",
      pixelFormat: "yuv420p",
      runtimeProfile: spec.profile
    },
    outputPath: `outputs/${spec.jobId}.mp4`,
    dryRun: spec.dryRun
  };
}

export function buildSchedulerSoakPlan({ seed = 606060, jobCount = 540 } = {}) {
  if (!Number.isInteger(jobCount) || jobCount < 500) {
    throw new TypeError("scheduler soak requires at least 500 jobs");
  }
  const random = xorshift32(seed);
  const jobs = [];
  for (let index = 0; index < jobCount; index += 1) {
    const profile = PROFILES[index % PROFILES.length];
    jobs.push({
      jobId: `scheduler-${seed}-${String(index).padStart(4, "0")}`,
      profile,
      priorityClass: profile === "interactive" ? "high" : profile === "background" ? "low" : "normal",
      long: index % 3 === 0,
      dryRun: index % 23 === 0,
      duplicateSubmit: index % 9 === 0,
      cancelQueued: index % 17 === 0,
      uncertainRestart: index % 29 === 0,
      orderKey: random()
    });
  }

  for (const item of jobs) {
    if (item.cancelQueued || item.dryRun) item.uncertainRestart = false;
  }

  return {
    seed,
    jobCount,
    jobs: [...jobs].sort((a, b) => a.orderKey - b.orderKey || a.jobId.localeCompare(b.jobId))
  };
}

class MixedExecutor {
  constructor(state, renderLimit) {
    this.state = state;
    this.renderLimit = renderLimit;
    this.active = 0;
    this.maxActive = 0;
    this.activeJobs = new Set();
    this.seenTokens = new Set();
    this.calls = 0;
    this.starts = [];
  }

  seedToken(token) {
    invariant(!this.seenTokens.has(token), `seed token repeated: ${token}`);
    this.seenTokens.add(token);
  }

  async run(command) {
    const outputPath = command.args.at(-1);
    const job = this.state.store.list().find((candidate) => candidate.tempOutputPath === outputPath);
    invariant(Boolean(job), `executor could not find job for ${outputPath}`);
    invariant(!job.reconciliation?.required, `${job.id} executed while reconciliation-required`);
    invariant(!this.activeJobs.has(job.id), `${job.id} has duplicate active render attempt`);
    const token = job.currentAttempt?.token;
    invariant(typeof token === "string", `${job.id} missing attempt token`);
    invariant(!this.seenTokens.has(token), `${job.id} repeated attempt token ${token}`);

    this.seenTokens.add(token);
    this.activeJobs.add(job.id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    invariant(this.active <= this.renderLimit, `executor exceeded render limit ${this.renderLimit}`);
    this.calls += 1;
    this.starts.push({
      jobId: job.id,
      priorityClass: job.scheduling.priorityClass,
      enqueueSequence: job.scheduling.enqueueSequence,
      dispatchSequence: job.scheduling.lastDispatchSequence,
      profile: job.scheduling.profile,
      long: job.timeline.canvas.durationMs > 30000
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, job.timeline.canvas.durationMs > 30000 ? 3 : 1));
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `scheduler-soak:${job.id}:${token}\n`, "utf8");
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
        durationMs: job.timeline.canvas.durationMs > 30000 ? 3 : 1
      };
    } finally {
      this.active -= 1;
      this.activeJobs.delete(job.id);
    }
  }
}

class MixedProbe {
  constructor(state, probeLimit) {
    this.state = state;
    this.probeLimit = probeLimit;
    this.active = 0;
    this.maxActive = 0;
    this.calls = 0;
  }

  async inspect(outputPath) {
    const job = this.state.store.list().find((candidate) => candidate.tempOutputPath === outputPath);
    invariant(Boolean(job), `probe could not find job for ${outputPath}`);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    invariant(this.active <= this.probeLimit, `probe exceeded limit ${this.probeLimit}`);
    this.calls += 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        hasVideo: true,
        hasAudio: false,
        width: job.timeline.canvas.width,
        height: job.timeline.canvas.height,
        fps: job.timeline.canvas.fps,
        durationMs: job.timeline.canvas.durationMs,
        videoCodec: "h264",
        audioCodec: null,
        blackFrameRatio: 0.01
      };
    } finally {
      this.active -= 1;
    }
  }
}

function countBy(values, keyFn) {
  const result = {};
  for (const value of values) {
    const key = keyFn(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function assertPublicTerminal(job) {
  const response = publicJobSnapshot(job);
  validateMediaJobPublicResponse(response, { action: "status" });
  const wire = JSON.stringify(response);
  invariant(!wire.includes(".partial"), `${job.id} leaked partial path`);
  invariant(!/publish/i.test(wire), `${job.id} leaked publishing state`);
  if (job.status === "succeeded" && !job.dryRun) {
    invariant(response.finalArtifact !== null, `${job.id} succeeded without final artifact`);
    invariant(job.telemetry.sideEffects.successfulFinalizations === 1, `${job.id} finalized more or less than once`);
  } else {
    invariant(response.finalArtifact === null, `${job.id} exposed forbidden artifact`);
  }
  if (isTerminalRenderStatus(job.status) && job.resolvedOutputPath) {
    invariant(!existsSync(tempOutputPath(job.resolvedOutputPath, job.id)), `${job.id} left terminal temp output`);
  }
}

export async function runResourceSchedulerSoak({
  root,
  seed = 606060,
  jobCount = 540,
  maxConcurrency = 8,
  resourceLimits = { cpu: 6, gpu: 2, render: 4, probe: 3, qa: 2 }
} = {}) {
  const plan = buildSchedulerSoakPlan({ seed, jobCount });
  const state = { store: null };
  const storePath = path.join(root, "jobs.json");
  mkdirSync(root, { recursive: true });

  const executor = new MixedExecutor(state, resourceLimits.render);
  const probe = new MixedProbe(state, resourceLimits.probe);
  let store;
  let runtime;
  let harness;
  let restartCount = 0;

  const rebuild = ({ recover = true } = {}) => {
    store = new PersistentRenderJobStore({ filePath: storePath });
    state.store = store;
    runtime = new RenderRuntimeV2({
      store,
      executor,
      probe,
      sandboxRoot: root,
      liveExecutionEnabled: true,
      maxConcurrency,
      resourceLimits,
      queueLimit: Math.max(jobCount + 32, 1024)
    });
    harness = new MediaJobProtocolHarness(new MediaJobProtocolV1(runtime));
    if (recover) runtime.recoverInterruptedJobs();
    restartCount += recover ? 1 : 0;
  };

  rebuild({ recover: false });

  const requestById = new Map();
  const idempotencyById = new Map();
  for (const spec of plan.jobs) {
    const request = requestFor(spec);
    requestById.set(spec.jobId, request);
    const idempotencyKey = `creator:scheduler:${seed}:${spec.jobId}`;
    idempotencyById.set(spec.jobId, idempotencyKey);
    const accepted = await harness.exchange({
      contractVersion: "media.job.v1",
      action: "submit",
      idempotencyKey,
      request
    });
    invariant(accepted.accepted === true, `${spec.jobId} was not accepted`);
    invariant(accepted.status === "queued", `${spec.jobId} did not enter durable queue`);
  }

  const identityBeforeRestart = new Map(
    store.list().map((job) => [job.id, {
      enqueueSequence: job.scheduling.enqueueSequence,
      priorityClass: job.scheduling.priorityClass,
      profile: job.scheduling.profile
    }])
  );

  let duplicateSubmits = 0;
  for (const spec of plan.jobs.filter((item) => item.duplicateSubmit)) {
    const responses = await Promise.all(Array.from({ length: 2 }, () => harness.exchange({
      contractVersion: "media.job.v1",
      action: "submit",
      idempotencyKey: idempotencyById.get(spec.jobId),
      request: requestById.get(spec.jobId)
    })));
    invariant(responses.every((item) => item.accepted && item.duplicate), `${spec.jobId} duplicate submit did not converge`);
    duplicateSubmits += responses.length;
  }
  invariant(executor.calls === 0, "duplicate submit spawned executor");

  let cancelledQueued = 0;
  for (const spec of plan.jobs.filter((item) => item.cancelQueued)) {
    const result = await harness.exchange({
      contractVersion: "media.job.v1",
      action: "cancel",
      jobId: spec.jobId,
      reason: "scheduler_soak_queue_cancel"
    });
    invariant(result.status === "cancelled", `${spec.jobId} queued cancellation failed`);
    cancelledQueued += 1;
  }

  let uncertainCount = 0;
  const held = { cpu: 0, gpu: 0, render: 0, probe: 0, qa: 0 };
  for (const spec of plan.jobs.filter((item) => item.uncertainRestart)) {
    let job = store.get(spec.jobId);
    if (isTerminalRenderStatus(job.status)) continue;
    const requirements = job.scheduling.requirements.render;
    const fits = Object.entries(held).every(([name, value]) =>
      value + requirements[name] <= resourceLimits[name]
    );
    if (!fits) continue;

    const token = `${job.id}:render:1`;
    executor.seedToken(token);
    const partial = tempOutputPath(job.resolvedOutputPath, job.id);
    mkdirSync(path.dirname(partial), { recursive: true });
    writeFileSync(partial, `uncertain:${job.id}\n`, "utf8");
    const telemetry = clone(job.telemetry);
    telemetry.sideEffects.executorInvocations = 1;
    job = {
      ...job,
      status: "rendering",
      attempts: 1,
      tempOutputPath: partial,
      telemetry,
      currentAttempt: {
        token,
        renderInvocation: 1,
        state: "started",
        startedAtMs: 1
      },
      scheduling: {
        ...job.scheduling,
        reservation: {
          token,
          stage: "render",
          requirements,
          external: false,
          uncertain: true
        }
      }
    };
    store.put(job);
    for (const [name, value] of Object.entries(requirements)) held[name] += value;
    uncertainCount += 1;
  }

  rebuild();
  rebuild();

  for (const job of store.list()) {
    const before = identityBeforeRestart.get(job.id);
    invariant(job.scheduling.enqueueSequence === before.enqueueSequence, `${job.id} enqueue sequence changed after restart`);
    invariant(job.scheduling.priorityClass === before.priorityClass, `${job.id} priority changed after restart`);
    invariant(job.scheduling.profile === before.profile, `${job.id} profile changed after restart`);
  }

  const beforeReconcile = runtime.getSchedulerDiagnostics();
  invariant(beforeReconcile.resources.externalReservations === uncertainCount, "uncertain reservations were not restored");
  const blocked = store.list().find((job) => job.reconciliation?.required);
  if (blocked) {
    const beforeCalls = executor.calls;
    const result = await harness.exchange({
      contractVersion: "media.job.v1",
      action: "resume_or_poll",
      jobId: blocked.id
    });
    invariant(result.reconciliation.required === true, "uncertain job lost reconciliation barrier");
    invariant(executor.calls === beforeCalls, "reconciliation-blocked job spawned executor");
  }

  for (const job of store.list().filter((candidate) => candidate.reconciliation?.required)) {
    runtime.reconcileAttempt(job.id, { outcome: "not_running" });
  }
  const afterReconcile = runtime.getSchedulerDiagnostics();
  invariant(afterReconcile.resources.externalReservations === 0, "external reservations leaked after reconciliation");
  invariant(Object.values(afterReconcile.resources.used).every((value) => value === 0), "resources remained held after reconciliation");

  await runtime.drain();

  const jobs = store.list();
  invariant(jobs.length === jobCount, `expected ${jobCount} durable jobs, found ${jobs.length}`);
  invariant(jobs.every((job) => isTerminalRenderStatus(job.status)), "scheduler soak left nonterminal jobs");

  for (const job of jobs) assertPublicTerminal(job);

  const background = jobs
    .filter((job) => job.scheduling.priorityClass === "low" && job.status !== "cancelled")
    .sort((a, b) => a.scheduling.enqueueSequence - b.scheduling.enqueueSequence);
  for (let index = 0; index < background.length; index += 1) {
    const dispatch = background[index].scheduling.lastDispatchSequence;
    invariant(Number.isInteger(dispatch), `${background[index].id} was never dispatched`);
    invariant(
      dispatch <= 7 * (index + 1),
      `${background[index].id} exceeded low-priority fairness bound at dispatch ${dispatch}`
    );
  }

  const diagnostics = runtime.getSchedulerDiagnostics();
  invariant(diagnostics.queue.depth === 0, "queue did not drain");
  invariant(diagnostics.throughput.terminalJobs === jobCount, "throughput terminal count mismatch");
  invariant(diagnostics.fairness.starvationCount > 0, "starvation telemetry did not record bounded waits");
  invariant(diagnostics.resources.maxUsed.cpu <= resourceLimits.cpu, "CPU slots exceeded");
  invariant(diagnostics.resources.maxUsed.gpu <= resourceLimits.gpu, "GPU slots exceeded");
  invariant(diagnostics.resources.maxUsed.render <= resourceLimits.render, "render slots exceeded");
  invariant(diagnostics.resources.maxUsed.probe <= resourceLimits.probe, "probe slots exceeded");
  invariant(diagnostics.resources.maxUsed.qa <= resourceLimits.qa, "QA slots exceeded");
  invariant(executor.maxActive <= resourceLimits.render, "executor render concurrency exceeded");
  invariant(probe.maxActive <= resourceLimits.probe, "probe concurrency exceeded");

  const persistedExecutorInvocations = jobs.reduce(
    (total, job) => total + job.telemetry.sideEffects.executorInvocations,
    0
  );
  invariant(
    persistedExecutorInvocations - executor.calls === uncertainCount,
    "executor side-effect accounting did not match seeded uncertain attempts"
  );

  const terminalCounts = countBy(jobs, (job) => job.status);
  const priorityCounts = countBy(jobs, (job) => job.scheduling.priorityClass);
  const profileCounts = countBy(jobs, (job) => job.scheduling.profile);
  const longJobs = jobs.filter((job) => job.timeline.canvas.durationMs > 30000).length;
  const dryRuns = jobs.filter((job) => job.dryRun).length;

  return {
    seed,
    jobCount,
    duplicateSubmits,
    cancelledQueued,
    uncertainRestartJobs: uncertainCount,
    restartCount,
    longJobs,
    shortJobs: jobCount - longJobs,
    dryRuns,
    priorityCounts,
    profileCounts,
    terminalCounts,
    fairness: {
      lowPriorityJobsDispatched: background.length,
      lowPriorityDispatchBound: 7,
      starvationTelemetryCount: diagnostics.fairness.starvationCount,
      finalDispatchSequence: diagnostics.fairness.dispatchSequence
    },
    resources: {
      budgets: diagnostics.resources.budgets,
      maxUsed: diagnostics.resources.maxUsed,
      maxExecutorActive: executor.maxActive,
      maxProbeActive: probe.maxActive,
      utilization: diagnostics.resources.utilization
    },
    waits: diagnostics.waits,
    throughput: diagnostics.throughput,
    sideEffects: {
      executorCallsObserved: executor.calls,
      executorInvocationsPersisted: persistedExecutorInvocations,
      probeCallsObserved: probe.calls
    }
  };
}
