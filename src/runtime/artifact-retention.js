import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { fingerprint, stableStringify } from "../stable.js";
import {
  artifactManifestDigest,
  validateArtifactManifest
} from "./artifact-manifest.js";
import {
  isArtifactPinLeaseActive,
  validateArtifactPinLease
} from "./artifact-pin-lease.js";
import { outputDigestSync } from "./atomic-output.js";
import { runtimeError } from "./errors.js";
import { isProtectedPath, resolveSandboxedPath } from "./path-policy.js";

export const MEDIA_ARTIFACT_RETENTION_VERSION = "media.artifact_retention.v1";
export const MEDIA_ARTIFACT_GC_PLAN_VERSION = "media.artifact_gc_plan.v1";
export const MEDIA_ARTIFACT_GC_EXECUTION_VERSION = "media.artifact_gc_execution.v1";

export const RETENTION_CLASSES = Object.freeze([
  "transient",
  "cacheable",
  "checkpoint_pinned",
  "release_pinned",
  "protected"
]);

const RETENTION_STORE_VERSION = 1;
const PINNED_CLASSES = new Set(["checkpoint_pinned", "release_pinned", "protected"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value, required, optional, label) {
  if (!isPlainObject(value)) fail("retention_invalid", `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length) fail("retention_invalid", `${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail("retention_invalid", `${label} unknown fields: ${extra.sort().join(", ")}`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("retention_invalid", `${label} must be a lowercase SHA-256 hex string`);
  }
}

function assertNonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail("retention_invalid", `${label} must be a non-empty string`);
  }
}

function assertTimestamp(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    fail("retention_invalid", `${label} must be a non-negative finite timestamp`);
  }
}

function sanitizeReasonList(values, label) {
  if (!Array.isArray(values)) fail("retention_invalid", `${label} must be an array`);
  const output = [];
  const seen = new Set();
  for (const value of values) {
    assertNonEmpty(value, label);
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }
  return output.sort();
}

function validateReference(reference) {
  exactKeys(reference, ["kind", "id"], ["digest"], "retention reference");
  assertNonEmpty(reference.kind, "reference.kind");
  assertNonEmpty(reference.id, "reference.id");
  if (Object.hasOwn(reference, "digest") && reference.digest !== null) {
    assertSha256(reference.digest, "reference.digest");
  }
  return clone(reference);
}

function validateIntegrity(value) {
  if (value === null) return null;
  exactKeys(value, ["verifiedAtMs", "ok", "sha256", "size"], [], "lastVerifiedIntegrity");
  assertTimestamp(value.verifiedAtMs, "lastVerifiedIntegrity.verifiedAtMs");
  if (value.ok !== true) fail("retention_invalid", "lastVerifiedIntegrity.ok must be true");
  assertSha256(value.sha256, "lastVerifiedIntegrity.sha256");
  if (!Number.isInteger(value.size) || value.size < 0) {
    fail("retention_invalid", "lastVerifiedIntegrity.size must be a non-negative integer");
  }
  return clone(value);
}

function validateEligibility(value) {
  exactKeys(value, ["eligible", "reasons", "evaluatedAtMs"], [], "deletionEligibility");
  if (typeof value.eligible !== "boolean") fail("retention_invalid", "deletionEligibility.eligible must be boolean");
  assertTimestamp(value.evaluatedAtMs, "deletionEligibility.evaluatedAtMs");
  const reasons = sanitizeReasonList(value.reasons, "deletionEligibility.reasons");
  if (value.eligible && reasons.length > 0) {
    fail("retention_invalid", "eligible retention metadata cannot contain blocking reasons");
  }
  return { eligible: value.eligible, reasons, evaluatedAtMs: value.evaluatedAtMs };
}

export function validateArtifactRetentionMetadata(input) {
  const value = clone(input);
  exactKeys(value, [
    "contractVersion",
    "artifactDigest",
    "logicalJobId",
    "manifestDigest",
    "createdAtMs",
    "finalizedAtMs",
    "retentionClass",
    "pinReasons",
    "references",
    "lastVerifiedIntegrity",
    "deletionEligibility"
  ], [], "artifact retention metadata");

  if (value.contractVersion !== MEDIA_ARTIFACT_RETENTION_VERSION) {
    fail("retention_invalid", "retention contractVersion mismatch");
  }
  assertSha256(value.artifactDigest, "artifactDigest");
  assertNonEmpty(value.logicalJobId, "logicalJobId");
  assertSha256(value.manifestDigest, "manifestDigest");
  assertTimestamp(value.createdAtMs, "createdAtMs");
  assertTimestamp(value.finalizedAtMs, "finalizedAtMs");
  if (!RETENTION_CLASSES.includes(value.retentionClass)) {
    fail("retention_invalid", `unsupported retentionClass: ${value.retentionClass}`);
  }

  value.pinReasons = sanitizeReasonList(value.pinReasons, "pinReasons");
  if (!Array.isArray(value.references)) fail("retention_invalid", "references must be an array");
  const refs = new Map();
  for (const reference of value.references.map(validateReference)) {
    const key = stableStringify(reference);
    refs.set(key, reference);
  }
  value.references = [...refs.values()].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  value.lastVerifiedIntegrity = validateIntegrity(value.lastVerifiedIntegrity);
  value.deletionEligibility = validateEligibility(value.deletionEligibility);

  const serialized = stableStringify(value);
  if (/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i.test(serialized)) {
    fail("retention_invalid", "public retention metadata must not contain filesystem paths or partial identifiers");
  }
  return value;
}

export function buildArtifactRetentionMetadata({
  artifactDigest,
  logicalJobId,
  manifestDigest,
  createdAtMs,
  finalizedAtMs,
  retentionClass = "cacheable",
  pinReasons = [],
  references = [],
  lastVerifiedIntegrity = null,
  deletionEligibility = null
} = {}) {
  const now = lastVerifiedIntegrity?.verifiedAtMs ?? finalizedAtMs ?? createdAtMs ?? 0;
  return validateArtifactRetentionMetadata({
    contractVersion: MEDIA_ARTIFACT_RETENTION_VERSION,
    artifactDigest,
    logicalJobId,
    manifestDigest,
    createdAtMs,
    finalizedAtMs,
    retentionClass,
    pinReasons,
    references,
    lastVerifiedIntegrity,
    deletionEligibility: deletionEligibility ?? {
      eligible: false,
      reasons: ["not_evaluated"],
      evaluatedAtMs: now
    }
  });
}

export function buildSucceededJobRetentionMetadata(job, { verifiedAtMs = null } = {}) {
  if (!job || job.status !== "succeeded" || job.dryRun || !job.artifactManifest) {
    fail("retention_invalid", "succeeded live job with artifact manifest is required");
  }
  const manifest = validateArtifactManifest(job.artifactManifest);
  const manifestDigest = artifactManifestDigest(manifest);
  const verifiedAt = verifiedAtMs ??
    job.artifactRetention?.lastVerifiedIntegrity?.verifiedAtMs ??
    manifest.timestamps.manifestCommittedAtMs;
  const existing = job.artifactRetention ?? null;
  return buildArtifactRetentionMetadata({
    artifactDigest: manifest.content.sha256,
    logicalJobId: job.id,
    manifestDigest,
    createdAtMs: manifest.timestamps.jobCreatedAtMs,
    finalizedAtMs: manifest.finalization.finalizedAtMs,
    retentionClass: existing?.retentionClass ?? "cacheable",
    pinReasons: ["succeeded_job_manifest", ...(existing?.pinReasons ?? [])],
    references: [
      {
        kind: "succeeded_job_manifest",
        id: job.id,
        digest: manifestDigest
      },
      ...(existing?.references ?? [])
    ],
    lastVerifiedIntegrity: {
      verifiedAtMs: verifiedAt,
      ok: true,
      sha256: manifest.content.sha256,
      size: manifest.content.size
    },
    deletionEligibility: {
      eligible: false,
      reasons: ["succeeded_job_manifest"],
      evaluatedAtMs: verifiedAt
    }
  });
}

function pinMatches(pin, metadata) {
  if (!pin || typeof pin !== "object") return false;
  if (pin.artifactDigest !== metadata.artifactDigest) return false;
  if (pin.logicalJobId !== undefined && pin.logicalJobId !== null && pin.logicalJobId !== metadata.logicalJobId) {
    return false;
  }
  if (pin.manifestDigest !== undefined && pin.manifestDigest !== null && pin.manifestDigest !== metadata.manifestDigest) {
    return false;
  }
  return true;
}

function classifyRecord(record, context) {
  const metadata = validateArtifactRetentionMetadata(record.metadata);
  const reasons = new Set();
  const references = new Map(metadata.references.map((ref) => [stableStringify(ref), ref]));

  if (PINNED_CLASSES.has(metadata.retentionClass)) {
    reasons.add(`retention_class:${metadata.retentionClass}`);
  }
  for (const reason of metadata.pinReasons) reasons.add(`metadata_pin:${reason}`);
  for (const ref of metadata.references) reasons.add(`metadata_reference:${ref.kind}`);

  for (const job of context.jobs) {
    if (job?.reconciliation?.required && job.id === metadata.logicalJobId) {
      reasons.add("unresolved_reconciliation");
      const ref = { kind: "reconciliation", id: job.id };
      references.set(stableStringify(ref), ref);
    }
    if (
      job?.status === "succeeded" &&
      job?.dryRun !== true &&
      job?.artifactManifest?.content?.sha256 === metadata.artifactDigest
    ) {
      const digest = job.artifactManifestSha256 ??
        artifactManifestDigest(job.artifactManifest);
      reasons.add("succeeded_job_manifest");
      const ref = { kind: "succeeded_job_manifest", id: job.id, digest };
      references.set(stableStringify(ref), ref);
    }
  }

  for (const pin of context.checkpointPins) {
    if (!pinMatches(pin, metadata)) continue;
    reasons.add("creator_checkpoint_pin");
    const ref = {
      kind: "creator_checkpoint",
      id: pin.referenceId ?? pin.checkpointId ?? "checkpoint",
      digest: pin.manifestDigest ?? metadata.manifestDigest
    };
    references.set(stableStringify(ref), ref);
  }
  for (const pin of context.releasePins) {
    if (!pinMatches(pin, metadata)) continue;
    reasons.add("release_candidate_pin");
    const ref = {
      kind: "release_candidate",
      id: pin.referenceId ?? pin.releaseId ?? "release",
      digest: pin.manifestDigest ?? metadata.manifestDigest
    };
    references.set(stableStringify(ref), ref);
  }

  const leaseKey = `${metadata.artifactDigest}:${metadata.manifestDigest}`;
  for (const lease of context.pinLeaseIndex.get(leaseKey) ?? []) {
    reasons.add("external_pin_lease");
    const ref = {
      kind: "external_pin_lease",
      id: `${lease.ownerKind}:${lease.ownerId}`,
      digest: lease.canonicalDigest
    };
    references.set(stableStringify(ref), ref);
  }

  const deletionReasons = [...reasons].sort();
  const eligible = deletionReasons.length === 0 &&
    (metadata.retentionClass === "transient" || metadata.retentionClass === "cacheable");
  return {
    metadata: validateArtifactRetentionMetadata({
      ...metadata,
      references: [...references.values()],
      deletionEligibility: {
        eligible,
        reasons: eligible ? [] : deletionReasons,
        evaluatedAtMs: context.nowMs
      }
    }),
    eligible,
    reasons: eligible ? [] : deletionReasons
  };
}

function normalizeContext({
  jobs = [],
  checkpointPins = [],
  releasePins = [],
  pinLeases = [],
  nowMs = Date.now()
} = {}) {
  if (
    !Array.isArray(jobs) ||
    !Array.isArray(checkpointPins) ||
    !Array.isArray(releasePins) ||
    !Array.isArray(pinLeases)
  ) {
    fail("retention_invalid", "jobs/checkpointPins/releasePins/pinLeases must be arrays");
  }
  assertTimestamp(nowMs, "nowMs");

  const activePinLeases = [];
  const pinLeaseIndex = new Map();
  for (const rawLease of pinLeases) {
    const lease = validateArtifactPinLease(rawLease);
    if (!isArtifactPinLeaseActive(lease, { nowMs })) continue;
    activePinLeases.push(lease);
    const key = `${lease.artifactDigest}:${lease.manifestDigest}`;
    const values = pinLeaseIndex.get(key) ?? [];
    values.push(lease);
    pinLeaseIndex.set(key, values);
  }
  for (const values of pinLeaseIndex.values()) {
    values.sort((a, b) =>
      a.ownerKind.localeCompare(b.ownerKind) ||
      a.ownerId.localeCompare(b.ownerId) ||
      a.generation - b.generation
    );
  }

  return {
    jobs,
    checkpointPins,
    releasePins,
    pinLeases: activePinLeases,
    pinLeaseIndex,
    nowMs
  };
}

export function artifactRetentionRecordId({ metadata, storageKey }) {
  assertNonEmpty(storageKey, "storageKey");
  return fingerprint({
    artifactDigest: metadata.artifactDigest,
    logicalJobId: metadata.logicalJobId,
    manifestDigest: metadata.manifestDigest,
    storageKey
  });
}

export function validateInternalRetentionRecord(input) {
  const record = clone(input);
  exactKeys(record, ["recordVersion", "recordId", "storageKey", "metadata", "manifest"], ["deletion"], "retention record");
  if (record.recordVersion !== "media.artifact_retention.record.v1") {
    fail("retention_invalid", "retention record version mismatch");
  }
  assertSha256(record.recordId, "recordId");
  assertNonEmpty(record.storageKey, "storageKey");
  if (isProtectedPath(record.storageKey)) fail("path_protected", "retention storage key references a protected location");
  const metadata = validateArtifactRetentionMetadata(record.metadata);
  const expectedId = artifactRetentionRecordId({ metadata, storageKey: record.storageKey });
  if (record.recordId !== expectedId) fail("retention_invalid", "retention recordId mismatch");

  const manifest = validateArtifactManifest(record.manifest);
  const manifestDigest = artifactManifestDigest(manifest);
  if (manifestDigest !== metadata.manifestDigest) fail("retention_invalid", "retention manifest digest mismatch");
  if (manifest.content.sha256 !== metadata.artifactDigest) fail("retention_invalid", "retention artifact digest mismatch");
  if (manifest.logicalJobId !== metadata.logicalJobId) fail("retention_invalid", "retention logical job mismatch");

  if (record.deletion !== undefined && record.deletion !== null) {
    exactKeys(record.deletion, ["status", "atMs", "planDigest"], [], "retention deletion state");
    assertNonEmpty(record.deletion.status, "deletion.status");
    assertTimestamp(record.deletion.atMs, "deletion.atMs");
    assertSha256(record.deletion.planDigest, "deletion.planDigest");
  }
  return { ...record, metadata, manifest };
}

export function makeInternalRetentionRecordFromJob(job, { storageKey = job?.outputPath, verifiedAtMs = null } = {}) {
  const metadata = buildSucceededJobRetentionMetadata(job, { verifiedAtMs });
  return makeInternalRetentionRecord({
    storageKey,
    metadata,
    manifest: job.artifactManifest
  });
}

export function makeInternalRetentionRecord({
  storageKey,
  metadata,
  manifest,
  deletion = null
} = {}) {
  const normalized = validateArtifactRetentionMetadata(metadata);
  return validateInternalRetentionRecord({
    recordVersion: "media.artifact_retention.record.v1",
    recordId: artifactRetentionRecordId({ metadata: normalized, storageKey }),
    storageKey,
    metadata: normalized,
    manifest,
    deletion
  });
}

export function planArtifactGc({
  records,
  jobs = [],
  checkpointPins = [],
  releasePins = [],
  pinLeases = [],
  nowMs = Date.now()
} = {}) {
  if (!Array.isArray(records)) fail("retention_invalid", "records must be an array");
  const context = normalizeContext({ jobs, checkpointPins, releasePins, pinLeases, nowMs });
  const entries = [];
  let eligibleCount = 0;
  let blockedCount = 0;

  for (const raw of records) {
    const record = validateInternalRetentionRecord(raw);
    const classification = classifyRecord(record, context);
    if (classification.eligible) eligibleCount += 1;
    else blockedCount += 1;
    entries.push({
      recordId: record.recordId,
      artifactDigest: classification.metadata.artifactDigest,
      logicalJobId: classification.metadata.logicalJobId,
      manifestDigest: classification.metadata.manifestDigest,
      retentionClass: classification.metadata.retentionClass,
      eligible: classification.eligible,
      reasons: classification.reasons,
      references: classification.metadata.references,
      retentionMetadata: classification.metadata
    });
  }
  entries.sort((a, b) => a.recordId.localeCompare(b.recordId));

  const core = {
    contractVersion: MEDIA_ARTIFACT_GC_PLAN_VERSION,
    dryRun: true,
    plannedAtMs: nowMs,
    entries,
    summary: {
      records: records.length,
      eligible: eligibleCount,
      blocked: blockedCount,
      workUnits: records.length + jobs.length + checkpointPins.length + releasePins.length + pinLeases.length
    }
  };
  return {
    ...core,
    planDigest: fingerprint(core)
  };
}

export function validateArtifactGcPlan(input) {
  const plan = clone(input);
  exactKeys(plan, ["contractVersion", "dryRun", "plannedAtMs", "entries", "summary", "planDigest"], [], "GC plan");
  if (plan.contractVersion !== MEDIA_ARTIFACT_GC_PLAN_VERSION || plan.dryRun !== true) {
    fail("gc_plan_invalid", "GC plan contract/version/dryRun mismatch");
  }
  assertTimestamp(plan.plannedAtMs, "plannedAtMs");
  assertSha256(plan.planDigest, "planDigest");
  const digest = fingerprint({
    contractVersion: plan.contractVersion,
    dryRun: plan.dryRun,
    plannedAtMs: plan.plannedAtMs,
    entries: plan.entries,
    summary: plan.summary
  });
  if (digest !== plan.planDigest) fail("gc_plan_invalid", "GC plan digest mismatch");
  return plan;
}

function emptyRetentionState() {
  return {
    version: RETENTION_STORE_VERSION,
    records: {},
    gcEvents: []
  };
}

function sanitizeRetentionState(raw) {
  if (!isPlainObject(raw) || raw.version !== RETENTION_STORE_VERSION || !isPlainObject(raw.records)) {
    fail("retention_state_corrupt", "artifact retention store root is invalid");
  }
  const state = emptyRetentionState();
  for (const [id, record] of Object.entries(raw.records)) {
    const validated = validateInternalRetentionRecord(record);
    if (id !== validated.recordId) fail("retention_state_corrupt", "artifact retention record key mismatch");
    state.records[id] = validated;
  }
  if (!Array.isArray(raw.gcEvents)) fail("retention_state_corrupt", "gcEvents must be an array");
  state.gcEvents = clone(raw.gcEvents);
  return state;
}

export class PersistentArtifactRetentionStore {
  constructor({ filePath } = {}) {
    if (!filePath) throw new TypeError("filePath is required");
    this.filePath = path.resolve(filePath);
    this.tmpPath = `${this.filePath}.tmp`;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.state = this.#load();
  }

  #load() {
    if (!existsSync(this.filePath)) {
      const state = emptyRetentionState();
      this.#persist(state);
      return state;
    }
    try {
      return sanitizeRetentionState(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error?.code === "retention_state_corrupt") throw error;
      fail("retention_state_corrupt", "artifact retention store is corrupt; refusing implicit reset", {
        cause: error?.message ?? String(error)
      });
    }
  }

  #persist(state = this.state) {
    writeFileSync(this.tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(this.tmpPath, this.filePath);
  }

  refresh() {
    this.state = this.#load();
    return this;
  }

  put(record) {
    const validated = validateInternalRetentionRecord(record);
    this.state.records[validated.recordId] = validated;
    this.#persist();
    return clone(validated);
  }

  get(recordId) {
    const value = this.state.records[recordId];
    return value ? clone(value) : null;
  }

  list() {
    return Object.values(this.state.records).map(clone);
  }

  recordGcEvent(event) {
    this.state.gcEvents.push(clone(event));
    this.#persist();
    return clone(event);
  }

  markDeletion(recordId, deletion) {
    const record = this.state.records[recordId];
    if (!record) fail("retention_not_found", `unknown retention record: ${recordId}`);
    record.deletion = clone(deletion);
    this.#persist();
    return clone(record);
  }

  gcEvents() {
    return clone(this.state.gcEvents);
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFileIdentity(a, b) {
  return a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs;
}

export class ArtifactGcExecutor {
  constructor({
    store,
    sandboxRoot,
    referenceProvider = () => ({ jobs: [], checkpointPins: [], releasePins: [], pinLeases: [] }),
    pinLeaseStore = null,
    clock = () => Date.now()
  } = {}) {
    if (!store) throw new TypeError("store is required");
    if (!sandboxRoot) throw new TypeError("sandboxRoot is required");
    if (typeof referenceProvider !== "function") throw new TypeError("referenceProvider must be a function");
    if (pinLeaseStore !== null && typeof pinLeaseStore.listActive !== "function") {
      throw new TypeError("pinLeaseStore.listActive is required");
    }
    this.store = store;
    this.sandboxRoot = path.resolve(sandboxRoot);
    this.referenceProvider = referenceProvider;
    this.pinLeaseStore = pinLeaseStore;
    this.clock = clock;
  }

  #safePath(record) {
    if (isProtectedPath(record.storageKey)) fail("path_protected", "GC storage key references a protected path");
    const resolved = resolveSandboxedPath(record.storageKey, {
      sandboxRoot: this.sandboxRoot,
      allowRemoteUri: false
    }).value;
    const rootReal = realpathSync(this.sandboxRoot);
    if (!existsSync(resolved)) return { resolved, missing: true };
    const parentReal = realpathSync(path.dirname(resolved));
    if (!isInside(rootReal, parentReal)) {
      fail("path_outside_sandbox", "GC artifact parent resolves outside sandbox");
    }
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) fail("path_symlink_rejected", "GC refuses symbolic-link/reparse-like artifact paths");
    const targetReal = realpathSync(resolved);
    if (!isInside(rootReal, targetReal)) fail("path_outside_sandbox", "GC artifact resolves outside sandbox");
    return { resolved, missing: false, stat };
  }

  #currentContext() {
    const nowMs = this.clock();
    const value = this.referenceProvider() ?? {};
    const storeLeases = this.pinLeaseStore
      ? this.pinLeaseStore.listActive({ nowMs })
      : [];
    return normalizeContext({
      jobs: value.jobs ?? [],
      checkpointPins: value.checkpointPins ?? [],
      releasePins: value.releasePins ?? [],
      pinLeases: [...(value.pinLeases ?? []), ...storeLeases],
      nowMs
    });
  }

  #outcome(plan, entry, status, details = {}) {
    const value = {
      recordId: entry.recordId,
      artifactDigest: entry.artifactDigest,
      status,
      atMs: this.clock(),
      ...details
    };
    this.store.recordGcEvent({
      planDigest: plan.planDigest,
      ...value
    });
    return value;
  }

  execute(inputPlan, { dryRun = true } = {}) {
    const plan = validateArtifactGcPlan(inputPlan);
    if (typeof dryRun !== "boolean") throw new TypeError("dryRun must be boolean");
    const outcomes = [];

    try {
      this.store.refresh();
    } catch (error) {
      return {
        contractVersion: MEDIA_ARTIFACT_GC_EXECUTION_VERSION,
        planDigest: plan.planDigest,
        dryRun,
        status: "failed_closed",
        outcomes: [],
        error: {
          code: error?.code ?? "retention_state_corrupt",
          message: error?.message ?? String(error)
        }
      };
    }

    for (const entry of plan.entries.filter((value) => value.eligible)) {
      try {
        this.store.refresh();
        const record = this.store.get(entry.recordId);
        if (!record) {
          outcomes.push(this.#outcome(plan, entry, "stale_record_missing"));
          continue;
        }

        if (
          record.metadata.manifestDigest !== entry.manifestDigest ||
          record.metadata.artifactDigest !== entry.artifactDigest ||
          record.metadata.logicalJobId !== entry.logicalJobId
        ) {
          outcomes.push(this.#outcome(plan, entry, "stale_plan_rejected", {
            reason: "record_identity_changed"
          }));
          continue;
        }

        const manifest = validateArtifactManifest(record.manifest);
        const currentManifestDigest = artifactManifestDigest(manifest);
        if (
          currentManifestDigest !== entry.manifestDigest ||
          manifest.content.sha256 !== entry.artifactDigest
        ) {
          outcomes.push(this.#outcome(plan, entry, "stale_plan_rejected", {
            reason: "manifest_digest_changed"
          }));
          continue;
        }

        const context = this.#currentContext();
        const fresh = planArtifactGc({
          records: [record],
          jobs: context.jobs,
          checkpointPins: context.checkpointPins,
          releasePins: context.releasePins,
          pinLeases: context.pinLeases,
          nowMs: context.nowMs
        });
        if (!fresh.entries[0].eligible) {
          outcomes.push(this.#outcome(plan, entry, "stale_plan_rejected", {
            reason: fresh.entries[0].reasons.join(",")
          }));
          continue;
        }

        const safe = this.#safePath(record);
        if (safe.missing) {
          outcomes.push(this.#outcome(plan, entry, "already_missing"));
          continue;
        }

        const digest = outputDigestSync(safe.resolved);
        if (
          digest.sha256 !== entry.artifactDigest ||
          digest.sha256 !== manifest.content.sha256 ||
          digest.size !== manifest.content.size
        ) {
          outcomes.push(this.#outcome(plan, entry, "integrity_failure", {
            reason: "artifact_bytes_changed"
          }));
          continue;
        }

        const beforeMutation = lstatSync(safe.resolved);
        if (beforeMutation.isSymbolicLink() || !sameFileIdentity(safe.stat, beforeMutation)) {
          outcomes.push(this.#outcome(plan, entry, "stale_plan_rejected", {
            reason: "file_identity_changed"
          }));
          continue;
        }

        if (dryRun) {
          outcomes.push(this.#outcome(plan, entry, "would_delete"));
          continue;
        }

        unlinkSync(safe.resolved);
        const deletion = {
          status: "deleted",
          atMs: this.clock(),
          planDigest: plan.planDigest
        };
        this.store.markDeletion(entry.recordId, deletion);
        outcomes.push(this.#outcome(plan, entry, "deleted"));
      } catch (error) {
        outcomes.push(this.#outcome(plan, entry, "failed", {
          error: {
            code: error?.code ?? "gc_delete_failed",
            message: error?.message ?? String(error)
          }
        }));
      }
    }

    const counts = {};
    for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
    return {
      contractVersion: MEDIA_ARTIFACT_GC_EXECUTION_VERSION,
      planDigest: plan.planDigest,
      dryRun,
      status: outcomes.some((item) =>
        ["failed", "integrity_failure", "stale_plan_rejected"].includes(item.status)
      ) ? "partial_failure" : "completed",
      outcomes,
      summary: {
        plannedEligible: plan.summary.eligible,
        attempted: outcomes.length,
        counts
      }
    };
  }
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}
