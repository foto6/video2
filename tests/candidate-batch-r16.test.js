import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CandidateBatchRuntime,
  MEDIA_CANDIDATE_BATCH_VERSION,
  PersistentCandidateBatchStore,
  PersistentCandidateCache,
  candidateBatchManifestDigest,
  candidateCacheIdentity,
  candidatePlanDigest,
  candidateRendererConfigDigest,
  stableStringify,
  validateCandidateBatchManifest,
  validateCandidateBatchRequest
} from "../src/index.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const PRODUCER_A = "1".repeat(40);
const PRODUCER_B = "2".repeat(40);

function plan(sourceSha = SHA_A, sourceSize = 100, variant = 0) {
  return {
    timeline: {
      id: `candidate-${variant}`,
      version: 1,
      profileVersion: "media.shortform_profile.r11.v1",
      canvas: { width: 1080, height: 1920, fps: 30, durationMs: 5000 },
      tracks: [{
        id: "video",
        kind: "video",
        items: [{
          id: "main",
          startMs: 0,
          endMs: 5000,
          role: "body",
          source: {
            id: "source",
            uri: "source.mp4",
            inMs: 0,
            outMs: 5000,
            sha256: sourceSha,
            size: sourceSize
          },
          ...(variant === 1 ? { motion: { type: "punch_in", zoom: 1.08 } } : {}),
          ...(variant === 2 ? { speed: 1.02 } : {})
        }]
      }]
    },
    exportSpec: {
      format: "mp4",
      videoCodec: "libx264",
      pixelFormat: "yuv420p",
      preset: "ultrafast"
    }
  };
}

function request({
  batchId = "batch-a",
  sourceSha = SHA_A,
  sourceSize = 100,
  maxParallel = 2,
  count = 3
} = {}) {
  return {
    contractVersion: MEDIA_CANDIDATE_BATCH_VERSION,
    batchId,
    source: { sourceId: "source", sha256: sourceSha, size: sourceSize },
    renderer: { configDigest: candidateRendererConfigDigest({ maxParallel }) },
    candidates: Array.from({ length: count }, (_, index) => ({
      candidateId: `candidate-${index + 1}`,
      plan: plan(sourceSha, sourceSize, index)
    }))
  };
}

function dirs() {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r16-"));
  return {
    root,
    storePath: path.join(root, "batch-state.json"),
    cachePath: path.join(root, "candidate-cache.json")
  };
}

function successResult(candidate, requestInput, producerSha, marker = "c") {
  const planDigest = candidatePlanDigest(candidate.plan);
  const identity = candidateCacheIdentity({
    source: requestInput.source,
    planDigest,
    rendererConfigDigest: requestInput.renderer.configDigest,
    producerSha
  });
  return {
    status: "succeeded",
    cacheIdentityDigest: identity,
    planDigest,
    sourceSha256: requestInput.source.sha256,
    rendererConfigDigest: requestInput.renderer.configDigest,
    producerSha,
    finalPath: `/tmp/${candidate.candidateId}/final.mp4`,
    sidecarPath: `/tmp/${candidate.candidateId}/media.render_export.v1.json`,
    final: {
      sha256: marker.repeat(64),
      size: 1000 + candidate.candidateId.length,
      renderExportSha256: "d".repeat(64)
    },
    metrics: { probeCalls: 1, qaCalls: 1, processCalls: 5 }
  };
}

function runtimeHarness({
  requestInput,
  producerSha = PRODUCER_A,
  maxParallel = 2,
  storePath,
  cachePath,
  execute,
  validateCached,
  detectSource
}) {
  return new CandidateBatchRuntime({
    store: new PersistentCandidateBatchStore({ filePath: storePath }),
    cache: new PersistentCandidateCache({ filePath: cachePath }),
    producerSha,
    maxParallel,
    executeCandidate: execute ?? (async ({ candidate, request: req }) => successResult(candidate, req, producerSha)),
    validateCachedCandidate: validateCached ?? (async (result) => result),
    detectSource: detectSource ?? (async () => ({
      sha256: requestInput.source.sha256,
      size: requestInput.source.size
    }))
  });
}

test("R16 request requires 2-4 ordered candidates bound to one exact primary source", () => {
  assert.doesNotThrow(() => validateCandidateBatchRequest(request({ count: 2 })));
  assert.doesNotThrow(() => validateCandidateBatchRequest(request({ count: 4 })));
  assert.throws(() => validateCandidateBatchRequest(request({ count: 1 })), /2-4 candidates/);
  assert.throws(() => validateCandidateBatchRequest(request({ count: 5 })), /2-4 candidates/);

  const wrong = request();
  wrong.candidates[1].plan.timeline.tracks[0].items[0].source.sha256 = SHA_B;
  assert.throws(() => validateCandidateBatchRequest(wrong), /primary source does not match/);
});

test("R16 bounded parallelism keeps sibling evidence independent on one failed candidate", async () => {
  const d = dirs();
  const req = request();
  let active = 0;
  let peak = 0;
  const runtime = runtimeHarness({
    requestInput: req,
    storePath: d.storePath,
    cachePath: d.cachePath,
    execute: async ({ candidate, request: runRequest }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      if (candidate.candidateId === "candidate-2") {
        return {
          status: "failed",
          failure: { code: "fixture_failure", message: "candidate two failed only" },
          metrics: { probeCalls: 0, qaCalls: 0, processCalls: 1 }
        };
      }
      return successResult(candidate, runRequest, PRODUCER_A);
    }
  });
  const result = await runtime.run(req);
  assert.equal(result.manifest.status, "partial_failure");
  assert.deepEqual(result.manifest.candidates.map((entry) => entry.status), ["succeeded", "failed", "succeeded"]);
  assert.equal(result.manifest.candidates[0].final.sha256, "c".repeat(64));
  assert.equal(result.manifest.candidates[2].final.sha256, "c".repeat(64));
  assert.equal(result.manifest.candidates[1].final, null);
  assert.equal(result.metrics.renderCalls, 3);
  assert.equal(result.metrics.peakConcurrentCandidates, 2);
  assert.equal(peak, 2);
  assert.ok(result.metrics.peakConcurrentCandidates <= 2);
  assert.doesNotThrow(() => validateCandidateBatchManifest(result.manifest));
});

test("R16 duplicate request and lost ACK replay produce identical canonical manifest with zero rerenders", async () => {
  const d = dirs();
  const req = request();
  let calls = 0;
  const runtime = runtimeHarness({
    requestInput: req,
    storePath: d.storePath,
    cachePath: d.cachePath,
    execute: async ({ candidate, request: runRequest }) => {
      calls += 1;
      return successResult(candidate, runRequest, PRODUCER_A);
    }
  });
  const first = await runtime.run(req);
  const firstBytes = stableStringify(first.manifest);
  assert.equal(calls, 3);
  const second = await runtime.run(req);
  assert.equal(calls, 3);
  assert.equal(second.metrics.renderCalls, 0);
  assert.equal(second.metrics.cacheHits, 3);
  assert.equal(stableStringify(second.manifest), firstBytes);
  assert.equal(candidateBatchManifestDigest(second.manifest), candidateBatchManifestDigest(first.manifest));
});

test("R16 restart recovers running to pending and resumes only incomplete candidates", async () => {
  const d = dirs();
  const req = request();
  const seedStore = new PersistentCandidateBatchStore({ filePath: d.storePath });
  const seeded = seedStore.initialize(req, PRODUCER_A);
  const firstCandidate = req.candidates[0];
  const firstResult = successResult(firstCandidate, req, PRODUCER_A);
  seedStore.putCandidate(firstCandidate.candidateId, {
    status: "succeeded",
    result: firstResult,
    reused: false,
    failure: null
  });
  seedStore.putCandidate(req.candidates[1].candidateId, { status: "running", attempts: 1 });

  const recovered = new PersistentCandidateBatchStore({ filePath: d.storePath });
  assert.equal(recovered.get().candidates["candidate-2"].status, "pending");
  assert.equal(recovered.get().candidates["candidate-1"].status, "succeeded");

  let renders = 0;
  const runtime = new CandidateBatchRuntime({
    store: recovered,
    cache: new PersistentCandidateCache({ filePath: d.cachePath }),
    producerSha: PRODUCER_A,
    maxParallel: 2,
    detectSource: async () => ({ sha256: SHA_A, size: 100 }),
    validateCachedCandidate: async (result) => result,
    executeCandidate: async ({ candidate, request: runRequest }) => {
      renders += 1;
      return successResult(candidate, runRequest, PRODUCER_A);
    }
  });
  const result = await runtime.run(req);
  assert.equal(renders, 2);
  assert.equal(result.metrics.renderCalls, 2);
  assert.equal(result.metrics.cacheHits, 1);
  assert.equal(result.manifest.status, "succeeded");
  assert.deepEqual(result.manifest.candidates.map((entry) => entry.order), [0, 1, 2]);
  assert.equal(seeded.requestDigest, result.state.requestDigest);
});

test("R16 stale/hash-mismatched cache is invalidated then rerendered through quality path", async () => {
  const d = dirs();
  const req = request({ count: 2 });
  const candidate = req.candidates[0];
  const identity = candidateCacheIdentity({
    source: req.source,
    planDigest: candidatePlanDigest(candidate.plan),
    rendererConfigDigest: req.renderer.configDigest,
    producerSha: PRODUCER_A
  });
  const cache = new PersistentCandidateCache({ filePath: d.cachePath });
  cache.put(identity, successResult(candidate, req, PRODUCER_A, "e"));

  let renders = 0;
  const runtime = new CandidateBatchRuntime({
    store: new PersistentCandidateBatchStore({ filePath: d.storePath }),
    cache,
    producerSha: PRODUCER_A,
    maxParallel: 2,
    detectSource: async () => ({ sha256: SHA_A, size: 100 }),
    validateCachedCandidate: async (result, context) => {
      if (context.candidate.candidateId === "candidate-1" && result.final.sha256 === "e".repeat(64)) {
        throw new Error("cached final hash mismatch");
      }
      return result;
    },
    executeCandidate: async ({ candidate: item, request: runRequest }) => {
      renders += 1;
      return successResult(item, runRequest, PRODUCER_A);
    }
  });
  const result = await runtime.run(req);
  assert.equal(result.metrics.staleCacheInvalidations, 1);
  assert.equal(result.metrics.renderCalls, 2);
  assert.equal(renders, 2);
  assert.equal(result.manifest.status, "succeeded");
});

test("R16 changed renderer config and changed source identity cannot hit prior cache", async () => {
  const d = dirs();
  const firstReq = request({ batchId: "first", maxParallel: 2, count: 2 });
  let renders = 0;
  const first = runtimeHarness({
    requestInput: firstReq,
    storePath: path.join(d.root, "first-state.json"),
    cachePath: d.cachePath,
    execute: async ({ candidate, request: runRequest }) => {
      renders += 1;
      return successResult(candidate, runRequest, PRODUCER_A);
    }
  });
  await first.run(firstReq);
  assert.equal(renders, 2);

  const configChanged = request({ batchId: "config-changed", maxParallel: 1, count: 2 });
  const second = runtimeHarness({
    requestInput: configChanged,
    storePath: path.join(d.root, "second-state.json"),
    cachePath: d.cachePath,
    maxParallel: 1,
    execute: async ({ candidate, request: runRequest }) => {
      renders += 1;
      return successResult(candidate, runRequest, PRODUCER_A);
    }
  });
  const secondResult = await second.run(configChanged);
  assert.equal(secondResult.metrics.cacheHits, 0);
  assert.equal(secondResult.metrics.renderCalls, 2);

  const sourceChanged = request({
    batchId: "source-changed",
    sourceSha: SHA_B,
    sourceSize: 101,
    maxParallel: 2,
    count: 2
  });
  const third = runtimeHarness({
    requestInput: sourceChanged,
    storePath: path.join(d.root, "third-state.json"),
    cachePath: d.cachePath,
    execute: async ({ candidate, request: runRequest }) => {
      renders += 1;
      return successResult(candidate, runRequest, PRODUCER_A, "f");
    }
  });
  const thirdResult = await third.run(sourceChanged);
  assert.equal(thirdResult.metrics.cacheHits, 0);
  assert.equal(thirdResult.metrics.renderCalls, 2);
  assert.equal(renders, 6);
});

test("R16 wrong detected source bytes fail before any candidate side effect", async () => {
  const d = dirs();
  const req = request({ count: 2 });
  let renders = 0;
  const runtime = runtimeHarness({
    requestInput: req,
    storePath: d.storePath,
    cachePath: d.cachePath,
    detectSource: async () => ({ sha256: SHA_B, size: 100 }),
    execute: async ({ candidate, request: runRequest }) => {
      renders += 1;
      return successResult(candidate, runRequest, PRODUCER_A);
    }
  });
  await assert.rejects(() => runtime.run(req), /detected source bytes do not match/);
  assert.equal(renders, 0);
});

test("R16 producer change invalidates persisted completion and cache identity", async () => {
  const d = dirs();
  const req = request({ count: 2 });
  let rendersA = 0;
  const first = runtimeHarness({
    requestInput: req,
    producerSha: PRODUCER_A,
    storePath: d.storePath,
    cachePath: d.cachePath,
    execute: async ({ candidate, request: runRequest }) => {
      rendersA += 1;
      return successResult(candidate, runRequest, PRODUCER_A);
    }
  });
  await first.run(req);
  assert.equal(rendersA, 2);

  let rendersB = 0;
  const second = runtimeHarness({
    requestInput: req,
    producerSha: PRODUCER_B,
    storePath: d.storePath,
    cachePath: d.cachePath,
    execute: async ({ candidate, request: runRequest }) => {
      rendersB += 1;
      return successResult(candidate, runRequest, PRODUCER_B);
    }
  });
  const result = await second.run(req);
  assert.equal(result.metrics.cacheHits, 0);
  assert.equal(result.metrics.renderCalls, 2);
  assert.equal(rendersB, 2);
  assert.equal(result.manifest.producer.sha, PRODUCER_B);
});

test("R16 rejects unbounded parallelism", () => {
  const d = dirs();
  assert.throws(() => new CandidateBatchRuntime({
    store: new PersistentCandidateBatchStore({ filePath: d.storePath }),
    cache: new PersistentCandidateCache({ filePath: d.cachePath }),
    producerSha: PRODUCER_A,
    executeCandidate: async () => ({}),
    validateCachedCandidate: async () => ({}),
    maxParallel: 3
  }), /maxParallel must be 1 or 2/);
});


test("R16 rejects duplicate candidate IDs and preserves declared order", async () => {
  const duplicate = request({ count: 2 });
  duplicate.candidates[1].candidateId = duplicate.candidates[0].candidateId;
  assert.throws(() => validateCandidateBatchRequest(duplicate), /candidate IDs must be unique/);

  const d = dirs();
  const ordered = request({ count: 4 });
  const runtime = runtimeHarness({
    requestInput: ordered,
    storePath: d.storePath,
    cachePath: d.cachePath
  });
  const result = await runtime.run(ordered);
  assert.deepEqual(
    result.manifest.candidates.map((entry) => [entry.order, entry.candidateId]),
    [[0, "candidate-1"], [1, "candidate-2"], [2, "candidate-3"], [3, "candidate-4"]]
  );
});

test("R16 changed plan digest cannot reuse prior cache", async () => {
  const d = dirs();
  const firstReq = request({ batchId: "plan-first", count: 2 });
  let renders = 0;
  const first = runtimeHarness({
    requestInput: firstReq,
    storePath: path.join(d.root, "plan-first-state.json"),
    cachePath: d.cachePath,
    execute: async ({ candidate, request: runRequest }) => {
      renders += 1;
      return successResult(candidate, runRequest, PRODUCER_A);
    }
  });
  await first.run(firstReq);
  assert.equal(renders, 2);

  const changed = request({ batchId: "plan-changed", count: 2 });
  changed.candidates[0].plan.timeline.tracks[0].items[0].motion = { type: "punch_in", zoom: 1.12 };
  const second = runtimeHarness({
    requestInput: changed,
    storePath: path.join(d.root, "plan-second-state.json"),
    cachePath: d.cachePath,
    execute: async ({ candidate, request: runRequest }) => {
      renders += 1;
      return successResult(candidate, runRequest, PRODUCER_A, candidate.candidateId === "candidate-1" ? "9" : "c");
    }
  });
  const result = await second.run(changed);
  assert.equal(result.metrics.renderCalls, 1);
  assert.equal(result.metrics.cacheHits, 1);
  assert.equal(renders, 3);
  assert.notEqual(
    result.manifest.candidates[0].planDigest,
    candidatePlanDigest(firstReq.candidates[0].plan)
  );
});

test("R16 conformance manifest pins exact blobs and canonical fixtures validate", () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(
    new URL("../conformance/media.candidate_batch.v1/manifest.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion, MEDIA_CANDIDATE_BATCH_VERSION);
  assert.deepEqual(manifest.bounds, {
    minCandidates: 2,
    maxCandidates: 4,
    maxCandidateParallelism: 2,
    renderSlots: 1,
    probeSlots: 1,
    runtimeMaxConcurrency: 2
  });
  for (const [name, pin] of Object.entries(manifest.pins)) {
    const actual = execFileSync("git", ["hash-object", pin.path], { cwd: root, encoding: "utf8" }).trim();
    assert.equal(actual, pin.gitBlobSha, name);
  }
  for (const fileName of ["canonical-success.json", "canonical-partial-failure.json"]) {
    const fixture = JSON.parse(readFileSync(
      new URL(`../conformance/media.candidate_batch.v1/fixtures/${fileName}`, import.meta.url),
      "utf8"
    ));
    assert.doesNotThrow(() => validateCandidateBatchManifest(fixture));
  }
});
