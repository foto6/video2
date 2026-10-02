# Media R22 live review artifact

R22 materializes an exact R21 round-pair review bundle into a coordinator-consumable directory and deterministic archive for one explicitly authorized Bridge R31 execution.

## Output directory

Every R22 live-review bundle contains:

- `review-A.mp4`
- `review-B.mp4`
- `model-review-prompt.txt` — exact UTF-8 bytes sent to the model
- `media.review_round_bundle.r21.v1.json`
- `media.review_round_transport_handoff.r21.v1.json`
- `media.review_round_sealed_mapping.r21.v1.json`
- `media.live_review_authority_profile.r22.v1.json`
- `media.dynamic_review_handoff.v1.json` — exact operator handoff accepted by the current Bridge R31/R30 verifier
- `media.live_review_package_manifest.r22.v1.json`

The first three files are model-facing only by filename/content. Candidate IDs, baseline/challenger roles, producer hashes, source hashes and R19 lineage remain machine-side in the sealed mapping and authority data.

## Validation before export

R22 does not merely copy the R21 directory. The export command requires the exact `media.review_round_request.r21.v1` that produced the bundle, because R21 intentionally seals R19 digests while omitting the original application path from its exported mapping. R22 revalidates the request-bound evidence and then proves it matches the sealed R21 lineage:

1. source file SHA-256 and size;
2. candidate MP4 SHA-256 and size;
3. R15 `media.render_export.v1` file SHA and semantic digest against the exact MP4;
4. R19 `media.editorial_reedit_application.v1` file and semantic digest when present;
5. R19 output/render-export/parent lineage for targeted re-edit rounds;
6. same source + brief lineage across the pair;
7. distinct render bytes;
8. R21 sealed-mapping digest;
9. exact R21 transport handoff;
10. model-facing prompt leak checks.

A stale R15 sidecar, stale R19 application, mismatched mapping, byte-identical pair or unrelated lineage fails closed.

## Bridge R31 operator handoff

At this milestone the R31 branch:

`agent/bridge-r31-live-dynamic-operator-20261002`

points to `ceaee873231a8552c5b7324083baa800eec566a8`, the exact-green R30 dynamic transport implementation, CI `36993885456`. No divergent R31 wire format exists at this pin.

R22 therefore emits `media.dynamic_review_handoff.v1.json` with:

- exact Media producer SHA;
- producer round `R21`;
- exact R21 bundle-file SHA as the contract blob;
- Bridge package digest `bridge.dynamic_review_package.sha256.v1`;
- raw prompt file SHA and prompt-text SHA;
- exact A/B basename/path/SHA/size/MIME;
- sealed-mapping digest reference;
- source, brief, round and R21 package lineage.

This is directly consumable by the existing Bridge verifier using the extracted bundle directory, without editing any internal attachment or prompt path.

Media does not invoke the Bridge live command.

## Authority profile

`media.live_review_authority_profile.r22.v1.json` records:

- exact R22 producer SHA and CI run ID;
- exact R22 contract/schema/implementation/exporter/verifier Git blob IDs plus SHA-256 and byte size;
- exact-green R21 producer SHA, CI and contract/schema/implementation identities;
- exact Bridge R31/R30 head, CI and implementation/verifier/schema/documentation blob IDs;
- the no-model/no-upload/no-publish/no-human-quality boundary.

## Deterministic archive

The export command takes both `--source-bundle-root` and `--source-request`, then creates a deterministic USTAR archive:

- lexicographic file order;
- mtime 0;
- uid/gid 0;
- mode 0644;
- stable USTAR headers;
- two terminal zero blocks.

The archive SHA-256 and size are written to a detached `media.live_review_archive_index.r22.v1` record. The package manifest hashes every other file in the extracted bundle; its own raw SHA-256 is recorded by the detached archive index, avoiding a self-hash cycle.

A replay with identical inputs, producer SHA and CI run ID must reproduce identical directory bytes and archive SHA-256.

## Extraction verification

Before Bridge use:

```bash
node tools/verify-r22-live-review-artifact.mjs \
  --bundle-dir <extracted-bundle-dir> \
  --archive <bundle.tar> \
  --archive-index <bundle.archive-index.json>
```

The verifier checks:

- archive SHA-256/size;
- package-manifest SHA from the detached archive index;
- exact bundle file set;
- SHA-256/size/MIME for every payload file;
- R21 bundle/handoff/sealed-map identity;
- exact raw prompt bytes;
- exact blinded MP4 bytes;
- Bridge package digest and attachment identities.

Only verified bytes should be handed to Bridge.

## Reproduction

`npm run verify:r22`

The CI rehearsal uses actual R21/R19/R15 outputs and produces two artifacts:

- initial round: two real current round-0 candidates;
- round 1: prior baseline versus actual R19 re-edited challenger.

It deliberately corrupts one referenced R15 sidecar and one referenced R19 application in the ephemeral CI workspace, confirms R22 refuses export, then restores the original bytes exactly.

R22 never performs a model call, browser upload, provider publish, credential access or human-quality judgment.
