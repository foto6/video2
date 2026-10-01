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
  rmSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MEDIA_SHORTFORM_PROFILE_VERSION,
  MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION,
  WEB_CHAT_REVIEW_MAX_FILE_BYTES,
  WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS,
  attachmentEligibility,
  buildArtifactManifest,
  buildSucceededRenderExport,
  buildWebChatReviewBundle,
  createBoundedReviewDerivative,
  fingerprint,
  renderExportDigest,
  reviewDerivativeSettingsDigest,
  stableStringify,
  validateReviewDerivativeProvenance,
  validateWebChatReviewBundle,
  writeRenderExportSidecar
} from "../src/index.js";

const PRODUCER = "1".repeat(40);

function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}

function makeRealFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r17-"));
  const batchRoot = path.join(root, "batch");
  const sourcePath = path.join(root, "source.mp4");
  mkdirSync(batchRoot, { recursive: true });

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

  const source = { sourceId: "source", ...hashFile(sourcePath) };
  const candidates = [];

  for (const [order, candidateId] of ["candidate-a", "candidate-b"].entries()) {
    const candidateDir = path.join(batchRoot, "candidates", candidateId);
    mkdirSync(candidateDir, { recursive: true });
    const finalPath = path.join(candidateDir, "final.mp4");
    copyFileSync(sourcePath, finalPath);
    const final = hashFile(finalPath);

    const timeline = {
      id: `r17-${candidateId}`,
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
      id: `r17-${candidateId}`,
      idempotencyKey: `r17:${candidateId}:1`,
      status: "succeeded",
      dryRun: false,
      timeline,
      exportSpec: { format: "mp4" },
      outputPath: `candidates/${candidateId}/final.mp4`,
      renderFingerprint: fingerprint({ candidateId }),
      currentAttempt: { token: `attempt-${candidateId}` },
      probe,
      qa,
      createdAtMs: 1000 + order
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
      producerSha: PRODUCER
    });
    const sidecarPath = path.join(candidateDir, "media.render_export.v1.json");
    const sidecar = writeRenderExportSidecar(renderExport, sidecarPath);
    candidates.push({
      order,
      candidateId,
      planDigest: fingerprint({ candidateId, plan: true }),
      cacheIdentityDigest: fingerprint({ candidateId, cache: true }),
      status: "succeeded",
      final: {
        fileName: "final.mp4",
        relativePath: `candidates/${candidateId}/final.mp4`,
        sha256: final.sha256,
        size: final.size,
        renderExportFileName: "media.render_export.v1.json",
        renderExportRelativePath: `candidates/${candidateId}/media.render_export.v1.json`,
        renderExportSha256: sidecar.sha256
      },
      failure: null
    });
  }

  const batch = {
    contractVersion: "media.candidate_batch.v1",
    batchId: "r17-test-batch",
    source,
    producer: { repository: "foto6/video2", sha: PRODUCER },
    renderer: { configDigest: "a".repeat(64) },
    requestDigest: "b".repeat(64),
    status: "succeeded",
    candidates
  };
  return { root, batchRoot, sourcePath, source, batch };
}

test("R17 builds source-bound review bundle and copies original MP4 bytes unchanged", () => {
  const f = makeRealFixture();
  const attachmentRoot = path.join(f.root, "review");
  const bundle = buildWebChatReviewBundle({
    candidateBatchManifest: f.batch,
    batchRoot: f.batchRoot,
    sourcePath: f.sourcePath,
    producerSha: PRODUCER,
    attachmentRoot
  });
  assert.equal(bundle.contractVersion, MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION);
  assert.equal(bundle.source.sha256, f.source.sha256);
  assert.equal(bundle.candidates.length, 2);
  for (const candidate of bundle.candidates) {
    assert.equal(candidate.technicalQa.passed, true);
    assert.equal(candidate.technicalQa.failedChecks.length, 0);
    assert.equal(candidate.attachmentEligibility.eligible, true);
    assert.equal(candidate.reviewAttachment.derivative, null);
    assert.equal(candidate.reviewAttachment.file.sha256, candidate.final.sha256);
    assert.equal(candidate.reviewAttachment.file.size, candidate.final.size);
    assert.match(candidate.renderExport.digest, /^[a-f0-9]{64}$/);
    assert.match(candidate.renderExport.fileSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      hashFile(path.join(attachmentRoot, candidate.reviewAttachment.file.path)).sha256,
      candidate.final.sha256
    );
  }
  assert.equal(hashFile(f.sourcePath).sha256, f.source.sha256);
});

test("R17 missing candidate final fails closed", () => {
  const f = makeRealFixture();
  rmSync(path.join(f.batchRoot, f.batch.candidates[0].final.relativePath));
  assert.throws(() => buildWebChatReviewBundle({
    candidateBatchManifest: f.batch,
    batchRoot: f.batchRoot,
    sourcePath: f.sourcePath,
    producerSha: PRODUCER
  }), /file is missing/);
});

test("R17 changed final bytes fail exact hash validation", () => {
  const f = makeRealFixture();
  appendFileSync(path.join(f.batchRoot, f.batch.candidates[0].final.relativePath), Buffer.from("tamper"));
  assert.throws(() => buildWebChatReviewBundle({
    candidateBatchManifest: f.batch,
    batchRoot: f.batchRoot,
    sourcePath: f.sourcePath,
    producerSha: PRODUCER
  }), /final\.mp4 hash\/size mismatch/);
});

test("R17 wrong source bytes fail before review packaging", () => {
  const f = makeRealFixture();
  const wrong = path.join(f.root, "wrong-source.mp4");
  copyFileSync(f.sourcePath, wrong);
  appendFileSync(wrong, Buffer.from("wrong"));
  assert.throws(() => buildWebChatReviewBundle({
    candidateBatchManifest: f.batch,
    batchRoot: f.batchRoot,
    sourcePath: wrong,
    producerSha: PRODUCER
  }), /source bytes do not match/);
});

test("R17 stale render export sidecar is rejected", () => {
  const f = makeRealFixture();
  const sidecarPath = path.join(f.batchRoot, f.batch.candidates[0].final.renderExportRelativePath);
  appendFileSync(sidecarPath, Buffer.from("\n"));
  assert.throws(() => buildWebChatReviewBundle({
    candidateBatchManifest: f.batch,
    batchRoot: f.batchRoot,
    sourcePath: f.sourcePath,
    producerSha: PRODUCER
  }), /sidecar hash mismatch/);
});

test("R17 attachment limit is exact and oversize original is ineligible without silent byte substitution", () => {
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
  const bundle = buildWebChatReviewBundle({
    candidateBatchManifest: f.batch,
    batchRoot: f.batchRoot,
    sourcePath: f.sourcePath,
    producerSha: PRODUCER
  });
  const synthetic = structuredClone(bundle);
  synthetic.candidates[0].final.size = WEB_CHAT_REVIEW_MAX_FILE_BYTES + 1;
  synthetic.candidates[0].attachmentEligibility = attachmentEligibility(synthetic.candidates[0].final.size);
  synthetic.candidates[0].reviewAttachment = null;
  assert.doesNotThrow(() => validateWebChatReviewBundle(synthetic));
});

test("R17 duplicate candidate IDs fail closed", () => {
  const f = makeRealFixture();
  const bundle = buildWebChatReviewBundle({
    candidateBatchManifest: f.batch,
    batchRoot: f.batchRoot,
    sourcePath: f.sourcePath,
    producerSha: PRODUCER
  });
  const duplicate = structuredClone(bundle);
  duplicate.candidates[1].candidateId = duplicate.candidates[0].candidateId;
  assert.throws(() => validateWebChatReviewBundle(duplicate), /duplicate candidate ID/);
});

test("R17 deterministic review derivative binds original, derivative and exact transform settings", () => {
  const f = makeRealFixture();
  const original = hashFile(f.sourcePath);
  const derivativePath = path.join(f.root, "derivative.mp4");
  const derivative = createBoundedReviewDerivative({
    originalPath: f.sourcePath,
    derivativePath
  });
  const derivativeBytes = hashFile(derivativePath);
  assert.equal(derivative.derivative_for_model_review, true);
  assert.equal(derivative.originalSha256, original.sha256);
  assert.equal(derivative.derivativeSha256, derivativeBytes.sha256);
  assert.equal(derivative.derivativeSize, derivativeBytes.size);
  assert.deepEqual(derivative.settings, WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS);
  assert.equal(derivative.settingsDigest, reviewDerivativeSettingsDigest(WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS));
  assert.ok(derivative.derivativeSize <= WEB_CHAT_REVIEW_MAX_FILE_BYTES);

  const wrongOriginal = structuredClone(derivative);
  wrongOriginal.originalSha256 = "f".repeat(64);
  assert.throws(() => validateReviewDerivativeProvenance(wrongOriginal, {
    expectedOriginalSha256: original.sha256,
    expectedDerivativeSha256: derivativeBytes.sha256
  }), /original SHA mismatch/);

  const wrongSettings = structuredClone(derivative);
  wrongSettings.settings.crf = 27;
  assert.throws(() => validateReviewDerivativeProvenance(wrongSettings), /settings digest mismatch/);
});

test("R17 render export digest remains bound to exact validated sidecar", () => {
  const f = makeRealFixture();
  const bundle = buildWebChatReviewBundle({
    candidateBatchManifest: f.batch,
    batchRoot: f.batchRoot,
    sourcePath: f.sourcePath,
    producerSha: PRODUCER
  });
  const first = f.batch.candidates[0];
  const sidecarPath = path.join(f.batchRoot, first.final.renderExportRelativePath);
  const sidecarBytes = readFileSync(sidecarPath);
  const sidecar = JSON.parse(sidecarBytes);
  assert.equal(bundle.candidates[0].renderExport.digest, renderExportDigest(sidecar));
  assert.equal(
    bundle.candidates[0].renderExport.fileSha256,
    createHash("sha256").update(sidecarBytes).digest("hex")
  );
  assert.equal(bundle.candidates[0].renderExport.fileSha256, first.final.renderExportSha256);
});


test("R17 conformance manifest pins exact implementation/schema/dependency blobs", () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(
    new URL("../conformance/media.web_chat_review_bundle.v1/manifest.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion, MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION);
  assert.equal(manifest.attachmentPolicy.maxBytesPerFile, WEB_CHAT_REVIEW_MAX_FILE_BYTES);
  assert.equal(manifest.modelJudgment, false);
  for (const [name, pin] of Object.entries(manifest.pins)) {
    const actual = execFileSync("git", ["hash-object", pin.path], { cwd: root, encoding: "utf8" }).trim();
    assert.equal(actual, pin.gitBlobSha, name);
  }
});
