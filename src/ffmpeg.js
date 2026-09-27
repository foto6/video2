import { canonicalizeTimeline } from "./timeline.js";

function seconds(ms) {
  return (ms / 1000).toFixed(3);
}

function escapeDrawtext(text) {
  return String(text)
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll("%", "\\%");
}

function collectInputs(timeline) {
  const uris = [];
  for (const track of timeline.tracks) {
    for (const item of track.items) {
      if (item.source?.uri && !uris.includes(item.source.uri)) uris.push(item.source.uri);
    }
  }
  return uris.sort();
}

function videoFilter(item, index, inputIndex, canvas) {
  const durationMs = item.endMs - item.startMs;
  const sourceInMs = item.source.inMs ?? 0;
  const parts = [
    `[${inputIndex}:v]trim=start=${seconds(sourceInMs)}:duration=${seconds(durationMs)}`,
    "setpts=PTS-STARTPTS"
  ];
  if (item.crop) {
    parts.push(`crop=${item.crop.width}:${item.crop.height}:${item.crop.x ?? 0}:${item.crop.y ?? 0}`);
    parts.push(`scale=${canvas.width}:${canvas.height}`);
  } else {
    parts.push(`scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase`);
    const x = item.reframe?.x ?? "(in_w-out_w)/2";
    const y = item.reframe?.y ?? "(in_h-out_h)/2";
    parts.push(`crop=${canvas.width}:${canvas.height}:${x}:${y}`);
  }
  parts.push("setsar=1");
  return `${parts.join(",")}[v${index}]`;
}

function chainVideos(items) {
  if (items.length === 0) return { filters: [], output: null };
  if (items.length === 1) return { filters: [], output: "[v0]" };

  const filters = [];
  let current = "[v0]";
  let elapsedMs = items[0].endMs - items[0].startMs;
  for (let i = 1; i < items.length; i += 1) {
    const previous = items[i - 1];
    const next = `[v${i}]`;
    const out = `[vc${i}]`;
    if (previous.transitionOut) {
      const transitionMs = previous.transitionOut.durationMs;
      const offsetMs = Math.max(0, elapsedMs - transitionMs);
      filters.push(
        `${current}${next}xfade=transition=${previous.transitionOut.type}:duration=${seconds(transitionMs)}:offset=${seconds(offsetMs)}${out}`
      );
      elapsedMs += (items[i].endMs - items[i].startMs) - transitionMs;
    } else {
      filters.push(`${current}${next}concat=n=2:v=1:a=0${out}`);
      elapsedMs += items[i].endMs - items[i].startMs;
    }
    current = out;
  }
  return { filters, output: current };
}

export function compileClipExtraction({ inputPath, outputPath, startMs = 0, durationMs, videoCodec = "libx264", audioCodec = "aac" }) {
  if (!inputPath || !outputPath) throw new TypeError("inputPath and outputPath are required");
  if (!Number.isInteger(startMs) || startMs < 0) throw new TypeError("startMs must be a non-negative integer");
  if (!Number.isInteger(durationMs) || durationMs <= 0) throw new TypeError("durationMs must be a positive integer");
  return {
    binary: "ffmpeg",
    args: [
      "-hide_banner", "-nostdin", "-y",
      "-ss", seconds(startMs),
      "-i", inputPath,
      "-t", seconds(durationMs),
      "-map_metadata", "-1",
      "-c:v", videoCodec,
      "-c:a", audioCodec,
      outputPath
    ]
  };
}

export function compileFfmpegCommand(timelineInput, exportSpec = {}, outputPath = "render.mp4") {
  const timeline = canonicalizeTimeline(timelineInput);
  const uris = collectInputs(timeline);
  const inputIndex = new Map(uris.map((uri, index) => [uri, index]));
  const args = ["-hide_banner", "-nostdin", "-y"];
  for (const uri of uris) args.push("-i", uri);

  const videoItems = timeline.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.items)
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  const filters = videoItems.map((item, index) => videoFilter(item, index, inputIndex.get(item.source.uri), timeline.canvas));
  const chained = chainVideos(videoItems);
  filters.push(...chained.filters);
  let videoOut = chained.output;

  const overlays = timeline.tracks.filter((track) => track.kind === "overlay").flatMap((track) => track.items);
  overlays.forEach((item, index) => {
    if (!videoOut) return;
    const next = `[vo${index}]`;
    if (item.source) {
      const idx = inputIndex.get(item.source.uri);
      const x = item.position?.x ?? 0;
      const y = item.position?.y ?? 0;
      filters.push(`${videoOut}[${idx}:v]overlay=x=${x}:y=${y}:enable='between(t,${seconds(item.startMs)},${seconds(item.endMs)})'${next}`);
    } else {
      filters.push(`${videoOut}drawtext=text='${escapeDrawtext(item.text)}':x=${item.position?.x ?? 0}:y=${item.position?.y ?? 0}:enable='between(t,${seconds(item.startMs)},${seconds(item.endMs)})'${next}`);
    }
    videoOut = next;
  });

  const captions = timeline.tracks.filter((track) => track.kind === "caption").flatMap((track) => track.items);
  captions.forEach((item, index) => {
    if (!videoOut) return;
    const next = `[vsub${index}]`;
    const x = item.style?.x ?? "(w-text_w)/2";
    const y = item.style?.y ?? "h-(text_h*2)";
    const size = item.style?.fontSize ?? 48;
    filters.push(`${videoOut}drawtext=text='${escapeDrawtext(item.text)}':x=${x}:y=${y}:fontsize=${size}:enable='between(t,${seconds(item.startMs)},${seconds(item.endMs)})'${next}`);
    videoOut = next;
  });

  const audioItems = timeline.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.items);
  const audioLabels = [];
  audioItems.forEach((item, index) => {
    const idx = inputIndex.get(item.source.uri);
    const duration = item.endMs - item.startMs;
    const label = `[a${index}]`;
    filters.push(
      `[${idx}:a]atrim=start=${seconds(item.source.inMs ?? 0)}:duration=${seconds(duration)},asetpts=PTS-STARTPTS,adelay=${item.startMs}|${item.startMs},volume=${item.gainDb ?? 0}dB${label}`
    );
    audioLabels.push(label);
  });

  let audioOut = null;
  if (audioLabels.length === 1) audioOut = audioLabels[0];
  if (audioLabels.length > 1) {
    audioOut = "[amix]";
    filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0${audioOut}`);
  }

  if (!videoOut) {
    filters.push(`color=c=black:s=${timeline.canvas.width}x${timeline.canvas.height}:r=${timeline.canvas.fps}:d=${seconds(timeline.canvas.durationMs)}[vblank]`);
    videoOut = "[vblank]";
  }

  args.push("-filter_complex", filters.join(";"), "-map", videoOut);
  if (audioOut) args.push("-map", audioOut);
  args.push(
    "-t", seconds(timeline.canvas.durationMs),
    "-r", String(timeline.canvas.fps),
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-threads", "1",
    "-c:v", exportSpec.videoCodec ?? "libx264",
    "-pix_fmt", exportSpec.pixelFormat ?? "yuv420p",
    "-b:v", exportSpec.videoBitrate ?? "8M"
  );
  if (audioOut) args.push("-c:a", exportSpec.audioCodec ?? "aac", "-b:a", exportSpec.audioBitrate ?? "192k");
  else args.push("-an");
  args.push(outputPath);
  return { binary: "ffmpeg", args };
}

export function captionsToSrt(timelineInput) {
  const timeline = canonicalizeTimeline(timelineInput);
  const captions = timeline.tracks
    .filter((track) => track.kind === "caption")
    .flatMap((track) => track.items)
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  function stamp(ms) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const secondsPart = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
  }

  return captions.map((item, index) => `${index + 1}\n${stamp(item.startMs)} --> ${stamp(item.endMs)}\n${item.text}\n`).join("\n");
}
