import { fingerprint } from "./stable.js";
import { canonicalizeTimeline } from "./timeline.js";
import { MEDIA_SHORTFORM_PROFILE_VERSION, SHORTFORM_R11_PROFILE } from "./shortform-profile.js";

export const MEDIA_CREATIVE_EDIT_PLAN_VERSION = "media.creative_edit_plan.r12.v1";
export const MEDIA_CREATIVE_QUALITY_REPORT_VERSION = "media.creative_quality_report.r12.v1";

export const R12_GUARDRAILS = Object.freeze({
  maxCutRatePerSecond: 1.25,
  maxZoomRatePerSecond: 0.30,
  maxTransitionDensityPerSecond: 0.20,
  maxTextCharsPerSecond: 22,
  maxMusicGainDb: -10,
  maxConcurrentTextItems: 2,
  maxMotionZoom: 1.18
});

export const CREATIVE_STYLES = Object.freeze({
  clean_podcast: Object.freeze({
    id: "clean_podcast",
    hookCadenceMs: 1800,
    regularCadenceMs: 3600,
    sentenceSnapMs: 320,
    beatSnapMs: 120,
    minDeadAirMs: 420,
    silenceHandleMs: 120,
    motionEveryCuts: 4,
    motionPattern: Object.freeze(["punch_in", "pan_right"]),
    maxZoom: 1.08,
    captionPreset: "clean",
    captionKinetic: "none",
    brollEveryCuts: 5,
    musicGainDb: -18,
    ctaDurationMs: 1200
  }),
  aggressive_shortform: Object.freeze({
    id: "aggressive_shortform",
    hookCadenceMs: 900,
    regularCadenceMs: 1700,
    sentenceSnapMs: 220,
    beatSnapMs: 180,
    minDeadAirMs: 260,
    silenceHandleMs: 80,
    motionEveryCuts: 2,
    motionPattern: Object.freeze(["punch_in", "pan_left", "slow_push"]),
    maxZoom: 1.14,
    captionPreset: "impact",
    captionKinetic: "bounce",
    brollEveryCuts: 3,
    musicGainDb: -16,
    ctaDurationMs: 1100
  }),
  cinematic_minimal: Object.freeze({
    id: "cinematic_minimal",
    hookCadenceMs: 2600,
    regularCadenceMs: 5200,
    sentenceSnapMs: 420,
    beatSnapMs: 200,
    minDeadAirMs: 650,
    silenceHandleMs: 180,
    motionEveryCuts: 5,
    motionPattern: Object.freeze(["slow_push", "pan_right"]),
    maxZoom: 1.06,
    captionPreset: "minimal",
    captionKinetic: "none",
    brollEveryCuts: 6,
    musicGainDb: -20,
    ctaDurationMs: 1400
  })
});

const STYLE_IDS = new Set(Object.keys(CREATIVE_STYLES));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new TypeError(message);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteMs(value, label) {
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative finite number`);
}

function normalizePoints(points, durationMs) {
  return [...new Set((points ?? [])
    .filter(Number.isFinite)
    .map((value) => Math.round(clamp(value, 0, durationMs))))]
    .sort((a, b) => a - b);
}

function normalizeRanges(ranges, durationMs) {
  const out = [];
  for (const range of ranges ?? []) {
    if (!range || typeof range !== "object") continue;
    finiteMs(range.startMs, "range.startMs");
    finiteMs(range.endMs, "range.endMs");
    if (range.endMs <= range.startMs) continue;
    out.push({
      startMs: Math.round(clamp(range.startMs, 0, durationMs)),
      endMs: Math.round(clamp(range.endMs, 0, durationMs))
    });
  }
  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [];
  for (const range of out) {
    if (range.endMs <= range.startMs) continue;
    const last = merged.at(-1);
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else merged.push(range);
  }
  return merged;
}

function nearestPoint(target, points, toleranceMs) {
  let best = null;
  let distance = Infinity;
  for (const point of points) {
    const nextDistance = Math.abs(point - target);
    if (nextDistance < distance || (nextDistance === distance && point < best)) {
      best = point;
      distance = nextDistance;
    }
  }
  return distance <= toleranceMs ? best : target;
}

function buildRemovalRanges(hints, style, durationMs) {
  const raw = normalizeRanges(hints.silenceRanges, durationMs);
  const boundaries = normalizePoints(hints.sentenceBoundariesMs, durationMs);
  const removals = [];
  for (const range of raw) {
    if (range.endMs - range.startMs < style.minDeadAirMs) continue;
    let startMs = range.startMs + style.silenceHandleMs;
    let endMs = range.endMs - style.silenceHandleMs;
    if (endMs - startMs < 120) continue;
    startMs = nearestPoint(startMs, boundaries, style.sentenceSnapMs);
    endMs = nearestPoint(endMs, boundaries, style.sentenceSnapMs);
    startMs = clamp(startMs, range.startMs, range.endMs);
    endMs = clamp(endMs, range.startMs, range.endMs);
    if (endMs - startMs >= 120) removals.push({ startMs, endMs });
  }
  return normalizeRanges(removals, durationMs);
}

function removedBefore(timeMs, removals) {
  let total = 0;
  for (const range of removals) {
    if (timeMs <= range.startMs) break;
    total += Math.max(0, Math.min(timeMs, range.endMs) - range.startMs);
  }
  return total;
}

function compressedTime(timeMs, removals) {
  return Math.round(timeMs - removedBefore(timeMs, removals));
}

function overlapsRemoval(startMs, endMs, removals) {
  return removals.some((range) => startMs < range.endMs && endMs > range.startMs);
}

function keepSpans(durationMs, removals) {
  const spans = [];
  let cursor = 0;
  for (const range of removals) {
    if (range.startMs > cursor) spans.push({ startMs: cursor, endMs: range.startMs });
    cursor = Math.max(cursor, range.endMs);
  }
  if (cursor < durationMs) spans.push({ startMs: cursor, endMs: durationMs });
  return spans;
}

function splitSourceItemBySpans(item, spans, removals) {
  const parts = [];
  let index = 0;
  const speed = item.speed ?? 1;
  for (const span of spans) {
    const startMs = Math.max(item.startMs, span.startMs);
    const endMs = Math.min(item.endMs, span.endMs);
    if (endMs - startMs < 80) continue;
    const sourceInMs = (item.source?.inMs ?? 0) + Math.round((startMs - item.startMs) * speed);
    const next = clone(item);
    next.id = `${item.id}~tight-${String(index + 1).padStart(2, "0")}`;
    next.startMs = compressedTime(startMs, removals);
    next.endMs = compressedTime(endMs, removals);
    next.source = { ...next.source, inMs: sourceInMs, outMs: sourceInMs + Math.round((endMs - startMs) * speed) };
    delete next.transitionOut;
    delete next.fadeInMs;
    delete next.fadeOutMs;
    parts.push(next);
    index += 1;
  }
  return parts;
}

function remapTimelineForDeadAir(timeline, removals) {
  if (removals.length === 0) return clone(timeline);
  const spans = keepSpans(timeline.canvas.durationMs, removals);
  const next = clone(timeline);
  next.canvas.durationMs = compressedTime(timeline.canvas.durationMs, removals);
  for (const track of next.tracks) {
    if (track.kind === "video" || track.kind === "audio" && track.items.some((item) => item.role === "voiceover")) {
      const sourceItems = [];
      for (const item of track.items) {
        if (track.kind === "audio" && item.role !== "voiceover") {
          const moved = clone(item);
          moved.startMs = compressedTime(item.startMs, removals);
          moved.endMs = Math.min(next.canvas.durationMs, compressedTime(item.endMs, removals));
          if (moved.endMs > moved.startMs) sourceItems.push(moved);
        } else {
          sourceItems.push(...splitSourceItemBySpans(item, spans, removals));
        }
      }
      track.items = sourceItems;
      continue;
    }

    const items = [];
    for (const item of track.items) {
      const moved = clone(item);
      const oldDuration = item.endMs - item.startMs;
      moved.startMs = compressedTime(item.startMs, removals);
      moved.endMs = compressedTime(item.endMs, removals);
      if (moved.endMs <= moved.startMs || oldDuration <= removedBefore(item.endMs, removals) - removedBefore(item.startMs, removals)) continue;
      items.push(moved);
    }
    track.items = items;
  }
  return next;
}

function remapPoints(points, removals, durationMs) {
  return normalizePoints(points, durationMs)
    .filter((point) => !overlapsRemoval(point, point + 1, removals))
    .map((point) => compressedTime(point, removals));
}

function desiredCutPoints(durationMs, style, sentencePoints, beatPoints) {
  const cuts = [];
  let cursor = style.hookCadenceMs;
  while (cursor < durationMs - 350) {
    let target = cursor;
    target = nearestPoint(target, sentencePoints, style.sentenceSnapMs);
    target = nearestPoint(target, beatPoints, style.beatSnapMs);
    if (target > 300 && target < durationMs - 300 && (cuts.length === 0 || target - cuts.at(-1) >= 350)) cuts.push(target);
    cursor += cursor < SHORTFORM_R11_PROFILE.hookWindowMs ? style.hookCadenceMs : style.regularCadenceMs;
  }
  const maxCuts = Math.floor((durationMs / 1000) * R12_GUARDRAILS.maxCutRatePerSecond);
  return cuts.slice(0, Math.max(0, maxCuts));
}

function splitVideoAtCuts(timeline, cuts) {
  const next = clone(timeline);
  for (const track of next.tracks) {
    if (track.kind !== "video") continue;
    const items = [];
    for (const item of track.items) {
      const localCuts = cuts.filter((point) => point > item.startMs + 250 && point < item.endMs - 250);
      const boundaries = [item.startMs, ...localCuts, item.endMs];
      for (let index = 0; index < boundaries.length - 1; index += 1) {
        const startMs = boundaries[index];
        const endMs = boundaries[index + 1];
        const part = clone(item);
        const speed = item.speed ?? 1;
        part.id = `${item.id}~cut-${String(index + 1).padStart(2, "0")}`;
        part.startMs = startMs;
        part.endMs = endMs;
        part.source = {
          ...part.source,
          inMs: (item.source?.inMs ?? 0) + Math.round((startMs - item.startMs) * speed),
          outMs: (item.source?.inMs ?? 0) + Math.round((endMs - item.startMs) * speed)
        };
        delete part.transitionOut;
        delete part.fadeInMs;
        delete part.fadeOutMs;
        items.push(part);
      }
    }
    track.items = items.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  }
  return next;
}

function saliencyAt(hints, timeMs) {
  const candidates = (hints.saliency ?? [])
    .filter((entry) => entry && Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs) && timeMs >= entry.startMs && timeMs < entry.endMs)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.startMs - b.startMs);
  return candidates[0] ?? null;
}

function reframeForSaliency(entry) {
  if (!entry || !Number.isFinite(entry.centerX) || !Number.isFinite(entry.centerY)) {
    return { x: "(in_w-out_w)/2", y: "(in_h-out_h)/2" };
  }
  const x = clamp(entry.centerX, 0, 1).toFixed(4);
  const y = clamp(entry.centerY, 0, 1).toFixed(4);
  return { x: `(in_w-out_w)*${x}`, y: `(in_h-out_h)*${y}` };
}

function chooseBroll(candidates, index, durationMs) {
  const eligible = (candidates ?? [])
    .filter((candidate) => candidate?.source?.sha256 && candidate?.source?.size >= 0 && (candidate.durationMs ?? Infinity) >= durationMs)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.id).localeCompare(String(b.id)));
  return eligible.length ? eligible[index % eligible.length] : null;
}

function applyCreativeVideoDecisions(timeline, hints, style) {
  const next = clone(timeline);
  const videoItems = next.tracks.filter((track) => track.kind === "video").flatMap((track) => track.items)
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  let motionIndex = 0;
  let brollIndex = 0;
  const maxMotionCount = Math.floor((next.canvas.durationMs / 1000) * R12_GUARDRAILS.maxZoomRatePerSecond);

  videoItems.forEach((item, index) => {
    const middle = Math.round((item.startMs + item.endMs) / 2);
    const saliency = saliencyAt(hints, middle);
    item.reframe = reframeForSaliency(saliency);
    item.creativeMeta = {
      ...(item.creativeMeta ?? {}),
      saliency: saliency ? {
        centerX: clamp(saliency.centerX, 0, 1),
        centerY: clamp(saliency.centerY, 0, 1),
        confidence: saliency.confidence ?? null
      } : null
    };

    if (index > 0 && style.brollEveryCuts > 0 && index % style.brollEveryCuts === 0) {
      const candidate = chooseBroll(hints.brollCandidates, brollIndex, item.endMs - item.startMs);
      if (candidate) {
        item.source = clone(candidate.source);
        item.role = "broll";
        item.creativeMeta.brollCandidateId = candidate.id;
        brollIndex += 1;
      }
    }

    if (index > 0 && style.motionEveryCuts > 0 && index % style.motionEveryCuts === 0 && motionIndex < maxMotionCount) {
      const type = style.motionPattern[motionIndex % style.motionPattern.length];
      item.motion = {
        type,
        zoom: Math.min(style.maxZoom, R12_GUARDRAILS.maxMotionZoom),
        amplitudePx: type.startsWith("pan_") ? 54 : 0
      };
      motionIndex += 1;
    }
  });
  return next;
}

function captionStyle(style, emphasized = false) {
  const safeBottomY = 1440;
  if (style.captionPreset === "impact") {
    return {
      fontSize: emphasized ? 78 : 68,
      maxWidth: 900,
      y: safeBottomY,
      fontColor: emphasized ? "yellow" : "white",
      boxColor: "black@0.68",
      kinetic: emphasized ? "bounce" : style.captionKinetic,
      motionAmplitudePx: emphasized ? 10 : 6
    };
  }
  if (style.captionPreset === "minimal") {
    return {
      fontSize: emphasized ? 58 : 52,
      maxWidth: 820,
      y: 1480,
      fontColor: "white",
      boxColor: "black@0.38",
      kinetic: "none",
      motionAmplitudePx: 0
    };
  }
  return {
    fontSize: emphasized ? 70 : 62,
    maxWidth: 860,
    y: 1460,
    fontColor: emphasized ? "yellow" : "white",
    boxColor: "black@0.58",
    kinetic: emphasized ? "bounce" : "none",
    motionAmplitudePx: emphasized ? 8 : 0
  };
}

function styleCaptions(timeline, hints, style) {
  const next = clone(timeline);
  const tokens = Array.isArray(hints.captionTokens) ? hints.captionTokens : null;
  let captionTrack = next.tracks.find((track) => track.kind === "caption");
  if (!captionTrack && tokens?.length) {
    captionTrack = { id: "creative-captions", kind: "caption", items: [] };
    next.tracks.push(captionTrack);
  }
  if (!captionTrack) return next;

  if (tokens?.length) {
    captionTrack.items = tokens
      .filter((token) => token && typeof token.text === "string" && token.text.length > 0)
      .map((token, index) => ({
        id: token.id ?? `creative-token-${String(index + 1).padStart(3, "0")}`,
        startMs: Math.round(clamp(token.startMs ?? 0, 0, next.canvas.durationMs - 1)),
        endMs: Math.round(clamp(token.endMs ?? next.canvas.durationMs, 1, next.canvas.durationMs)),
        text: token.emphasis ? token.text.toUpperCase() : token.text,
        style: captionStyle(style, token.emphasis === true),
        creativeMeta: { emphasis: token.emphasis === true }
      }))
      .filter((item) => item.endMs > item.startMs);
  } else {
    captionTrack.items = captionTrack.items.map((item, index) => ({
      ...item,
      style: { ...captionStyle(style, index === 0), ...(item.style ?? {}) },
      creativeMeta: { ...(item.creativeMeta ?? {}), emphasis: index === 0 }
    }));
  }
  return next;
}

function applyMusicGuardrail(timeline, style) {
  const next = clone(timeline);
  for (const track of next.tracks) {
    if (track.kind !== "audio") continue;
    for (const item of track.items) {
      if (item.role === "music") {
        item.gainDb = Math.min(item.gainDb ?? style.musicGainDb, style.musicGainDb, R12_GUARDRAILS.maxMusicGainDb);
        item.duckUnderVoice = true;
      }
    }
  }
  return next;
}

function addCta(timeline, request, style) {
  if (request.cta === false) return clone(timeline);
  const next = clone(timeline);
  let overlayTrack = next.tracks.find((track) => track.kind === "overlay");
  if (!overlayTrack) {
    overlayTrack = { id: "creative-overlays", kind: "overlay", items: [] };
    next.tracks.push(overlayTrack);
  }
  const duration = Math.min(style.ctaDurationMs, Math.max(600, next.canvas.durationMs - 1000));
  overlayTrack.items.push({
    id: "creative-cta",
    startMs: next.canvas.durationMs - duration,
    endMs: next.canvas.durationMs - 80,
    role: "cta",
    text: request.ctaText ?? "FOLLOW FOR MORE",
    position: { x: 90, y: 260 },
    style: {
      fontSize: style.id === "aggressive_shortform" ? 66 : 56,
      fontColor: "white",
      boxColor: "black@0.56",
      kinetic: style.id === "aggressive_shortform" ? "slide" : "none",
      motionAmplitudePx: style.id === "aggressive_shortform" ? 16 : 0
    }
  });
  return next;
}

function addLoopBridge(timeline, enabled) {
  if (!enabled) return clone(timeline);
  const next = clone(timeline);
  const track = next.tracks.find((entry) => entry.kind === "video" && entry.items.length > 0);
  if (!track || track.items.length < 1 || next.canvas.durationMs < 1200) return next;
  const first = track.items[0];
  const bridgeMs = 360;
  const endMs = next.canvas.durationMs;
  const cutAt = endMs - bridgeMs;
  const last = track.items.at(-1);
  if (last.startMs < cutAt && last.endMs > cutAt) last.endMs = cutAt;
  track.items = track.items.filter((item) => item.endMs <= cutAt || item.startMs < cutAt);
  track.items.push({
    ...clone(first),
    id: "creative-loop-bridge",
    startMs: cutAt,
    endMs,
    role: "loop_bridge",
    source: { ...clone(first.source), inMs: first.source?.inMs ?? 0, outMs: (first.source?.inMs ?? 0) + bridgeMs * (first.speed ?? 1) },
    creativeMeta: { ...(first.creativeMeta ?? {}), loopBridge: true }
  });
  return next;
}

function textItems(timeline) {
  return timeline.tracks
    .filter((track) => track.kind === "caption" || track.kind === "overlay")
    .flatMap((track) => track.items.map((item) => ({ ...item, kind: track.kind })));
}

function rangesOverlap(a, b) {
  return a.startMs < b.endMs && a.endMs > b.startMs;
}

function textBox(item, timeline) {
  const style = item.style ?? {};
  const fontSize = style.fontSize ?? 64;
  const width = Math.min(style.maxWidth ?? timeline.canvas.width, Math.ceil(String(item.text ?? "").length * fontSize * 0.58));
  const height = Math.ceil(style.lineHeight ?? fontSize * 1.25);
  const x = Number.isFinite(item.position?.x) ? item.position.x :
    Number.isFinite(style.x) ? style.x : Math.round((timeline.canvas.width - width) / 2);
  const y = Number.isFinite(item.position?.y) ? item.position.y :
    Number.isFinite(style.y) ? style.y : timeline.canvas.height - SHORTFORM_R11_PROFILE.safeArea.bottom - height;
  const amp = style.motionAmplitudePx ?? 0;
  return { x: x - amp, y: y - amp, width: width + amp * 2, height: height + amp * 2 };
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function creativeMetrics(timelineInput) {
  const timeline = canonicalizeTimeline(timelineInput);
  const durationSeconds = Math.max(0.001, timeline.canvas.durationMs / 1000);
  const videos = timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.items);
  const cuts = Math.max(0, videos.length - 1);
  const zooms = videos.filter((item) => item.motion).length;
  const transitions = videos.filter((item) => item.transitionOut).length;
  const texts = textItems(timeline);
  const textChars = texts.reduce((sum, item) => sum + String(item.text ?? "").length, 0);
  const musicGains = timeline.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.items)
    .filter((item) => item.role === "music").map((item) => item.gainDb ?? 0);
  return {
    durationMs: timeline.canvas.durationMs,
    cuts,
    cutRatePerSecond: cuts / durationSeconds,
    zooms,
    zoomRatePerSecond: zooms / durationSeconds,
    transitions,
    transitionDensityPerSecond: transitions / durationSeconds,
    textChars,
    textCharsPerSecond: textChars / durationSeconds,
    musicMaxGainDb: musicGains.length ? Math.max(...musicGains) : null
  };
}

export function evaluateCreativeVisualQa(timelineInput, probe = {}) {
  const timeline = canonicalizeTimeline(timelineInput);
  const metrics = creativeMetrics(timeline);
  const items = textItems(timeline);
  const textCollisions = [];
  const subtitleOcclusions = [];
  let maxConcurrentText = 0;

  for (let index = 0; index < items.length; index += 1) {
    const active = items.filter((candidate) => rangesOverlap(items[index], candidate)).length;
    maxConcurrentText = Math.max(maxConcurrentText, active);
    for (let other = index + 1; other < items.length; other += 1) {
      if (!rangesOverlap(items[index], items[other])) continue;
      if (!boxesOverlap(textBox(items[index], timeline), textBox(items[other], timeline))) continue;
      textCollisions.push([items[index].id, items[other].id]);
      if (items[index].kind === "caption" || items[other].kind === "caption") {
        subtitleOcclusions.push([items[index].id, items[other].id]);
      }
    }
  }

  const unsafeCrops = timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.items)
    .filter((item) => {
      const saliency = item.creativeMeta?.saliency;
      const zoom = item.motion?.zoom ?? 1;
      return saliency && zoom > 1.1 &&
        (saliency.centerX < 0.06 || saliency.centerX > 0.94 || saliency.centerY < 0.05 || saliency.centerY > 0.95);
    }).map((item) => item.id);

  const repeatedSourceWindows = [];
  const videos = timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.items);
  for (let index = 0; index < videos.length; index += 1) {
    const a = videos[index];
    if (a.creativeMeta?.loopBridge) continue;
    const aStart = a.source?.inMs ?? 0;
    const aEnd = a.source?.outMs ?? aStart + (a.endMs - a.startMs) * (a.speed ?? 1);
    for (let other = index + 1; other < videos.length; other += 1) {
      const b = videos[other];
      if (b.creativeMeta?.loopBridge || a.source?.uri !== b.source?.uri) continue;
      const bStart = b.source?.inMs ?? 0;
      const bEnd = b.source?.outMs ?? bStart + (b.endMs - b.startMs) * (b.speed ?? 1);
      if (Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 180) repeatedSourceWindows.push([a.id, b.id]);
    }
  }

  const checks = [
    { name: "creative-subtitle-occlusion", pass: subtitleOcclusions.length === 0, actual: subtitleOcclusions.length, expected: 0, details: subtitleOcclusions },
    { name: "creative-text-collision", pass: textCollisions.length === 0, actual: textCollisions.length, expected: 0, details: textCollisions },
    { name: "creative-concurrent-text", pass: maxConcurrentText <= R12_GUARDRAILS.maxConcurrentTextItems, actual: maxConcurrentText, expected: `<=${R12_GUARDRAILS.maxConcurrentTextItems}` },
    { name: "creative-excessive-motion", pass: metrics.zoomRatePerSecond <= R12_GUARDRAILS.maxZoomRatePerSecond, actual: metrics.zoomRatePerSecond, expected: `<=${R12_GUARDRAILS.maxZoomRatePerSecond}` },
    { name: "creative-unsafe-crop", pass: unsafeCrops.length === 0, actual: unsafeCrops.length, expected: 0, details: unsafeCrops },
    { name: "creative-repeated-source-window", pass: repeatedSourceWindows.length === 0, actual: repeatedSourceWindows.length, expected: 0, details: repeatedSourceWindows },
    { name: "creative-transition-spam", pass: metrics.transitionDensityPerSecond <= R12_GUARDRAILS.maxTransitionDensityPerSecond, actual: metrics.transitionDensityPerSecond, expected: `<=${R12_GUARDRAILS.maxTransitionDensityPerSecond}` }
  ];

  if (probe.maxFreezeDurationMs !== undefined) {
    checks.push({
      name: "creative-repeated-frames",
      pass: probe.maxFreezeDurationMs <= 1500,
      actual: probe.maxFreezeDurationMs,
      expected: "<=1500"
    });
  }
  return { passed: checks.every((entry) => entry.pass), checks, metrics };
}

export function evaluateCreativeQuality(timelineInput, probe = {}) {
  const timeline = canonicalizeTimeline(timelineInput);
  const metrics = creativeMetrics(timeline);
  const guardrails = [
    { name: "cut-rate", pass: metrics.cutRatePerSecond <= R12_GUARDRAILS.maxCutRatePerSecond, actual: metrics.cutRatePerSecond, expected: `<=${R12_GUARDRAILS.maxCutRatePerSecond}` },
    { name: "zoom-rate", pass: metrics.zoomRatePerSecond <= R12_GUARDRAILS.maxZoomRatePerSecond, actual: metrics.zoomRatePerSecond, expected: `<=${R12_GUARDRAILS.maxZoomRatePerSecond}` },
    { name: "transition-density", pass: metrics.transitionDensityPerSecond <= R12_GUARDRAILS.maxTransitionDensityPerSecond, actual: metrics.transitionDensityPerSecond, expected: `<=${R12_GUARDRAILS.maxTransitionDensityPerSecond}` },
    { name: "text-density", pass: metrics.textCharsPerSecond <= R12_GUARDRAILS.maxTextCharsPerSecond, actual: metrics.textCharsPerSecond, expected: `<=${R12_GUARDRAILS.maxTextCharsPerSecond}` },
    { name: "music-loudness", pass: metrics.musicMaxGainDb === null || metrics.musicMaxGainDb <= R12_GUARDRAILS.maxMusicGainDb, actual: metrics.musicMaxGainDb, expected: `<=${R12_GUARDRAILS.maxMusicGainDb}dB` }
  ];
  const visual = evaluateCreativeVisualQa(timeline, probe);
  return {
    contractVersion: MEDIA_CREATIVE_QUALITY_REPORT_VERSION,
    passed: guardrails.every((entry) => entry.pass) && visual.passed,
    metrics,
    guardrails,
    visualQa: visual,
    creativePlanDigest: timeline.creativePlan?.planDigest ?? null
  };
}

export function compileCreativeEditPlan(request) {
  if (!request || typeof request !== "object") fail("creative edit request is required");
  if (!STYLE_IDS.has(request.style)) fail("unsupported creative style");
  const style = CREATIVE_STYLES[request.style];
  const base = canonicalizeTimeline(request.timeline);
  if (base.profileVersion !== MEDIA_SHORTFORM_PROFILE_VERSION) fail("R12 requires an R11 short-form timeline");
  const hints = clone(request.hints ?? {});
  const removals = buildRemovalRanges(hints, style, base.canvas.durationMs);

  let timeline = remapTimelineForDeadAir(base, removals);
  const sentencePoints = remapPoints(hints.sentenceBoundariesMs, removals, base.canvas.durationMs);
  const beatPoints = remapPoints(hints.beatMarkersMs, removals, base.canvas.durationMs);
  const cuts = desiredCutPoints(timeline.canvas.durationMs, style, sentencePoints, beatPoints);
  timeline = splitVideoAtCuts(timeline, cuts);
  timeline = applyCreativeVideoDecisions(timeline, hints, style);
  timeline = styleCaptions(timeline, hints, style);
  timeline = applyMusicGuardrail(timeline, style);
  timeline = addLoopBridge(timeline, request.loopFriendly === true);
  timeline = addCta(timeline, request, style);

  const decisionCore = {
    contractVersion: MEDIA_CREATIVE_EDIT_PLAN_VERSION,
    style: request.style,
    baseTimelineId: base.id,
    baseTimelineDigest: fingerprint(base),
    hintDigest: fingerprint(hints),
    removedDeadAir: removals,
    alignedCutPointsMs: cuts,
    beatHintsUsed: beatPoints.length,
    sentenceHintsUsed: sentencePoints.length,
    saliencyHintsUsed: Array.isArray(hints.saliency) ? hints.saliency.length : 0,
    brollCandidatesConsidered: Array.isArray(hints.brollCandidates) ? hints.brollCandidates.length : 0,
    deterministicFallbacks: {
      beat: beatPoints.length === 0,
      sentence: sentencePoints.length === 0,
      saliency: !Array.isArray(hints.saliency) || hints.saliency.length === 0,
      broll: !Array.isArray(hints.brollCandidates) || hints.brollCandidates.length === 0
    },
    loopFriendly: request.loopFriendly === true,
    cta: request.cta !== false
  };
  const planDigest = fingerprint(decisionCore);
  timeline.creativePlan = { ...decisionCore, planDigest };
  timeline = canonicalizeTimeline(timeline);

  const quality = evaluateCreativeQuality(timeline);
  if (!quality.guardrails.every((entry) => entry.pass)) {
    fail(`creative plan exceeds guardrails: ${quality.guardrails.filter((entry) => !entry.pass).map((entry) => entry.name).join(", ")}`);
  }
  if (!quality.visualQa.passed) {
    fail(`creative plan fails visual QA: ${quality.visualQa.checks.filter((entry) => !entry.pass).map((entry) => entry.name).join(", ")}`);
  }

  return {
    contractVersion: MEDIA_CREATIVE_EDIT_PLAN_VERSION,
    planDigest,
    style: request.style,
    timeline,
    qualityReport: quality
  };
}

export function createCreativeHintAdapters({ beat = null, saliency = null, captions = null } = {}) {
  for (const [name, adapter] of Object.entries({ beat, saliency, captions })) {
    if (adapter !== null && typeof adapter.provide !== "function") fail(`${name}.provide is required`);
  }
  return Object.freeze({ beat, saliency, captions });
}
