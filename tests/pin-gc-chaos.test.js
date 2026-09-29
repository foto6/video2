import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  MEDIA_ARTIFACT_PIN_REQUEST_VERSION,
  MEDIA_ARTIFACT_PIN_LEASE_VERSION,
  PersistentArtifactPinLeaseStore,
  artifactManifestDigest,
  artifactPinScope,
  buildArtifactManifest,
  buildArtifactRetentionMetadata,
  buildRenderPlan,
  createArtifactPinLease,
  handleMediaRenderRequest,
  isProtectedPath,
  makeInternalRetentionRecord,
  planArtifactGcWithPinStore,
  prepareScopedGcApproval,
  runPinLeaseStress,
  simulateScopedArtifactGc,
  validateCreatorArtifactPinRequest,
  validateArtifactPinLease
} from "../src/index.js";

const fixtureRoot = new URL("../conformance/media.pin_gc_chaos.v1/", import.meta.url);
const reportUrl = new URL("../reports/R9_PIN_GC_CHAOS.json", import.meta.url);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const temp = () => mkdtempSync(path.join(os.tmpdir(), "media-pin-gc-chaos-"));

function makeRecord(id, bytes = `synthetic-content:${id}\n`) {
  const artifactDigest = sha(bytes);
  const job = {
    id, idempotencyKey: `synthetic:${id}`, renderFingerprint: sha(`render:${id}`),
    dryRun: false,
    timeline: {
      id, version: 1,
      canvas: { width: 64, height: 64, fps: 10, durationMs: 300 },
      tracks: []
    },
    exportSpec: { runtimeProfile: "standard" },
    outputPath: `virtual/${id}.bin`, createdAtMs: 100,
    scheduling: {
      profile: "standard", priorityClass: "normal",
      requirements: {
        render: { cpu: 1, gpu: 0, render: 1, probe: 0, qa: 0 },
        probe: { cpu: 1, gpu: 0, render: 0, probe: 1, qa: 0 },
        qa: { cpu: 1, gpu: 0, render: 0, probe: 0, qa: 1 }
      }
    },
    currentAttempt: { token: `${id}:render:1` },
    probe: { fixture: "synthetic-probe", id, observed: true },
    qa: { fixture: "synthetic-qa", id, passed: true }
  };
  const finalDigest = { sha256: artifactDigest, size: Buffer.byteLength(bytes) };
  const manifest = buildArtifactManifest(job, {
    finalDigest, preparedDigest: finalDigest,
    preparedAtMs: 101, finalizedAtMs: 102, manifestCommittedAtMs: 103
  });
  const metadata = buildArtifactRetentionMetadata({
    artifactDigest, logicalJobId: id,
    manifestDigest: artifactManifestDigest(manifest),
    createdAtMs: 100, finalizedAtMs: 102, retentionClass: "cacheable",
    lastVerifiedIntegrity: {
      verifiedAtMs: 103, ok: true,
      sha256: artifactDigest, size: finalDigest.size
    }
  });
  return makeInternalRetentionRecord({
    storageKey: `virtual/${id}.bin`, metadata, manifest
  });
}

function makeContext(record, now = 1000) {
  const root = temp();
  const clock = { value: now };
  const storePath = path.join(root, "synthetic-pin-lease-state.json");
  const store = new PersistentArtifactPinLeaseStore({
    filePath: storePath, clock: () => clock.value
  });
  const virtual = new Map([[record.recordId, {
    artifactDigest: record.metadata.artifactDigest,
    manifestDigest: record.metadata.manifestDigest,
    size: record.manifest.content.size
  }]]);
  const binding = {
    creatorJobId: `creator:${record.metadata.logicalJobId}`,
    logicalMediaJobId: record.metadata.logicalJobId,
    checkpointId: `checkpoint:${record.metadata.logicalJobId}`,
    releaseCandidateId: null,
    artifactDigest: record.metadata.artifactDigest,
    manifestDigest: record.metadata.manifestDigest
  };
  const args = {
    artifactDigest: binding.artifactDigest,
    manifestDigest: binding.manifestDigest,
    ownerKind: "creator_checkpoint",
    ownerId: binding.checkpointId,
    pinReason: "creator_checkpoint_active",
    expiresAtMs: null
  };
  const verifyArtifact = (input) => ({
    verified: virtual.has(record.recordId),
    artifactDigest: input.artifactDigest,
    manifestDigest: input.manifestDigest,
    logicalMediaJobId: input.logicalMediaJobId
  });
  const acquire = (requestId, extra = {}) => store.journaledLeaseOperation({
    requestId, action: "acquire", args, binding, expectedOwnerEpoch: 0,
    verifyArtifact, ...extra
  });
  const release = (requestId, expectedGeneration = 1, extra = {}) =>
    store.journaledLeaseOperation({
      requestId, action: "release",
      args: { ownerKind: args.ownerKind, ownerId: args.ownerId, expectedGeneration },
      binding, expectedOwnerEpoch: null, ...extra
    });
  const plan = () => planArtifactGcWithPinStore({
    pinLeaseStore: store, records: [record], nowMs: clock.value
  });
  const approval = (p, approvalId = `approve:${record.metadata.logicalJobId}`) =>
    prepareScopedGcApproval({
      pinLeaseStore: store, plan: p, recordId: record.recordId,
      approvalId, approvedBy: "synthetic-human-reviewer",
      clock: () => clock.value, ttlMs: 1000
    });
  const simulate = (p, opts = {}) => simulateScopedArtifactGc({
    plan: p, records: [record], virtualArtifacts: virtual,
    pinLeaseStore: store, clock: () => clock.value, ...opts
  });
  return { root, clock, storePath, store, virtual, record, binding, args,
    verifyArtifact, acquire, release, plan, approval, simulate };
}

function dispose(context) {
  rmSync(context.root, { recursive: true, force: true });
}

test("baseline media.render.v1 remains planning-only with a deterministic synthetic fixture", () => {
  const request = JSON.parse(readFileSync(new URL("fixtures/synthetic-render.request.json", fixtureRoot), "utf8"));
  let executorInvocations = 0;
  const response = handleMediaRenderRequest(request, {
    executor: { run() { executorInvocations += 1; throw Error("forbidden executor invocation"); } }
  });
  assert.equal(response.contractVersion, "media.render.v1");
  assert.equal(response.dryRun, true);
  assert.equal(executorInvocations, 0);
  assert.equal(response.renderFingerprint, buildRenderPlan(request.timeline, request.exportSpec).fingerprint);
});

test("Creator command fixture is strict, path-free, and pre-existing pin-lease contract is unchanged", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixtureRoot), "utf8"));
  for (const item of manifest.files) {
    const bytes = readFileSync(new URL(item.path, fixtureRoot));
    assert.equal(sha(bytes), item.sha256, item.path);
  }
  const commands = JSON.parse(readFileSync(new URL("fixtures/creator-commands.json", fixtureRoot), "utf8"));
  const request = validateCreatorArtifactPinRequest(commands.acquire);
  assert.equal(request.contractVersion, MEDIA_ARTIFACT_PIN_REQUEST_VERSION);
  assert.equal(request.binding.logicalMediaJobId, commands.acquire.binding.logicalMediaJobId);
  assert.throws(() => validateCreatorArtifactPinRequest({
    ...commands.acquire, extra: "unauthorized"
  }), (error) => error.code === "pin_lease_invalid");

  const frozen = JSON.parse(readFileSync(new URL("../media.artifact_pin_lease.v1/fixtures/canonical.json", fixtureRoot), "utf8"));
  assert.equal(validateArtifactPinLease(frozen).contractVersion, MEDIA_ARTIFACT_PIN_LEASE_VERSION);
  const baseline = JSON.parse(readFileSync(new URL("../media.artifact_pin_lease.v1/manifest.json", fixtureRoot), "utf8"));
  assert.equal(sha(readFileSync(new URL("../media.artifact_pin_lease.v1/manifest.json", fixtureRoot))), "1431f9feed07b29832281cb3e14542b03bea369ca5e2c98a91b695f2e1a915d4");
  assert.equal(baseline.contractVersion, MEDIA_ARTIFACT_PIN_LEASE_VERSION);
});

test("verified Creator job/checkpoint binding, duplicate request ID and owner epoch are at-most-once", () => {
  const c = makeContext(makeRecord("idempotent"));
  try {
    const first = c.acquire("creator-request-001");
    assert.equal(first.lease.generation, 1);
    assert.equal(first.duplicate, false);
    const repeated = c.acquire("creator-request-001");
    assert.equal(repeated.replayed, true);
    assert.equal(repeated.lease.canonicalDigest, first.lease.canonicalDigest);
    assert.equal(c.store.events().length, 1);

    const otherDelivery = c.store.journaledLeaseOperation({
      requestId: "creator-request-002", action: "acquire", args: c.args,
      binding: c.binding, expectedOwnerEpoch: 1, verifyArtifact: c.verifyArtifact
    });
    assert.equal(otherDelivery.duplicate, true);
    assert.equal(c.store.events().length, 1);
    assert.equal(c.store.epochFor(c.args.artifactDigest, c.args.manifestDigest), 1);

    assert.throws(() => c.store.journaledLeaseOperation({
      requestId: "creator-request-001", action: "acquire",
      args: { ...c.args, manifestDigest: "f".repeat(64) },
      binding: c.binding, expectedOwnerEpoch: 0, verifyArtifact: c.verifyArtifact
    }), (error) => error.code === "pin_request_conflict" || error.code === "pin_binding_conflict");
  } finally { dispose(c); }
});

test("wrong Creator binding or missing final-artifact verification fails before effect", () => {
  const c = makeContext(makeRecord("binding"));
  try {
    assert.throws(() => c.store.journaledLeaseOperation({
      requestId: "unverified", action: "acquire", args: c.args,
      binding: c.binding, expectedOwnerEpoch: 0
    }), (error) => error.code === "pin_artifact_verification_required");
    assert.throws(() => c.store.journaledLeaseOperation({
      requestId: "wrong-manifest", action: "acquire",
      args: { ...c.args, manifestDigest: "d".repeat(64) },
      binding: c.binding, expectedOwnerEpoch: 0,
      verifyArtifact: c.verifyArtifact
    }), (error) => error.code === "pin_binding_conflict");
    assert.throws(() => c.store.journaledLeaseOperation({
      requestId: "wrong-creator", action: "acquire", args: c.args,
      binding: { ...c.binding, creatorJobId: "wrong-creator", checkpointId: "wrong-owner" },
      expectedOwnerEpoch: 0, verifyArtifact: c.verifyArtifact
    }), (error) => error.code === "pin_binding_conflict");
    assert.equal(c.store.events().length, 0);
  } finally { dispose(c); }
});

test("renew/release CAS and replacement owner epochs reject stale generations and cross-job aliasing", () => {
  const c = makeContext(makeRecord("replacement"));
  try {
    c.acquire("pin-initial");
    const renewed = c.store.journaledLeaseOperation({
      requestId: "pin-renew", action: "renew",
      args: {
        ownerKind: c.args.ownerKind, ownerId: c.args.ownerId,
        expectedGeneration: 1, expiresAtMs: 8000
      },
      binding: c.binding, expectedOwnerEpoch: null
    });
    assert.equal(renewed.generation, 2);
    assert.throws(() => c.release("pin-stale-release", 1),
      (error) => error.code === "pin_lease_generation_conflict");

    assert.throws(() => c.store.journaledLeaseOperation({
      requestId: "pin-alias", action: "acquire",
      args: { ...c.args, expiresAtMs: 8000 },
      binding: { ...c.binding, creatorJobId: "different-creator" },
      expectedOwnerEpoch: 2, verifyArtifact: c.verifyArtifact
    }), (error) => error.code === "pin_binding_conflict");

    const released = c.release("pin-release", 2);
    assert.equal(released.released, true);
    assert.equal(c.store.epochFor(c.args.artifactDigest, c.args.manifestDigest), 3);

    const replacement = c.store.journaledLeaseOperation({
      requestId: "pin-replace", action: "acquire",
      args: { ...c.args, expiresAtMs: null },
      binding: { ...c.binding, creatorJobId: "replacement-creator" },
      expectedOwnerEpoch: 2, verifyArtifact: c.verifyArtifact
    });
    assert.equal(replacement.lease.generation, 3);
    assert.equal(c.store.events().length, 4);
    assert.throws(() => c.store.journaledLeaseOperation({
      requestId: "pin-stale-replace", action: "acquire",
      args: c.args, binding: c.binding,
      expectedOwnerEpoch: 2, verifyArtifact: c.verifyArtifact
    }), (error) => ["pin_binding_conflict","pin_owner_epoch_conflict"].includes(error.code));
  } finally { dispose(c); }
});

test("lost acknowledgment after committed acquire and release returns persisted response after restart", () => {
  const c = makeContext(makeRecord("lost-ack"));
  try {
    assert.throws(() => c.acquire("ack-acquire", {
      fault: "after_commit_before_ack"
    }), (error) => error.code === "pin_ack_lost");
    const restarted = new PersistentArtifactPinLeaseStore({
      filePath: c.storePath, clock: () => c.clock.value
    });
    const replay = restarted.journaledLeaseOperation({
      requestId: "ack-acquire", action: "acquire",
      args: c.args, binding: c.binding, expectedOwnerEpoch: 0,
      verifyArtifact: c.verifyArtifact
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.lease.generation, 1);
    assert.equal(restarted.events().length, 1);

    assert.throws(() => restarted.journaledLeaseOperation({
      requestId: "ack-release", action: "release",
      args: { ownerKind: c.args.ownerKind, ownerId: c.args.ownerId, expectedGeneration: 1 },
      binding: c.binding, expectedOwnerEpoch: null,
      fault: "after_commit_before_ack"
    }), (error) => error.code === "pin_ack_lost");
    const secondRestart = new PersistentArtifactPinLeaseStore({
      filePath: c.storePath, clock: () => c.clock.value
    });
    const released = secondRestart.journaledLeaseOperation({
      requestId: "ack-release", action: "release",
      args: { ownerKind: c.args.ownerKind, ownerId: c.args.ownerId, expectedGeneration: 1 },
      binding: c.binding, expectedOwnerEpoch: null
    });
    assert.equal(released.replayed, true);
    assert.equal(released.released, true);
    assert.equal(secondRestart.events().length, 2);
    assert.equal(secondRestart.listActive().length, 0);
  } finally { dispose(c); }
});

test("unknown outcome after persisted pin side effect blocks GC even after expiry; restart reconciles without replay", () => {
  const c = makeContext(makeRecord("unknown-effect"));
  try {
    c.args.expiresAtMs = 1500;
    assert.throws(() => c.acquire("unknown-acquire", {
      fault: "after_effect_before_commit"
    }), (error) => error.code === "pin_outcome_unknown");
    c.clock.value = 1500;
    let p = c.plan();
    assert.equal(p.summary.eligible, 0);
    assert.equal(p.entries[0].reasons.includes("pin_outcome_unknown"), true);
    assert.equal(c.store.events().length, 1);

    const restart = new PersistentArtifactPinLeaseStore({
      filePath: c.storePath, clock: () => c.clock.value
    });
    assert.throws(() => restart.journaledLeaseOperation({
      requestId: "unknown-acquire", action: "acquire",
      args: c.args, binding: c.binding, expectedOwnerEpoch: 0,
      verifyArtifact: c.verifyArtifact
    }), (error) => error.code === "pin_outcome_unknown");
    const recovered = restart.reconcileJournaledRequest({ requestId: "unknown-acquire" });
    assert.equal(recovered.lease.generation, 1);
    assert.equal(restart.events().length, 1);
    p = planArtifactGcWithPinStore({
      pinLeaseStore: restart, records: [c.record], nowMs: c.clock.value
    });
    assert.equal(p.summary.eligible, 1);
  } finally { dispose(c); }
});

test("prepared-before-effect request requires explicit, epoch-bound no-effect reconciliation", () => {
  const c = makeContext(makeRecord("prepared-only"));
  try {
    assert.throws(() => c.acquire("prepared-not-applied", {
      fault: "after_prepare_before_effect"
    }), (error) => error.code === "pin_outcome_unknown");
    assert.equal(c.store.events().length, 0);
    assert.equal(c.plan().summary.eligible, 0);
    const restart = new PersistentArtifactPinLeaseStore({
      filePath: c.storePath, clock: () => c.clock.value
    });
    const outcome = restart.reconcileNoEffect({
      requestId: "prepared-not-applied", reviewedBy: "synthetic-reviewer",
      evidenceDigest: sha("persisted-root-and-epoch-no-effect"),
      expectedScopeEpoch: 0
    });
    assert.equal(outcome.status, "aborted");
    assert.equal(planArtifactGcWithPinStore({
      pinLeaseStore: restart, records: [c.record], nowMs: c.clock.value
    }).summary.eligible, 1);
    assert.throws(() => restart.journaledLeaseOperation({
      requestId: "prepared-not-applied", action: "acquire",
      args: c.args, binding: c.binding, expectedOwnerEpoch: 0,
      verifyArtifact: c.verifyArtifact
    }), (error) => error.code === "pin_request_closed");
  } finally { dispose(c); }
});

test("orphaned coordination barrier and corrupt journal both fail closed after restart", () => {
  const c = makeContext(makeRecord("orphan-lock"));
  try {
    mkdirSync(c.store.coordinationPath);
    assert.throws(() => c.plan(), (error) => error.code === "pin_gc_coordination_unknown");
    assert.throws(() => c.acquire("lock-acquire"), (error) => error.code === "pin_gc_coordination_unknown");
    rmSync(c.store.coordinationPath, { recursive: true, force: true });

    writeFileSync(c.storePath, "{ torn pin journal", "utf8");
    assert.throws(() => new PersistentArtifactPinLeaseStore({
      filePath: c.storePath, clock: () => c.clock.value
    }), (error) => error.code === "pin_lease_state_corrupt");
  } finally { dispose(c); }
});

test("active checkpoint lease blocks approval; post-plan acquisition and release invalidate old approval epoch", () => {
  const c = makeContext(makeRecord("approval-epoch"));
  try {
    const oldPlan = c.plan();
    const oldApproval = c.approval(oldPlan, "approval-old");
    assert.equal(oldPlan.summary.eligible, 1);
    c.acquire("pin-between-plan-approval");
    assert.equal(c.plan().summary.eligible, 0);
    assert.throws(() => c.approval(oldPlan, "approval-pinned"),
      (error) => error.code === "gc_approval_blocked");
    const pinned = c.simulate(oldPlan, { dryRun: false, approvals: [oldApproval] });
    assert.equal(pinned.outcomes[0].status, "stale_plan_rejected");
    assert.equal(c.virtual.has(c.record.recordId), true);

    c.release("pin-owner-release", 1);
    const afterRelease = c.plan();
    assert.equal(afterRelease.summary.eligible, 1);
    const stale = c.simulate(afterRelease, {
      dryRun: false,
      approvals: [{ ...oldApproval, planDigest: afterRelease.planDigest }]
    });
    assert.equal(stale.outcomes[0].status, "stale_plan_rejected");
    assert.equal(c.virtual.has(c.record.recordId), true);

    const fresh = c.approval(afterRelease, "approval-current-epoch");
    const result = c.simulate(afterRelease, { dryRun: false, approvals: [fresh] });
    assert.equal(result.outcomes[0].status, "deleted");
    assert.equal(c.virtual.has(c.record.recordId), false);
  } finally { dispose(c); }
});

test("cleanup and simultaneous external acquire are serialized through one atomic coordination barrier", () => {
  const c = makeContext(makeRecord("simultaneous"));
  try {
    const plan = c.plan();
    const approval = c.approval(plan);
    const competingStore = new PersistentArtifactPinLeaseStore({
      filePath: c.storePath, clock: () => c.clock.value
    });
    let rejected = 0;
    const outcome = c.simulate(plan, {
      dryRun: false, approvals: [approval],
      beforeSyntheticDelete: () => {
        assert.throws(() => competingStore.acquire(c.args),
          (error) => error.code === "pin_gc_coordination_unknown");
        rejected += 1;
        assert.throws(() => c.store.acquire(c.args),
          (error) => error.code === "pin_gc_coordination_busy");
        rejected += 1;
      }
    });
    assert.equal(rejected, 2);
    assert.equal(outcome.outcomes[0].status, "deleted");
    assert.equal(c.virtual.has(c.record.recordId), false);
    assert.throws(() => c.acquire("pin-after-deletion"),
      (error) => error.code === "pin_artifact_integrity");
  } finally { dispose(c); }
});

test("lost cleanup outcome after synthetic side effect blocks retries/restarts until scoped delete evidence", () => {
  const c = makeContext(makeRecord("cleanup-unknown"));
  try {
    const unrelated = makeRecord("unrelated");
    c.virtual.set(unrelated.recordId, {
      artifactDigest: unrelated.metadata.artifactDigest,
      manifestDigest: unrelated.metadata.manifestDigest,
      size: unrelated.manifest.content.size
    });
    const plan = c.plan();
    const approval = c.approval(plan, "cleanup-approval-unknown");
    const result = c.simulate(plan, {
      dryRun: false, approvals: [approval],
      fault: "after_delete_before_commit"
    });
    assert.equal(result.outcomes[0].status, "outcome_unknown");
    assert.equal(c.virtual.has(c.record.recordId), false);
    assert.equal(c.virtual.has(unrelated.recordId), true);

    const restart = new PersistentArtifactPinLeaseStore({
      filePath: c.storePath, clock: () => c.clock.value
    });
    assert.equal(planArtifactGcWithPinStore({
      pinLeaseStore: restart, records: [c.record], nowMs: c.clock.value
    }).entries[0].reasons.includes("cleanup_outcome_unknown"), true);
    const retry = simulateScopedArtifactGc({
      plan, records: [c.record], virtualArtifacts: c.virtual,
      pinLeaseStore: restart, approvals: [approval],
      clock: () => c.clock.value, dryRun: false
    });
    assert.equal(retry.summary.deleted, 0);
    assert.equal(c.virtual.has(unrelated.recordId), true);
    assert.throws(() => restart.reconcileCleanupNoDelete({
      requestId: approval.approvalId,
      reviewedBy: "synthetic-reviewer",
      evidenceDigest: sha("false-no-delete"),
      verifyNoDelete: () => c.virtual.has(c.record.recordId)
    }), (error) => error.code === "gc_outcome_unknown");

    const resolved = restart.reconcileCleanupDeleted({
      requestId: approval.approvalId,
      reviewedBy: "synthetic-reviewer",
      evidenceDigest: sha("scoped-virtual-record-missing"),
      verifyDeleted: (row) => row.recordId === c.record.recordId &&
        !c.virtual.has(row.recordId)
    });
    assert.equal(resolved.status, "deleted_reconciled");
    assert.equal(restart.cleanupRequest(approval.approvalId).status, "committed");
  } finally { dispose(c); }
});

test("prepared cleanup with no side effect can only be cleared by verified no-delete evidence", () => {
  const c = makeContext(makeRecord("cleanup-prepared"));
  try {
    const plan = c.plan();
    const approval = c.approval(plan);
    c.store.withCoordination(() => c.store.beginCleanup({
      requestId: approval.approvalId,
      recordId: c.record.recordId,
      artifactDigest: c.record.metadata.artifactDigest,
      manifestDigest: c.record.metadata.manifestDigest,
      planDigest: plan.planDigest, approval
    }));
    assert.equal(c.virtual.has(c.record.recordId), true);
    assert.equal(c.plan().summary.eligible, 0);
    const resolved = c.store.reconcileCleanupNoDelete({
      requestId: approval.approvalId,
      reviewedBy: "synthetic-reviewer",
      evidenceDigest: sha("record-still-present-and-digest-matched"),
      verifyNoDelete: (row) => row.recordId === c.record.recordId &&
        c.virtual.has(row.recordId)
    });
    assert.equal(resolved.status, "aborted");
    assert.equal(c.plan().summary.eligible, 1);
    const freshApproval = c.approval(c.plan(), "fresh-approval");
    assert.equal(c.simulate(c.plan(), {
      dryRun: true, approvals: [freshApproval]
    }).outcomes[0].status, "would_delete");
    assert.equal(c.virtual.has(c.record.recordId), true);
  } finally { dispose(c); }
});

test("protected-path lexical veto and stale manifest digest prevent scoped mutation without file inspection", () => {
  const c = makeContext(makeRecord("protected-path"));
  try {
    assert.equal(isProtectedPath("E:\\manhwa\\unread-video.mp4"), true);
    assert.throws(() => createArtifactPinLease({
      artifactDigest: c.record.metadata.artifactDigest,
      manifestDigest: c.record.metadata.manifestDigest,
      ownerKind: "creator_checkpoint",
      ownerId: "E:\\manhwa\\owner",
      pinReason: "checkpoint", createdAtMs: 1, renewedAtMs: 1,
      expiresAtMs: null, generation: 1
    }), (error) => error.code === "pin_lease_invalid");
    const wrong = { ...c.record, metadata: {
      ...c.record.metadata, manifestDigest: "f".repeat(64)
    }};
    assert.throws(() => planArtifactGcWithPinStore({
      pinLeaseStore: c.store, records: [wrong], nowMs: c.clock.value
    }), (error) => error.code === "retention_invalid");
    assert.equal(c.virtual.has(c.record.recordId), true);
  } finally { dispose(c); }
});

test("seeded synthetic GC simulation never deletes a reachable artifact or any real file", () => {
  const fixture = JSON.parse(readFileSync(new URL("fixtures/scoped-chaos.json", fixtureRoot), "utf8"));
  const summary = {
    seeds: fixture.seeds, records: 0, pinnedBeforeRelease: 0,
    dryRunPlans: 0, virtualDeletes: 0,
    lostCleanupOutcomes: 0, reconciledDeletes: 0,
    realArtifactFilesReadOrDeleted: 0
  };
  for (const seed of fixture.seeds) {
    for (let index = 0; index < fixture.logicalRecordsPerSeed; index += 1) {
      const c = makeContext(makeRecord(`seed-${seed}-${index}`));
      try {
        summary.records += 1;
        if (index % 3 === 0) {
          c.acquire(`seed-pin:${seed}:${index}`);
          assert.equal(c.plan().summary.eligible, 0);
          summary.pinnedBeforeRelease += 1;
          c.release(`seed-release:${seed}:${index}`);
        }
        const plan = c.plan();
        assert.equal(plan.summary.eligible, 1);
        const approval = c.approval(plan, `seed-approval:${seed}:${index}`);
        assert.equal(c.simulate(plan).outcomes[0].status, "would_delete");
        summary.dryRunPlans += 1;
        assert.equal(c.virtual.has(c.record.recordId), true);

        const injected = index % 4 === 0;
        const result = c.simulate(plan, {
          dryRun: false, approvals: [approval],
          fault: injected ? "after_delete_before_commit" : null
        });
        assert.equal(result.outcomes[0].status, injected ? "outcome_unknown" : "deleted");
        assert.equal(c.virtual.has(c.record.recordId), false);
        summary.virtualDeletes += 1;
        if (injected) {
          summary.lostCleanupOutcomes += 1;
          const restart = new PersistentArtifactPinLeaseStore({
            filePath: c.storePath, clock: () => c.clock.value
          });
          restart.reconcileCleanupDeleted({
            requestId: approval.approvalId,
            reviewedBy: "synthetic-reviewer",
            evidenceDigest: sha(`seed:${seed}:${index}:delete-proof`),
            verifyDeleted: (row) => row.recordId === c.record.recordId &&
              !c.virtual.has(row.recordId)
          });
          summary.reconciledDeletes += 1;
        }
      } finally { dispose(c); }
    }
  }
  assert.equal(summary.records, fixture.expected.records);
  assert.equal(summary.pinnedBeforeRelease, fixture.expected.pinnedBeforeRelease);
  assert.equal(summary.dryRunPlans, fixture.expected.dryRunPlans);
  assert.equal(summary.virtualDeletes, fixture.expected.virtualDeletes);
  assert.equal(summary.lostCleanupOutcomes, fixture.expected.lostCleanupOutcomes);
  assert.equal(summary.reconciledDeletes, fixture.expected.reconciledDeletes);
  assert.equal(summary.realArtifactFilesReadOrDeleted, 0);
  console.log("R9_PIN_GC_CHAOS_SUMMARY", JSON.stringify(summary));
});

test("prior Wave9 ten-thousand lease and Wave8 retention parity remains exact", () => {
  const summary = runPinLeaseStress({
    seed: 909090, leaseCount: 10000, retentionRecordCount: 1200, nowMs: 2000000
  });
  assert.equal(summary.activeLeases, 8571);
  assert.equal(summary.expiredLeases, 1429);
  assert.equal(summary.recordsPinnedByActiveLease, 1200);
  assert.equal(summary.eligibleAfterLeases, 0);
  assert.equal(summary.blockedAfterLeases, 1200);
  assert.equal(summary.reachableEligibilityViolations, 0);
  assert.equal(summary.planDigest,
    "c868608856674c50e5cf2cfa8ac27d2df7bf82d4e2e0ade11cac43d50fd1a703");
});

test("machine-readable report identifies no paid provider/publication/live GC actions", () => {
  const report = JSON.parse(readFileSync(reportUrl, "utf8"));
  assert.equal(report.reportVersion, "media.r9.pin_gc_chaos.v1");
  assert.equal(report.baselineSha, "ab3be066308f47c1bb07d1836e2d2f72faffe0ff");
  assert.equal(sha(readFileSync(new URL("manifest.json", fixtureRoot))), report.fixtureManifestSha256);
  assert.equal(report.noRealVideoInspection, true);
  assert.equal(report.noProductionDeletion, true);
  assert.equal(report.noPaidProviders, true);
  assert.equal(report.noPublishing, true);
});
