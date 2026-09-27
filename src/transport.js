import { win32 } from "node:path";

import { compileFfmpegCommand } from "./ffmpeg.js";
import { buildRenderPlan } from "./plan.js";
import { canonicalizeTimeline } from "./timeline.js";

export const MEDIA_RENDER_CONTRACT_VERSION = "media.render.v1";

const REQUEST_FIELDS = new Set([
  "contractVersion",
  "jobId",
  "timeline",
  "exportSpec",
  "outputPath",
  "dryRun"
]);

const PROTECTED_ROOT = win32.normalize("E:\\manhwa").toLowerCase();

function invariant(condition, message) {
  if (!condition) throw new TypeError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeWindowsPathCandidate(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Keep the literal form when a URI contains malformed percent encoding.
  }

  candidate = candidate.replace(/^file:(?:\/{1,3})?/i, "");
  candidate = candidate.replaceAll("/", "\\");
  candidate = candidate.replace(/^\\+([a-z]:\\)/i, "$1");
  if (candidate.toLowerCase().startsWith("\\\\?\\")) {
    candidate = candidate.slice(4);
  }
  if (!/^[a-z]:\\/i.test(candidate)) return null;
  return win32.normalize(candidate).toLowerCase();
}

function assertPathAllowed(value, label) {
  const normalized = normalizeWindowsPathCandidate(value);
  if (normalized === null) return;
  if (normalized === PROTECTED_ROOT || normalized.startsWith(`${PROTECTED_ROOT}\\`)) {
    throw new TypeError(`${label} references a protected path`);
  }
}

function assertRequestShape(request) {
  invariant(isPlainObject(request), "media.render.v1 request must be an object");

  const unknownFields = Object.keys(request).filter((key) => !REQUEST_FIELDS.has(key));
  invariant(unknownFields.length === 0, `media.render.v1 request contains unknown fields: ${unknownFields.join(", ")}`);

  for (const field of REQUEST_FIELDS) {
    invariant(Object.hasOwn(request, field), `media.render.v1 request is missing ${field}`);
  }

  invariant(
    request.contractVersion === MEDIA_RENDER_CONTRACT_VERSION,
    `contractVersion must be ${MEDIA_RENDER_CONTRACT_VERSION}`
  );
  invariant(typeof request.jobId === "string" && request.jobId.length > 0, "jobId is required");
  invariant(isPlainObject(request.timeline), "timeline must be an object");
  invariant(isPlainObject(request.exportSpec), "exportSpec must be an object");
  invariant(typeof request.outputPath === "string" && request.outputPath.length > 0, "outputPath is required");
  invariant(request.dryRun === true, "media.render.v1 only supports dryRun=true");
}

function assertTimelineSourcesAllowed(timeline) {
  for (const track of timeline.tracks) {
    for (const item of track.items) {
      if (item.source?.uri) {
        assertPathAllowed(item.source.uri, `timeline source ${item.id}`);
      }
    }
  }
}

export function parseMediaRenderRequest(request) {
  assertRequestShape(request);
  assertPathAllowed(request.outputPath, "outputPath");

  const timeline = canonicalizeTimeline(request.timeline);
  assertTimelineSourcesAllowed(timeline);

  return {
    contractVersion: MEDIA_RENDER_CONTRACT_VERSION,
    jobId: request.jobId,
    timeline,
    exportSpec: { ...request.exportSpec },
    outputPath: request.outputPath,
    dryRun: true
  };
}

export function handleMediaRenderRequest(request, _dependencies = {}) {
  const parsed = parseMediaRenderRequest(request);
  const plan = buildRenderPlan(parsed.timeline, parsed.exportSpec);
  const command = compileFfmpegCommand(parsed.timeline, parsed.exportSpec, parsed.outputPath);

  return {
    contractVersion: MEDIA_RENDER_CONTRACT_VERSION,
    jobId: parsed.jobId,
    dryRun: true,
    validation: {
      ok: true,
      timelineVersion: parsed.timeline.version
    },
    renderFingerprint: plan.fingerprint,
    command
  };
}
