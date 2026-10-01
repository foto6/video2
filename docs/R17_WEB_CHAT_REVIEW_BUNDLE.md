# Media R17 web-chat video review bundle

Contract: `media.web_chat_review_bundle.v1`.

R17 packages technically validated Media candidate outputs for direct attachment to an agent's ChatGPT web chat. Media remains the technical authority only; the bundle contains no semantic or editorial model judgment.

## Required identity

Every review candidate binds:

- exact source ID, SHA-256 and byte size;
- candidate ID and stable order from `media.candidate_batch.v1`;
- canonical `final.mp4` path/name, SHA-256 and byte size;
- exact `media.render_export.v1` semantic digest and sidecar file SHA-256;
- exact Media producer Git SHA;
- technical QA summary derived from the validated R15 export;
- explicit attachment eligibility.

The builder re-hashes the source and each candidate MP4, verifies the R16 manifest, verifies the R15 sidecar hash, re-runs R15 exact-byte validation, and checks the sidecar's source evidence and producer SHA.

## 500 MB attachment rule

The per-file working limit is exactly **500,000,000 bytes**.

Original candidate bytes are attachment-eligible only when their exact size is at or below that value. Oversize originals remain preserved and are marked ineligible; Media never silently substitutes different bytes.

An oversize derivative is created only when explicitly requested with `--transcode-oversize`. The derivative is deterministic and records:

- `derivative_for_model_review=true`;
- original SHA-256 and size;
- derivative SHA-256 and size;
- complete transform settings;
- transform-settings digest.

The current deterministic derivative profile is H.264/AAC, 720x1280, 30 fps, CRF 28, preset medium, AAC 128k, yuv420p, stripped metadata, one thread. A derivative that still exceeds 500,000,000 bytes fails closed.

## Failure semantics

The review bundle fails closed for missing files, changed MP4 bytes, wrong source bytes, stale or changed R15 sidecars, stale producer SHA, duplicate candidate IDs, oversize attachment attempts, and derivative provenance mismatch.

Original R16 candidate MP4s are never modified. Eligible originals are copied byte-for-byte into the review artifact and re-hashed after copying.

## Reproduction

```bash
npm run verify:r17
```

This runs the focused R17 suite, regenerates the real R16 three-candidate demo, and builds:

```
.artifacts/r17-web-chat-review/media.web_chat_review_bundle.v1.json
.artifacts/r17-web-chat-review/media.web_chat_review_bundle.r17.evidence.json
.artifacts/r17-web-chat-review/attachments/<candidateId>/final.mp4
```

The CI artifact is suitable for direct web-chat attachment of any eligible MP4. The machine manifest states whether each attached file is the original or an explicit derivative.

No publishing, credentials, Creator/Growth mutation, live Bridge/PC modification, or model judgment is part of R17.
