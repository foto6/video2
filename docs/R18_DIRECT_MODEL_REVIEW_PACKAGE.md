# Media R18 direct model review package

Contract: `media.direct_model_review_package.v1`.

R18 turns the exact green R17 review artifact into a blinded two-video package that can be attached to an existing ChatGPT web conversation by the independently developed Bridge attachment transport. Media does not upload anything and does not fabricate any model judgment.

## Exact upstream authority

R18 accepts only the green R17 artifact:

- Media producer: `e88f1791ae47e7333ce85db584f0a04dbf229809`
- CI run: `36890371410` — SUCCESS
- artifact: `11177570580`, `media-r17-web-chat-review`
- archive SHA-256: `37778b26f02b248f47a97046f87bf83b988191cb91e0486182c09e4d695e1ad2`
- `media.web_chat_review_bundle.v1.json` SHA-256: `96a8f5376daadb710916880c036c54154e28ccc63c05f15482cabc2d3bf465bc`

The exact source remains:

- source ID: `r16-demo-source`
- SHA-256: `7b484abef5de1569e1b7f91a5d780f17c6d687ef68b3c42c9e54375f4e5e434b`
- size: `763377` bytes

## Blinded A/B selection

R17 contains three eligible original MP4s. Candidate 1 and candidate 3 are byte-identical, so R18 selects the two distinct render byte identities:

- A = candidate-1 → `review-A.mp4`
- B = candidate-2 → `review-B.mp4`

The model-facing prompt contains only blind labels and generic filenames. Candidate IDs, Media producer SHA, source/render hashes, and other lineage remain in the machine package/handoff, not in the review prompt.

No transcode is needed for the exact R17 pair because both originals are far below the 500,000,000-byte working limit. The copied blinded files must remain byte-identical to the R17 attachment bytes. If a derivative is ever used, R18 requires the inherited R17 derivative provenance: original SHA/size, derivative SHA/size, exact transform settings/digest, and `derivative_for_model_review=true`.

## Prompt contract

`media.direct_model_review_prompt.v1` asks the reviewing model to use the actual attached MP4/audio as primary semantic evidence. Each actionable observation must contain:

```
attachment_label
start_ms
end_ms
defect_category
severity
evidence
description
proposed_edit
confidence
uncertainty
```

The required mapping is:

`timestamp -> defect -> severity/evidence -> proposed edit`

Coverage must report inspected ranges and notes while preserving:

- `uninspected_possible=true`
- `every_frame_inspected=false`

Pairwise output is requested as A, B, tie, or insufficient evidence. The prompt explicitly forbids claiming human ground truth, human labels, live platform evidence, or exhaustive frame/millisecond inspection.

## Bridge R25/R26 compatibility

The machine handoff binds:

- contract: `bridge.chat_file_attachment.v1`
- repository: `foto6/WebAIBridge`
- exact SHA: `bfe6b043460b6c0c3d712cbcc7e0c9772d6bd3af`
- R25 branch: `agent/bridge-r25-file-attachment-20261001`
- R26 branch: `agent/bridge-r26-file-attachment-rehearsal-20261002`
- exact working cap: `500000000` bytes/file
- `livePass=false`, no live deploy/cutover

Each blinded attachment descriptor contains path, expected SHA-256, expected size, and MIME type. R18 itself performs no browser/UI side effect.

## Growth R22/R23 compatibility

The package/handoff is bound to:

- repository: `foto6/video3`
- exact SHA: `0f6824d7c3962ccee572b21a4e1a343e6470c1a9`
- R22 branch: `agent/growth-r22-direct-video-critic-20261001`
- R23 branch: `agent/growth-r23-critic-reedit-adapter-20261002`
- critic: `growth.web_video_critic.v1`
- pairwise: `growth.web_video_critic_pairwise.v1`
- transport binding: `growth.web_video_attachment_transport_binding.r22.v1`

The handoff exposes the exact source, Media producer, candidate IDs, render SHA/size, render-export file SHA, attachment SHA/size and blind labels needed to form Growth inputs after an explicitly authorized review execution.

## Output files

`npm run verify:r18` builds:

```
.artifacts/r18-direct-model-review/
  review-A.mp4
  review-B.mp4
  media.direct_model_review_package.v1.json
  model-review-prompt.json
  bridge-growth-handoff.json
  media.direct_model_review_package.r18.evidence.json
```

The Actions artifact is intended for later Bridge attachment transport. R18 performs no live upload.

## Failure boundaries

R18 fails closed on missing attachment bytes, changed hashes/sizes, wrong source, stale/regenerated R17 lineage, oversized files, duplicate candidates/render bytes, non-generic model-facing names, derivative provenance mismatch, stale producer/artifact authority, or consumer-binding drift.

Media remains technical/provenance authority only. No model verdict is produced by this milestone.
