import {
  artifactManifestDigest,
  evidenceDigest,
  validateArtifactManifest,
  verifyArtifactManifestForJob
} from "./runtime/artifact-manifest.js";
import { evaluateCreativeQuality } from "./creative-plan.js";
import { fingerprint, stableStringify } from "./stable.js";
import { canonicalizeTimeline } from "./timeline.js";

export const MEDIA_CREATOR_CONSUMER_COMPAT_VERSION = "media.creator_consumer_compat.r13.v1";

const ENVELOPE_FIELDS = new Set([
  "contractVersion",
  "logicalJobId",
  "idempotencyKey",
  "renderFingerprint",
  "profileDigest",
  "creativePlanDigest",
  "finalContent",
  "artifactManifestDigest",
  "probeEvidence",
  "technicalQa",
  "creativeQuality",
  "timelineDigest",
  "producer",
  "contractDigests"
]);

function fail(message) {
  throw new TypeError(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail(`${label} must be an object`);
  const expected = new Set(fields);
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length) fail(`${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail(`${label} unknown fields: ${extra.sort().join(", ")}`);
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hex string`);
  }
}

function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail(`${label} must be a lowercase 40-character Git SHA`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
}

function validateContractDigests(contractDigests, label = "contractDigests") {
  if (!plainObject(contractDigests) || Object.keys(contractDigests).length < 10) {
    fail(`${label} must contain all pinned compatibility contracts`);
  }
  const out = {};
  for (const key of Object.keys(contractDigests).sort()) {
    const entry = contractDigests[key];
    exactKeys(entry, ["path", "gitBlobSha"], `${label}.${key}`);
    nonEmpty(entry.path, `${label}.${key}.path`);
    gitSha(entry.gitBlobSha, `${label}.${key}.gitBlobSha`);
    out[key] = { path: entry.path, gitBlobSha: entry.gitBlobSha };
  }
  return out;
}

function validateCreativeQuality(quality, creativePlanDigest) {
  if (!plainObject(quality)) fail("creativeQuality must be an object");
  if (quality.contractVersion !== "media.creative_quality_report.r12.v1") {
    fail("creativeQuality contractVersion mismatch");
  }
  if (quality.passed !== true) fail("creativeQuality must pass");
  if (quality.creativePlanDigest !== creativePlanDigest) {
    fail("creativeQuality creativePlanDigest mismatch");
  }
  if (!Array.isArray(quality.guardrails) || quality.guardrails.length === 0 ||
      quality.guardrails.some((entry) => entry?.pass !== true)) {
    fail("all creative guardrails must pass");
  }
  if (quality.visualQa?.passed !== true ||
      !Array.isArray(quality.visualQa?.checks) ||
      quality.visualQa.checks.some((entry) => entry?.pass !== true)) {
    fail("all creative visual QA checks must pass");
  }
}

function validateTechnicalQa(technicalQa) {
  exactKeys(technicalQa, ["sha256", "passed", "value"], "technicalQa");
  sha256(technicalQa.sha256, "technicalQa.sha256");
  if (technicalQa.passed !== true || technicalQa.value?.passed !== true) {
    fail("technical QA must pass");
  }
  if (!Array.isArray(technicalQa.value?.checks) ||
      technicalQa.value.checks.length === 0 ||
      technicalQa.value.checks.some((entry) => entry?.pass !== true)) {
    fail("all technical QA checks must pass");
  }
  if (evidenceDigest(technicalQa.value) !== technicalQa.sha256) {
    fail("technicalQa evidence digest mismatch");
  }
}

function validateProbeEvidence(probeEvidence) {
  exactKeys(probeEvidence, ["sha256", "value"], "probeEvidence");
  sha256(probeEvidence.sha256, "probeEvidence.sha256");
  if (!plainObject(probeEvidence.value)) fail("probeEvidence.value must be an object");
  if (evidenceDigest(probeEvidence.value) !== probeEvidence.sha256) {
    fail("probeEvidence digest mismatch");
  }
}

export function buildCreatorConsumerEnvelope({
  job,
  artifactManifest,
  creativeQualityReport = null,
  producerSha,
  contractDigests
} = {}) {
  if (!job || typeof job !== "object") fail("job is required");
  if (job.status !== "succeeded" || job.dryRun === true) {
    fail("only succeeded live Media jobs may be exported to Creator");
  }
  const manifest = verifyArtifactManifestForJob(job, artifactManifest);
  const timeline = canonicalizeTimeline(job.timeline);
  const creativePlanDigest = timeline.creativePlan?.planDigest;
  sha256(creativePlanDigest, "timeline.creativePlan.planDigest");
  gitSha(producerSha, "producerSha");
  const pins = validateContractDigests(contractDigests);

  const quality = creativeQualityReport ?? evaluateCreativeQuality(timeline, job.probe ?? {});
  validateCreativeQuality(quality, creativePlanDigest);
  validateTechnicalQa(manifest.qaEvidence);
  validateProbeEvidence(manifest.probeEvidence);

  const envelope = {
    contractVersion: MEDIA_CREATOR_CONSUMER_COMPAT_VERSION,
    logicalJobId: manifest.logicalJobId,
    idempotencyKey: manifest.idempotencyKey,
    renderFingerprint: manifest.renderFingerprint,
    profileDigest: manifest.profileDigest,
    creativePlanDigest,
    finalContent: {
      sha256: manifest.content.sha256,
      size: manifest.content.size
    },
    artifactManifestDigest: artifactManifestDigest(manifest),
    probeEvidence: clone(manifest.probeEvidence),
    technicalQa: clone(manifest.qaEvidence),
    creativeQuality: clone(quality),
    timelineDigest: fingerprint(timeline),
    producer: {
      repository: "foto6/video2",
      sha: producerSha
    },
    contractDigests: pins
  };

  return validateCreatorConsumerEnvelope(envelope, {
    artifactManifest: manifest,
    timeline,
    expectedProducerSha: producerSha,
    expectedContractDigests: pins
  });
}

export function validateCreatorConsumerEnvelope(input, {
  artifactManifest,
  timeline,
  expectedProducerSha,
  expectedContractDigests
} = {}) {
  exactKeys(input, ENVELOPE_FIELDS, "Creator compatibility envelope");
  if (input.contractVersion !== MEDIA_CREATOR_CONSUMER_COMPAT_VERSION) {
    fail("Creator compatibility contractVersion mismatch");
  }
  nonEmpty(input.logicalJobId, "logicalJobId");
  if (input.idempotencyKey !== null) nonEmpty(input.idempotencyKey, "idempotencyKey");
  sha256(input.renderFingerprint, "renderFingerprint");
  sha256(input.profileDigest, "profileDigest");
  sha256(input.creativePlanDigest, "creativePlanDigest");
  sha256(input.artifactManifestDigest, "artifactManifestDigest");
  sha256(input.timelineDigest, "timelineDigest");

  exactKeys(input.finalContent, ["sha256", "size"], "finalContent");
  sha256(input.finalContent.sha256, "finalContent.sha256");
  positiveInteger(input.finalContent.size, "finalContent.size");
  validateProbeEvidence(input.probeEvidence);
  validateTechnicalQa(input.technicalQa);
  validateCreativeQuality(input.creativeQuality, input.creativePlanDigest);

  exactKeys(input.producer, ["repository", "sha"], "producer");
  if (input.producer.repository !== "foto6/video2") fail("producer.repository mismatch");
  gitSha(input.producer.sha, "producer.sha");
  const pins = validateContractDigests(input.contractDigests);

  if (!expectedProducerSha) fail("expectedProducerSha is required for fail-closed validation");
  gitSha(expectedProducerSha, "expectedProducerSha");
  if (input.producer.sha !== expectedProducerSha) fail("producer SHA does not match pinned exact head");

  if (!expectedContractDigests) fail("expectedContractDigests is required for fail-closed validation");
  const expectedPins = validateContractDigests(expectedContractDigests, "expectedContractDigests");
  if (stableStringify(pins) !== stableStringify(expectedPins)) {
    fail("contract digests do not match pinned compatibility manifest");
  }

  if (!artifactManifest) fail("artifactManifest is required for fail-closed validation");
  const manifest = validateArtifactManifest(artifactManifest);
  if (artifactManifestDigest(manifest) !== input.artifactManifestDigest) {
    fail("artifactManifestDigest mismatch");
  }
  if (manifest.logicalJobId !== input.logicalJobId ||
      manifest.idempotencyKey !== input.idempotencyKey ||
      manifest.renderFingerprint !== input.renderFingerprint ||
      manifest.profileDigest !== input.profileDigest ||
      manifest.content.sha256 !== input.finalContent.sha256 ||
      manifest.content.size !== input.finalContent.size) {
    fail("Creator envelope does not match artifact manifest identity");
  }
  if (manifest.probeEvidence.sha256 !== input.probeEvidence.sha256 ||
      stableStringify(manifest.probeEvidence.value) !== stableStringify(input.probeEvidence.value)) {
    fail("Creator envelope probe evidence does not match artifact manifest");
  }
  if (manifest.qaEvidence.sha256 !== input.technicalQa.sha256 ||
      stableStringify(manifest.qaEvidence.value) !== stableStringify(input.technicalQa.value)) {
    fail("Creator envelope technical QA does not match artifact manifest");
  }

  if (!timeline) fail("timeline is required for fail-closed validation");
  const canonicalTimeline = canonicalizeTimeline(timeline);
  if (fingerprint(canonicalTimeline) !== input.timelineDigest) fail("timelineDigest mismatch");
  if (canonicalTimeline.creativePlan?.planDigest !== input.creativePlanDigest) {
    fail("creativePlanDigest does not match canonical timeline");
  }

  return clone(input);
}
