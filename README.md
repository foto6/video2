# Media Engine

Headless deterministic media-production engine for timeline-driven video rendering.

## Core

- versioned, validated timeline spec;
- canonical Remotion-style render plan with SHA-256 fingerprinting;
- FFmpeg command compilation;
- clip extraction;
- crop/reframe;
- captions and SRT export;
- transitions and overlays;
- audio delay/gain/mix;
- render-job state machine and export metadata;
- automated render QA;
- optional Runway and Descript adapter boundaries with no vendor SDK dependency;
- no social publishing.

## Integration contracts

`media.render.v1` is the preserved dry-run planning/validation JSON boundary. Its canonical fixture is `fixtures/media.render.v1.request.json`.

Headless Render Runtime v2 adds durable queueing, recovery, bounded concurrency/resources, process timeout/cancellation, atomic output finalization, sandbox policy, retry classification, telemetry and idempotency around the same deterministic core.

Runtime fixture bundle:

- `fixtures/runtime-v2/full-pipeline.request.json`
- `fixtures/runtime-v2/probe-success.json`

## Test

```sh
npm test
```

The suite uses Node's built-in test runner. The FFmpeg smoke test executes only when a local `ffmpeg` binary is available.

See `docs/ARCHITECTURE.md`, `docs/MEDIA_RENDER_V1.md`, and `docs/RENDER_RUNTIME_V2.md`.
