import test from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_SHORTFORM_PROFILE_VERSION,
  SHORTFORM_R11_PROFILE,
  buildRenderPlan,
  compileFfmpegCommand,
  evaluateRenderQa,
  evaluateShortformSourceProvenance,
  validateShortformR11Contract
} from "../src/index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const V = "v".repeat(64).replaceAll("v", "c");
const M = "d".repeat(64);

function r11Timeline() {
  return {
    id: "r11-unit",
    version: 1,
    profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
    canvas: { width: 1080, height: 1920, fps: 30, durationMs: 8000 },
    tracks: [
      {
        id: "video",
        kind: "video",
        items: [
          {
            id: "video-a", startMs: 0, endMs: 4000, role: "intro", speed: 1.25,
            source: { id: "source-a", uri: "a.mp4", inMs: 0, sha256: A, size: 101 },
            reframe: { x: 0, y: 0 }, transitionOut: { type: "fade", durationMs: 350 }, fadeInMs: 200
          },
          {
            id: "video-b", startMs: 4000, endMs: 8000, role: "outro",
            source: { id: "source-b", uri: "b.mp4", inMs: 0, sha256: B, size: 102 },
            crop: { width: 1080, height: 1920, x: 0, y: 0 }, fadeOutMs: 200
          }
        ]
      },
      {
        id: "captions", kind: "caption",
        items: [{ id: "caption-1", startMs: 500, endMs: 3400, text: "R11 subtitles", style: { fontSize: 64, y: 1450, maxWidth: 900 } }]
      },
      {
        id: "overlay", kind: "overlay",
        items: [{ id: "cta", startMs: 6200, endMs: 7900, role: "cta", text: "SAVE + SHARE", position: { x: 120, y: 300 } }]
      },
      {
        id: "audio", kind: "audio",
        items: [
          { id: "voice", startMs: 0, endMs: 8000, role: "voiceover", source: { id: "voice-src", uri: "voice.wav", sha256: V, size: 103 }, gainDb: -3, fadeInMs: 100, fadeOutMs: 100 },
          { id: "music", startMs: 0, endMs: 8000, role: "music", source: { id: "music-src", uri: "music.wav", sha256: M, size: 104 }, gainDb: -18, duckUnderVoice: true }
        ]
      }
    ]
  };
}

function sourceEvidence() {
  return [
    { uri: "a.mp4", sourceId: "source-a", exists: true, probeOk: true, sha256: A, size: 101 },
    { uri: "b.mp4", sourceId: "source-b", exists: true, probeOk: true, sha256: B, size: 102 },
    { uri: "voice.wav", sourceId: "voice-src", exists: true, probeOk: true, sha256: V, size: 103 },
    { uri: "music.wav", sourceId: "music-src", exists: true, probeOk: true, sha256: M, size: 104 }
  ];
}

test("R11 profile is exact 1080x1920 9:16 with stable safe area and hook window", () => {
  const contract = validateShortformR11Contract(r11Timeline());
  assert.equal(contract.contractVersion, "media.shortform_editor.r11.v1");
  assert.equal(contract.profile.width, 1080);
  assert.equal(contract.profile.height, 1920);
  assert.equal(contract.profile.aspectRatio, "9:16");
  assert.equal(contract.profile.hookWindowMs, 3000);
  assert.match(contract.timelineSha256, /^[a-f0-9]{64}$/);
});

test("R11 FFmpeg graph covers speed, cuts/transition, fades, overlays, subtitles, ducking and loudness", () => {
  const command = compileFfmpegCommand(r11Timeline(), {
    format: "mp4",
    loudness: { integratedLufs: -16, truePeakDb: -1.5, lra: 11 }
  }, ".output.mp4.job.partial");
  const text = command.args.join(" ");
  assert.match(text, /setpts=\(PTS-STARTPTS\)\/1.25/);
  assert.match(text, /xfade=transition=fade/);
  assert.match(text, /fade=t=in/);
  assert.match(text, /drawtext=text=/);
  assert.match(text, /sidechaincompress=/);
  assert.match(text, /loudnorm=I=-16:TP=-1.5:LRA=11/);
  assert.match(text, /-f mp4 \.output\.mp4\.job\.partial$/);
});

test("render fingerprint binds R11 source hashes and richer editing operations", () => {
  const first = buildRenderPlan(r11Timeline(), {});
  const changed = r11Timeline();
  changed.tracks.find((track) => track.kind === "video").items[0].source.sha256 = "e".repeat(64);
  const second = buildRenderPlan(changed, {});
  assert.notEqual(first.fingerprint, second.fingerprint);
  const types = new Set(first.operations.map((entry) => entry.type));
  for (const type of ["time.speed", "video.fade", "audio.fade", "audio.mix", "caption.render", "overlay.compose", "transition.apply"]) {
    assert.equal(types.has(type), true, `missing ${type}`);
  }
});

test("machine QA passes clean evidence and fails provenance, freeze, loudness and subtitle-safe-area defects", () => {
  const timeline = r11Timeline();
  const good = evaluateRenderQa(timeline, {
    hasVideo: true, hasAudio: true, width: 1080, height: 1920, fps: 30, durationMs: 8000,
    outputSize: 1000, probeCorrupt: false, analysisComplete: true,
    blackFrameRatio: 0.01, maxFreezeDurationMs: 300, silenceRatio: 0.05, peakDb: -1.6,
    sourceEvidence: sourceEvidence()
  });
  assert.equal(good.passed, true, JSON.stringify(good.checks));

  const badEvidence = sourceEvidence();
  badEvidence[0] = { ...badEvidence[0], sha256: "f".repeat(64) };
  const unsafe = r11Timeline();
  unsafe.tracks.find((track) => track.kind === "caption").items[0].style.y = 1750;
  const bad = evaluateRenderQa(unsafe, {
    hasVideo: true, hasAudio: true, width: 1080, height: 1920, fps: 30, durationMs: 8000,
    outputSize: 1000, probeCorrupt: false, analysisComplete: true,
    blackFrameRatio: 0.01, maxFreezeDurationMs: 2200, silenceRatio: 0.05, peakDb: -0.1,
    sourceEvidence: badEvidence
  });
  assert.equal(bad.passed, false);
  for (const name of ["source-assets-provenance", "frozen-frame-duration", "audio-peak", "subtitle-safe-area"]) {
    assert.equal(bad.checks.some((entry) => entry.name === name && entry.pass === false), true, name);
  }
});

test("source provenance preflight is fail-closed without fabricating evidence", () => {
  const evidence = sourceEvidence();
  assert.equal(evaluateShortformSourceProvenance(evidence.map((entry) => ({ ...entry, expectedSha256: entry.sha256, expectedSize: entry.size }))).passed, true);
  const missing = evidence.map((entry) => ({ ...entry, expectedSha256: entry.sha256, expectedSize: entry.size }));
  missing[1] = { ...missing[1], exists: false, error: "source_missing" };
  const result = evaluateShortformSourceProvenance(missing);
  assert.equal(result.passed, false);
  assert.equal(result.failures.some((entry) => entry.reason === "source_missing"), true);
});

void SHORTFORM_R11_PROFILE;
