import { expectedMediaShape } from "./timeline.js";
import { isShortformR11Timeline, SHORTFORM_R11_PROFILE } from "./shortform-profile.js";

function check(name, pass, actual, expected, details = null) {
  return { name, pass: Boolean(pass), actual, expected, ...(details ? { details } : {}) };
}

function declaredSources(timeline) {
  const out = new Map();
  for (const track of timeline.tracks ?? []) {
    for (const item of track.items ?? []) {
      if (!item.source?.uri) continue;
      if (!out.has(item.source.uri)) {
        out.set(item.source.uri, {
          uri: item.source.uri,
          sourceId: item.source.id ?? item.id,
          sha256: item.source.sha256 ?? null,
          size: item.source.size ?? null,
          expectedKind: track.kind === "audio" ? "audio" : "video"
        });
      }
    }
  }
  return [...out.values()];
}

function captionSafeArea(timeline) {
  const failures = [];
  const safe = SHORTFORM_R11_PROFILE.safeArea;
  const width = timeline.canvas.width;
  const height = timeline.canvas.height;
  const minX = safe.left;
  const maxX = width - safe.right;
  const minY = safe.top;
  const maxY = height - safe.bottom;

  for (const track of timeline.tracks ?? []) {
    if (track.kind !== "caption") continue;
    for (const item of track.items ?? []) {
      const style = item.style ?? {};
      const fontSize = style.fontSize ?? 64;
      const lineHeight = style.lineHeight ?? Math.ceil(fontSize * 1.25);
      const estimatedWidth = Math.min(style.maxWidth ?? width, Math.ceil(item.text.length * fontSize * 0.6));
      const estimatedHeight = lineHeight * Math.max(1, String(item.text).split("\n").length);
      const x = Number.isFinite(style.x) ? style.x : Math.round((width - estimatedWidth) / 2);
      const y = Number.isFinite(style.y) ? style.y : height - safe.bottom - estimatedHeight;
      if (x < minX || y < minY || x + estimatedWidth > maxX || y + estimatedHeight > maxY) {
        failures.push({ itemId: item.id, x, y, width: estimatedWidth, height: estimatedHeight });
      }
    }
  }
  return failures;
}

function sourceQa(timeline, evidence) {
  const declared = declaredSources(timeline);
  const byUri = new Map((evidence ?? []).map((entry) => [entry.uri, entry]));
  const failures = [];
  for (const source of declared) {
    const actual = byUri.get(source.uri);
    if (!actual) {
      failures.push({ sourceId: source.sourceId, reason: "evidence_missing" });
      continue;
    }
    if (actual.exists !== true) failures.push({ sourceId: source.sourceId, reason: "asset_missing" });
    if (actual.probeOk !== true) failures.push({ sourceId: source.sourceId, reason: "asset_corrupt_or_wrong_stream" });
    if (source.sha256 && actual.sha256 !== source.sha256) failures.push({ sourceId: source.sourceId, reason: "sha256_mismatch" });
    if (source.size !== null && actual.size !== source.size) failures.push({ sourceId: source.sourceId, reason: "size_mismatch" });
  }
  return { declared: declared.length, observed: evidence?.length ?? 0, failures };
}

export function evaluateRenderQa(timeline, probe, thresholds = {}) {
  const expected = expectedMediaShape(timeline);
  const r11 = isShortformR11Timeline(timeline);
  const durationToleranceMs = thresholds.durationToleranceMs ?? 120;
  const maxBlackFrameRatio = thresholds.maxBlackFrameRatio ?? (r11 ? 0.4 : 0.98);
  const maxSilenceRatio = thresholds.maxSilenceRatio ?? (r11 ? 0.65 : 0.98);
  const maxFreezeDurationMs = thresholds.maxFreezeDurationMs ?? 1500;
  const maxPeakDb = thresholds.maxPeakDb ?? -0.5;
  const checks = [
    check("video-present", probe.hasVideo === true, probe.hasVideo, true),
    check("width", probe.width === expected.width, probe.width, expected.width),
    check("height", probe.height === expected.height, probe.height, expected.height),
    check("fps", Math.abs((probe.fps ?? 0) - expected.fps) < 0.01, probe.fps, expected.fps),
    check("duration", Math.abs((probe.durationMs ?? 0) - expected.durationMs) <= durationToleranceMs, probe.durationMs, expected.durationMs),
    check("audio-present", !expected.hasAudio || probe.hasAudio === true, probe.hasAudio, expected.hasAudio)
  ];
  if (probe.outputSize !== undefined) checks.push(check("non-empty-output", probe.outputSize > 0, probe.outputSize, ">0"));
  if (probe.probeCorrupt !== undefined) checks.push(check("probe-readable", probe.probeCorrupt === false, probe.probeCorrupt, false));
  if (probe.analysisComplete !== undefined) checks.push(check("analysis-complete", probe.analysisComplete === true, probe.analysisComplete, true));
  if (probe.blackFrameRatio !== undefined) {
    checks.push(check("black-frame-ratio", probe.blackFrameRatio <= maxBlackFrameRatio, probe.blackFrameRatio, `<=${maxBlackFrameRatio}`));
  }
  if (probe.maxFreezeDurationMs !== undefined) {
    checks.push(check("frozen-frame-duration", probe.maxFreezeDurationMs <= maxFreezeDurationMs, probe.maxFreezeDurationMs, `<=${maxFreezeDurationMs}`));
  }
  if (expected.hasAudio && probe.silenceRatio !== undefined) {
    checks.push(check("silence-ratio", probe.silenceRatio <= maxSilenceRatio, probe.silenceRatio, `<=${maxSilenceRatio}`));
  }
  if (expected.hasAudio && probe.peakDb !== undefined && Number.isFinite(probe.peakDb)) {
    checks.push(check("audio-peak", probe.peakDb <= maxPeakDb, probe.peakDb, `<=${maxPeakDb}dB`));
  }
  if (probe.clippedSampleRatio !== undefined) {
    checks.push(check("audio-clipping", probe.clippedSampleRatio === 0, probe.clippedSampleRatio, 0));
  }
  if (r11) {
    const source = sourceQa(timeline, probe.sourceEvidence);
    checks.push(check("source-assets-provenance", source.failures.length === 0, source.failures.length, 0, source));
    const unsafe = captionSafeArea(timeline);
    checks.push(check("subtitle-safe-area", unsafe.length === 0, unsafe.length, 0, { failures: unsafe }));
  }
  return {
    passed: checks.every((entry) => entry.pass),
    checks,
    expected
  };
}
