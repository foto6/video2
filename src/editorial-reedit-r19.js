import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { buildRenderPlan } from "./plan.js";
import { fingerprint, stableStringify } from "./stable.js";
import { canonicalizeTimeline } from "./timeline.js";
import { validateRenderExportAgainstFinal } from "./render-export-r15.js";
import { resolveSandboxedPath } from "./runtime/path-policy.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION = "media.editorial_reedit_application.v1";
export const GROWTH_CREATOR_REEDIT_HANDOFF_VERSION = "growth.creator_reedit_handoff.v1";
export const GROWTH_REEDIT_ADAPTER_VERSION = "growth.web_video_critic_reedit_adapter.v1";

export const R19_GROWTH_R23_AUTHORITY = Object.freeze({
  repository: "foto6/video3",
  branch: "agent/growth-r23-critic-reedit-adapter-20261002",
  sourceSha: "26f769abceb43a63677ea8f7ba028369db371696",
  ciRunId: 36974062565,
  contractVersion: GROWTH_CREATOR_REEDIT_HANDOFF_VERSION,
  adapterVersion: GROWTH_REEDIT_ADAPTER_VERSION,
  contractBlobSha: "ced853aad722aad4c7a88e9a41756baa1b2892a6",
  schemaBlobSha: "ba9ada04488760147136dcaaf012206405c04653"
});

export const R19_SUPPORTED_OPERATIONS = Object.freeze([
  "trim",
  "cut",
  "crop_scale_reframe",
  "speed_change",
  "fade_transition",
  "text_overlay",
  "subtitles_captions",
  "audio_duck_mix",
  "intro_outro_cta"
]);

const GROWTH_BINDING_KEYS = Object.freeze([
  "source_id",
  "source_sha256",
  "source_size",
  "media_repository",
  "media_producer_sha",
  "candidate_id",
  "render_sha256",
  "render_size",
  "render_export_sha256",
  "attachment_sha256",
  "attachment_size",
  "attachment_identity",
  "review_bundle_digest",
  "critic_input_digest",
  "critic_output_digest"
]);

const EXPECTED_BRIDGE_R26 = Object.freeze({
  repository: "foto6/WebAIBridge",
  branch: "agent/bridge-r26-file-attachment-rehearsal-20261002",
  source_sha: "73c13f9eed2a2cbcea881dd8c5452d054bfef940",
  attachment_contract: "bridge.chat_file_attachment.v1",
  rehearsal_request_contract: "bridge.chat_file_attachment_rehearsal_request.v1",
  rehearsal_result_contract: "bridge.chat_file_attachment_rehearsal_result.v1",
  dom_probe_contract: "bridge.chat_file_attachment_dom_probe.v1",
  operator_evidence_contract: "bridge.chat_file_attachment_operator_evidence.v1",
  max_file_bytes: 500000000,
  disposition: "READY_FOR_EXPLICIT_LIVE_REHEARSAL",
  live_pass: false,
  real_upload_proven: false,
  real_prompt_send_proven: false,
  no_live_deploy: true,
  no_cutover: true
});

const EXPECTED_MEDIA_R18 = Object.freeze({
  repository: "foto6/video2",
  branch: "agent/media-r18-direct-model-review-package-20261002",
  source_sha: "2c41f084e000eca5efd9a51d2d3752bec1bd1311",
  ci_run_id: 36967381891,
  contract: "media.direct_model_review_package.v1",
  max_file_bytes: 500000000,
  live_upload_performed: false,
  model_judgment_performed: false
});

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, fields, label) {
  if (!plain(value)) fail("editorial_reedit_invalid", `${label} must be an object`);
  const expected = new Set(fields);
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length) fail("editorial_reedit_invalid", `${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail("editorial_reedit_invalid", `${label} unknown fields: ${extra.sort().join(", ")}`);
}
function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("editorial_reedit_invalid", `${label} must be lowercase SHA-256 hex`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("editorial_reedit_invalid", `${label} must be exact Git SHA`);
  }
}
function hashFileSync(filePath) {
  if (!existsSync(filePath)) fail("editorial_reedit_missing_file", `missing file: ${filePath}`);
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}
function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}
function overlaps(a, b) {
  return a.start_ms < b.end_ms && b.start_ms < a.end_ms;
}
function contains(interval, startMs, endMs) {
  return interval.start_ms <= startMs && endMs <= interval.end_ms;
}
function severitySpeed(severity) {
  if (severity === "hard_failure") return 1.18;
  if (severity === "major") return 1.12;
  return 1.08;
}
function fragmentSource(source, offsetMs, durationMs, speed = 1) {
  if (!source) return undefined;
  const baseIn = source.inMs ?? 0;
  const sourceOffset = Math.round(offsetMs * speed);
  const sourceDuration = Math.round(durationMs * speed);
  return {
    ...clone(source),
    inMs: baseIn + sourceOffset,
    outMs: baseIn + sourceOffset + sourceDuration
  };
}
function uniqueSorted(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value)))].sort((a, b) => a - b);
}

export function validateGrowthR23Handoff(input) {
  const handoff = clone(input);
  exactKeys(handoff, [
    "contract_version", "adapter_version", "handoff_id", "handoff_digest",
    "state", "reedit_round", "max_reedit_rounds", "binding", "pairwise",
    "coverage", "summary_uncertainty", "directives", "bridge_r26_authority",
    "media_r18_authority", "evidence_boundary", "authority"
  ], "growth handoff");
  if (
    handoff.contract_version !== GROWTH_CREATOR_REEDIT_HANDOFF_VERSION ||
    handoff.adapter_version !== GROWTH_REEDIT_ADAPTER_VERSION
  ) fail("editorial_reedit_unsupported_handoff", "unsupported Growth R23 handoff");
  if (handoff.state !== "targeted_reedit") {
    fail("editorial_reedit_not_targeted", "Media executes only targeted_reedit handoffs");
  }
  if (
    !Number.isInteger(handoff.reedit_round) ||
    handoff.reedit_round < 0 ||
    handoff.reedit_round >= 2 ||
    handoff.max_reedit_rounds !== 2
  ) fail("editorial_reedit_round_exhausted", "re-edit handoff must be round 0 or 1 with max two rounds");

  exactKeys(handoff.binding, GROWTH_BINDING_KEYS, "handoff binding");
  for (const key of [
    "source_sha256", "render_sha256", "render_export_sha256",
    "attachment_sha256", "review_bundle_digest", "critic_input_digest",
    "critic_output_digest"
  ]) sha256(handoff.binding[key], `binding.${key}`);
  gitSha(handoff.binding.media_producer_sha, "binding.media_producer_sha");
  if (
    handoff.binding.render_sha256 !== handoff.binding.attachment_sha256 ||
    handoff.binding.render_size !== handoff.binding.attachment_size
  ) fail("editorial_reedit_lineage_mismatch", "reviewed render and attachment identities differ");
  if (stableStringify(handoff.bridge_r26_authority) !== stableStringify(EXPECTED_BRIDGE_R26)) {
    fail("editorial_reedit_lineage_mismatch", "Bridge R26 authority drift");
  }
  if (stableStringify(handoff.media_r18_authority) !== stableStringify(EXPECTED_MEDIA_R18)) {
    fail("editorial_reedit_lineage_mismatch", "Media R18 authority drift");
  }
  if (
    handoff.coverage?.uninspected_possible !== true ||
    handoff.coverage?.every_frame_inspected !== false ||
    handoff.coverage?.coverage_uncertainty_preserved !== true ||
    !Array.isArray(handoff.coverage?.inspected_ranges)
  ) fail("editorial_reedit_coverage_invalid", "Growth coverage uncertainty must be preserved");
  if (
    handoff.evidence_boundary?.human_ground_truth !== false ||
    handoff.evidence_boundary?.live_video_review_fabricated !== false ||
    handoff.authority?.provider_mutation !== false ||
    handoff.authority?.upload_performed !== false
  ) fail("editorial_reedit_authority_invalid", "handoff crosses Media authority boundary");

  if (!Array.isArray(handoff.directives) || handoff.directives.length === 0) {
    fail("editorial_reedit_invalid", "targeted_reedit requires directives");
  }
  const seen = new Set();
  for (const directive of handoff.directives) {
    exactKeys(directive, [
      "operation", "start_ms", "end_ms", "defect_category", "severity",
      "source_observation_id", "evidence", "confidence", "uncertainty",
      "upstream_proposed_edit", "upstream_proposed_edit_executable",
      "binding", "directive_id"
    ], "directive");
    if (!R19_SUPPORTED_OPERATIONS.includes(directive.operation)) {
      fail("editorial_reedit_unsupported_operation", `unsupported operation: ${directive.operation}`);
    }
    if (
      !Number.isInteger(directive.start_ms) ||
      !Number.isInteger(directive.end_ms) ||
      directive.start_ms < 0 ||
      directive.end_ms <= directive.start_ms
    ) fail("editorial_reedit_interval_invalid", "directive interval is contradictory");
    if (directive.upstream_proposed_edit_executable !== false) {
      fail("editorial_reedit_freeform_forbidden", "free-form proposed edit is never executable");
    }
    if (stableStringify(directive.binding) !== stableStringify(handoff.binding)) {
      fail("editorial_reedit_lineage_mismatch", "directive binding differs from handoff binding");
    }
    if (seen.has(directive.directive_id)) fail("editorial_reedit_duplicate_directive", "duplicate directive id");
    seen.add(directive.directive_id);
    const body = clone(directive);
    delete body.directive_id;
    const expectedId = `gcrd1:${fingerprint(body)}`;
    if (directive.directive_id !== expectedId) {
      fail("editorial_reedit_lineage_mismatch", "directive digest/id mismatch");
    }
  }

  const expectedHandoffId = `gcrh1:${fingerprint({
    critic_output_digest: handoff.binding.critic_output_digest,
    pairwise_output_digest: handoff.pairwise?.output_digest ?? null,
    reedit_round: handoff.reedit_round
  })}`;
  if (handoff.handoff_id !== expectedHandoffId) {
    fail("editorial_reedit_lineage_mismatch", "handoff id mismatch");
  }
  const material = clone(handoff);
  material.handoff_digest = "";
  if (handoff.handoff_digest !== fingerprint(material)) {
    fail("editorial_reedit_lineage_mismatch", "handoff digest mismatch");
  }
  return handoff;
}

export function validateEditorialDirectiveSet(handoffInput, durationMs) {
  const handoff = validateGrowthR23Handoff(handoffInput);
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    fail("editorial_reedit_invalid", "durationMs must be positive integer");
  }
  for (const directive of handoff.directives) {
    if (directive.end_ms > durationMs) {
      fail("editorial_reedit_interval_invalid", "directive interval exceeds candidate timeline duration");
    }
  }
  for (let i = 0; i < handoff.directives.length; i += 1) {
    for (let j = i + 1; j < handoff.directives.length; j += 1) {
      const a = handoff.directives[i];
      const b = handoff.directives[j];
      if (!overlaps(a, b)) continue;
      if (a.operation === b.operation) {
        fail("editorial_reedit_conflict", `overlapping duplicate operation: ${a.operation}`);
      }
      if (["trim", "cut"].includes(a.operation) || ["trim", "cut"].includes(b.operation)) {
        fail("editorial_reedit_conflict", "cut/trim interval cannot overlap another directive");
      }
      if (
        (a.operation === "speed_change" && b.operation === "speed_change") ||
        (a.operation === "crop_scale_reframe" && b.operation === "crop_scale_reframe")
      ) fail("editorial_reedit_conflict", "conflicting structural operations overlap");
    }
  }
  return handoff.directives.map(clone);
}

export function validateEditorialReeditInput({
  handoff,
  candidate,
  timeline,
  sandboxRoot = process.cwd()
} = {}) {
  const parsed = validateGrowthR23Handoff(handoff);
  if (!plain(candidate)) fail("editorial_reedit_invalid", "candidate is required");
  exactKeys(candidate, [
    "candidateId", "source", "finalPath", "renderSha256", "renderSize",
    "renderExportPath", "renderExportSha256", "renderProducerSha"
  ], "candidate");
  exactKeys(candidate.source, ["sourceId", "sha256", "size"], "candidate.source");
  sha256(candidate.source.sha256, "candidate.source.sha256");
  sha256(candidate.renderSha256, "candidate.renderSha256");
  sha256(candidate.renderExportSha256, "candidate.renderExportSha256");
  gitSha(candidate.renderProducerSha, "candidate.renderProducerSha");

  const binding = parsed.binding;
  if (
    candidate.candidateId !== binding.candidate_id ||
    candidate.source.sourceId !== binding.source_id ||
    candidate.source.sha256 !== binding.source_sha256 ||
    candidate.source.size !== binding.source_size ||
    candidate.renderSha256 !== binding.render_sha256 ||
    candidate.renderSize !== binding.render_size ||
    candidate.renderExportSha256 !== binding.render_export_sha256 ||
    candidate.renderProducerSha !== binding.media_producer_sha
  ) fail("editorial_reedit_lineage_mismatch", "candidate/source metadata is stale against Growth binding");

  const finalResolved = resolveSandboxedPath(candidate.finalPath, {
    sandboxRoot,
    allowRemoteUri: false
  });
  const sidecarResolved = resolveSandboxedPath(candidate.renderExportPath, {
    sandboxRoot,
    allowRemoteUri: false
  });
  if (finalResolved.kind !== "path" || sidecarResolved.kind !== "path") {
    fail("editorial_reedit_path_invalid", "candidate paths must resolve to local sandbox files");
  }
  const finalBytes = hashFileSync(finalResolved.value);
  if (finalBytes.sha256 !== candidate.renderSha256 || finalBytes.size !== candidate.renderSize) {
    fail("editorial_reedit_stale_render", "candidate final bytes do not match Growth binding");
  }
  const sidecarBytes = hashFileSync(sidecarResolved.value);
  if (sidecarBytes.sha256 !== candidate.renderExportSha256) {
    fail("editorial_reedit_stale_render_export", "render-export sidecar hash differs from Growth binding");
  }
  const renderExport = validateRenderExportAgainstFinal(
    JSON.parse(readFileSync(sidecarResolved.value, "utf8")),
    finalResolved.value
  );
  if (
    renderExport.producer.sha !== candidate.renderProducerSha ||
    renderExport.artifact.sha256 !== candidate.renderSha256 ||
    renderExport.artifact.size !== candidate.renderSize
  ) fail("editorial_reedit_stale_render_export", "render-export semantic lineage differs from Growth binding");

  const canonicalTimeline = canonicalizeTimeline(timeline);
  const sources = canonicalTimeline.tracks.flatMap((track) => track.items)
    .filter((item) => item.source)
    .map((item) => item.source);
  const primary = sources.find((source) =>
    source.id === candidate.source.sourceId ||
    (source.sha256 === candidate.source.sha256 && source.size === candidate.source.size)
  );
  if (!primary) fail("editorial_reedit_wrong_source", "candidate timeline does not bind exact Growth source");
  const resolvedSource = resolveSandboxedPath(primary.uri, {
    sandboxRoot,
    allowRemoteUri: false
  });
  if (resolvedSource.kind !== "path") fail("editorial_reedit_path_invalid", "primary source must be local");
  const sourceBytes = hashFileSync(resolvedSource.value);
  if (
    sourceBytes.sha256 !== candidate.source.sha256 ||
    sourceBytes.size !== candidate.source.size
  ) fail("editorial_reedit_wrong_source", "primary source bytes do not match Growth binding");

  validateEditorialDirectiveSet(parsed, canonicalTimeline.canvas.durationMs);

  return {
    handoff: parsed,
    candidate: clone(candidate),
    timeline: canonicalTimeline,
    candidateFinalPath: finalResolved.value,
    renderExportPath: sidecarResolved.value,
    renderExport,
    inputTimelineDigest: fingerprint(canonicalTimeline)
  };
}

function removeCutIntervals(timelineInput, cutDirectives) {
  if (cutDirectives.length === 0) return canonicalizeTimeline(timelineInput);
  const timeline = clone(timelineInput);
  const cuts = cutDirectives
    .map((d) => ({ start: d.start_ms, end: d.end_ms, directiveId: d.directive_id }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < cuts.length; i += 1) {
    if (cuts[i].start < cuts[i - 1].end) fail("editorial_reedit_conflict", "cut intervals overlap");
  }
  const removedBefore = (time) => cuts.reduce((sum, cut) => {
    if (cut.end <= time) return sum + (cut.end - cut.start);
    if (cut.start < time) return sum + Math.max(0, time - cut.start);
    return sum;
  }, 0);
  const outTracks = [];
  for (const track of timeline.tracks) {
    const outItems = [];
    for (const item of track.items) {
      let segments = [{ start: item.startMs, end: item.endMs }];
      for (const cut of cuts) {
        const next = [];
        for (const seg of segments) {
          if (cut.end <= seg.start || cut.start >= seg.end) {
            next.push(seg);
            continue;
          }
          if (seg.start < cut.start) next.push({ start: seg.start, end: cut.start });
          if (cut.end < seg.end) next.push({ start: cut.end, end: seg.end });
        }
        segments = next;
      }
      segments.forEach((seg, index) => {
        if (seg.end <= seg.start) return;
        const speed = item.speed ?? 1;
        const copy = clone(item);
        copy.id = `${item.id}__r19cut_${seg.start}_${seg.end}_${index}`;
        if (item.source) {
          copy.source = fragmentSource(item.source, seg.start - item.startMs, seg.end - seg.start, speed);
        }
        copy.startMs = seg.start - removedBefore(seg.start);
        copy.endMs = seg.end - removedBefore(seg.end);
        if (copy.fadeInMs && copy.fadeInMs >= copy.endMs - copy.startMs) delete copy.fadeInMs;
        if (copy.fadeOutMs && copy.fadeOutMs >= copy.endMs - copy.startMs) delete copy.fadeOutMs;
        if (copy.transitionOut && copy.transitionOut.durationMs >= copy.endMs - copy.startMs) delete copy.transitionOut;
        outItems.push(copy);
      });
    }
    outTracks.push({ ...track, items: outItems });
  }
  timeline.tracks = outTracks;
  timeline.canvas.durationMs -= cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0);
  return canonicalizeTimeline(timeline);
}

function mapThroughCuts(time, cutDirectives) {
  let mapped = time;
  for (const d of cutDirectives) {
    if (d.end_ms <= time) mapped -= d.end_ms - d.start_ms;
  }
  return mapped;
}

function applySpeedIntervals(timelineInput, speedDirectives) {
  if (speedDirectives.length === 0) {
    return {
      timeline: canonicalizeTimeline(timelineInput),
      mapTime: (value) => value,
      factors: []
    };
  }
  const directives = speedDirectives.map((d) => ({
    start: d.start_ms,
    end: d.end_ms,
    factor: severitySpeed(d.severity),
    directiveId: d.directive_id
  })).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < directives.length; i += 1) {
    if (directives[i].start < directives[i - 1].end) {
      fail("editorial_reedit_conflict", "speed-change intervals overlap");
    }
  }
  const factorAt = (start, end) => {
    const d = directives.find((row) => row.start <= start && end <= row.end);
    return d?.factor ?? 1;
  };
  const mapTime = (time) => {
    let out = 0;
    let cursor = 0;
    for (const d of directives) {
      if (time <= cursor) break;
      const normalEnd = Math.min(time, d.start);
      if (normalEnd > cursor) out += normalEnd - cursor;
      if (time <= d.start) return out;
      const speedEnd = Math.min(time, d.end);
      if (speedEnd > d.start) out += (speedEnd - d.start) / d.factor;
      cursor = d.end;
      if (time <= d.end) return out;
    }
    if (time > cursor) out += time - cursor;
    return out;
  };
  const boundaries = uniqueSorted(directives.flatMap((d) => [d.start, d.end]));
  const timeline = clone(timelineInput);
  timeline.tracks = timeline.tracks.map((track) => {
    const items = [];
    for (const item of track.items) {
      const points = uniqueSorted([
        item.startMs,
        ...boundaries.filter((b) => item.startMs < b && b < item.endMs),
        item.endMs
      ]);
      for (let i = 0; i < points.length - 1; i += 1) {
        const start = points[i];
        const end = points[i + 1];
        if (end <= start) continue;
        const factor = factorAt(start, end);
        const copy = clone(item);
        copy.id = `${item.id}__r19speed_${start}_${end}_${i}`;
        if (item.source) {
          const existingSpeed = item.speed ?? 1;
          copy.source = fragmentSource(item.source, start - item.startMs, end - start, existingSpeed);
          copy.speed = Number((existingSpeed * factor).toFixed(6));
        }
        copy.startMs = Math.round(mapTime(start));
        copy.endMs = Math.round(mapTime(end));
        if (copy.fadeInMs && copy.fadeInMs >= copy.endMs - copy.startMs) delete copy.fadeInMs;
        if (copy.fadeOutMs && copy.fadeOutMs >= copy.endMs - copy.startMs) delete copy.fadeOutMs;
        if (copy.transitionOut && copy.transitionOut.durationMs >= copy.endMs - copy.startMs) delete copy.transitionOut;
        items.push(copy);
      }
    }
    return { ...track, items };
  });
  timeline.canvas.durationMs = Math.round(mapTime(timelineInput.canvas.durationMs));
  return { timeline: canonicalizeTimeline(timeline), mapTime, factors: directives };
}

function splitAtBoundaries(timelineInput, boundariesByKind) {
  const timeline = clone(timelineInput);
  timeline.tracks = timeline.tracks.map((track) => {
    const boundaries = boundariesByKind[track.kind] ?? [];
    const items = [];
    for (const item of track.items) {
      const points = uniqueSorted([
        item.startMs,
        ...boundaries.filter((b) => item.startMs < b && b < item.endMs),
        item.endMs
      ]);
      for (let i = 0; i < points.length - 1; i += 1) {
        const start = points[i];
        const end = points[i + 1];
        if (end <= start) continue;
        const copy = clone(item);
        copy.id = `${item.id}__r19fx_${start}_${end}_${i}`;
        if (item.source) {
          copy.source = fragmentSource(item.source, start - item.startMs, end - start, item.speed ?? 1);
        }
        copy.startMs = start;
        copy.endMs = end;
        if (copy.fadeInMs && copy.fadeInMs >= copy.endMs - copy.startMs) delete copy.fadeInMs;
        if (copy.fadeOutMs && copy.fadeOutMs >= copy.endMs - copy.startMs) delete copy.fadeOutMs;
        if (copy.transitionOut && copy.transitionOut.durationMs >= copy.endMs - copy.startMs) delete copy.transitionOut;
        items.push(copy);
      }
    }
    return { ...track, items };
  });
  return canonicalizeTimeline(timeline);
}

function applyNonStructuralDirective(timeline, directive, interval) {
  const result = { applied: false, reason: null, exactOperations: [] };
  const duration = interval.end - interval.start;
  const matching = (track) => track.items.filter((item) =>
    item.startMs < interval.end && interval.start < item.endMs
  );

  if (directive.operation === "crop_scale_reframe") {
    const tracks = timeline.tracks.filter((track) => track.kind === "video");
    const items = tracks.flatMap(matching).filter((item) => contains(
      { start_ms: interval.start, end_ms: interval.end },
      item.startMs,
      item.endMs
    ));
    if (!items.length) {
      result.reason = "no_video_segment_in_interval";
      return result;
    }
    for (const item of items) {
      item.reframe = { x: "(in_w-out_w)/2", y: "(in_h-out_h)/2" };
      item.motion = { type: "punch_in", zoom: directive.severity === "major" || directive.severity === "hard_failure" ? 1.08 : 1.05 };
      result.exactOperations.push({ itemId: item.id, reframe: clone(item.reframe), motion: clone(item.motion) });
    }
    result.applied = true;
    return result;
  }

  if (directive.operation === "fade_transition") {
    const tracks = timeline.tracks.filter((track) => track.kind === "video");
    const items = tracks.flatMap(matching).filter((item) => item.endMs - item.startMs >= 300);
    if (!items.length) {
      result.reason = "no_video_segment_long_enough_for_fade";
      return result;
    }
    for (const item of items) {
      const fadeMs = Math.min(120, Math.floor((item.endMs - item.startMs) / 4));
      if (fadeMs <= 0) continue;
      item.fadeInMs = fadeMs;
      item.fadeOutMs = fadeMs;
      result.exactOperations.push({ itemId: item.id, fadeInMs: fadeMs, fadeOutMs: fadeMs });
    }
    result.applied = result.exactOperations.length > 0;
    if (!result.applied) result.reason = "fade_interval_too_short";
    return result;
  }

  if (directive.operation === "text_overlay") {
    const tracks = timeline.tracks.filter((track) => track.kind === "overlay");
    const items = tracks.flatMap(matching);
    if (!items.length) {
      result.reason = "missing_existing_text_overlay";
      return result;
    }
    for (const item of items) {
      item.style = {
        ...(item.style ?? {}),
        box: true,
        fontSize: Math.min(72, Math.max(48, (item.style?.fontSize ?? 56) + 4)),
        kinetic: "slide",
        motionAmplitudePx: Math.min(24, item.style?.motionAmplitudePx ?? 18)
      };
      result.exactOperations.push({ itemId: item.id, style: clone(item.style), textPreserved: item.text ?? null });
    }
    result.applied = true;
    return result;
  }

  if (directive.operation === "subtitles_captions") {
    const tracks = timeline.tracks.filter((track) => track.kind === "caption");
    const items = tracks.flatMap(matching);
    if (!items.length) {
      result.reason = "missing_existing_caption";
      return result;
    }
    for (const item of items) {
      item.style = {
        ...(item.style ?? {}),
        box: true,
        fontSize: Math.min(72, Math.max(52, (item.style?.fontSize ?? 64) + 2)),
        kinetic: "bounce",
        motionAmplitudePx: Math.min(10, item.style?.motionAmplitudePx ?? 8)
      };
      result.exactOperations.push({ itemId: item.id, style: clone(item.style), textPreserved: item.text });
    }
    result.applied = true;
    return result;
  }

  if (directive.operation === "audio_duck_mix") {
    const audioTracks = timeline.tracks.filter((track) => track.kind === "audio");
    const items = audioTracks.flatMap(matching);
    const voice = items.filter((item) => item.role === "voiceover");
    const music = items.filter((item) => item.role === "music");
    if (!voice.length || !music.length) {
      result.reason = "missing_voice_or_music_layer";
      return result;
    }
    for (const item of music) {
      item.gainDb = Math.min(item.gainDb ?? 0, -18);
      item.duckUnderVoice = true;
      result.exactOperations.push({ itemId: item.id, gainDb: item.gainDb, duckUnderVoice: true });
    }
    result.applied = true;
    return result;
  }

  if (directive.operation === "intro_outro_cta") {
    const overlays = timeline.tracks
      .filter((track) => track.kind === "overlay")
      .flatMap((track) => track.items)
      .filter((item) => ["intro", "outro", "cta"].includes(item.role));
    const items = overlays.filter((item) => item.startMs < interval.end && interval.start < item.endMs);
    if (!items.length) {
      result.reason = "missing_existing_intro_outro_cta";
      return result;
    }
    for (const item of items) {
      item.style = {
        ...(item.style ?? {}),
        box: true,
        fontSize: Math.min(72, Math.max(48, item.style?.fontSize ?? 60)),
        kinetic: "slide",
        motionAmplitudePx: Math.min(24, item.style?.motionAmplitudePx ?? 16)
      };
      result.exactOperations.push({ itemId: item.id, role: item.role, style: clone(item.style), textPreserved: item.text ?? null });
    }
    result.applied = true;
    return result;
  }

  result.reason = "operation_requires_structural_phase";
  return result;
}

export function compileEditorialReeditPlan(input, {
  sandboxRoot = process.cwd(),
  expectedPlanDigest = null
} = {}) {
  const validated = validateEditorialReeditInput({ ...input, sandboxRoot });
  const directives = validated.handoff.directives
    .slice()
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.directive_id.localeCompare(b.directive_id));
  const cutDirectives = directives.filter((d) => ["trim", "cut"].includes(d.operation));
  let timeline = removeCutIntervals(validated.timeline, cutDirectives);

  const speedOriginal = directives.filter((d) => d.operation === "speed_change");
  const speedMapped = speedOriginal.map((d) => ({
    ...d,
    start_ms: mapThroughCuts(d.start_ms, cutDirectives),
    end_ms: mapThroughCuts(d.end_ms, cutDirectives)
  }));
  const speedApplied = applySpeedIntervals(timeline, speedMapped);
  timeline = speedApplied.timeline;

  const mapFinalTime = (original) => {
    const cutMapped = mapThroughCuts(original, cutDirectives);
    return Math.round(speedApplied.mapTime(cutMapped));
  };

  const nonStructural = directives.filter((d) =>
    !["trim", "cut", "speed_change"].includes(d.operation)
  );
  const intervals = nonStructural.map((d) => ({
    directive: d,
    start: mapFinalTime(d.start_ms),
    end: mapFinalTime(d.end_ms)
  }));
  const boundariesByKind = {
    video: uniqueSorted(intervals.filter((row) =>
      ["crop_scale_reframe", "fade_transition"].includes(row.directive.operation)
    ).flatMap((row) => [row.start, row.end])),
    overlay: uniqueSorted(intervals.filter((row) =>
      ["text_overlay", "intro_outro_cta"].includes(row.directive.operation)
    ).flatMap((row) => [row.start, row.end])),
    caption: uniqueSorted(intervals.filter((row) =>
      row.directive.operation === "subtitles_captions"
    ).flatMap((row) => [row.start, row.end])),
    audio: uniqueSorted(intervals.filter((row) =>
      row.directive.operation === "audio_duck_mix"
    ).flatMap((row) => [row.start, row.end]))
  };
  timeline = splitAtBoundaries(timeline, boundariesByKind);

  const applications = [];
  for (const directive of directives) {
    if (["trim", "cut"].includes(directive.operation)) {
      applications.push({
        directiveId: directive.directive_id,
        operation: directive.operation,
        originalInterval: { startMs: directive.start_ms, endMs: directive.end_ms },
        appliedInterval: null,
        status: "applied",
        reason: null,
        exactOperations: [{ type: "remove_interval", durationMs: directive.end_ms - directive.start_ms }]
      });
      continue;
    }
    if (directive.operation === "speed_change") {
      const mappedStart = mapThroughCuts(directive.start_ms, cutDirectives);
      const mappedEnd = mapThroughCuts(directive.end_ms, cutDirectives);
      applications.push({
        directiveId: directive.directive_id,
        operation: directive.operation,
        originalInterval: { startMs: directive.start_ms, endMs: directive.end_ms },
        appliedInterval: { startMs: Math.round(speedApplied.mapTime(mappedStart)), endMs: Math.round(speedApplied.mapTime(mappedEnd)) },
        status: "applied",
        reason: null,
        exactOperations: [{ type: "speed_change", factor: severitySpeed(directive.severity) }]
      });
      continue;
    }
    const interval = {
      start: mapFinalTime(directive.start_ms),
      end: mapFinalTime(directive.end_ms)
    };
    const applied = applyNonStructuralDirective(timeline, directive, interval);
    applications.push({
      directiveId: directive.directive_id,
      operation: directive.operation,
      originalInterval: { startMs: directive.start_ms, endMs: directive.end_ms },
      appliedInterval: { startMs: interval.start, endMs: interval.end },
      status: applied.applied ? "applied" : "unsupported",
      reason: applied.reason,
      exactOperations: applied.exactOperations
    });
  }

  timeline.id = `${validated.timeline.id}-r19-${validated.handoff.reedit_round + 1}`;
  timeline = canonicalizeTimeline(timeline);
  const unsupported = applications.filter((row) => row.status === "unsupported");
  const directiveDigest = fingerprint(directives);
  const renderPlan = buildRenderPlan(timeline, input.exportSpec ?? {});
  const core = {
    contractVersion: MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION,
    growthAuthority: clone(R19_GROWTH_R23_AUTHORITY),
    handoff: {
      id: validated.handoff.handoff_id,
      digest: validated.handoff.handoff_digest,
      reeditRound: validated.handoff.reedit_round
    },
    input: {
      source: clone(validated.candidate.source),
      candidateId: validated.candidate.candidateId,
      renderSha256: validated.candidate.renderSha256,
      renderSize: validated.candidate.renderSize,
      renderExportSha256: validated.candidate.renderExportSha256,
      renderProducerSha: validated.candidate.renderProducerSha,
      timelineDigest: validated.inputTimelineDigest
    },
    directiveDigest,
    applications,
    outputTimelineDigest: fingerprint(timeline),
    ffmpegPlanDigest: renderPlan.fingerprint,
    humanQuality: false
  };
  const planDigest = fingerprint(core);
  if (expectedPlanDigest && expectedPlanDigest !== planDigest) {
    fail("editorial_reedit_plan_drift", "compiled R19 plan differs from expected deterministic digest");
  }
  return {
    ...core,
    planDigest,
    timeline,
    exportSpec: clone(input.exportSpec ?? {}),
    unsupported
  };
}

export function validateEditorialReeditApplicationSidecar(input) {
  const sidecar = clone(input);
  exactKeys(sidecar, [
    "contractVersion", "producer", "growthAuthority", "handoff", "input",
    "directiveDigest", "applications", "ffmpegPlanDigest", "outputTimelineDigest",
    "planDigest", "output", "qa", "humanQuality"
  ], "R19 application sidecar");
  if (sidecar.contractVersion !== MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION) {
    fail("editorial_reedit_invalid", "application sidecar contractVersion mismatch");
  }
  exactKeys(sidecar.producer, ["repository", "sha"], "sidecar producer");
  if (sidecar.producer.repository !== "foto6/video2") fail("editorial_reedit_invalid", "producer repository mismatch");
  gitSha(sidecar.producer.sha, "producer.sha");
  if (stableStringify(sidecar.growthAuthority) !== stableStringify(R19_GROWTH_R23_AUTHORITY)) {
    fail("editorial_reedit_lineage_mismatch", "Growth R23 authority drift in sidecar");
  }
  for (const key of ["directiveDigest", "ffmpegPlanDigest", "outputTimelineDigest", "planDigest"]) {
    sha256(sidecar[key], key);
  }
  if (!Array.isArray(sidecar.applications) || sidecar.applications.length === 0) {
    fail("editorial_reedit_invalid", "sidecar applications are required");
  }
  if (!sidecar.output || sidecar.output.status !== "succeeded") {
    fail("editorial_reedit_invalid", "sidecar requires succeeded output");
  }
  sha256(sidecar.output.sha256, "output.sha256");
  if (!Number.isInteger(sidecar.output.size) || sidecar.output.size <= 0) {
    fail("editorial_reedit_invalid", "output.size must be positive");
  }
  sha256(sidecar.output.renderExportSha256, "output.renderExportSha256");
  if (sidecar.qa?.technicalPassed !== true) {
    fail("editorial_reedit_invalid", "sidecar requires passing technical QA");
  }
  sha256(sidecar.qa.technicalEvidenceSha256, "qa.technicalEvidenceSha256");
  if (sidecar.humanQuality !== false) {
    fail("editorial_reedit_invalid", "human-quality claim must remain false");
  }
  return sidecar;
}

export function buildEditorialReeditApplicationSidecar({
  plan,
  producerSha,
  output,
  technicalQa,
  renderExportSha256
} = {}) {
  gitSha(producerSha, "producerSha");
  if (!plan || plan.contractVersion !== MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION) {
    fail("editorial_reedit_invalid", "compiled R19 plan is required");
  }
  if (!technicalQa?.passed) fail("editorial_reedit_qa_failed", "technical QA must pass before success sidecar");
  sha256(output?.sha256, "output.sha256");
  sha256(renderExportSha256, "renderExportSha256");
  return validateEditorialReeditApplicationSidecar({
    contractVersion: MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION,
    producer: { repository: "foto6/video2", sha: producerSha },
    growthAuthority: clone(R19_GROWTH_R23_AUTHORITY),
    handoff: clone(plan.handoff),
    input: clone(plan.input),
    directiveDigest: plan.directiveDigest,
    applications: clone(plan.applications),
    ffmpegPlanDigest: plan.ffmpegPlanDigest,
    outputTimelineDigest: plan.outputTimelineDigest,
    planDigest: plan.planDigest,
    output: {
      status: "succeeded",
      sha256: output.sha256,
      size: output.size,
      renderExportSha256
    },
    qa: {
      technicalPassed: true,
      technicalEvidenceSha256: fingerprint(technicalQa),
      measurable: {
        width: technicalQa.expected?.width ?? null,
        height: technicalQa.expected?.height ?? null,
        durationMs: technicalQa.expected?.durationMs ?? null
      }
    },
    humanQuality: false
  });
}

export function editorialReeditReplayIdentity(plan) {
  if (!plan || plan.contractVersion !== MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION) {
    fail("editorial_reedit_invalid", "compiled plan required");
  }
  return `r19:${plan.handoff.id}:${plan.planDigest}`;
}

export function verifyEditorialReeditReplay({
  existingSidecar,
  plan,
  outputPath,
  renderExportPath
} = {}) {
  const sidecar = validateEditorialReeditApplicationSidecar(existingSidecar);
  if (sidecar.planDigest !== plan.planDigest || sidecar.handoff.digest !== plan.handoff.digest) {
    fail("editorial_reedit_replay_conflict", "existing application sidecar binds a different plan/handoff");
  }
  const outputBytes = hashFileSync(outputPath);
  if (outputBytes.sha256 !== sidecar.output.sha256 || outputBytes.size !== sidecar.output.size) {
    fail("editorial_reedit_replay_conflict", "existing output bytes differ from application sidecar");
  }
  const exportBytes = hashFileSync(renderExportPath);
  if (exportBytes.sha256 !== sidecar.output.renderExportSha256) {
    fail("editorial_reedit_replay_conflict", "existing render-export bytes differ from application sidecar");
  }
  return {
    replayed: true,
    identity: editorialReeditReplayIdentity(plan),
    output: outputBytes,
    renderExport: exportBytes,
    sidecarDigest: hashText(`${stableStringify(sidecar)}\n`)
  };
}
