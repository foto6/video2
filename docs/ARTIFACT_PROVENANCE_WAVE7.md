# Primary Media Wave 7 — content-addressed final artifact provenance

`media.artifact_manifest.v1` is a durable, path-free manifest for successful live renders. It is layered onto `RenderRuntimeV2`; `media.render.v1` and `media.job.v1` retain their existing public wire shapes.

## Manifest binding

A committed manifest binds:

- logical render job ID and idempotency key;
- render fingerprint and exact render attempt token;
- digest of the validated render request;
- digest of the scheduler profile/resource requirements;
- final SHA-256, byte size and content ID `sha256:<digest>`;
- full probe evidence plus its canonical digest;
- passing QA evidence plus its canonical digest;
- atomic-finalization provenance;
- job/finalization/manifest timestamps.

The manifest contains no final path, temporary path, source URI or protected absolute path. Filesystem policy remains internal to Media.

## Commit protocol and crash consistency

Before atomic rename, Media hashes the temporary output and durably stores `media.artifact_pending.v1` evidence tied to the attempt/request/profile/probe/QA state. Only then is the file atomically finalized.

After rename, the successful-finalization side effect and finalize timestamp are persisted, final bytes are rehashed, and `media.artifact_manifest.v1` is committed together with the succeeded job state.

If restart occurs after rename but before manifest commit, a QA-stage job with pending provenance is reconciled by hashing the already-finalized bytes. Exact digest/evidence agreement transitions the same job to succeeded without calling the render executor. Mismatch fails integrity and cannot silently rerender.

A restart after manifest commit verifies the manifest and bytes and does not finalize or render again.

## Integrity reads

Every succeeded live `get`/`status` path uses runtime observation, and every terminal `resume_or_poll` verifies final bytes against the manifest. `exportArtifactManifest(jobId)` verifies the same binding before returning the path-free manifest.

Missing, truncated, tampered or substituted bytes produce `artifact_integrity_failure`; a succeeded response is not returned.

Dry-run, failed and cancelled jobs never receive a final manifest. A cancellation observed after atomic rename but before manifest commit removes the finalized bytes and transitions cancelled without exposing an artifact.

## Creator fixture corpus

`conformance/media.artifact_manifest.v1/manifest.json` is self-contained and pins each canonical JSON fixture by file SHA-256 plus canonical manifest SHA-256. Creator checkpoint code can consume these JSON files directly without importing Media source code.

The first two fixtures intentionally have the same byte content ID under different logical jobs, demonstrating that content identity is independent of job/temp-path identity.

## Test commands

Focused integrity tests:

```sh
npm run test:artifact
```

Crash/resource stress:

```sh
npm run test:stress
```

Full suite:

```sh
npm test
```

No publishing/account mutation is introduced. Protected-path rules are unchanged. Optional FFmpeg smoke remains optional.
