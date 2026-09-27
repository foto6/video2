# Media Engine

Headless deterministic media-production engine for timeline-driven video rendering.

## MVP

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

## Test

```sh
npm test
```

The test suite uses Node's built-in test runner and requires no package installation.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for timeline, pipeline, determinism, QA, and provider-boundary details.
