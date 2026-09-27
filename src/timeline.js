const TRACK_KINDS = new Set(["video", "audio", "caption", "overlay"]);

function invariant(condition, message) {
  if (!condition) throw new TypeError(message);
}

function positiveInteger(value, path) {
  invariant(Number.isInteger(value) && value > 0, `${path} must be a positive integer`);
}

function nonNegativeInteger(value, path) {
  invariant(Number.isInteger(value) && value >= 0, `${path} must be a non-negative integer`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateSource(source, path) {
  invariant(source && typeof source === "object", `${path} is required`);
  invariant(typeof source.uri === "string" && source.uri.length > 0, `${path}.uri is required`);
  if (source.inMs !== undefined) nonNegativeInteger(source.inMs, `${path}.inMs`);
  if (source.outMs !== undefined) positiveInteger(source.outMs, `${path}.outMs`);
  if (source.inMs !== undefined && source.outMs !== undefined) {
    invariant(source.outMs > source.inMs, `${path}.outMs must be greater than inMs`);
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

      if (track.kind === "video" || track.kind === "audio") {
        validateSource(item.source, `${itemPath}.source`);
      }
      if (track.kind === "overlay") {
        invariant(item.source || item.text, `${itemPath} requires source or text`);
        if (item.source) validateSource(item.source, `${itemPath}.source`);
      }
      if (track.kind === "caption") {
        invariant(typeof item.text === "string" && item.text.length > 0, `${itemPath}.text is required`);
      }
      if (item.transitionOut) {
        invariant(track.kind === "video", `${itemPath}.transitionOut is only valid on video items`);
        invariant(["fade", "wipeleft", "wiperight"].includes(item.transitionOut.type), `${itemPath}.transitionOut.type is unsupported`);
        positiveInteger(item.transitionOut.durationMs, `${itemPath}.transitionOut.durationMs`);
        invariant(item.transitionOut.durationMs < item.endMs - item.startMs, `${itemPath}.transitionOut is too long`);
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
