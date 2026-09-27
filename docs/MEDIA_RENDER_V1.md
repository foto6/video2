# media.render.v1

`media.render.v1` is the Integration Round 1 JSON boundary around the existing Media Engine planning core.

## Request

The request has exactly these fields:

- `contractVersion`: exactly `media.render.v1`
- `jobId`: non-empty string
- `timeline`: existing timeline v1 object
- `exportSpec`: existing export options object
- `outputPath`: non-empty output path
- `dryRun`: exactly `true`

Round 1 is planning-only. The transport rejects `dryRun:false`; callers that need the existing live renderer continue to use `MediaEngine.render` directly.

The canonical request fixture is `fixtures/media.render.v1.request.json`.

## Result

A successful request returns JSON-compatible data with the same contract version, job id, `dryRun:true`, a validation outcome, the deterministic render fingerprint, and a compiled FFmpeg command for validation. Compiling the command does not invoke a process executor.

The integration result has no publishing state or action.

## Protected path

The transport rejects output paths and timeline source URIs that normalize under the protected Windows root named in the integration requirements. Detection is lexical only; the filesystem is never queried.

## Determinism

Timeline canonicalization and `buildRenderPlan` remain authoritative. Reordering tracks or items does not change the render fingerprint.
