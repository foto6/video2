import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_CREATOR_PIN_RECOVERY_VERSION,
  PersistentArtifactPinLeaseStore,
  artifactManifestDigest,
  buildArtifactRetentionMetadata,
  evaluateNativePcMcpExposure,
  fingerprint,
  inspectCreatorPinRecovery,
  makeInternalRetentionRecord,
  planArtifactGcWithPinStore,
  reconcileCreatorPinRecovery,
  validateArtifactManifest
} from "../src/index.js";

const rootUrl = new URL("../conformance/media.creator_pin_recovery.r10/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("../conformance/media.artifact_manifest.v1/fixtures/canonical.json", import.meta.url), "utf8"));
const manifest = validateArtifactManifest(fixture);
const manifestDigest = artifactManifestDigest(manifest);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function createHarness(name = "baseline", { expiryDelta = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r10-pin-"));
  const clock = { value: 1790600000000 };
  const storeFile = path.join(root, "pin-lease-journal.json");
  const store = new PersistentArtifactPinLeaseStore({ filePath: storeFile, clock: () => clock.value });
  const binding = {
    creatorJobId: `creator-r10-${name}`,
    logicalMediaJobId: manifest.logicalJobId,
    checkpointId: `checkpoint-r10-${name}`,
    releaseCandidateId: null,
    artifactDigest: manifest.content.sha256,
    manifestDigest
  };
  const args = {
    artifactDigest: binding.artifactDigest,
    manifestDigest: binding.manifestDigest,
    ownerKind: "creator_checkpoint",
    ownerId: binding.checkpointId,
    pinReason: "creator_checkpoint_active",
    expiresAtMs: expiryDelta === null ? null : clock.value + expiryDelta
  };
  let verificationCalls = 0;
  function verifyArtifact(candidate) {
    verificationCalls += 1;
    return {
      verified:
        manifest.qaEvidence.passed &&
        manifest.finalization.preparedSha256 === manifest.content.sha256 &&
        candidate.logicalMediaJobId === manifest.logicalJobId &&
        candidate.artifactDigest === manifest.content.sha256 &&
        candidate.manifestDigest === manifestDigest,
      logicalMediaJobId: manifest.logicalJobId,
      artifactDigest: manifest.content.sha256,
      manifestDigest
    };
  }
  function apply(requestId, { action = "acquire", operationArgs = args, bindingOverride = binding,
    expectedOwnerEpoch = action === "acquire" ? 0 : null, fault = null, onStore = store } = {}) {
    return onStore.journaledLeaseOperation({
      requestId, action, args: operationArgs, binding: bindingOverride,
      expectedOwnerEpoch, verifyArtifact, fault
    });
  }
  const record = makeInternalRetentionRecord({
    storageKey: "synthetic-media/r10-fixture.bin",
    manifest,
    metadata: buildArtifactRetentionMetadata({
      artifactDigest: manifest.content.sha256,
      logicalJobId: manifest.logicalJobId,
      manifestDigest,
      createdAtMs: manifest.timestamps.jobCreatedAtMs,
      finalizedAtMs: manifest.finalization.finalizedAtMs,
      retentionClass: "cacheable",
      pinReasons: [], references: [],
      lastVerifiedIntegrity: {
        verifiedAtMs: manifest.timestamps.manifestCommittedAtMs,
        ok: true, sha256: manifest.content.sha256, size: manifest.content.size
      }
    })
  });
  function plan(onStore = store) {
    return planArtifactGcWithPinStore({ pinLeaseStore: onStore, records: [record], nowMs: clock.value });
  }
  return {
    root, clock, storeFile, store, binding, args, apply, record, plan,
    verifyArtifact, verificationCalls: () => verificationCalls,
    restart: () => new PersistentArtifactPinLeaseStore({
      filePath: storeFile, clock: () => clock.value
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("Native MCP exposure gate does not confuse Desktop Commander and legacy GitHub relay with direct Native PC", () => {
  const toolNames = [
    "mcp__Remote_Desktop_Commander__list_devices",
    "mcp__Remote_Desktop_Commander__ping",
    "mcp__Remote_Desktop_Commander__get_config",
    "mcp__GitHub__fetch",
    "mcp__GitHub__get_file_contents"
  ];
  const skillUris = ["skills://plugins/pc-control/pc-control"];
  const result = evaluateNativePcMcpExposure({ toolNames, skillUris });
  assert.equal(result.nativeExposed, false);
  assert.deepEqual(result.nativeToolNames, []);
  assert.equal(result.desktopCommanderToolCount, 3);
  assert.equal(result.legacyGitHubRelaySkillVisible, true);
  assert.equal(result.blocker, "NATIVE_PC_MCP_NOT_EXPOSED");
  assert.equal(result.capabilityProbePermitted, false);
  const hypothetical = evaluateNativePcMcpExposure({
    toolNames: [...toolNames, "mcp__Native_PC__readCapabilities", "mcp__Native_PC__list_devices"]
  });
  assert.deepEqual(hypothetical.nativeToolNames, [
    "mcp__Native_PC__list_devices", "mcp__Native_PC__readCapabilities"
  ]);
  assert.equal(hypothetical.nativeExposed, true);
  // The hypothetical is classifier-only; no such callable namespace was present
  // in the actual observed ChatGPT session.
});

test("actual ChatGPT native MCP exposure report contains explicit blocker, null version/digest and no spoofed calls", () => {
  const report = JSON.parse(readFileSync(
    new URL("../reports/R10_NATIVE_MCP_EXPOSURE.json", import.meta.url), "utf8"
  ));
  assert.equal(report.contractVersion, "media.native_pc_exposure_audit.v1");
  assert.equal(report.advertisedToolCount, 255);
  assert.equal(report.exposedPluginNamespaces.Remote_Desktop_Commander, 30);
  assert.equal(report.nativeMcp.blocker, "NATIVE_PC_MCP_NOT_EXPOSED");
  assert.equal(report.nativeMcp.actualNativeCallsAttempted, 0);
  assert.equal(report.nativeMcp.capabilityDiscovery.version, null);
  assert.equal(report.nativeMcp.capabilityDiscovery.registryDigest, null);
  assert.equal(report.nativeMcp.deviceList.outcome, null);
  assert.equal(report.nativeMcp.ping.outcome, null);
  assert.equal(report.nativeMcp.configurationMetadata.outcome, null);
  assert.equal(report.nativeMcp.isolatedKnownTempFixture.outcome, null);
  assert.equal(report.distinctAlternatives.desktopCommander.nativePcMcp, false);
  assert.equal(report.distinctAlternatives.olderPcControl.nativePcMcp, false);
  assert.equal(report.distinctAlternatives.desktopCommander.probedForThisAudit, false);
  assert.equal(report.distinctAlternatives.olderPcControl.usedForThisAudit, false);
});

test("missing request is a read-only blocked observation; validated synthetic manifest binds provenance", () => {
  const h = createHarness("missing");
  try {
    const before = inspectCreatorPinRecovery({
      pinLeaseStore: h.store, requestId: "never-sent"
    });
    assert.equal(before.contractVersion, MEDIA_CREATOR_PIN_RECOVERY_VERSION);
    assert.equal(before.decision, "REQUEST_NOT_FOUND");
    assert.equal(before.canTreatPinAsActive, false);
    assert.equal(before.mayReplaySideEffect, false);
    assert.equal(before.requestId, "never-sent");
    assert.equal(h.store.events().length, 0);
    assert.equal(manifest.qaEvidence.passed, true);
    assert.equal(manifest.finalization.preparedSha256, manifest.content.sha256);
    assert.equal(manifestDigest, "1e938fb714071996c003c20512ac3dbbd9e49e10f554c8758bd9fe48f2258d1c");
  } finally { h.cleanup(); }
});

test("identical duplicate acquire across restart recovers one committed Creator-bound event without second lease", () => {
  const h = createHarness("duplicate");
  try {
    const first = h.apply("creator-r10-duplicate");
    assert.equal(first.lease.generation, 1);
    const restarted = h.restart();
    const journal = restarted.journaledRequest("creator-r10-duplicate");
    const observed = inspectCreatorPinRecovery({
      pinLeaseStore: restarted,
      requestId: "creator-r10-duplicate",
      expectedRequestDigest: journal.requestDigest
    });
    assert.equal(observed.decision, "COMMITTED_ACTIVE_PIN");
    assert.equal(observed.canTreatPinAsActive, true);
    assert.equal(observed.eventVerified, true);
    assert.equal(observed.creatorBindingDigest, fingerprint(h.binding));
    assert.equal(observed.ownerGeneration, 1);
    const replay = h.apply("creator-r10-duplicate", { onStore: restarted });
    assert.equal(replay.replayed, true);
    assert.equal(replay.lease.canonicalDigest, first.lease.canonicalDigest);
    assert.equal(restarted.events().length, 1);
    assert.equal(restarted.epochFor(h.binding.artifactDigest, manifestDigest), 1);
    assert.equal(h.verificationCalls(), 1);
    assert.throws(() => inspectCreatorPinRecovery({
      pinLeaseStore: restarted,
      requestId: "creator-r10-duplicate",
      expectedRequestDigest: "f".repeat(64)
    }), (error) => error.code === "pin_request_conflict");
  } finally { h.cleanup(); }
});

test("lost result after committed acquire replays original answer after process restart, never creates lease 2", () => {
  const h = createHarness("ack");
  try {
    assert.throws(() => h.apply("creator-r10-lost-ack", {
      fault: "after_commit_before_ack"
    }), (error) => error.code === "pin_ack_lost");
    const restarted = h.restart();
    const observed = inspectCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-lost-ack"
    });
    assert.equal(observed.decision, "COMMITTED_ACTIVE_PIN");
    const replay = h.apply("creator-r10-lost-ack", { onStore: restarted });
    assert.equal(replay.replayed, true);
    assert.equal(replay.lease.generation, 1);
    assert.equal(restarted.events().length, 1);
    assert.equal(restarted.listActive().length, 1);
  } finally { h.cleanup(); }
});

test("prepared pre-effect unknown remains GC-blocked; no blind acquire after restart", () => {
  const h = createHarness("pre-effect");
  try {
    assert.throws(() => h.apply("creator-r10-pre-effect", {
      fault: "after_prepare_before_effect"
    }), (error) => error.code === "pin_outcome_unknown");
    const restarted = h.restart();
    const observed = inspectCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-pre-effect"
    });
    assert.equal(observed.decision, "PREPARED_UNPROVEN");
    assert.equal(observed.requiresReconciliation, true);
    assert.equal(observed.mayReplaySideEffect, false);
    assert.equal(h.plan(restarted).summary.eligible, 0);
    assert.equal(h.plan(restarted).entries[0].reasons.includes("pin_outcome_unknown"), true);
    assert.throws(() => reconcileCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-pre-effect"
    }), (error) => error.code === "pin_outcome_unknown");
    assert.throws(() => h.apply("creator-r10-different-id", {
      onStore: restarted
    }), (error) => error.code === "pin_outcome_unknown");
    assert.equal(restarted.events().length, 0);

    const noEffect = restarted.reconcileNoEffect({
      requestId: "creator-r10-pre-effect",
      reviewedBy: "synthetic-provenance-reviewer",
      evidenceDigest: sha256("event-absent-and-scope-epoch-zero"),
      expectedScopeEpoch: 0
    });
    assert.equal(noEffect.status, "aborted");
    const aborted = inspectCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-pre-effect"
    });
    assert.equal(aborted.decision, "ABORTED_PROVEN_NO_EFFECT");
    assert.equal(h.plan(restarted).summary.eligible, 1);
    assert.throws(() => h.apply("creator-r10-pre-effect", { onStore: restarted }),
      (error) => error.code === "pin_request_closed");
  } finally { h.cleanup(); }
});

test("crash after lease event but before Creator-binding commit reconstructs binding without a second effect", () => {
  const h = createHarness("binding-window");
  try {
    assert.throws(() => h.apply("creator-r10-binding-window", {
      fault: "after_lease_effect_before_binding_commit"
    }), (error) => error.code === "pin_outcome_unknown");
    const restarted = h.restart();
    const snapshot = restarted.recoverySnapshot({ requestId: "creator-r10-binding-window" });
    assert.equal(snapshot.ownerBinding, null);
    assert.equal(snapshot.matchingEvents.length, 1);
    const before = inspectCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-binding-window"
    });
    assert.equal(before.decision, "PREPARED_EFFECT_PROVEN");
    assert.equal(before.canTreatPinAsActive, false);
    assert.equal(h.plan(restarted).summary.eligible, 0);
    const recovered = reconcileCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-binding-window"
    });
    assert.equal(recovered.action, "reconciled_from_persisted_event");
    assert.equal(recovered.after.decision, "COMMITTED_ACTIVE_PIN");
    assert.equal(restarted.recoverySnapshot({ requestId: "creator-r10-binding-window" })
      .ownerBinding.bindingDigest, fingerprint(h.binding));
    assert.equal(restarted.events().length, 1);
    assert.equal(restarted.epochFor(h.binding.artifactDigest, manifestDigest), 1);
  } finally { h.cleanup(); }
});

test("crash after Creator binding but before journal commit preserves exactly one lease after recovery", () => {
  const h = createHarness("effect-window");
  try {
    assert.throws(() => h.apply("creator-r10-effect-window", {
      fault: "after_effect_before_commit"
    }), (error) => error.code === "pin_outcome_unknown");
    const restarted = h.restart();
    assert.equal(inspectCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-effect-window"
    }).decision, "PREPARED_EFFECT_PROVEN");
    const result = reconcileCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-effect-window"
    });
    assert.equal(result.after.decision, "COMMITTED_ACTIVE_PIN");
    assert.equal(restarted.events().length, 1);
    assert.equal(restarted.listActive().length, 1);
  } finally { h.cleanup(); }
});

test("renew supersedes prior committed acknowledgement; stale replay cannot report active older generation", () => {
  const h = createHarness("renew");
  try {
    h.apply("creator-r10-acquire");
    const renewed = h.apply("creator-r10-renew", {
      action: "renew", operationArgs: {
        ownerKind: h.args.ownerKind,
        ownerId: h.args.ownerId,
        expectedGeneration: 1,
        expiresAtMs: null
      },
      expectedOwnerEpoch: null
    });
    assert.equal(renewed.generation, 2);
    assert.equal(inspectCreatorPinRecovery({
      pinLeaseStore: h.store, requestId: "creator-r10-acquire"
    }).decision, "SUPERSEDED_OR_EXPIRED_PIN");
    assert.equal(inspectCreatorPinRecovery({
      pinLeaseStore: h.store, requestId: "creator-r10-renew"
    }).decision, "COMMITTED_ACTIVE_PIN");
    assert.throws(() => h.apply("creator-r10-acquire"),
      (error) => error.code === "pin_request_superseded");
    assert.equal(h.store.events().length, 2);
    assert.equal(h.store.epochFor(h.binding.artifactDigest, manifestDigest), 2);
  } finally { h.cleanup(); }
});

test("after release and owner replacement, stale acquire/release acknowledgements never imply current lease ownership", () => {
  const h = createHarness("replacement");
  try {
    h.apply("creator-r10-first-acquire");
    const released = h.apply("creator-r10-first-release", {
      action: "release",
      operationArgs: {
        ownerKind: h.args.ownerKind, ownerId: h.args.ownerId, expectedGeneration: 1
      }, expectedOwnerEpoch: null
    });
    assert.equal(released.released, true);
    assert.equal(inspectCreatorPinRecovery({
      pinLeaseStore: h.store, requestId: "creator-r10-first-release"
    }).decision, "COMMITTED_RELEASE");
    assert.equal(inspectCreatorPinRecovery({
      pinLeaseStore: h.store, requestId: "creator-r10-first-acquire"
    }).canTreatPinAsActive, false);
    assert.throws(() => h.apply("creator-r10-first-acquire"),
      (error) => error.code === "pin_request_superseded");

    const second = h.apply("creator-r10-replacement-acquire", { expectedOwnerEpoch: 1 });
    assert.equal(second.lease.generation, 2);
    assert.equal(inspectCreatorPinRecovery({
      pinLeaseStore: h.store, requestId: "creator-r10-first-release"
    }).decision, "SUPERSEDED_OR_CONFLICTING_RELEASE");
    assert.throws(() => h.apply("creator-r10-first-release", {
      action: "release", operationArgs: {
        ownerKind: h.args.ownerKind, ownerId: h.args.ownerId, expectedGeneration: 1
      }, expectedOwnerEpoch: null
    }), (error) => error.code === "pin_request_superseded");
    assert.equal(h.store.events().length, 3);
  } finally { h.cleanup(); }
});

test("expired committed lease does not masquerade as active and requires fresh CAS generation", () => {
  const h = createHarness("expiry", { expiryDelta: 100 });
  try {
    h.apply("creator-r10-expiring");
    h.clock.value += 100;
    const old = inspectCreatorPinRecovery({
      pinLeaseStore: h.store, requestId: "creator-r10-expiring"
    });
    assert.equal(old.decision, "SUPERSEDED_OR_EXPIRED_PIN");
    assert.equal(old.canTreatPinAsActive, false);
    assert.throws(() => h.apply("creator-r10-expiring"),
      (error) => error.code === "pin_request_superseded");
    assert.equal(h.plan().summary.eligible, 1);
    // A new request must bind a new expiry and the durable owner generation.
    const renewedArgs = { ...h.args, expiresAtMs: h.clock.value + 1000 };
    const fresh = h.apply("creator-r10-expiry-reacquire", {
      operationArgs: renewedArgs, expectedOwnerEpoch: 1
    });
    assert.equal(fresh.lease.generation, 2);
    assert.equal(h.plan().summary.eligible, 0);
  } finally { h.cleanup(); }
});

test("two independent Creator checkpoints require both releases before any GC eligibility", () => {
  const h = createHarness("dual");
  try {
    h.apply("creator-r10-one");
    const secondBinding = { ...h.binding, checkpointId: "checkpoint-r10-dual-other" };
    const secondArgs = { ...h.args, ownerId: secondBinding.checkpointId };
    const acquired = h.apply("creator-r10-two", {
      operationArgs: secondArgs, bindingOverride: secondBinding,
      expectedOwnerEpoch: 0
    });
    assert.equal(acquired.lease.generation, 1);
    assert.equal(h.store.listActive().length, 2);
    assert.equal(h.plan().summary.eligible, 0);

    h.apply("creator-r10-one-release", {
      action: "release",
      operationArgs: {
        ownerKind: h.args.ownerKind, ownerId: h.args.ownerId, expectedGeneration: 1
      }, expectedOwnerEpoch: null
    });
    assert.equal(h.store.listActive().length, 1);
    assert.equal(h.plan().summary.eligible, 0);
    h.apply("creator-r10-two-release", {
      action: "release",
      operationArgs: {
        ownerKind: secondArgs.ownerKind, ownerId: secondArgs.ownerId, expectedGeneration: 1
      }, bindingOverride: secondBinding, expectedOwnerEpoch: null
    });
    assert.equal(h.plan().summary.eligible, 1);
    assert.equal(h.store.events().length, 4);
  } finally { h.cleanup(); }
});

test("contradictory action in durable event fails closed and cannot manufacture an applied result", () => {
  const h = createHarness("tamper");
  try {
    assert.throws(() => h.apply("creator-r10-tamper", {
      fault: "after_lease_effect_before_binding_commit"
    }), (error) => error.code === "pin_outcome_unknown");
    const bytes = JSON.parse(readFileSync(h.storeFile, "utf8"));
    bytes.events.find((event) => event.requestId === "creator-r10-tamper").type = "release";
    writeFileSync(h.storeFile, JSON.stringify(bytes, null, 2) + "\n");
    const restarted = h.restart();
    assert.equal(inspectCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-tamper"
    }).decision, "PROVENANCE_CONFLICT");
    assert.throws(() => reconcileCreatorPinRecovery({
      pinLeaseStore: restarted, requestId: "creator-r10-tamper"
    }), (error) => error.code === "pin_outcome_unknown");
    assert.throws(() => restarted.reconcileJournaledRequest({
      requestId: "creator-r10-tamper"
    }), (error) => error.code === "pin_outcome_unknown");
    assert.equal(h.plan(restarted).summary.eligible, 0);
    assert.equal(restarted.events().length, 1);
  } finally { h.cleanup(); }
});

test("durable Creator owner-key tampering is rejected at store load, not silently rebound", () => {
  const h = createHarness("owner-corrupt");
  try {
    assert.throws(() => h.apply("creator-r10-owner-corrupt", {
      fault: "after_prepare_before_effect"
    }), (error) => error.code === "pin_outcome_unknown");
    const json = JSON.parse(readFileSync(h.storeFile, "utf8"));
    json.requestJournal["creator-r10-owner-corrupt"].ownerKey = "f".repeat(64);
    writeFileSync(h.storeFile, JSON.stringify(json, null, 2) + "\n");
    assert.throws(() => h.restart(), (error) => error.code === "pin_lease_state_corrupt");
    assert.equal(existsSync(h.storeFile), true);
  } finally { h.cleanup(); }
});

test("deterministic 4-seed x 4-fault restart matrix proves no blind second lease side effect", () => {
  const descriptor = JSON.parse(readFileSync(new URL("fixtures/restart-matrix.json", rootUrl), "utf8"));
  const summary = {
    seeds: descriptor.seeds,
    scenarios: 0,
    preparedUnproven: 0,
    reconciledFromEvent: 0,
    committedAckRecovered: 0,
    duplicateEffectInvocations: 0,
    realVideoReadsOrWrites: 0
  };
  for (const seed of descriptor.seeds) {
    for (const fault of descriptor.faults) {
      const h = createHarness(`matrix-${seed}-${fault}`);
      const requestId = `r10:${seed}:${fault}`;
      try {
        summary.scenarios += 1;
        assert.throws(() => h.apply(requestId, { fault }),
          (error) => ["pin_ack_lost", "pin_outcome_unknown"].includes(error.code));
        const restarted = h.restart();
        const before = inspectCreatorPinRecovery({ pinLeaseStore: restarted, requestId });
        if (fault === "after_prepare_before_effect") {
          summary.preparedUnproven += 1;
          assert.equal(before.decision, "PREPARED_UNPROVEN");
          assert.equal(h.plan(restarted).summary.eligible, 0);
          assert.throws(() => reconcileCreatorPinRecovery({
            pinLeaseStore: restarted, requestId
          }), (error) => error.code === "pin_outcome_unknown");
          assert.equal(restarted.events().length, 0);
          continue;
        }
        if (fault === "after_commit_before_ack") {
          summary.committedAckRecovered += 1;
          assert.equal(before.decision, "COMMITTED_ACTIVE_PIN");
          assert.equal(h.apply(requestId, { onStore: restarted }).replayed, true);
        } else {
          summary.reconciledFromEvent += 1;
          assert.equal(before.decision, "PREPARED_EFFECT_PROVEN");
          const recovered = reconcileCreatorPinRecovery({
            pinLeaseStore: restarted, requestId
          });
          assert.equal(recovered.after.decision, "COMMITTED_ACTIVE_PIN");
        }
        assert.equal(restarted.events().length, 1);
        assert.equal(restarted.listActive().length, 1);
        assert.equal(restarted.epochFor(h.binding.artifactDigest, manifestDigest), 1);
        summary.duplicateEffectInvocations += Math.max(0, restarted.events().length - 1);
      } finally { h.cleanup(); }
    }
  }
  assert.deepEqual(summary, { ...descriptor.expected, seeds: descriptor.seeds });
  console.log("R10_CREATOR_PIN_RECOVERY_SUMMARY", JSON.stringify(summary));
});
