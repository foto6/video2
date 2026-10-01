# Media R17 web-chat video review bundle

Contract: `media.web_chat_review_bundle.v1`.

R17 packages the **accepted R16 candidate artifact** for direct attachment to an agent's ChatGPT web chat. Media remains the technical authority only; the bundle contains no semantic/editorial model judgment.

## Two distinct authorities

The bundle deliberately separates:

- `review_bundle_producer`: the exact R17 Git SHA that verifies and packages attachments;
- `upstream_media_authority`: immutable accepted R16 evidence.

Accepted upstream authority:

- Media producer SHA: `231a0680c8939cfec77aaa283e507e93f383ad73`
- CI run: `36865890506`
- Actions artifact ID: `11163920921`
- artifact name: `media-r16-candidate-batch-demo`
- archive digest: `sha256:d929b592c76ec93e41b54701376f4b02366a3bdbd127d3472d73ae277d450d0f`

R17 must consume those accepted artifact bytes. Regenerating the R16 demo under the R17 SHA is not upstream evidence.

## Exact accepted R16 identities

Source:

- ID: `r16-demo-source`
- SHA-256: `7b484abef5de1569e1b7f91a5d780f17c6d687ef68b3c42c9e54375f4e5e434b`
- size: `763377`

Candidate batch:

- manifest file SHA-256: `44ab0a7dd761bbc79e554a21003b7e67b65b6e80b6c1b3830179caedab509872`
- semantic manifest digest: `ec75baee68bc73b8c8e1812dddbf6dbe5cc0dfdc4d0a66938a16c6db87536dbf`

Candidates:

| Candidate | final.mp4 SHA-256 | Size | R16 render-export file SHA-256 | R16 render-export semantic digest |
| --- | --- | ---: | --- | --- |
| candidate-1 | `3bd12d999264cb932cb3ef15dfbd96e002ede517f2273795b593553b9642d864` | 575465 | `2b5177c00bb054184a239c7eddb1383ad253922e8eb686f5aa2e56c91a1335ac` | `6a005607dd463643a908a35ce24f411ae74be4100c349a212bd70b59e449a2b5` |
| candidate-2 | `cdae63d5ccce67332e607af7fd87b18c31da8dc77c2f0ce5182550321767286c` | 576763 | `b349b897f8f86bc9257e2622f564d6430f3864ff605ae4b82ba0cb09c59298f6` | `47b7d0dcaaf0277274c1990825025042e89272dd153e3752b15d29a515041d82` |
| candidate-3 | `3bd12d999264cb932cb3ef15dfbd96e002ede517f2273795b593553b9642d864` | 575465 | `26fe61f0644e263ce047869334ba65c5973eba809ff45f76286490f573d61b8e` | `d31f45e0b29b1c002e8a9b3d52f54d69838ebcb902b04cfbde963cd82e2c2233` |

The bundle also preserves each accepted R16 technical-QA evidence SHA.

## CI consumption

R17 CI does not use a regenerated R16 demo as upstream evidence. It:

1. queries GitHub Actions metadata and verifies the exact R16 run is successful;
2. verifies exact artifact ID/name/archive digest;
3. downloads artifact ID `11163920921` from run `36865890506`;
4. re-hashes the extracted source, candidate batch manifest, each `final.mp4`, and each `media.render_export.v1.json`;
5. runs R15 exact-byte/ffprobe validation against the accepted MP4 and sidecar pair;
6. verifies exact R16 source evidence, producer SHA, render-export semantic digest and technical-QA evidence SHA;
7. copies eligible original MP4 bytes into the R17 review artifact and re-hashes the copies.

## 500 MB attachment rule

The per-file working limit is exactly **500,000,000 bytes**.

Original accepted R16 MP4 bytes are eligible only when their exact size is at or below that limit. Oversize originals remain preserved and are marked ineligible; they are never silently substituted.

A derivative is generated only when explicitly requested with `--transcode-oversize`. It is marked `derivative_for_model_review=true` and binds original SHA/size, derivative SHA/size, exact transform settings and settings digest.

## Failure semantics

R17 fails closed for wrong upstream producer/run/artifact ID/name/digest, wrong candidate-batch manifest hash/digest, missing/tampered MP4, wrong source, stale or regenerated sidecar provenance, wrong render-export digest, duplicate candidates, oversize attachments and derivative-provenance mismatch.

## Reproduction

After placing the accepted R16 artifact contents at `.artifacts/r16-accepted`:

```bash
npm run verify:r17
```

The output is:

```
.artifacts/r17-web-chat-review/media.web_chat_review_bundle.v1.json
.artifacts/r17-web-chat-review/media.web_chat_review_bundle.r17.evidence.json
.artifacts/r17-web-chat-review/attachments/candidate-1/final.mp4
.artifacts/r17-web-chat-review/attachments/candidate-2/final.mp4
.artifacts/r17-web-chat-review/attachments/candidate-3/final.mp4
```

No publishing, credentials acquisition, Creator/Growth mutation, live Bridge/PC modification, or model judgment is part of R17.
