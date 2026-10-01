import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CandidateBatchRuntime,
  DeterministicProcessExecutor,
  FfmpegQaProbe,
  MEDIA_CANDIDATE_BATCH_VERSION,
  MEDIA_JOB_CONTRACT_VERSION,
  MediaJobProtocolV1,
  PersistentCandidateBatchStore,
  PersistentCandidateCache,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  ShortformFfmpegExecutor,
  buildFailedRenderExport,
  buildSucceededRenderExport,
  candidateBatchManifestDigest,
  candidateCacheIdentity,
  candidateRendererConfigDigest,
  requireRenderExportSidecar,
  stableStringify,
  writeRenderExportSidecar
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else out[key] = true;
  }
  return out;
}

function sha256File(filePath) {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}

function normalizeRelative(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`path escapes batch sandbox: ${filePath}`);
  }
  return relative;
}

function primarySourceUri(candidate) {
  const items = candidate.plan.timeline.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.items);
  const item = items.find((entry) => !["broll", "insert"].includes(entry.role)) ?? items[0];
  if (!item?.source?.uri) throw new Error(`candidate ${candidate.candidateId} has no primary source URI`);
  return item.source.uri;
}

const args = parseArgs(process.argv.slice(2));
if (!args.request) throw new Error("--request is required");

const requestPath = path.resolve(args.request);
const request = JSON.parse(readFileSync(requestPath, "utf8"));
if (request.contractVersion !== MEDIA_CANDIDATE_BATCH_VERSION) {
  throw new Error("request must use media.candidate_batch.v1");
}

const sandboxRoot = path.resolve(args["sandbox-root"] ?? path.dirname(requestPath));
const outputRoot = path.resolve(args["output-dir"] ?? path.join(sandboxRoot, ".r16-batch", request.batchId));
const maxParallel = Number(args["max-parallel"] ?? 2);
if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 2) {
  throw new Error("--max-parallel must be 1 or 2");
}
const actualRendererConfigDigest = candidateRendererConfigDigest({ maxParallel });
if (request.renderer?.configDigest !== actualRendererConfigDigest) {
  throw new Error(`renderer config digest mismatch: request=${request.renderer?.configDigest ?? null} actual=${actualRendererConfigDigest}`);
}
mkdirSync(outputRoot, { recursive: true });

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked-out HEAD ${producerSha}`);
}

const renderStore = new PersistentRenderJobStore({ filePath: path.join(outputRoot, "render-jobs.json") });
const processExecutor = new DeterministicProcessExecutor({
  defaultTimeoutMs: 180000,
  maxOutputBytes: 4 * 1024 * 1024
});
const renderer = new ShortformFfmpegExecutor({
  store: renderStore,
  sandboxRoot,
  executor: processExecutor
});
const probe = new FfmpegQaProbe({ store: renderStore, sandboxRoot });
const renderRuntime = new RenderRuntimeV2({
  store: renderStore,
  executor: renderer,
  probe,
  sandboxRoot,
  liveExecutionEnabled: true,
  maxConcurrency: 2,
  resourceLimits: { render: 1, probe: 1 },
  processTimeoutMs: 180000
});
const protocol = new MediaJobProtocolV1(renderRuntime);

const batchStore = new PersistentCandidateBatchStore({
  filePath: path.join(outputRoot, "candidate-batch-state.json")
});
const cache = new PersistentCandidateCache({
  filePath: path.resolve(args["cache-file"] ?? path.join(path.dirname(outputRoot), "candidate-cache.json"))
});

function resultProcessCount(job) {
  const sourceCount = job.probe?.sourceEvidence?.length ?? 0;
  const executorInvocations = job.telemetry?.sideEffects?.executorInvocations ?? 0;
  const probeInvocations = job.telemetry?.sideEffects?.probeInvocations ?? 0;
  const perProbe = 1 + (job.probe?.hasVideo ? 1 : 0) + (job.probe?.hasAudio ? 1 : 0) + sourceCount;
  return executorInvocations * (sourceCount + 1) + probeInvocations * perProbe;
}

async function executeCandidate({ candidate, request: batchRequest, cacheIdentityDigest }) {
  const candidateDir = path.join(outputRoot, "candidates", candidate.candidateId);
  mkdirSync(candidateDir, { recursive: true });
  const finalPath = path.join(candidateDir, "final.mp4");
  const outputPath = normalizeRelative(sandboxRoot, finalPath);
  const jobId = `r16-${batchRequest.batchId}-${candidate.candidateId}`;
  const idempotencyKey = `r16:${cacheIdentityDigest}`;

  await protocol.handle({
    contractVersion: MEDIA_JOB_CONTRACT_VERSION,
    action: "submit",
    idempotencyKey,
    request: {
      contractVersion: "media.render.v1",
      jobId,
      timeline: candidate.plan.timeline,
      exportSpec: candidate.plan.exportSpec,
      outputPath,
      dryRun: false
    }
  });

  let response = null;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    response = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId
    });
    if (response.terminal) break;
  }
  const job = renderStore.get(jobId);
  if (!job || !response?.terminal) throw new Error(`candidate ${candidate.candidateId} did not reach terminal state`);

  const sourceCount = job.probe?.sourceEvidence?.length ?? 0;
  const metrics = {
    probeCalls: job.telemetry?.sideEffects?.probeInvocations ?? 0,
    qaCalls: job.telemetry?.sideEffects?.qaEvaluations ?? 0,
    processCalls: resultProcessCount(job),
    renderExecutorCalls: job.telemetry?.sideEffects?.executorInvocations ?? 0,
    sourcePreflightProbeCalls: (job.telemetry?.sideEffects?.executorInvocations ?? 0) * sourceCount,
    renderExportProbeCalls: 0
  };

  if (job.status !== "succeeded") {
    const failureExport = buildFailedRenderExport({ job, producerSha });
    const sidecarPath = path.join(candidateDir, "media.render_export.v1.json");
    writeRenderExportSidecar(failureExport, sidecarPath);
    return {
      status: "failed",
      failure: job.failure ?? { code: "render_failed", message: "candidate render failed" },
      metrics
    };
  }

  const artifactManifest = renderRuntime.exportArtifactManifest(jobId);
  const renderExport = buildSucceededRenderExport({
    job,
    finalPath: job.resolvedOutputPath,
    artifactManifest,
    producerSha
  });
  const sidecarPath = path.join(candidateDir, "media.render_export.v1.json");
  const sidecar = writeRenderExportSidecar(renderExport, sidecarPath);
  requireRenderExportSidecar(job.resolvedOutputPath);
  metrics.renderExportProbeCalls = 2;
  metrics.processCalls += 2;

  return {
    status: "succeeded",
    cacheIdentityDigest,
    planDigest: candidate.planDigest,
    sourceSha256: batchRequest.source.sha256,
    rendererConfigDigest: batchRequest.renderer.configDigest,
    producerSha,
    finalPath: job.resolvedOutputPath,
    sidecarPath,
    final: {
      sha256: renderExport.artifact.sha256,
      size: renderExport.artifact.size,
      renderExportSha256: sidecar.sha256
    },
    metrics
  };
}

async function validateCachedCandidate(result, { candidate, request: batchRequest }) {
  if (!result || result.status !== "succeeded") throw new Error("cache entry is not successful");
  const expectedIdentity = candidateCacheIdentity({
    source: batchRequest.source,
    planDigest: candidate.planDigest,
    rendererConfigDigest: batchRequest.renderer.configDigest,
    producerSha
  });
  if (
    result.cacheIdentityDigest !== expectedIdentity ||
    result.planDigest !== candidate.planDigest ||
    result.sourceSha256 !== batchRequest.source.sha256 ||
    result.rendererConfigDigest !== batchRequest.renderer.configDigest ||
    result.producerSha !== producerSha
  ) throw new Error("cache identity mismatch");
  if (!existsSync(result.finalPath) || !existsSync(result.sidecarPath)) throw new Error("cached artifact/sidecar missing");

  const record = requireRenderExportSidecar(result.finalPath);
  const sidecarDigest = sha256File(result.sidecarPath);
  if (
    record.producer.sha !== producerSha ||
    record.artifact.sha256 !== result.final.sha256 ||
    record.artifact.size !== result.final.size ||
    sidecarDigest.sha256 !== result.final.renderExportSha256
  ) throw new Error("cached artifact or render export hash mismatch");
  const source = record.evidence?.sources?.items?.find((entry) =>
    entry.sha256 === batchRequest.source.sha256 && entry.size === batchRequest.source.size
  );
  if (!source) throw new Error("cached render export does not bind exact batch source");
  return result;
}

const batchRuntime = new CandidateBatchRuntime({
  store: batchStore,
  cache,
  producerSha,
  maxParallel,
  detectSource: async () => {
    const uri = primarySourceUri(request.candidates[0]);
    const sourcePath = path.resolve(sandboxRoot, uri);
    if (!existsSync(sourcePath)) throw new Error(`batch source missing: ${sourcePath}`);
    return sha256File(sourcePath);
  },
  executeCandidate,
  validateCachedCandidate
});

const result = await batchRuntime.run(request);
const manifestPath = path.join(outputRoot, "media.candidate_batch.v1.json");
writeFileSync(manifestPath, `${stableStringify(result.manifest)}\n`);

const evidence = {
  evidenceVersion: "media.candidate_batch.r16.evidence.v1",
  producer: { repository: "foto6/video2", sha: producerSha },
  manifestDigest: candidateBatchManifestDigest(result.manifest),
  manifestPath: path.basename(manifestPath),
  metrics: result.metrics,
  resourceEnvelope: {
    candidateParallelismLimit: maxParallel,
    observedPeakConcurrentCandidates: result.metrics.peakConcurrentCandidates,
    renderSlots: 1,
    probeSlots: 1,
    runtimeMaxConcurrency: 2,
    unboundedSpawning: false
  },
  candidateStatuses: result.manifest.candidates.map((entry) => ({
    order: entry.order,
    candidateId: entry.candidateId,
    status: entry.status,
    reused: result.state.candidates[entry.candidateId]?.reused === true
  }))
};
writeFileSync(
  path.join(outputRoot, "media.candidate_batch.r16.evidence.json"),
  `${stableStringify(evidence)}\n`
);

console.log("R16_CANDIDATE_BATCH", stableStringify({
  producerSha,
  batchId: result.manifest.batchId,
  status: result.manifest.status,
  manifestDigest: evidence.manifestDigest,
  metrics: result.metrics,
  resourceEnvelope: evidence.resourceEnvelope,
  candidates: evidence.candidateStatuses
}));
