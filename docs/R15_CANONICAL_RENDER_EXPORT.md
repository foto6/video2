# Media R15 canonical render export

Contract: `media.render_export.v1`.

R15 adds one canonical machine-readable sidecar beside each real R14 `final.mp4`:

```
final.mp4
media.render_export.v1.json
```

The sidecar is export-only. It does not alter R11-R14 render, QA, idempotency, retention, artifact-manifest, creative-plan, or acceptance semantics.

## Success record

A success export is emitted only after all of the following hold:

1. persisted Media job status is `succeeded` and is not dry-run;
2. `media.artifact_manifest.v1` validates against the persisted job;
3. SHA-256 and byte size read from the exact `final.mp4` match the artifact manifest;
4. the same SHA-256 and byte size match the QA-passed probe evidence;
5. technical QA is passing;
6. R12 creative QA and guardrails are passing;
7. an independent `ffprobe` of the exact final bytes matches persisted width, height, FPS and duration.

The export records exact final SHA-256/size, producer SHA, normalized ffprobe evidence, source hashes, render fingerprint, artifact-manifest digest, request/profile/timeline/creative-plan digests, technical and creative QA, caption evidence, crop/reframe/motion evidence, audio/loudness evidence, and the frozen boss benchmark binding.

## Failure record

A render that does not succeed emits a deterministic failure sidecar with:

- `status: "failed"`;
- `artifact: null`;
- machine-readable failure code/category/message/retryability;
- any probe/technical-QA/source evidence that exists;
- `benchmark.technicalDq: true`.

A failure record cannot validate as success. Failed cases remain visible and are never converted to synthetic success evidence.

## Replay/idempotency

`writeRenderExportSidecar()` is idempotent only when the existing sidecar is byte-identical to the canonical stable-JSON record. A different replay is rejected as a conflict.

`requireRenderExportSidecar()` fails closed when the sidecar is missing and re-hashes/re-probes the exact `final.mp4` before returning the record.

## Frozen boss benchmark binding

R15 is source-bound to:

- protocol: `human.editorial_benchmark.v1`;
- repository: `foto6/boss`;
- producer SHA: `912fb4b937ec3bd0c1752fe198a41d60236a20dc`;
- path: `GATES/EDITORIAL_PARITY_BENCHMARK_V1.md`;
- Git blob: `af509b79ff8dce6cb621f8ac1c88db1bba6e5219`.

The R14 harness additionally emits compatibility filenames required by that frozen benchmark: `render-manifest.json`, `probe.json`, `technical-qa.json`, `creative-quality.json`, `acceptance.json`, and `human-review-targets.json`, while preserving its existing reports and contact sheet/preview.

Generated CI media proves engineering compatibility only and explicitly counts as zero human-parity samples.

## Commands

Focused contract tests:

```bash
npm run test:r15
```

Batch-export an existing persisted job store without rerendering:

```bash
npm run export:r15:batch -- --jobs-file /path/to/jobs.json
```

The batch operation reuses the exact persisted Media job/artifact manifest, validates each existing successful MP4, emits failure records for failed jobs, and writes `media.render_export.batch.json`.

The CI benchmark proof runs after the R14 matrix is downloaded:

```bash
npm run prove:r15:benchmark -- --input-root .artifacts/r14-shards --output-dir .artifacts/r15-benchmark-proof
```

It verifies real generated MP4 bytes against each canonical sidecar and checks the frozen boss bundle/DQ mapping. The result is `media.r15.benchmark_readiness.v1.json`.

## Conformance

Pinned files live under `conformance/media.render_export.v1/`. The conformance manifest verifies Git blob identity for the implementation, schema, benchmark binding, and canonical success/failure fixtures.

No publishing, credentials, Creator/Growth mutation, or benchmark-score fabrication is part of R15.
