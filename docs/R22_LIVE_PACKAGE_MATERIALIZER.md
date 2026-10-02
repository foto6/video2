# Media R22 live package materializer / operator bundle

R22 converts the exact green Media R21 round-pair Actions artifact into a self-contained operator directory for Bridge R30/R31. It does not rebuild the R21 bundle under an R22 SHA; the R21 bundle, handoff, sealed mapping, evidence, prompt JSON and A/B MP4 bytes remain byte-identical to the accepted R21 producer.

## Frozen source authority

R22 accepts only:

- Media R21 producer `d753e9e4c1f4448386608a1425232dbc1dba87ea`
- CI run `36994000619 SUCCESS`
- Actions artifact `11221240371`, `media-r21-round-pair-review`
- Actions archive digest `sha256:1036800923196882590ace62edbaa123ab4250b9d242e14adba909ba256ab022`
- contracts `media.review_round_bundle.r21.v1` and `media.review_round_transport_handoff.r21.v1`

The materializer recomputes the R21 package digest, prompt bytes/digest, sealed-mapping digest, evidence file bindings, A/B SHA/size/MIME and round lineage before copying anything.

## One-command materialization

```bash
npm run materialize:r22 -- \
  --r21-round-dir /path/to/extracted-r21/round-1 \
  --out-dir /path/to/operator-dir
```

The output directory is:

```
operator-dir/
  payload/
    review-A.mp4
    review-B.mp4
    model-review-prompt.txt.json
    model-facing-prompt.txt
    media.review_round_bundle.r21.v1.json
    media.review_round_transport_handoff.r21.v1.json
    media.review_round_sealed_mapping.r21.v1.json
    media.review_round_bundle.r21.evidence.json
    media.live_review_authority_profile.r22.v1.json
    media.live_review_package_manifest.r22.v1.json
  media-r22-live-package.tar
  media.live_review_operator_manifest.r22.v1.json
```

The R21 files and MP4s are copied byte-for-byte. `model-facing-prompt.txt` is the exact UTF-8 text from the R21 prompt JSON. It is checked against sealed candidate IDs, roles and lineage hashes. The sealed mapping is machine-side only.

## Independent verification

```bash
npm run verify:r22:dir -- --operator-dir /path/to/operator-dir
```

This independently verifies path confinement, every payload file SHA/size/MIME, package-manifest file-set digest, R21 package/prompt/sealed/evidence digests, R15/R19 round-1 lineage references, A/B names and <=500 MB cap, deterministic tar digest/content and all evidence-boundary flags.

To verify extraction before use:

```bash
npm run extract:r22 -- \
  --operator-dir /path/to/operator-dir \
  --out-dir /path/to/verified-extraction
```

The extractor parses the deterministic USTAR archive itself, rejects path escapes/duplicates/bad checksums, writes into a clean destination and compares every extracted byte against the already-verified payload.

## Bridge R31 consumption

R22 is pinned to the latest completed-green R31 authority used for this milestone:

- Bridge R31 SHA `31cfef82663d72d53e69e6345b50073ffcd461ca`
- CI `36997793086 SUCCESS`
- Media R21 operator implementation blob `38509af174fc25aa4229c084fc3cd9b2e35b539e`

The sanitized operator manifest does not contain sealed mapping entries. It provides the exact R31 media-preparation arguments relative to the operator directory:

- artifact dir: `payload`
- archive: `media-r22-live-package.tar`
- expected archive SHA-256: recorded in the manifest
- output dir: `r31-source`

Therefore the coordinator does not need to hand-edit attachment, prompt, bundle, mapping or archive paths.

## Deterministic archive

The payload is archived as deterministic USTAR: sorted paths, uid/gid 0, mtime 0 and fixed file modes. The SHA-256 is recorded in the operator manifest. Re-materializing the same R21 input at the same exact R22 producer/CI context must reproduce byte-identical payload metadata, archive and operator manifest; mismatches fail closed.

## Rehearsal

`npm run verify:r22` consumes the downloaded exact R21 Actions artifact and materializes both:

- `initial/` — the real initial two-candidate review pair
- `round-1/` — the real baseline-vs-R19-re-edit pair

Both contain actual `review-A.mp4` and `review-B.mp4` files from the accepted R21 evidence. The rehearsal materializes twice, independently verifies both directories, extracts/verifies both archives and records exact hashes under `.artifacts/r22-live-package/r22-readiness-evidence.json`.

No model call, browser mutation, provider upload/publish, credentials, human-quality judgment, merge or release occurs.
