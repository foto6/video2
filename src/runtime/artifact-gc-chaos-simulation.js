import { fingerprint } from "../stable.js";
import { artifactManifestDigest } from "./artifact-manifest.js";
import {
  artifactPinScope,
  createScopedGcApproval
} from "./artifact-pin-lease.js";
import {
  planArtifactGc,
  validateArtifactGcPlan,
  validateInternalRetentionRecord
} from "./artifact-retention.js";
import { runtimeError } from "./errors.js";
import { isProtectedPath } from "./path-policy.js";

/**
 * Authoritative read-only planner. Unlike planArtifactGc's offline input-only
 * form, this always obtains active pins AND unresolved outcomes from durable
 * Media state. Caller-supplied lists may add protections, never subtract them.
 */
export function planArtifactGcWithPinStore({
  pinLeaseStore,
  nowMs = Date.now(),
  pinLeases = [],
  unknownScopes = [],
  ...inputs
} = {}) {
  if (!pinLeaseStore || typeof pinLeaseStore.snapshotForGc !== "function") {
    throw new TypeError("authoritative pinLeaseStore is required");
  }
  const snapshot = pinLeaseStore.snapshotForGc({ nowMs });
  return planArtifactGc({
    ...inputs,
    pinLeases: [...pinLeases, ...snapshot.pinLeases],
    unknownScopes: [...unknownScopes, ...snapshot.unknownScopes],
    nowMs
  });
}

/**
 * Human approval is an additional scoped gate, never a replacement for lease
 * release. The embedding Control/Creator system MUST authenticate approvedBy.
 * The epoch makes approval unusable after an intervening acquire/renew/release.
 */
export function prepareScopedGcApproval({
  pinLeaseStore,
  plan,
  recordId,
  approvalId,
  approvedBy,
  clock = () => Date.now(),
  ttlMs = 60000
} = {}) {
  if (!pinLeaseStore || typeof pinLeaseStore.withCoordination !== "function") {
    throw new TypeError("pinLeaseStore is required");
  }
  const validatedPlan = validateArtifactGcPlan(plan);
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 3600000) {
    throw runtimeError("gc_approval_invalid", "approval TTL must be between 1 and 3600000 ms");
  }
  return pinLeaseStore.withCoordination(() => {
    const entry = validatedPlan.entries.find((candidate) => candidate.recordId === recordId);
    if (!entry || !entry.eligible) {
      throw runtimeError("gc_approval_invalid", "approval target must be eligible in the given dry-run plan");
    }
    const nowMs = clock();
    const snapshot = pinLeaseStore.snapshotForGc({ nowMs });
    if (
      snapshot.pinLeases.some((lease) =>
        lease.artifactDigest === entry.artifactDigest &&
        lease.manifestDigest === entry.manifestDigest
      ) ||
      snapshot.unknownScopes.some((row) =>
        row.artifactDigest === entry.artifactDigest &&
        row.manifestDigest === entry.manifestDigest
      )
    ) {
      throw runtimeError("gc_approval_blocked", "cannot approve while active pin or unknown outcome exists");
    }
    const scope = artifactPinScope(entry.artifactDigest, entry.manifestDigest);
    return createScopedGcApproval({
      approvalId, approvedBy,
      artifactDigest: entry.artifactDigest,
      manifestDigest: entry.manifestDigest,
      planDigest: validatedPlan.planDigest,
      expectedEpoch: snapshot.mutationEpochs[scope] ?? 0,
      approvedAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs
    });
  });
}

function result(recordId, status, error = null) {
  return error
    ? { recordId, status, error: { code: error?.code ?? "gc_simulation_failed", message: error?.message ?? String(error) } }
    : { recordId, status };
}

/**
 * In-memory cleanup simulator: this NEVER reads, opens, probes, or unlinks any
 * artifact file. virtualArtifacts is a Map<recordId, {artifactDigest,
 * manifestDigest,size}>. Only its matching recordId is ever removed.
 *
 * Pin/GC journal and coordination use synthetic temporary state files in
 * focused tests. Production ArtifactGcExecutor uses the same begin/commit
 * journal and exclusive barrier around actual (separately authorized) unlink.
 */
export function simulateScopedArtifactGc({
  plan,
  records,
  virtualArtifacts,
  pinLeaseStore,
  approvals = [],
  jobs = [],
  checkpointPins = [],
  releasePins = [],
  clock = () => Date.now(),
  dryRun = true,
  fault = null,
  beforeSyntheticDelete = null
} = {}) {
  const validatedPlan = validateArtifactGcPlan(plan);
  if (!(virtualArtifacts instanceof Map)) throw new TypeError("virtualArtifacts must be a Map");
  if (!Array.isArray(records) || !Array.isArray(approvals)) throw new TypeError("records/approvals must be arrays");
  if (!pinLeaseStore || typeof pinLeaseStore.withCoordination !== "function") {
    throw new TypeError("authoritative pinLeaseStore is required");
  }
  const byId = new Map(records.map((raw) => {
    const record = validateInternalRetentionRecord(raw);
    return [record.recordId, record];
  }));
  const outcomes = [];
  for (const entry of validatedPlan.entries.filter((item) => item.eligible)) {
    try {
      const outcome = pinLeaseStore.withCoordination(() => {
        const record = byId.get(entry.recordId);
        if (!record) return result(entry.recordId, "stale_record_missing");
        if (isProtectedPath(record.storageKey) || /(^|[\\/])\.\.([\\/]|$)/.test(record.storageKey)) {
          return result(entry.recordId, "path_protected");
        }
        const currentManifestDigest = artifactManifestDigest(record.manifest);
        if (
          currentManifestDigest !== entry.manifestDigest ||
          record.metadata.manifestDigest !== entry.manifestDigest ||
          record.metadata.artifactDigest !== entry.artifactDigest
        ) return result(entry.recordId, "manifest_integrity_failure");

        const current = planArtifactGcWithPinStore({
          pinLeaseStore,
          records: [record],
          jobs, checkpointPins, releasePins,
          nowMs: clock()
        });
        if (!current.entries[0].eligible) {
          return { ...result(entry.recordId, "stale_plan_rejected"), reasons: current.entries[0].reasons };
        }

        const virtual = virtualArtifacts.get(entry.recordId);
        if (!virtual) return result(entry.recordId, "already_missing");
        if (
          virtual.artifactDigest !== entry.artifactDigest ||
          virtual.manifestDigest !== entry.manifestDigest ||
          virtual.size !== record.manifest.content.size
        ) return result(entry.recordId, "manifest_integrity_failure");
        if (dryRun) return result(entry.recordId, "would_delete");

        const approval = approvals.find((item) =>
          item?.artifactDigest === entry.artifactDigest &&
          item?.manifestDigest === entry.manifestDigest &&
          item?.planDigest === validatedPlan.planDigest
        );
        if (!approval) return result(entry.recordId, "human_release_approval_required");

        let prepared = false;
        try {
          const started = pinLeaseStore.beginCleanup({
            requestId: approval.approvalId,
            recordId: entry.recordId,
            artifactDigest: entry.artifactDigest,
            manifestDigest: entry.manifestDigest,
            planDigest: validatedPlan.planDigest,
            approval
          });
          if (started.duplicate) return result(entry.recordId, "already_completed");
          prepared = true;

          if (beforeSyntheticDelete) beforeSyntheticDelete({ recordId: entry.recordId });
          virtualArtifacts.delete(entry.recordId);
          if (fault === "after_delete_before_commit") {
            throw runtimeError("gc_outcome_unknown", "synthetic lost acknowledgement after deletion");
          }
          const completed = result(entry.recordId, "deleted");
          pinLeaseStore.commitCleanup({
            requestId: approval.approvalId,
            outcome: completed
          });
          return completed;
        } catch (error) {
          if (prepared) {
            pinLeaseStore.markCleanupUnknown({
              requestId: approval.approvalId,
              reason: error?.code ?? "gc_simulation_failed"
            });
          }
          return result(entry.recordId, prepared ? "outcome_unknown" : "stale_plan_rejected", error);
        }
      });
      outcomes.push(outcome);
    } catch (error) {
      outcomes.push(result(entry.recordId, "failed_closed", error));
    }
  }
  return {
    contractVersion: "media.artifact_gc_simulation.v1",
    dryRun,
    planDigest: validatedPlan.planDigest,
    outcomes,
    summary: {
      records: validatedPlan.summary.records,
      eligible: validatedPlan.summary.eligible,
      attempted: outcomes.length,
      deleted: outcomes.filter((row) => row.status === "deleted").length,
      unknown: outcomes.filter((row) => row.status === "outcome_unknown").length
    },
    evidenceDigest: fingerprint({ planDigest: validatedPlan.planDigest, outcomes })
  };
}
