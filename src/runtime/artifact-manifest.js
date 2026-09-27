import { stableStringify, fingerprint } from "../stable.js";
import { runtimeError } from "./errors.js";

export const MEDIA_ARTIFACT_MANIFEST_VERSION = "media.artifact_manifest.v1";

const MANIFEST_FIELDS = new Set([
  "contractVersion",
  "logicalJobId",
  "idempotencyKey",
  "renderFingerprint",
  "attemptToken",
  "validatedRequestDigest",
  "profileDigest",
  "content",
  "probeEvidence",
  "qaEvidence",
  "finalization",
  "timestamps"
]);

function fail(message) {
  throw runtimeError("artifact_manifest_invalid", message);
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

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
}

function finiteTimestamp(value, label) {
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative finite timestamp`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function validatedRequestDigest(job) {
  return fingerprint({
    contractVersion: "media.render.v1",
    jobId: job.id,
    timeline: job.timeline,
    exportSpec: job.exportSpec ?? {},
    outputPath: job.outputPath,
    dryRun: job.dryRun === true
  });
}

export function validatedProfileDigest(job) {
  return fingerprint({
    profile: job.scheduling?.profile ?? "standard",
    priorityClass: job.scheduling?.priorityClass ?? "normal",
    requirements: job.scheduling?.requirements ?? null
  });
}

export function evidenceDigest(value) {
  return fingerprint(value);
}

export function buildArtifactManifest(job, {
  finalDigest,
  preparedDigest,
  preparedAtMs,
  finalizedAtMs,
  manifestCommittedAtMs,
  finalizationMethod = "atomic_rename"
} = {}) {
  if (!job || typeof job !== "object") fail("job is required");
  if (job.dryRun) fail("dry-run jobs cannot publish artifact manifests");
  if (!job.qa?.passed) fail("QA-passing evidence is required");
  nonEmpty(job.currentAttempt?.token, "job.currentAttempt.token");
  sha256(job.renderFingerprint, "job.renderFingerprint");
  sha256(finalDigest?.sha256, "finalDigest.sha256");
  nonNegativeInteger(finalDigest?.size, "finalDigest.size");
  sha256(preparedDigest?.sha256, "preparedDigest.sha256");
  nonNegativeInteger(preparedDigest?.size, "preparedDigest.size");
  if (preparedDigest.sha256 !== finalDigest.sha256 || preparedDigest.size !== finalDigest.size) {
    fail("prepared and finalized byte digests must match");
  }

  const manifest = {
    contractVersion: MEDIA_ARTIFACT_MANIFEST_VERSION,
    logicalJobId: job.id,
    idempotencyKey: job.idempotencyKey ?? null,
    renderFingerprint: job.renderFingerprint,
    attemptToken: job.currentAttempt.token,
    validatedRequestDigest: validatedRequestDigest(job),
    profileDigest: validatedProfileDigest(job),
    content: {
      algorithm: "sha256",
      sha256: finalDigest.sha256,
      size: finalDigest.size,
      contentId: `sha256:${finalDigest.sha256}`
    },
    probeEvidence: {
      sha256: evidenceDigest(job.probe),
      value: clone(job.probe)
    },
    qaEvidence: {
      sha256: evidenceDigest(job.qa),
      passed: true,
      value: clone(job.qa)
    },
    finalization: {
      method: finalizationMethod,
      preparedSha256: preparedDigest.sha256,
      preparedSize: preparedDigest.size,
      preparedAtMs,
      finalizedAtMs
    },
    timestamps: {
      jobCreatedAtMs: job.createdAtMs,
      manifestCommittedAtMs
    }
  };
  return validateArtifactManifest(manifest);
}

export function validateArtifactManifest(input) {
  const manifest = clone(input);
  exactKeys(manifest, MANIFEST_FIELDS, "artifact manifest");
  if (manifest.contractVersion !== MEDIA_ARTIFACT_MANIFEST_VERSION) fail("artifact manifest contractVersion mismatch");
  nonEmpty(manifest.logicalJobId, "logicalJobId");
  if (manifest.idempotencyKey !== null) nonEmpty(manifest.idempotencyKey, "idempotencyKey");
  sha256(manifest.renderFingerprint, "renderFingerprint");
  nonEmpty(manifest.attemptToken, "attemptToken");
  sha256(manifest.validatedRequestDigest, "validatedRequestDigest");
  sha256(manifest.profileDigest, "profileDigest");

  exactKeys(manifest.content, ["algorithm", "sha256", "size", "contentId"], "content");
  if (manifest.content.algorithm !== "sha256") fail("content.algorithm must be sha256");
  sha256(manifest.content.sha256, "content.sha256");
  nonNegativeInteger(manifest.content.size, "content.size");
  if (manifest.content.contentId !== `sha256:${manifest.content.sha256}`) {
    fail("content.contentId must bind the final SHA-256");
  }

  exactKeys(manifest.probeEvidence, ["sha256", "value"], "probeEvidence");
  sha256(manifest.probeEvidence.sha256, "probeEvidence.sha256");
  if (evidenceDigest(manifest.probeEvidence.value) !== manifest.probeEvidence.sha256) {
    fail("probeEvidence digest mismatch");
  }

  exactKeys(manifest.qaEvidence, ["sha256", "passed", "value"], "qaEvidence");
  sha256(manifest.qaEvidence.sha256, "qaEvidence.sha256");
  if (manifest.qaEvidence.passed !== true || manifest.qaEvidence.value?.passed !== true) {
    fail("artifact manifest requires passing QA evidence");
  }
  if (evidenceDigest(manifest.qaEvidence.value) !== manifest.qaEvidence.sha256) {
    fail("qaEvidence digest mismatch");
  }

  exactKeys(
    manifest.finalization,
    ["method", "preparedSha256", "preparedSize", "preparedAtMs", "finalizedAtMs"],
    "finalization"
  );
  if (!["atomic_rename", "legacy_atomic_rename_verified"].includes(manifest.finalization.method)) {
    fail("unsupported finalization method");
  }
  sha256(manifest.finalization.preparedSha256, "finalization.preparedSha256");
  nonNegativeInteger(manifest.finalization.preparedSize, "finalization.preparedSize");
  finiteTimestamp(manifest.finalization.preparedAtMs, "finalization.preparedAtMs");
  finiteTimestamp(manifest.finalization.finalizedAtMs, "finalization.finalizedAtMs");
  if (
    manifest.finalization.preparedSha256 !== manifest.content.sha256 ||
    manifest.finalization.preparedSize !== manifest.content.size
  ) {
    fail("finalization provenance must bind the content digest");
  }

  exactKeys(manifest.timestamps, ["jobCreatedAtMs", "manifestCommittedAtMs"], "timestamps");
  finiteTimestamp(manifest.timestamps.jobCreatedAtMs, "timestamps.jobCreatedAtMs");
  finiteTimestamp(manifest.timestamps.manifestCommittedAtMs, "timestamps.manifestCommittedAtMs");

  const serialized = stableStringify(manifest);
  if (/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i.test(serialized)) {
    fail("artifact manifest must not contain filesystem paths or partial-output identifiers");
  }
  return manifest;
}

export function artifactManifestDigest(manifest) {
  return fingerprint(validateArtifactManifest(manifest));
}

export function verifyArtifactManifestForJob(job, manifest) {
  const value = validateArtifactManifest(manifest);
  if (job.dryRun || job.status !== "succeeded") {
    throw runtimeError("artifact_integrity_failure", "only succeeded live jobs may expose an artifact manifest");
  }
  const checks = [
    [value.logicalJobId === job.id, "logical job id"],
    [value.idempotencyKey === (job.idempotencyKey ?? null), "idempotency key"],
    [value.renderFingerprint === job.renderFingerprint, "render fingerprint"],
    [value.attemptToken === job.currentAttempt?.token, "attempt token"],
    [value.validatedRequestDigest === validatedRequestDigest(job), "validated request digest"],
    [value.profileDigest === validatedProfileDigest(job), "profile digest"],
    [value.probeEvidence.sha256 === evidenceDigest(job.probe), "probe evidence"],
    [value.qaEvidence.sha256 === evidenceDigest(job.qa), "QA evidence"]
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) {
    throw runtimeError("artifact_integrity_failure", `artifact manifest does not match persisted ${failed[1]}`);
  }
  return value;
}

export function serializeArtifactManifest(manifest) {
  return stableStringify(validateArtifactManifest(manifest));
}
