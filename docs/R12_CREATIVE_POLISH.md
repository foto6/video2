# Media R12 creative polish / human-quality short-form editing

R12 is an additive creative-planning layer above the green R11 deterministic editor. It does not replace `media.job.v1`, `media.render.v1`, R11 source provenance, QA, atomic finalization, artifact manifests, pin leases, retention, retry ownership, or unknown-outcome reconciliation.

## Versioned creative plan

`media.creative_edit_plan.r12.v1` accepts an R11 1080x1920 timeline, one of three deterministic styles, and optional editorial evidence:

- `silenceRanges` and `sentenceBoundariesMs` for dead-air removal and sentence-aware jump cuts;
- `beatMarkersMs` for deterministic cut snapping to known music beats;
- `saliency` windows for subject/face/person-centered reframing when upstream CV metadata exists;
- source-bound `brollCandidates` with SHA-256 and byte size;
- timed `captionTokens` with optional emphasis.

All hints are optional. Missing beat/sentence/saliency/B-roll metadata produces a stable deterministic fallback. Optional model or CV systems remain adapter boundaries through `createCreativeHintAdapters()`; they are not required for rendering.

The plan digest binds the base timeline digest, style, hint digest, dead-air decisions, aligned cut points, fallback choices, loop option, and CTA option. R12 writes that plan digest into `timeline.creativePlan`; `buildRenderPlan()` then binds it into the existing render fingerprint.

## Creative behavior

The three fixture styles are:

- **clean podcast** — conversation-first, moderate hook pacing, sparse punch-ins, clean captions, restrained B-roll;
- **aggressive short-form** — sub-second hook cadence where guardrails allow, stronger jump-cut rhythm, bounded punch/pan/push motion, emphasized kinetic captions, more frequent inserts;
- **cinematic/minimal** — longer holds, sparse movement, minimal captions, subdued music and restrained insert frequency.

Dead-air removal never invents media. It compresses source-bound video and voiceover windows, preserving SHA-256/size provenance. Cadence cuts prefer nearby sentence boundaries, then nearby beat markers, within style-specific tolerances. Saliency hints become bounded FFmpeg crop expressions; absent saliency falls back to centered reframing. Eligible B-roll is selected deterministically by score then ID and must remain source-bound.

Motion uses deterministic FFmpeg `zoompan` patterns (`punch_in`, `slow_push`, `pan_left`, `pan_right`). Caption presets support safe-area placement, emphasis colors, and bounded bounce/slide variants. Loop-friendly mode uses a short source-bound opening bridge at the ending. CTA text is rendered in a top safe-area end-card position.

## Hard anti-over-editing guardrails

R12 fails closed if its compiled plan exceeds:

- cut rate: 1.25 cuts/s;
- motion/zoom rate: 0.30 events/s;
- transition density: 0.20 transitions/s;
- text density: 22 characters/s;
- music gain: no louder than -10 dB before R11 loudness normalization;
- concurrent text: at most two timed text items;
- creative motion zoom: at most 1.18x.

Style targets are lower than the hard ceilings. The planner also caps generated motion count and clamps music gain before final validation.

## Creative visual QA

For an R12 timeline, the normal R11 `evaluateRenderQa()` gate additionally runs creative QA. A live render cannot finalize if these checks fail:

- subtitle/overlay occlusion;
- colliding timed text boxes;
- excessive concurrent text;
- excessive motion;
- unsafe high-zoom saliency crops;
- repeated overlapping source windows, excluding the intentional loop bridge;
- transition spam;
- repeated/frozen-frame evidence from the R11 FFmpeg probe.

R11 continues to enforce dimensions/aspect, duration, empty/corrupt output, black/frozen frames, silence, audio peak, subtitle safe area, and source provenance.

## Reproducible before/after evidence

Run:

```bash
npm run verify:r12
```

`tools/render-r12-demo.mjs` generates synthetic source-bound video, B-roll, voice and music; renders an unpolished R11 baseline; compiles an aggressive R12 plan; renders the creative result through the same durable runtime; runs R11 + R12 QA; exports content-addressed R11 bundles for both; and writes:

```
.artifacts/r12-demo/creative-quality-report.json
```

The report contains before/after render fingerprints, primary artifact and manifest digests, bundle digests, duration/cut/motion deltas, all guardrail checks, all creative visual-QA checks, idempotency counters, executor invocation counts, and source hashes.

## Consumer pinning

Pin the exact producer Git SHA containing `conformance/media.creative_edit_plan.r12.v1/manifest.json`, and verify every listed fixture SHA-256. Continue submitting the compiled timeline through `media.job.v1`; Media remains retry/reconciliation owner. Downstream consumers should accept only succeeded, QA-passing R11 artifacts.

No publishing, credentials, Creator/Growth repository mutation, Desktop Commander, protected-path access, merge, or release is part of R12.
