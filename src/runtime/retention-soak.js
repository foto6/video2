import { fingerprint } from "../stable.js";
import {
  artifactManifestDigest,
  evidenceDigest
} from "./artifact-manifest.js";
import {
  buildArtifactRetentionMetadata,
  makeInternalRetentionRecord,
  planArtifactGc
} from "./artifact-retention.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function syntheticManifest(seed, index, artifactDigest, logicalJobId) {
  const probe = { fixture: "probe", seed, index, ok: true };
  const qa = { fixture: "qa", seed, index, passed: true };
  const manifest = {
    contractVersion: "media.artifact_manifest.v1",
    logicalJobId,
    idempotencyKey: `retention-soak:${seed}:${index}`,
    renderFingerprint: fingerprint({ seed, index, kind: "render" }),
    attemptToken: `${logicalJobId}:render:1`,
    validatedRequestDigest: fingerprint({ seed, index, kind: "request" }),
    profileDigest: fingerprint({ seed, index, kind: "profile" }),
    content: {
      algorithm: "sha256",
      sha256: artifactDigest,
      size: index + 1,
      contentId: `sha256:${artifactDigest}`
    },
    probeEvidence: {
      sha256: evidenceDigest(probe),
      value: probe
    },
    qaEvidence: {
      sha256: evidenceDigest(qa),
      passed: true,
      value: qa
    },
    finalization: {
      method: "atomic_rename",
      preparedSha256: artifactDigest,
      preparedSize: index + 1,
      preparedAtMs: 1000000 + index * 10,
      finalizedAtMs: 1000001 + index * 10
    },
    timestamps: {
      jobCreatedAtMs: 999000 + index * 10,
      manifestCommittedAtMs: 1000002 + index * 10
    }
  };
  return manifest;
}

function retentionClassFor(index) {
  if (index % 20 === 0) return "protected";
  if (index % 17 === 0) return "checkpoint_pinned";
  if (index % 19 === 0) return "release_pinned";
  if (index % 2 === 0) return "cacheable";
  return "transient";
}

export function buildRetentionStressCorpus({
  seed = 808080,
  recordCount = 1200
} = {}) {
  if (!Number.isInteger(recordCount) || recordCount < 1000) {
    throw new TypeError("retention stress corpus requires at least 1000 records");
  }

  const records = [];
  const jobs = [];
  const checkpointPins = [];
  const releasePins = [];
  const classCounts = {
    transient: 0,
    cacheable: 0,
    checkpoint_pinned: 0,
    release_pinned: 0,
    protected: 0
  };

  for (let index = 0; index < recordCount; index += 1) {
    const logicalJobId = `retention-${seed}-${String(index).padStart(4, "0")}`;
    const artifactDigest = fingerprint({ seed, index, kind: "artifact" });
    const manifest = syntheticManifest(seed, index, artifactDigest, logicalJobId);
    const manifestDigest = artifactManifestDigest(manifest);
    const retentionClass = retentionClassFor(index);
    classCounts[retentionClass] += 1;

    const pinReasons = index % 31 === 0 ? ["manual_hold"] : [];
    const references = index % 37 === 0
      ? [{ kind: "legacy_checkpoint", id: `legacy-${index}`, digest: manifestDigest }]
      : [];
    const metadata = buildArtifactRetentionMetadata({
      artifactDigest,
      logicalJobId,
      manifestDigest,
      createdAtMs: manifest.timestamps.jobCreatedAtMs,
      finalizedAtMs: manifest.finalization.finalizedAtMs,
      retentionClass,
      pinReasons,
      references,
      lastVerifiedIntegrity: {
        verifiedAtMs: manifest.timestamps.manifestCommittedAtMs,
        ok: true,
        sha256: artifactDigest,
        size: manifest.content.size
      }
    });
    records.push(makeInternalRetentionRecord({
      storageKey: `retention-stress/${seed}/${index}.bin`,
      metadata,
      manifest
    }));

    const reconciliation = index % 29 === 0;
    const succeeded = index % 7 === 0;
    if (reconciliation) {
      jobs.push({
        id: logicalJobId,
        status: "retry_wait",
        dryRun: false,
        reconciliation: { required: true, reason: "uncertain_render_attempt" }
      });
    } else if (succeeded) {
      jobs.push({
        id: logicalJobId,
        status: "succeeded",
        dryRun: false,
        artifactManifest: clone(manifest),
        artifactManifestSha256: manifestDigest,
        reconciliation: { required: false }
      });
    }

    if (index % 11 === 0) {
      const pin = {
        referenceId: `checkpoint-${index}`,
        artifactDigest,
        logicalJobId,
        manifestDigest
      };
      checkpointPins.push(pin);
      if (index % 22 === 0) checkpointPins.push({ ...pin });
    }

    if (index % 13 === 0) {
      const pin = {
        referenceId: `release-${index}`,
        artifactDigest,
        logicalJobId,
        manifestDigest
      };
      releasePins.push(pin);
      if (index % 26 === 0) releasePins.push({ ...pin });
    }
  }

  return {
    seed,
    recordCount,
    records,
    jobs,
    checkpointPins,
    releasePins,
    classCounts
  };
}

export function runRetentionPlannerStress(options = {}) {
  const corpus = buildRetentionStressCorpus(options);
  const nowMs = 2000000;
  const plan = planArtifactGc({
    records: corpus.records,
    jobs: corpus.jobs,
    checkpointPins: corpus.checkpointPins,
    releasePins: corpus.releasePins,
    nowMs
  });

  const reachableRecordIds = new Set();
  const jobById = new Map(corpus.jobs.map((job) => [job.id, job]));
  for (const record of corpus.records) {
    const metadata = record.metadata;
    const job = jobById.get(metadata.logicalJobId);
    const jobReachable = Boolean(job?.reconciliation?.required) ||
      Boolean(job?.status === "succeeded" && job?.artifactManifest?.content?.sha256 === metadata.artifactDigest);
    const checkpointReachable = corpus.checkpointPins.some((pin) =>
      pin.artifactDigest === metadata.artifactDigest &&
      pin.logicalJobId === metadata.logicalJobId &&
      pin.manifestDigest === metadata.manifestDigest
    );
    const releaseReachable = corpus.releasePins.some((pin) =>
      pin.artifactDigest === metadata.artifactDigest &&
      pin.logicalJobId === metadata.logicalJobId &&
      pin.manifestDigest === metadata.manifestDigest
    );
    const durablePinned = ["protected", "checkpoint_pinned", "release_pinned"].includes(metadata.retentionClass) ||
      metadata.pinReasons.length > 0 ||
      metadata.references.length > 0;
    if (jobReachable || checkpointReachable || releaseReachable || durablePinned) {
      reachableRecordIds.add(record.recordId);
    }
  }
  const eligibleRecordIds = plan.entries.filter((entry) => entry.eligible).map((entry) => entry.recordId);
  const eligibleSet = new Set(eligibleRecordIds);
  const reachableEligibleViolations = [...reachableRecordIds].filter((recordId) => eligibleSet.has(recordId));

  return {
    seed: corpus.seed,
    recordCount: corpus.recordCount,
    classCounts: corpus.classCounts,
    jobReferences: corpus.jobs.length,
    checkpointPinDeliveries: corpus.checkpointPins.length,
    releasePinDeliveries: corpus.releasePins.length,
    eligible: plan.summary.eligible,
    blocked: plan.summary.blocked,
    workUnits: plan.summary.workUnits,
    eligibleRecordIds,
    blockedRecordCount: reachableRecordIds.size,
    reachableRecordCount: reachableRecordIds.size,
    reachableEligibleViolations: reachableEligibleViolations.length,
    planDigest: plan.planDigest
  };
}
