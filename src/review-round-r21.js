import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  DYNAMIC_REVIEW_PACKAGE_READY,
  LIVE_MODEL_REVIEWED,
  buildDynamicReviewPackage,
  validateDynamicCandidateDescriptor
} from "./dynamic-review-r20.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_REVIEW_ROUND_BUNDLE_VERSION = "media.review_round_bundle.r21.v1";
export const MEDIA_REVIEW_ROUND_HANDOFF_VERSION = "media.review_round_transport_handoff.r21.v1";
export const MEDIA_PRIOR_REVIEW_SELECTION_VERSION = "media.prior_review_selection.r21.v1";
export const MEDIA_REVIEW_ROUND_EVIDENCE_VERSION = "media.review_round_bundle.r21.evidence.v1";
export const ROUND_PAIR_PACKAGE_READY = "ROUND_PAIR_PACKAGE_READY";

export const R21_BRIDGE_R30_AUTHORITY = Object.freeze({
  repository: "foto6/WebAIBridge",
  branch: "agent/bridge-r30-dynamic-review-transport-20261002",
  branchHeadSha: "ed9a35290f94607d7577f1ee9301de1bb44334f2",
  provenImplementationBranch: "agent/bridge-r29-isolated-live-video-review-20261002",
  provenImplementationCiRunId: 36989658042,
  inheritedRequestContract: "bridge.existing_chat_video_review_request.v1",
  inheritedCaptureContract: "bridge.existing_chat_video_review_capture.v1",
  nativeR30RoundPairConsumerPresentAtPin: false,
  transportNeutralMediaHandoff: MEDIA_REVIEW_ROUND_HANDOFF_VERSION,
  maxFileBytes: 500_000_000,
  liveModelReviewed: false
});

const SELECTION_EVIDENCE_TYPES = new Set([
  "model_review_capture",
  "growth_reedit_handoff",
  "fixture_rehearsal"
]);

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
  if (!plain(value)) fail("review_round_invalid", `${label} must be an object`);
  const expected = new Set(fields);
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length) fail("review_round_invalid", `${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail("review_round_invalid", `${label} unknown fields: ${extra.sort().join(", ")}`);
}
function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("review_round_invalid", `${label} must be lowercase SHA-256 hex`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("review_round_invalid", `${label} must be exact Git SHA`);
  }
}
function hashText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function validatePriorReviewSelection(input, {
  baselineCandidateId = null,
  baselineRound = null
} = {}) {
  exactKeys(input, [
    "contractVersion",
    "selectedCandidateId",
    "reviewRound",
    "reviewPackageDigest",
    "sealedMappingDigest",
    "decisionEvidenceDigest",
    "evidenceType"
  ], "priorReview");
  if (input.contractVersion !== MEDIA_PRIOR_REVIEW_SELECTION_VERSION) {
    fail("review_round_invalid", "priorReview contractVersion mismatch");
  }
  if (typeof input.selectedCandidateId !== "string" || !input.selectedCandidateId) {
    fail("review_round_invalid", "priorReview selectedCandidateId required");
  }
  if (!Number.isInteger(input.reviewRound) || input.reviewRound < 0 || input.reviewRound > 1) {
    fail("review_round_invalid", "priorReview reviewRound must be 0 or 1");
  }
  for (const key of ["reviewPackageDigest", "sealedMappingDigest", "decisionEvidenceDigest"]) {
    sha256(input[key], `priorReview.${key}`);
  }
  if (!SELECTION_EVIDENCE_TYPES.has(input.evidenceType)) {
    fail("review_round_invalid", "priorReview evidenceType is unsupported");
  }
  if (baselineCandidateId !== null && input.selectedCandidateId !== baselineCandidateId) {
    fail("review_round_baseline_mismatch", "prior review selection does not identify the baseline candidate");
  }
  if (baselineRound !== null && input.reviewRound !== baselineRound) {
    fail("review_round_baseline_mismatch", "prior review round does not match baseline round");
  }
  return clone(input);
}

function validateParticipant(input, label) {
  exactKeys(input, ["candidate", "briefLineageDigest"], label);
  const candidate = validateDynamicCandidateDescriptor(input.candidate);
  sha256(input.briefLineageDigest, `${label}.briefLineageDigest`);
  return { candidate, briefLineageDigest: input.briefLineageDigest };
}

function ensurePairEligibility(a, b, label) {
  if (!sameSource(a.candidate, b.candidate)) {
    fail("review_round_source_mismatch", `${label} participants must bind the same exact source`);
  }
  if (a.candidate.render.sha256 === b.candidate.render.sha256) {
    fail("review_round_duplicate_render", `${label} participants cannot have byte-identical renders`);
  }
}

function validateInitialRequest(input) {
  exactKeys(input, ["mode", "left", "right"], "initial request");
  if (input.mode !== "initial") fail("review_round_invalid", "initial mode mismatch");
  const left = validateParticipant(input.left, "left");
  const right = validateParticipant(input.right, "right");
  if (left.candidate.roundNumber !== 0 || right.candidate.roundNumber !== 0) {
    fail("review_round_round_mismatch", "initial review requires two round-0 candidates");
  }
  if (left.briefLineageDigest !== right.briefLineageDigest) {
    fail("review_round_brief_mismatch", "initial candidates must bind the same brief lineage");
  }
  ensurePairEligibility(left, right, "initial");
  return { mode: "initial", left, right, priorReview: null };
}

function validateTargetedRequest(input) {
  exactKeys(input, ["mode", "baseline", "challenger", "priorReview"], "targeted request");
  if (input.mode !== "targeted_reedit") fail("review_round_invalid", "targeted mode mismatch");
  const baseline = validateParticipant(input.baseline, "baseline");
  const challenger = validateParticipant(input.challenger, "challenger");
  if (baseline.briefLineageDigest !== challenger.briefLineageDigest) {
    fail("review_round_brief_mismatch", "baseline and challenger must bind the same brief lineage");
  }
  ensurePairEligibility(baseline, challenger, "targeted");
  if (challenger.candidate.roundNumber !== baseline.candidate.roundNumber + 1) {
    fail("review_round_parent_child_mismatch", "challenger must be exactly baseline round N+1");
  }
  if (challenger.candidate.roundNumber > 2) {
    fail("review_round_round_mismatch", "Media supports at most two re-edit rounds");
  }
  const priorReview = validatePriorReviewSelection(input.priorReview, {
    baselineCandidateId: baseline.candidate.candidateId,
    baselineRound: baseline.candidate.roundNumber
  });
  return { mode: "targeted_reedit", baseline, challenger, priorReview };
}

export function validateReviewRoundRequest(input) {
  if (!plain(input)) fail("review_round_invalid", "review round request must be object");
  if (input.mode === "initial") return validateInitialRequest(input);
  if (input.mode === "targeted_reedit") return validateTargetedRequest(input);
  fail("review_round_invalid", "review round mode must be initial or targeted_reedit");
}

function sameSource(a, b) {
  return a.source.sourceId === b.source.sourceId &&
    a.source.sha256 === b.source.sha256 &&
    a.source.size === b.source.size;
}

function r20Candidates(request) {
  return request.mode === "initial"
    ? [request.left.candidate, request.right.candidate]
    : [request.baseline.candidate, request.challenger.candidate];
}

function participantById(request) {
  const participants = request.mode === "initial"
    ? [request.left, request.right]
    : [request.baseline, request.challenger];
  return new Map(participants.map((participant) => [participant.candidate.candidateId, participant]));
}

function roleById(request) {
  if (request.mode === "initial") {
    return new Map([
      [request.left.candidate.candidateId, "initial_candidate"],
      [request.right.candidate.candidateId, "initial_candidate"]
    ]);
  }
  return new Map([
    [request.baseline.candidate.candidateId, "baseline"],
    [request.challenger.candidate.candidateId, "challenger"]
  ]);
}

function fixedR20NeutralTarget() {
  return {
    managedChatId: "r21-transport-neutral",
    profileId: "r21-transport-neutral",
    conversationId: "r21-transport-neutral",
    titleHint: "R21 transport-neutral review package",
    expectedAccountMarkerHash: ""
  };
}

function assertModelFacingBlindness(promptManifest, sealedEntries) {
  const serialized = stableStringify(promptManifest);
  for (const forbiddenWord of ["baseline", "challenger", "winner", "parent", "child"]) {
    if (serialized.toLowerCase().includes(forbiddenWord)) {
      fail("review_round_blinding_failed", `model-facing prompt leaks round role: ${forbiddenWord}`);
    }
  }
  for (const entry of sealedEntries) {
    const secrets = [
      entry.candidateId,
      entry.briefLineageDigest,
      entry.render.sha256,
      entry.renderExport.digest,
      entry.renderProducerSha,
      entry.growthHandoffDigest,
      entry.mediaApplicationDigest
    ].filter(Boolean);
    for (const secret of secrets) {
      if (serialized.includes(secret)) {
        fail("review_round_blinding_failed", "model-facing prompt leaks sealed round lineage");
      }
    }
  }
}

function targetedLineageFromR20(request, r20Package) {
  if (request.mode !== "targeted_reedit") return null;
  const baseline = request.baseline.candidate;
  const challenger = request.challenger.candidate;
  const challengerEntry = r20Package.sealedMapping.entries.find(
    (entry) => entry.candidateId === challenger.candidateId
  );
  if (!challengerEntry?.editorialApplication) {
    fail("review_round_parent_child_mismatch", "challenger is missing verified R19 application lineage");
  }
  const app = challengerEntry.editorialApplication;
  if (
    app.inputCandidateId !== baseline.candidateId ||
    app.inputRenderSha256 !== baseline.render.sha256 ||
    app.reeditRound !== baseline.roundNumber ||
    challenger.roundNumber !== app.reeditRound + 1 ||
    app.digest !== challenger.editorialApplication.digest
  ) {
    fail("review_round_parent_child_mismatch", "R19 application does not prove baseline -> challenger lineage");
  }
  sha256(app.handoffDigest, "challenger Growth handoff digest");
  return {
    parentCandidateId: baseline.candidateId,
    parentRenderSha256: baseline.render.sha256,
    parentRound: baseline.roundNumber,
    childCandidateId: challenger.candidateId,
    childRenderSha256: challenger.render.sha256,
    childRound: challenger.roundNumber,
    growthHandoffDigest: app.handoffDigest,
    mediaApplicationDigest: app.digest,
    mediaApplicationFileSha256: app.fileSha256,
    priorReview: clone(request.priorReview)
  };
}

export function validateReviewRoundBundle(input) {
  const bundle = clone(input);
  exactKeys(bundle, [
    "contractVersion",
    "state",
    "producer",
    "bridgeAuthority",
    "mode",
    "source",
    "briefLineageDigest",
    "reviewRound",
    "attachments",
    "prompt",
    "r20PackageDigest",
    "r20SealedMappingDigest",
    "sealedMapping",
    "roundLineage",
    "transportHandoff",
    "modelReviewPerformed",
    "liveModelReviewed",
    "providerPublish",
    "humanQuality"
  ], "R21 review round bundle");
  if (bundle.contractVersion !== MEDIA_REVIEW_ROUND_BUNDLE_VERSION) fail("review_round_invalid", "contractVersion mismatch");
  if (bundle.state !== ROUND_PAIR_PACKAGE_READY) fail("review_round_invalid", "state must be ROUND_PAIR_PACKAGE_READY");
  exactKeys(bundle.producer, ["repository", "sha"], "producer");
  if (bundle.producer.repository !== "foto6/video2") fail("review_round_invalid", "producer repository mismatch");
  gitSha(bundle.producer.sha, "producer.sha");
  if (stableStringify(bundle.bridgeAuthority) !== stableStringify(R21_BRIDGE_R30_AUTHORITY)) {
    fail("review_round_bridge_authority_mismatch", "Bridge R30 authority drift");
  }
  if (!["initial", "targeted_reedit"].includes(bundle.mode)) fail("review_round_invalid", "mode invalid");
  exactKeys(bundle.source, ["sourceId", "sha256", "size"], "source");
  sha256(bundle.source.sha256, "source.sha256");
  if (!Number.isInteger(bundle.source.size) || bundle.source.size <= 0) fail("review_round_invalid", "source.size invalid");
  sha256(bundle.briefLineageDigest, "briefLineageDigest");
  if (!Number.isInteger(bundle.reviewRound) || bundle.reviewRound < 0 || bundle.reviewRound > 2) {
    fail("review_round_invalid", "reviewRound invalid");
  }
  if (!Array.isArray(bundle.attachments) || bundle.attachments.length !== 2) {
    fail("review_round_invalid", "exactly two attachments required");
  }
  if (bundle.attachments[0].blindLabel !== "A" || bundle.attachments[1].blindLabel !== "B") {
    fail("review_round_blinding_failed", "attachments must be A then B");
  }
  for (const attachment of bundle.attachments) {
    exactKeys(attachment, ["blindLabel", "path", "sha256", "size", "mimeType", "derivative_for_model_review"], "attachment");
    if (!/^review-[AB]\.mp4$/.test(attachment.path) || attachment.mimeType !== "video/mp4") {
      fail("review_round_blinding_failed", "attachment path or MIME invalid");
    }
    sha256(attachment.sha256, "attachment.sha256");
    if (!Number.isInteger(attachment.size) || attachment.size <= 0 || attachment.size > 500_000_000) {
      fail("review_round_invalid", "attachment size invalid");
    }
    if (typeof attachment.derivative_for_model_review !== "boolean") {
      fail("review_round_invalid", "derivative flag invalid");
    }
  }
  exactKeys(bundle.prompt, ["text", "digest"], "prompt");
  if (typeof bundle.prompt.text !== "string" || !bundle.prompt.text) fail("review_round_invalid", "prompt text required");
  sha256(bundle.prompt.digest, "prompt.digest");
  if (hashText(bundle.prompt.text) !== bundle.prompt.digest) fail("review_round_invalid", "prompt digest mismatch");
  sha256(bundle.r20PackageDigest, "r20PackageDigest");
  sha256(bundle.r20SealedMappingDigest, "r20SealedMappingDigest");
  if (
    !plain(bundle.sealedMapping) ||
    !Array.isArray(bundle.sealedMapping.entries) ||
    bundle.sealedMapping.entries.length !== 2 ||
    fingerprint(bundle.sealedMapping.entries) !== bundle.sealedMapping.digest
  ) fail("review_round_invalid", "sealed mapping digest mismatch");
  if (bundle.mode === "targeted_reedit") {
    if (!plain(bundle.roundLineage)) fail("review_round_invalid", "targeted bundle requires roundLineage");
    if (bundle.roundLineage.childRound !== bundle.roundLineage.parentRound + 1) {
      fail("review_round_parent_child_mismatch", "roundLineage is not N -> N+1");
    }
    if (bundle.roundLineage.childRound !== bundle.reviewRound) {
      fail("review_round_parent_child_mismatch", "reviewRound does not match child round");
    }
    sha256(bundle.roundLineage.growthHandoffDigest, "roundLineage.growthHandoffDigest");
    sha256(bundle.roundLineage.mediaApplicationDigest, "roundLineage.mediaApplicationDigest");
    validatePriorReviewSelection(bundle.roundLineage.priorReview, {
      baselineCandidateId: bundle.roundLineage.parentCandidateId,
      baselineRound: bundle.roundLineage.parentRound
    });
  } else if (bundle.roundLineage !== null) {
    fail("review_round_invalid", "initial bundle must not contain parent/child roundLineage");
  }
  if (bundle.transportHandoff?.contractVersion !== MEDIA_REVIEW_ROUND_HANDOFF_VERSION) {
    fail("review_round_invalid", "transport handoff contract mismatch");
  }
  if (
    bundle.transportHandoff.state !== ROUND_PAIR_PACKAGE_READY ||
    bundle.transportHandoff.packageDigest !== fingerprint({
      contractVersion: bundle.contractVersion,
      state: bundle.state,
      producer: bundle.producer,
      bridgeAuthority: bundle.bridgeAuthority,
      mode: bundle.mode,
      source: bundle.source,
      briefLineageDigest: bundle.briefLineageDigest,
      reviewRound: bundle.reviewRound,
      attachments: bundle.attachments,
      prompt: bundle.prompt,
      r20PackageDigest: bundle.r20PackageDigest,
      r20SealedMappingDigest: bundle.r20SealedMappingDigest,
      sealedMapping: bundle.sealedMapping,
      roundLineage: bundle.roundLineage,
      modelReviewPerformed: bundle.modelReviewPerformed,
      liveModelReviewed: bundle.liveModelReviewed,
      providerPublish: bundle.providerPublish,
      humanQuality: bundle.humanQuality
    }) ||
    bundle.transportHandoff.sealedMappingDigest !== bundle.sealedMapping.digest ||
    bundle.transportHandoff.promptDigest !== bundle.prompt.digest
  ) fail("review_round_invalid", "transport handoff does not bind bundle");
  if (
    bundle.modelReviewPerformed !== false ||
    bundle.liveModelReviewed !== false ||
    bundle.providerPublish !== false ||
    bundle.humanQuality !== false
  ) fail("review_round_invalid", "Media evidence boundary violated");
  return bundle;
}

function bundleCore({
  producerSha,
  request,
  r20Package,
  r20PackageDigest,
  roundLineage,
  sealedMapping,
  attachments
}) {
  const participants = request.mode === "initial"
    ? [request.left, request.right]
    : [request.baseline, request.challenger];
  const source = participants[0].candidate.source;
  return {
    contractVersion: MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
    state: ROUND_PAIR_PACKAGE_READY,
    producer: { repository: "foto6/video2", sha: producerSha },
    bridgeAuthority: clone(R21_BRIDGE_R30_AUTHORITY),
    mode: request.mode,
    source: {
      sourceId: source.sourceId,
      sha256: source.sha256,
      size: source.size
    },
    briefLineageDigest: participants[0].briefLineageDigest,
    reviewRound: request.mode === "initial" ? 0 : request.challenger.candidate.roundNumber,
    attachments,
    prompt: {
      text: r20Package.promptManifest.promptText,
      digest: r20Package.promptDigest
    },
    r20PackageDigest,
    r20SealedMappingDigest: r20Package.sealedMapping.digest,
    sealedMapping,
    roundLineage,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
}

export function buildReviewRoundBundle({
  request: requestInput,
  producerSha,
  sandboxRoot = process.cwd(),
  outputRoot
} = {}) {
  gitSha(producerSha, "producerSha");
  const request = validateReviewRoundRequest(requestInput);
  const candidates = r20Candidates(request);
  if (!sameSource(candidates[0], candidates[1])) {
    fail("review_round_source_mismatch", "review candidates must bind the same exact source");
  }
  if (candidates[0].render.sha256 === candidates[1].render.sha256) {
    fail("review_round_duplicate_render", "byte-identical review candidates are forbidden");
  }

  const r20 = buildDynamicReviewPackage({
    candidates,
    packageProducerSha: producerSha,
    sandboxRoot,
    outputRoot,
    bridgeTarget: fixedR20NeutralTarget(),
    duplicatePolicy: "reject"
  });
  if (r20.package.state !== DYNAMIC_REVIEW_PACKAGE_READY) {
    fail("review_round_r20_mismatch", "R20 package is not ready");
  }

  const roles = roleById(request);
  const participants = participantById(request);
  const roundLineage = targetedLineageFromR20(request, r20.package);
  const entries = r20.package.sealedMapping.entries.map((entry) => {
    const participant = participants.get(entry.candidateId);
    const role = roles.get(entry.candidateId);
    if (!participant || !role) fail("review_round_invalid", "R20 sealed mapping contains unexpected candidate");
    const targeted = request.mode === "targeted_reedit";
    const isChallenger = role === "challenger";
    return {
      blindLabel: entry.blindLabel,
      genericFileName: entry.genericFileName,
      role,
      candidateId: entry.candidateId,
      roundNumber: entry.roundNumber,
      briefLineageDigest: participant.briefLineageDigest,
      source: clone(entry.source),
      render: clone(entry.render),
      renderExport: clone(entry.renderExport),
      renderProducerSha: entry.renderProducerSha,
      parentCandidateId: targeted && isChallenger ? roundLineage.parentCandidateId : null,
      parentRenderSha256: targeted && isChallenger ? roundLineage.parentRenderSha256 : null,
      growthHandoffDigest: targeted && isChallenger ? roundLineage.growthHandoffDigest : null,
      mediaApplicationDigest: targeted && isChallenger ? roundLineage.mediaApplicationDigest : null,
      attachment: clone(entry.attachment)
    };
  });
  const sealedMapping = {
    digest: fingerprint(entries),
    entries
  };
  assertModelFacingBlindness(r20.package.promptManifest, entries);

  const attachments = r20.package.attachments.map((attachment) => ({
    blindLabel: attachment.blindLabel,
    path: attachment.file.path,
    sha256: attachment.file.sha256,
    size: attachment.file.size,
    mimeType: attachment.mimeType,
    derivative_for_model_review: attachment.derivative?.derivative_for_model_review === true
  }));

  const core = bundleCore({
    producerSha,
    request,
    r20Package: r20.package,
    r20PackageDigest: r20.packageDigest,
    roundLineage,
    sealedMapping,
    attachments
  });
  const packageDigest = fingerprint(core);
  const roundLineageDigest = fingerprint({
    source: core.source,
    briefLineageDigest: core.briefLineageDigest,
    reviewRound: core.reviewRound,
    roundLineage: core.roundLineage
  });
  const transportHandoff = {
    contractVersion: MEDIA_REVIEW_ROUND_HANDOFF_VERSION,
    state: ROUND_PAIR_PACKAGE_READY,
    bridgeAuthority: clone(R21_BRIDGE_R30_AUTHORITY),
    packageDigest,
    sealedMappingDigest: sealedMapping.digest,
    promptBytes: Buffer.byteLength(core.prompt.text, "utf8"),
    promptText: core.prompt.text,
    promptDigest: core.prompt.digest,
    sourceLineage: {
      sourceId: core.source.sourceId,
      sha256: core.source.sha256,
      size: core.source.size,
      briefLineageDigest: core.briefLineageDigest
    },
    roundLineage: {
      mode: core.mode,
      reviewRound: core.reviewRound,
      digest: roundLineageDigest
    },
    attachments: attachments.map((attachment) => clone(attachment)),
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
  const bundle = validateReviewRoundBundle({
    ...core,
    transportHandoff
  });
  return {
    bundle,
    packageDigest,
    sealedMappingDigest: sealedMapping.digest,
    roundLineageDigest,
    r20Package: r20.package,
    r20PackageDigest: r20.packageDigest
  };
}
