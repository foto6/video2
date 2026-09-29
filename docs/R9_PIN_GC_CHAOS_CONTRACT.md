# R9: Creator-bound pin and GC crash consistency (isolated candidate)

**Producer:** foto6/video2, `agent/media-r9-pin-gc-chaos-20260928`, base `ab3be066308f47c1bb07d1836e2d2f72faffe0ff`. This is a compatibility/security candidate, not a deployment or release. No primary stack mutation, user-video inspection, social publishing, or paid provider invocation.

## Frozen producer surface and companion boundary

The existing `media.render.v1`, `media.job.v1`, `media.artifact_manifest.v1`, `media.artifact_retention.v1`, and **exact** `media.artifact_pin_lease.v1` canonical fields/digest are not changed. Previous Wave9 10k lease fixture and Wave8 retention plan remain pinned in `conformance/media.pin_gc_chaos.v1/manifest.json`.

New **transport-neutral Creator companion** `media.artifact_pin_request.v1`:

```json
{
  "contractVersion": "media.artifact_pin_request.v1",
  "requestId": "creator:pin:job-42:checkpoint-3:v1",
  "action": "acquire",
  "args": {
    "artifactDigest": "<64 lowercase hex>",
    "manifestDigest": "<64 lowercase hex>",
    "ownerKind": "creator_checkpoint",
    "ownerId": "checkpoint-3",
    "pinReason": "creator_checkpoint_active",
    "expiresAtMs": null
  },
  "binding": {
    "creatorJobId": "job-42",
    "logicalMediaJobId": "render-job-42",
    "checkpointId": "checkpoint-3",
    "releaseCandidateId": null,
    "artifactDigest": "<same 64 lowercase hex>",
    "manifestDigest": "<same 64 lowercase hex>"
  },
  "expectedOwnerEpoch": 0
}
```

The other supported owners are `creator_job` (ownerId = creatorJobId) and `release_candidate` (ownerId = releaseCandidateId). An active owner cannot silently switch Creator job, media job, checkpoint, content or manifest. The Creator binding is persisted in the request journal and owner-binding table; it is intentionally **not** inserted into the frozen public pin-lease v1 JSON. Owner replacement after a verified release must CAS the generation watermark (`expectedOwnerEpoch`); renewal and release CAS `expectedGeneration`. All mismatches fail closed.

### Exact caller transaction

1. Persist the Creator job ID, Media logical job ID, checkpoint/release ID, successful Media manifest digest, final artifact SHA-256, stable `requestId`, and expected owner epoch **before** sending acquisition.
2. Media checks the request's exact fields and calls a synchronous authoritative `verifyArtifact(binding)` under the pin/GC barrier. The producer must verify **succeeded live** Media state, the expected immutable manifest and actual content SHA/size; the callback returns `{verified:true,artifactDigest,manifestDigest,logicalMediaJobId}`. A missing or mismatched proof rejects the operation. No path is included in public lease/request output.
3. Invoke `PersistentArtifactPinLeaseStore.journaledLeaseOperation({requestId,action,args,binding,expectedOwnerEpoch,verifyArtifact})`. Media persists prepared intent first, then the lease mutation + event containing requestId, then a committed response. Duplicate identical committed requests return the original persisted result with `replayed:true`, without a second mutation or epoch increment. Reusing the ID for different content fails `pin_request_conflict`.
4. If the RPC times out, **do not make a fresh request ID**. Inspect `journaledRequest(requestId)`: committed means reuse the stored response; prepared means unknown. Re-send the identical envelope only for committed-response recovery; a prepared request always fails `pin_outcome_unknown`.
5. On restart, `reconcileJournaledRequest({requestId})` commits an applied result only when a persisted side-effect event and current lease/generation match. If no event is present, use `reconcileNoEffect({requestId,reviewedBy,evidenceDigest,expectedScopeEpoch})` only after verifying the durable epoch and no event. Never infer absence from silence alone.
6. Retain the lease across Creator retry, checkpoint commit and release-candidate construction. Expiry is `nowMs >= expiresAtMs`, but an unresolved prepared pin/cleanup outcome **does not expire away**. Renew ahead of expiry with the currently persisted generation.
7. For human-approved release: authenticate the human/release authority outside this library; CAS release every applicable Creator/checkpoint/release owner. Approval does not itself remove a lease.

## Safe GC protocol and human release gate

Production callers must use `planArtifactGcWithPinStore({pinLeaseStore,records,jobs,checkpointPins,releasePins,nowMs})`. The original input-only planner remains valid for offline fixtures but is **not authoritative** if durable pin state exists. Both verified active leases and any unknown prepared pin/cleanup journal entry block eligibility, regardless of age.

After ALL applicable pins have been released, construct a fresh dry-run plan and call `prepareScopedGcApproval({pinLeaseStore,plan,recordId,approvalId,approvedBy,clock,ttlMs})`. This creates `media.artifact_gc_approval.v1` bound to content digest, manifest digest, exact GC plan digest, current mutation epoch and a short clock window (max 1 hour). The embedding system must authenticate `approvedBy`; a self-asserted ID is not an authentication mechanism. Approval is an additional gate and **cannot override an active pin**.

For a separately authorized production delete, inject the **same authoritative pinLeaseStore** into `ArtifactGcExecutor` and pass `{dryRun:false,approvals:[approval]}`; default stays `dryRun:true`. Execution re-reads durable pins, unresolved journals, retention record/manifest, sandbox path, bytes and identity under the shared exclusive barrier. Any intervening renew/acquire/release increments the relevant epoch, invalidating the earlier approval.

The GC journal records `prepared` **before** an unlink and `committed` after durable retention outcome. Crash/lost acknowledgment between them leaves `outcome_unknown`, which blocks GC and fresh acquisitions on that artifact. No automatic replay, cleanup of a different record, or automatic stale-barrier theft is permitted. After external backend reconciliation, use exactly one of:
- `reconcileCleanupNoDelete` with synchronous exact-record proof that the artifact still exists;
- `reconcileCleanupDeleted` with synchronous exact-record proof of deletion.

Both require reviewer ID and SHA-256 evidence digest. A crashed lock directory remains fail-closed until an operator proves all processes quiescent and reconciles outstanding journal entries; it is never automatically stolen.

## Synthetic parity / chaos evidence

`simulateScopedArtifactGc` uses an in-memory `Map<recordId,{artifactDigest,manifestDigest,size}>` for deletion and does **not** open or unlink artifact files. The only filesystem state used by focused tests is isolated OS TEMP for the small pin/journal snapshots. A deterministic 3-seed / 36-record corpus tests duplicate delivery, unknown result before/after mutation, restart, expiry, stale approval epoch, concurrent external owner acquisition, protected-path lexical rejection, verified no-delete and verified delete. The existing independent 10,000-lease Wave9 stress and Wave5/Wave6 crash/resource tests run unchanged. Synthetic `media.render.v1` planning-only fixture exercises FFmpeg compilation without launching FFmpeg; existing optional FFmpeg smoke remains optional.

```sh
npm run test:pin-chaos
npm run test:pin
npm run test:retention
npm run test:artifact
npm run test:stress
npm test
```

Focused evidence: `reports/R9_PIN_GC_CHAOS.json`; fixture SHA-256 list: `conformance/media.pin_gc_chaos.v1/manifest.json`. No integration merge/release is performed.

**Boundary note:** older direct `PersistentArtifactPinLeaseStore.acquire/renew/release` calls are retained for Wave9 ABI compatibility. Downstream Creator must use the journaled bound method for externally referenced artifacts. Old unbound/offline GC planning or a GC executor without an authoritative pin store is not an acceptable production cutover configuration.

## Fail-closed production configuration

`ArtifactGcExecutor.execute(plan,{dryRun:false})` now returns `failed_closed / authoritative_pin_store_required` when an authoritative pin store is absent. The only compatibility exception is an explicit `syntheticUnleasedFixtureMode:true` restricted to isolated `media-wave8-*` OS TEMP fixtures in pre-existing tests; do not use it in production. The pin-journal file is atomically replaced after fsync of the temporary snapshot (and directory fsync where supported). Missing primary state alongside an abandoned temporary snapshot, corrupt JSON or an orphan coordination barrier **never** initializes a fresh empty store.

## Additional atomicity evidence

The `after_lease_effect_before_binding_commit` fault injects the narrow crash window between a persisted lease/event snapshot and the companion Creator owner-binding snapshot. `reconcileJournaledRequest` repairs the binding from the original request and matching durable event in the same atomic commit as its replay response, without any second lease side effect.
