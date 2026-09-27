import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { fingerprint, stableStringify } from "../stable.js";
import { runtimeError } from "./errors.js";

export const MEDIA_ARTIFACT_PIN_LEASE_VERSION = "media.artifact_pin_lease.v1";
const PIN_LEASE_STORE_VERSION = 1;

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
    events: []
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
    !Array.isArray(raw.events)
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
  return state;
}

export class PersistentArtifactPinLeaseStore {
  constructor({ filePath, clock = () => Date.now() } = {}) {
    if (!filePath) throw new TypeError("filePath is required");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.filePath = path.resolve(filePath);
    this.tmpPath = `${this.filePath}.tmp`;
    this.clock = clock;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.state = this.#load();
  }

  #load() {
    if (!existsSync(this.filePath)) {
      const state = emptyState();
      this.#persist(state);
      return state;
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
    writeFileSync(this.tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(this.tmpPath, this.filePath);
  }

  #refresh() {
    this.state = this.#load();
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
      ...extra
    });
  }

  acquire({
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
    this.#record(existing ? "reacquire" : "acquire", lease, nowMs);
    this.#persist();
    return { lease: clone(lease), duplicate: false };
  }

  renew({
    ownerKind,
    ownerId,
    expectedGeneration,
    expiresAtMs
  } = {}) {
    const nowMs = this.clock();
    timestamp(nowMs, "clock");
    generation(expectedGeneration, "expectedGeneration");
    this.#refresh();
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
    this.#record("renew", lease, nowMs, { previousGeneration: existing.generation });
    this.#persist();
    return clone(lease);
  }

  release({ ownerKind, ownerId, expectedGeneration } = {}) {
    const nowMs = this.clock();
    timestamp(nowMs, "clock");
    generation(expectedGeneration, "expectedGeneration");
    this.#refresh();
    const key = artifactPinOwnerKey(ownerKind, ownerId);
    const existing = this.state.leases[key];
    if (!existing) fail("pin_lease_not_found", "pin lease does not exist");
    if (existing.generation !== expectedGeneration) {
      fail("pin_lease_generation_conflict", "pin lease generation compare-and-set failed");
    }
    delete this.state.leases[key];
    this.state.generations[key] = existing.generation;
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

  listAll() {
    this.#refresh();
    return Object.values(this.state.leases).map(clone);
  }

  events() {
    this.#refresh();
    return clone(this.state.events);
  }
}
