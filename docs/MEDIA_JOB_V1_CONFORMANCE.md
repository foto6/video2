# media.job.v1 consumer conformance pack

Producer compatibility base: `foto6/video2@cc542d626622c780fba2d03d094815d3dca240f9`.

Creator assumptions were cross-checked against `foto6/video1@7ece5182bdf0791eadda28f10e7316f3a496ded4`, specifically `resumable_media.py`, `external_ops.py`, the recovery tests, and `EXTERNAL_OPERATION_RECOVERY.md`. No Creator files are copied or imported.

## Files

`conformance/media.job.v1/consumer-manifest.json` is the self-contained entry point. It pins every canonical fixture with SHA-256 and records retry ownership, allowed actions/statuses, the preserved `media.render.v1` fixture hash, and the exact Creator reference head.

Canonical fixtures cover:

- accepted submit;
- byte-identical logical duplicate submit;
- `idempotency_conflict`;
- `job_conflict`;
- queued, rendering, reconciliation-blocked, succeeded, failed, and cancelled statuses;
- `resume_or_poll`;
- cancel.

Consumers do not import Media implementation code. They can copy the manifest/fixture directory and independently validate JSON.

## Strict wire shape

`parseMediaJobEnvelope` rejects unknown/extra envelope fields and unsupported actions/versions. Submit accepts exactly the current render fields: `contractVersion`, `jobId`, `timeline`, `exportSpec`, `outputPath`, `dryRun`.

`validateMediaJobPublicResponse` rejects unknown response/nested telemetry fields and impossible combinations. In particular:

- `terminal` must agree with lifecycle status;
- `retryOwner` is exactly `media`;
- reconciliation blocking is valid only for `rendering` or `retry_wait`;
- failed status requires failure details;
- final artifacts are forbidden for dry-run and all non-succeeded states;
- a succeeded live response requires an artifact whose size/hash match telemetry;
- partial/temp output paths are forbidden;
- protected paths are forbidden;
- dry-run responses must have zero executor/probe/QA/finalize side effects.

The serializers produce deterministic canonical JSON strings. `MediaJobProtocolHarness` exposes the same strict exchange for in-process objects, JSONL lines, or RPC-style params without starting a server.

## Exact Creator adapter mapping

Creator's current generic resumable client has two methods:

`submit_operation(request, idempotency_key=...)`

Map it to:

```json
{
  "contractVersion": "media.job.v1",
  "action": "submit",
  "idempotencyKey": "<Creator stage idempotency key>",
  "request": "<the existing media.render.v1-shaped request>"
}
```

Persist Media's returned `jobId` as Creator's `external_operation_id`. This is the stable provider handle.

Creator's current:

`read_operation(external_operation_id)`

maps to:

```json
{
  "contractVersion": "media.job.v1",
  "action": "resume_or_poll",
  "jobId": "<external_operation_id>"
}
```

State translation for the current generic Creator adapter:

| Media public state | Creator generic state |
| --- | --- |
| `planned`, `queued`, ordinary `retry_wait` | `pending` |
| reconciliation-blocked `rendering/retry_wait` | `pending` with reconciliation metadata retained |
| `rendering`, `probing`, `qa` | `running` |
| `failed` | `failed` using Media failure code/message |
| `cancelled` | `failed` with cancellation metadata |
| `succeeded` | `succeeded` |

The current Creator `GenericResumableMediaAdapter` is planning-only and sends `dryRun:true`. For a succeeded dry-run Media job, its client adapter should synthesize the existing result object expected by Creator without changing Creator's frozen validator:

```json
{
  "contractVersion": "media.render.v1",
  "jobId": "<Media jobId>",
  "dryRun": true,
  "validation": {"ok": true},
  "renderFingerprint": "<Media renderFingerprint>"
}
```

After Creator has persisted acceptance, it must never call submit again for that logical stage. It repeatedly calls `resume_or_poll` on the same job. If acceptance response delivery itself times out, resubmitting the exact same jobId/idempotencyKey/work is safe and returns the same job; conflicting work fails closed.

A reconciliation-blocked restart is provider-owned. Creator continues polling the same handle. Media does not spawn a second executor until its own reconciliation says the uncertain prior process is `not_running`.

## Artifact and safety invariants

Only a succeeded live job with QA-passing atomic finalization exposes `finalArtifact`. Dry-run success and partial outputs never expose it.

This pack does not modify `media.render.v1`, sandbox/protected-path behavior, live-execution gating, or the no-publishing boundary.
