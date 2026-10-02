# Media R23 next-round review session package

R23 is the Creator-facing entrypoint that chains the frozen R21 round-pair builder into the frozen R22 live-review materializer in one command.

## Command

```
node tools/export-r23-next-round.mjs \
  --request /path/to/media.review_session_request.r23.v1.json \
  --sandbox-root /path/to/media-workspace \
  --output-dir /path/to/session/round-N \
  --producer-ci-run-id <exact-ci-run-id>
```

The command writes a request lock before any nested package mutation. Replaying the exact same request is byte-stable. Reusing the same session/round output directory with changed candidate or evidence bytes fails before R21/R22 output is touched.

## Inputs

Round 0 accepts exactly two round-0 candidates from the same source and brief lineage.

Targeted rounds 1 and 2 require:

- prior baseline candidate;
- new challenger candidate at exactly N+1;
- prior review package digest;
- prior sealed mapping digest;
- exact selected Growth envelope digest;
- exact Growth handoff digest;
- exact R15 render evidence;
- exact R19 application evidence on the challenger.

Candidate artifact paths must be confined relative paths. Byte-identical baseline/challenger renders, source drift, round skips, missing R19 evidence, stale R15/R19 evidence, wrong Growth handoff digest, and path traversal fail closed.

## Nested authorities

R21 output is built with the exact frozen R21 authority:

- SHA `d753e9e4c1f4448386608a1425232dbc1dba87ea`
- CI `36994000619`
- `media.review_round_bundle.r21.v1`

R22 materialization uses the exact green R22 authority:

- SHA `e82a7ac04f3758d0e3e21ea3d05265dbc2822132`
- CI `37001071721`
- artifact `11224061610`
- archive digest `sha256:d534f1656e22b72cf42531c827e66516965b4167549906521dee04edafd01734`

The R22 operator directory remains independently verifiable before browser mutation.

## Session index

`media.review_session_package.r23.v1.json` binds:

- source and brief lineage;
- review round and mode;
- selected Growth envelope digest;
- Growth handoff digest;
- baseline candidate/render identity;
- challenger candidate/render identity;
- exact R21 package/bundle/round-lineage digests;
- exact R22 operator-directory digest and deterministic archive SHA/size;
- blinded A/B attachment SHA/size/MIME;
- prompt digest;
- sealed mapping digest;
- exact R23 producer SHA and CI run ID.

The sealed mapping stays machine-side in the nested R21/R22 payload. Model-facing prompt bytes remain blinded.

## Rehearsal

`npm run verify:r23` performs real FFmpeg-backed rehearsals for:

- round 0 with two real current candidates;
- round 1 baseline vs the actual R19 re-edit;
- round 2 using the round-1 MP4 as the exact R19 parent for a second real re-edit.

Each round is exported twice to the same directory to prove byte-stable replay. A changed selected-envelope digest for the same session/round is also injected and must fail closed.

No model/browser/provider call occurs. `modelReviewPerformed=false`, `liveModelReviewed=false`, `providerPublish=false`, and `humanQuality=false`.
