import {
  createArtifactPinLease,
  isArtifactPinLeaseActive
} from "./artifact-pin-lease.js";
import { planArtifactGc } from "./artifact-retention.js";
import { buildRetentionStressCorpus } from "./retention-soak.js";

export function buildPinLeaseStressCorpus({
  seed = 909090,
  leaseCount = 10000,
  retentionRecordCount = 1200,
  nowMs = 2000000
} = {}) {
  if (!Number.isInteger(leaseCount) || leaseCount < 10000) {
    throw new TypeError("pin lease stress requires at least 10000 leases");
  }
  if (!Number.isInteger(retentionRecordCount) || retentionRecordCount < 1000) {
    throw new TypeError("pin lease stress requires at least 1000 retention records");
  }

  const retention = buildRetentionStressCorpus({
    seed: 808080,
    recordCount: retentionRecordCount
  });
  const leases = [];
  let activeLeases = 0;
  let expiredLeases = 0;

  for (let index = 0; index < leaseCount; index += 1) {
    const record = retention.records[index % retention.records.length];
    const createdAtMs = 1000000 + index;
    const expired = index % 7 === 0;
    const expiresAtMs = expired
      ? 1500000
      : (index % 2 === 0 ? null : 2500000);
    const lease = createArtifactPinLease({
      artifactDigest: record.metadata.artifactDigest,
      manifestDigest: record.metadata.manifestDigest,
      ownerKind: index % 2 === 0 ? "creator_checkpoint" : "release_candidate",
      ownerId: `wave9-${seed}-${String(index).padStart(5, "0")}`,
      pinReason: index % 2 === 0 ? "checkpoint_active" : "release_candidate_active",
      createdAtMs,
      renewedAtMs: createdAtMs,
      expiresAtMs,
      generation: 1
    });
    leases.push(lease);
    if (isArtifactPinLeaseActive(lease, { nowMs })) activeLeases += 1;
    else expiredLeases += 1;
  }

  return {
    seed,
    leaseCount,
    retentionRecordCount,
    nowMs,
    retention,
    leases,
    activeLeases,
    expiredLeases
  };
}

export function runPinLeaseStress(options = {}) {
  const corpus = buildPinLeaseStressCorpus(options);
  const plan = planArtifactGc({
    records: corpus.retention.records,
    jobs: corpus.retention.jobs,
    checkpointPins: corpus.retention.checkpointPins,
    releasePins: corpus.retention.releasePins,
    pinLeases: corpus.leases,
    nowMs: corpus.nowMs
  });
  const externallyPinned = plan.entries.filter((entry) =>
    entry.reasons.includes("external_pin_lease")
  ).length;
  const reachableEligibilityViolations = plan.entries.filter((entry) =>
    entry.reasons.includes("external_pin_lease") && entry.eligible
  ).length;

  return {
    seed: corpus.seed,
    leaseCount: corpus.leaseCount,
    retentionRecordCount: corpus.retentionRecordCount,
    activeLeases: corpus.activeLeases,
    expiredLeases: corpus.expiredLeases,
    recordsPinnedByActiveLease: externallyPinned,
    eligibleAfterLeases: plan.summary.eligible,
    blockedAfterLeases: plan.summary.blocked,
    reachableEligibilityViolations,
    plannerWorkUnits: plan.summary.workUnits,
    planDigest: plan.planDigest
  };
}
