# Headless Render Runtime v2

Render Runtime v2 adds durable queue execution around the existing deterministic media core. The existing `buildRenderPlan` and `media.render.v1` implementations remain authoritative and unchanged.

## Lifecycle

Persisted jobs use the explicit states:

`planned -> queued -> rendering -> probing -> qa -> succeeded`

Failure/control states are `retry_wait`, `cancelled`, and `failed`. Dry-run jobs move from `queued` directly to `succeeded` with reason `dry_run_plan_only`; they never enter the executor or probe.

Interrupted `rendering`, `probing`, or `qa` jobs recover to `retry_wait` when attempts remain, otherwise to `failed`. Planned jobs recover to `queued`. Cancellation survives restart.

## Persistent store

`PersistentRenderJobStore` writes a versioned JSON snapshot using adjacent temp-file + rename replacement. A valid orphaned temp store can be promoted after restart. A corrupt root store is moved to a deterministic `.corrupt` quarantine and replaced with an empty v2 store. Jobs with invalid persisted statuses are retained as failed `state_corrupt` records. Idempotency entries pointing to missing jobs are discarded.

## Execution and resources

`RenderRuntimeV2` has both a worker-concurrency bound and named resource semaphores for render/probe lanes. Duplicate idempotency keys return the original job. Duplicate job IDs are rejected.

Live execution is opt-in through `liveExecutionEnabled:true`. The default is off. A request with `dryRun:true` never invokes the process executor, even when live execution is enabled.

`DeterministicProcessExecutor` uses argv execution with no shell, bounded stdout/stderr capture, timeout, cancellation, exit code/signal, truncation flags, and duration capture.

## Output safety

Live renders target a deterministic partial file next to the final output. Probe and QA run against that partial file. Only a QA-passing render is renamed to the final destination. Failed/retried/cancelled attempts clean the partial output.

Runtime paths are lexically sandboxed beneath a configured root. Escapes are rejected. Remote source URIs may be planned, but output paths must be local. The protected Windows path required by coordinator policy is rejected lexically, including file-URI and normalized traversal forms; the runtime never probes that filesystem location.

## Retry policy

Default maximum attempts: 3.

- process timeout / process failure: retryable;
- probe failure: retryable;
- QA failure: classified separately and not retried by default;
- cancellation: never retried;
- path/policy/invalid state: never retried;
- output-finalization failure: retryable.

QA retry can be explicitly enabled by constructing `RetryPolicy({ retryQaFailures: true })`.

## Telemetry

Each persisted job carries:

- planning time;
- cumulative queue wait;
- cumulative render, probe, and QA timing;
- retry count;
- final output size;
- final SHA-256.

The logical render identity remains `buildRenderPlan(...).fingerprint`.

## Fixtures

- `fixtures/runtime-v2/full-pipeline.request.json`: deterministic captions + reframe/crop + audio + transition + overlay request.
- `fixtures/runtime-v2/probe-success.json`: deterministic successful probe result.

The tests also exercise a fake executor for live runtime behavior. An optional FFmpeg smoke test generates a tiny synthetic video when `ffmpeg` is available and is skipped otherwise.

No social publishing APIs or states exist in this runtime.
