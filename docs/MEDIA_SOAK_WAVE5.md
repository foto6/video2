# Round 2 Wave 5 — Media crash-consistency and concurrency soak

This wave adds a deterministic reliability stress harness on top of the existing `media.job.v1` and `RenderRuntimeV2`. It does not add or redesign transport actions.

## Deterministic workload

`runDeterministicMediaSoak` uses fixed xorshift32 seeds and a 15-scenario matrix. The committed report is `reports/ROUND2_WAVE5_MEDIA_SOAK.json`.

CI executes three fixed permutations:

- 20,260,927
- 271,828
- 314,159

Each seed runs 105 logical jobs (7 jobs per scenario), for 315 logical job runs and 630 explicitly injected submit/scenario events across the three permutations.

Scenarios are:

- normal render;
- duplicate submit;
- caller timeout after acceptance;
- process failure;
- process timeout;
- transient probe failure;
- QA failure;
- cancel before render;
- cancel during render;
- restart while rendering;
- restart while probing;
- restart while in QA;
- restart in retry_wait;
- uncertain render outcome;
- dry-run.

The fake executor/probe require no FFmpeg binary.

## Concurrency and invariant instrumentation

The harness constrains worker concurrency to 6, render slots to 3, and probe slots to 2. Fake side-effect adapters track active usage and fail the test immediately on overflow.

The persistent store is wrapped with invariants checked on every create/put transition. The harness also checks the public `media.job.v1` snapshot at every transition.

Hard checks include:

- no more than one active render attempt for one logical job;
- one executor invocation per attempt token;
- immutable idempotency-key binding;
- no executor start while reconciliation is required;
- worker/render/probe bounds;
- terminal states cannot return to nonterminal states;
- a succeeded live job has exactly one successful finalization and a final artifact;
- failed, cancelled, and dry-run jobs expose no final artifact;
- public responses never contain partial/temp paths or publishing state;
- terminal jobs leave no expected partial file behind.

Restart-rendering and uncertain-outcome jobs seed a persisted prior attempt and its attempt token before reconstruction. The runtime must retain the reconciliation barrier. Only `not_running` permits another render attempt. Probe/QA restart cases resume against the persisted partial output rather than multiplying render execution.

## Corruption policy

`PersistentRenderJobStore` now defaults to fail-closed for malformed primary JSON and malformed orphan temp snapshots. It does not rename/delete/reset those files automatically. The previous quarantine/reset behavior remains available only through explicit `recoverCorrupt:true` for controlled repair flows.

A valid orphan temp snapshot can still be promoted atomically.

## Concurrency races

The focused stress suite includes 16 concurrent identical submits for one job and 16 concurrent `resume_or_poll` calls. They must converge on one stable job and one render executor invocation.

## Compatibility

Wave 4 conformance fixtures and their manifest are unchanged. Existing CI continues to hash-check those files and the frozen `media.render.v1` fixture. Sandbox/protected-path checks, live execution gating, atomic final-artifact behavior, and the no-publishing boundary are unchanged.

Run the focused soak with:

```sh
npm run test:stress
```

The full suite remains:

```sh
npm test
```
