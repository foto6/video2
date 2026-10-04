import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FfmpegQaProbe,
  MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
  PersistentCandidateCache,
  buildArtifactManifest,
  buildR25Candidate4Checkpoint,
  buildR25Candidate4Decomposition,
  buildRenderPlan,
  buildSucceededRenderExport,
  buildTournamentCandidatePlans,
  candidateCacheIdentity,
  candidatePlanDigest,
  candidateRendererConfigDigest,
  captionsToSrt,
  compileFfmpegCommand,
  evaluateRenderQa,
  evaluateTournamentTechnicalGate,
  fingerprint,
  inspectShortformSources,
  renderExportDigest,
  sliceTimelineForR25Checkpoint,
  stableStringify,
  tournamentRequestIdentityDigest,
  validateR25Candidate4Checkpoint,
  validateRenderExport,
  validateTournamentCandidateManifest,
  writeRenderExportSidecar
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else out[key] = true;
  }
  return out;
}
function hashFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const bytes = readFileSync(filePath);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}
function writeStable(filePath, value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : stableStringify(value) + "\n", "utf8");
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    const prior = readFileSync(filePath);
    if (!prior.equals(bytes)) throw new Error(`R25 checkpoint replay conflict: ${filePath}`);
    return hashFile(filePath);
  }
  writeFileSync(filePath, bytes);
  return hashFile(filePath);
}
function allOperationTypes(graph) {
  return [...new Set(graph.operations.map((x) => x.type))].sort();
}
function parseRate(value) {
  const [n, d] = String(value ?? "").split("/").map(Number);
  return Number.isFinite(n) && Number.isFinite(d) && d ? Number((n / d).toFixed(6)) : null;
}
function ffprobeFacts(filePath) {
  const parsed = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,duration:format=duration",
    "-of", "json",
    filePath
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
  const video = (parsed.streams ?? []).find((x) => x.codec_type === "video");
  const audio = (parsed.streams ?? []).find((x) => x.codec_type === "audio");
  const formatMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  const videoMs = video?.duration ? Math.round(Number(video.duration) * 1000) : formatMs;
  const audioMs = audio?.duration ? Math.round(Number(audio.duration) * 1000) : (audio ? formatMs : null);
  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseRate(video?.r_frame_rate),
    durationMs: formatMs,
    videoDurationMs: videoMs,
    audioDurationMs: audioMs,
    avSyncDeltaMs: video && audio ? Math.abs(videoMs - audioMs) : null
  };
}
function verifyRuntimeManifest(root) {
  const manifestPath = path.join(root, "runtime.manifest.sha256");
  const manifestBytes = readFileSync(manifestPath);
  const lines = manifestBytes.toString("utf8").split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("runtime manifest is empty");
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) throw new Error(`invalid runtime manifest line: ${line}`);
    const expected = match[1];
    const relative = match[2].replace(/^\*/, "");
    const filePath = path.resolve(root, relative);
    const rel = path.relative(root, filePath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("runtime manifest path escape");
    const actual = hashFile(filePath);
    if (actual.sha256 !== expected) throw new Error(`runtime file digest mismatch: ${relative}`);
  }
  return createHash("sha256").update(manifestBytes).digest("hex");
}
function runFfmpeg(command) {
  const started = Date.now();
  execFileSync(command.binary, command.args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  return Date.now() - started;
}

const args = parseArgs(process.argv.slice(2));
const phase = args.phase;
if (!(phase === "assemble" || /^segment-[1-9][0-9]*$/.test(phase))) {
  throw new Error("--phase must be segment-N or assemble");
}
const root = path.resolve(args.root ?? path.join(repoRoot, ".artifacts", "r25-demo"));
const requestPath = path.join(root, "request.json");
const sourcePath = path.join(root, "source.mp4");
const runtimeRoot = path.join(root, "ci-ffmpeg-runtime");
if (!existsSync(requestPath) || !existsSync(sourcePath)) throw new Error("R25 request/source checkpoint missing");
if (!existsSync(runtimeRoot)) throw new Error("R25 checkpointed FFmpeg runtime missing");

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot, encoding: "utf8", windowsHide: true
}).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}
const runtimeManifestSha256 = verifyRuntimeManifest(runtimeRoot);
const request = JSON.parse(readFileSync(requestPath, "utf8"));
const sourceIdentity = hashFile(sourcePath);
if (sourceIdentity.sha256 !== request.source.sha256 || sourceIdentity.size !== request.source.size) {
  throw new Error("R25 source checkpoint drift");
}
const plans = buildTournamentCandidatePlans(request);
const planEntry = plans.find((entry) => entry.candidateId === "candidate-4");
if (!planEntry) throw new Error("candidate-4 plan missing");
const decomposition = buildR25Candidate4Decomposition({
  tournamentId: request.tournamentId,
  candidateId: planEntry.candidateId,
  producerSha,
  source: {
    sourceId: request.source.sourceId,
    sha256: request.source.sha256,
    size: request.source.size
  },
  operationGraphDigest: planEntry.operationGraphDigest,
  runtimeManifestSha256,
  timeline: planEntry.plan.timeline
});

const subRoot = path.join(root, "initial", "phases", "candidate-4-subphases");
const checkpointPath = (name) => path.join(subRoot, name, "r25-candidate4-checkpoint.json");
const outputPath = (name) => path.join(subRoot, name, "segment.mp4");

function loadCheckpoint(name, segment) {
  if (!existsSync(checkpointPath(name))) return null;
  return validateR25Candidate4Checkpoint(
    JSON.parse(readFileSync(checkpointPath(name), "utf8")),
    { decomposition, segment, outputPath: outputPath(name) }
  );
}

if (phase !== "assemble") {
  const segmentIndex = decomposition.segments.findIndex((entry) => entry.phase === phase);
  if (segmentIndex < 0) throw new Error(`decomposition segment missing: ${phase}`);
  const segment = decomposition.segments[segmentIndex];

  const inputs = [{
    kind: "source",
    sha256: sourceIdentity.sha256,
    size: sourceIdentity.size
  }];
  for (let index = 0; index < segmentIndex; index += 1) {
    const priorSegment = decomposition.segments[index];
    const prior = loadCheckpoint(priorSegment.phase, priorSegment);
    if (!prior) throw new Error(`${phase} requires verified ${priorSegment.phase} checkpoint`);
    const priorFile = hashFile(checkpointPath(priorSegment.phase));
    inputs.push({
      kind: "checkpoint",
      phase: priorSegment.phase,
      sha256: priorFile.sha256,
      size: priorFile.size
    });
  }

  const existing = loadCheckpoint(phase, segment);
  if (existing) {
    console.log("R25_CANDIDATE4_SUBPHASE", stableStringify({
      phase,
      reused: true,
      operationId: existing.operationId,
      output: existing.output,
      runtimeManifestSha256
    }));
    process.exit(0);
  }

  const timeline = sliceTimelineForR25Checkpoint(
    planEntry.plan.timeline,
    segment.startMs,
    segment.endMs
  );
  const out = outputPath(phase);
  mkdirSync(path.dirname(out), { recursive: true });
  const command = compileFfmpegCommand(timeline, planEntry.plan.exportSpec, out);
  const elapsedMs = runFfmpeg(command);
  const output = hashFile(out);
  const facts = ffprobeFacts(out);
  if (
    facts.hasVideo !== true ||
    facts.hasAudio !== true ||
    facts.width !== 1080 ||
    facts.height !== 1920 ||
    Math.abs((facts.fps ?? 0) - 30) >= 0.01
  ) throw new Error(`R25 ${phase} intermediate media shape invalid: ${stableStringify(facts)}`);
  const checkpoint = buildR25Candidate4Checkpoint({
    decomposition,
    segment,
    inputs,
    output,
    durationMs: facts.durationMs,
    elapsedMs
  });
  const checkpointIdentity = writeStable(checkpointPath(phase), checkpoint);
  console.log("R25_CANDIDATE4_SUBPHASE", stableStringify({
    phase,
    reused: false,
    operationId: checkpoint.operationId,
    output,
    checkpointSha256: checkpointIdentity.sha256,
    elapsedMs,
    runtimeManifestSha256
  }));
  process.exit(0);
}

const verifiedSegments = decomposition.segments.map((segment) => {
  const checkpoint = loadCheckpoint(segment.phase, segment);
  if (!checkpoint) throw new Error(`assemble requires verified ${segment.phase} checkpoint`);
  return checkpoint;
});

const candidateDir = path.join(root, "initial", "render-batch", "candidates", "candidate-4");
mkdirSync(candidateDir, { recursive: true });
const finalPath = path.join(candidateDir, "final.mp4");
const sidecarPath = path.join(candidateDir, "media.render_export.v1.json");
const candidateManifestPath = path.join(candidateDir, "media.tournament_candidate_manifest.r25.v1.json");
const phaseCheckpointPath = path.join(root, "initial", "phases", "candidate-4", "r25-phase-checkpoint.json");

const existingPhase = existsSync(phaseCheckpointPath)
  ? JSON.parse(readFileSync(phaseCheckpointPath, "utf8"))
  : null;
if (existingPhase && existsSync(finalPath) && existsSync(sidecarPath) && existsSync(candidateManifestPath)) {
  const manifest = validateTournamentCandidateManifest(JSON.parse(readFileSync(candidateManifestPath, "utf8")));
  const finalId = hashFile(finalPath);
  if (finalId.sha256 !== manifest.render.sha256 || finalId.size !== manifest.render.size) {
    throw new Error("candidate-4 final replay hash mismatch");
  }
  console.log("R25_CANDIDATE4_ASSEMBLE", stableStringify({
    reused: true,
    final: finalId,
    decompositionDigest: decomposition.decompositionDigest
  }));
  process.exit(0);
}

const concatList = path.join(subRoot, "concat.txt");
writeFileSync(
  concatList,
  decomposition.segments.map((segment) => outputPath(segment.phase))
    .map((value) => `file '${value.replaceAll("'", "'\\''")}'`)
    .join("\n") + "\n",
  "utf8"
);
const tempFinal = path.join(candidateDir, ".final.r25-segmented.partial.mp4");
const assemblyStarted = Date.now();
execFileSync("ffmpeg", [
  "-hide_banner", "-nostdin", "-y",
  "-f", "concat", "-safe", "0", "-i", concatList,
  "-map", "0:v:0", "-map", "0:a:0",
  "-map_metadata", "-1",
  "-c", "copy",
  "-movflags", "+faststart",
  "-f", "mp4",
  tempFinal
], {
  cwd: root,
  env: process.env,
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024
});
renameSync(tempFinal, finalPath);
const assemblyElapsedMs = Date.now() - assemblyStarted;
const finalId = hashFile(finalPath);

const probeTool = new FfmpegQaProbe({ sandboxRoot: root });
const probe = await probeTool.inspect(finalPath);
probe.sourceEvidence = await inspectShortformSources(planEntry.plan.timeline, {
  sandboxRoot: root,
  ffprobeBinary: "ffprobe"
});
const qa = evaluateRenderQa(planEntry.plan.timeline, probe);
if (!qa.passed) throw new Error(`candidate-4 assembled QA failed: ${stableStringify(qa)}`);

const renderPlan = buildRenderPlan(planEntry.plan.timeline, planEntry.plan.exportSpec);
const job = {
  id: `r25-${request.tournamentId}-candidate-4-segmented`,
  idempotencyKey: `r25c4:${decomposition.decompositionDigest}`,
  renderFingerprint: renderPlan.fingerprint,
  status: "succeeded",
  dryRun: false,
  timeline: planEntry.plan.timeline,
  exportSpec: planEntry.plan.exportSpec,
  outputPath: path.relative(root, finalPath).split(path.sep).join("/"),
  probe,
  qa,
  currentAttempt: { token: `r25c4-${decomposition.decompositionDigest.slice(0, 24)}` },
  createdAtMs: 0,
  scheduling: {
    profile: "standard",
    priorityClass: "normal",
    requirements: null
  }
};
const artifactManifest = buildArtifactManifest(job, {
  finalDigest: finalId,
  preparedDigest: finalId,
  preparedAtMs: 0,
  finalizedAtMs: 0,
  manifestCommittedAtMs: 0,
  finalizationMethod: "atomic_rename"
});
const renderExport = buildSucceededRenderExport({
  job,
  finalPath,
  artifactManifest,
  producerSha,
  ffprobeBinary: "ffprobe"
});
const sidecar = writeRenderExportSidecar(renderExport, sidecarPath);
const facts = ffprobeFacts(finalPath);
const gate = evaluateTournamentTechnicalGate({
  renderExport,
  ffprobeFacts: facts,
  expectAudio: request.source.expectAudio
});
if (!gate.passed) throw new Error("candidate-4 segmented technical gate failed");

const captionPath = path.join(candidateDir, "captions.srt");
const caption = writeStable(captionPath, captionsToSrt(planEntry.plan.timeline));
const candidateManifest = validateTournamentCandidateManifest({
  contractVersion: MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
  tournamentId: request.tournamentId,
  candidateId: planEntry.candidateId,
  roundNumber: 0,
  strategy: planEntry.strategy,
  source: {
    sourceId: request.source.sourceId,
    path: request.source.path,
    sha256: request.source.sha256,
    size: request.source.size
  },
  briefDigest: request.brief.digest,
  producerSha,
  operationGraph: planEntry.operationGraph,
  operationGraphDigest: planEntry.operationGraphDigest,
  declaredOperationTypes: allOperationTypes(planEntry.operationGraph),
  render: {
    path: path.relative(root, finalPath).split(path.sep).join("/"),
    sha256: finalId.sha256,
    size: finalId.size
  },
  renderExport: {
    path: path.relative(root, sidecarPath).split(path.sep).join("/"),
    fileSha256: sidecar.sha256,
    digest: renderExportDigest(validateRenderExport(renderExport))
  },
  ffprobe: facts,
  technicalGate: gate,
  captionSidecar: {
    path: path.relative(root, captionPath).split(path.sep).join("/"),
    sha256: caption.sha256,
    size: caption.size,
    mime: "application/x-subrip"
  },
  blindSeed: fingerprint({
    tournamentId: request.tournamentId,
    candidateId: planEntry.candidateId,
    operationGraphDigest: planEntry.operationGraphDigest,
    renderSha256: finalId.sha256
  }),
  humanQuality: false
});
writeStable(candidateManifestPath, candidateManifest);

const rendererConfigDigest = candidateRendererConfigDigest({ maxParallel: 2 });
const planDigest = candidatePlanDigest(planEntry.plan);
const cacheIdentityDigest = candidateCacheIdentity({
  source: { sha256: request.source.sha256, size: request.source.size },
  planDigest,
  rendererConfigDigest,
  producerSha
});
const cache = new PersistentCandidateCache({
  filePath: path.join(root, "initial", "candidate-cache.json")
});
cache.put(cacheIdentityDigest, {
  status: "succeeded",
  cacheIdentityDigest,
  planDigest,
  sourceSha256: request.source.sha256,
  rendererConfigDigest,
  producerSha,
  finalPath,
  sidecarPath,
  final: {
    sha256: finalId.sha256,
    size: finalId.size,
    renderExportSha256: sidecar.sha256
  },
  metrics: {
    probeCalls: 1,
    qaCalls: 1,
    processCalls: 4,
    renderExecutorCalls: 0,
    sourcePreflightProbeCalls: 0,
    renderExportProbeCalls: 2
  }
});

const segmentCheckpointEvidence = decomposition.segments.map((segment, index) => {
  const checkpointFile = hashFile(checkpointPath(segment.phase));
  return {
    phase: segment.phase,
    sha256: checkpointFile.sha256,
    output: verifiedSegments[index].output,
    elapsedMs: verifiedSegments[index].elapsedMs
  };
});
const phaseCheckpoint = {
  phase: "candidate-4",
  producerSha,
  requestIdentityDigest: tournamentRequestIdentityDigest(request),
  batchManifestDigest: null,
  metrics: {
    cacheHits: 1,
    renderCalls: 1,
    peakConcurrentCandidates: 1,
    detectorCalls: 1,
    probeCalls: 1,
    qaCalls: 1
  },
  batchCandidateIds: ["candidate-3", "candidate-4"],
  targetCandidateIds: ["candidate-4"],
  anchorCandidateId: "candidate-3",
  completedCandidateRerendered: false,
  renderDecomposition: {
    contractVersion: "media.r25.candidate4_segmented_render.v1",
    decompositionDigest: decomposition.decompositionDigest,
    runtimeManifestSha256,
    semanticOutputContract: "same frozen candidate-4 timeline/operation graph; segmented encoding at motion-safe existing video-item boundary; final byte hash frozen by this method",
    byteIdentityToLegacyUnsegmentedRenderClaimed: false,
    segmentCheckpoints: segmentCheckpointEvidence,
    final: finalId,
    assemblyElapsedMs
  },
  candidates: [{
    candidateId: candidateManifest.candidateId,
    manifestDigest: fingerprint(candidateManifest),
    renderSha256: candidateManifest.render.sha256,
    renderSize: candidateManifest.render.size,
    operationGraphDigest: candidateManifest.operationGraphDigest
  }],
  modelReviewPerformed: false,
  providerPublish: false,
  humanQuality: false
};
writeStable(phaseCheckpointPath, phaseCheckpoint);

console.log("R25_CANDIDATE4_ASSEMBLE", stableStringify({
  reused: false,
  final: finalId,
  renderExportSha256: sidecar.sha256,
  candidateManifestDigest: fingerprint(candidateManifest),
  decompositionDigest: decomposition.decompositionDigest,
  runtimeManifestSha256,
  assemblyElapsedMs,
  segmentElapsedMs: Object.fromEntries(
    verifiedSegments.map((checkpoint) => [checkpoint.phase, checkpoint.elapsedMs])
  ),
  completedCandidateRerendered: false,
  byteIdentityToLegacyUnsegmentedRenderClaimed: false
}));
