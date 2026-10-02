import { createHash } from "node:crypto";

import {
  MEDIA_PRIOR_REVIEW_SELECTION_VERSION,
  MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
  buildReviewRoundBundle,
  validateReviewRoundBundle
} from "./review-round-r21.js";
import {
  LIVE_REVIEW_ARTIFACT_READY,
  materializeLiveReviewArtifact,
  verifyMaterializedLiveReviewArtifact
} from "./live-review-artifact-r22.js";
import { validateDynamicCandidateDescriptor } from "./dynamic-review-r20.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_REVIEW_SESSION_REQUEST_VERSION = "media.review_session_request.r23.v1";
export const MEDIA_REVIEW_SESSION_PACKAGE_VERSION = "media.review_session_package.r23.v1";
export const REVIEW_SESSION_PACKAGE_READY = "REVIEW_SESSION_PACKAGE_READY";

export const R23_R21_AUTHORITY = Object.freeze({
  repository: "foto6/video2",
  producerSha: "d753e9e4c1f4448386608a1425232dbc1dba87ea",
  ciRunId: 36994000619,
  contractVersion: "media.review_round_bundle.r21.v1",
  implementationBlob: "c6f556b8a177b6182d787356625094cdcad5a58e"
});

export const R23_R22_AUTHORITY = Object.freeze({
  repository: "foto6/video2",
  producerSha: "e82a7ac04f3758d0e3e21ea3d05265dbc2822132",
  ciRunId: 37001071721,
  ciConclusion: "success",
  artifactId: 11224061610,
  artifactName: "media-r22-live-review-operator-bundle",
  artifactDigest: "sha256:d534f1656e22b72cf42531c827e66516965b4167549906521dee04edafd01734",
  implementationBlob: "31845333a6919364d81a7c2bc52aad1cb3ae82ed",
  materializerBlob: "ade9e7181ecccf8e78e7dd966240618c872c9b26",
  verifierBlob: "86b0a53eed6959af805fd0c492620eb037071e25",
  extractorBlob: "dc45ee753480fc62249bd69ca209b994d680d08a",
  contractBlob: "d6e494950b5ab54383733db69912c2384cce188f",
  operatorManifestSchemaBlob: "7e78d7be9fffbbda6ee86cf39c4db8e59a635a3d"
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
function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("review_session_invalid", `${label} must be lowercase SHA-256 hex`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("review_session_invalid", `${label} must be exact Git SHA`);
  }
}
function positive(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail("review_session_invalid", `${label} must be positive integer`);
}
function sameSource(candidate, source) {
  return candidate.source.sourceId === source.sourceId &&
    candidate.source.sha256 === source.sha256 &&
    candidate.source.size === source.size;
}
function candidateSummary(candidate) {
  return {
    candidateId: candidate.candidateId,
    roundNumber: candidate.roundNumber,
    render: {
      sha256: candidate.render.sha256,
      size: candidate.render.size
    },
    renderExport: {
      digest: candidate.renderExport.digest,
      fileSha256: candidate.renderExport.fileSha256
    },
    renderProducerSha: candidate.renderProducerSha,
    editorialApplication: candidate.editorialApplication === null ? null : {
      digest: candidate.editorialApplication.digest,
      fileSha256: candidate.editorialApplication.fileSha256
    }
  };
}

export function validateReviewSessionRequest(input) {
  if (!plain(input)) fail("review_session_invalid", "request must be object");
  const common = [
    "contractVersion", "sessionId", "mode", "reviewRound", "source",
    "briefLineageDigest", "growthSelectedEnvelopeDigest", "growthHandoffDigest"
  ];
  const modeFields = input.mode === "initial"
    ? [...common, "initial"]
    : [...common, "baseline", "challenger"];
  const actual = Object.keys(input).sort();
  const expected = [...modeFields].sort();
  if (stableStringify(actual) !== stableStringify(expected)) {
    fail("review_session_invalid", "request fields mismatch");
  }
  if (input.contractVersion !== MEDIA_REVIEW_SESSION_REQUEST_VERSION) {
    fail("review_session_invalid", "contractVersion mismatch");
  }
  if (typeof input.sessionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(input.sessionId)) {
    fail("review_session_invalid", "sessionId must be path-safe");
  }
  if (!["initial", "targeted_reedit"].includes(input.mode)) {
    fail("review_session_invalid", "mode must be initial or targeted_reedit");
  }
  if (!Number.isInteger(input.reviewRound) || input.reviewRound < 0 || input.reviewRound > 2) {
    fail("review_session_round_invalid", "reviewRound must be 0, 1 or 2");
  }
  if (!plain(input.source) || Object.keys(input.source).sort().join(",") !== "sha256,size,sourceId") {
    fail("review_session_invalid", "source fields mismatch");
  }
  if (typeof input.source.sourceId !== "string" || !input.source.sourceId) fail("review_session_invalid", "sourceId required");
  sha256(input.source.sha256, "source.sha256");
  positive(input.source.size, "source.size");
  sha256(input.briefLineageDigest, "briefLineageDigest");

  if (input.mode === "initial") {
    if (input.reviewRound !== 0) fail("review_session_round_invalid", "initial reviewRound must be 0");
    if (input.growthSelectedEnvelopeDigest !== null || input.growthHandoffDigest !== null) {
      fail("review_session_invalid", "initial session cannot claim prior Growth selection");
    }
    if (!plain(input.initial) || Object.keys(input.initial).sort().join(",") !== "left,right") {
      fail("review_session_invalid", "initial fields mismatch");
    }
    const left = validateDynamicCandidateDescriptor(input.initial.left);
    const right = validateDynamicCandidateDescriptor(input.initial.right);
    if (left.roundNumber !== 0 || right.roundNumber !== 0) fail("review_session_round_invalid", "initial candidates must be round 0");
    if (!sameSource(left, input.source) || !sameSource(right, input.source)) {
      fail("review_session_source_mismatch", "initial candidates do not bind request source");
    }
    if (left.render.sha256 === right.render.sha256) fail("review_session_duplicate_render", "initial candidates are byte-identical");
    return { ...clone(input), initial: { left, right } };
  }

  if (input.reviewRound < 1) fail("review_session_round_invalid", "targeted reviewRound must be 1 or 2");
  sha256(input.growthSelectedEnvelopeDigest, "growthSelectedEnvelopeDigest");
  sha256(input.growthHandoffDigest, "growthHandoffDigest");
  if (!plain(input.baseline) || Object.keys(input.baseline).sort().join(",") !==
      "candidate,priorReviewPackageDigest,priorSealedMappingDigest") {
    fail("review_session_invalid", "baseline fields mismatch");
  }
  const baseline = validateDynamicCandidateDescriptor(input.baseline.candidate);
  const challenger = validateDynamicCandidateDescriptor(input.challenger);
  sha256(input.baseline.priorReviewPackageDigest, "baseline.priorReviewPackageDigest");
  sha256(input.baseline.priorSealedMappingDigest, "baseline.priorSealedMappingDigest");
  if (baseline.roundNumber !== input.reviewRound - 1 || challenger.roundNumber !== input.reviewRound) {
    fail("review_session_round_invalid", "baseline/challenger rounds must be N -> N+1");
  }
  if (!sameSource(baseline, input.source) || !sameSource(challenger, input.source)) {
    fail("review_session_source_mismatch", "targeted candidates do not bind request source");
  }
  if (baseline.render.sha256 === challenger.render.sha256) fail("review_session_duplicate_render", "baseline/challenger bytes are identical");
  if (challenger.editorialApplication === null) {
    fail("review_session_missing_application", "targeted challenger requires R19 application evidence");
  }
  return {
    ...clone(input),
    baseline: { ...clone(input.baseline), candidate: baseline },
    challenger
  };
}

export function reviewSessionIdentity(requestInput) {
  const request = validateReviewSessionRequest(requestInput);
  return fingerprint({
    sessionId: request.sessionId,
    reviewRound: request.reviewRound,
    mode: request.mode,
    source: request.source,
    briefLineageDigest: request.briefLineageDigest,
    growthSelectedEnvelopeDigest: request.growthSelectedEnvelopeDigest,
    growthHandoffDigest: request.growthHandoffDigest,
    baseline: request.mode === "initial"
      ? candidateSummary(request.initial.left)
      : {
          ...candidateSummary(request.baseline.candidate),
          priorReviewPackageDigest: request.baseline.priorReviewPackageDigest,
          priorSealedMappingDigest: request.baseline.priorSealedMappingDigest
        },
    challenger: request.mode === "initial"
      ? candidateSummary(request.initial.right)
      : candidateSummary(request.challenger)
  });
}

export function reviewSessionToR21Request(requestInput) {
  const request = validateReviewSessionRequest(requestInput);
  const participant = (candidate) => ({
    candidate: clone(candidate),
    briefLineageDigest: request.briefLineageDigest
  });
  if (request.mode === "initial") {
    return {
      mode: "initial",
      left: participant(request.initial.left),
      right: participant(request.initial.right)
    };
  }
  return {
    mode: "targeted_reedit",
    baseline: participant(request.baseline.candidate),
    challenger: participant(request.challenger),
    priorReview: {
      contractVersion: MEDIA_PRIOR_REVIEW_SELECTION_VERSION,
      selectedCandidateId: request.baseline.candidate.candidateId,
      reviewRound: request.baseline.candidate.roundNumber,
      reviewPackageDigest: request.baseline.priorReviewPackageDigest,
      sealedMappingDigest: request.baseline.priorSealedMappingDigest,
      decisionEvidenceDigest: request.growthHandoffDigest,
      evidenceType: "growth_reedit_handoff"
    }
  };
}

export function buildFrozenR21RoundForSession({
  request,
  sandboxRoot,
  outputRoot
} = {}) {
  const parsed = validateReviewSessionRequest(request);
  const built = buildReviewRoundBundle({
    request: reviewSessionToR21Request(parsed),
    producerSha: R23_R21_AUTHORITY.producerSha,
    sandboxRoot,
    outputRoot
  });
  const bundle = validateReviewRoundBundle(built.bundle);
  if (bundle.reviewRound !== parsed.reviewRound || bundle.source.sha256 !== parsed.source.sha256 ||
      bundle.briefLineageDigest !== parsed.briefLineageDigest) {
    fail("review_session_lineage_mismatch", "R21 bundle does not bind session source/round/brief");
  }
  if (parsed.mode === "targeted_reedit") {
    if (bundle.roundLineage?.growthHandoffDigest !== parsed.growthHandoffDigest) {
      fail("review_session_growth_handoff_mismatch", "R19/R21 Growth handoff digest differs from selected session handoff");
    }
    if (bundle.roundLineage?.mediaApplicationDigest !== parsed.challenger.editorialApplication.digest) {
      fail("review_session_application_mismatch", "R21 challenger application digest differs from request");
    }
  }
  return built;
}

export function materializeFrozenR22ForSession({
  r21RoundDir,
  outputDir
} = {}) {
  const result = materializeLiveReviewArtifact({
    r21RoundDir,
    outputDir,
    materializerProducerSha: R23_R22_AUTHORITY.producerSha,
    materializerCiRunId: R23_R22_AUTHORITY.ciRunId,
    materializerBlobs: {
      implementation: R23_R22_AUTHORITY.implementationBlob,
      materializer: R23_R22_AUTHORITY.materializerBlob,
      verifier: R23_R22_AUTHORITY.verifierBlob,
      extractor: R23_R22_AUTHORITY.extractorBlob,
      contract: R23_R22_AUTHORITY.contractBlob,
      operatorManifestSchema: R23_R22_AUTHORITY.operatorManifestSchemaBlob
    }
  });
  if (result.verification?.ok !== true || result.verification?.reviewRound == null) {
    fail("review_session_materialization_failed", "R22 materialized directory did not verify");
  }
  return result;
}

export function validateReviewSessionPackage(input) {
  if (!plain(input)) fail("review_session_invalid", "session package must be object");
  const required = [
    "contractVersion","state","producer","sessionId","mode","reviewRound","source",
    "briefLineageDigest","growthSelectedEnvelopeDigest","growthHandoffDigest",
    "baseline","challenger","r21","r22","attachments","promptDigest","sealedMappingDigest",
    "sessionIdentity","modelReviewPerformed","liveModelReviewed","providerPublish","humanQuality"
  ];
  if (stableStringify(Object.keys(input).sort()) !== stableStringify(required.sort())) {
    fail("review_session_invalid", "session package fields mismatch");
  }
  if (input.contractVersion !== MEDIA_REVIEW_SESSION_PACKAGE_VERSION ||
      input.state !== REVIEW_SESSION_PACKAGE_READY) fail("review_session_invalid", "session package contract/state mismatch");
  if (!plain(input.producer) || input.producer.repository !== "foto6/video2") fail("review_session_invalid", "producer invalid");
  gitSha(input.producer.sha, "producer.sha");
  positive(input.producer.ciRunId, "producer.ciRunId");
  if (!Number.isInteger(input.reviewRound) || input.reviewRound < 0 || input.reviewRound > 2) fail("review_session_invalid", "reviewRound invalid");
  sha256(input.source.sha256, "source.sha256");
  positive(input.source.size, "source.size");
  sha256(input.briefLineageDigest, "briefLineageDigest");
  if (input.growthSelectedEnvelopeDigest !== null) sha256(input.growthSelectedEnvelopeDigest, "growthSelectedEnvelopeDigest");
  if (input.growthHandoffDigest !== null) sha256(input.growthHandoffDigest, "growthHandoffDigest");
  sha256(input.r21.packageDigest, "r21.packageDigest");
  sha256(input.r22.directoryDigest, "r22.directoryDigest");
  sha256(input.r22.archiveSha256, "r22.archiveSha256");
  sha256(input.promptDigest, "promptDigest");
  sha256(input.sealedMappingDigest, "sealedMappingDigest");
  sha256(input.sessionIdentity, "sessionIdentity");
  if (!Array.isArray(input.attachments) || input.attachments.length !== 2) fail("review_session_invalid", "two attachments required");
  if (input.attachments[0].sha256 === input.attachments[1].sha256) fail("review_session_duplicate_render", "package attachments are byte-identical");
  if (input.modelReviewPerformed !== false || input.liveModelReviewed !== false ||
      input.providerPublish !== false || input.humanQuality !== false) {
    fail("review_session_invalid", "Media evidence boundary violated");
  }
  return clone(input);
}

export function buildReviewSessionPackage({
  request: requestInput,
  producerSha,
  producerCiRunId,
  r21Bundle,
  r21BundleFileSha256,
  r21RoundLineageDigest,
  r22Materialized,
  r22DirectoryDigest
} = {}) {
  gitSha(producerSha, "producerSha");
  positive(producerCiRunId, "producerCiRunId");
  const request = validateReviewSessionRequest(requestInput);
  const bundle = validateReviewRoundBundle(r21Bundle);
  if (bundle.reviewRound !== request.reviewRound || bundle.mode !== request.mode ||
      bundle.source.sha256 !== request.source.sha256 || bundle.briefLineageDigest !== request.briefLineageDigest) {
    fail("review_session_lineage_mismatch", "R21 bundle does not match session request");
  }
  if (r22Materialized?.verification?.ok !== true || r22Materialized.reviewRound !== request.reviewRound) {
    fail("review_session_materialization_failed", "R22 output does not match review round");
  }
  if (r22Materialized.packageDigest !== bundle.transportHandoff.packageDigest ||
      r22Materialized.sealedMappingDigest !== bundle.sealedMapping.digest ||
      r22Materialized.promptDigest !== bundle.prompt.digest) {
    fail("review_session_materialization_failed", "R22 digests do not bind exact R21 bundle");
  }
  sha256(r21BundleFileSha256, "r21BundleFileSha256");
  sha256(r21RoundLineageDigest, "r21RoundLineageDigest");
  sha256(r22DirectoryDigest, "r22DirectoryDigest");

  const baselineCandidate = request.mode === "initial" ? request.initial.left : request.baseline.candidate;
  const challengerCandidate = request.mode === "initial" ? request.initial.right : request.challenger;
  const pkg = {
    contractVersion: MEDIA_REVIEW_SESSION_PACKAGE_VERSION,
    state: REVIEW_SESSION_PACKAGE_READY,
    producer: { repository: "foto6/video2", sha: producerSha, ciRunId: producerCiRunId },
    sessionId: request.sessionId,
    mode: request.mode,
    reviewRound: request.reviewRound,
    source: clone(request.source),
    briefLineageDigest: request.briefLineageDigest,
    growthSelectedEnvelopeDigest: request.growthSelectedEnvelopeDigest,
    growthHandoffDigest: request.growthHandoffDigest,
    baseline: candidateSummary(baselineCandidate),
    challenger: candidateSummary(challengerCandidate),
    r21: {
      authority: clone(R23_R21_AUTHORITY),
      bundleContract: MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
      packageDigest: bundle.transportHandoff.packageDigest,
      bundleFileSha256: r21BundleFileSha256,
      roundLineageDigest: r21RoundLineageDigest
    },
    r22: {
      authority: clone(R23_R22_AUTHORITY),
      state: LIVE_REVIEW_ARTIFACT_READY,
      directoryDigest: r22DirectoryDigest,
      archiveSha256: r22Materialized.archiveSha256,
      archiveSize: r22Materialized.archiveSize,
      operatorManifestSha256: r22Materialized.operatorManifestSha256,
      packageManifestSha256: r22Materialized.packageManifestSha256
    },
    attachments: r22Materialized.attachments.map((entry) => ({
      blindLabel: entry.blindLabel,
      name: entry.name,
      sha256: entry.sha256,
      size: entry.size,
      mime: entry.mime
    })),
    promptDigest: bundle.prompt.digest,
    sealedMappingDigest: bundle.sealedMapping.digest,
    sessionIdentity: reviewSessionIdentity(request),
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
  return validateReviewSessionPackage(pkg);
}

export function hashSessionPromptBytes(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}
