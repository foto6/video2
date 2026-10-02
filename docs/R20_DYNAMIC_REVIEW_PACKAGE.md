# Media R20 dynamic R19 -> blinded review package

R20 generalizes the R18 blinded model-review package so current Media artifacts can enter the autonomous review loop without being tied to the frozen R17 demo.

## Accepted current inputs

Each of the two review candidates binds:

- exact source ID, path, SHA-256 and size;
- orchestration candidate ID;
- exact render path, SHA-256 and size;
- exact `media.render_export.v1` path, file SHA-256 and semantic digest;
- exact Media producer Git SHA;
- round number 0, 1 or 2;
- exact `media.editorial_reedit_application.v1` path, file SHA-256 and semantic digest for every re-edit candidate.

Round 0 candidates must not claim an R19 application. Round 1/2 candidates must have one, and R20 validates that the application output bytes, render-export SHA, source lineage and `handoff.reeditRound + 1` exactly match the candidate.

Both candidates must bind the same source bytes. Byte-identical render candidates are rejected before blinding.

## Deterministic blinding

Candidate IDs do not determine A/B. R20 sorts a sealed provenance tuple derived from render SHA/size, render-export digest, optional R19 application digest and round number, then assigns generic `review-A.mp4` and `review-B.mp4`.

The model-facing prompt is inherited from the R18 direct-video review protocol and contains only A/B filenames and review instructions. R20 verifies that candidate IDs, source IDs/hashes, render hashes, render-export hashes/digests, producer SHAs and R19 application hashes/digests do not occur in the model-facing prompt.

Complete provenance is retained in a machine-only sealed mapping. The mapping includes blind label, candidate ID, round, source lineage, render lineage, R15 export lineage, optional R19 re-edit lineage, exact normalized artifact paths and the packaged attachment identity. Its canonical digest is emitted in both the package and Bridge handoff.

## Original bytes and derivatives

If an MP4 is already within the 500,000,000 byte transport cap and no derivative is explicitly required, R20 copies the original bytes unchanged. SHA-256 and size must remain identical.

A review derivative can only be requested explicitly. The existing deterministic R17 derivative path is reused; its record includes `derivative_for_model_review=true`, original and derivative SHA/size, exact transform settings and settings digest.

R20 never invents or silently transcodes a review derivative.

## Review rounds

Two modes are supported:

- `initial_candidate_review`: both candidates are round 0.
- `targeted_reedit_review`: at least one candidate is a later round, with no gap larger than one round between compared candidates.

The maximum Media re-edit round remains 2.

## Bridge R29 handoff

At implementation time, `agent/bridge-r29-isolated-live-video-review-20261002` points to SHA `8b314bd020b05d90f6c45fa861727df5e78e5a39`, identical to exact-green Bridge R28, CI `36983797963`.

Therefore R20 targets the concrete transport request `bridge.existing_chat_video_review_request.v1`. The portable handoff carries the exact prompt digest, sealed mapping digest, target routing fields, and attachment basename/SHA/size/MIME. The R20 materializer produces the exact Bridge request with local file paths and re-verifies the bytes immediately before handoff.

No Bridge execute endpoint is called by Media.

## State boundary

A successful Media package has state:

`DYNAMIC_REVIEW_PACKAGE_READY`

Its declared downstream state after an actual Bridge-captured model response is:

`LIVE_MODEL_REVIEWED`

Media cannot emit `LIVE_MODEL_REVIEWED`. Every R20 package records:

- model review performed = false;
- live upload performed = false;
- provider publish performed = false;
- human quality = false.

## Reproduction

Run:

`npm run verify:r20`

The real rehearsal consumes the R19 talking-head fixture and actual R19-produced round-1 MP4. It also creates a second real R15-valid round-0 render from the same source, then builds:

1. an initial round-0 A/B package; and
2. a targeted package comparing the round-0 control to the R19 round-1 re-edit.

Both packages contain real `review-A.mp4` and `review-B.mp4`, prompt, sealed mapping, portable Bridge handoff, exact Bridge request and machine evidence under `.artifacts/r20-demo`.
