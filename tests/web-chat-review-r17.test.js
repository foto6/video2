import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MEDIA_SHORTFORM_PROFILE_VERSION,
  MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION,
  R17_ACCEPTED_R16_UPSTREAM_AUTHORITY,
  WEB_CHAT_REVIEW_MAX_FILE_BYTES,
  WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS,
  attachmentEligibility,
  buildArtifactManifest,
  buildSucceededRenderExport,
  createBoundedReviewDerivative,
  fingerprint,
  renderExportDigest,
  reviewDerivativeSettingsDigest,
  stableStringify,
  validateAcceptedR16UpstreamAuthority,
  validateReviewDerivativeProvenance,
  validateWebChatReviewBundle,
  verifyReviewCandidateAgainstPin,
  verifyReviewSourceFile,
  writeRenderExportSidecar
} from "../src/index.js";

const TEST_UPSTREAM = "1".repeat(40);
const TEST_REVIEW = "f".repeat(40);

function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}

function makeRealFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r17-"));
  const sourcePath = path.join(root, "source.mp4");
  const finalPath = path.join(root, "final.mp4");
  const sidecarPath = path.join(root, "media.render_export.v1.json");

  execFileSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=30:d=5",
    "-t", "5",
    "-map_metadata", "-1",
    "-metadata", "creation_time=1970-01-01T00:00:00Z",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-threads", "1",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "35",
    "-pix_fmt", "yuv420p",
    "-an",
    "-movflags", "+faststart",
    "-f", "mp4",
    sourcePath
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

  copyFileSync(sourcePath, finalPath);
  const source = { sourceId: "source", ...hashFile(sourcePath) };
  const final = hashFile(finalPath);

  const timeline = {
    id: "r17-fixture",
    version: 1,
    profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
    canvas: { width: 1080, height: 1920, fps: 30, durationMs: 5000 },
    tracks: [{
      id: "video",
      kind: "video",
      items: [{
        id: "main",
        startMs: 0,
        endMs: 5000,
        role: "body",
        source: {
          id: source.sourceId,
          uri: "source.mp4",
          inMs: 0,
          outMs: 5000,
          sha256: source.sha256,
          size: source.size
        }
      }]
    }]
  };
  const qa = {
    passed: true,
    checks: [
      { name: "video-present", pass: true, actual: true, expected: true },
      { name: "dimensions", pass: true, actual: "1080x1920", expected: "1080x1920" },
      { name: "source-assets-provenance", pass: true, actual: 0, expected: 0 },
      { name: "subtitle-safe-area", pass: true, actual: 0, expected: 0 }
    ],
    expected: { width: 1080, height: 1920, fps: 30, durationMs: 5000, hasAudio: false }
  };
  const probe = {
    hasVideo: true,
    hasAudio: false,
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: 5000,
    videoCodec: "h264",
    audioCodec: null,
    outputSize: final.size,
    outputSha256: final.sha256,
    probeCorrupt: false,
    analysisComplete: true,
    blackFrameRatio: 0,
    maxFreezeDurationMs: 0,
    sourceEvidence: [{
      sourceId: source.sourceId,
      expectedKind: "video",
      uri: "source.mp4",
      exists: true,
      local: true,
      probeOk: true,
      sha256: source.sha256,
      size: source.size
    }]
  };
  const job = {
    id: "r17-fixture",
    idempotencyKey: "r17:fixture:1",
    status: "succeeded",
    dryRun: false,
    timeline,
    exportSpec: { format: "mp4" },
    outputPath: "final.mp4",
    renderFingerprint: fingerprint({ fixture: "r17" }),
    currentAttempt: { token: "attempt-r17" },
    probe,
    qa,
    createdAtMs: 1000
  };
  const artifactManifest = buildArtifactManifest(job, {
    finalDigest: final,
    preparedDigest: final,
    preparedAtMs: 2000,
    finalizedAtMs: 2010,
    manifestCommittedAtMs: 2020
  });
  const renderExport = buildSucceededRenderExport({
    job,
    finalPath,
    artifactManifest,
    producerSha: TEST_UPSTREAM
  });
  const written = writeRenderExportSidecar(renderExport, sidecarPath);
  const expectedCandidate = {
    order: 0,
    candidateId: "fixture",
    finalSha256: final.sha256,
    finalSize: final.size,
    renderExportFileSha256: written.sha256,
    renderExportDigest: renderExportDigest(renderExport),
    technicalQaEvidenceSha256: renderExport.qa.technical.sha256
  };
  return { root, sourcePath, finalPath, sidecarPath, source, final, renderExport, expectedCandidate };
}

function acceptedBundle() {
  return {
    contractVersion: MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION,
    review_bundle_producer: { repository: "foto6/video2", sha: TEST_REVIEW },
    upstream_media_authority: structuredClone(R17_ACCEPTED_R16_UPSTREAM_AUTHORITY),
    source: structuredClone(R17_ACCEPTED_R16_UPSTREAM_AUTHORITY.source),
    candidate_batch: structuredClone(R17_ACCEPTED_R16_UPSTREAM_AUTHORITY.candidateBatch),
    attachment_policy: {
      maxBytesPerFile: WEB_CHAT_REVIEW_MAX_FILE_BYTES,
      oversizeBehavior: "ineligible_without_explicit_derivative"
    },
    candidates: R17_ACCEPTED_R16_UPSTREAM_AUTHORITY.candidates.map((pin) => ({
      order: pin.order,
      candidateId: pin.candidateId,
      final: {
        path: `candidates/${pin.candidateId}/final.mp4`,
        name: "final.mp4",
        sha256: pin.finalSha256,
        size: pin.finalSize
      },
      renderExport: {
        path: `candidates/${pin.candidateId}/media.render_export.v1.json`,
        digest: pin.renderExportDigest,
        fileSha256: pin.renderExportFileSha256,
        producerSha: R17_ACCEPTED_R16_UPSTREAM_AUTHORITY.producerSha
      },
      technicalQa: {
        passed: true,
        evidenceSha256: pin.technicalQaEvidenceSha256,
        checkCount: 1,
        failedChecks: []
      },
      attachmentEligibility: attachmentEligibility(pin.finalSize),
      reviewAttachment: {
        file: {
          path: `attachments/${pin.candidateId}/final.mp4`,
          name: "final.mp4",
          sha256: pin.finalSha256,
          size: pin.finalSize
        },
        derivative: null
      }
    }))
  };
}

test("R17 accepted upstream authority pins exact R16 run/artifact/source/candidate evidence", () => {
  const a = R17_ACCEPTED_R16_UPSTREAM_AUTHORITY;
  assert.equal(a.producerSha, "231a0680c8939cfec77aaa283e507e93f383ad73");
  assert.equal(a.ciRunId, 36865890506);
  assert.equal(a.artifact.id, 11163920921);
  assert.equal(a.artifact.name, "media-r16-candidate-batch-demo");
  assert.equal(a.artifact.archiveDigest, "sha256:d929b592c76ec93e41b54701376f4b02366a3bdbd127d3472d73ae277d450d0f");
  assert.equal(a.source.sha256, "7b484abef5de1569e1b7f91a5d780f17c6d687ef68b3c42c9e54375f4e5e434b");
  assert.equal(a.source.size, 763377);
  assert.deepEqual(a.candidates.map((c) => c.renderExportFileSha256), [
    "2b5177c00bb054184a239c7eddb1383ad253922e8eb686f5aa2e56c91a1335ac",
    "b349b897f8f86bc9257e2622f564d6430f3864ff605ae4b82ba0cb09c59298f6",
    "26fe61f0644e263ce047869334ba65c5973eba809ff45f76286490f573d61b8e"
  ]);
  assert.doesNotThrow(() => validateAcceptedR16UpstreamAuthority(a));
});

test("R17 rejects wrong upstream producer SHA, artifact ID and archive digest", () => {
  for (const mutate of [
    (a) => { a.producerSha = "2".repeat(40); },
    (a) => { a.artifact.id += 1; },
    (a) => { a.artifact.archiveDigest = "sha256:" + "0".repeat(64); }
  ]) {
    const a = structuredClone(R17_ACCEPTED_R16_UPSTREAM_AUTHORITY);
    mutate(a);
    assert.throws(() => validateAcceptedR16UpstreamAuthority(a), /exact accepted R16/);
  }
});

test("R17 source verifier fails on missing and wrong source bytes", () => {
  const f = makeRealFixture();
  assert.doesNotThrow(() => verifyReviewSourceFile(f.sourcePath, f.source));
  assert.throws(
    () => verifyReviewSourceFile(path.join(f.root, "missing.mp4"), f.source),
    /file is missing/
  );
  const wrong = path.join(f.root, "wrong.mp4");
  copyFileSync(f.sourcePath, wrong);
  appendFileSync(wrong, Buffer.from("wrong"));
  assert.throws(() => verifyReviewSourceFile(wrong, f.source), /source bytes do not match/);
});

test("R17 candidate verifier rejects missing file, changed final hash and stale sidecar bytes", () => {
  const f = makeRealFixture();
  assert.doesNotThrow(() => verifyReviewCandidateAgainstPin({
    finalPath: f.finalPath,
    sidecarPath: f.sidecarPath,
    expectedCandidate: f.expectedCandidate,
    expectedSource: f.source,
    upstreamProducerSha: TEST_UPSTREAM
  }));

  const missing = path.join(f.root, "missing-final.mp4");
  assert.throws(() => verifyReviewCandidateAgainstPin({
    finalPath: missing,
    sidecarPath: f.sidecarPath,
    expectedCandidate: f.expectedCandidate,
    expectedSource: f.source,
    upstreamProducerSha: TEST_UPSTREAM
  }), /file is missing/);

  appendFileSync(f.finalPath, Buffer.from("tamper"));
  assert.throws(() => verifyReviewCandidateAgainstPin({
    finalPath: f.finalPath,
    sidecarPath: f.sidecarPath,
    expectedCandidate: f.expectedCandidate,
    expectedSource: f.source,
    upstreamProducerSha: TEST_UPSTREAM
  }), /differs from pinned upstream bytes/);

  const g = makeRealFixture();
  appendFileSync(g.sidecarPath, Buffer.from("\n"));
  assert.throws(() => verifyReviewCandidateAgainstPin({
    finalPath: g.finalPath,
    sidecarPath: g.sidecarPath,
    expectedCandidate: g.expectedCandidate,
    expectedSource: g.source,
    upstreamProducerSha: TEST_UPSTREAM
  }), /sidecar bytes differ/);
});

test("R17 rejects regenerated same MP4 when sidecar provenance changes", () => {
  const f = makeRealFixture();
  const changed = structuredClone(f.renderExport);
  changed.producer.sha = "2".repeat(40);
  writeFileSync(f.sidecarPath, `${stableStringify(changed)}\n`);
  const changedBytes = hashFile(f.sidecarPath);
  const changedPin = {
    ...f.expectedCandidate,
    renderExportFileSha256: changedBytes.sha256,
    renderExportDigest: renderExportDigest(changed)
  };
  assert.equal(hashFile(f.finalPath).sha256, f.expectedCandidate.finalSha256);
  assert.throws(() => verifyReviewCandidateAgainstPin({
    finalPath: f.finalPath,
    sidecarPath: f.sidecarPath,
    expectedCandidate: changedPin,
    expectedSource: f.source,
    upstreamProducerSha: TEST_UPSTREAM
  }), /provenance differs/);
});

test("R17 rejects wrong render-export semantic digest even when sidecar file hash matches", () => {
  const f = makeRealFixture();
  const wrongPin = {
    ...f.expectedCandidate,
    renderExportDigest: "0".repeat(64)
  };
  assert.throws(() => verifyReviewCandidateAgainstPin({
    finalPath: f.finalPath,
    sidecarPath: f.sidecarPath,
    expectedCandidate: wrongPin,
    expectedSource: f.source,
    upstreamProducerSha: TEST_UPSTREAM
  }), /provenance differs/);
});

test("R17 candidate verifier rejects wrong source lineage in render export", () => {
  const f = makeRealFixture();
  const wrongSource = { ...f.source, sha256: "f".repeat(64) };
  assert.throws(() => verifyReviewCandidateAgainstPin({
    finalPath: f.finalPath,
    sidecarPath: f.sidecarPath,
    expectedCandidate: f.expectedCandidate,
    expectedSource: wrongSource,
    upstreamProducerSha: TEST_UPSTREAM
  }), /does not bind expected upstream source/);
});

test("R17 exact accepted bundle separates R17 producer from R16 upstream and rejects duplicate candidate", () => {
  const bundle = acceptedBundle();
  assert.doesNotThrow(() => validateWebChatReviewBundle(bundle));
  assert.notEqual(bundle.review_bundle_producer.sha, bundle.upstream_media_authority.producerSha);

  const duplicate = structuredClone(bundle);
  duplicate.candidates[1].candidateId = duplicate.candidates[0].candidateId;
  assert.throws(() => validateWebChatReviewBundle(duplicate), /duplicate candidate ID/);
});

test("R17 attachment limit is exact and derivative provenance is explicit", () => {
  assert.deepEqual(attachmentEligibility(WEB_CHAT_REVIEW_MAX_FILE_BYTES), {
    eligible: true,
    maxBytes: 500000000,
    reason: null
  });
  assert.deepEqual(attachmentEligibility(WEB_CHAT_REVIEW_MAX_FILE_BYTES + 1), {
    eligible: false,
    maxBytes: 500000000,
    reason: "file_exceeds_500mb_limit"
  });

  const f = makeRealFixture();
  const derivativePath = path.join(f.root, "derivative.mp4");
  const derivative = createBoundedReviewDerivative({
    originalPath: f.sourcePath,
    derivativePath
  });
  assert.equal(derivative.derivative_for_model_review, true);
  assert.equal(derivative.originalSha256, f.source.sha256);
  assert.equal(derivative.derivativeSha256, hashFile(derivativePath).sha256);
  assert.equal(derivative.settingsDigest, reviewDerivativeSettingsDigest(WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS));

  const wrong = structuredClone(derivative);
  wrong.settings.crf = 27;
  assert.throws(() => validateReviewDerivativeProvenance(wrong), /settings digest mismatch/);
});

test("R17 conformance manifest pins exact blobs", () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(
    new URL("../conformance/media.web_chat_review_bundle.v1/manifest.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion, MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION);
  assert.equal(manifest.attachmentPolicy.maxBytesPerFile, WEB_CHAT_REVIEW_MAX_FILE_BYTES);
  assert.equal(manifest.modelJudgment, false);
  const manifestCommit = "e88f1791ae47e7333ce85db584f0a04dbf229809";
  assert.match(manifestCommit, /^[a-f0-9]{40}$/);
  for (const [name, pin] of Object.entries(manifest.pins)) {
    const actual = execFileSync(
      "git",
      ["rev-parse", `${manifestCommit}:${pin.path}`],
      { cwd: root, encoding: "utf8" }
    ).trim();
    assert.equal(actual, pin.gitBlobSha, name);
  }
});
