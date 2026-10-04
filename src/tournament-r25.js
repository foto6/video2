import { createHash } from "node:crypto";

import {
  compileCreativeEditPlan
} from "./creative-plan.js";
import {
  validateEditorialReeditApplicationSidecar
} from "./editorial-reedit-r19.js";
import {
  renderExportDigest,
  validateRenderExport
} from "./render-export-r15.js";
import {
  MEDIA_SHORTFORM_PROFILE_VERSION,
  SHORTFORM_R11_PROFILE
} from "./shortform-profile.js";
import { canonicalizeTimeline } from "./timeline.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_TOURNAMENT_REQUEST_VERSION = "media.edit_tournament_request.r25.v1";
export const MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION = "media.tournament_candidate_manifest.r25.v1";
export const MEDIA_TOURNAMENT_BRACKET_VERSION = "media.review_tournament_bracket.r25.v1";
export const MEDIA_TOURNAMENT_EVIDENCE_VERSION = "media.edit_tournament.r25.evidence.v1";
export const MEDIA_TOURNAMENT_TARGETED_REEDIT_VERSION = "media.tournament_targeted_reedit.r25.v1";
export const TOURNAMENT_ROUND_READY = "TOURNAMENT_ROUND_READY";

export const R25_R24_AUTHORITY = Object.freeze({
  repository: "foto6/video2",
  branch: "agent/media-r24-canonical-live-artifact-20261002",
  producerSha: "244acdf154741e669991b17df3ef2a47e2dfdfa9",
  ciRunId: 37195239582,
  ciConclusion: "success",
  artifactId: 11301055747,
  artifactName: "media-r24-canonical-live-review-export",
  artifactDigest: "sha256:fc5c9b9635d49b643e66efafe602d21ce1ef695a553f81a797bdf16d7b8cf228",
  contractVersion: "media.canonical_live_review_export.r24.v1"
});

const ALLOWED_STRATEGIES = Object.freeze([
  "clean_podcast",
  "aggressive_shortform",
  "cinematic_minimal",
  "kinetic_punch"
]);

const OP_TYPES = new Set([
  "cut_pacing",
  "speed_change",
  "crop_reframe",
  "motion_zoom_pan",
  "fade_transition",
  "caption_layout",
  "text_overlay",
  "audio_mix_duck",
  "cta",
  "loop_bridge",
  "broll_insert"
]);

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("tournament_invalid", `${label} must be lowercase SHA-256`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("tournament_invalid", `${label} must be exact Git SHA`);
  }
}
function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail("tournament_invalid", `${label} must be positive integer`);
}
function textHash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
function timeRange(item) {
  return { startMs: item.startMs, endMs: item.endMs };
}
function sourceRef(item) {
  if (!item.source) return null;
  return {
    sourceId: item.source.id ?? null,
    sha256: item.source.sha256 ?? null,
    size: item.source.size ?? null,
    inMs: item.source.inMs ?? 0,
    outMs: item.source.outMs ?? null
  };
}

export function validateTournamentRequest(input) {
  if (!plain(input)) fail("tournament_invalid", "request must be object");
  const required = [
    "contractVersion", "tournamentId", "source", "brief", "roundNumber",
    "candidateCount", "baseTimeline", "exportSpec"
  ];
  for (const key of required) if (!Object.hasOwn(input, key)) fail("tournament_invalid", `missing ${key}`);
  if (input.contractVersion !== MEDIA_TOURNAMENT_REQUEST_VERSION) fail("tournament_invalid", "contractVersion mismatch");
  if (typeof input.tournamentId !== "string" || !/^[A-Za-z0-9._-]+$/.test(input.tournamentId)) {
    fail("tournament_invalid", "tournamentId must be path-safe");
  }
  if (!plain(input.source)) fail("tournament_invalid", "source required");
  for (const key of ["sourceId", "path", "sha256", "size", "durationMs", "expectAudio"]) {
    if (!Object.hasOwn(input.source, key)) fail("tournament_invalid", `source.${key} required`);
  }
  if (typeof input.source.sourceId !== "string" || !input.source.sourceId) fail("tournament_invalid", "sourceId required");
  if (typeof input.source.path !== "string" || !input.source.path || input.source.path.includes("..")) {
    fail("tournament_path_escape", "source.path must be confined relative path");
  }
  sha256(input.source.sha256, "source.sha256");
  positiveInt(input.source.size, "source.size");
  positiveInt(input.source.durationMs, "source.durationMs");
  if (typeof input.source.expectAudio !== "boolean") fail("tournament_invalid", "source.expectAudio must be boolean");
  if (!plain(input.brief)) fail("tournament_invalid", "brief required");
  if (typeof input.brief.briefId !== "string" || !input.brief.briefId) fail("tournament_invalid", "brief.briefId required");
  sha256(input.brief.digest, "brief.digest");
  if (!Number.isInteger(input.roundNumber) || input.roundNumber < 0 || input.roundNumber > 2) {
    fail("tournament_round_invalid", "roundNumber must be 0, 1 or 2");
  }
  if (!Number.isInteger(input.candidateCount) || input.candidateCount < 2 || input.candidateCount > 4) {
    fail("tournament_invalid", "candidateCount must be 2-4");
  }
  const timeline = canonicalizeTimeline(input.baseTimeline);
  if (
    timeline.profileVersion !== MEDIA_SHORTFORM_PROFILE_VERSION ||
    timeline.canvas.width !== SHORTFORM_R11_PROFILE.width ||
    timeline.canvas.height !== SHORTFORM_R11_PROFILE.height ||
    timeline.canvas.fps !== SHORTFORM_R11_PROFILE.fps
  ) fail("tournament_profile_invalid", "base timeline must use the frozen R11 vertical profile");
  if (timeline.canvas.durationMs !== input.source.durationMs) {
    fail("tournament_lineage_mismatch", "base timeline duration differs from source duration");
  }
  return {
    contractVersion: MEDIA_TOURNAMENT_REQUEST_VERSION,
    tournamentId: input.tournamentId,
    source: clone(input.source),
    brief: clone(input.brief),
    roundNumber: input.roundNumber,
    candidateCount: input.candidateCount,
    baseTimeline: timeline,
    exportSpec: clone(input.exportSpec ?? {})
  };
}

export function tournamentRequestIdentityDigest(requestInput) {
  const request = validateTournamentRequest(requestInput);
  return fingerprint({
    tournamentId: request.tournamentId,
    source: {
      sourceId: request.source.sourceId,
      sha256: request.source.sha256,
      size: request.source.size
    },
    briefDigest: request.brief.digest,
    roundNumber: request.roundNumber,
    candidateCount: request.candidateCount
  });
}

export function validateTournamentReplayBinding(state, requestInput) {
  const digest = tournamentRequestIdentityDigest(requestInput);
  if (!plain(state) || state.requestIdentityDigest !== digest) {
    fail("tournament_replay_conflict", "same tournament identity is bound to changed source/brief/round/count");
  }
  return { requestIdentityDigest: digest, replayCompatible: true };
}

function kineticVariant(timelineInput) {
  const timeline = clone(timelineInput);
  const videos = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.items);
  const body = videos.find((item) => item.role === "body") ?? videos[0];
  if (body) {
    body.motion = { type: "slow_push", zoom: 1.05 };
    body.fadeInMs = Math.min(90, Math.max(30, Math.floor((body.endMs - body.startMs) / 20)));
    body.fadeOutMs = body.fadeInMs;
  }
  for (const track of timeline.tracks.filter((t) => t.kind === "caption")) {
    for (const item of track.items) {
      item.style = {
        ...(item.style ?? {}),
        box: true,
        fontSize: Math.min(68, Math.max(54, item.style?.fontSize ?? 60)),
        kinetic: "slide",
        motionAmplitudePx: Math.min(18, item.style?.motionAmplitudePx ?? 14)
      };
    }
  }
  return canonicalizeTimeline(timeline);
}

export function buildTournamentCandidatePlans(requestInput) {
  const request = validateTournamentRequest(requestInput);
  if (request.roundNumber !== 0) fail("tournament_round_invalid", "initial candidate generation is round 0 only");
  const styles = ALLOWED_STRATEGIES.slice(0, request.candidateCount);
  const plans = styles.map((strategy, index) => {
    let timeline;
    if (strategy === "kinetic_punch") {
      const base = compileCreativeEditPlan({
        style: "clean_podcast",
        timeline: { ...clone(request.baseTimeline), id: `${request.baseTimeline.id}-r25-${index + 1}` },
        hints: {
          sentenceBoundariesMs: clone(request.brief.sentenceBoundariesMs ?? []),
          beatMarkersMs: clone(request.brief.beatMarkersMs ?? []),
          silenceRanges: clone(request.brief.silenceRanges ?? [])
        },
        loopFriendly: request.brief.loopFriendly === true,
        cta: request.brief.ctaText || false
      });
      timeline = kineticVariant(base.timeline);
    } else {
      const creative = compileCreativeEditPlan({
        style: strategy,
        timeline: { ...clone(request.baseTimeline), id: `${request.baseTimeline.id}-r25-${index + 1}` },
        hints: {
          sentenceBoundariesMs: clone(request.brief.sentenceBoundariesMs ?? []),
          beatMarkersMs: clone(request.brief.beatMarkersMs ?? []),
          silenceRanges: clone(request.brief.silenceRanges ?? []),
          saliency: clone(request.brief.saliency ?? [])
        },
        loopFriendly: strategy === "cinematic_minimal" ? request.brief.loopFriendly === true : false,
        cta: request.brief.ctaText || false
      });
      timeline = creative.timeline;
    }
    const operationGraph = buildOperationGraph(timeline);
    return {
      candidateId: `candidate-${index + 1}`,
      strategy,
      plan: { timeline, exportSpec: clone(request.exportSpec) },
      operationGraph,
      operationGraphDigest: fingerprint(operationGraph)
    };
  });
  const graphDigests = new Set(plans.map((p) => p.operationGraphDigest));
  const structuralDigests = new Set(plans.map((p) => fingerprint(p.operationGraph.operations)));
  if (graphDigests.size !== plans.length || structuralDigests.size !== plans.length) {
    fail("tournament_diversity_failure", "candidate operation graphs are not structurally distinct");
  }
  return plans;
}

export function buildOperationGraph(timelineInput) {
  const timeline = canonicalizeTimeline(timelineInput);
  const operations = [];
  for (const track of timeline.tracks) {
    for (const item of track.items) {
      const base = {
        trackId: track.id,
        trackKind: track.kind,
        itemId: item.id,
        role: item.role ?? null,
        range: timeRange(item),
        source: sourceRef(item)
      };
      if (track.kind === "video") {
        if ((item.speed ?? 1) !== 1) operations.push({ type: "speed_change", ...base, speed: item.speed });
        if (item.crop || item.reframe) operations.push({ type: "crop_reframe", ...base, crop: clone(item.crop ?? null), reframe: clone(item.reframe ?? null) });
        if (item.motion) operations.push({ type: "motion_zoom_pan", ...base, motion: clone(item.motion) });
        if (item.fadeInMs || item.fadeOutMs || item.transitionOut) operations.push({
          type: "fade_transition", ...base,
          fadeInMs: item.fadeInMs ?? 0,
          fadeOutMs: item.fadeOutMs ?? 0,
          transitionOut: clone(item.transitionOut ?? null)
        });
        if (["broll", "insert"].includes(item.role)) operations.push({ type: "broll_insert", ...base });
        if (item.role === "loop_bridge") operations.push({ type: "loop_bridge", ...base });
      } else if (track.kind === "caption") {
        operations.push({
          type: "caption_layout", ...base,
          textSha256: textHash(item.text ?? ""),
          style: clone(item.style ?? {})
        });
      } else if (track.kind === "overlay") {
        const type = ["cta", "intro", "outro"].includes(item.role) ? "cta" : "text_overlay";
        operations.push({
          type, ...base,
          textSha256: textHash(item.text ?? ""),
          style: clone(item.style ?? {}),
          position: clone(item.position ?? null)
        });
      } else if (track.kind === "audio") {
        operations.push({
          type: "audio_mix_duck", ...base,
          gainDb: item.gainDb ?? 0,
          duckUnderVoice: item.duckUnderVoice === true
        });
      }
    }
  }
  const videoItems = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.items);
  if (videoItems.length > 1) {
    operations.push({
      type: "cut_pacing",
      segmentCount: videoItems.length,
      sourceWindows: videoItems.map((item) => sourceRef(item))
    });
  }
  const primary = videoItems.filter((item) => item.source && !["broll", "insert", "loop_bridge"].includes(item.role));
  const primarySourceId = primary[0]?.source?.id ?? null;
  const windows = primary
    .filter((item) => (item.source?.id ?? null) === primarySourceId)
    .map((item) => ({
      inMs: item.source?.inMs ?? 0,
      outMs: item.source?.outMs ?? null
    }))
    .filter((x) => Number.isInteger(x.inMs) && Number.isInteger(x.outMs) && x.outMs > x.inMs)
    .sort((a, b) => a.inMs - b.inMs || a.outMs - b.outMs);
  const gaps = [];
  if (windows.length) {
    let cursor = windows[0].inMs;
    for (const window of windows) {
      if (window.inMs > cursor) gaps.push({ startMs: cursor, endMs: window.inMs });
      cursor = Math.max(cursor, window.outMs);
    }
  }
  return {
    timelineDigest: fingerprint(timeline),
    durationMs: timeline.canvas.durationMs,
    operations: operations.sort((a, b) =>
      String(a.type).localeCompare(String(b.type)) ||
      String(a.itemId ?? "").localeCompare(String(b.itemId ?? ""))
    ),
    sourceCoverage: {
      primarySourceId,
      windows,
      gaps,
      declaredOmissions: clone(timeline.creativePlan?.removedDeadAir ?? [])
    }
  };
}

function findQaCheck(record, name) {
  return record.qa?.technical?.value?.checks?.find((x) => x.name === name) ?? null;
}

export function evaluateTournamentTechnicalGate({
  renderExport: renderExportInput,
  ffprobeFacts,
  expectAudio,
  avSyncToleranceMs = 120
} = {}) {
  const record = validateRenderExport(renderExportInput);
  if (record.status !== "succeeded") fail("tournament_candidate_failed", "candidate render export is not succeeded");
  const checks = [];
  const push = (name, pass, actual, expected) => checks.push({ name, pass: Boolean(pass), actual, expected });
  push("video-present", ffprobeFacts?.hasVideo === true, ffprobeFacts?.hasVideo ?? null, true);
  push("nonzero-video", (ffprobeFacts?.videoDurationMs ?? 0) > 0, ffprobeFacts?.videoDurationMs ?? null, ">0");
  push("width", ffprobeFacts?.width === 1080, ffprobeFacts?.width ?? null, 1080);
  push("height", ffprobeFacts?.height === 1920, ffprobeFacts?.height ?? null, 1920);
  push("fps", Math.abs((ffprobeFacts?.fps ?? 0) - 30) < 0.01, ffprobeFacts?.fps ?? null, 30);
  push("duration-min", (ffprobeFacts?.durationMs ?? 0) >= SHORTFORM_R11_PROFILE.targetDurationMs.min, ffprobeFacts?.durationMs ?? null, `>=${SHORTFORM_R11_PROFILE.targetDurationMs.min}`);
  push("duration-max", (ffprobeFacts?.durationMs ?? Infinity) <= SHORTFORM_R11_PROFILE.targetDurationMs.max, ffprobeFacts?.durationMs ?? null, `<=${SHORTFORM_R11_PROFILE.targetDurationMs.max}`);
  push("audio-present", !expectAudio || ffprobeFacts?.hasAudio === true, ffprobeFacts?.hasAudio ?? null, expectAudio);
  if (expectAudio) {
    push("nonzero-audio", (ffprobeFacts?.audioDurationMs ?? 0) > 0, ffprobeFacts?.audioDurationMs ?? null, ">0");
    push("av-sync", Number.isFinite(ffprobeFacts?.avSyncDeltaMs) && ffprobeFacts.avSyncDeltaMs <= avSyncToleranceMs, ffprobeFacts?.avSyncDeltaMs ?? null, `<=${avSyncToleranceMs}`);
  }
  for (const name of ["probe-readable", "analysis-complete", "black-frame-ratio", "frozen-frame-duration", "source-assets-provenance", "subtitle-safe-area"]) {
    const q = findQaCheck(record, name);
    if (q) push(`r15:${name}`, q.pass === true, q.actual, q.expected);
  }
  push("r15-technical-qa", record.qa?.technical?.passed === true, record.qa?.technical?.passed ?? null, true);
  push("r15-creative-qa", record.qa?.creative?.passed === true, record.qa?.creative?.passed ?? null, true);
  push("benchmark-technical-dq", record.benchmark?.technicalDq === false, record.benchmark?.technicalDq ?? null, false);
  return { passed: checks.every((c) => c.pass), checks };
}

export function validateTournamentCandidateManifest(input) {
  if (!plain(input)) fail("tournament_candidate_invalid", "candidate manifest must be object");
  const required = [
    "contractVersion", "tournamentId", "candidateId", "roundNumber", "strategy",
    "source", "briefDigest", "producerSha", "operationGraph", "operationGraphDigest",
    "declaredOperationTypes", "render", "renderExport", "ffprobe", "technicalGate",
    "captionSidecar", "blindSeed", "humanQuality"
  ];
  for (const key of required) if (!Object.hasOwn(input, key)) fail("tournament_candidate_invalid", `missing ${key}`);
  if (input.contractVersion !== MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION) fail("tournament_candidate_invalid", "contractVersion mismatch");
  gitSha(input.producerSha, "producerSha");
  sha256(input.source.sha256, "source.sha256");
  sha256(input.briefDigest, "briefDigest");
  sha256(input.operationGraphDigest, "operationGraphDigest");
  if (fingerprint(input.operationGraph) !== input.operationGraphDigest) fail("tournament_candidate_invalid", "operation graph digest mismatch");
  const observedTypes = [...new Set(input.operationGraph.operations.map((x) => x.type))].sort();
  for (const type of observedTypes) if (!OP_TYPES.has(type)) fail("tournament_candidate_invalid", `unknown operation type: ${type}`);
  const coverage = input.operationGraph.sourceCoverage;
  if (!plain(coverage) || !Array.isArray(coverage.gaps) || !Array.isArray(coverage.declaredOmissions)) {
    fail("tournament_candidate_invalid", "operation graph sourceCoverage is required");
  }
  for (const gap of coverage.gaps) {
    const declaredGap = coverage.declaredOmissions.some((range) =>
      range.startMs <= gap.startMs && range.endMs >= gap.endMs
    );
    if (!declaredGap && !observedTypes.includes("broll_insert")) {
      fail("tournament_undeclared_source_omission", "candidate omits a primary-source segment without a declared edit");
    }
  }
  const declared = [...new Set(input.declaredOperationTypes)].sort();
  if (stableStringify(observedTypes) !== stableStringify(declared)) {
    fail("tournament_undeclared_operation", "operation graph includes undeclared or missing operation types", { observedTypes, declared });
  }
  sha256(input.render.sha256, "render.sha256");
  positiveInt(input.render.size, "render.size");
  sha256(input.renderExport.fileSha256, "renderExport.fileSha256");
  sha256(input.renderExport.digest, "renderExport.digest");
  sha256(input.captionSidecar.sha256, "captionSidecar.sha256");
  if (input.captionSidecar.size < 0 || !Number.isInteger(input.captionSidecar.size)) fail("tournament_candidate_invalid", "caption sidecar size invalid");
  sha256(input.blindSeed, "blindSeed");
  if (input.technicalGate?.passed !== true) fail("tournament_candidate_invalid", "technical gate must pass before reviewable candidate");
  if (input.humanQuality !== false) fail("tournament_candidate_invalid", "humanQuality must remain false");
  return clone(input);
}

export function candidateManifestDigest(input) {
  return fingerprint(validateTournamentCandidateManifest(input));
}

export function buildTournamentBracket(candidateManifestsInput, {
  tournamentId,
  roundNumber = 0
} = {}) {
  if (!Array.isArray(candidateManifestsInput) || candidateManifestsInput.length < 2 || candidateManifestsInput.length > 4) {
    fail("tournament_bracket_invalid", "bracket requires 2-4 candidates");
  }
  const manifests = candidateManifestsInput.map(validateTournamentCandidateManifest);
  const sourceSha = manifests[0].source.sha256;
  const briefDigest = manifests[0].briefDigest;
  const renderSet = new Set();
  for (const m of manifests) {
    if (m.tournamentId !== tournamentId || m.roundNumber !== roundNumber) fail("tournament_bracket_invalid", "candidate tournament/round mismatch");
    if (m.source.sha256 !== sourceSha || m.briefDigest !== briefDigest) fail("tournament_bracket_invalid", "candidate source/brief lineage mismatch");
    if (renderSet.has(m.render.sha256)) fail("tournament_duplicate_render", "byte-identical candidates cannot enter bracket");
    renderSet.add(m.render.sha256);
  }
  const seeded = manifests.map((m) => ({
    candidateId: m.candidateId,
    candidateManifestDigest: candidateManifestDigest(m),
    seedDigest: fingerprint({
      tournamentId,
      roundNumber,
      candidateManifestDigest: candidateManifestDigest(m)
    })
  })).sort((a, b) => a.seedDigest.localeCompare(b.seedDigest));

  const matches = [];
  if (seeded.length === 2) {
    matches.push({ matchId: "final", stage: "final", participants: seeded.map((x) => ({ candidateId: x.candidateId })), reviewPackageRequired: true });
  } else if (seeded.length === 3) {
    matches.push({
      matchId: "semifinal-1",
      stage: "semifinal",
      participants: [{ candidateId: seeded[1].candidateId }, { candidateId: seeded[2].candidateId }],
      reviewPackageRequired: true
    });
    matches.push({
      matchId: "final",
      stage: "final",
      participants: [{ candidateId: seeded[0].candidateId, bye: true }, { winnerOf: "semifinal-1" }],
      reviewPackageRequired: false
    });
  } else {
    matches.push({
      matchId: "semifinal-1",
      stage: "semifinal",
      participants: [{ candidateId: seeded[0].candidateId }, { candidateId: seeded[3].candidateId }],
      reviewPackageRequired: true
    });
    matches.push({
      matchId: "semifinal-2",
      stage: "semifinal",
      participants: [{ candidateId: seeded[1].candidateId }, { candidateId: seeded[2].candidateId }],
      reviewPackageRequired: true
    });
    matches.push({
      matchId: "final",
      stage: "final",
      participants: [{ winnerOf: "semifinal-1" }, { winnerOf: "semifinal-2" }],
      reviewPackageRequired: false
    });
  }
  const sealedMapping = {
    digest: fingerprint(seeded),
    entries: seeded
  };
  return validateTournamentBracket({
    contractVersion: MEDIA_TOURNAMENT_BRACKET_VERSION,
    state: TOURNAMENT_ROUND_READY,
    tournamentId,
    roundNumber,
    candidateCount: seeded.length,
    sourceSha256: sourceSha,
    briefDigest,
    seedOrder: seeded.map((x, i) => ({ seed: i + 1, blindSeed: x.seedDigest })),
    matches,
    sealedMapping,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  });
}

export function validateTournamentBracket(input) {
  if (!plain(input)) fail("tournament_bracket_invalid", "bracket must be object");
  if (input.contractVersion !== MEDIA_TOURNAMENT_BRACKET_VERSION || input.state !== TOURNAMENT_ROUND_READY) {
    fail("tournament_bracket_invalid", "bracket contract/state mismatch");
  }
  if (!Array.isArray(input.seedOrder) || !Array.isArray(input.matches)) fail("tournament_bracket_invalid", "bracket seeds/matches required");
  if (!plain(input.sealedMapping) || fingerprint(input.sealedMapping.entries ?? []) !== input.sealedMapping.digest) {
    fail("tournament_sealed_mapping_mismatch", "bracket sealed mapping digest mismatch");
  }
  if (input.candidateCount < 2 || input.candidateCount > 4 || input.seedOrder.length !== input.candidateCount) {
    fail("tournament_bracket_invalid", "candidate count/seed order mismatch");
  }
  const expectedStages = input.candidateCount === 2 ? ["final"] : ["semifinal", "final"];
  for (const stage of expectedStages) {
    if (!input.matches.some((m) => m.stage === stage)) fail("tournament_bracket_invalid", `missing ${stage} stage`);
  }
  if (
    input.modelReviewPerformed !== false ||
    input.liveModelReviewed !== false ||
    input.providerPublish !== false ||
    input.humanQuality !== false
  ) fail("tournament_bracket_invalid", "evidence boundary violated");
  return clone(input);
}

function sourceWindows(timelineInput) {
  const timeline = canonicalizeTimeline(timelineInput);
  return timeline.tracks
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.items)
    .filter((item) => item.source)
    .map((item) => ({
      sourceId: item.source.id ?? null,
      inMs: item.source.inMs ?? 0,
      outMs: item.source.outMs ?? null,
      speed: item.speed ?? 1,
      role: item.role ?? null
    }))
    .sort((a, b) => (a.inMs - b.inMs) || String(a.sourceId).localeCompare(String(b.sourceId)));
}

export function buildUnaffectedRegionEvidence({
  baselineTimeline,
  challengerTimeline,
  applications
} = {}) {
  const declared = (applications ?? []).map((app) => ({
    startMs: app.originalInterval?.startMs ?? null,
    endMs: app.originalInterval?.endMs ?? null,
    operation: app.operation
  })).filter((x) => Number.isInteger(x.startMs) && Number.isInteger(x.endMs));
  const sourceRanges = sourceWindows(baselineTimeline);
  const challenged = sourceWindows(challengerTimeline);
  const fullyInsideDeclared = (window) => declared.some((d) =>
    window.inMs >= d.startMs && window.outMs <= d.endMs
  );
  const baselineUnaffected = sourceRanges.filter((x) => !fullyInsideDeclared(x));
  const challengerUnaffected = challenged.filter((x) => !fullyInsideDeclared(x));
  const baselineDigest = fingerprint(baselineUnaffected);
  const challengerDigest = fingerprint(challengerUnaffected);
  return {
    method: "source-window-lineage-outside-declared-edit-intervals",
    declaredIntervals: declared,
    baselineDigest,
    challengerDigest,
    preserved: baselineDigest === challengerDigest,
    baselineWindows: baselineUnaffected,
    challengerWindows: challengerUnaffected,
    limitation: "proves source-window mapping outside declared intervals where comparable; does not claim pixel identity after full re-encode"
  };
}

export function validateTargetedTournamentReedit({
  baselineManifest,
  challengerManifest,
  application: applicationInput,
  priorReview,
  baselineTimeline,
  challengerTimeline
} = {}) {
  const baseline = validateTournamentCandidateManifest(baselineManifest);
  const challenger = validateTournamentCandidateManifest(challengerManifest);
  const app = validateEditorialReeditApplicationSidecar(applicationInput);
  if (challenger.roundNumber !== baseline.roundNumber + 1 || challenger.roundNumber > 2) {
    fail("tournament_round_invalid", "targeted challenger must be exact N+1 and <=2");
  }
  if (
    baseline.source.sha256 !== challenger.source.sha256 ||
    baseline.briefDigest !== challenger.briefDigest
  ) fail("tournament_lineage_mismatch", "targeted baseline/challenger lineage mismatch");
  if (baseline.render.sha256 === challenger.render.sha256) fail("tournament_duplicate_render", "re-edit did not change bytes");
  if (
    app.input.renderSha256 !== baseline.render.sha256 ||
    app.output.sha256 !== challenger.render.sha256 ||
    app.output.size !== challenger.render.size ||
    app.handoff.reeditRound !== baseline.roundNumber
  ) fail("tournament_lineage_mismatch", "R19 application does not bind baseline -> challenger");
  if (!plain(priorReview)) fail("tournament_prior_review_invalid", "priorReview required");
  for (const key of ["selectedCandidateId", "reviewPackageDigest", "growthHandoffDigest", "directiveDigest"]) {
    if (typeof priorReview[key] !== "string" || !priorReview[key]) fail("tournament_prior_review_invalid", `priorReview.${key} required`);
  }
  sha256(priorReview.reviewPackageDigest, "priorReview.reviewPackageDigest");
  sha256(priorReview.growthHandoffDigest, "priorReview.growthHandoffDigest");
  sha256(priorReview.directiveDigest, "priorReview.directiveDigest");
  if (
    priorReview.selectedCandidateId !== baseline.candidateId ||
    priorReview.growthHandoffDigest !== app.handoff.digest ||
    priorReview.directiveDigest !== app.directiveDigest
  ) fail("tournament_stale_directive", "prior review/Growth directive evidence is stale");
  const unaffected = buildUnaffectedRegionEvidence({
    baselineTimeline,
    challengerTimeline,
    applications: app.applications
  });
  return {
    contractVersion: MEDIA_TOURNAMENT_TARGETED_REEDIT_VERSION,
    baselineCandidateId: baseline.candidateId,
    challengerCandidateId: challenger.candidateId,
    parentRound: baseline.roundNumber,
    childRound: challenger.roundNumber,
    growthHandoffDigest: app.handoff.digest,
    directiveDigest: app.directiveDigest,
    mediaApplicationDigest: fingerprint(app),
    unaffectedRegionEvidence: unaffected,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
}
