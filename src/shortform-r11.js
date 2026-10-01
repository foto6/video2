import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { artifactManifestDigest } from "./runtime/artifact-manifest.js";
import { runtimeError } from "./runtime/errors.js";
import { resolveSandboxedPath } from "./runtime/path-policy.js";
import { DeterministicProcessExecutor } from "./runtime/process-executor.js";
import { fingerprint, stableStringify } from "./stable.js";
import { canonicalizeTimeline } from "./timeline.js";
import {
  MEDIA_SHORTFORM_BUNDLE_VERSION,
  MEDIA_SHORTFORM_PROFILE_VERSION,
  MEDIA_SHORTFORM_TIMELINE_SPEC_VERSION,
  SHORTFORM_R11_PROFILE,
  isShortformR11Timeline
} from "./shortform-profile.js";

const execFileAsync = promisify(execFile);

export const MEDIA_SHORTFORM_EDITOR_CONFORMANCE_VERSION = "media.shortform_editor.r11.v1";

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), size: statSync(filePath).size };
}

function parseRate(value) {
  if (typeof value !== "string") return null;
  const [a, b] = value.split("/").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

async function runCaptured(binary, args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    const result = await execFileAsync(binary, args, { encoding: "utf8", maxBuffer, windowsHide: true });
    return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : String(error?.message ?? error),
      code: error?.code ?? null
    };
  }
}

async function ffprobeInspect(filePath, ffprobeBinary) {
  const result = await runCaptured(ffprobeBinary, [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name,width,height,r_frame_rate,duration:format=duration,size",
    "-of", "json",
    filePath
  ]);
  if (!result.ok) return { ok: false, error: result.stderr.slice(-2000) };
  try {
    const parsed = JSON.parse(result.stdout);
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video") ?? null;
    const audio = streams.find((stream) => stream.codec_type === "audio") ?? null;
    const durationSeconds = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration);
    return {
      ok: true,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps: parseRate(video?.r_frame_rate),
      durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null
    };
  } catch (error) {
    return { ok: false, error: `invalid ffprobe JSON: ${error.message}` };
  }
}

function uniqueSources(timeline) {
  const sources = new Map();
  for (const track of timeline.tracks ?? []) {
    for (const item of track.items ?? []) {
      if (!item.source?.uri || sources.has(item.source.uri)) continue;
      sources.set(item.source.uri, {
        uri: item.source.uri,
        sourceId: item.source.id ?? item.id,
        expectedSha256: item.source.sha256 ?? null,
        expectedSize: item.source.size ?? null,
        expectedKind: track.kind === "audio" ? "audio" : "video"
      });
    }
  }
  return [...sources.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.uri.localeCompare(b.uri));
}

export async function inspectShortformSources(timelineInput, {
  sandboxRoot = process.cwd(),
  ffprobeBinary = "ffprobe"
} = {}) {
  const timeline = canonicalizeTimeline(timelineInput);
  const results = [];
  for (const source of uniqueSources(timeline)) {
    let resolved;
    try {
      resolved = resolveSandboxedPath(source.uri, { sandboxRoot, allowRemoteUri: true });
    } catch (error) {
      results.push({ ...source, exists: false, local: true, probeOk: false, sha256: null, size: null, error: error.code ?? error.message });
      continue;
    }
    if (resolved.kind !== "path") {
      results.push({ ...source, exists: null, local: false, probeOk: false, sha256: null, size: null, error: "remote_source_not_deterministic" });
      continue;
    }
    if (!existsSync(resolved.value)) {
      results.push({ ...source, exists: false, local: true, probeOk: false, sha256: null, size: null, error: "source_missing" });
      continue;
    }
    const digest = await hashFile(resolved.value);
    const media = await ffprobeInspect(resolved.value, ffprobeBinary);
    const kindOk = media.ok && (source.expectedKind === "audio" ? media.hasAudio : media.hasVideo);
    results.push({
      ...source,
      exists: true,
      local: true,
      probeOk: Boolean(kindOk),
      sha256: digest.sha256,
      size: digest.size,
      media: media.ok ? {
        hasVideo: media.hasVideo,
        hasAudio: media.hasAudio,
        width: media.width,
        height: media.height,
        durationMs: media.durationMs,
        videoCodec: media.videoCodec,
        audioCodec: media.audioCodec
      } : null,
      error: media.ok ? null : media.error
    });
  }
  return results;
}

export function evaluateShortformSourceProvenance(evidence) {
  const failures = [];
  for (const entry of evidence ?? []) {
    if (entry.exists !== true) failures.push({ sourceId: entry.sourceId, reason: entry.error ?? "source_missing" });
    else if (entry.probeOk !== true) failures.push({ sourceId: entry.sourceId, reason: "source_corrupt_or_wrong_stream" });
    if (entry.expectedSha256 && entry.sha256 !== entry.expectedSha256) failures.push({ sourceId: entry.sourceId, reason: "source_sha256_mismatch" });
    if (entry.expectedSize !== null && entry.expectedSize !== undefined && entry.size !== entry.expectedSize) failures.push({ sourceId: entry.sourceId, reason: "source_size_mismatch" });
  }
  return { passed: failures.length === 0, failures };
}

function sumTaggedDurations(text, tag) {
  const regex = new RegExp(`${tag}:\\s*([0-9.]+)`, "g");
  let total = 0;
  let match;
  while ((match = regex.exec(text)) !== null) total += Number(match[1]) || 0;
  return total;
}

function maxTaggedDuration(text, tag) {
  const regex = new RegExp(`${tag}:\\s*([0-9.]+)`, "g");
  let max = 0;
  let match;
  while ((match = regex.exec(text)) !== null) max = Math.max(max, Number(match[1]) || 0);
  return max;
}

function parseDb(text, label) {
  const match = text.match(new RegExp(`${label}:\\s*(-?(?:inf|[0-9.]+))\\s*dB`, "i"));
  if (!match) return null;
  if (match[1].toLowerCase() === "-inf") return -Infinity;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export class FfmpegQaProbe {
  constructor({ store = null, sandboxRoot = process.cwd(), ffmpegBinary = "ffmpeg", ffprobeBinary = "ffprobe" } = {}) {
    this.store = store;
    this.sandboxRoot = sandboxRoot;
    this.ffmpegBinary = ffmpegBinary;
    this.ffprobeBinary = ffprobeBinary;
  }

  #jobForOutput(outputPath) {
    if (!this.store || typeof this.store.list !== "function") return null;
    return this.store.list().find((job) => job.tempOutputPath === outputPath || job.resolvedOutputPath === outputPath) ?? null;
  }

  async inspect(outputPath) {
    const media = await ffprobeInspect(outputPath, this.ffprobeBinary);
    if (!media.ok) throw runtimeError("probe_corrupt", `ffprobe could not read render output: ${media.error}`);
    const durationSeconds = Math.max(0.001, (media.durationMs ?? 0) / 1000);

    let videoAnalysis = { ok: true, stderr: "" };
    if (media.hasVideo) {
      videoAnalysis = await runCaptured(this.ffmpegBinary, [
        "-hide_banner", "-nostdin", "-i", outputPath,
        "-vf", "blackdetect=d=0.4:pix_th=0.10,freezedetect=n=-50dB:d=1.0",
        "-an", "-f", "null", "-"
      ]);
    }

    let audioAnalysis = { ok: true, stderr: "" };
    if (media.hasAudio) {
      audioAnalysis = await runCaptured(this.ffmpegBinary, [
        "-hide_banner", "-nostdin", "-i", outputPath,
        "-af", "silencedetect=n=-45dB:d=0.8,volumedetect",
        "-vn", "-f", "null", "-"
      ]);
    }

    const job = this.#jobForOutput(outputPath);
    const sourceEvidence = job?.timeline && isShortformR11Timeline(job.timeline)
      ? await inspectShortformSources(job.timeline, { sandboxRoot: this.sandboxRoot, ffprobeBinary: this.ffprobeBinary })
      : undefined;
    const digest = await hashFile(outputPath);
    const blackSeconds = sumTaggedDurations(videoAnalysis.stderr, "black_duration");
    const silenceSeconds = sumTaggedDurations(audioAnalysis.stderr, "silence_duration");

    return {
      hasVideo: media.hasVideo,
      hasAudio: media.hasAudio,
      width: media.width,
      height: media.height,
      fps: media.fps,
      durationMs: media.durationMs,
      videoCodec: media.videoCodec,
      audioCodec: media.audioCodec,
      outputSize: digest.size,
      outputSha256: digest.sha256,
      probeCorrupt: false,
      analysisComplete: videoAnalysis.ok && audioAnalysis.ok,
      blackFrameRatio: media.hasVideo ? Math.min(1, blackSeconds / durationSeconds) : undefined,
      maxFreezeDurationMs: media.hasVideo ? Math.round(maxTaggedDuration(videoAnalysis.stderr, "freeze_duration") * 1000) : undefined,
      silenceRatio: media.hasAudio ? Math.min(1, silenceSeconds / durationSeconds) : undefined,
      meanDb: media.hasAudio ? parseDb(audioAnalysis.stderr, "mean_volume") : undefined,
      peakDb: media.hasAudio ? parseDb(audioAnalysis.stderr, "max_volume") : undefined,
      sourceEvidence
    };
  }
}

export class ShortformFfmpegExecutor {
  constructor({
    store,
    sandboxRoot = process.cwd(),
    executor = new DeterministicProcessExecutor(),
    ffprobeBinary = "ffprobe"
  } = {}) {
    if (!store || typeof store.list !== "function") throw new TypeError("store.list is required");
    if (!executor || typeof executor.run !== "function") throw new TypeError("executor.run is required");
    this.store = store;
    this.sandboxRoot = sandboxRoot;
    this.executor = executor;
    this.ffprobeBinary = ffprobeBinary;
  }

  async run(command, options = {}) {
    const outputPath = command?.args?.at?.(-1);
    const job = this.store.list().find((entry) => entry.tempOutputPath === outputPath) ?? null;
    if (job?.timeline && isShortformR11Timeline(job.timeline)) {
      const evidence = await inspectShortformSources(job.timeline, {
        sandboxRoot: this.sandboxRoot,
        ffprobeBinary: this.ffprobeBinary
      });
      const provenance = evaluateShortformSourceProvenance(evidence);
      if (!provenance.passed) {
        throw runtimeError("source_provenance_failure", "R11 source preflight failed", provenance);
      }
    }
    return this.executor.run(command, options);
  }
}

function ensureOk(result, label) {
  if (!result || result.ok !== true) {
    throw runtimeError("derivative_failed", `${label} failed`, { result: result ?? null });
  }
}

function moveContentAddressed(tempPath, outputDir, kind, extension, digest) {
  const finalPath = path.join(outputDir, `${kind}.sha256-${digest.sha256}.${extension}`);
  if (existsSync(finalPath)) unlinkSync(tempPath);
  else renameSync(tempPath, finalPath);
  return finalPath;
}

function writeContentAddressedJson(outputDir, kind, value) {
  const content = `${stableStringify(value)}\n`;
  const sha256 = createHash("sha256").update(content).digest("hex");
  const filePath = path.join(outputDir, `${kind}.sha256-${sha256}.json`);
  writeFileSync(filePath, content);
  return { path: filePath, sha256, size: Buffer.byteLength(content), contentId: `sha256:${sha256}` };
}

function publicSourceEvidence(evidence) {
  return (evidence ?? []).map((entry) => ({
    sourceId: entry.sourceId,
    expectedKind: entry.expectedKind,
    sha256: entry.sha256,
    size: entry.size,
    contentId: entry.sha256 ? `sha256:${entry.sha256}` : null,
    probeOk: entry.probeOk === true
  })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export async function materializeShortformArtifacts({
  finalPath,
  timeline,
  exportSpec = {},
  qa,
  artifactManifest,
  sourceEvidence,
  outputDir,
  executor = new DeterministicProcessExecutor(),
  previewDurationMs = 3000
}) {
  if (!isShortformR11Timeline(timeline)) throw new TypeError("R11 short-form timeline is required");
  if (!qa?.passed) throw runtimeError("qa_failed", "cannot materialize derivatives without passing QA");
  if (!artifactManifest) throw new TypeError("artifactManifest is required");
  mkdirSync(outputDir, { recursive: true });

  const primary = await hashFile(finalPath);
  if (primary.sha256 !== artifactManifest.content.sha256 || primary.size !== artifactManifest.content.size) {
    throw runtimeError("artifact_integrity_failure", "primary artifact bytes do not match media.artifact_manifest.v1");
  }

  const timelineSpec = {
    contractVersion: MEDIA_SHORTFORM_TIMELINE_SPEC_VERSION,
    profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
    timeline: canonicalizeTimeline(timeline),
    exportSpec: JSON.parse(JSON.stringify(exportSpec))
  };
  const timelineArtifact = writeContentAddressedJson(outputDir, "timeline", timelineSpec);

  const previewTemp = path.join(outputDir, ".preview.tmp.mp4");
  const previewSeconds = Math.max(1, previewDurationMs) / 1000;
  const previewResult = await executor.run({
    binary: "ffmpeg",
    args: [
      "-hide_banner", "-nostdin", "-y", "-i", finalPath,
      "-t", previewSeconds.toFixed(3),
      "-vf", "scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2:black",
      "-map_metadata", "-1", "-threads", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-f", "mp4", previewTemp
    ]
  });
  ensureOk(previewResult, "preview render");
  const previewDigest = await hashFile(previewTemp);
  const previewPath = moveContentAddressed(previewTemp, outputDir, "preview", "mp4", previewDigest);

  const thumbnailTemp = path.join(outputDir, ".thumbnail.tmp.jpg");
  const thumbnailResult = await executor.run({
    binary: "ffmpeg",
    args: [
      "-hide_banner", "-nostdin", "-y", "-ss", "1.000", "-i", finalPath,
      "-frames:v", "1",
      "-vf", "scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2:black",
      "-map_metadata", "-1", "-q:v", "2", "-f", "image2", thumbnailTemp
    ]
  });
  ensureOk(thumbnailResult, "thumbnail render");
  const thumbnailDigest = await hashFile(thumbnailTemp);
  const thumbnailPath = moveContentAddressed(thumbnailTemp, outputDir, "thumbnail", "jpg", thumbnailDigest);

  const bundle = {
    contractVersion: MEDIA_SHORTFORM_BUNDLE_VERSION,
    profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
    logicalJobId: artifactManifest.logicalJobId,
    idempotencyKey: artifactManifest.idempotencyKey,
    renderFingerprint: artifactManifest.renderFingerprint,
    primary: {
      contentId: artifactManifest.content.contentId,
      sha256: primary.sha256,
      size: primary.size,
      artifactManifestSha256: artifactManifestDigest(artifactManifest)
    },
    timelineSpec: {
      contentId: timelineArtifact.contentId,
      sha256: timelineArtifact.sha256,
      size: timelineArtifact.size
    },
    preview: { contentId: `sha256:${previewDigest.sha256}`, sha256: previewDigest.sha256, size: previewDigest.size },
    thumbnail: { contentId: `sha256:${thumbnailDigest.sha256}`, sha256: thumbnailDigest.sha256, size: thumbnailDigest.size },
    sources: publicSourceEvidence(sourceEvidence),
    qaEvidence: { sha256: fingerprint(qa), value: JSON.parse(JSON.stringify(qa)) }
  };
  const bundleArtifact = writeContentAddressedJson(outputDir, "bundle", bundle);
  return {
    bundle,
    bundleArtifact,
    timelineArtifact,
    preview: { path: previewPath, ...previewDigest },
    thumbnail: { path: thumbnailPath, ...thumbnailDigest }
  };
}

export function validateShortformR11Contract(timeline) {
  const canonical = canonicalizeTimeline(timeline);
  if (!isShortformR11Timeline(canonical)) throw new TypeError("timeline must use media.shortform_profile.r11.v1");
  return {
    contractVersion: MEDIA_SHORTFORM_EDITOR_CONFORMANCE_VERSION,
    profile: SHORTFORM_R11_PROFILE,
    timeline: canonical,
    timelineSha256: fingerprint(canonical)
  };
}
