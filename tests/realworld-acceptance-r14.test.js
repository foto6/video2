import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MEDIA_R14_ACCEPTANCE_VERSION,
  acceptanceMetrics,
  classifyMvpAcceptance,
  summarizeMvpAcceptance
} from "../src/acceptance-r14.js";
import {
  MEDIA_SHORTFORM_PROFILE_VERSION,
  compileCreativeEditPlan
} from "../src/index.js";

test("R14 corpus covers all required real-world shapes and both creative styles", () => {
  const corpus = JSON.parse(readFileSync(
    new URL("./fixtures/r14-acceptance/corpus.json", import.meta.url),
    "utf8"
  ));
  assert.equal(corpus.corpusVersion, "media.r14.acceptance_corpus.v1");
  assert.equal(corpus.cases.length >= 7, true);
  const ids = new Set(corpus.cases.map((entry) => entry.id));
  for (const id of [
    "talking-head-pauses",
    "landscape-reframe",
    "fast-motion",
    "low-motion",
    "speech-music",
    "subtitle-heavy",
    "broll-insert"
  ]) assert.equal(ids.has(id), true, id);

  for (const entry of corpus.cases) {
    assert.equal(entry.styles.includes("clean_podcast"), true, entry.id);
    assert.equal(entry.styles.includes("aggressive_shortform"), true, entry.id);
    assert.equal(Array.isArray(entry.humanReview) && entry.humanReview.length > 0, true, entry.id);
  }
});

test("R14 separates objective FAIL from human-aesthetic WARN", () => {
  const technicalQa = {
    passed: true,
    checks: [
      { name: "subtitle-safe-area", pass: true },
      { name: "black-frame-ratio", pass: true }
    ]
  };
  const creativeQuality = {
    passed: true,
    metrics: {
      durationMs: 6000,
      cutRatePerSecond: 0.8,
      zoomRatePerSecond: 0.2,
      textCharsPerSecond: 12
    },
    guardrails: [{ name: "cut-rate", pass: true }],
    visualQa: {
      passed: true,
      checks: [
        { name: "creative-unsafe-crop", pass: true },
        { name: "creative-text-collision", pass: true }
      ]
    }
  };
  const probe = {
    durationMs: 6000,
    blackFrameRatio: 0,
    maxFreezeDurationMs: 0,
    silenceRatio: 0.2,
    meanDb: -18,
    peakDb: -2,
    width: 1080,
    height: 1920,
    fps: 30
  };

  const warn = classifyMvpAcceptance({
    renderSucceeded: true,
    sourcePreserved: true,
    technicalQa,
    creativeQuality,
    probe,
    humanReviewReasons: ["Judge whether pacing feels natural."]
  });
  assert.equal(warn.status, "WARN");
  assert.equal(warn.failures.length, 0);
  assert.equal(warn.warnings.some((entry) => entry.code === "human_aesthetic_review"), true);

  const fail = classifyMvpAcceptance({
    renderSucceeded: true,
    sourcePreserved: false,
    technicalQa: { ...technicalQa, passed: false, checks: [{ name: "black-frame-ratio", pass: false }] },
    creativeQuality,
    probe
  });
  assert.equal(fail.status, "FAIL");
  assert.equal(fail.failures.some((entry) => entry.code === "source_mutated"), true);
  assert.equal(fail.failures.some((entry) => entry.code === "technical:black-frame-ratio"), true);
});

test("R14 acceptance metrics include pacing, black/freeze/silence, crop/safe-area and loudness", () => {
  const metrics = acceptanceMetrics({
    probe: {
      durationMs: 6100,
      blackFrameRatio: 0.01,
      maxFreezeDurationMs: 300,
      silenceRatio: 0.2,
      meanDb: -17,
      peakDb: -1.8,
      width: 1080,
      height: 1920,
      fps: 30
    },
    technicalQa: {
      checks: [{ name: "subtitle-safe-area", pass: true }]
    },
    creativeQuality: {
      metrics: {
        cutRatePerSecond: 0.7,
        zoomRatePerSecond: 0.15,
        textCharsPerSecond: 10
      },
      visualQa: {
        checks: [
          { name: "creative-unsafe-crop", pass: true },
          { name: "creative-text-collision", pass: true }
        ]
      }
    }
  });
  assert.deepEqual(metrics, {
    durationMs: 6100,
    cutRatePerSecond: 0.7,
    motionRatePerSecond: 0.15,
    textCharsPerSecond: 10,
    blackFrameRatio: 0.01,
    maxFreezeDurationMs: 300,
    silenceRatio: 0.2,
    meanDb: -17,
    peakDb: -1.8,
    subtitleSafeAreaPassed: true,
    unsafeCropPassed: true,
    textCollisionPassed: true,
    width: 1080,
    height: 1920,
    fps: 30
  });
});

test("R14 machine summary binds exact producer SHA and preserves all failures/warnings", () => {
  const summary = summarizeMvpAcceptance({
    producerSha: "a".repeat(40),
    sourceRoot: "/input",
    outputRoot: "/output",
    results: [
      {
        caseId: "one",
        style: "clean_podcast",
        acceptance: {
          status: "WARN",
          failures: [],
          warnings: [{ code: "human_aesthetic_review", message: "review it" }]
        }
      },
      {
        caseId: "two",
        style: "aggressive_shortform",
        acceptance: {
          status: "FAIL",
          failures: [{ code: "render_failed", message: "failed" }],
          warnings: []
        }
      }
    ]
  });
  assert.equal(summary.summaryVersion, MEDIA_R14_ACCEPTANCE_VERSION);
  assert.equal(summary.producer.sha, "a".repeat(40));
  assert.equal(summary.status, "FAIL");
  assert.deepEqual(summary.counts, { pass: 0, warn: 1, fail: 1 });
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.warnings.length, 1);
});


test("R14 regression: dead-air tightening cannot shrink below the R11 five-second minimum", () => {
  const timeline = {
    id: "r14-dead-air-minimum",
    version: 1,
    profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
    canvas: { width: 1080, height: 1920, fps: 30, durationMs: 6000 },
    tracks: [{
      id: "video",
      kind: "video",
      items: [{
        id: "main",
        startMs: 0,
        endMs: 6000,
        role: "body",
        source: {
          id: "source",
          uri: "input.mp4",
          inMs: 0,
          outMs: 6000,
          sha256: "a".repeat(64),
          size: 100
        }
      }]
    }]
  };
  const result = compileCreativeEditPlan({
    style: "aggressive_shortform",
    timeline,
    cta: false,
    hints: {
      silenceRanges: [
        { startMs: 1200, endMs: 2100 },
        { startMs: 3000, endMs: 4100 }
      ],
      sentenceBoundariesMs: [0, 1100, 2200, 2900, 4200, 6000]
    }
  });
  assert.equal(result.timeline.canvas.durationMs >= 5000, true);
  const removed = result.timeline.creativePlan.removedDeadAir
    .reduce((sum, range) => sum + range.endMs - range.startMs, 0);
  assert.equal(removed <= 1000, true);
});
