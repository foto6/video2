# Creator ↔ Media durable job protocol

## Contracts

`media.render.v1` remains the planning-only compatibility contract. It still requires `dryRun:true`, returns the canonical render fingerprint, and never invokes the process executor.

Long-running Creator integration uses `media.job.v1`. It is transport-neutral: the same message shapes can be carried over an in-process adapter, JSONL, RPC, or HTTP without changing Media runtime semantics.

### Submit

```json
{
  "contractVersion": "media.job.v1",
  "action": "submit",
  "idempotencyKey": "creator:<stable-operation-key>",
  "request": {
    "contractVersion": "media.render.v1",
    "jobId": "<stable-logical-render-job-id>",
    "timeline": {},
    "exportSpec": {},
    "outputPath": "outputs/example.mp4",
    "dryRun": false
  }
}
```

Media canonicalizes the timeline, computes the authoritative `buildRenderPlan` fingerprint, validates paths, and binds `idempotencyKey -> jobId + workSignature -> renderFingerprint`. The caller does not supply or override the fingerprint.

Identical repeated submit returns the same accepted job. The same idempotency key with a different job id, fingerprint, output path, or dry-run mode fails with `idempotency_conflict`. Reusing a logical job id for different work fails with `job_conflict`.

### Get / status

```json
{"contractVersion":"media.job.v1","action":"status","jobId":"<same-job-id>"}
```

`get` and `status` are read-side observations. The public response never exposes the runtime's resolved sandbox path or partial output path.

### Resume or poll

```json
{"contractVersion":"media.job.v1","action":"resume_or_poll","jobId":"<same-job-id>"}
```

After Media accepts a job, Creator owns only polling/resume of that same job. Creator must not create a new job to recover from its own timeout. Media owns process, probe, QA, finalization and their bounded retries. Concurrent resume calls for the same in-process runtime share the same job execution promise.

If restart recovery finds an accepted render attempt whose process outcome is uncertain, the job is reconciliation-blocked. Polling does not spawn another process. Media must reconcile the prior attempt as `still_running`, `unknown`, `render_complete`, or `not_running` before another render can begin.

### Cancel

```json
{"contractVersion":"media.job.v1","action":"cancel","jobId":"<same-job-id>","reason":"creator_cancelled"}
```

Cancellation is idempotent with respect to render side effects: repeated cancel requests may increase protocol telemetry but do not create a new render process. An uncertain restarted render remains reconciliation-blocked until Media establishes whether that process is still active.

## Retry ownership matrix

| Failure / caller event | Owner | Media behavior | New render process? |
| --- | --- | --- | --- |
| duplicate submit, identical work | Media idempotency | return same job | no |
| duplicate idempotency key, conflicting work | Media idempotency | fail closed | no |
| Creator request/response timeout after acceptance | Creator polls same job | return/resume same job | no duplicate |
| process timeout/failure | Media | bounded render retry | yes, only after prior process is known complete/failed |
| probe transient failure | Media | retry probe against same partial output | no |
| QA failure | Media | fail closed by default; optional bounded QA retry | no |
| runtime restart during render | Media | reconciliation barrier | no, until reconciled not-running |
| runtime restart during probe/QA | Media | resume stage against same partial output | no |
| cancellation race | Media | abort active attempt or reconciliation-block uncertain attempt | no duplicate |

## Side-effect telemetry

Every persisted job records cumulative counters: `executorInvocations`, `probeInvocations`, `qaEvaluations`, `finalizeInvocations`, `successfulFinalizations`, plus protocol submit/duplicate/poll/resume/cancel/reconciliation counts. Counters are persisted before the corresponding external side-effect invocation where relevant.

## Final artifact rule

Only a QA-passing output that completes atomic finalization can be reported as `finalArtifact` on a `succeeded` live job. Partial paths are internal and never appear in the consumer response. Dry-run success has no final artifact.

Sandbox and protected-path rules remain unchanged. No publishing action or state exists.
