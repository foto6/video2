# Media R16 candidate batch runtime

Contract: `media.candidate_batch.v1`.

R16 renders a bounded Creator candidate set while preserving the existing R11-R15 per-candidate render, QA, provenance, idempotency and `media.render_export.v1` semantics.

## Request and manifest

A batch contains exactly 2-4 ordered candidates. Every candidate must bind the same exact primary source SHA-256 and byte size. Each candidate has a stable `candidateId`, a canonical plan digest, and one terminal status.

A successful candidate manifest entry binds:

- exact `final.mp4` SHA-256 and byte size;
- exact `media.render_export.v1.json` SHA-256;
- canonical paths `candidates/<candidateId>/final.mp4` and `candidates/<candidateId>/media.render_export.v1.json`;
- candidate plan digest;
- cache identity digest;
- stable candidate order.

A failed candidate remains explicitly `failed` with `final: null` and machine-readable failure evidence. Successful siblings remain intact and independently consumable.

## Bounded execution

The R16 worker pool accepts at most two candidates concurrently. The preserved render runtime is configured with:

- candidate parallelism: <= 2;
- runtime max concurrency: 2;
- render slots: 1;
- probe slots: 1.

No unbounded process spawning is introduced. Per-candidate rendering still uses `media.job.v1`, R14 QA and R15 export validation.

## Exact cache identity

A candidate may be reused only when all of these identities match exactly:

1. source SHA-256;
2. source byte size;
3. canonical candidate plan digest;
4. renderer/config digest;
5. exact Media producer Git SHA.

The runner also revalidates the cached `final.mp4` bytes and its R15 sidecar before reuse. Missing/tampered/stale artifacts invalidate the entry and force the normal render/QA path. Cache reuse is execution metadata only and does not alter canonical batch manifest bytes.

## Restart, replay and partial completion

Batch state is persisted atomically. On process restart, a persisted `running` candidate returns to `pending`; already succeeded or failed siblings remain terminal.

An exact duplicate request or lost-ACK replay returns the same canonical batch manifest and reuses only revalidated exact artifacts. A producer SHA change invalidates persisted successful candidates and recomputes cache identity.

## One-command runner

```bash
node tools/run-r16-candidate-batch.mjs \
  --request /path/to/media.candidate_batch.v1.request.json \
  --sandbox-root /path/to/workspace \
  --output-dir /path/to/output \
  --max-parallel 2
```

The request's `renderer.configDigest` must equal the digest for the selected R16 resource configuration. The runner refuses mismatched config identity.

Outputs include `media.candidate_batch.v1.json`, durable batch/render state, per-candidate MP4/R15 sidecars, and `media.candidate_batch.r16.evidence.json` with detector/render/probe/QA/process counts, wall time, cache counts and observed peak concurrency.

## Reproducible evidence

```bash
npm run verify:r16
```

The deterministic demo generates one real video source, compiles three distinct R12 creative plans, renders all three through the preserved Media runtime, validates every R15 sidecar, reruns the identical request, and proves that replay performs zero renders while the canonical manifest remains byte-identical.

The evidence records first-run detector/render/process counts, replay cache-hit counts, wall time and resource envelope. Optimization does not skip QA: every cache miss follows the full existing render/probe/QA/export path, while every hit is byte-revalidated before reuse.

## Conformance and compatibility

Pinned R16 files live under `conformance/media.candidate_batch.v1/`. The manifest also pins the existing `media.render_export.v1`, `media.job.v1`, and R12 creative-plan manifests.

R11-R15 behavior remains unchanged. No publishing, credentials, Creator/Growth repository mutation, or live account work is part of R16.
