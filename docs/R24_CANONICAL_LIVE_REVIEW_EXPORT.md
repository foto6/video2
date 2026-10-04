# Media R24 canonical live review artifact export

R24 turns one exact R23 review-session package into one canonical, self-contained export that can be downloaded and independently verified before Bridge performs any browser mutation.

## Exact upstream authority

R24 accepts only the exact-green R23 Actions authority:

- repository: `foto6/video2`
- branch: `agent/media-r23-next-round-export-20261002`
- producer SHA: `78c6982a91d7e3e8c037cd9ce740ee077babdccc`
- CI run: `37007419237` — SUCCESS
- artifact ID: `11226183002`
- artifact name: `media-r23-review-session-package`
- artifact digest: `sha256:5170ada97f8c86421f4bee34c97fbfa5701bef74ef406f18889a1a790ae3ac66`

The upstream verifier checks that exact run, head SHA, conclusion, artifact ID/name/digest and expiration state before the accepted artifact is used.

## Canonical export shape

Each exported review round is:

```
<export-dir>/
  payload/
    review-A.mp4
    review-B.mp4
    model-facing-prompt.txt
    media.canonical_live_review_authority.r24.v1.json
    media.bridge_live_review_handoff.r24.v1.json
    media.canonical_live_review_package_manifest.r24.v1.json
    r23/
      media.review_session_package.r23.v1.json
      media.review_session_package.r23.evidence.json
    r21/
      media.review_round_bundle.r21.v1.json
      media.review_round_transport_handoff.r21.v1.json
      media.review_round_bundle.r21.evidence.json
    machine/
      r23/media.review_session_request.r23.v1.json
      r21/media.review_round_sealed_mapping.r21.v1.json
    nested/
      r22-operator/
        ... exact verified R22 operator directory ...
  media-r24-canonical-live-review.tar
  media.canonical_live_review_export.r24.v1.json
```

The top-level A/B MP4 files are exact bytes copied from the verified R23/R22 operator package. The raw model prompt is copied byte-for-byte. The sealed mapping remains under `machine/` and is never inserted into model-facing prompt content.

The entire original R22 operator directory is preserved under `nested/r22-operator/`, including its deterministic archive and operator manifest, so Bridge R31 can still consume the frozen R22/R31 shape without hand-editing Media paths.

## Digests

R24 records three distinct identities:

- `packageDigest`: SHA-256 fingerprint of canonical review/source/session/authority semantics.
- `payloadDirectory.digest`: SHA-256 fingerprint of the complete payload file inventory and file identities.
- `archive.sha256`: SHA-256 of the deterministic USTAR archive bytes.

The outer export index records all three, plus exact package-manifest, authority-profile and sanitized-Bridge-handoff file hashes.

The archive contains the complete `payload/` contents but does not contain its own digest, avoiding a self-referential hash. The outer index is the authority for archive identity.

## Independent verification

After downloading the Actions artifact, verify any round before browser mutation:

```bash
npm run verify:r24:dir -- --export-dir /path/to/round-0
```

Verification checks:

- outer export state and evidence boundary;
- package manifest file set, hashes, sizes and MIME;
- payload directory digest;
- deterministic archive entry set and every archived byte against the directory;
- exact R23 session/index/evidence hashes and source/brief/round lineage;
- R21 bundle/handoff/sealed mapping linkage;
- exact raw prompt bytes/digest and absence of sealed candidate/role identities;
- exact A/B MP4 SHA/size/MIME and non-identical render bytes;
- nested R22 operator directory with its existing verifier;
- R24 authority profile and exact accepted R23 authority;
- sanitized Bridge handoff without candidate IDs or baseline/challenger mapping.

Any mismatch fails closed.

## Bridge handoff

`media.bridge_live_review_handoff.r24.v1.json` includes:

- exact source ID/SHA/size;
- brief lineage digest;
- session ID/identity;
- mode and review round;
- exact prompt path/SHA/size/MIME;
- exact A/B paths/SHA/size/MIME;
- R24 package digest;
- sealed mapping digest and machine-side location, but not its contents;
- nested R22 operator directory/archive locations and expected R22 archive SHA;
- exact Bridge R31 authority inherited from the verified R22 operator package.

The handoff deliberately contains no candidate IDs, baseline/challenger role map or sealed mapping contents.

## Real rehearsal and Actions artifacts

`npm run verify:r24` consumes the exact accepted R23 artifact and exports:

- a real encoded-MP4 round-0 initial-review package;
- a real encoded-MP4 round-1 targeted-re-edit package.

Each export is materialized twice and must remain byte-identical on replay. Both archives are independently verified.

CI uploads `.artifacts/r24-demo` as `media-r24-canonical-live-review-export`. After upload, the workflow queries GitHub Actions and writes `.artifacts/r24-actions-readiness.json` containing the exact current run/head plus artifact ID, name, digest, size and the canonical archive/package identities. That runtime report is uploaded separately as `media-r24-ci-readiness`.

The footage is deterministic rehearsal media, not human ground truth. R24 records `modelReviewPerformed=false`, `liveModelReviewed=false`, `providerPublish=false`, and `humanQuality=false`.

No model call, browser mutation, provider publish, credentials, merge or release occurs.
