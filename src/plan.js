import { canonicalizeTimeline } from "./timeline.js";
import { fingerprint } from "./stable.js";
import { isShortformR11Timeline, SHORTFORM_R11_PROFILE } from "./shortform-profile.js";

function inputKey(source) {
  return source?.uri ?? null;
}

function frames(ms, fps) {
  return Math.round((ms / 1000) * fps);
}

function inputEntry(uri, source) {
  const entry = { id: "", uri };
  if (source?.id) entry.sourceId = source.id;
  if (source?.sha256) entry.sha256 = source.sha256;
  if (source?.size !== undefined) entry.size = source.size;
  return entry;
}

export function buildRenderPlan(timelineInput, exportSpec = {}) {
  const timeline = canonicalizeTimeline(timelineInput);
  const sources = new Map();
  for (const track of timeline.tracks) {
    for (const item of track.items) {
      if (!item.source) continue;
      const uri = inputKey(item.source);
      if (!sources.has(uri)) sources.set(uri, inputEntry(uri, item.source));
    }
  }

  const inputs = [...sources.values()]
    .sort((a, b) => a.uri.localeCompare(b.uri))
    .map((entry, index) => ({ ...entry, id: `input-${String(index + 1).padStart(3, "0")}` }));
  const inputByUri = new Map(inputs.map((entry) => [entry.uri, entry.id]));
  const operations = [];
  const sequences = [];

  for (const track of timeline.tracks) {
    for (const item of track.items) {
      const sequence = {
        id: item.id,
        trackId: track.id,
        kind: track.kind,
        fromFrame: frames(item.startMs, timeline.canvas.fps),
        durationInFrames: frames(item.endMs - item.startMs, timeline.canvas.fps)
      };
      if (item.role) sequence.role = item.role;
      sequences.push(sequence);

      if (item.source) {
        operations.push({
          type: "clip.extract",
          itemId: item.id,
          inputId: inputByUri.get(item.source.uri),
          sourceInMs: item.source.inMs ?? 0,
          durationMs: item.endMs - item.startMs
        });
      }
      if (item.speed !== undefined && item.speed !== 1) {
        operations.push({ type: "time.speed", itemId: item.id, speed: item.speed });
      }
      if (track.kind === "video" && (item.crop || item.reframe)) {
        operations.push({ type: "video.reframe", itemId: item.id, crop: item.crop ?? null, reframe: item.reframe ?? null });
      }
      if (track.kind === "caption") {
        operations.push({ type: "caption.render", itemId: item.id, text: item.text, style: item.style ?? {} });
      }
      if (track.kind === "overlay") {
        const operation = { type: "overlay.compose", itemId: item.id, text: item.text ?? null, position: item.position ?? { x: 0, y: 0 } };
        if (item.role) operation.role = item.role;
        operations.push(operation);
      }
      if (track.kind === "audio") {
        const operation = { type: "audio.mix", itemId: item.id, gainDb: item.gainDb ?? 0 };
        if (item.role) operation.role = item.role;
        if (item.duckUnderVoice !== undefined) operation.duckUnderVoice = item.duckUnderVoice;
        operations.push(operation);
      }
      if (item.fadeInMs || item.fadeOutMs) {
        operations.push({
          type: track.kind === "audio" ? "audio.fade" : "video.fade",
          itemId: item.id,
          fadeInMs: item.fadeInMs ?? 0,
          fadeOutMs: item.fadeOutMs ?? 0
        });
      }
      if (item.transitionOut) {
        operations.push({
          type: "transition.apply",
          itemId: item.id,
          transitionType: item.transitionOut.type,
          durationMs: item.transitionOut.durationMs
        });
      }
    }
  }

  sequences.sort((a, b) => a.fromFrame - b.fromFrame || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  operations.sort((a, b) => a.itemId.localeCompare(b.itemId) || a.type.localeCompare(b.type));

  const exportConfig = {
    format: exportSpec.format ?? "mp4",
    videoCodec: exportSpec.videoCodec ?? "libx264",
    audioCodec: exportSpec.audioCodec ?? "aac",
    videoBitrate: exportSpec.videoBitrate ?? "8M",
    audioBitrate: exportSpec.audioBitrate ?? "192k",
    pixelFormat: exportSpec.pixelFormat ?? "yuv420p"
  };
  if (exportSpec.preset) exportConfig.preset = exportSpec.preset;
  if (exportSpec.loudness && typeof exportSpec.loudness === "object") exportConfig.loudness = { ...exportSpec.loudness };
  else if (isShortformR11Timeline(timeline)) exportConfig.loudness = { ...SHORTFORM_R11_PROFILE.loudness };

  const core = {
    schemaVersion: 1,
    timelineId: timeline.id,
    canvas: timeline.canvas,
    inputs,
    composition: { type: "remotion-style", sequences },
    operations,
    export: exportConfig
  };
  if (timeline.profileVersion) core.profileVersion = timeline.profileVersion;
  return { ...core, fingerprint: fingerprint(core), timeline };
}
