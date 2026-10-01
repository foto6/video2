import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MEDIA_RENDER_EXPORT_FILENAME,
  MEDIA_RENDER_EXPORT_VERSION,
  MEDIA_SHORTFORM_PROFILE_VERSION,
  R15_BOSS_BENCHMARK_BINDING,
  artifactManifestDigest,
  buildArtifactManifest,
  buildFailedRenderExport,
  buildSucceededRenderExport,
  fingerprint,
  renderExportDigest,
  requireRenderExportSidecar,
  validateRenderExport,
  validateRenderExportAgainstFinal,
  writeRenderExportSidecar
} from "../src/index.js";

function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r15-"));
  const renderDir = path.join(root, "renders", "fixture");
  mkdirSync(renderDir, { recursive: true });
  const finalPath = path.join(renderDir, "final.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=30:d=5",
    "-t", "5", "-map_metadata", "-1", "-threads", "1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-an", "-movflags", "+faststart", "-f", "mp4", finalPath
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const digest = hashFile(finalPath);
  const timeline = {
    id: "r15-fixture",
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
        reframe: { x: "(in_w-out_w)/2", y: "(in_h-out_h)/2" },
        source: {
          id: "source",
          uri: "source.mp4",
          inMs: 0,
          outMs: 5000,
          sha256: "a".repeat(64),
          size: 123
        }
      }]
    }]
  };
  const qa = {
    passed: true,
    checks: [
      { name: "video-present", pass: true, actual: true, expected: true },
      { name: "dimensions", pass: true, actual: "1080x1920", expected: "1080x1920" },
      { name: "subtitle-safe-area", pass: true, actual: 0, expected: 0 },
      { name: "source-assets-provenance", pass: true, actual: 0, expected: 0 }
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
    outputSize: digest.size,
    outputSha256: digest.sha256,
    probeCorrupt: false,
    analysisComplete: true,
    blackFrameRatio: 0,
    maxFreezeDurationMs: 0,
    sourceEvidence: [{
      sourceId: "source",
      expectedKind: "video",
      uri: "source.mp4",
      exists: true,
      local: true,
      probeOk: true,
      sha256: "a".repeat(64),
      size: 123
    }]
  };
  const job = {
    id: "r15-fixture",
    idempotencyKey: "r15:fixture:1",
    status: "succeeded",
    dryRun: false,
    timeline,
    exportSpec: { format: "mp4" },
    outputPath: "renders/fixture/final.mp4",
    renderFingerprint: fingerprint({ fixture: "r15" }),
    currentAttempt: { token: "attempt-r15" },
    probe,
    qa,
    createdAtMs: 1000
  };
  const artifactManifest = buildArtifactManifest(job, {
    finalDigest: digest,
    preparedDigest: digest,
    preparedAtMs: 2000,
    finalizedAtMs: 2010,
    manifestCommittedAtMs: 2020
  });
  job.artifactManifest = artifactManifest;
  return { root, renderDir, finalPath, job, artifactManifest, digest };
}

test("R15 schema and frozen boss benchmark binding are explicit", () => {
  const schema = JSON.parse(readFileSync(new URL("../conformance/media.render_export.v1/schema.json", import.meta.url), "utf8"));
  const binding = JSON.parse(readFileSync(new URL("../conformance/media.render_export.v1/boss-benchmark-binding.json", import.meta.url), "utf8"));
  assert.equal(schema.$id, MEDIA_RENDER_EXPORT_VERSION);
  assert.equal(binding.protocol, R15_BOSS_BENCHMARK_BINDING.protocol);
  assert.equal(binding.producerSha, R15_BOSS_BENCHMARK_BINDING.producerSha);
  assert.equal(binding.gitBlobSha, R15_BOSS_BENCHMARK_BINDING.gitBlobSha);
  assert.equal(binding.generatedMediaCountsForParitySamples, false);
});

test("R15 success export binds exact final.mp4 bytes, ffprobe, QA, source and benchmark provenance", () => {
  const fixture = makeFixture();
  const record = buildSucceededRenderExport({
    job: fixture.job,
    finalPath: fixture.finalPath,
    artifactManifest: fixture.artifactManifest,
    producerSha: "1".repeat(40)
  });
  assert.equal(record.status, "succeeded");
  assert.equal(record.artifact.fileName, "final.mp4");
  assert.equal(record.artifact.sha256, fixture.digest.sha256);
  assert.equal(record.artifact.size, fixture.digest.size);
  assert.equal(record.artifact.artifactManifestDigest, artifactManifestDigest(fixture.artifactManifest));
  assert.equal(record.probe.width, 1080);
  assert.equal(record.probe.height, 1920);
  assert.equal(record.probe.fps, 30);
  assert.equal(record.qa.technical.passed, true);
  assert.equal(record.qa.creative.passed, true);
  assert.equal(record.evidence.sources.items[0].sha256, "a".repeat(64));
  assert.equal(record.evidence.crop.reframeItems, 1);
  assert.equal(record.benchmark.technicalDq, false);
  assert.doesNotThrow(() => validateRenderExportAgainstFinal(record, fixture.finalPath));
  assert.match(renderExportDigest(record), /^[a-f0-9]{64}$/);
});

test("R15 exact-byte validation rejects hash mismatch", () => {
  const fixture = makeFixture();
  const record = buildSucceededRenderExport({
    job: fixture.job,
    finalPath: fixture.finalPath,
    artifactManifest: fixture.artifactManifest,
    producerSha: "2".repeat(40)
  });
  appendFileSync(fixture.finalPath, Buffer.from("tamper"));
  assert.throws(
    () => validateRenderExportAgainstFinal(record, fixture.finalPath),
    /hash\/size mismatch/
  );
});

test("R15 sidecar replay is idempotent and conflicting replay fails closed", () => {
  const fixture = makeFixture();
  const record = buildSucceededRenderExport({
    job: fixture.job,
    finalPath: fixture.finalPath,
    artifactManifest: fixture.artifactManifest,
    producerSha: "3".repeat(40)
  });
  const sidecar = path.join(fixture.renderDir, MEDIA_RENDER_EXPORT_FILENAME);
  assert.equal(writeRenderExportSidecar(record, sidecar).replayed, false);
  assert.equal(writeRenderExportSidecar(record, sidecar).replayed, true);
  const conflict = structuredClone(record);
  conflict.producer.sha = "4".repeat(40);
  assert.throws(() => writeRenderExportSidecar(conflict, sidecar), /replay conflict/);
});

test("R15 missing sidecar fails closed", () => {
  const fixture = makeFixture();
  assert.throws(() => requireRenderExportSidecar(fixture.finalPath), /sidecar is missing/);
});

test("R15 failed render export is machine-readable and cannot fake artifact success", () => {
  const failed = buildFailedRenderExport({
    job: {
      id: "failed-job",
      idempotencyKey: "r15:failed:1",
      status: "failed",
      renderFingerprint: "5".repeat(64),
      failure: { code: "render_process_failed", category: "render", message: "ffmpeg exited 1", retryable: false }
    },
    producerSha: "6".repeat(40)
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.artifact, null);
  assert.equal(failed.failure.code, "render_process_failed");
  assert.equal(failed.benchmark.technicalDq, true);
  assert.doesNotThrow(() => validateRenderExport(failed));
  const forged = structuredClone(failed);
  forged.status = "succeeded";
  assert.throws(() => validateRenderExport(forged), /requires artifact/);
});

test("R15 batch export deterministically emits canonical sidecar from persisted job store", () => {
  const fixture = makeFixture();
  const jobsFile = path.join(fixture.root, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify({
    version: 1,
    jobs: { [fixture.job.id]: fixture.job },
    idempotency: {},
    recoveryEvents: [],
    scheduler: {}
  }));
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  execFileSync(process.execPath, [
    "tools/export-r15-batch.mjs",
    "--jobs-file", jobsFile
  ], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const sidecar = path.join(fixture.renderDir, MEDIA_RENDER_EXPORT_FILENAME);
  assert.equal(requireRenderExportSidecar(fixture.finalPath).status, "succeeded");
  const first = readFileSync(sidecar, "utf8");
  execFileSync(process.execPath, [
    "tools/export-r15-batch.mjs",
    "--jobs-file", jobsFile
  ], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  assert.equal(readFileSync(sidecar, "utf8"), first);
  const summary = JSON.parse(readFileSync(path.join(fixture.root, "media.render_export.batch.json"), "utf8"));
  assert.equal(summary.count, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 0);
});
