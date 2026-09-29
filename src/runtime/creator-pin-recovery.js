import { fingerprint } from "../stable.js";
import { runtimeError } from "./errors.js";
import { artifactPinOwnerKey, isArtifactPinLeaseActive } from "./artifact-pin-lease.js";

export const MEDIA_CREATOR_PIN_RECOVERY_VERSION = "media.creator_pin_recovery.v1";

function fail(code, message) {
  throw runtimeError(code, message);
}

function eventProvesRequest(journal, event, lease, ownerGeneration, scopeEpoch) {
  if (!event || artifactPinOwnerKey(event.ownerKind, event.ownerId) !== journal.ownerKey ||
      event.artifactDigest !== journal.artifactDigest ||
      event.manifestDigest !== journal.manifestDigest ||
      scopeEpoch <= journal.scopeEpochAtPrepare) return false;

  const actionMatches = journal.action === "acquire"
    ? ["acquire", "reacquire"].includes(event.type)
    : event.type === journal.action;
  if (!actionMatches) return false;
  if (journal.expectedGeneration !== undefined &&
      event.generation !== (journal.action === "release"
        ? journal.expectedGeneration : journal.expectedGeneration + 1)) return false;
  if (journal.action === "release") {
    return lease === null && ownerGeneration === event.generation &&
      typeof event.canonicalDigest === "string" && /^[a-f0-9]{64}$/.test(event.canonicalDigest);
  }
  return lease !== null && lease.canonicalDigest === event.canonicalDigest &&
    lease.generation === event.generation && ownerGeneration === event.generation &&
    lease.artifactDigest === journal.artifactDigest &&
    lease.manifestDigest === journal.manifestDigest;
}

function normalizeDecision(decision, snapshot, {
  eventVerified = false, activeLease = false, requestId = snapshot.journal?.requestId ?? null
} = {}) {
  const journal = snapshot.journal;
  const canonical = {
    contractVersion: MEDIA_CREATOR_PIN_RECOVERY_VERSION,
    requestId,
    requestDigest: journal?.requestDigest ?? null,
    action: journal?.action ?? null,
    journalStatus: journal?.status ?? "not_found",
    artifactDigest: journal?.artifactDigest ?? null,
    manifestDigest: journal?.manifestDigest ?? null,
    creatorBindingDigest: journal?.bindingDigest ?? null,
    ownerKey: journal?.ownerKey ?? null,
    ownerGeneration: snapshot.ownerGeneration,
    scopeEpoch: snapshot.scopeEpoch,
    leaseCanonicalDigest: snapshot.lease?.canonicalDigest ?? null,
    eventCount: snapshot.matchingEvents.length,
    eventVerified,
    activeLease,
    observedAtMs: snapshot.observedAtMs,
    decision,
    canTreatPinAsActive: decision === "COMMITTED_ACTIVE_PIN",
    canTreatReleaseAsFinal: decision === "COMMITTED_RELEASE",
    mayReplaySideEffect: false,
    requiresReconciliation: [
      "PREPARED_EFFECT_PROVEN", "PREPARED_UNPROVEN", "PROVENANCE_CONFLICT"
    ].includes(decision)
  };
  return { ...canonical, evidenceDigest: fingerprint(canonical) };
}

/**
 * Durable, synchronous read-only recovery gate. A committed historical
 * acknowledgement is not mistaken for a currently pinned artifact; the
 * caller must inspect the present lease, Creator binding, epoch and event.
 * No replay or lease mutation is performed by this function.
 */
export function inspectCreatorPinRecovery({
  pinLeaseStore,
  requestId,
  expectedRequestDigest = null
} = {}) {
  if (!pinLeaseStore || typeof pinLeaseStore.recoverySnapshot !== "function") {
    throw new TypeError("pinLeaseStore.recoverySnapshot is required");
  }
  if (typeof requestId !== "string" || !requestId) {
    throw new TypeError("requestId is required");
  }
  const snapshot = pinLeaseStore.recoverySnapshot({ requestId });
  const row = snapshot.journal;
  if (!row) {
    return normalizeDecision("REQUEST_NOT_FOUND", snapshot, { requestId });
  }
  if (expectedRequestDigest !== null && expectedRequestDigest !== row.requestDigest) {
    fail("pin_request_conflict", "request digest differs from the durable Creator journal");
  }

  if (row.status === "aborted") return normalizeDecision("ABORTED_PROVEN_NO_EFFECT", snapshot);
  if (row.status === "rejected") return normalizeDecision("REJECTED", snapshot);
  if (!["prepared", "committed"].includes(row.status)) {
    return normalizeDecision("PROVENANCE_CONFLICT", snapshot);
  }

  const bindingMatches = snapshot.ownerBinding !== null &&
    snapshot.ownerBinding.bindingDigest === row.bindingDigest;
  const active = snapshot.lease !== null &&
    isArtifactPinLeaseActive(snapshot.lease, { nowMs: snapshot.observedAtMs });
  const events = snapshot.matchingEvents;
  const eventVerified = events.length === 1 && eventProvesRequest(
    row, events[0], snapshot.lease, snapshot.ownerGeneration, snapshot.scopeEpoch
  );

  if (row.status === "prepared") {
    if (events.length === 0) return normalizeDecision("PREPARED_UNPROVEN", snapshot, { activeLease: false });
    return normalizeDecision(
      eventVerified ? "PREPARED_EFFECT_PROVEN" : "PROVENANCE_CONFLICT",
      snapshot, { eventVerified, activeLease: false }
    );
  }

  const responseLease = row.action === "acquire" ? row.response?.lease :
    row.action === "renew" ? row.response : null;
  const duplicateAccepted = row.action === "acquire" &&
    row.response?.duplicate === true && events.length === 0;
  if (row.action === "release") {
    const releaseVerified = eventVerified && !snapshot.lease &&
      snapshot.ownerGeneration === row.response?.generation &&
      snapshot.ownerBinding === null;
    return normalizeDecision(
      releaseVerified ? "COMMITTED_RELEASE" : "SUPERSEDED_OR_CONFLICTING_RELEASE",
      snapshot, { eventVerified, activeLease: false }
    );
  }
  if (events.length !== 1 && !duplicateAccepted) {
    return normalizeDecision("PROVENANCE_CONFLICT", snapshot);
  }
  if (events.length === 1 && !eventVerified) {
    // A previously committed acquire/renew can legitimately be superseded by
    // a later owner epoch. Historical event remains, but never proves ACTIVE.
    if (!active || !snapshot.lease || snapshot.ownerGeneration !== responseLease?.generation) {
      return normalizeDecision("SUPERSEDED_OR_EXPIRED_PIN", snapshot);
    }
    return normalizeDecision("PROVENANCE_CONFLICT", snapshot);
  }
  const currentMatches = bindingMatches && active && responseLease &&
    snapshot.lease.canonicalDigest === responseLease.canonicalDigest &&
    snapshot.ownerGeneration === responseLease.generation;
  return normalizeDecision(
    currentMatches ? "COMMITTED_ACTIVE_PIN" : "SUPERSEDED_OR_EXPIRED_PIN",
    snapshot, { eventVerified, activeLease: Boolean(currentMatches) }
  );
}

/**
 * Explicitly reconstructs an APPLIED prepared request from its persisted
 * exact owner/action/epoch event. Never handles absent/contradictory evidence
 * by resubmitting acquire, renew or release.
 */
export function reconcileCreatorPinRecovery({
  pinLeaseStore,
  requestId,
  expectedRequestDigest = null
} = {}) {
  const before = inspectCreatorPinRecovery({ pinLeaseStore, requestId, expectedRequestDigest });
  if (before.decision === "PREPARED_UNPROVEN" ||
      before.decision === "PROVENANCE_CONFLICT" ||
      before.decision === "REQUEST_NOT_FOUND") {
    fail("pin_outcome_unknown", "no proven effect; preserve unknown journal and do not replay lease");
  }
  if (before.decision !== "PREPARED_EFFECT_PROVEN") {
    return { action: "observed_without_mutation", before, after: before };
  }
  const result = pinLeaseStore.reconcileJournaledRequest({ requestId });
  const after = inspectCreatorPinRecovery({ pinLeaseStore, requestId, expectedRequestDigest });
  if (!["COMMITTED_ACTIVE_PIN", "COMMITTED_RELEASE", "SUPERSEDED_OR_EXPIRED_PIN"].includes(after.decision)) {
    fail("pin_outcome_unknown", "reconciled journal is not a valid committed historical effect");
  }
  return {
    action: "reconciled_from_persisted_event",
    before,
    after,
    persistedResponseDigest: fingerprint(result)
  };
}
