# Media R21 round-pair review bundle

R21 adds deterministic comparison semantics above the exact-green R20 dynamic blinded package.

## Initial review

An initial bundle accepts exactly two round-0 candidates. Both must bind the same exact source ID/SHA-256/size and the same brief-lineage digest. R20 re-validates each real MP4 and its R15 render export before any review files are copied. Byte-identical candidates are rejected.

## Targeted re-edit review

Targeted mode accepts one baseline and one challenger. The challenger must be exactly round N+1, never more than round 2. A prior-selection record must identify the baseline candidate and baseline round.

The challenger must have a valid R19 editorial application. R21 requires the verified R19 application to bind:
- input render SHA = baseline render SHA;
- R19 handoff re-edit round = baseline round;
- challenger round = R19 re-edit round + 1.

Candidate identity is preserved without conflating namespaces. The baseline's review/orchestration candidate ID can be an alias created by R20, while the R19 application retains its original canonical input candidate ID. R21 records both `baselineReviewCandidateId` and `applicationParentCandidateId`, and the exact shared parent render SHA proves that they refer to the same reviewed bytes.

The sealed mapping preserves both identities plus the exact Growth handoff digest and Media application digest/file SHA for the child.

## Blinding

R21 delegates deterministic A/B assignment and byte packaging to R20. The model-facing prompt only describes blinded A/B files. R21 additionally rejects role leakage such as baseline/challenger/winner/parent/child, candidate IDs, brief digests, render identities, Growth handoff digests and Media application digests in model-facing prompt content.

All semantic roles and parent/child lineage remain machine-side in the sealed mapping.

## Transport-neutral Bridge R30 handoff

The handoff contract is `media.review_round_transport_handoff.r21.v1`. It contains:
- exact relative attachment path, SHA-256, size and MIME;
- exact prompt text, UTF-8 byte count and SHA-256;
- R21 package digest and sealed-mapping digest;
- exact source lineage and a content-addressed round-lineage digest.

It contains no ChatGPT profile/conversation target and performs no browser action.

At this Media pin, Bridge branch `agent/bridge-r30-dynamic-review-transport-20261002` is SHA `ed9a35290f94607d7577f1ee9301de1bb44334f2`, the same implementation proven green on R29 CI `36989658042`. That exact Bridge pin does not yet contain a native R30 round-pair consumer, so Media reports the handoff as transport-neutral and does not claim live R30 consumption.

## Rehearsal

Run:

`npm run verify:r21`

The demo consumes the actual R20/R19 talking-head artifacts. It produces:
1. an initial two-candidate round-0 package; and
2. a baseline-versus-real-R19-round-1 package.

Both contain real `review-A.mp4` and `review-B.mp4` files. The targeted rehearsal uses `fixture_rehearsal` prior-selection evidence solely to exercise lineage; it does not claim that a model or human selected the baseline.

Every successful package remains:
- `ROUND_PAIR_PACKAGE_READY`
- `modelReviewPerformed=false`
- `liveModelReviewed=false`
- `providerPublish=false`
- `humanQuality=false`.
