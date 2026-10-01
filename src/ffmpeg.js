import { canonicalizeTimeline } from "./timeline.js";
import { isShortformR11Timeline, SHORTFORM_R11_PROFILE } from "./shortform-profile.js";

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

function sourceDurationMs(item) {
  const outputDuration = item.endMs - item.startMs;
  const speed = item.speed ?? 1;
  const needed = Math.round(outputDuration * speed);
  if (item.source?.outMs !== undefined) {
    const available = item.source.outMs - (item.source.inMs ?? 0);
    if (available < needed) throw new TypeError(`${item.id} source range is shorter than speed-adjusted duration`);
  }
  return needed;
}

function atempoFilters(speed) {
  const filters = [];
  let value = speed;
  while (value > 2) {
    filters.push("atempo=2");
    value /= 2;
  }
  while (value < 0.5) {
    filters.push("atempo=0.5");
    value /= 0.5;
  }
  if (Math.abs(value - 1) > 1e-9) filters.push(`atempo=${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`);
  return filters;
}

function motionFilter(item, canvas, durationMs) {
  if (!item.motion) return null;
  const zoom = item.motion.zoom ?? 1.08;
  const frames = Math.max(2, Math.round((durationMs / 1000) * canvas.fps));
  const last = Math.max(1, frames - 1);
  if (item.motion.type === "slow_push") {
    const delta = Math.max(0, zoom - 1);
    return `zoompan=z='min(1+on/${last}*${delta.toFixed(5)},${zoom})':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${canvas.width}x${canvas.height}:fps=${canvas.fps}`;
  }
  if (item.motion.type === "pan_left") {
    return `zoompan=z='${zoom}':x='(iw-iw/zoom)*(1-on/${last})':y='ih/2-ih/zoom/2':d=1:s=${canvas.width}x${canvas.height}:fps=${canvas.fps}`;
  }
  if (item.motion.type === "pan_right") {
    return `zoompan=z='${zoom}':x='(iw-iw/zoom)*on/${last}':y='ih/2-ih/zoom/2':d=1:s=${canvas.width}x${canvas.height}:fps=${canvas.fps}`;
  }
  return `zoompan=z='${zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${canvas.width}x${canvas.height}:fps=${canvas.fps}`;
}

function videoFilter(item, index, inputIndex, canvas) {
  const durationMs = item.endMs - item.startMs;
  const sourceInMs = item.source.inMs ?? 0;
  const speed = item.speed ?? 1;
  const parts = [
    `[${inputIndex}:v]trim=start=${seconds(sourceInMs)}:duration=${seconds(sourceDurationMs(item))}`,
    speed === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${speed}`
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
  const motion = motionFilter(item, canvas, durationMs);
  if (motion) parts.push(motion);
  parts.push(`fps=${canvas.fps}`, "setsar=1", "settb=AVTB");
  if (item.fadeInMs) parts.push(`fade=t=in:st=0:d=${seconds(item.fadeInMs)}`);
  if (item.fadeOutMs) parts.push(`fade=t=out:st=${seconds(durationMs - item.fadeOutMs)}:d=${seconds(item.fadeOutMs)}`);
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

function mixLabels(filters, labels, name) {
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  const output = `[${name}]`;
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0${output}`);
  return output;
}

function kineticPosition(item, axis, fallback) {
  const raw = item.position?.[axis] ?? item.style?.[axis] ?? fallback;
  const kinetic = item.style?.kinetic ?? "none";
  const amplitude = item.style?.motionAmplitudePx ?? 0;
  if (kinetic === "none" || amplitude === 0 || !Number.isFinite(raw)) return raw;
  if (kinetic === "bounce" && axis === "y") {
    return `'${raw}+${amplitude}*sin(8*(t-${seconds(item.startMs)}))'`;
  }
  if (kinetic === "slide" && axis === "x") {
    return `'${raw}+${amplitude}*max(0,1-(t-${seconds(item.startMs)})/0.18)'`;
  }
  return raw;
}

function normalizedLoudness(timeline, exportSpec) {
  if (exportSpec.loudness === false) return null;
  if (exportSpec.loudness && typeof exportSpec.loudness === "object") {
    return {
      integratedLufs: exportSpec.loudness.integratedLufs ?? SHORTFORM_R11_PROFILE.loudness.integratedLufs,
      truePeakDb: exportSpec.loudness.truePeakDb ?? SHORTFORM_R11_PROFILE.loudness.truePeakDb,
      lra: exportSpec.loudness.lra ?? SHORTFORM_R11_PROFILE.loudness.lra
    };
  }
  return isShortformR11Timeline(timeline) ? { ...SHORTFORM_R11_PROFILE.loudness } : null;
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
      const size = item.style?.fontSize ?? 56;
      const x = kineticPosition(item, "x", "(w-text_w)/2");
      const y = kineticPosition(item, "y", 180);
      const color = item.style?.fontColor ?? "white";
      const boxColor = item.style?.boxColor ?? "black@0.55";
      const box = item.style?.box === false ? "" : `:box=1:boxcolor=${boxColor}:boxborderw=20`;
      filters.push(`${videoOut}drawtext=text='${escapeDrawtext(item.text)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}${box}:enable='between(t,${seconds(item.startMs)},${seconds(item.endMs)})'${next}`);
    }
    videoOut = next;
  });

  const captions = timeline.tracks.filter((track) => track.kind === "caption").flatMap((track) => track.items);
  captions.forEach((item, index) => {
    if (!videoOut) return;
    const next = `[vsub${index}]`;
    const x = kineticPosition(item, "x", "(w-text_w)/2");
    const y = kineticPosition(item, "y", "h-text_h-300");
    const size = item.style?.fontSize ?? 64;
    const color = item.style?.fontColor ?? "white";
    const boxColor = item.style?.boxColor ?? "black@0.62";
    const box = item.style?.box === false ? "" : `:box=1:boxcolor=${boxColor}:boxborderw=18`;
    filters.push(`${videoOut}drawtext=text='${escapeDrawtext(item.text)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}${box}:enable='between(t,${seconds(item.startMs)},${seconds(item.endMs)})'${next}`);
    videoOut = next;
  });

  const audioItems = timeline.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.items);
  const audioLabels = [];
  const voiceLabels = [];
  const bedLabels = [];
  let duckRequested = false;
  audioItems.forEach((item, index) => {
    const idx = inputIndex.get(item.source.uri);
    const outputDuration = item.endMs - item.startMs;
    const speed = item.speed ?? 1;
    const label = `[a${index}]`;
    const parts = [
      `[${idx}:a]atrim=start=${seconds(item.source.inMs ?? 0)}:duration=${seconds(sourceDurationMs(item))}`,
      "asetpts=PTS-STARTPTS",
      ...atempoFilters(speed)
    ];
    if (item.fadeInMs) parts.push(`afade=t=in:st=0:d=${seconds(item.fadeInMs)}`);
    if (item.fadeOutMs) parts.push(`afade=t=out:st=${seconds(outputDuration - item.fadeOutMs)}:d=${seconds(item.fadeOutMs)}`);
    parts.push(`adelay=${item.startMs}|${item.startMs}`, `volume=${item.gainDb ?? 0}dB`);
    filters.push(`${parts.join(",")}${label}`);
    audioLabels.push(label);
    if (item.role === "voiceover") voiceLabels.push(label);
    else bedLabels.push(label);
    if (item.duckUnderVoice === true) duckRequested = true;
  });

  let audioOut = null;
  if (duckRequested && voiceLabels.length > 0 && bedLabels.length > 0) {
    const voice = mixLabels(filters, voiceLabels, "avoice");
    const bed = mixLabels(filters, bedLabels, "abed");
    filters.push(`${voice}asplit=2[avoice_mix][avoice_sc]`);
    filters.push(`${bed}[avoice_sc]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=350[aducked]`);
    filters.push(`[avoice_mix][aducked]amix=inputs=2:normalize=0:dropout_transition=0[amixed]`);
    audioOut = "[amixed]";
  } else {
    audioOut = mixLabels(filters, audioLabels, "amix");
  }

  const loudness = normalizedLoudness(timeline, exportSpec);
  if (audioOut && loudness) {
    filters.push(`${audioOut}loudnorm=I=${loudness.integratedLufs}:TP=${loudness.truePeakDb}:LRA=${loudness.lra},aresample=48000[anorm]`);
    audioOut = "[anorm]";
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
    "-metadata", "creation_time=1970-01-01T00:00:00Z",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-threads", "1",
    "-c:v", exportSpec.videoCodec ?? "libx264",
    "-pix_fmt", exportSpec.pixelFormat ?? "yuv420p",
    "-b:v", exportSpec.videoBitrate ?? "8M"
  );
  if (exportSpec.preset) args.push("-preset", String(exportSpec.preset));
  if (audioOut) args.push("-c:a", exportSpec.audioCodec ?? "aac", "-b:a", exportSpec.audioBitrate ?? "192k");
  else args.push("-an");
  const format = exportSpec.format ?? "mp4";
  if (format === "mp4") args.push("-movflags", "+faststart");
  args.push("-f", format, outputPath);
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
