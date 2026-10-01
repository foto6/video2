import { MEDIA_SHORTFORM_PROFILE_VERSION, SHORTFORM_R11_PROFILE } from "./shortform-profile.js";

const TRACK_KINDS = new Set(["video", "audio", "caption", "overlay"]);
const VIDEO_ROLES = new Set(["intro", "body", "outro"]);
const AUDIO_ROLES = new Set(["voiceover", "music", "sfx", "ambient"]);
const OVERLAY_ROLES = new Set(["intro", "cta", "outro", "label"]);

function invariant(condition, message) {
  if (!condition) throw new TypeError(message);
}

function positiveInteger(value, path) {
  invariant(Number.isInteger(value) && value > 0, `${path} must be a positive integer`);
}

function nonNegativeInteger(value, path) {
  invariant(Number.isInteger(value) && value >= 0, `${path} must be a non-negative integer`);
}

function finiteNumber(value, path) {
  invariant(Number.isFinite(value), `${path} must be finite`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateSource(source, path) {
  invariant(source && typeof source === "object", `${path} is required`);
  invariant(typeof source.uri === "string" && source.uri.length > 0, `${path}.uri is required`);
  if (source.id !== undefined) invariant(typeof source.id === "string" && source.id.length > 0, `${path}.id must be non-empty`);
  if (source.sha256 !== undefined) invariant(/^[a-f0-9]{64}$/.test(source.sha256), `${path}.sha256 must be lowercase SHA-256`);
  if (source.size !== undefined) nonNegativeInteger(source.size, `${path}.size`);
  if (source.inMs !== undefined) nonNegativeInteger(source.inMs, `${path}.inMs`);
  if (source.outMs !== undefined) positiveInteger(source.outMs, `${path}.outMs`);
  if (source.inMs !== undefined && source.outMs !== undefined) {
    invariant(source.outMs > source.inMs, `${path}.outMs must be greater than inMs`);
  }
}

function validateStyle(style, path) {
  if (style === undefined) return;
  invariant(style && typeof style === "object" && !Array.isArray(style), `${path} must be an object`);
  for (const key of ["fontSize", "maxWidth", "marginX", "marginBottom", "lineHeight"]) {
    if (style[key] !== undefined) positiveInteger(style[key], `${path}.${key}`);
  }
  for (const key of ["x", "y"]) {
    if (style[key] !== undefined) {
      invariant(typeof style[key] === "string" || Number.isFinite(style[key]), `${path}.${key} must be numeric or an FFmpeg expression`);
    }
  }
}

export function validateTimeline(input) {
  invariant(input && typeof input === "object", "timeline must be an object");
  invariant(input.version === 1, "timeline.version must be 1");
  invariant(typeof input.id === "string" && input.id.length > 0, "timeline.id is required");
  invariant(input.canvas && typeof input.canvas === "object", "timeline.canvas is required");
  positiveInteger(input.canvas.width, "timeline.canvas.width");
  positiveInteger(input.canvas.height, "timeline.canvas.height");
  positiveInteger(input.canvas.fps, "timeline.canvas.fps");
  positiveInteger(input.canvas.durationMs, "timeline.canvas.durationMs");
  invariant(Array.isArray(input.tracks), "timeline.tracks must be an array");

  if (input.profileVersion !== undefined) {
    invariant(input.profileVersion === MEDIA_SHORTFORM_PROFILE_VERSION, "timeline.profileVersion is unsupported");
    invariant(input.canvas.width === SHORTFORM_R11_PROFILE.width, "R11 short-form width must be 1080");
    invariant(input.canvas.height === SHORTFORM_R11_PROFILE.height, "R11 short-form height must be 1920");
    invariant(input.canvas.fps === SHORTFORM_R11_PROFILE.fps, "R11 short-form fps must be 30");
    invariant(
      input.canvas.durationMs >= SHORTFORM_R11_PROFILE.targetDurationMs.min &&
      input.canvas.durationMs <= SHORTFORM_R11_PROFILE.targetDurationMs.max,
      `R11 short-form duration must be ${SHORTFORM_R11_PROFILE.targetDurationMs.min}-${SHORTFORM_R11_PROFILE.targetDurationMs.max}ms`
    );
  }

  const trackIds = new Set();
  const itemIds = new Set();
  input.tracks.forEach((track, trackIndex) => {
    const path = `timeline.tracks[${trackIndex}]`;
    invariant(track && typeof track === "object", `${path} must be an object`);
    invariant(typeof track.id === "string" && track.id.length > 0, `${path}.id is required`);
    invariant(!trackIds.has(track.id), `duplicate track id: ${track.id}`);
    trackIds.add(track.id);
    invariant(TRACK_KINDS.has(track.kind), `${path}.kind is unsupported`);
    invariant(Array.isArray(track.items), `${path}.items must be an array`);

    track.items.forEach((item, itemIndex) => {
      const itemPath = `${path}.items[${itemIndex}]`;
      invariant(typeof item.id === "string" && item.id.length > 0, `${itemPath}.id is required`);
      invariant(!itemIds.has(item.id), `duplicate item id: ${item.id}`);
      itemIds.add(item.id);
      nonNegativeInteger(item.startMs, `${itemPath}.startMs`);
      positiveInteger(item.endMs, `${itemPath}.endMs`);
      invariant(item.endMs > item.startMs, `${itemPath}.endMs must be greater than startMs`);
      invariant(item.endMs <= input.canvas.durationMs, `${itemPath} exceeds timeline duration`);

      if (track.kind === "video" || track.kind === "audio") validateSource(item.source, `${itemPath}.source`);
      if (track.kind === "overlay") {
        invariant(item.source || item.text, `${itemPath} requires source or text`);
        if (item.source) validateSource(item.source, `${itemPath}.source`);
      }
      if (track.kind === "caption") {
        invariant(typeof item.text === "string" && item.text.length > 0, `${itemPath}.text is required`);
        validateStyle(item.style, `${itemPath}.style`);
      }
      if (item.speed !== undefined) {
        finiteNumber(item.speed, `${itemPath}.speed`);
        invariant(item.speed >= 0.25 && item.speed <= 4, `${itemPath}.speed must be between 0.25 and 4`);
      }
      for (const fadeKey of ["fadeInMs", "fadeOutMs"]) {
        if (item[fadeKey] !== undefined) {
          positiveInteger(item[fadeKey], `${itemPath}.${fadeKey}`);
          invariant(item[fadeKey] < item.endMs - item.startMs, `${itemPath}.${fadeKey} is too long`);
        }
      }
      if (item.transitionOut) {
        invariant(track.kind === "video", `${itemPath}.transitionOut is only valid on video items`);
        invariant(["fade", "wipeleft", "wiperight"].includes(item.transitionOut.type), `${itemPath}.transitionOut.type is unsupported`);
        positiveInteger(item.transitionOut.durationMs, `${itemPath}.transitionOut.durationMs`);
        invariant(item.transitionOut.durationMs < item.endMs - item.startMs, `${itemPath}.transitionOut is too long`);
      }
      if (item.role !== undefined) {
        const allowed = track.kind === "audio" ? AUDIO_ROLES : track.kind === "overlay" ? OVERLAY_ROLES : VIDEO_ROLES;
        invariant(track.kind !== "caption" && allowed.has(item.role), `${itemPath}.role is unsupported for ${track.kind}`);
      }
      if (item.duckUnderVoice !== undefined) {
        invariant(track.kind === "audio" && typeof item.duckUnderVoice === "boolean", `${itemPath}.duckUnderVoice is only valid on audio items`);
      }
    });
  });
  return true;
}

export function canonicalizeTimeline(input) {
  validateTimeline(input);
  const timeline = clone(input);
  timeline.tracks.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  for (const track of timeline.tracks) {
    track.items.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  }
  return timeline;
}

export function expectedMediaShape(input) {
  const timeline = canonicalizeTimeline(input);
  return {
    width: timeline.canvas.width,
    height: timeline.canvas.height,
    fps: timeline.canvas.fps,
    durationMs: timeline.canvas.durationMs,
    hasAudio: timeline.tracks.some((track) => track.kind === "audio" && track.items.length > 0)
  };
}
