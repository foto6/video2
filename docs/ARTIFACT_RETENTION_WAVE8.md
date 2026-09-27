# Primary Media Wave 8 — artifact retention, pinning and safe GC

Wave 8 adds `media.artifact_retention.v1` around the existing content-addressed artifact manifest. It does not change `media.render.v1`, `media.job.v1`, or `media.artifact_manifest.v1`.

## Retention metadata

Public retention metadata is path-free and records:

- artifact SHA-256;
- logical Media job ID;
- artifact-manifest SHA-256;
- creation/finalization timestamps;
- retention class;
- pin reasons and deduplicated references;
- last successful integrity verification;
- evaluated deletion eligibility.

Supported classes are `transient`, `cacheable`, `checkpoint_pinned`, `release_pinned`, and `protected`.

Succeeded live Media jobs persist retention metadata next to the job after artifact-manifest commit. Their manifest reference pins them. `exportArtifactRetentionMetadata(jobId)` performs the same byte/manifest integrity verification as status/export and returns only path-free metadata.

## GC planning

`planArtifactGc` is read-only and always emits `media.artifact_gc_plan.v1` with `dryRun:true`. It never exposes storage paths.

A record is blocked when any of these remain reachable:

- a succeeded Media job manifest for the artifact;
- unresolved Media reconciliation for the logical job;
- Creator checkpoint pin;
- release-candidate pin;
- retention class `checkpoint_pinned`, `release_pinned`, or `protected`;
- an explicit durable pin/reference in retention metadata.

Only unreferenced `transient` or `cacheable` records become candidates.

## Explicit deletion

`ArtifactGcExecutor.execute(plan)` defaults to dry-run. Live mutation requires `{dryRun:false}`.

Immediately before any unlink, execution:

1. reloads the durable retention store;
2. verifies the plan record identity;
3. validates `media.artifact_manifest.v1` and its manifest digest;
4. recomputes checkpoint/release/job/reconciliation reachability;
5. resolves the storage key through the existing sandbox/protected-path policy;
6. rejects symlink/reparse-like targets and realpath escapes;
7. hashes the artifact bytes and compares SHA-256/size to the manifest;
8. checks file identity again immediately before unlink.

A pin added after planning therefore invalidates the deletion candidate.

The durable GC event log records per-record results. Partial failure never broadens the deletion set; retries operate on the same record IDs, so a prior deletion becomes `already_missing` rather than causing deletion of another file.

## Deterministic stress

The committed stress descriptor generates 1,200 retention records under seed 808080. It includes protected/pinned classes, duplicated checkpoint/release references, succeeded-job reachability and unresolved reconciliation. The planner result is pinned in `reports/WAVE8_GC_DRY_RUN.json`.

CI performs dry-run planning only for the stress corpus. Small isolated temporary-directory tests exercise the explicit deletion executor; no repository or external artifact cleanup occurs.

## Commands

```sh
npm run test:retention
npm run test:artifact
npm run test:stress
npm test
```

No publishing/account mutation is introduced. Protected-path rules remain unchanged.
