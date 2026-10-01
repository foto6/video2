# Media R13 Creator-consumer compatibility / production pin

R13 is a read-only compatibility layer for Creator candidate tournaments. It preserves the green R11/R12 runtime and does not create a second render protocol.

## Consumer contract

`media.creator_consumer_compat.r13.v1` gives Creator one stable result envelope instead of requiring field mapping from Media implementation details.

The envelope contains:

- logical Media job ID and idempotency key;
- render fingerprint;
- Media scheduling/profile digest from `media.artifact_manifest.v1`;
- R12 creative-plan digest;
- final content SHA-256 and byte size;
- artifact-manifest stable-JSON SHA-256;
- exact probe evidence and digest;
- exact technical QA evidence and digest;
- R12 creative guardrail and visual-QA evidence;
- canonical timeline SHA-256;
- exact Media producer Git SHA;
- exact Git blob IDs for every pinned contract/schema dependency.

The exporter accepts only a succeeded, non-dry-run job. Before emitting, it calls the existing artifact-manifest job verifier, validates technical QA, recomputes creative quality, binds the canonical timeline and creative-plan digest, and checks the pinned producer/contract identities.

## Production pin without self-reported SHA

A committed file cannot safely contain the SHA of the commit containing itself: changing the file changes the commit SHA. R13 therefore uses two independently checkable identities:

1. `conformance/media.creator_consumer_compat.r13.v1/manifest.json` commits exact Git blob IDs for the preserved Media contracts and the R13 schemas.
2. `npm run emit:r13` obtains the actual producer SHA from `git rev-parse HEAD`, obtains the compatibility manifest's own blob ID from `git hash-object`, verifies every committed pin against Git, and writes both identities into the emitted compatibility bundle.

In GitHub Actions, the emitter additionally requires `GITHUB_SHA === git rev-parse HEAD`. Thus the producer SHA in the CI artifact is the same commit that executed and passed the workflow, not an older self-reported candidate.

## Pinned contract surface

The committed compatibility manifest pins:

- `media.job.v1` consumer manifest;
- `media.artifact_manifest.v1` manifest;
- R12 creative-plan manifest and contract;
- R11 short-form editor manifest and profile;
- R13 compatibility contract;
- R13 result-envelope schema;
- R13 technical-QA schema;
- R13 creative-quality schema.

The emitted bundle adds the R13 manifest blob itself.

Creator should reject a pin if any Git blob ID differs, the producer SHA differs, the compatibility version differs, or a required contract/schema is absent.

## Fail-closed future compatibility

`validateCreatorConsumerEnvelope()` rejects unknown envelope fields and versions, missing fields, stale producer SHA, changed contract pins, content/manifest/timeline/creative-plan digest mismatch, probe evidence mismatch, technical QA mismatch/failure, and any failed creative guardrail or visual-QA check.

A future Media schema that changes the Creator-visible mapping requires a new compatibility contract version. R13 does not silently accept additive fields.

## Reproduction

Run:

```bash
npm run verify:r13
```

This runs focused R13 tests, regenerates the real R12 before/after demo through FFmpeg, and emits:

```
.artifacts/r13-compat/compatibility-bundle.json
.artifacts/r13-compat/demo-consumer-envelope.json
```

For just the deterministic bundle generation from a fresh real R12 demo:

```bash
npm run emit:r13
```

The demo envelope is built from the persisted succeeded `r12-after` job and its actual `media.artifact_manifest.v1`; it cannot be produced by passing synthetic QA flags around the artifact verifier.

No Creator/Growth repository mutation, publishing, credentials, merge/release, Desktop Commander, or protected-path access is part of R13.
