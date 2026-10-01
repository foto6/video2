# Media R11 autonomous short-form editor

R11 extends the existing durable `media.job.v1` / `media.render.v1` runtime instead of introducing a second job state machine. Existing idempotency, crash recovery, unknown-outcome reconciliation, artifact finalization, pin leases, and retention remain authoritative.

## Deterministic short-form profile

`media.shortform_profile.r11.v1` is 1080x1920, 30 fps, 5-90 seconds, with a 3 second hook window and explicit subtitle safe area. R11 timelines opt in with `timeline.profileVersion`. Source entries can bind `id`, SHA-256 and byte size; these values participate in the render fingerprint.

The FFmpeg compiler supports hard cuts/concat, crop/scale/reframe, 0.25x-4x speed changes, per-clip fades, requested xfade transitions, text overlays with semantic intro/CTA/outro roles, captions, voiceover/music/SFX tracks, side-chain ducking, fades, mixing, and loudness normalization. The output muxer is explicit (`-f mp4`), so runtime `.partial` files are valid real FFmpeg targets rather than relying on a filename extension.

## Source preflight and QA

`ShortformFfmpegExecutor` performs read-only source preflight before FFmpeg: local existence, SHA-256/size match and ffprobe stream readability. `FfmpegQaProbe` then rechecks source provenance after rendering and analyzes the rendered output with ffprobe/FFmpeg for dimensions, duration, empty output, black frames, prolonged freeze, silence, peak loudness, stream corruption, and source substitution. `evaluateRenderQa` adds R11 subtitle safe-area checks and fails closed when required source evidence or media analysis is missing.

A source changed between preflight and QA therefore cannot silently inherit a successful manifest. Probe corruption raises a probe failure; QA defects prevent atomic finalization and `media.artifact_manifest.v1` publication.

## Content-addressed outputs

The primary MP4 continues to use the frozen `media.artifact_manifest.v1`. After a succeeded live job, `materializeShortformArtifacts` creates:

- an exact canonical timeline/export-spec JSON sidecar;
- a short preview MP4;
- a thumbnail JPEG;
- `media.shortform_artifact_bundle.r11.v1`, binding the primary artifact-manifest digest, timeline sidecar, preview, thumbnail, source hashes and QA evidence.

Each sidecar/bundle filename is content-addressed by SHA-256. This post-success bundle does not add publishing or provider mutation.

## Reproducible synthetic render

Run:

```bash
npm run verify:r11
```

The focused tests validate compiler and QA invariants. `tools/render-r11-demo.mjs` creates synthetic video/audio sources with FFmpeg, hashes them, submits the job twice using the same `media.job.v1` idempotency key, renders one 1080x1920 MP4, runs machine QA, exports the existing artifact manifest, and emits content-addressed timeline/preview/thumbnail/bundle artifacts plus `.artifacts/r11-demo/evidence.json`.

The demo exercises two cuts, speed change, fade, subtitles, intro/CTA overlays, voice+music mixing, ducking, loudness normalization, final artifact integrity, and duplicate-submit exactly-once behavior. GitHub Actions uploads the demo directory as evidence.

## Creator pinning

Creator should pin the exact Git commit containing `conformance/media.shortform_editor.r11.v1/manifest.json` and independently SHA-256 each listed conformance file. It should continue to submit through `media.job.v1`; Media owns retries and reconciliation. Only a succeeded live job with QA-passing `media.artifact_manifest.v1` is eligible for downstream pin/retention/release handling.

No publishing, credential storage, Creator/Growth mutation, Desktop Commander use, or protected-path access is part of R11.
