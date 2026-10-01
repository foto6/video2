import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { artifactManifestDigest, evidenceDigest, verifyArtifactManifestForJob } from "./runtime/artifact-manifest.js";
import { evaluateCreativeQuality } from "./creative-plan.js";
import { fingerprint, stableStringify } from "./stable.js";
import { canonicalizeTimeline } from "./timeline.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_RENDER_EXPORT_VERSION = "media.render_export.v1";
export const MEDIA_RENDER_EXPORT_FILENAME = "media.render_export.v1.json";

export const R15_BOSS_BENCHMARK_BINDING = Object.freeze({
  protocol: "human.editorial_benchmark.v1",
  repository: "foto6/boss",
  producerSha: "912fb4b937ec3bd0c1752fe198a41d60236a20dc",
  path: "GATES/EDITORIAL_PARITY_BENCHMARK_V1.md",
  gitBlobSha: "af509b79ff8dce6cb621f8ac1c88db1bba6e5219"
});

const TOP_FIELDS = new Set([
  "contractVersion", "status", "producer", "job", "artifact", "probe",
  "qa", "evidence", "provenance", "failure", "benchmark"
]);

function fail(message) {
  throw runtimeError("render_export_invalid", message);
}
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, fields, label) {
  if (!plain(value)) fail(`${label} must be an object`);
  const expected = new Set(fields);
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length) fail(`${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail(`${label} unknown fields: ${extra.sort().join(", ")}`);
}
function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be SHA-256 hex`);
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) fail(`${label} must be exact Git SHA`);
}
function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be non-empty`);
}
function hashFileSync(filePath) {
  const bytes = readFileSync(filePath);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}
function parseRate(value) {
  if (typeof value !== "string") return null;
  const [n, d] = value.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return Number((n / d).toFixed(6));
}
function probeFinal(filePath, ffprobeBinary = "ffprobe") {
  let parsed;
  try {
    parsed = JSON.parse(execFileSync(ffprobeBinary, [
      "-v", "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height,r_frame_rate,duration:format=duration,size",
      "-of", "json",
      filePath
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    fail(`ffprobe failed for final artifact: ${error.message}`);
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((entry) => entry.codec_type === "video") ?? null;
  const audio = streams.find((entry) => entry.codec_type === "audio") ?? null;
  const seconds = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration);
  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseRate(video?.r_frame_rate),
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null
  };
}
function publicSources(sourceEvidence = []) {
  return sourceEvidence.map((entry) => ({
    sourceId: entry.sourceId,
    expectedKind: entry.expectedKind,
    sha256: entry.sha256,
    size: entry.size,
    probeOk: entry.probeOk === true
  })).sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));
}
function findCheck(checks, name) {
  return (checks ?? []).find((entry) => entry?.name === name) ?? null;
}
function evidenceFor(job, creative) {
  const timeline = canonicalizeTimeline(job.timeline);
  const captions = timeline.tracks.filter((track) => track.kind === "caption").flatMap((track) => track.items);
  const video = timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.items);
  const audio = timeline.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.items);
  const sources = publicSources(job.probe?.sourceEvidence ?? []);
  return {
    sources: {
      count: sources.length,
      sha256: fingerprint(sources),
      items: sources
    },
    captions: {
      count: captions.length,
      sha256: fingerprint(captions),
      safeAreaPassed: findCheck(job.qa?.checks, "subtitle-safe-area")?.pass ?? null,
      textCharsPerSecond: creative?.metrics?.textCharsPerSecond ?? null
    },
    crop: {
      explicitCropItems: video.filter((item) => item.crop).length,
      reframeItems: video.filter((item) => item.reframe).length,
      motionItems: video.filter((item) => item.motion).length,
      unsafeCropPassed: findCheck(creative?.visualQa?.checks, "creative-unsafe-crop")?.pass ?? null
    },
    audio: {
      itemCount: audio.length,
      roles: [...new Set(audio.map((item) => item.role ?? "unspecified"))].sort(),
      maxMusicGainDb: creative?.metrics?.musicMaxGainDb ?? null,
      hasAudio: job.probe?.hasAudio ?? null,
      meanDb: Number.isFinite(job.probe?.meanDb) ? job.probe.meanDb : null,
      peakDb: Number.isFinite(job.probe?.peakDb) ? job.probe.peakDb : null,
      silenceRatio: Number.isFinite(job.probe?.silenceRatio) ? job.probe.silenceRatio : null
    }
  };
}
function benchmarkState({ job, artifact, probe, evidence, status }) {
  const reasons = [];
  if (status !== "succeeded") reasons.push("render_not_succeeded");
  if (!probe?.hasVideo) reasons.push("missing_video");
  if (probe?.width !== 1080 || probe?.height !== 1920 || probe?.fps !== 30) reasons.push("wrong_video_profile");
  if (job?.qa?.passed !== true) reasons.push("technical_qa_failed");
  if (artifact && probe && (artifact.sha256 !== job?.probe?.outputSha256 || artifact.size !== job?.probe?.outputSize)) {
    reasons.push("rated_bytes_differ_from_qa_bytes");
  }
  if (evidence?.sources?.items?.some((entry) => entry.probeOk !== true || !entry.sha256)) reasons.push("source_provenance_invalid");
  return {
    binding: clone(R15_BOSS_BENCHMARK_BINDING),
    technicalDq: reasons.length > 0,
    technicalDqReasons: reasons
  };
}
function commonJob(job) {
  return {
    logicalJobId: job?.id ?? null,
    idempotencyKey: job?.idempotencyKey ?? null,
    renderFingerprint: job?.renderFingerprint ?? null,
    status: job?.status ?? "unknown"
  };
}

export function buildSucceededRenderExport({
  job,
  finalPath,
  artifactManifest,
  producerSha,
  ffprobeBinary = "ffprobe"
} = {}) {
  if (!job || job.status !== "succeeded" || job.dryRun === true) fail("success export requires succeeded live job");
  gitSha(producerSha, "producerSha");
  if (!finalPath || !existsSync(finalPath)) fail("final.mp4 is missing");
  const manifest = verifyArtifactManifestForJob(job, artifactManifest);
  const bytes = hashFileSync(finalPath);
  if (bytes.sha256 !== manifest.content.sha256 || bytes.size !== manifest.content.size) {
    fail("final.mp4 bytes do not match media.artifact_manifest.v1");
  }
  if (job.probe?.outputSha256 !== bytes.sha256 || job.probe?.outputSize !== bytes.size) {
    fail("final.mp4 bytes do not match QA-passed probe evidence");
  }
  if (job.qa?.passed !== true) fail("success export requires passing technical QA");
  const creative = evaluateCreativeQuality(job.timeline, job.probe ?? {});
  if (creative.passed !== true) fail("success export requires passing creative QA/guardrails");
  const probe = probeFinal(finalPath, ffprobeBinary);
  if (
    probe.width !== job.probe?.width ||
    probe.height !== job.probe?.height ||
    probe.fps !== job.probe?.fps ||
    probe.durationMs !== job.probe?.durationMs
  ) fail("independent ffprobe does not match persisted probe evidence");

  const evidence = evidenceFor(job, creative);
  const artifact = {
    fileName: path.basename(finalPath),
    algorithm: "sha256",
    sha256: bytes.sha256,
    size: bytes.size,
    contentId: `sha256:${bytes.sha256}`,
    artifactManifestDigest: artifactManifestDigest(manifest)
  };
  const record = {
    contractVersion: MEDIA_RENDER_EXPORT_VERSION,
    status: "succeeded",
    producer: { repository: "foto6/video2", sha: producerSha },
    job: commonJob(job),
    artifact,
    probe,
    qa: {
      technical: { sha256: evidenceDigest(job.qa), passed: true, value: clone(job.qa) },
      creative: { sha256: evidenceDigest(creative), passed: true, value: clone(creative) }
    },
    evidence,
    provenance: {
      validatedRequestDigest: manifest.validatedRequestDigest,
      profileDigest: manifest.profileDigest,
      timelineDigest: fingerprint(canonicalizeTimeline(job.timeline)),
      creativePlanDigest: job.timeline?.creativePlan?.planDigest ?? null,
      sourceEvidenceDigest: evidence.sources.sha256,
      artifactManifestDigest: artifact.artifactManifestDigest
    },
    failure: null,
    benchmark: null
  };
  record.benchmark = benchmarkState({ job, artifact, probe, evidence, status: record.status });
  return validateRenderExport(record);
}

export function buildFailedRenderExport({ job, producerSha, failure = null } = {}) {
  gitSha(producerSha, "producerSha");
  const normalizedFailure = {
    code: failure?.code ?? job?.failure?.code ?? "render_failed",
    category: failure?.category ?? job?.failure?.category ?? "render",
    message: failure?.message ?? job?.failure?.message ?? "render did not succeed",
    retryable: failure?.retryable ?? job?.failure?.retryable ?? false
  };
  const sources = publicSources(job?.probe?.sourceEvidence ?? []);
  const evidence = {
    sources: { count: sources.length, sha256: fingerprint(sources), items: sources },
    captions: null,
    crop: null,
    audio: null
  };
  const record = {
    contractVersion: MEDIA_RENDER_EXPORT_VERSION,
    status: "failed",
    producer: { repository: "foto6/video2", sha: producerSha },
    job: commonJob(job),
    artifact: null,
    probe: job?.probe ? clone(job.probe) : null,
    qa: {
      technical: job?.qa ? { sha256: evidenceDigest(job.qa), passed: job.qa.passed === true, value: clone(job.qa) } : null,
      creative: null
    },
    evidence,
    provenance: {
      validatedRequestDigest: null,
      profileDigest: null,
      timelineDigest: job?.timeline ? fingerprint(canonicalizeTimeline(job.timeline)) : null,
      creativePlanDigest: job?.timeline?.creativePlan?.planDigest ?? null,
      sourceEvidenceDigest: evidence.sources.sha256,
      artifactManifestDigest: null
    },
    failure: normalizedFailure,
    benchmark: null
  };
  record.benchmark = benchmarkState({ job, artifact: null, probe: record.probe, evidence, status: record.status });
  return validateRenderExport(record);
}

export function validateRenderExport(input) {
  const record = clone(input);
  exactKeys(record, TOP_FIELDS, "render export");
  if (record.contractVersion !== MEDIA_RENDER_EXPORT_VERSION) fail("contractVersion mismatch");
  if (!["succeeded", "failed"].includes(record.status)) fail("status must be succeeded or failed");
  exactKeys(record.producer, ["repository", "sha"], "producer");
  if (record.producer.repository !== "foto6/video2") fail("producer repository mismatch");
  gitSha(record.producer.sha, "producer.sha");
  exactKeys(record.job, ["logicalJobId", "idempotencyKey", "renderFingerprint", "status"], "job");
  if (record.job.logicalJobId !== null) nonEmpty(record.job.logicalJobId, "job.logicalJobId");
  if (record.job.renderFingerprint !== null) sha256(record.job.renderFingerprint, "job.renderFingerprint");

  if (record.status === "succeeded") {
    if (!record.artifact || !record.probe || !record.qa?.technical || !record.qa?.creative || record.failure !== null) {
      fail("succeeded export requires artifact/probe/QA and no failure");
    }
    sha256(record.artifact.sha256, "artifact.sha256");
    if (!Number.isInteger(record.artifact.size) || record.artifact.size <= 0) fail("artifact.size must be positive");
    if (record.artifact.fileName !== "final.mp4") fail("canonical success export must bind final.mp4");
    if (record.qa.technical.passed !== true || record.qa.creative.passed !== true) fail("success QA must pass");
    if (record.benchmark?.technicalDq !== false) fail("success export must not claim benchmark readiness with a technical DQ");
  } else {
    if (record.artifact !== null) fail("failed export cannot contain successful artifact identity");
    if (!record.failure) fail("failed export requires failure record");
    nonEmpty(record.failure.code, "failure.code");
    nonEmpty(record.failure.message, "failure.message");
    if (record.benchmark?.technicalDq !== true) fail("failed export must remain benchmark DQ-visible");
  }
  if (record.benchmark?.binding?.protocol !== R15_BOSS_BENCHMARK_BINDING.protocol ||
      record.benchmark?.binding?.producerSha !== R15_BOSS_BENCHMARK_BINDING.producerSha ||
      record.benchmark?.binding?.gitBlobSha !== R15_BOSS_BENCHMARK_BINDING.gitBlobSha) {
    fail("boss benchmark binding mismatch");
  }
  return record;
}

export function validateRenderExportAgainstFinal(recordInput, finalPath) {
  const record = validateRenderExport(recordInput);
  if (record.status !== "succeeded") fail("only success exports bind final.mp4 bytes");
  if (!existsSync(finalPath)) fail("final.mp4 is missing");
  const bytes = hashFileSync(finalPath);
  if (bytes.sha256 !== record.artifact.sha256 || bytes.size !== record.artifact.size) {
    fail("render export hash/size mismatch against exact final.mp4 bytes");
  }
  const independent = probeFinal(finalPath);
  if (stableStringify(independent) !== stableStringify(record.probe)) {
    fail("render export ffprobe mismatch against exact final.mp4 bytes");
  }
  return record;
}

export function renderExportDigest(record) {
  return fingerprint(validateRenderExport(record));
}

export function writeRenderExportSidecar(recordInput, sidecarPath) {
  const record = validateRenderExport(recordInput);
  const content = `${stableStringify(record)}\n`;
  if (existsSync(sidecarPath)) {
    const existing = readFileSync(sidecarPath, "utf8");
    if (existing !== content) fail("render export replay conflict: existing sidecar differs");
    return { path: sidecarPath, replayed: true, sha256: createHash("sha256").update(content).digest("hex") };
  }
  writeFileSync(sidecarPath, content);
  return { path: sidecarPath, replayed: false, sha256: createHash("sha256").update(content).digest("hex") };
}

export function requireRenderExportSidecar(finalPath, fileName = MEDIA_RENDER_EXPORT_FILENAME) {
  const sidecarPath = path.join(path.dirname(finalPath), fileName);
  if (!existsSync(sidecarPath)) fail(`required render export sidecar is missing: ${fileName}`);
  const record = JSON.parse(readFileSync(sidecarPath, "utf8"));
  return validateRenderExportAgainstFinal(record, finalPath);
}
