import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync
} from "node:fs";
import path from "node:path";

import { fingerprint, stableStringify } from "../stable.js";
import { runtimeError } from "./errors.js";

export const MEDIA_ARTIFACT_PIN_LEASE_VERSION = "media.artifact_pin_lease.v1";
const PIN_LEASE_STORE_VERSION = 1;
export const MEDIA_ARTIFACT_PIN_REQUEST_VERSION = "media.artifact_pin_request.v1";
export const MEDIA_ARTIFACT_GC_APPROVAL_VERSION = "media.artifact_gc_approval.v1";

export function artifactPinScope(artifactDigest, manifestDigest) {
  sha256(artifactDigest, "artifactDigest");
  sha256(manifestDigest, "manifestDigest");
  return `${artifactDigest}:${manifestDigest}`;
}

function validateBinding(binding) {
  exactKeys(binding, [
    "creatorJobId", "logicalMediaJobId", "checkpointId", "releaseCandidateId",
    "artifactDigest", "manifestDigest"
  ], [], "Creator binding");
  for (const name of ["creatorJobId", "logicalMediaJobId"]) {
    nonEmpty(binding[name], name);
    assertPathFree(binding[name], name);
  }
  for (const name of ["checkpointId", "releaseCandidateId"]) {
    if (binding[name] !== null) {
      nonEmpty(binding[name], name);
      assertPathFree(binding[name], name);
    }
  }
  artifactPinScope(binding.artifactDigest, binding.manifestDigest);
  return clone(binding);
}

function validateRequestId(value) {
  nonEmpty(value, "requestId");
  if (value.length > 160) fail("pin_lease_invalid", "requestId is too long");
  assertPathFree(value, "requestId");
}


export function validateCreatorArtifactPinRequest(input) {
  exactKeys(input, [
    "contractVersion", "requestId", "action", "args", "binding", "expectedOwnerEpoch"
  ], [], "Creator pin request");
  if (input.contractVersion !== MEDIA_ARTIFACT_PIN_REQUEST_VERSION) {
    fail("pin_lease_invalid", "Creator pin request version mismatch");
  }
  validateRequestId(input.requestId);
  if (!["acquire", "renew", "release"].includes(input.action)) {
    fail("pin_lease_invalid", "Creator pin action invalid");
  }
  validateBinding(input.binding);
  if (!isPlainObject(input.args)) fail("pin_lease_invalid", "Creator pin args must be object");
  if (input.action === "acquire" &&
      (!Number.isInteger(input.expectedOwnerEpoch) || input.expectedOwnerEpoch < 0)) {
    fail("pin_lease_invalid", "expectedOwnerEpoch must be nonnegative on acquire");
  }
  if (input.action !== "acquire" && input.expectedOwnerEpoch !== null) {
    fail("pin_lease_invalid", "expectedOwnerEpoch must be null on renew/release");
  }
  const payload = clone(input);
  if (/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i.test(stableStringify(payload))) {
    fail("pin_lease_invalid", "Creator pin request cannot expose filesystem paths");
  }
  return payload;
}

function validateApproval(value, { artifactDigest, manifestDigest, planDigest, epoch, nowMs }) {
  exactKeys(value, [
    "contractVersion", "approvalId", "approvedBy", "artifactDigest",
    "manifestDigest", "planDigest", "expectedEpoch", "approvedAtMs",
    "expiresAtMs", "canonicalDigest"
  ], [], "GC approval");
  if (value.contractVersion !== MEDIA_ARTIFACT_GC_APPROVAL_VERSION) {
    fail("gc_approval_invalid", "GC approval version mismatch");
  }
  nonEmpty(value.approvalId, "approvalId");
  nonEmpty(value.approvedBy, "approvedBy");
  assertPathFree(value.approvalId, "approvalId");
  assertPathFree(value.approvedBy, "approvedBy");
  for (const name of ["artifactDigest", "manifestDigest", "planDigest", "canonicalDigest"]) sha256(value[name], name);
  if (!Number.isInteger(value.expectedEpoch) || value.expectedEpoch < 0) {
    fail("gc_approval_invalid", "invalid expectedEpoch");
  }
  timestamp(value.approvedAtMs, "approvedAtMs");
  timestamp(value.expiresAtMs, "expiresAtMs");
  const { canonicalDigest, ...core } = value;
  if (fingerprint(core) !== canonicalDigest) fail("gc_approval_invalid", "GC approval digest mismatch");
  if (
    value.artifactDigest !== artifactDigest ||
    value.manifestDigest !== manifestDigest ||
    value.planDigest !== planDigest ||
    value.expectedEpoch !== epoch ||
    value.approvedAtMs > nowMs ||
    nowMs >= value.expiresAtMs
  ) fail("gc_approval_stale", "GC approval does not bind the current artifact/manifest/plan/epoch/clock");
  return clone(value);
}

export function createScopedGcApproval({
  approvalId, approvedBy, artifactDigest, manifestDigest, planDigest,
  expectedEpoch, approvedAtMs, expiresAtMs
} = {}) {
  const core = {
    contractVersion: MEDIA_ARTIFACT_GC_APPROVAL_VERSION,
    approvalId, approvedBy, artifactDigest, manifestDigest, planDigest,
    expectedEpoch, approvedAtMs, expiresAtMs
  };
  return { ...core, canonicalDigest: fingerprint(core) };
}


function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional, label) {
  if (!isPlainObject(value)) fail("pin_lease_invalid", `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length) fail("pin_lease_invalid", `${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail("pin_lease_invalid", `${label} unknown fields: ${extra.sort().join(", ")}`);
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("pin_lease_invalid", `${label} must be a lowercase SHA-256 hex string`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail("pin_lease_invalid", `${label} must be a non-empty string`);
  }
}

function timestamp(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    fail("pin_lease_invalid", `${label} must be a non-negative finite timestamp`);
  }
}

function generation(value, label = "generation") {
  if (!Number.isInteger(value) || value < 1) {
    fail("pin_lease_invalid", `${label} must be a positive integer`);
  }
}

function assertPathFree(value, label) {
  if (/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i.test(String(value))) {
    fail("pin_lease_invalid", `${label} must not contain filesystem paths`);
  }
}

export function artifactPinOwnerKey(ownerKind, ownerId) {
  nonEmpty(ownerKind, "ownerKind");
  nonEmpty(ownerId, "ownerId");
  assertPathFree(ownerKind, "ownerKind");
  assertPathFree(ownerId, "ownerId");
  return fingerprint({ ownerKind, ownerId });
}

function leaseCore(input) {
  return {
    contractVersion: MEDIA_ARTIFACT_PIN_LEASE_VERSION,
    artifactDigest: input.artifactDigest,
    manifestDigest: input.manifestDigest,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    pinReason: input.pinReason,
    createdAtMs: input.createdAtMs,
    renewedAtMs: input.renewedAtMs,
    expiresAtMs: input.expiresAtMs,
    generation: input.generation
  };
}

export function artifactPinLeaseDigest(input) {
  return fingerprint(leaseCore(input));
}

export function validateArtifactPinLease(input) {
  const value = clone(input);
  exactKeys(value, [
    "contractVersion",
    "artifactDigest",
    "manifestDigest",
    "ownerKind",
    "ownerId",
    "pinReason",
    "createdAtMs",
    "renewedAtMs",
    "expiresAtMs",
    "generation",
    "canonicalDigest"
  ], [], "artifact pin lease");

  if (value.contractVersion !== MEDIA_ARTIFACT_PIN_LEASE_VERSION) {
    fail("pin_lease_invalid", "pin lease contractVersion mismatch");
  }
  sha256(value.artifactDigest, "artifactDigest");
  sha256(value.manifestDigest, "manifestDigest");
  nonEmpty(value.ownerKind, "ownerKind");
  nonEmpty(value.ownerId, "ownerId");
  nonEmpty(value.pinReason, "pinReason");
  assertPathFree(value.ownerKind, "ownerKind");
  assertPathFree(value.ownerId, "ownerId");
  assertPathFree(value.pinReason, "pinReason");
  timestamp(value.createdAtMs, "createdAtMs");
  timestamp(value.renewedAtMs, "renewedAtMs");
  if (value.renewedAtMs < value.createdAtMs) {
    fail("pin_lease_invalid", "renewedAtMs cannot precede createdAtMs");
  }
  if (value.expiresAtMs !== null) {
    timestamp(value.expiresAtMs, "expiresAtMs");
    if (value.expiresAtMs <= value.renewedAtMs) {
      fail("pin_lease_invalid", "expiresAtMs must be later than renewedAtMs");
    }
  }
  generation(value.generation);
  sha256(value.canonicalDigest, "canonicalDigest");
  const expected = artifactPinLeaseDigest(value);
  if (value.canonicalDigest !== expected) {
    fail("pin_lease_invalid", "canonicalDigest mismatch");
  }
  const serialized = stableStringify(value);
  if (/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i.test(serialized)) {
    fail("pin_lease_invalid", "pin lease must not expose filesystem paths");
  }
  return value;
}

export function createArtifactPinLease({
  artifactDigest,
  manifestDigest,
  ownerKind,
  ownerId,
  pinReason,
  createdAtMs,
  renewedAtMs = createdAtMs,
  expiresAtMs = null,
  generation: leaseGeneration = 1
} = {}) {
  const core = leaseCore({
    artifactDigest,
    manifestDigest,
    ownerKind,
    ownerId,
    pinReason,
    createdAtMs,
    renewedAtMs,
    expiresAtMs,
    generation: leaseGeneration
  });
  return validateArtifactPinLease({
    ...core,
    canonicalDigest: fingerprint(core)
  });
}

export function isArtifactPinLeaseActive(input, { nowMs = Date.now() } = {}) {
  const lease = validateArtifactPinLease(input);
  timestamp(nowMs, "nowMs");
  return lease.expiresAtMs === null || nowMs < lease.expiresAtMs;
}

function sameAcquireIdentity(existing, input) {
  return existing.artifactDigest === input.artifactDigest &&
    existing.manifestDigest === input.manifestDigest &&
    existing.ownerKind === input.ownerKind &&
    existing.ownerId === input.ownerId &&
    existing.pinReason === input.pinReason &&
    existing.expiresAtMs === (input.expiresAtMs ?? null);
}

function emptyState() {
  return {
    version: PIN_LEASE_STORE_VERSION,
    leases: {},
    generations: {},
    events: [],
    requestJournal: {},
    mutationEpochs: {},
    cleanupJournal: {},
    ownerBindings: {}
  };
}

function validateEvent(event) {
  if (!isPlainObject(event) || typeof event.type !== "string" || !Number.isFinite(event.atMs)) {
    fail("pin_lease_state_corrupt", "pin lease event is invalid");
  }
  return clone(event);
}

function sanitizeState(raw) {
  if (
    !isPlainObject(raw) ||
    raw.version !== PIN_LEASE_STORE_VERSION ||
    !isPlainObject(raw.leases) ||
    !isPlainObject(raw.generations) ||
    !Array.isArray(raw.events) ||
    (raw.requestJournal !== undefined && !isPlainObject(raw.requestJournal)) ||
    (raw.mutationEpochs !== undefined && !isPlainObject(raw.mutationEpochs)) ||
    (raw.cleanupJournal !== undefined && !isPlainObject(raw.cleanupJournal)) ||
    (raw.ownerBindings !== undefined && !isPlainObject(raw.ownerBindings))
  ) {
    fail("pin_lease_state_corrupt", "pin lease store root is invalid");
  }
  const state = emptyState();
  for (const [key, rawLease] of Object.entries(raw.leases)) {
    const lease = validateArtifactPinLease(rawLease);
    const expectedKey = artifactPinOwnerKey(lease.ownerKind, lease.ownerId);
    if (key !== expectedKey) fail("pin_lease_state_corrupt", "pin lease owner key mismatch");
    state.leases[key] = lease;
  }
  for (const [key, value] of Object.entries(raw.generations)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isInteger(value) || value < 0) {
      fail("pin_lease_state_corrupt", "pin lease generation table is invalid");
    }
    state.generations[key] = value;
    if (state.leases[key] && value < state.leases[key].generation) {
      fail("pin_lease_state_corrupt", "pin lease generation regressed behind active lease");
    }
  }
  state.events = raw.events.map(validateEvent);
  for (const [requestId, entry] of Object.entries(raw.requestJournal ?? {})) {
    validateRequestId(requestId);
    if (!isPlainObject(entry) || !["prepared", "committed", "rejected", "aborted"].includes(entry.status)) {
      fail("pin_lease_state_corrupt", "request journal entry invalid");
    }
    sha256(entry.requestDigest, "requestDigest");
    sha256(entry.ownerKey, "ownerKey");
    sha256(entry.bindingDigest, "bindingDigest");
    const binding = validateBinding(entry.binding);
    if (fingerprint(binding) !== entry.bindingDigest ||
        binding.artifactDigest !== entry.artifactDigest ||
        binding.manifestDigest !== entry.manifestDigest) {
      fail("pin_lease_state_corrupt", "prepared Creator binding mismatch");
    }
    // R9 journals without these companion provenance fields remain readable.
    // R10 journals bind owner identity and exact mutation args durably.
    if (entry.ownerKind !== undefined || entry.ownerId !== undefined) {
      if (!["creator_checkpoint", "creator_job", "release_candidate"].includes(entry.ownerKind) ||
          typeof entry.ownerId !== "string" ||
          artifactPinOwnerKey(entry.ownerKind, entry.ownerId) !== entry.ownerKey) {
        fail("pin_lease_state_corrupt", "journaled owner identity mismatch");
      }
      const expectedId =
        entry.ownerKind === "creator_checkpoint" ? binding.checkpointId :
        entry.ownerKind === "release_candidate" ? binding.releaseCandidateId :
        binding.creatorJobId;
      if (expectedId !== entry.ownerId) {
        fail("pin_lease_state_corrupt", "journaled owner differs from Creator binding");
      }
      sha256(entry.argsDigest, "request argsDigest");
    }
    artifactPinScope(entry.artifactDigest, entry.manifestDigest);
    state.requestJournal[requestId] = clone(entry);
  }
  for (const [scope, epoch] of Object.entries(raw.mutationEpochs ?? {})) {
    if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(scope) || !Number.isInteger(epoch) || epoch < 0) {
      fail("pin_lease_state_corrupt", "mutation epoch invalid");
    }
    state.mutationEpochs[scope] = epoch;
  }
  for (const [key, entry] of Object.entries(raw.cleanupJournal ?? {})) {
    validateRequestId(key);
    if (!isPlainObject(entry) || !["prepared", "committed", "outcome_unknown", "aborted"].includes(entry.status)) {
      fail("pin_lease_state_corrupt", "cleanup journal entry invalid");
    }
    artifactPinScope(entry.artifactDigest, entry.manifestDigest);
    state.cleanupJournal[key] = clone(entry);
  }
  for (const [key, entry] of Object.entries(raw.ownerBindings ?? {})) {
    if (!/^[a-f0-9]{64}$/.test(key) || !isPlainObject(entry)) {
      fail("pin_lease_state_corrupt", "owner binding invalid");
    }
    const binding = validateBinding(entry.binding);
    sha256(entry.bindingDigest, "owner binding digest");
    if (fingerprint(binding) !== entry.bindingDigest) {
      fail("pin_lease_state_corrupt", "owner binding hash mismatch");
    }
    state.ownerBindings[key] = clone(entry);
  }
  return state;
}

export class PersistentArtifactPinLeaseStore {
  #barrierDepth = 0;
  #journalRequestId = null;

  constructor({ filePath, clock = () => Date.now() } = {}) {
    if (!filePath) throw new TypeError("filePath is required");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.filePath = path.resolve(filePath);
    this.tmpPath = `${this.filePath}.tmp`;
    this.coordinationPath = `${this.filePath}.pin-gc-barrier`;
    this.clock = clock;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.state = this.#load();
  }

  #load() {
    if (!existsSync(this.filePath)) {
      if (this.#barrierDepth > 0 || existsSync(this.tmpPath)) {
        fail("pin_lease_state_corrupt", "primary pin journal missing or ambiguous temporary snapshot; refusing implicit reset");
      }
      try {
        mkdirSync(this.coordinationPath, { mode: 0o700 });
      } catch (error) {
        if (error?.code === "EEXIST") {
          fail("pin_gc_coordination_unknown", "initialization conflicts with an active/unknown pin-GC writer");
        }
        throw error;
      }
      try {
        if (existsSync(this.filePath)) return this.#load();
        if (existsSync(this.tmpPath)) {
          fail("pin_lease_state_corrupt", "missing primary with abandoned temporary snapshot");
        }
        const state = emptyState();
        this.#persist(state);
        return state;
      } finally {
        rmSync(this.coordinationPath, { recursive: true, force: true });
      }
    }
    try {
      return sanitizeState(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error?.code === "pin_lease_state_corrupt") throw error;
      fail("pin_lease_state_corrupt", "artifact pin lease store is corrupt; refusing implicit reset", {
        cause: error?.message ?? String(error)
      });
    }
  }

  #persist(state = this.state) {
    const data = `${JSON.stringify(state, null, 2)}\n`;
    const fd = openSync(this.tmpPath, "w", 0o600);
    try {
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.tmpPath, this.filePath);
    // The directory fsync ensures rename provenance survives an ordinary
    // POSIX process/host crash. Windows does not generally allow directory fd.
    if (process.platform !== "win32") {
      const dirFd = openSync(path.dirname(this.filePath), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    }
  }

  #refresh() {
    this.state = this.#load();
  }

  withCoordination(callback) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    if (this.#barrierDepth > 0) {
      fail("pin_gc_coordination_busy", "nested mutator is forbidden inside the exclusive GC/lease barrier");
    }
    try {
      mkdirSync(this.coordinationPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail("pin_gc_coordination_unknown", "pin/GC coordination is busy or an earlier process crashed; never auto-steal lock");
      }
      throw error;
    }
    this.#barrierDepth = 1;
    try {
      const result = callback();
      if (result && typeof result.then === "function") {
        fail("pin_gc_invalid", "coordination callback must be synchronous");
      }
      return result;
    } finally {
      this.#barrierDepth = 0;
      rmSync(this.coordinationPath, { recursive: true, force: true });
    }
  }

  #assertOwnerSettled(ownerKind, ownerId) {
    const ownerKey = artifactPinOwnerKey(ownerKind, ownerId);
    if (Object.entries(this.state.requestJournal).some(([requestId, row]) =>
      row.status === "prepared" && row.ownerKey === ownerKey && requestId !== this.#journalRequestId
    )) {
      fail("pin_outcome_unknown", "owner has an unresolved request; no blind replay or replacement");
    }
  }

  #bumpEpoch(lease) {
    const scope = artifactPinScope(lease.artifactDigest, lease.manifestDigest);
    this.state.mutationEpochs[scope] = (this.state.mutationEpochs[scope] ?? 0) + 1;
  }

  #record(type, lease, atMs, extra = {}) {
    this.state.events.push({
      type,
      ownerKind: lease.ownerKind,
      ownerId: lease.ownerId,
      artifactDigest: lease.artifactDigest,
      manifestDigest: lease.manifestDigest,
      generation: lease.generation,
      canonicalDigest: lease.canonicalDigest,
      atMs,
      ...(this.#journalRequestId ? { requestId: this.#journalRequestId } : {}),
      ...extra
    });
  }

  acquire(input = {}) {
    return this.withCoordination(() => this.#acquireUnsafe(input));
  }

  #acquireUnsafe({
    artifactDigest,
    manifestDigest,
    ownerKind,
    ownerId,
    pinReason,
    expiresAtMs = null
  } = {}) {
    const nowMs = this.clock();
    timestamp(nowMs, "clock");
    sha256(artifactDigest, "artifactDigest");
    sha256(manifestDigest, "manifestDigest");
    nonEmpty(ownerKind, "ownerKind");
    nonEmpty(ownerId, "ownerId");
    nonEmpty(pinReason, "pinReason");
    assertPathFree(ownerKind, "ownerKind");
    assertPathFree(ownerId, "ownerId");
    assertPathFree(pinReason, "pinReason");
    if (expiresAtMs !== null) {
      timestamp(expiresAtMs, "expiresAtMs");
      if (expiresAtMs <= nowMs) fail("pin_lease_invalid", "new lease expiry must be in the future");
    }

    this.#refresh();
    this.#assertOwnerSettled(ownerKind, ownerId);
    const scope = artifactPinScope(artifactDigest, manifestDigest);
    if (Object.values(this.state.cleanupJournal).some((row) =>
      ["prepared", "outcome_unknown"].includes(row.status) &&
      artifactPinScope(row.artifactDigest, row.manifestDigest) === scope
    )) fail("pin_outcome_unknown", "cleanup outcome is unresolved; cannot acquire against uncertain artifact");
    const key = artifactPinOwnerKey(ownerKind, ownerId);
    const existing = this.state.leases[key] ?? null;
    if (existing && isArtifactPinLeaseActive(existing, { nowMs })) {
      if (!sameAcquireIdentity(existing, {
        artifactDigest,
        manifestDigest,
        ownerKind,
        ownerId,
        pinReason,
        expiresAtMs
      })) {
        fail("pin_lease_conflict", "active owner lease is bound to different artifact/manifest/reason/expiry");
      }
      return { lease: clone(existing), duplicate: true };
    }

    const previousGeneration = Math.max(
      this.state.generations[key] ?? 0,
      existing?.generation ?? 0
    );
    const lease = createArtifactPinLease({
      artifactDigest,
      manifestDigest,
      ownerKind,
      ownerId,
      pinReason,
      createdAtMs: nowMs,
      renewedAtMs: nowMs,
      expiresAtMs,
      generation: previousGeneration + 1
    });
    this.state.leases[key] = lease;
    this.state.generations[key] = lease.generation;
    this.#bumpEpoch(lease);
    this.#record(existing ? "reacquire" : "acquire", lease, nowMs);
    this.#persist();
    return { lease: clone(lease), duplicate: false };
  }

  renew(input = {}) {
    return this.withCoordination(() => this.#renewUnsafe(input));
  }

  #renewUnsafe({
    ownerKind,
    ownerId,
    expectedGeneration,
    expiresAtMs
  } = {}) {
    const nowMs = this.clock();
    timestamp(nowMs, "clock");
    generation(expectedGeneration, "expectedGeneration");
    this.#refresh();
    this.#assertOwnerSettled(ownerKind, ownerId);
    const key = artifactPinOwnerKey(ownerKind, ownerId);
    const existing = this.state.leases[key];
    if (!existing) fail("pin_lease_not_found", "pin lease does not exist");
    if (!isArtifactPinLeaseActive(existing, { nowMs })) {
      fail("pin_lease_expired", "expired pin lease must be reacquired");
    }
    if (existing.generation !== expectedGeneration) {
      fail("pin_lease_generation_conflict", "pin lease generation compare-and-set failed");
    }

    const nextExpiry = expiresAtMs === undefined ? existing.expiresAtMs : expiresAtMs;
    if (nextExpiry !== null) {
      timestamp(nextExpiry, "expiresAtMs");
      if (nextExpiry <= nowMs) fail("pin_lease_invalid", "renewed expiry must be in the future");
    }
    const lease = createArtifactPinLease({
      artifactDigest: existing.artifactDigest,
      manifestDigest: existing.manifestDigest,
      ownerKind: existing.ownerKind,
      ownerId: existing.ownerId,
      pinReason: existing.pinReason,
      createdAtMs: existing.createdAtMs,
      renewedAtMs: nowMs,
      expiresAtMs: nextExpiry,
      generation: existing.generation + 1
    });
    this.state.leases[key] = lease;
    this.state.generations[key] = lease.generation;
    this.#bumpEpoch(lease);
    this.#record("renew", lease, nowMs, { previousGeneration: existing.generation });
    this.#persist();
    return clone(lease);
  }

  release(input = {}) {
    return this.withCoordination(() => this.#releaseUnsafe(input));
  }

  #releaseUnsafe({ ownerKind, ownerId, expectedGeneration } = {}) {
    const nowMs = this.clock();
    timestamp(nowMs, "clock");
    generation(expectedGeneration, "expectedGeneration");
    this.#refresh();
    this.#assertOwnerSettled(ownerKind, ownerId);
    const key = artifactPinOwnerKey(ownerKind, ownerId);
    const existing = this.state.leases[key];
    if (!existing) fail("pin_lease_not_found", "pin lease does not exist");
    if (existing.generation !== expectedGeneration) {
      fail("pin_lease_generation_conflict", "pin lease generation compare-and-set failed");
    }
    delete this.state.leases[key];
    this.state.generations[key] = existing.generation;
    this.#bumpEpoch(existing);
    this.#record("release", existing, nowMs);
    this.#persist();
    return {
      released: true,
      ownerKind: existing.ownerKind,
      ownerId: existing.ownerId,
      generation: existing.generation,
      canonicalDigest: existing.canonicalDigest,
      releasedAtMs: nowMs
    };
  }

  inspect({ ownerKind, ownerId, nowMs = this.clock() } = {}) {
    timestamp(nowMs, "nowMs");
    this.#refresh();
    const key = artifactPinOwnerKey(ownerKind, ownerId);
    const lease = this.state.leases[key] ?? null;
    return {
      lease: lease ? clone(lease) : null,
      active: lease ? isArtifactPinLeaseActive(lease, { nowMs }) : false,
      expired: lease ? !isArtifactPinLeaseActive(lease, { nowMs }) : false,
      inspectedAtMs: nowMs
    };
  }

  listActive({ nowMs = this.clock() } = {}) {
    timestamp(nowMs, "nowMs");
    if (this.#barrierDepth === 0 && existsSync(this.coordinationPath)) {
      fail("pin_gc_coordination_unknown", "pin/GC coordination has unknown outcome");
    }
    this.#refresh();
    return Object.values(this.state.leases)
      .filter((lease) => isArtifactPinLeaseActive(lease, { nowMs }))
      .sort((a, b) =>
        a.ownerKind.localeCompare(b.ownerKind) ||
        a.ownerId.localeCompare(b.ownerId) ||
        a.generation - b.generation
      )
      .map(clone);
  }


  /**
   * The conservative read side: a missing acknowledgement or prepared cleanup blocks GC
   * independently of lease expiry. This must run under the pin/GC coordination barrier
   * for a live delete, and rejects an orphaned lock when called outside it.
   */
  snapshotForGc({ nowMs = this.clock() } = {}) {
    const leases = this.listActive({ nowMs });
    const unresolved = [];
    for (const [requestId, row] of Object.entries(this.state.requestJournal)) {
      if (row.status === "prepared") {
        unresolved.push({
          requestId,
          artifactDigest: row.artifactDigest,
          manifestDigest: row.manifestDigest,
          reason: "pin_outcome_unknown"
        });
      }
    }
    for (const [requestId, row] of Object.entries(this.state.cleanupJournal)) {
      if (["prepared", "outcome_unknown"].includes(row.status)) {
        unresolved.push({
          requestId,
          artifactDigest: row.artifactDigest,
          manifestDigest: row.manifestDigest,
          reason: "cleanup_outcome_unknown"
        });
      }
    }
    return {
      pinLeases: leases,
      unknownScopes: unresolved,
      mutationEpochs: clone(this.state.mutationEpochs),
      nowMs
    };
  }

  epochFor(artifactDigest, manifestDigest) {
    if (this.#barrierDepth === 0 && existsSync(this.coordinationPath)) {
      fail("pin_gc_coordination_unknown", "cannot inspect epoch during unknown coordination");
    }
    this.#refresh();
    return this.state.mutationEpochs[artifactPinScope(artifactDigest, manifestDigest)] ?? 0;
  }

  /**
   * Request-ID journal: prepared is persisted BEFORE the lease side effect; both the
   * lease and event carrying requestId are persisted together. If the ack is lost,
   * committed replays return the same response; prepared never blindly replays.
   *
   * Creator binding is a companion request (NOT a change to frozen pin lease v1).
   */
  journaledLeaseOperation({
    requestId,
    action,
    args,
    binding,
    expectedOwnerEpoch = null,
    verifyArtifact = null,
    fault = null
  } = {}) {
    validateRequestId(requestId);
    if (!["acquire", "renew", "release"].includes(action)) {
      fail("pin_lease_invalid", "invalid journaled lease action");
    }
    const normalizedBinding = validateBinding(binding);
    validateCreatorArtifactPinRequest({
      contractVersion: MEDIA_ARTIFACT_PIN_REQUEST_VERSION,
      requestId, action, args, binding: normalizedBinding, expectedOwnerEpoch
    });
    if (!isPlainObject(args)) fail("pin_lease_invalid", "args must be an object");
    if (!["creator_checkpoint", "creator_job", "release_candidate"].includes(args.ownerKind)) {
      fail("pin_lease_invalid", "journaled ownerKind not supported");
    }
    const ownerExpected =
      args.ownerKind === "creator_checkpoint" ? normalizedBinding.checkpointId :
      args.ownerKind === "release_candidate" ? normalizedBinding.releaseCandidateId :
      normalizedBinding.creatorJobId;
    if (ownerExpected === null || ownerExpected !== args.ownerId) {
      fail("pin_binding_conflict", "owner does not match Creator job/checkpoint/release binding");
    }
    if (action === "acquire" && (
      args.artifactDigest !== normalizedBinding.artifactDigest ||
      args.manifestDigest !== normalizedBinding.manifestDigest
    )) fail("pin_binding_conflict", "acquire does not match Creator artifact/manifest binding");
    if (action === "acquire" && (!Number.isInteger(expectedOwnerEpoch) || expectedOwnerEpoch < 0)) {
      fail("pin_lease_invalid", "acquire requires expectedOwnerEpoch");
    }

    const requestDigest = fingerprint({
      contractVersion: MEDIA_ARTIFACT_PIN_REQUEST_VERSION,
      requestId,
      action,
      args,
      binding: normalizedBinding,
      expectedOwnerEpoch
    });
    return this.withCoordination(() => {
      this.#refresh();
      const prior = this.state.requestJournal[requestId];
      if (prior) {
        if (prior.requestDigest !== requestDigest) {
          fail("pin_request_conflict", "requestId reused for different command");
        }
        if (prior.status === "committed") {
          // A persisted acknowledgement proves historical completion, NOT
          // that its lease remains held following a later CAS mutation/expiry.
          if (prior.action === "release") {
            if (this.state.leases[prior.ownerKey] ||
                (this.state.generations[prior.ownerKey] ?? 0) !== prior.response?.generation) {
              fail("pin_request_superseded", "committed release was followed by an owner replacement; inspect current generation");
            }
          } else {
            const acknowledgedLease = prior.response?.lease ?? prior.response;
            const currentLease = this.state.leases[prior.ownerKey];
            const currentBinding = this.state.ownerBindings[prior.ownerKey];
            if (!acknowledgedLease || !currentLease ||
                currentLease.canonicalDigest !== acknowledgedLease.canonicalDigest ||
                !currentBinding || currentBinding.bindingDigest !== prior.bindingDigest ||
                !isArtifactPinLeaseActive(currentLease, { nowMs: this.clock() })) {
              fail("pin_request_superseded", "committed historical acknowledgement is no longer a verified active pin");
            }
          }
          return { ...clone(prior.response), replayed: true };
        }
        if (prior.status === "rejected" || prior.status === "aborted") {
          fail("pin_request_closed", "this requestId has already been closed; use a new ID");
        }
        fail("pin_outcome_unknown", "prepared request requires reconciliation; never replay side effect");
      }

      const ownerKey = artifactPinOwnerKey(args.ownerKind, args.ownerId);
      const existing = this.state.leases[ownerKey] ?? null;
      const bindingDigest = fingerprint(normalizedBinding);
      const oldBinding = this.state.ownerBindings[ownerKey];
      const nowMs = this.clock();
      if (existing && isArtifactPinLeaseActive(existing, { nowMs }) &&
          (!oldBinding || oldBinding.bindingDigest !== bindingDigest)) {
        fail("pin_binding_conflict", "active owner has a different/unverified Creator binding");
      }
      if (action !== "acquire" && (
        !existing ||
        existing.artifactDigest !== normalizedBinding.artifactDigest ||
        existing.manifestDigest !== normalizedBinding.manifestDigest ||
        !oldBinding ||
        oldBinding.bindingDigest !== bindingDigest
      )) fail("pin_binding_conflict", "mutation does not match active bound lease");

      if (action === "acquire") {
        if (typeof verifyArtifact !== "function") {
          fail("pin_artifact_verification_required", "acquire requires authoritative synchronous artifact and Creator binding verification");
        }
        const proof = verifyArtifact(clone(normalizedBinding));
        if (!proof || proof.verified !== true ||
            proof.artifactDigest !== normalizedBinding.artifactDigest ||
            proof.manifestDigest !== normalizedBinding.manifestDigest ||
            proof.logicalMediaJobId !== normalizedBinding.logicalMediaJobId) {
          fail("pin_artifact_integrity", "acquire proof does not bind a verified final artifact to the Creator job");
        }
      }

      const currentEpoch = this.state.generations[ownerKey] ?? 0;
      if (action === "acquire" && expectedOwnerEpoch !==
          (existing && isArtifactPinLeaseActive(existing, { nowMs })
            ? existing.generation : currentEpoch)) {
        fail("pin_owner_epoch_conflict", "owner replacement epoch mismatch");
      }

      const scope = artifactPinScope(
        normalizedBinding.artifactDigest,
        normalizedBinding.manifestDigest
      );
      const prepared = {
        status: "prepared",
        action,
        requestDigest,
        ownerKey,
        ownerKind: args.ownerKind,
        ownerId: args.ownerId,
        argsDigest: fingerprint(args),
        bindingDigest,
        binding: normalizedBinding,
        artifactDigest: normalizedBinding.artifactDigest,
        manifestDigest: normalizedBinding.manifestDigest,
        scopeEpochAtPrepare: this.state.mutationEpochs[scope] ?? 0,
        expectedGeneration: action === "acquire" ? expectedOwnerEpoch : args.expectedGeneration,
        preparedAtMs: nowMs
      };
      this.state.requestJournal[requestId] = prepared;
      this.#persist();
      if (fault === "after_prepare_before_effect") {
        fail("pin_outcome_unknown", "injected lost outcome after durable preparation, before effect");
      }

      let response;
      this.#journalRequestId = requestId;
      try {
        if (action === "acquire") response = this.#acquireUnsafe(args);
        if (action === "renew") response = this.#renewUnsafe(args);
        if (action === "release") response = this.#releaseUnsafe(args);
      } catch (error) {
        this.#refresh();
        this.state.requestJournal[requestId] = {
          ...prepared,
          status: "rejected",
          errorCode: error?.code ?? "pin_lease_failed",
          resolvedAtMs: this.clock()
        };
        this.#persist();
        throw error;
      } finally {
        this.#journalRequestId = null;
      }

      // A real process crash can occur after the lease/event atomic snapshot
      // but before the companion owner binding snapshot. Restart recovery
      // reconstructs the binding from the durable prepared request + event.
      if (fault === "after_lease_effect_before_binding_commit") {
        fail("pin_outcome_unknown", "injected crash after lease effect before Creator binding commit");
      }
      this.#refresh();
      if (action !== "release") {
        this.state.ownerBindings[ownerKey] = {
          binding: normalizedBinding,
          bindingDigest,
          generation: response.lease?.generation ?? response.generation
        };
      } else {
        delete this.state.ownerBindings[ownerKey];
      }
      // The effect was persisted before this point. A fault here simulates a crash
      // after effect, before journal commit; prepared remains a GC-blocking unknown.
      this.#persist();
      if (fault === "after_effect_before_commit") {
        fail("pin_outcome_unknown", "injected missing acknowledgement before journal commit");
      }
      this.state.requestJournal[requestId] = {
        ...prepared,
        status: "committed",
        response: clone(response),
        resolvedAtMs: this.clock()
      };
      this.#persist();
      if (fault === "after_commit_before_ack") {
        fail("pin_ack_lost", "injected lost acknowledgement after durable commit");
      }
      return { ...clone(response), replayed: false };
    });
  }

  recoverySnapshot({ requestId } = {}) {
    validateRequestId(requestId);
    return this.withCoordination(() => {
      this.#refresh();
      const row = this.state.requestJournal[requestId] ?? null;
      if (!row) {
        return {
          journal: null, lease: null, ownerBinding: null, ownerGeneration: null,
          matchingEvents: [], scopeEpoch: null, observedAtMs: this.clock()
        };
      }
      const scope = artifactPinScope(row.artifactDigest, row.manifestDigest);
      return {
        journal: { ...clone(row), requestId },
        lease: this.state.leases[row.ownerKey] ? clone(this.state.leases[row.ownerKey]) : null,
        ownerBinding: this.state.ownerBindings[row.ownerKey]
          ? clone(this.state.ownerBindings[row.ownerKey]) : null,
        ownerGeneration: this.state.generations[row.ownerKey] ?? 0,
        matchingEvents: this.state.events.filter((event) => event.requestId === requestId).map(clone),
        scopeEpoch: this.state.mutationEpochs[scope] ?? 0,
        observedAtMs: this.clock()
      };
    });
  }

  journaledRequest(requestId) {
    validateRequestId(requestId);
    this.#refresh();
    const row = this.state.requestJournal[requestId];
    return row ? clone(row) : null;
  }

  reconcileJournaledRequest({ requestId } = {}) {
    validateRequestId(requestId);
    return this.withCoordination(() => {
      this.#refresh();
      const row = this.state.requestJournal[requestId];
      if (!row) fail("pin_request_not_found", "unknown requestId");
      if (row.status === "committed") return clone(row.response);
      if (row.status !== "prepared") {
        fail("pin_request_closed", "request cannot be reconciled as applied");
      }
      const events = this.state.events.filter((item) => item.requestId === requestId);
      if (events.length !== 1) {
        fail("pin_outcome_unknown", "missing or duplicated event evidence; no blind side-effect replay");
      }
      const event = events[0];
      const correctEventType = row.action === "acquire"
        ? ["acquire", "reacquire"].includes(event.type)
        : event.type === row.action;
      if (!correctEventType ||
          artifactPinOwnerKey(event.ownerKind, event.ownerId) !== row.ownerKey ||
          event.artifactDigest !== row.artifactDigest ||
          event.manifestDigest !== row.manifestDigest ||
          event.canonicalDigest === undefined ||
          (this.state.mutationEpochs[artifactPinScope(row.artifactDigest, row.manifestDigest)] ?? 0) <= row.scopeEpochAtPrepare ||
          (row.expectedGeneration !== undefined && event.generation !==
            (row.action === "release" ? row.expectedGeneration : row.expectedGeneration + 1))) {
        fail("pin_outcome_unknown", "persisted event does not prove the requested owner/action/epoch/provenance");
      }

      const lease = this.state.leases[row.ownerKey];
      let response;
      if (row.action === "release") {
        if (lease || this.state.generations[row.ownerKey] !== event.generation ||
            !/^[a-f0-9]{64}$/.test(event.canonicalDigest)) {
          fail("pin_outcome_unknown", "release event conflicts with lease/generation/canonical provenance");
        }
        response = {
          released: true,
          ownerKind: event.ownerKind,
          ownerId: event.ownerId,
          generation: event.generation,
          canonicalDigest: event.canonicalDigest,
          releasedAtMs: event.atMs
        };
      } else {
        if (!lease || lease.canonicalDigest !== event.canonicalDigest ||
            lease.generation !== event.generation ||
            this.state.generations[row.ownerKey] !== event.generation ||
            lease.artifactDigest !== row.artifactDigest ||
            lease.manifestDigest !== row.manifestDigest) {
          fail("pin_outcome_unknown", "lease bytes do not match persisted side-effect evidence");
        }
        response = row.action === "acquire"
          ? { lease: clone(lease), duplicate: false }
          : clone(lease);
      }
      if (row.action === "release") {
        delete this.state.ownerBindings[row.ownerKey];
      } else {
        this.state.ownerBindings[row.ownerKey] = {
          binding: row.binding,
          bindingDigest: row.bindingDigest,
          generation: lease.generation
        };
      }
      this.state.requestJournal[requestId] = {
        ...row,
        status: "committed",
        response,
        resolvedAtMs: this.clock(),
        reconciliation: "persisted_event_and_lease"
      };
      this.#persist();
      return clone(response);
    });
  }

  reconcileNoEffect({
    requestId, reviewedBy, evidenceDigest, expectedScopeEpoch
  } = {}) {
    validateRequestId(requestId);
    nonEmpty(reviewedBy, "reviewedBy");
    sha256(evidenceDigest, "evidenceDigest");
    return this.withCoordination(() => {
      this.#refresh();
      const row = this.state.requestJournal[requestId];
      if (!row || row.status !== "prepared") {
        fail("pin_request_closed", "no prepared request available for no-effect reconciliation");
      }
      const scope = artifactPinScope(row.artifactDigest, row.manifestDigest);
      if (this.state.events.some((event) => event.requestId === requestId) ||
          (this.state.mutationEpochs[scope] ?? 0) !== expectedScopeEpoch ||
          expectedScopeEpoch !== row.scopeEpochAtPrepare) {
        fail("pin_outcome_unknown", "cannot prove no effect against persisted epoch/event");
      }
      this.state.requestJournal[requestId] = {
        ...row, status: "aborted",
        reconciliation: "explicit_proven_no_effect", reviewedBy, evidenceDigest,
        resolvedAtMs: this.clock()
      };
      this.#persist();
      return { status: "aborted", requestId, scopeEpoch: expectedScopeEpoch };
    });
  }

  beginCleanup({
    requestId, recordId, artifactDigest, manifestDigest, planDigest, approval
  } = {}) {
    if (this.#barrierDepth === 0) {
      fail("pin_gc_coordination_unknown", "cleanup preparation requires exclusive coordination barrier");
    }
    validateRequestId(requestId);
    sha256(recordId, "recordId");
    sha256(planDigest, "planDigest");
    const scope = artifactPinScope(artifactDigest, manifestDigest);
    this.#refresh();
    const existing = this.state.cleanupJournal[requestId];
    if (existing) {
      if (existing.recordId !== recordId ||
          existing.artifactDigest !== artifactDigest ||
          existing.manifestDigest !== manifestDigest ||
          existing.planDigest !== planDigest) {
        fail("gc_request_conflict", "cleanup requestId reused with different identity");
      }
      if (existing.status === "committed") return { duplicate: true, outcome: clone(existing.outcome) };
      fail("gc_outcome_unknown", "cleanup request has unknown/prepared outcome; never blindly delete again");
    }
    const snapshot = this.snapshotForGc({ nowMs: this.clock() });
    if (snapshot.unknownScopes.some((row) =>
      row.artifactDigest === artifactDigest && row.manifestDigest === manifestDigest
    )) fail("gc_outcome_unknown", "unresolved pin or cleanup journal blocks GC");
    if (snapshot.pinLeases.some((lease) =>
      lease.artifactDigest === artifactDigest && lease.manifestDigest === manifestDigest
    )) fail("gc_pin_active", "an active verified pin lease blocks GC");
    const epoch = snapshot.mutationEpochs[scope] ?? 0;
    validateApproval(approval, {
      artifactDigest, manifestDigest, planDigest, epoch, nowMs: this.clock()
    });
    this.state.cleanupJournal[requestId] = {
      status: "prepared", requestId, recordId, artifactDigest, manifestDigest,
      planDigest, approvalDigest: approval.canonicalDigest,
      expectedEpoch: epoch, preparedAtMs: this.clock()
    };
    this.#persist();
    return { duplicate: false, epoch };
  }

  commitCleanup({ requestId, outcome }) {
    if (this.#barrierDepth === 0) fail("pin_gc_coordination_unknown", "cleanup commit requires coordination");
    this.#refresh();
    const row = this.state.cleanupJournal[requestId];
    if (!row || !["prepared", "outcome_unknown"].includes(row.status)) {
      fail("gc_request_conflict", "cleanup journal has no preparatory record");
    }
    this.state.cleanupJournal[requestId] = {
      ...row, status: "committed", outcome: clone(outcome), committedAtMs: this.clock()
    };
    this.#persist();
    return clone(outcome);
  }

  markCleanupUnknown({ requestId, reason }) {
    if (this.#barrierDepth === 0) fail("pin_gc_coordination_unknown", "cleanup unknown requires coordination");
    this.#refresh();
    const row = this.state.cleanupJournal[requestId];
    if (!row || row.status !== "prepared") return;
    this.state.cleanupJournal[requestId] = {
      ...row, status: "outcome_unknown", reason: String(reason), atMs: this.clock()
    };
    this.#persist();
  }

  reconcileCleanupNoDelete({ requestId, reviewedBy, evidenceDigest, verifyNoDelete }) {
    validateRequestId(requestId);
    nonEmpty(reviewedBy, "reviewedBy");
    sha256(evidenceDigest, "evidenceDigest");
    if (typeof verifyNoDelete !== "function") {
      fail("gc_outcome_unknown", "synchronous backend verification callback is required");
    }
    return this.withCoordination(() => {
      this.#refresh();
      const row = this.state.cleanupJournal[requestId];
      if (!row || !["prepared", "outcome_unknown"].includes(row.status)) {
        fail("gc_request_conflict", "no uncertain cleanup to reconcile");
      }
      if (verifyNoDelete(clone(row)) !== true) {
        fail("gc_outcome_unknown", "backend cannot prove cleanup did not occur");
      }
      this.state.cleanupJournal[requestId] = {
        ...row, status: "aborted", reconciliation: "external_no_delete_proof",
        reviewedBy, evidenceDigest, resolvedAtMs: this.clock()
      };
      this.#persist();
      return { status: "aborted", requestId };
    });
  }

  reconcileCleanupDeleted({ requestId, reviewedBy, evidenceDigest, verifyDeleted }) {
    validateRequestId(requestId);
    nonEmpty(reviewedBy, "reviewedBy");
    sha256(evidenceDigest, "evidenceDigest");
    if (typeof verifyDeleted !== "function") {
      fail("gc_outcome_unknown", "synchronous backend verification callback is required");
    }
    return this.withCoordination(() => {
      this.#refresh();
      const row = this.state.cleanupJournal[requestId];
      if (!row || !["prepared", "outcome_unknown"].includes(row.status)) {
        fail("gc_request_conflict", "no uncertain cleanup to reconcile");
      }
      if (verifyDeleted(clone(row)) !== true) {
        fail("gc_outcome_unknown", "backend cannot prove the scoped artifact was deleted");
      }
      const outcome = {
        status: "deleted_reconciled",
        recordId: row.recordId,
        requestId
      };
      this.state.cleanupJournal[requestId] = {
        ...row, status: "committed", outcome,
        reconciliation: "external_delete_proof",
        reviewedBy, evidenceDigest, committedAtMs: this.clock()
      };
      this.#persist();
      return clone(outcome);
    });
  }

  cleanupRequest(requestId) {
    validateRequestId(requestId);
    this.#refresh();
    const row = this.state.cleanupJournal[requestId];
    return row ? clone(row) : null;
  }

  listAll() {
    this.#refresh();
    return Object.values(this.state.leases).map(clone);
  }

  events() {
    this.#refresh();
    return clone(this.state.events);
  }
}
