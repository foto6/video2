# Primary Media Wave 9 — external artifact pin leases

`media.artifact_pin_lease.v1` makes Creator/checkpoint/release references durable and explicit without changing `media.artifact_manifest.v1` or `media.artifact_retention.v1`.

## Lease contract

Each lease is path-free and binds:

- artifact SHA-256;
- artifact-manifest SHA-256;
- owner kind and owner ID;
- pin reason;
- created and last-renewed timestamps;
- optional expiry;
- positive generation;
- canonical SHA-256 digest over all contract fields except `canonicalDigest`.

The owner identity is `ownerKind + ownerId`. Two different owner kinds may reuse the same textual ID.

## Operations and CAS rules

`PersistentArtifactPinLeaseStore` exposes `acquire`, `renew`, `release`, and `inspect`.

An active duplicate acquire is idempotent only when artifact digest, manifest digest, owner kind/id, pin reason and expiry all match. Otherwise it fails with `pin_lease_conflict`.

Renew and release require `expectedGeneration`. A mismatch fails with `pin_lease_generation_conflict`. Renew increments generation. Release removes the active lease but preserves the generation watermark, so a later reacquire advances generation rather than reusing it.

The store reloads durable state before every mutation and uses temp-file + rename persistence. Corrupt state fails closed rather than resetting.

## Clock and expiry

A lease is active exactly when:

```
expiresAtMs === null || nowMs < expiresAtMs
```

Therefore `nowMs === expiresAtMs` is expired. Expired leases remain inspectable but do not block GC. An expired lease cannot be renewed; it must be reacquired, which advances generation. All clock decisions are injected and deterministic in tests.

## GC integration and TOCTOU

`planArtifactGc` accepts active pin leases in addition to existing job/checkpoint/release references. An exact artifact+manifest lease adds `external_pin_lease` reachability independent of retention age/class.

`ArtifactGcExecutor` can be bound to a `pinLeaseStore`. Immediately before any actual deletion it re-reads that store, validates active leases at the current clock, revalidates the retention record and manifest digest, and recomputes reachability. A lease acquired after planning therefore blocks deletion.

A lease for the correct artifact but a different manifest digest does not pin the record; active owner rebinding to a different manifest is rejected while the original lease remains active.

## Creator conformance fixture

`conformance/media.artifact_pin_lease.v1/manifest.json` hashes the canonical lease, operation sequence and 10k stress descriptor. Creator can consume those JSON files without importing Media source.

## Stress

Seed 909090 generates 10,000 leases over the existing 1,200-record retention corpus. 8,571 leases are active and 1,429 are expired at the fixed planner clock. Every retention record has at least one exact active external lease, yielding 1,200 blocked / 0 eligible records and zero reachable-eligibility violations.

CI uses GC planning only for this stress corpus; it performs no production/external cleanup.

No publishing or account mutation is introduced. Existing protected-path policy remains unchanged.
