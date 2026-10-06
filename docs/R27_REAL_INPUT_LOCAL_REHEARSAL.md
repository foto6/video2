# Media R27 real-input local rehearsal

R27 implements `media.real_input_local_rehearsal.r27.v1` on top of the existing R25 tournament/render code and R26 durable checkpoint semantics. It does not add a second renderer.

## Windows commands

Run with an explicit source video and explicit output root:

```bat
RUN_LOCAL_R27.cmd "E:\media\input.mp4" "E:\media\r27-output"
```

Status and read-only verification use only the output root:

```bat
STATUS_LOCAL_R27.cmd "E:\media\r27-output"
VERIFY_LOCAL_R27.cmd "E:\media\r27-output"
```

The input file is never modified. The output root must not be a protected Windows location and must not contain the input file.

## Preflight and source binding

Before any candidate render, R27:

- hashes the exact input bytes;
- probes video/audio presence, dimensions, frame rate, and duration with the checkpointed `ffprobe.exe`;
- requires at least five seconds of video;
- checkpoints the exact FFmpeg runtime under the output root and verifies every runtime-file hash;
- binds input hash, probe facts, producer SHA, normalization spec digest, and runtime-manifest hash into the durable operation identity.

Changing the input, producer SHA, runtime, or normalization binding while reusing the same output root fails closed.

## Deterministic normalization

R27 extracts the first five seconds and normalizes them to the existing R25 source contract: 360x640, 30 fps, H.264/AAC, fixed metadata, one encoding thread, and a deterministic cover/center-crop policy. Source audio is resampled to 48 kHz. If the source has no audio stream, R27 injects deterministic silence solely to satisfy the inherited R25 audio contract; this is recorded in normalization evidence.

The normalized source is real content derived from the supplied input. It is not a placeholder or synthetic replacement.

## Existing renderer reuse

After normalization, R27 invokes the existing R25 tools against `<output-root>\work\r25`:

- pair-1 renders candidates 1 and 2;
- candidate 3 uses the existing continuation/cache path;
- candidate 4 uses the existing six durable R25 subphases and assembly;
- initial finalize builds the R25 bracket/review packages;
- targeted re-edit delegates to the existing R19 renderer and R21 review-package code;
- the existing R25 verifier runs without rerendering.

The targeted decision is explicitly a deterministic offline fixture. No model, browser, provider, human-review, upload, or publish claim is made.

## Resume and cancellation

Every R27 phase writes exact artifact hashes into `<output-root>\state\r27-ledger.json`. On restart, completed phase artifacts are rehashed before reuse. Corruption fails closed and does not authorize silent rerender.

Ctrl+C records a cancellation event and does not mark the active phase complete. Re-running the same `RUN_LOCAL_R27.cmd` command resumes from verified completed work.

## Outputs

A complete run produces:

- `final\final.mp4`
- `evidence\media.real_input_local_rehearsal.r27.evidence.json`
- `growth\media.real_input_growth_bundle.r27.manifest.json`
- `growth\media-r27-growth-bundle.tar`

The Growth bundle contains four real candidate MP4s and manifests, bracket evidence, targeted re-edit evidence, the final targeted MP4, normalization evidence, and the R27 evidence summary. Every listed file is hashed and the tar is verified after creation.

The producer authority in all R27 evidence remains:

`PENDING_INDEPENDENT_QA`

Local success does not self-authorize or self-accept Media.

## Resource envelope

Enforced minimums are 2 logical CPUs, 4 GiB RAM, and 4 GiB free disk at the output root. A practical target is 4+ logical CPUs, 8 GiB RAM, and at least 8 GiB free disk.

The cold runtime depends on the Windows CPU and FFmpeg build. For the inherited five-second four-candidate 1080x1920 R25 graph plus targeted re-edit, budget roughly 10-45 minutes. Resume after completed phases should be substantially shorter.

## Hosted CI boundary

Hosted CI runs only `npm run ci:r27`. It does not install FFmpeg and does not claim any real video encoding. It runs the adversarial control-plane suite and tiny byte fixtures to prove ordering, restart/reuse, corruption checks, operation conflicts, sealed four-candidate lineage, and the pending-QA/no-live-effects boundary.
