import { runtimeError } from "./errors.js";
import { normalizeResourceRequirements } from "./resources.js";

export const MEDIA_SCHEDULER_DIAGNOSTICS_VERSION = "media.scheduler.diagnostics.v1";

export const SCHEDULER_PROFILES = Object.freeze({
  background: Object.freeze({ priorityClass: "low", gpu: 0 }),
  standard: Object.freeze({ priorityClass: "normal", gpu: 0 }),
  interactive: Object.freeze({ priorityClass: "high", gpu: 0 }),
  gpu: Object.freeze({ priorityClass: "normal", gpu: 1 })
});

export const PRIORITY_CLASSES = Object.freeze(["high", "normal", "low"]);
export const DEFAULT_PRIORITY_WHEEL = Object.freeze([
  "high", "high", "high", "high",
  "normal", "normal",
  "low"
]);

function assertProfile(profile) {
  if (!Object.hasOwn(SCHEDULER_PROFILES, profile)) {
    throw runtimeError(
      "invalid_request",
      `exportSpec.runtimeProfile must be one of: ${Object.keys(SCHEDULER_PROFILES).join(", ")}`
    );
  }
}

function cpuSlotsForTimeline(timeline) {
  const pixels = timeline.canvas.width * timeline.canvas.height;
  const heavy = timeline.canvas.durationMs > 30000 || pixels > 1920 * 1080;
  return heavy ? 2 : 1;
}

export function deriveSchedulingProfile(timeline, exportSpec = {}, dryRun = false) {
  const profileName = exportSpec.runtimeProfile ?? "standard";
  if (typeof profileName !== "string") {
    throw runtimeError("invalid_request", "exportSpec.runtimeProfile must be a string");
  }
  assertProfile(profileName);
  const profile = SCHEDULER_PROFILES[profileName];

  if (dryRun) {
    const none = normalizeResourceRequirements({});
    return {
      profile: profileName,
      priorityClass: profile.priorityClass,
      requirements: { render: none, probe: none, qa: none }
    };
  }

  const cpu = cpuSlotsForTimeline(timeline);
  return {
    profile: profileName,
    priorityClass: profile.priorityClass,
    requirements: {
      render: normalizeResourceRequirements({
        cpu,
        gpu: profile.gpu,
        render: 1
      }),
      probe: normalizeResourceRequirements({
        cpu: 1,
        probe: 1
      }),
      qa: normalizeResourceRequirements({
        cpu: 1,
        qa: 1
      })
    }
  };
}

export function schedulerStage(job) {
  if (job.status === "queued") return "render";
  if (job.status === "probing") return "probe";
  if (job.status === "qa") return "qa";
  if (job.status === "retry_wait") {
    if (job.retryStage === "probing") return "probe";
    if (job.retryStage === "qa") return "qa";
    return "render";
  }
  return null;
}

export function isSchedulerRunnable(job) {
  return !job.reconciliation?.required && schedulerStage(job) !== null;
}

function queueSequence(job) {
  return job.scheduling?.enqueueSequence ?? Number.MAX_SAFE_INTEGER;
}

export class DurableFairScheduler {
  constructor({
    store,
    clock = () => Date.now(),
    priorityWheel = DEFAULT_PRIORITY_WHEEL,
    starvationDispatchThreshold = 64
  } = {}) {
    if (!store) throw new TypeError("store is required");
    if (!Array.isArray(priorityWheel) || priorityWheel.length === 0) {
      throw new TypeError("priorityWheel must be a non-empty array");
    }
    for (const value of priorityWheel) {
      if (!PRIORITY_CLASSES.includes(value)) throw new TypeError(`unknown priority class: ${value}`);
    }
    if (!Number.isInteger(starvationDispatchThreshold) || starvationDispatchThreshold < 1) {
      throw new TypeError("starvationDispatchThreshold must be a positive integer");
    }
    this.store = store;
    this.clock = clock;
    this.priorityWheel = [...priorityWheel];
    this.starvationDispatchThreshold = starvationDispatchThreshold;
  }

  select(jobs, limit, excludedIds = new Set()) {
    if (!Number.isInteger(limit) || limit < 1) return [];
    const queues = Object.fromEntries(PRIORITY_CLASSES.map((name) => [name, []]));
    for (const job of jobs) {
      if (excludedIds.has(job.id) || !isSchedulerRunnable(job)) continue;
      const priority = job.scheduling?.priorityClass ?? "normal";
      if (!queues[priority]) throw runtimeError("state_corrupt", `unknown persisted priority: ${priority}`);
      queues[priority].push(job);
    }
    for (const priority of PRIORITY_CLASSES) {
      queues[priority].sort((a, b) => queueSequence(a) - queueSequence(b) || a.id.localeCompare(b.id));
    }

    const selected = [];
    let state = this.store.getSchedulerState();
    let cursor = state.fairCursor % this.priorityWheel.length;
    let dispatchSequence = state.dispatchSequence;

    while (selected.length < limit && PRIORITY_CLASSES.some((name) => queues[name].length > 0)) {
      let chosen = null;
      let chosenSlot = -1;
      for (let offset = 0; offset < this.priorityWheel.length; offset += 1) {
        const slot = (cursor + offset) % this.priorityWheel.length;
        const priority = this.priorityWheel[slot];
        if (queues[priority].length > 0) {
          chosen = queues[priority].shift();
          chosenSlot = slot;
          break;
        }
      }
      if (!chosen) break;

      dispatchSequence += 1;
      cursor = (chosenSlot + 1) % this.priorityWheel.length;
      const scheduling = {
        ...chosen.scheduling,
        lastDispatchSequence: dispatchSequence,
        lastDispatchAtMs: this.clock()
      };
      const telemetry = {
        ...chosen.telemetry,
        scheduler: {
          queueAgeMs: Math.max(
            chosen.telemetry?.scheduler?.queueAgeMs ?? 0,
            Math.max(0, this.clock() - (chosen.queuedAtMs ?? chosen.createdAtMs ?? this.clock()))
          ),
          resourceWaitMs: chosen.telemetry?.scheduler?.resourceWaitMs ?? 0,
          dispatches: (chosen.telemetry?.scheduler?.dispatches ?? 0) + 1,
          starvationCount: chosen.telemetry?.scheduler?.starvationCount ?? 0
        }
      };
      const waitedDispatches = Math.max(
        0,
        dispatchSequence - (chosen.scheduling?.enqueuedDispatchSequence ?? 0)
      );
      if (waitedDispatches >= this.starvationDispatchThreshold) {
        telemetry.scheduler.starvationCount += 1;
      }
      selected.push(this.store.put({ ...chosen, scheduling, telemetry }));
    }

    this.store.updateSchedulerState({
      fairCursor: cursor,
      dispatchSequence
    });
    return selected;
  }
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function buildSchedulerDiagnostics({
  jobs,
  queueLimit,
  resourceSnapshot,
  schedulerState,
  nowMs
}) {
  const queued = jobs.filter((job) =>
    !job.reconciliation?.required &&
    (job.status === "queued" || job.status === "retry_wait" || job.status === "probing" || job.status === "qa")
  );
  const queueAges = queued.map((job) =>
    Math.max(0, nowMs - (job.queuedAtMs ?? job.createdAtMs ?? nowMs))
  );
  const byPriority = { high: 0, normal: 0, low: 0 };
  for (const job of queued) byPriority[job.scheduling?.priorityClass ?? "normal"] += 1;

  const schedulerTelemetry = jobs.map((job) => job.telemetry?.scheduler ?? {});
  const terminal = jobs.filter((job) => ["succeeded", "failed", "cancelled"].includes(job.status));
  const completedTimes = terminal
    .map((job) => job.history?.at?.(-1)?.atMs)
    .filter((value) => Number.isFinite(value));
  const createdTimes = jobs
    .map((job) => job.createdAtMs)
    .filter((value) => Number.isFinite(value));
  const startMs = createdTimes.length ? Math.min(...createdTimes) : nowMs;
  const elapsedMs = Math.max(1, nowMs - startMs);

  return {
    contractVersion: MEDIA_SCHEDULER_DIAGNOSTICS_VERSION,
    queue: {
      depth: queued.length,
      limit: queueLimit,
      saturated: queued.length >= queueLimit,
      byPriority,
      oldestAgeMs: queueAges.length ? Math.max(...queueAges) : 0,
      averageAgeMs: average(queueAges)
    },
    fairness: {
      priorityWheel: [...DEFAULT_PRIORITY_WHEEL],
      dispatchSequence: schedulerState.dispatchSequence,
      starvationCount: schedulerTelemetry.reduce(
        (total, item) => total + (item.starvationCount ?? 0),
        0
      )
    },
    resources: resourceSnapshot,
    throughput: {
      terminalJobs: terminal.length,
      succeededJobs: terminal.filter((job) => job.status === "succeeded").length,
      elapsedMs,
      jobsPerSecond: terminal.length * 1000 / elapsedMs,
      lastCompletionAtMs: completedTimes.length ? Math.max(...completedTimes) : null
    },
    waits: {
      averageResourceWaitMs: average(
        schedulerTelemetry.map((item) => item.resourceWaitMs ?? 0)
      ),
      maxResourceWaitMs: schedulerTelemetry.length
        ? Math.max(...schedulerTelemetry.map((item) => item.resourceWaitMs ?? 0))
        : 0
    }
  };
}
