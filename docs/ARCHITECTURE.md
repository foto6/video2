# Media Engine Architecture

## Scope

The Media Engine is a headless, deterministic media-production component. It accepts a versioned timeline, compiles a canonical render plan, compiles that plan into FFmpeg-compatible work, executes through an injected process boundary, probes the output, performs automated QA, and emits export metadata.

It does not publish to social networks. There is deliberately no publish state in the render-job state machine.

## Determinism

Determinism starts before rendering:

- timelines require stable track and item IDs;
- canonicalization sorts tracks and timeline items;
- source inputs are sorted and assigned stable IDs;
- render plans are SHA-256 fingerprinted from a stable JSON representation;
- FFmpeg compilation strips source metadata, enables bitexact flags, fixes the render thread count to one, and uses explicit codecs/bitrates;
- timestamps are never generated implicitly in core render metadata; callers may provide a completion timestamp.

Codec implementations and hardware can still affect binary-level reproducibility. The plan fingerprint is therefore the stable logical identity, while output hashes can be added by a storage layer.

## Timeline v1

A timeline has:

- `id` and `version: 1`;
- a `canvas` with width, height, fps and durationMs;
- tracks of kind `video`, `audio`, `caption`, or `overlay`;
- stable item IDs and millisecond start/end times;
- source-backed items with URI plus optional source in/out points;
- optional video crop/reframe and transitionOut directives;
- optional audio gain;
- caption text/style and overlay text/source/position.

Validation rejects duplicate IDs, invalid ranges, unsupported transitions and items outside the canvas duration.

## Render pipeline

1. Validate and canonicalize the timeline.
2. Build a Remotion-style composition view using frame ranges.
3. Emit a deterministic logical render plan and fingerprint.
4. Compile FFmpeg input/filter/output arguments.
5. Execute through the injected executor.
6. Probe the render through the injected probe boundary.
7. Run QA against expected duration, resolution, fps, audio presence and optional black-frame/silence metrics.
8. Complete or fail the render job.
9. On success, emit export metadata tied to the plan fingerprint.

The FFmpeg compiler covers clip trim, crop/reframe, xfade transitions, text/image overlays, captions, audio delay/gain/mix, codecs and output metadata stripping. `compileClipExtraction` is also exposed for standalone deterministic clip extraction, and `captionsToSrt` provides subtitle sidecar output.

## Render jobs

The closed state machine is:

`queued -> planning -> rendering -> qa -> completed`

Any active state can fail. Invalid transitions throw. Attempts increment only when a queued job starts. No publishing transition exists.

The current store is caller-owned: jobs are immutable values returned from transitions. Persistence can be supplied by a service without coupling storage into rendering.

## Automated render QA

The built-in QA layer checks:

- video stream presence;
- exact target width and height;
- fps within 0.01;
- duration within a configurable tolerance;
- required audio stream presence;
- optional black-frame ratio;
- optional silence ratio.

A probe implementation can use ffprobe plus analysis passes. The engine only depends on an `inspect(path)` contract, keeping probe mechanics replaceable and testable.

## Provider boundaries

Runway and Descript are optional adapter interfaces only. The core package does not import either vendor SDK.

- Runway boundary: `generateVideo(request)`.
- Descript boundary: `transcribe(request)` and `synthesizeVoice(request)`.

Provider-produced files enter the engine as ordinary source URIs. This keeps rendering usable offline or with different vendors.

## Safety and publishing boundary

The package performs media rendering only. It contains no API, state, or adapter for social publishing.
