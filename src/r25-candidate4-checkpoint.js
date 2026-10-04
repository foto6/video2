import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { canonicalizeTimeline } from "./timeline.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_R25_CANDIDATE4_SUBPHASE_VERSION = "media.r25.candidate4_subphase.v1";
export const MEDIA_R25_CANDIDATE4_CHECKPOINT_VERSION = "media.r25.candidate4_checkpoint.v1";

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function sha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("r25_checkpoint_invalid", `${label} must be lowercase SHA-256`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("r25_checkpoint_invalid", `${label} must be exact Git SHA`);
  }
}
function hashFile(filePath) {
  if (!existsSync(filePath)) fail("r25_checkpoint_missing", `missing checkpoint artifact: ${filePath}`);
  const bytes = readFileSync(filePath);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}
function overlap(item, startMs, endMs) {
  return item.startMs < endMs && startMs < item.endMs;
}

export function sliceTimelineForR25Checkpoint(timelineInput, startMs, endMs) {
  const timeline = canonicalizeTimeline(timelineInput);
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs <= startMs || endMs > timeline.canvas.durationMs) {
    fail("r25_checkpoint_invalid", "checkpoint slice interval is invalid");
  }
  const sliced = clone(timeline);
  sliced.id = `${timeline.id}-r25-checkpoint-${startMs}-${endMs}`;
  sliced.canvas.durationMs = endMs - startMs;
  // Checkpoint segments are internal render intermediates, not reviewable R11
  // final artifacts. Keep the frozen full candidate timeline/profile for final
  // assembly QA, but do not apply the R11 >=5s final-output duration invariant
  // to a deliberately shorter durable segment.
  delete sliced.profileVersion;
  delete sliced.creativePlan;
  sliced.tracks = timeline.tracks.map((track) => {
    const items = [];
    for (const item of track.items) {
      if (!overlap(item, startMs, endMs)) continue;
      const clippedStart = Math.max(item.startMs, startMs);
      const clippedEnd = Math.min(item.endMs, endMs);
      const copy = clone(item);
      if (item.motion && (clippedStart !== item.startMs || clippedEnd !== item.endMs)) {
        const totalFrames = Math.max(2, Math.round(((item.endMs - item.startMs) / 1000) * timeline.canvas.fps));
        const progressStartFrame = Math.round(((clippedStart - item.startMs) / 1000) * timeline.canvas.fps);
        copy.motion = {
          ...copy.motion,
          checkpointProgressStartFrame: progressStartFrame,
          checkpointProgressTotalFrames: totalFrames
        };
      }
      copy.id = `${item.id}__r25seg_${startMs}_${endMs}`;
      copy.startMs = clippedStart - startMs;
      copy.endMs = clippedEnd - startMs;
      if (copy.source) {
        const speed = item.speed ?? 1;
        const originalIn = item.source.inMs ?? 0;
        const sourceOffset = Math.round((clippedStart - item.startMs) * speed);
        const sourceDuration = Math.round((clippedEnd - clippedStart) * speed);
        copy.source.inMs = originalIn + sourceOffset;
        copy.source.outMs = copy.source.inMs + sourceDuration;
      }
      if (clippedStart !== item.startMs) delete copy.fadeInMs;
      if (clippedEnd !== item.endMs) {
        delete copy.fadeOutMs;
        delete copy.transitionOut;
      }
      items.push(copy);
    }
    return { ...clone(track), items };
  }).filter((track) => track.items.length > 0);
  return canonicalizeTimeline(sliced);
}

export function buildR25Candidate4Decomposition({
  tournamentId,
  candidateId,
  producerSha,
  source,
  operationGraphDigest,
  runtimeManifestSha256,
  timeline
} = {}) {
  gitSha(producerSha, "producerSha");
  sha(source?.sha256, "source.sha256");
  sha(operationGraphDigest, "operationGraphDigest");
  sha(runtimeManifestSha256, "runtimeManifestSha256");
  const canonical = canonicalizeTimeline(timeline);
  const videoItems = canonical.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.items)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  if (!videoItems.length) fail("r25_checkpoint_no_video", "candidate-4 has no video items");
  const maxMotionChunkMs = 800;
  const rawSegments = [];
  for (const item of videoItems) {
    if (item.motion && item.endMs - item.startMs > maxMotionChunkMs) {
      for (let start = item.startMs; start < item.endMs; start += maxMotionChunkMs) {
        rawSegments.push({ startMs: start, endMs: Math.min(item.endMs, start + maxMotionChunkMs) });
      }
    } else {
      rawSegments.push({ startMs: item.startMs, endMs: item.endMs });
    }
  }
  if (rawSegments[0].startMs !== 0 || rawSegments.at(-1).endMs !== canonical.canvas.durationMs) {
    fail("r25_checkpoint_video_coverage", "candidate-4 video segments must cover full output duration");
  }
  for (let i = 1; i < rawSegments.length; i += 1) {
    if (rawSegments[i - 1].endMs !== rawSegments[i].startMs) {
      fail("r25_checkpoint_video_coverage", "candidate-4 durable segments must be contiguous");
    }
  }
  const common = {
    contractVersion: MEDIA_R25_CANDIDATE4_SUBPHASE_VERSION,
    tournamentId,
    candidateId,
    producerSha,
    source: { sourceId: source.sourceId, sha256: source.sha256, size: source.size },
    operationGraphDigest,
    timelineDigest: fingerprint(canonical),
    runtimeManifestSha256
  };
  const segments = rawSegments.map((range, index) => ({
    phase: `segment-${index + 1}`,
    ...range
  })).map((segment) => {
    const sliced = sliceTimelineForR25Checkpoint(canonical, segment.startMs, segment.endMs);
    const input = { ...common, ...segment, segmentTimelineDigest: fingerprint(sliced) };
    return {
      ...segment,
      segmentTimelineDigest: input.segmentTimelineDigest,
      operationId: `r25c4:${fingerprint(input)}`
    };
  });
  return {
    ...common,
    splitMs: segments[0]?.endMs ?? null,
    durationMs: canonical.canvas.durationMs,
    maxMotionChunkMs,
    decompositionDigest: fingerprint({ ...common, maxMotionChunkMs, segments }),
    segments
  };
}

export function buildR25Candidate4Checkpoint({
  decomposition,
  segment,
  inputs = [],
  output,
  durationMs,
  elapsedMs
} = {}) {
  if (!decomposition || !segment) fail("r25_checkpoint_invalid", "decomposition and segment required");
  sha(output?.sha256, "output.sha256");
  if (!Number.isInteger(output?.size) || output.size <= 0) fail("r25_checkpoint_invalid", "output.size invalid");
  const checkpoint = {
    contractVersion: MEDIA_R25_CANDIDATE4_CHECKPOINT_VERSION,
    authority: {
      tournamentId: decomposition.tournamentId,
      candidateId: decomposition.candidateId,
      producerSha: decomposition.producerSha,
      source: clone(decomposition.source),
      operationGraphDigest: decomposition.operationGraphDigest,
      timelineDigest: decomposition.timelineDigest,
      runtimeManifestSha256: decomposition.runtimeManifestSha256,
      decompositionDigest: decomposition.decompositionDigest
    },
    phase: segment.phase,
    operationId: segment.operationId,
    interval: { startMs: segment.startMs, endMs: segment.endMs },
    segmentTimelineDigest: segment.segmentTimelineDigest,
    inputs: inputs.map(clone),
    output: clone(output),
    durationMs,
    elapsedMs,
    complete: true,
    modelReviewPerformed: false,
    providerPublish: false,
    humanQuality: false
  };
  return validateR25Candidate4Checkpoint(checkpoint, { decomposition, segment });
}

export function validateR25Candidate4Checkpoint(input, { decomposition, segment, outputPath = null } = {}) {
  const checkpoint = clone(input);
  if (checkpoint.contractVersion !== MEDIA_R25_CANDIDATE4_CHECKPOINT_VERSION || checkpoint.complete !== true) {
    fail("r25_checkpoint_invalid", "checkpoint contract/completion mismatch");
  }
  if (!decomposition || !segment) fail("r25_checkpoint_invalid", "expected decomposition/segment required");
  const expectedAuthority = {
    tournamentId: decomposition.tournamentId,
    candidateId: decomposition.candidateId,
    producerSha: decomposition.producerSha,
    source: decomposition.source,
    operationGraphDigest: decomposition.operationGraphDigest,
    timelineDigest: decomposition.timelineDigest,
    runtimeManifestSha256: decomposition.runtimeManifestSha256,
    decompositionDigest: decomposition.decompositionDigest
  };
  if (stableStringify(checkpoint.authority) !== stableStringify(expectedAuthority)) {
    fail("r25_checkpoint_conflict", "checkpoint authority/source/graph/runtime mismatch");
  }
  if (
    checkpoint.phase !== segment.phase ||
    checkpoint.operationId !== segment.operationId ||
    checkpoint.segmentTimelineDigest !== segment.segmentTimelineDigest ||
    checkpoint.interval?.startMs !== segment.startMs ||
    checkpoint.interval?.endMs !== segment.endMs
  ) fail("r25_checkpoint_conflict", "checkpoint phase operation identity mismatch");
  sha(checkpoint.output?.sha256, "checkpoint.output.sha256");
  if (!Number.isInteger(checkpoint.output?.size) || checkpoint.output.size <= 0) {
    fail("r25_checkpoint_invalid", "checkpoint output size invalid");
  }
  if (
    checkpoint.modelReviewPerformed !== false ||
    checkpoint.providerPublish !== false ||
    checkpoint.humanQuality !== false
  ) fail("r25_checkpoint_invalid", "checkpoint evidence boundary violated");
  if (outputPath) {
    const actual = hashFile(outputPath);
    if (actual.sha256 !== checkpoint.output.sha256 || actual.size !== checkpoint.output.size) {
      fail("r25_checkpoint_corrupt", "checkpoint output bytes/hash mismatch");
    }
  }
  return checkpoint;
}

export function r25Candidate4ResumeState({
  decomposition,
  checkpoints = null,
  checkpoint1 = null,
  checkpoint2 = null,
  final = null
} = {}) {
  const segments = decomposition?.segments ?? [];
  if (segments.length < 2) fail("r25_checkpoint_invalid", "multi-segment decomposition required");
  const supplied = Array.isArray(checkpoints)
    ? checkpoints
    : [checkpoint1, checkpoint2].filter(Boolean);
  const reused = [];
  for (let index = 0; index < supplied.length; index += 1) {
    if (index >= segments.length) fail("r25_checkpoint_invalid", "too many segment checkpoints supplied");
    validateR25Candidate4Checkpoint(supplied[index], { decomposition, segment: segments[index] });
    reused.push(segments[index].phase);
  }
  if (supplied.length < segments.length) {
    return { nextPhase: segments[supplied.length].phase, reused };
  }
  if (!final) return { nextPhase: "assemble", reused };
  return { nextPhase: "complete", reused: [...reused, "assemble"] };
}
