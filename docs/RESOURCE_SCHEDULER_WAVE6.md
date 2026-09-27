# Primary Media Wave 6 — Resource scheduler, backpressure and fairness

Wave 6 extends `RenderRuntimeV2`; it does not introduce a second renderer or change the `media.render.v1` / `media.job.v1` public wire shapes.

## Resource classes and budgets

The runtime now has five explicit classes:

- `cpu`
- `gpu`
- `render`
- `probe`
- `qa`

Default budgets remain conservative: one render lane, one probe lane, one QA lane, no GPU requirement by default, and CPU sized to at least the configured render/probe/QA concurrency.

Each stage acquires an atomic multi-resource lease. Render uses CPU + optional GPU + render; probe uses CPU + probe; QA uses CPU + QA. A lease is released once, including cancellation and error paths.

## Bounded profiles

Clients cannot send slot counts. Resource requirements are derived from already-validated timeline metadata and a fixed optional `exportSpec.runtimeProfile` enum:

- `background`: low priority, CPU render
- `standard`: normal priority, CPU render
- `interactive`: high priority, CPU render
- `gpu`: normal priority, one GPU slot

Long timelines (>30 s) or >1080p canvases consume two CPU slots during render. Other renders consume one. Arbitrary fields such as client numeric `resourceRequirements` are ignored by the scheduler and cannot increase reservations.

A profile that cannot fit configured budgets fails before acceptance with `resource_profile_unavailable`.

## Durable fair queue

Each newly accepted logical job receives persisted scheduling metadata:

- immutable profile / priority class;
- monotonic enqueue sequence;
- enqueue dispatch sequence;
- stage requirements;
- last dispatch metadata;
- current reservation evidence.

The scheduler uses a durable weighted wheel:

`high, high, high, high, normal, normal, low`

Within each priority class it is FIFO by enqueue sequence. A continuously populated low-priority lane therefore receives a dispatch opportunity at least once every seven scheduler selections. The cursor and dispatch sequence are committed atomically with selected-job dispatch telemetry, so restart cannot advance one without the other.

Queue order, priority, and enqueue identity survive restart.

## Backpressure

`queueLimit` bounds nonterminal accepted work. Under ordinary load, submit returns an accepted `queued` job; it never creates a second render attempt. Identical duplicate submit returns the existing accepted job even when the queue is full.

A new distinct job beyond the configured bound fails closed with `queue_saturated`. Cancelling terminally queued work frees capacity.

## Restart and reconciliation reservations

Before a render executor call, the runtime persists its attempt token and resource reservation. If restart observes an interrupted render, the existing reconciliation barrier is retained and the reservation is restored as an external hold. That hold consumes scheduler capacity until Media reconciliation reports `not_running` or `render_complete`.

A reconciliation-required job never receives a fresh executor lease. Cancellation of an uncertain attempt also waits for reconciliation rather than guessing that resources/side effects disappeared.

Probe/QA reservations are local and are cleared during recovery because their in-process stage execution cannot remain attached to the reconstructed runtime.

## Diagnostics

`media.scheduler.diagnostics.v1` is an optional aggregate-only diagnostics contract exposed by `RenderRuntimeV2.getSchedulerDiagnostics()`. It does not alter `media.job.v1`.

It reports:

- queue depth/limit, current age and priority mix;
- durable dispatch sequence and starvation-event count;
- per-resource budgets/current/max use, waiters, cumulative busy-slot time and utilization;
- historical queue age and resource wait;
- aggregate terminal throughput.

It exposes no job IDs, paths, idempotency keys, source URIs, or publishing data.

## Stress workload

`reports/WAVE6_RESOURCE_SCHEDULER.json` pins the deterministic focused workload: seed 606060, 540 logical jobs, four resource profiles, three priority classes, 180 long + 360 short jobs, duplicate submits, two store reconstructions, queued cancellation and four conservatively restored uncertain render attempts.

The stress assertions cover slot ceilings, stable enqueue/priority across restart, no duplicate attempt tokens, duplicate-submit side-effect suppression, reconciliation barriers, weighted low-priority dispatch bounds, terminal cleanup and exact final-artifact behavior.

Run:

```sh
npm run test:stress
npm test
```

Publishing remains absent. Protected-path policy is unchanged.
