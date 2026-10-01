import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { fingerprint, stableStringify } from "./stable.js";
import { canonicalizeTimeline } from "./timeline.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_CANDIDATE_BATCH_VERSION = "media.candidate_batch.v1";
export const MEDIA_CANDIDATE_BATCH_STATE_VERSION = 1;
export const MEDIA_CANDIDATE_BATCH_CACHE_VERSION = 1;
export const R16_RENDERER_RESOURCE_PROFILE = Object.freeze({
  runtimeMaxConcurrency: 2,
  renderSlots: 1,
  probeSlots: 1
});

export function candidateRendererConfigDigest({ maxParallel = 2 } = {}) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 2) {
    throw new TypeError("maxParallel must be 1 or 2");
  }
  return fingerprint({
    contractVersion: MEDIA_CANDIDATE_BATCH_VERSION,
    renderContractVersion: "media.render.v1",
    renderExportContractVersion: "media.render_export.v1",
    maxParallel,
    ...R16_RENDERER_RESOURCE_PROFILE
  });
}

const TERMINAL = new Set(["succeeded", "failed"]);
const BATCH_MANIFEST_FIELDS = new Set([
  "contractVersion", "batchId", "source", "producer", "renderer",
  "requestDigest", "status", "candidates"
]);

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, fields, label) {
  if (!plain(value)) fail("candidate_batch_invalid", `${label} must be an object`);
  const expected = new Set(fields);
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length) fail("candidate_batch_invalid", `${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail("candidate_batch_invalid", `${label} unknown fields: ${extra.sort().join(", ")}`);
}
function nonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) fail("candidate_batch_invalid", `${label} must be non-empty`);
}
function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("candidate_batch_invalid", `${label} must be lowercase SHA-256 hex`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("candidate_batch_invalid", `${label} must be exact Git SHA`);
  }
}
function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail("candidate_batch_invalid", `${label} must be a positive integer`);
}
function atomicJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  writeFileSync(temp, `${stableStringify(value)}\n`, "utf8");
  renameSync(temp, filePath);
}
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function candidatePlanDigest(plan) {
  if (!plain(plan) || !plain(plan.timeline)) fail("candidate_batch_invalid", "candidate plan.timeline is required");
  return fingerprint({
    timeline: canonicalizeTimeline(plan.timeline),
    exportSpec: clone(plan.exportSpec ?? {})
  });
}

function primarySourceFromPlan(plan) {
  const timeline = canonicalizeTimeline(plan.timeline);
  const video = timeline.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.items)
    .find((item) => !["broll", "insert"].includes(item.role)) ??
    timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.items)[0] ??
    null;
  return video?.source ?? null;
}

export function validateCandidateBatchRequest(input) {
  if (!plain(input)) fail("candidate_batch_invalid", "candidate batch request must be an object");
  exactKeys(input, ["contractVersion", "batchId", "source", "renderer", "candidates"], "candidate batch request");
  if (input.contractVersion !== MEDIA_CANDIDATE_BATCH_VERSION) fail("candidate_batch_invalid", "contractVersion mismatch");
  nonEmpty(input.batchId, "batchId");

  exactKeys(input.source, ["sourceId", "sha256", "size"], "source");
  nonEmpty(input.source.sourceId, "source.sourceId");
  sha256(input.source.sha256, "source.sha256");
  positiveInt(input.source.size, "source.size");

  exactKeys(input.renderer, ["configDigest"], "renderer");
  sha256(input.renderer.configDigest, "renderer.configDigest");

  if (!Array.isArray(input.candidates) || input.candidates.length < 2 || input.candidates.length > 4) {
    fail("candidate_batch_invalid", "candidate batch must contain 2-4 candidates");
  }
  const ids = new Set();
  const candidates = input.candidates.map((candidate, order) => {
    exactKeys(candidate, ["candidateId", "plan"], `candidates[${order}]`);
    nonEmpty(candidate.candidateId, `candidates[${order}].candidateId`);
    if (ids.has(candidate.candidateId)) fail("candidate_batch_invalid", "candidate IDs must be unique");
    ids.add(candidate.candidateId);
    const planDigest = candidatePlanDigest(candidate.plan);
    const primary = primarySourceFromPlan(candidate.plan);
    if (!primary) fail("candidate_batch_wrong_source", `candidate ${candidate.candidateId} has no primary video source`);
    if (primary.sha256 !== input.source.sha256 || primary.size !== input.source.size) {
      fail("candidate_batch_wrong_source", `candidate ${candidate.candidateId} primary source does not match batch source`, {
        expectedSha256: input.source.sha256,
        actualSha256: primary.sha256 ?? null,
        expectedSize: input.source.size,
        actualSize: primary.size ?? null
      });
    }
    return {
      candidateId: candidate.candidateId,
      plan: {
        timeline: canonicalizeTimeline(candidate.plan.timeline),
        exportSpec: clone(candidate.plan.exportSpec ?? {})
      },
      order,
      planDigest
    };
  });

  return {
    contractVersion: MEDIA_CANDIDATE_BATCH_VERSION,
    batchId: input.batchId,
    source: clone(input.source),
    renderer: clone(input.renderer),
    candidates
  };
}

export function candidateCacheIdentity({ source, planDigest, rendererConfigDigest, producerSha }) {
  sha256(source?.sha256, "cache source.sha256");
  positiveInt(source?.size, "cache source.size");
  sha256(planDigest, "cache planDigest");
  sha256(rendererConfigDigest, "cache rendererConfigDigest");
  gitSha(producerSha, "cache producerSha");
  return fingerprint({
    sourceSha256: source.sha256,
    sourceSize: source.size,
    planDigest,
    rendererConfigDigest,
    producerSha
  });
}

export function candidateBatchRequestDigest(requestInput) {
  const request = validateCandidateBatchRequest(requestInput);
  return fingerprint({
    contractVersion: request.contractVersion,
    batchId: request.batchId,
    source: request.source,
    renderer: request.renderer,
    candidates: request.candidates.map((entry) => ({
      candidateId: entry.candidateId,
      order: entry.order,
      planDigest: entry.planDigest
    }))
  });
}

export class PersistentCandidateBatchStore {
  constructor({ filePath } = {}) {
    if (!filePath) throw new TypeError("filePath is required");
    this.filePath = path.resolve(filePath);
    this.state = null;
    if (existsSync(this.filePath)) {
      this.state = readJson(this.filePath);
      if (this.state?.version !== MEDIA_CANDIDATE_BATCH_STATE_VERSION) {
        fail("candidate_batch_state_corrupt", "unsupported candidate batch state version");
      }
      for (const entry of Object.values(this.state.candidates ?? {})) {
        if (entry.status === "running") entry.status = "pending";
      }
      atomicJson(this.filePath, this.state);
    }
  }

  initialize(requestInput, producerSha) {
    const request = validateCandidateBatchRequest(requestInput);
    gitSha(producerSha, "producerSha");
    const requestDigest = candidateBatchRequestDigest(request);
    if (this.state) {
      if (this.state.batchId !== request.batchId || this.state.requestDigest !== requestDigest) {
        fail("candidate_batch_conflict", "persisted batch ID is bound to different request content");
      }
      if (this.state.producerSha !== producerSha) {
        this.state.producerSha = producerSha;
        for (const candidate of request.candidates) {
          const entry = this.state.candidates[candidate.candidateId];
          entry.cacheIdentityDigest = candidateCacheIdentity({
            source: request.source,
            planDigest: candidate.planDigest,
            rendererConfigDigest: request.renderer.configDigest,
            producerSha
          });
          entry.status = "pending";
          entry.reused = false;
          entry.result = null;
          entry.failure = null;
        }
        atomicJson(this.filePath, this.state);
      }
      return clone(this.state);
    }
    const candidates = {};
    for (const candidate of request.candidates) {
      const cacheIdentityDigest = candidateCacheIdentity({
        source: request.source,
        planDigest: candidate.planDigest,
        rendererConfigDigest: request.renderer.configDigest,
        producerSha
      });
      candidates[candidate.candidateId] = {
        candidateId: candidate.candidateId,
        order: candidate.order,
        planDigest: candidate.planDigest,
        cacheIdentityDigest,
        status: "pending",
        attempts: 0,
        reused: false,
        result: null,
        failure: null
      };
    }
    this.state = {
      version: MEDIA_CANDIDATE_BATCH_STATE_VERSION,
      batchId: request.batchId,
      requestDigest,
      producerSha,
      source: request.source,
      rendererConfigDigest: request.renderer.configDigest,
      candidates
    };
    atomicJson(this.filePath, this.state);
    return clone(this.state);
  }

  get() {
    return this.state ? clone(this.state) : null;
  }

  putCandidate(candidateId, patch) {
    if (!this.state?.candidates?.[candidateId]) fail("candidate_batch_state_corrupt", `unknown candidate: ${candidateId}`);
    this.state.candidates[candidateId] = {
      ...this.state.candidates[candidateId],
      ...clone(patch)
    };
    atomicJson(this.filePath, this.state);
    return clone(this.state.candidates[candidateId]);
  }
}

export class PersistentCandidateCache {
  constructor({ filePath } = {}) {
    if (!filePath) throw new TypeError("filePath is required");
    this.filePath = path.resolve(filePath);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (existsSync(this.filePath)) {
      this.state = readJson(this.filePath);
      if (this.state?.version !== MEDIA_CANDIDATE_BATCH_CACHE_VERSION || !plain(this.state.entries)) {
        fail("candidate_cache_corrupt", "candidate cache state is invalid");
      }
    } else {
      this.state = { version: MEDIA_CANDIDATE_BATCH_CACHE_VERSION, entries: {} };
      atomicJson(this.filePath, this.state);
    }
  }
  get(identity) {
    const value = this.state.entries[identity];
    return value ? clone(value) : null;
  }
  put(identity, result) {
    this.state.entries[identity] = clone(result);
    atomicJson(this.filePath, this.state);
  }
  delete(identity) {
    if (Object.hasOwn(this.state.entries, identity)) {
      delete this.state.entries[identity];
      atomicJson(this.filePath, this.state);
    }
  }
}

function validateTerminalResult(result, candidateId) {
  if (!plain(result) || !TERMINAL.has(result.status)) {
    fail("candidate_batch_executor_invalid", `candidate ${candidateId} executor must return succeeded or failed terminal result`);
  }
  if (result.status === "succeeded") {
    exactKeys(result.final, ["sha256", "size", "renderExportSha256"], `candidate ${candidateId} final`);
    sha256(result.final.sha256, "final.sha256");
    positiveInt(result.final.size, "final.size");
    sha256(result.final.renderExportSha256, "final.renderExportSha256");
  } else if (!plain(result.failure)) {
    fail("candidate_batch_executor_invalid", `candidate ${candidateId} failed result requires failure`);
  }
  return clone(result);
}

export function buildCandidateBatchManifest({ request: requestInput, state, producerSha }) {
  const request = validateCandidateBatchRequest(requestInput);
  gitSha(producerSha, "producerSha");
  if (!state || state.requestDigest !== candidateBatchRequestDigest(request)) {
    fail("candidate_batch_state_corrupt", "state/request digest mismatch");
  }
  const candidates = request.candidates.map((candidate) => {
    const persisted = state.candidates[candidate.candidateId];
    if (!persisted || !TERMINAL.has(persisted.status)) {
      fail("candidate_batch_incomplete", `candidate ${candidate.candidateId} is not terminal`);
    }
    const result = persisted.result;
    const terminal = {
      order: candidate.order,
      candidateId: candidate.candidateId,
      planDigest: candidate.planDigest,
      cacheIdentityDigest: persisted.cacheIdentityDigest,
      status: persisted.status,
      reused: persisted.reused === true,
      final: null,
      failure: persisted.failure ? clone(persisted.failure) : null
    };
    if (persisted.status === "succeeded") {
      const validated = validateTerminalResult(result, candidate.candidateId);
      terminal.final = {
        fileName: "final.mp4",
        sha256: validated.final.sha256,
        size: validated.final.size,
        renderExportFileName: "media.render_export.v1.json",
        renderExportSha256: validated.final.renderExportSha256
      };
      terminal.failure = null;
    }
    return terminal;
  });
  const status = candidates.every((entry) => entry.status === "succeeded") ? "succeeded" : "partial_failure";
  return validateCandidateBatchManifest({
    contractVersion: MEDIA_CANDIDATE_BATCH_VERSION,
    batchId: request.batchId,
    source: clone(request.source),
    producer: { repository: "foto6/video2", sha: producerSha },
    renderer: { configDigest: request.renderer.configDigest },
    requestDigest: state.requestDigest,
    status,
    candidates
  });
}

export function validateCandidateBatchManifest(input) {
  const manifest = clone(input);
  exactKeys(manifest, BATCH_MANIFEST_FIELDS, "candidate batch manifest");
  if (manifest.contractVersion !== MEDIA_CANDIDATE_BATCH_VERSION) fail("candidate_batch_invalid", "manifest contractVersion mismatch");
  nonEmpty(manifest.batchId, "manifest.batchId");
  exactKeys(manifest.source, ["sourceId", "sha256", "size"], "manifest.source");
  sha256(manifest.source.sha256, "manifest.source.sha256");
  positiveInt(manifest.source.size, "manifest.source.size");
  exactKeys(manifest.producer, ["repository", "sha"], "manifest.producer");
  if (manifest.producer.repository !== "foto6/video2") fail("candidate_batch_invalid", "producer repository mismatch");
  gitSha(manifest.producer.sha, "manifest.producer.sha");
  exactKeys(manifest.renderer, ["configDigest"], "manifest.renderer");
  sha256(manifest.renderer.configDigest, "manifest.renderer.configDigest");
  sha256(manifest.requestDigest, "manifest.requestDigest");
  if (!["succeeded", "partial_failure"].includes(manifest.status)) fail("candidate_batch_invalid", "manifest status invalid");
  if (!Array.isArray(manifest.candidates) || manifest.candidates.length < 2 || manifest.candidates.length > 4) {
    fail("candidate_batch_invalid", "manifest must contain 2-4 candidates");
  }
  manifest.candidates.forEach((entry, order) => {
    exactKeys(entry, [
      "order", "candidateId", "planDigest", "cacheIdentityDigest",
      "status", "reused", "final", "failure"
    ], `manifest.candidates[${order}]`);
    if (entry.order !== order) fail("candidate_batch_invalid", "candidate order must be stable and contiguous");
    nonEmpty(entry.candidateId, "candidateId");
    sha256(entry.planDigest, "planDigest");
    sha256(entry.cacheIdentityDigest, "cacheIdentityDigest");
    if (!TERMINAL.has(entry.status)) fail("candidate_batch_invalid", "candidate status must be terminal");
    if (typeof entry.reused !== "boolean") fail("candidate_batch_invalid", "candidate reused must be boolean");
    if (entry.status === "succeeded") {
      if (!plain(entry.final) || entry.failure !== null) fail("candidate_batch_invalid", "succeeded candidate requires final and no failure");
      exactKeys(entry.final, [
        "fileName", "sha256", "size", "renderExportFileName", "renderExportSha256"
      ], "candidate final");
      if (entry.final.fileName !== "final.mp4" || entry.final.renderExportFileName !== "media.render_export.v1.json") {
        fail("candidate_batch_invalid", "candidate final filenames are not canonical");
      }
      sha256(entry.final.sha256, "candidate final.sha256");
      positiveInt(entry.final.size, "candidate final.size");
      sha256(entry.final.renderExportSha256, "candidate final.renderExportSha256");
    } else if (!plain(entry.failure) || entry.final !== null) {
      fail("candidate_batch_invalid", "failed candidate requires failure and no final");
    }
  });
  return manifest;
}

export function candidateBatchManifestDigest(manifest) {
  return fingerprint(validateCandidateBatchManifest(manifest));
}

export class CandidateBatchRuntime {
  constructor({
    store,
    cache,
    producerSha,
    executeCandidate,
    validateCachedCandidate,
    detectSource = null,
    maxParallel = 2,
    clock = () => Date.now()
  } = {}) {
    if (!store) throw new TypeError("store is required");
    if (!cache) throw new TypeError("cache is required");
    gitSha(producerSha, "producerSha");
    if (typeof executeCandidate !== "function") throw new TypeError("executeCandidate is required");
    if (typeof validateCachedCandidate !== "function") throw new TypeError("validateCachedCandidate is required");
    if (detectSource !== null && typeof detectSource !== "function") throw new TypeError("detectSource must be a function");
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 2) {
      throw new TypeError("maxParallel must be 1 or 2");
    }
    this.store = store;
    this.cache = cache;
    this.producerSha = producerSha;
    this.executeCandidate = executeCandidate;
    this.validateCachedCandidate = validateCachedCandidate;
    this.detectSource = detectSource;
    this.maxParallel = maxParallel;
    this.clock = clock;
  }

  async run(requestInput) {
    const request = validateCandidateBatchRequest(requestInput);
    const startedAt = this.clock();
    this.store.initialize(request, this.producerSha);
    const metrics = {
      detectorCalls: 0,
      renderCalls: 0,
      probeCalls: 0,
      qaCalls: 0,
      processCalls: 0,
      cacheHits: 0,
      staleCacheInvalidations: 0,
      peakConcurrentCandidates: 0,
      maxParallel: this.maxParallel,
      wallTimeMs: 0
    };

    if (this.detectSource) {
      metrics.detectorCalls += 1;
      const detected = await this.detectSource(request.source);
      if (!detected || detected.sha256 !== request.source.sha256 || detected.size !== request.source.size) {
        fail("candidate_batch_wrong_source", "detected source bytes do not match batch source");
      }
    }

    let cursor = 0;
    let active = 0;
    const work = request.candidates;

    const runOne = async (candidate) => {
      const state = this.store.get().candidates[candidate.candidateId];
      if (state.status === "succeeded") {
        try {
          const validated = validateTerminalResult(
            await this.validateCachedCandidate(state.result, { candidate, request, localState: true }),
            candidate.candidateId
          );
          metrics.cacheHits += 1;
          this.store.putCandidate(candidate.candidateId, { reused: true, result: validated });
          return;
        } catch {
          this.store.putCandidate(candidate.candidateId, {
            status: "pending", reused: false, result: null, failure: null
          });
          metrics.staleCacheInvalidations += 1;
        }
      } else if (state.status === "failed") {
        return;
      }

      const refreshed = this.store.get().candidates[candidate.candidateId];
      const cached = this.cache.get(refreshed.cacheIdentityDigest);
      if (cached) {
        try {
          const validated = validateTerminalResult(
            await this.validateCachedCandidate(cached, { candidate, request, localState: false }),
            candidate.candidateId
          );
          if (validated.status !== "succeeded") throw new Error("cache contains non-success result");
          metrics.cacheHits += 1;
          this.store.putCandidate(candidate.candidateId, {
            status: "succeeded", reused: true, result: validated, failure: null
          });
          return;
        } catch {
          this.cache.delete(refreshed.cacheIdentityDigest);
          metrics.staleCacheInvalidations += 1;
        }
      }

      this.store.putCandidate(candidate.candidateId, {
        status: "running",
        attempts: refreshed.attempts + 1,
        reused: false
      });
      active += 1;
      metrics.peakConcurrentCandidates = Math.max(metrics.peakConcurrentCandidates, active);
      metrics.renderCalls += 1;
      try {
        const result = validateTerminalResult(
          await this.executeCandidate({
            candidate,
            request,
            producerSha: this.producerSha,
            cacheIdentityDigest: refreshed.cacheIdentityDigest
          }),
          candidate.candidateId
        );
        metrics.probeCalls += result.metrics?.probeCalls ?? 0;
        metrics.qaCalls += result.metrics?.qaCalls ?? 0;
        metrics.processCalls += result.metrics?.processCalls ?? 0;
        if (result.status === "succeeded") {
          this.cache.put(refreshed.cacheIdentityDigest, result);
          this.store.putCandidate(candidate.candidateId, {
            status: "succeeded", reused: false, result, failure: null
          });
        } else {
          this.store.putCandidate(candidate.candidateId, {
            status: "failed", reused: false, result, failure: clone(result.failure)
          });
        }
      } catch (error) {
        const failure = {
          code: error?.code ?? "candidate_execution_failed",
          message: error?.message ?? String(error)
        };
        this.store.putCandidate(candidate.candidateId, {
          status: "failed",
          reused: false,
          result: { status: "failed", failure },
          failure
        });
      } finally {
        active -= 1;
      }
    };

    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= work.length) return;
        await runOne(work[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxParallel, work.length) }, () => worker()));

    const finalState = this.store.get();
    metrics.wallTimeMs = Math.max(0, this.clock() - startedAt);
    const manifest = buildCandidateBatchManifest({
      request,
      state: finalState,
      producerSha: this.producerSha
    });
    return {
      manifest,
      manifestDigest: candidateBatchManifestDigest(manifest),
      metrics,
      state: finalState
    };
  }
}
