import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_RENDER_CONTRACT_VERSION,
  buildRenderPlan,
  handleMediaRenderRequest,
  parseMediaRenderRequest
} from "../src/index.js";

const fixtureUrl = new URL("../fixtures/media.render.v1.request.json", import.meta.url);

function fixtureRequest() {
  return JSON.parse(readFileSync(fixtureUrl, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("canonical media.render.v1 fixture matches direct render-plan fingerprint without execution", () => {
  const request = fixtureRequest();
  let executorCalls = 0;
  const executor = {
    run() {
      executorCalls += 1;
      throw new Error("executor must not run during media.render.v1 dry-run");
    }
  };

  const result = handleMediaRenderRequest(request, { executor });
  const direct = buildRenderPlan(request.timeline, request.exportSpec);

  assert.equal(result.contractVersion, MEDIA_RENDER_CONTRACT_VERSION);
  assert.equal(result.validation.ok, true);
  assert.equal(result.renderFingerprint, direct.fingerprint);
  assert.equal(result.dryRun, true);
  assert.equal(executorCalls, 0);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.doesNotMatch(JSON.stringify(result), /publish/i);
});

test("reordered tracks and items preserve media.render.v1 fingerprint", () => {
  const canonical = fixtureRequest();
  const reordered = clone(canonical);
  reordered.timeline.tracks.reverse();
  for (const track of reordered.timeline.tracks) track.items.reverse();

  const first = handleMediaRenderRequest(canonical);
  const second = handleMediaRenderRequest(reordered);

  assert.equal(first.renderFingerprint, second.renderFingerprint);
});

test("invalid timeline is rejected before executor invocation", () => {
  const request = fixtureRequest();
  request.timeline.version = 2;
  let executorCalls = 0;

  assert.throws(
    () => handleMediaRenderRequest(request, { executor: { run() { executorCalls += 1; } } }),
    /timeline\.version must be 1/
  );
  assert.equal(executorCalls, 0);
});

test("protected source and output paths are rejected lexically without execution", () => {
  const sourceRequest = fixtureRequest();
  sourceRequest.timeline.tracks[1].items[0].source.uri = "file:///E:/manhwa/private.mp4";

  assert.throws(
    () => handleMediaRenderRequest(sourceRequest),
    /protected path/
  );

  const outputRequest = fixtureRequest();
  outputRequest.outputPath = "e:/scratch/../manhwa/out.mp4";

  assert.throws(
    () => handleMediaRenderRequest(outputRequest),
    /protected path/
  );
});

test("media.render.v1 fails closed on version, live execution, and extra action fields", () => {
  const unknownVersion = fixtureRequest();
  unknownVersion.contractVersion = "media.render.v2";
  assert.throws(() => parseMediaRenderRequest(unknownVersion), /contractVersion must be media\.render\.v1/);

  const live = fixtureRequest();
  live.dryRun = false;
  assert.throws(() => parseMediaRenderRequest(live), /only supports dryRun=true/);

  const publishAttempt = fixtureRequest();
  publishAttempt.publishAction = "queue";
  assert.throws(() => parseMediaRenderRequest(publishAttempt), /unknown fields: publishAction/);
});
