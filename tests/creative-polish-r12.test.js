import test from "node:test";
import assert from "node:assert/strict";

import {
  CREATIVE_STYLES,
  MEDIA_CREATIVE_EDIT_PLAN_VERSION,
  MEDIA_CREATIVE_QUALITY_REPORT_VERSION,
  MEDIA_SHORTFORM_PROFILE_VERSION,
  R12_GUARDRAILS,
  buildRenderPlan,
  compileCreativeEditPlan,
  compileFfmpegCommand,
  createCreativeHintAdapters,
  evaluateCreativeQuality,
  evaluateCreativeVisualQa
} from "../src/index.js";

const MAIN = "a".repeat(64);
const VOICE = "b".repeat(64);
const MUSIC = "c".repeat(64);
const BROLL = "d".repeat(64);

function baseTimeline() {
  return {
    id: "r12-base",
    version: 1,
    profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
    canvas: { width: 1080, height: 1920, fps: 30, durationMs: 12000 },
    tracks: [
      {
        id: "video", kind: "video",
        items: [{
          id: "main", startMs: 0, endMs: 12000, role: "body",
          source: { id: "main-source", uri: "main.mp4", inMs: 0, outMs: 12000, sha256: MAIN, size: 1000 }
        }]
      },
      {
        id: "audio", kind: "audio",
        items: [
          {
            id: "voice", startMs: 0, endMs: 12000, role: "voiceover",
            source: { id: "voice-source", uri: "voice.wav", inMs: 0, outMs: 12000, sha256: VOICE, size: 1000 },
            gainDb: -3
          },
          {
            id: "music", startMs: 0, endMs: 12000, role: "music",
            source: { id: "music-source", uri: "music.wav", inMs: 0, outMs: 12000, sha256: MUSIC, size: 1000 },
            gainDb: -6
          }
        ]
      },
      {
        id: "captions", kind: "caption",
        items: [
          { id: "cap-a", startMs: 300, endMs: 2200, text: "Start with the result" },
          { id: "cap-b", startMs: 4300, endMs: 6200, text: "Then explain the proof" }
        ]
      }
    ]
  };
}

function hints() {
  return {
    silenceRanges: [
      { startMs: 3200, endMs: 3900 },
      { startMs: 7300, endMs: 8000 }
    ],
    sentenceBoundariesMs: [0, 3100, 4000, 7200, 8100, 12000],
    beatMarkersMs: Array.from({ length: 24 }, (_, index) => index * 500),
    saliency: [
      { startMs: 0, endMs: 6000, centerX: 0.42, centerY: 0.46, confidence: 0.95 },
      { startMs: 6000, endMs: 12000, centerX: 0.58, centerY: 0.44, confidence: 0.92 }
    ],
    brollCandidates: [{
      id: "broll-proof",
      score: 0.9,
      durationMs: 3000,
      source: { id: "broll-source", uri: "broll.mp4", inMs: 0, sha256: BROLL, size: 900 }
    }],
    captionTokens: [
      { text: "RESULT", startMs: 250, endMs: 1100, emphasis: true },
      { text: "then the proof", startMs: 1150, endMs: 2400 },
      { text: "remove dead air", startMs: 4200, endMs: 5600, emphasis: true },
      { text: "finish clean", startMs: 8200, endMs: 9600 }
    ]
  };
}

test("R12 exposes three distinct deterministic creative styles", () => {
  assert.deepEqual(Object.keys(CREATIVE_STYLES).sort(), [
    "aggressive_shortform", "cinematic_minimal", "clean_podcast"
  ]);
  const results = Object.keys(CREATIVE_STYLES).map((style) => compileCreativeEditPlan({
    style, timeline: baseTimeline(), hints: hints(), ctaText: "KEEP WATCHING"
  }));
  assert.equal(new Set(results.map((entry) => entry.planDigest)).size, 3);
  assert.equal(new Set(results.map((entry) => buildRenderPlan(entry.timeline).fingerprint)).size, 3);
  for (const result of results) {
    assert.equal(result.contractVersion, MEDIA_CREATIVE_EDIT_PLAN_VERSION);
    assert.equal(result.qualityReport.contractVersion, MEDIA_CREATIVE_QUALITY_REPORT_VERSION);
    assert.equal(result.qualityReport.passed, true);
    assert.equal(result.timeline.creativePlan.planDigest, result.planDigest);
  }
});

test("aggressive plan tightens silence, aligns cuts, uses saliency/B-roll and stays under hard guardrails", () => {
  const result = compileCreativeEditPlan({
    style: "aggressive_shortform",
    timeline: baseTimeline(),
    hints: hints(),
    loopFriendly: true,
    ctaText: "SAVE THIS"
  });
  assert.equal(result.timeline.canvas.durationMs < 12000, true);
  assert.equal(result.timeline.creativePlan.beatHintsUsed > 0, true);
  assert.equal(result.timeline.creativePlan.sentenceHintsUsed > 0, true);
  assert.equal(result.timeline.tracks.flatMap((track) => track.items).some((item) => item.role === "broll"), true);
  assert.equal(result.timeline.tracks.flatMap((track) => track.items).some((item) => item.role === "loop_bridge"), true);
  assert.equal(result.timeline.tracks.flatMap((track) => track.items).some((item) => item.motion), true);
  assert.equal(result.timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.items)
    .some((item) => item.reframe?.x?.includes?.("in_w-out_w")), true);
  assert.equal(result.qualityReport.metrics.cutRatePerSecond <= R12_GUARDRAILS.maxCutRatePerSecond, true);
  assert.equal(result.qualityReport.metrics.zoomRatePerSecond <= R12_GUARDRAILS.maxZoomRatePerSecond, true);
  assert.equal(result.qualityReport.metrics.musicMaxGainDb <= R12_GUARDRAILS.maxMusicGainDb, true);
});

test("metadata-free fallback is deterministic and remains source-bound", () => {
  const a = compileCreativeEditPlan({ style: "clean_podcast", timeline: baseTimeline(), hints: {} });
  const b = compileCreativeEditPlan({ style: "clean_podcast", timeline: baseTimeline(), hints: {} });
  assert.equal(a.planDigest, b.planDigest);
  assert.deepEqual(a.timeline, b.timeline);
  assert.deepEqual(a.timeline.creativePlan.deterministicFallbacks, {
    beat: true, sentence: true, saliency: true, broll: true
  });
  assert.equal(a.qualityReport.passed, true);
});

test("R12 FFmpeg output includes bounded zoompan and kinetic text without bypassing R11", () => {
  const result = compileCreativeEditPlan({
    style: "aggressive_shortform", timeline: baseTimeline(), hints: hints(), ctaText: "SAVE THIS"
  });
  const command = compileFfmpegCommand(result.timeline, { format: "mp4" }, ".r12.mp4.partial");
  const text = command.args.join(" ");
  assert.match(text, /zoompan=/);
  assert.match(text, /fontcolor=yellow/);
  assert.match(text, /sin\(8\*\(t-/);
  assert.match(text, /sidechaincompress=/);
  assert.match(text, /-f mp4 \.r12\.mp4\.partial$/);
});

test("creative visual QA catches occlusion, unsafe crop, repeated windows and transition spam", () => {
  const result = compileCreativeEditPlan({ style: "cinematic_minimal", timeline: baseTimeline(), hints: hints(), cta: false });
  const broken = structuredClone(result.timeline);
  const captions = broken.tracks.find((track) => track.kind === "caption");
  captions.items.push({
    id: "collision", startMs: captions.items[0].startMs, endMs: captions.items[0].endMs,
    text: "COLLIDE", style: { fontSize: 72, y: 1480, maxWidth: 900 }
  });
  const videos = broken.tracks.find((track) => track.kind === "video").items;
  videos[0].creativeMeta = { saliency: { centerX: 0.01, centerY: 0.5, confidence: 1 } };
  videos[0].motion = { type: "punch_in", zoom: 1.18, amplitudePx: 0 };
  if (videos.length > 1) {
    videos[1].source = { ...videos[0].source };
    videos[1].transitionOut = { type: "fade", durationMs: 100 };
  }
  for (let index = 0; index < videos.length - 1; index += 1) {
    if (index % 2 === 0) videos[index].transitionOut = { type: "fade", durationMs: 100 };
  }
  const qa = evaluateCreativeVisualQa(broken, { maxFreezeDurationMs: 2200 });
  assert.equal(qa.passed, false);
  const failed = new Set(qa.checks.filter((entry) => !entry.pass).map((entry) => entry.name));
  for (const name of [
    "creative-subtitle-occlusion", "creative-text-collision", "creative-unsafe-crop",
    "creative-repeated-source-window", "creative-repeated-frames"
  ]) assert.equal(failed.has(name), true, name);
});

test("creative quality rejects objective over-editing metrics", () => {
  const result = compileCreativeEditPlan({ style: "clean_podcast", timeline: baseTimeline(), hints: {}, cta: false });
  const broken = structuredClone(result.timeline);
  const video = broken.tracks.find((track) => track.kind === "video");
  const source = video.items[0].source;
  video.items = Array.from({ length: 20 }, (_, index) => ({
    id: `spam-${index}`,
    startMs: index * 500,
    endMs: Math.min(broken.canvas.durationMs, index * 500 + 500),
    source: { ...source, inMs: index * 500, outMs: index * 500 + 500 },
    transitionOut: index < 19 ? { type: "fade", durationMs: 50 } : undefined
  })).filter((item) => item.endMs > item.startMs);
  const report = evaluateCreativeQuality(broken);
  assert.equal(report.passed, false);
  assert.equal(report.guardrails.some((entry) => entry.name === "cut-rate" && !entry.pass), true);
  assert.equal(report.guardrails.some((entry) => entry.name === "transition-density" && !entry.pass), true);
});

test("model-assisted hints remain optional adapter boundaries", async () => {
  const calls = [];
  const adapters = createCreativeHintAdapters({
    beat: { async provide(input) { calls.push(["beat", input.id]); return [500, 1000]; } },
    saliency: { async provide(input) { calls.push(["saliency", input.id]); return []; } }
  });
  await adapters.beat.provide({ id: "x" });
  await adapters.saliency.provide({ id: "y" });
  assert.deepEqual(calls, [["beat", "x"], ["saliency", "y"]]);
  assert.equal(createCreativeHintAdapters().beat, null);
});
