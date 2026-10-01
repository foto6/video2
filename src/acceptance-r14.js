export const MEDIA_R14_ACCEPTANCE_VERSION = "media.realworld_mvp_acceptance.r14.v1";

function add(list, code, message, details = null) {
  list.push({ code, message, ...(details === null ? {} : { details }) });
}

export function acceptanceMetrics({ probe = {}, creativeQuality = null } = {}) {
  const metrics = creativeQuality?.metrics ?? {};
  return {
    durationMs: probe.durationMs ?? metrics.durationMs ?? null,
    cutRatePerSecond: metrics.cutRatePerSecond ?? null,
    motionRatePerSecond: metrics.zoomRatePerSecond ?? null,
    textCharsPerSecond: metrics.textCharsPerSecond ?? null,
    blackFrameRatio: probe.blackFrameRatio ?? null,
    maxFreezeDurationMs: probe.maxFreezeDurationMs ?? null,
    silenceRatio: probe.silenceRatio ?? null,
    peakDb: Number.isFinite(probe.peakDb) ? probe.peakDb : null,
    width: probe.width ?? null,
    height: probe.height ?? null,
    fps: probe.fps ?? null
  };
}

export function classifyMvpAcceptance({
  renderSucceeded,
  sourcePreserved,
  technicalQa,
  creativeQuality,
  probe,
  humanReviewReasons = []
} = {}) {
  const failures = [];
  const warnings = [];
  const metrics = acceptanceMetrics({ probe, creativeQuality });

  if (renderSucceeded !== true) add(failures, "render_failed", "Render did not complete successfully.");
  if (sourcePreserved !== true) add(failures, "source_mutated", "One or more source files changed during acceptance.");

  if (technicalQa?.passed !== true) {
    add(failures, "technical_qa_failed", "Technical QA did not pass.");
  }
  for (const check of technicalQa?.checks ?? []) {
    if (check.pass !== true) add(failures, `technical:${check.name}`, `Technical check failed: ${check.name}`, check);
  }

  if (creativeQuality?.passed !== true) {
    add(failures, "creative_quality_failed", "Creative guardrail or visual QA did not pass.");
  }
  for (const check of creativeQuality?.guardrails ?? []) {
    if (check.pass !== true) add(failures, `guardrail:${check.name}`, `Creative guardrail failed: ${check.name}`, check);
  }
  for (const check of creativeQuality?.visualQa?.checks ?? []) {
    if (check.pass !== true) add(failures, `visual:${check.name}`, `Creative visual QA failed: ${check.name}`, check);
  }

  if (Number.isFinite(metrics.blackFrameRatio) && metrics.blackFrameRatio > 0.15) {
    add(warnings, "near_black_frame_limit", "Black-frame ratio is elevated and should be visually checked.", metrics.blackFrameRatio);
  }
  if (Number.isFinite(metrics.maxFreezeDurationMs) && metrics.maxFreezeDurationMs > 750) {
    add(warnings, "near_freeze_limit", "A long low-motion/frozen interval should be visually checked.", metrics.maxFreezeDurationMs);
  }
  if (Number.isFinite(metrics.silenceRatio) && metrics.silenceRatio > 0.35) {
    add(warnings, "high_silence_ratio", "Silence ratio is high but still within technical acceptance.", metrics.silenceRatio);
  }
  if (Number.isFinite(metrics.peakDb) && metrics.peakDb > -1.0) {
    add(warnings, "near_audio_peak_limit", "Audio peak is close to the technical ceiling.", metrics.peakDb);
  }
  if (Number.isFinite(metrics.cutRatePerSecond) && metrics.cutRatePerSecond > 1.0) {
    add(warnings, "dense_cut_pacing", "Cut pacing is dense and requires human aesthetic review.", metrics.cutRatePerSecond);
  }
  if (Number.isFinite(metrics.motionRatePerSecond) && metrics.motionRatePerSecond > 0.24) {
    add(warnings, "dense_motion_pacing", "Added motion is near the creative guardrail and requires visual review.", metrics.motionRatePerSecond);
  }
  if (Number.isFinite(metrics.textCharsPerSecond) && metrics.textCharsPerSecond > 18) {
    add(warnings, "dense_text", "Text density is high and requires phone-size readability review.", metrics.textCharsPerSecond);
  }

  for (const reason of humanReviewReasons) {
    if (typeof reason === "string" && reason.trim()) {
      add(warnings, "human_aesthetic_review", reason.trim());
    }
  }

  return {
    status: failures.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS",
    failures,
    warnings,
    metrics
  };
}

export function summarizeMvpAcceptance({ producerSha, sourceRoot, outputRoot, results } = {}) {
  if (typeof producerSha !== "string" || !/^[a-f0-9]{40}$/.test(producerSha)) {
    throw new TypeError("producerSha must be an exact Git SHA");
  }
  if (!Array.isArray(results) || results.length === 0) throw new TypeError("acceptance results are required");
  const failures = results.flatMap((entry) =>
    (entry.acceptance?.failures ?? []).map((failure) => ({
      caseId: entry.caseId,
      style: entry.style,
      ...failure
    }))
  );
  const warnings = results.flatMap((entry) =>
    (entry.acceptance?.warnings ?? []).map((warning) => ({
      caseId: entry.caseId,
      style: entry.style,
      ...warning
    }))
  );
  return {
    summaryVersion: MEDIA_R14_ACCEPTANCE_VERSION,
    producer: { repository: "foto6/video2", sha: producerSha },
    sourceRoot,
    outputRoot,
    resultCount: results.length,
    status: failures.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS",
    counts: {
      pass: results.filter((entry) => entry.acceptance?.status === "PASS").length,
      warn: results.filter((entry) => entry.acceptance?.status === "WARN").length,
      fail: results.filter((entry) => entry.acceptance?.status === "FAIL").length
    },
    failures,
    warnings,
    results
  };
}
