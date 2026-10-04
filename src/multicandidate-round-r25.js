import { stableStringify, fingerprint } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_MULTICANDIDATE_ROUND_VERSION = "media.multicandidate_round.r25.v1";

export const R25_EXTERNAL_UMBRELLA_MAP = Object.freeze({
  requestContract: "media.edit_tournament_request.r25.v1",
  candidateManifestContract: "media.tournament_candidate_manifest.r25.v1",
  bracketContract: "media.review_tournament_bracket.r25.v1",
  targetedReeditContract: "media.tournament_targeted_reedit.r25.v1",
  evidenceContract: "media.edit_tournament.r25.evidence.v1",
  acceptedR24Authority: {
    producerSha: "244acdf154741e669991b17df3ef2a47e2dfdfa9",
    ciRunId: 37195239582,
    artifactId: 11301055747,
    artifactName: "media-r24-canonical-live-review-export",
    artifactDigest: "sha256:fc5c9b9635d49b643e66efafe602d21ce1ef695a553f81a797bdf16d7b8cf228",
    contractVersion: "media.canonical_live_review_export.r24.v1"
  }
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
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("multicandidate_round_invalid", `${label} must be exact Git SHA`);
  }
}
function sha256Digest(value, label) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    fail("multicandidate_round_invalid", `${label} must be sha256:<hex>`);
  }
}
function exactString(actual, expected, label) {
  if (actual !== expected) {
    fail("multicandidate_round_mapping_mismatch", `${label} must map exactly to ${expected}`);
  }
}

export function buildMulticandidateRoundAuthority({
  producerSha,
  implementationBlobs
} = {}) {
  gitSha(producerSha, "producerSha");
  if (!plain(implementationBlobs)) {
    fail("multicandidate_round_invalid", "implementationBlobs must be an object");
  }
  const requiredBlobs = [
    "tournamentImplementation",
    "umbrellaImplementation",
    "runner",
    "phaseMaterializer",
    "rehearsal",
    "verifier",
    "externalContract",
    "externalSchema"
  ];
  for (const key of requiredBlobs) {
    gitSha(implementationBlobs[key], `implementationBlobs.${key}`);
  }
  const authority = {
    contractVersion: MEDIA_MULTICANDIDATE_ROUND_VERSION,
    producer: { repository: "foto6/video2", sha: producerSha },
    internalContracts: {
      request: R25_EXTERNAL_UMBRELLA_MAP.requestContract,
      candidateManifest: R25_EXTERNAL_UMBRELLA_MAP.candidateManifestContract,
      bracket: R25_EXTERNAL_UMBRELLA_MAP.bracketContract,
      targetedReedit: R25_EXTERNAL_UMBRELLA_MAP.targetedReeditContract,
      evidence: R25_EXTERNAL_UMBRELLA_MAP.evidenceContract
    },
    acceptedR24Authority: clone(R25_EXTERNAL_UMBRELLA_MAP.acceptedR24Authority),
    implementationBlobs: clone(implementationBlobs),
    externalAuthorityOnly: true,
    internalContractMayMasqueradeAsUmbrella: false,
    modelReviewPerformed: false,
    providerPublish: false,
    humanQuality: false
  };
  return validateMulticandidateRoundAuthority(authority);
}

export function validateMulticandidateRoundAuthority(input) {
  if (!plain(input)) fail("multicandidate_round_invalid", "umbrella authority must be an object");
  if (input.contractVersion !== MEDIA_MULTICANDIDATE_ROUND_VERSION) {
    if ([
      R25_EXTERNAL_UMBRELLA_MAP.requestContract,
      R25_EXTERNAL_UMBRELLA_MAP.candidateManifestContract,
      R25_EXTERNAL_UMBRELLA_MAP.bracketContract,
      R25_EXTERNAL_UMBRELLA_MAP.targetedReeditContract
    ].includes(input.contractVersion)) {
      fail("multicandidate_round_internal_only", "internal R25 contract cannot masquerade as external umbrella authority");
    }
    fail("multicandidate_round_invalid", "umbrella contractVersion mismatch");
  }
  if (input.producer?.repository !== "foto6/video2") fail("multicandidate_round_invalid", "producer repository mismatch");
  gitSha(input.producer?.sha, "producer.sha");

  const internal = input.internalContracts;
  if (!plain(internal)) fail("multicandidate_round_invalid", "internalContracts required");
  exactString(internal.request, R25_EXTERNAL_UMBRELLA_MAP.requestContract, "internal request");
  exactString(internal.candidateManifest, R25_EXTERNAL_UMBRELLA_MAP.candidateManifestContract, "candidate manifest");
  exactString(internal.bracket, R25_EXTERNAL_UMBRELLA_MAP.bracketContract, "bracket");
  exactString(internal.targetedReedit, R25_EXTERNAL_UMBRELLA_MAP.targetedReeditContract, "targeted re-edit");
  exactString(internal.evidence, R25_EXTERNAL_UMBRELLA_MAP.evidenceContract, "evidence");

  const r24 = input.acceptedR24Authority;
  const expected = R25_EXTERNAL_UMBRELLA_MAP.acceptedR24Authority;
  if (stableStringify(r24) !== stableStringify(expected)) {
    fail("multicandidate_round_mapping_mismatch", "accepted Media R24 authority mismatch");
  }
  gitSha(r24.producerSha, "acceptedR24Authority.producerSha");
  sha256Digest(r24.artifactDigest, "acceptedR24Authority.artifactDigest");

  if (!plain(input.implementationBlobs)) fail("multicandidate_round_invalid", "implementationBlobs required");
  for (const [key, value] of Object.entries(input.implementationBlobs)) {
    gitSha(value, `implementationBlobs.${key}`);
  }
  for (const key of [
    "tournamentImplementation",
    "runner",
    "rehearsal",
    "verifier",
    "externalContract",
    "externalSchema"
  ]) {
    if (!Object.hasOwn(input.implementationBlobs, key)) {
      fail("multicandidate_round_invalid", `implementationBlobs.${key} required`);
    }
  }

  if (
    input.externalAuthorityOnly !== true ||
    input.internalContractMayMasqueradeAsUmbrella !== false ||
    input.modelReviewPerformed !== false ||
    input.providerPublish !== false ||
    input.humanQuality !== false
  ) {
    fail("multicandidate_round_invalid", "umbrella evidence/authority boundary violated");
  }
  return clone(input);
}

export function multicandidateRoundAuthorityDigest(input) {
  return fingerprint(validateMulticandidateRoundAuthority(input));
}
