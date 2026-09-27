const TRANSITIONS = {
  queued: { start: "planning", fail: "failed" },
  planning: { planned: "rendering", fail: "failed" },
  rendering: { rendered: "qa", fail: "failed" },
  qa: { qa_passed: "completed", qa_failed: "failed", fail: "failed" },
  completed: {},
  failed: {}
};

export function createRenderJob({ id, timelineId, outputPath }) {
  if (!id || !timelineId || !outputPath) throw new TypeError("id, timelineId and outputPath are required");
  return {
    id,
    timelineId,
    outputPath,
    status: "queued",
    attempt: 0,
    events: [{ type: "created", status: "queued" }]
  };
}

export function transitionRenderJob(job, event, payload = {}) {
  const next = TRANSITIONS[job.status]?.[event];
  if (!next) throw new Error(`invalid render job transition: ${job.status} -> ${event}`);
  const attempt = event === "start" ? job.attempt + 1 : job.attempt;
  return {
    ...job,
    ...payload,
    status: next,
    attempt,
    events: [...job.events, { type: event, status: next }]
  };
}

export function buildExportMetadata({ job, plan, probe, qa, completedAt = null }) {
  if (job.status !== "completed") throw new Error("export metadata requires a completed render job");
  return {
    schemaVersion: 1,
    jobId: job.id,
    timelineId: job.timelineId,
    outputPath: job.outputPath,
    renderFingerprint: plan.fingerprint,
    media: {
      durationMs: probe.durationMs,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio === true,
      videoCodec: probe.videoCodec ?? null,
      audioCodec: probe.audioCodec ?? null
    },
    qa: { passed: qa.passed, checks: qa.checks },
    completedAt
  };
}
