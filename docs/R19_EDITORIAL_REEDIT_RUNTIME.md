# Media R19 production editorial re-edit runtime

R19 executes the bounded edit-operation surface emitted by exact-green Growth R23 against an exact Media candidate/source lineage and produces a new real MP4 through the existing deterministic FFmpeg runtime.

## Exact upstream authority

Growth R23 is pinned to:

- repository: `foto6/video3`
- branch: `agent/growth-r23-critic-reedit-adapter-20261002`
- SHA: `26f769abceb43a63677ea8f7ba028369db371696`
- exact-head CI: `36974062565` — SUCCESS
- handoff: `growth.creator_reedit_handoff.v1`
- contract blob: `ced853aad722aad4c7a88e9a41756baa1b2892a6`
- schema blob: `ba9ada04488760147136dcaaf012206405c04653`

R19 also preserves the R15 `media.render_export.v1` evidence layer and all R11-R18 render/QA/provenance behavior.

## Execution boundary

Media accepts only `targeted_reedit` handoffs for re-edit round 0 or 1. It recomputes every directive ID, handoff ID and handoff digest before execution.

Before render it verifies:

- exact source ID/SHA/size against real source bytes;
- exact reviewed candidate MP4 SHA/size;
- exact R15 render-export sidecar file SHA;
- render-export semantic binding against the candidate bytes;
- Media producer SHA from the Growth binding;
- source path confinement to the declared sandbox;
- directive intervals are in range and non-contradictory;
- duplicate/conflicting structural operations are rejected;
- deterministic plan digest has not drifted.

The model's `upstream_proposed_edit` text remains audit-only and is never executable.

## Supported edit behavior

The runtime supports the existing bounded Media operations:

- `trim` and `cut`: remove exact reviewed timeline intervals and compress downstream time.
- `speed_change`: deterministic severity-bounded pacing change while preserving source window lineage.
- `crop_scale_reframe`: bounded center reframe plus mild punch-in on only the targeted video segment.
- `fade_transition`: bounded in/out fades on the targeted segment.
- `text_overlay`: restyles existing structured overlay copy only.
- `subtitles_captions`: restyles existing caption copy only.
- `audio_duck_mix`: enables bounded ducking only where voice and music layers already exist.
- `intro_outro_cta`: restyles existing intro/outro/CTA copy only.

Media does not invent copy, B-roll, voice, music, or other external assets. If a required structured layer is absent, the application is marked unsupported and the runtime fails before rendering.

## Output evidence

Every successful run emits:

- `final.mp4`;
- `media.render_export.v1.json`;
- `media.editorial_reedit_plan.r19.v1.json`;
- `media.editorial_reedit_application.v1.json`;
- `media.editorial_reedit_runtime.r19.evidence.json`.

The application sidecar binds the exact input source/candidate identity, Growth handoff/digest, directive digest, exact applied operations, FFmpeg render-plan digest, output timeline digest, output MP4 SHA/size, R15 sidecar SHA and technical-QA evidence.

Duplicate replay validates those exact output bytes and sidecars and performs no blind re-render. Partial existing evidence fails closed.

## Real deterministic rehearsal

`npm run verify:r19` creates actual video/audio fixtures via the existing R14 corpus generator and exercises three production shapes:

1. talking-head vertical with pauses — speed tightening, trim/cut, caption restyle, audio duck/mix and CTA restyle;
2. landscape source reframed to 9:16 — crop/reframe, fade, text overlay and CTA;
3. motion-heavy short-form — bounded reframe, fade, caption and text-overlay changes.

For each shape the rehearsal creates a real before-candidate, constructs a provenance-bound Growth-R23-shaped handoff, renders the new real MP4, runs the existing FFprobe/FFmpeg technical QA, writes the R15/R19 sidecars, and then replays the same request to prove byte-stable idempotency.

The readiness artifact is written under `.artifacts/r19-demo`.

## Quality boundary

Technical checks include decode/probe readability, duration, 1080x1920 dimensions, 30fps, audio presence where expected, loudness/peak evidence, black-frame ratio, freeze duration, silence ratio, source provenance, subtitle safe area and the preserved R12/R14 creative guardrails.

These checks do not prove aesthetic or human-quality parity. All R19 evidence explicitly records `humanQuality=false` and `aestheticQualityProven=false`.

No provider upload, publishing, credentials, Creator/Growth mutation, merge or release occurs in R19.
