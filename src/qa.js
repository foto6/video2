import { expectedMediaShape } from "./timeline.js";

function check(name, pass, actual, expected) {
  return { name, pass: Boolean(pass), actual, expected };
}

export function evaluateRenderQa(timeline, probe, thresholds = {}) {
  const expected = expectedMediaShape(timeline);
  const durationToleranceMs = thresholds.durationToleranceMs ?? 100;
  const maxBlackFrameRatio = thresholds.maxBlackFrameRatio ?? 0.98;
  const maxSilenceRatio = thresholds.maxSilenceRatio ?? 0.98;
  const checks = [
    check("video-present", probe.hasVideo === true, probe.hasVideo, true),
    check("width", probe.width === expected.width, probe.width, expected.width),
    check("height", probe.height === expected.height, probe.height, expected.height),
    check("fps", Math.abs((probe.fps ?? 0) - expected.fps) < 0.01, probe.fps, expected.fps),
    check("duration", Math.abs((probe.durationMs ?? 0) - expected.durationMs) <= durationToleranceMs, probe.durationMs, expected.durationMs),
    check("audio-present", !expected.hasAudio || probe.hasAudio === true, probe.hasAudio, expected.hasAudio)
  ];
  if (probe.blackFrameRatio !== undefined) {
    checks.push(check("black-frame-ratio", probe.blackFrameRatio <= maxBlackFrameRatio, probe.blackFrameRatio, `<=${maxBlackFrameRatio}`));
  }
  if (expected.hasAudio && probe.silenceRatio !== undefined) {
    checks.push(check("silence-ratio", probe.silenceRatio <= maxSilenceRatio, probe.silenceRatio, `<=${maxSilenceRatio}`));
  }
  return {
    passed: checks.every((entry) => entry.pass),
    checks,
    expected
  };
}
