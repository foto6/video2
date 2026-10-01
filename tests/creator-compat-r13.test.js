import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  MEDIA_CREATOR_CONSUMER_COMPAT_VERSION,
  MEDIA_SHORTFORM_PROFILE_VERSION,
  artifactManifestDigest,
  buildArtifactManifest,
  buildCreatorConsumerEnvelope,
  compileCreativeEditPlan,
  evaluateCreativeQuality,
  fingerprint,
  validateCreatorConsumerEnvelope
} from "../src/index.js";

function contractPins() {
  const manifest = JSON.parse(readFileSync(
    new URL("../conformance/media.creator_consumer_compat.r13.v1/manifest.json", import.meta.url),
    "utf8"
  ));
  return manifest.pins;
}

function succeededFixture() {
  const base = {
    id: "r13-consumer-fixture",
    version: 1,
    profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
    canvas: { width: 1080, height: 1920, fps: 30, durationMs: 5000 },
    tracks: [
      {
        id: "video",
        kind: "video",
        items: [{
          id: "main",
          startMs: 0,
          endMs: 5000,
          role: "body",
          source: {
            id: "main-source",
            uri: "inputs/main.mp4",
            inMs: 0,
            outMs: 5000,
            sha256: "a".repeat(64),
            size: 1234
          }
        }]
      },
      {
        id: "audio",
        kind: "audio",
        items: [{
          id: "music",
          startMs: 0,
          endMs: 5000,
          role: "music",
          source: {
            id: "music-source",
            uri: "inputs/music.wav",
            inMs: 0,
            outMs: 5000,
            sha256: "b".repeat(64),
            size: 5678
          },
          gainDb: -18
        }]
      }
    ]
  };
  const creative = compileCreativeEditPlan({
    style: "cinematic_minimal",
    timeline: base,
    hints: {},
    cta: false
  });
  const probe = {
    hasVideo: true,
    hasAudio: true,
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: 5000,
    outputSize: 4096,
    outputSha256: "c".repeat(64),
    probeCorrupt: false,
    analysisComplete: true,
    blackFrameRatio: 0,
    maxFreezeDurationMs: 0,
    silenceRatio: 0,
    meanDb: -18,
    peakDb: -2,
    sourceEvidence: [
      {
        sourceId: "main-source",
        expectedKind: "video",
        uri: "inputs/main.mp4",
        exists: true,
        local: true,
        probeOk: true,
        sha256: "a".repeat(64),
        size: 1234
      },
      {
        sourceId: "music-source",
        expectedKind: "audio",
        uri: "inputs/music.wav",
        exists: true,
        local: true,
        probeOk: true,
        sha256: "b".repeat(64),
        size: 5678
      }
    ]
  };
  const qa = {
    passed: true,
    checks: [
      { name: "video-present", pass: true, actual: true, expected: true },
      { name: "source-assets-provenance", pass: true, actual: 0, expected: 0 },
      { name: "creative-transition-spam", pass: true, actual: 0, expected: "<=0.2" }
    ],
    expected: { width: 1080, height: 1920, fps: 30, durationMs: 5000, hasAudio: true }
  };
  const job = {
    id: "r13-consumer-fixture",
    idempotencyKey: "creator:r13:fixture:1",
    status: "succeeded",
    dryRun: false,
    renderFingerprint: fingerprint({ fixture: "r13" }),
    currentAttempt: { token: "attempt-r13-fixture" },
    timeline: creative.timeline,
    exportSpec: { format: "mp4" },
    outputPath: "outputs/r13-consumer-fixture.mp4",
    probe,
    qa,
    createdAtMs: 1000
  };
  const digest = { sha256: "c".repeat(64), size: 4096 };
  const artifactManifest = buildArtifactManifest(job, {
    finalDigest: digest,
    preparedDigest: digest,
    preparedAtMs: 2000,
    finalizedAtMs: 2100,
    manifestCommittedAtMs: 2200
  });
  const creativeQualityReport = evaluateCreativeQuality(job.timeline, job.probe);
  return { job, artifactManifest, creativeQualityReport };
}

test("R13 builds exact Creator tournament envelope from succeeded QA-passing R12 artifact", () => {
  const fixture = succeededFixture();
  const producerSha = "1".repeat(40);
  const pins = contractPins();
  const envelope = buildCreatorConsumerEnvelope({
    ...fixture,
    producerSha,
    contractDigests: pins
  });
  assert.equal(envelope.contractVersion, MEDIA_CREATOR_CONSUMER_COMPAT_VERSION);
  assert.equal(envelope.logicalJobId, fixture.job.id);
  assert.equal(envelope.idempotencyKey, fixture.job.idempotencyKey);
  assert.equal(envelope.renderFingerprint, fixture.job.renderFingerprint);
  assert.equal(envelope.creativePlanDigest, fixture.job.timeline.creativePlan.planDigest);
  assert.equal(envelope.finalContent.sha256, "c".repeat(64));
  assert.equal(envelope.finalContent.size, 4096);
  assert.equal(envelope.artifactManifestDigest, artifactManifestDigest(fixture.artifactManifest));
  assert.equal(envelope.technicalQa.passed, true);
  assert.equal(envelope.creativeQuality.passed, true);
  assert.equal(envelope.producer.sha, producerSha);
  assert.deepEqual(envelope.contractDigests, pins);
});

test("R13 validator fails closed on stale producer, contract drift, digest drift and QA bypass", () => {
  const fixture = succeededFixture();
  const producerSha = "2".repeat(40);
  const pins = contractPins();
  const envelope = buildCreatorConsumerEnvelope({
    ...fixture,
    producerSha,
    contractDigests: pins
  });

  assert.throws(() => validateCreatorConsumerEnvelope(envelope, {
    artifactManifest: fixture.artifactManifest,
    timeline: fixture.job.timeline,
    expectedProducerSha: "3".repeat(40),
    expectedContractDigests: pins
  }), /producer SHA/);

  const driftedPins = structuredClone(pins);
  driftedPins.mediaJobConsumerManifest.gitBlobSha = "4".repeat(40);
  assert.throws(() => validateCreatorConsumerEnvelope(envelope, {
    artifactManifest: fixture.artifactManifest,
    timeline: fixture.job.timeline,
    expectedProducerSha: producerSha,
    expectedContractDigests: driftedPins
  }), /contract digests/);

  const digestDrift = structuredClone(envelope);
  digestDrift.timelineDigest = "5".repeat(64);
  assert.throws(() => validateCreatorConsumerEnvelope(digestDrift, {
    artifactManifest: fixture.artifactManifest,
    timeline: fixture.job.timeline,
    expectedProducerSha: producerSha,
    expectedContractDigests: pins
  }), /timelineDigest/);

  const qaBypass = structuredClone(envelope);
  qaBypass.technicalQa.passed = false;
  assert.throws(() => validateCreatorConsumerEnvelope(qaBypass, {
    artifactManifest: fixture.artifactManifest,
    timeline: fixture.job.timeline,
    expectedProducerSha: producerSha,
    expectedContractDigests: pins
  }), /technical QA/);

  const creativeBypass = structuredClone(envelope);
  creativeBypass.creativeQuality.guardrails[0].pass = false;
  assert.throws(() => validateCreatorConsumerEnvelope(creativeBypass, {
    artifactManifest: fixture.artifactManifest,
    timeline: fixture.job.timeline,
    expectedProducerSha: producerSha,
    expectedContractDigests: pins
  }), /creative guardrails/);

  const unknown = { ...envelope, futureField: true };
  assert.throws(() => validateCreatorConsumerEnvelope(unknown, {
    artifactManifest: fixture.artifactManifest,
    timeline: fixture.job.timeline,
    expectedProducerSha: producerSha,
    expectedContractDigests: pins
  }), /unknown fields/);
});

test("R13 compatibility manifest pins actual Git blobs and CI head is the checked-out commit", () => {
  const manifest = JSON.parse(readFileSync(
    new URL("../conformance/media.creator_consumer_compat.r13.v1/manifest.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion, MEDIA_CREATOR_CONSUMER_COMPAT_VERSION);
  assert.equal(Object.keys(manifest.pins).length, 10);
  for (const [name, pin] of Object.entries(manifest.pins)) {
    const actual = execFileSync("git", ["hash-object", pin.path], { encoding: "utf8" }).trim();
    assert.equal(actual, pin.gitBlobSha, name);
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  if (process.env.GITHUB_SHA) assert.equal(head, process.env.GITHUB_SHA);
});
