import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_CANDIDATE_BATCH_VERSION,
  MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
  MEDIA_TOURNAMENT_EVIDENCE_VERSION,
  TOURNAMENT_ROUND_READY,
  buildTournamentBracket,
  buildTournamentCandidatePlans,
  candidateRendererConfigDigest,
  captionsToSrt,
  createDeterministicTar,
  evaluateTournamentTechnicalGate,
  fingerprint,
  readDeterministicTar,
  renderExportDigest,
  stableStringify,
  validateRenderExport,
  validateTournamentCandidateManifest,
  validateTournamentRequest
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
    if (!prior.equals(bytes)) throw new Error(`R25 replay conflict: ${filePath}`);
    return { ...hashFile(filePath), replayed: true };
  }
  writeFileSync(filePath, bytes);
  return { ...hashFile(filePath), replayed: false };
}
function rel(root, filePath) {
  const value = path.relative(root, filePath).split(path.sep).join("/");
  if (!value || value.startsWith("../") || path.isAbsolute(value)) {
    throw new Error(`path escapes sandbox: ${filePath}`);
  }
  return value;
}
function listFiles(root) {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  walk(root);
  return out;
}
function parseRate(value) {
  const [n, d] = String(value ?? "").split("/").map(Number);
  return Number.isFinite(n) && Number.isFinite(d) && d !== 0 ? Number((n / d).toFixed(6)) : null;
}
function ffprobeFacts(filePath) {
  const parsed = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,duration:format=duration",
    "-of", "json",
    filePath
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
  const video = (parsed.streams ?? []).find((x) => x.codec_type === "video") ?? null;
  const audio = (parsed.streams ?? []).find((x) => x.codec_type === "audio") ?? null;
  const formatDurationMs = Number.isFinite(Number(parsed.format?.duration))
    ? Math.round(Number(parsed.format.duration) * 1000)
    : null;
  const videoDurationMs = Number.isFinite(Number(video?.duration))
    ? Math.round(Number(video.duration) * 1000)
    : formatDurationMs;
  const audioDurationMs = Number.isFinite(Number(audio?.duration))
    ? Math.round(Number(audio.duration) * 1000)
    : (audio ? formatDurationMs : null);
  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseRate(video?.r_frame_rate),
    durationMs: formatDurationMs,
    videoDurationMs,
    audioDurationMs,
    avSyncDeltaMs: video && audio && Number.isFinite(videoDurationMs) && Number.isFinite(audioDurationMs)
      ? Math.abs(videoDurationMs - audioDurationMs)
      : null
  };
}
function allOperationTypes(graph) {
  return [...new Set(graph.operations.map((x) => x.type))].sort();
}
function copyStable(source, target) {
  const expected = hashFile(source);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) {
    const actual = hashFile(target);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`R25 copied file drift: ${target}`);
    }
  } else copyFileSync(source, target);
  return expected;
}
function makeR21Candidate({ manifest, sandboxRoot }) {
  return {
    candidateId: manifest.candidateId,
    roundNumber: manifest.roundNumber,
    source: {
      sourceId: manifest.source.sourceId,
      sha256: manifest.source.sha256,
      size: manifest.source.size,
      path: manifest.source.path
    },
    render: {
      path: manifest.render.path,
      sha256: manifest.render.sha256,
      size: manifest.render.size
    },
    renderExport: {
      path: manifest.renderExport.path,
      fileSha256: manifest.renderExport.fileSha256,
      digest: manifest.renderExport.digest
    },
    renderProducerSha: manifest.producerSha,
    editorialApplication: null,
    reviewDerivative: null
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.request) throw new Error("--request is required");
const requestPath = path.resolve(args.request);
const request = validateTournamentRequest(JSON.parse(readFileSync(requestPath, "utf8")));
if (request.roundNumber !== 0) throw new Error("run-r25-tournament currently materializes initial tournament round 0");

const sandboxRoot = path.resolve(args["sandbox-root"] ?? path.dirname(requestPath));
const outputRoot = path.resolve(args["output-dir"] ?? path.join(sandboxRoot, ".r25-tournament", request.tournamentId));
const outRel = path.relative(sandboxRoot, outputRoot);
if (!outRel || outRel.startsWith("..") || path.isAbsolute(outRel)) throw new Error("output root escapes sandbox");
mkdirSync(outputRoot, { recursive: true });
process.chdir(sandboxRoot);

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}

const sourcePath = path.resolve(sandboxRoot, request.source.path);
if (rel(sandboxRoot, sourcePath) !== request.source.path.replaceAll("\\", "/")) {
  throw new Error("source path is not canonical within sandbox");
}
const sourceBytes = hashFile(sourcePath);
if (sourceBytes.sha256 !== request.source.sha256 || sourceBytes.size !== request.source.size) {
  throw new Error("source bytes differ from tournament source identity");
}

const statePath = path.join(outputRoot, "media.edit_tournament.r25.state.json");
const identityCore = {
  tournamentId: request.tournamentId,
  source: { sourceId: request.source.sourceId, sha256: request.source.sha256, size: request.source.size },
  briefDigest: request.brief.digest,
  roundNumber: request.roundNumber,
  candidateCount: request.candidateCount
};
const requestIdentityDigest = fingerprint(identityCore);
if (existsSync(statePath)) {
  const prior = JSON.parse(readFileSync(statePath, "utf8"));
  if (prior.requestIdentityDigest !== requestIdentityDigest) {
    throw new Error("R25 tournament identity conflict: source/brief/round/count changed");
  }
} else {
  writeStable(statePath, {
    version: 1,
    tournamentId: request.tournamentId,
    requestIdentityDigest,
    producerSha
  });
}

const candidates = buildTournamentCandidatePlans(request);
const r16Request = {
  contractVersion: MEDIA_CANDIDATE_BATCH_VERSION,
  batchId: `${request.tournamentId}-round-${request.roundNumber}`,
  source: {
    sourceId: request.source.sourceId,
    sha256: request.source.sha256,
    size: request.source.size
  },
  renderer: { configDigest: candidateRendererConfigDigest({ maxParallel: 2 }) },
  candidates: candidates.map((entry) => ({
    candidateId: entry.candidateId,
    plan: entry.plan
  }))
};
const r16RequestPath = path.join(outputRoot, "media.candidate_batch.r16.request.json");
writeStable(r16RequestPath, r16Request);
const batchRoot = path.join(outputRoot, "render-batch");
const r16Log = execFileSync(process.execPath, [
  path.join(repoRoot, "tools", "run-r16-candidate-batch.mjs"),
  "--request", r16RequestPath,
  "--sandbox-root", sandboxRoot,
  "--output-dir", batchRoot,
  "--max-parallel", "2"
], {
  cwd: repoRoot,
  env: process.env,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024
});
const batchManifest = JSON.parse(readFileSync(path.join(batchRoot, "media.candidate_batch.v1.json"), "utf8"));
const batchEvidence = JSON.parse(readFileSync(path.join(batchRoot, "media.candidate_batch.r16.evidence.json"), "utf8"));
if (batchManifest.status !== "succeeded") throw new Error("R25 requires every tournament candidate to pass R16");

const candidateManifests = [];
for (const planEntry of candidates) {
  const terminal = batchManifest.candidates.find((x) => x.candidateId === planEntry.candidateId);
  if (!terminal || terminal.status !== "succeeded") throw new Error(`candidate not succeeded: ${planEntry.candidateId}`);
  const candidateDir = path.join(batchRoot, "candidates", planEntry.candidateId);
  const finalPath = path.join(candidateDir, "final.mp4");
  const renderExportPath = path.join(candidateDir, "media.render_export.v1.json");
  const finalId = hashFile(finalPath);
  const renderExportFile = hashFile(renderExportPath);
  const renderExport = validateRenderExport(JSON.parse(readFileSync(renderExportPath, "utf8")));
  if (
    finalId.sha256 !== terminal.final.sha256 ||
    finalId.size !== terminal.final.size ||
    renderExportFile.sha256 !== terminal.final.renderExportSha256 ||
    renderExport.artifact.sha256 !== finalId.sha256 ||
    renderExport.artifact.size !== finalId.size ||
    renderExport.producer.sha !== producerSha
  ) throw new Error(`candidate lineage drift: ${planEntry.candidateId}`);

  const facts = ffprobeFacts(finalPath);
  const gate = evaluateTournamentTechnicalGate({
    renderExport,
    ffprobeFacts: facts,
    expectAudio: request.source.expectAudio
  });
  if (!gate.passed) throw new Error(`candidate technical gate failed: ${planEntry.candidateId}: ${stableStringify(gate)}`);

  const srt = captionsToSrt(planEntry.plan.timeline);
  const captionPath = path.join(candidateDir, "captions.srt");
  const captionWrite = writeStable(captionPath, srt);
  const operationGraph = planEntry.operationGraph;
  const manifest = validateTournamentCandidateManifest({
    contractVersion: MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
    tournamentId: request.tournamentId,
    candidateId: planEntry.candidateId,
    roundNumber: request.roundNumber,
    strategy: planEntry.strategy,
    source: {
      sourceId: request.source.sourceId,
      path: request.source.path,
      sha256: request.source.sha256,
      size: request.source.size
    },
    briefDigest: request.brief.digest,
    producerSha,
    operationGraph,
    operationGraphDigest: fingerprint(operationGraph),
    declaredOperationTypes: allOperationTypes(operationGraph),
    render: {
      path: rel(sandboxRoot, finalPath),
      sha256: finalId.sha256,
      size: finalId.size
    },
    renderExport: {
      path: rel(sandboxRoot, renderExportPath),
      fileSha256: renderExportFile.sha256,
      digest: renderExportDigest(renderExport)
    },
    ffprobe: facts,
    technicalGate: gate,
    captionSidecar: {
      path: rel(sandboxRoot, captionPath),
      sha256: captionWrite.sha256,
      size: captionWrite.size,
      mime: "application/x-subrip"
    },
    blindSeed: fingerprint({
      tournamentId: request.tournamentId,
      candidateId: planEntry.candidateId,
      operationGraphDigest: fingerprint(operationGraph),
      renderSha256: finalId.sha256
    }),
    humanQuality: false
  });
  writeStable(path.join(candidateDir, "media.tournament_candidate_manifest.r25.v1.json"), manifest);
  candidateManifests.push(manifest);
}

if (new Set(candidateManifests.map((x) => x.render.sha256)).size !== candidateManifests.length) {
  throw new Error("R25 tournament produced duplicate candidate bytes");
}
if (new Set(candidateManifests.map((x) => fingerprint(x.operationGraph.operations))).size !== candidateManifests.length) {
  throw new Error("R25 tournament candidate diversity is not structural");
}

const bracket = buildTournamentBracket(candidateManifests, {
  tournamentId: request.tournamentId,
  roundNumber: request.roundNumber
});
const matchPackages = [];
for (const match of bracket.matches.filter((x) => x.reviewPackageRequired)) {
  const ids = match.participants.map((x) => x.candidateId);
  if (ids.some((x) => !x)) throw new Error("reviewable match contains unresolved winner slot");
  const left = candidateManifests.find((x) => x.candidateId === ids[0]);
  const right = candidateManifests.find((x) => x.candidateId === ids[1]);
  const review = {
    contractVersion: "media.review_round_request.r21.v1",
    review: {
      mode: "initial",
      left: { candidate: makeR21Candidate({ manifest: left, sandboxRoot }), briefLineageDigest: request.brief.digest },
      right: { candidate: makeR21Candidate({ manifest: right, sandboxRoot }), briefLineageDigest: request.brief.digest }
    }
  };
  const matchRoot = path.join(outputRoot, "review-bracket", match.matchId);
  const reviewPath = path.join(matchRoot, "request.json");
  writeStable(reviewPath, review);
  const log = execFileSync(process.execPath, [
    path.join(repoRoot, "tools", "build-r21-review-round.mjs"),
    "--request", reviewPath,
    "--sandbox-root", sandboxRoot,
    "--output-dir", matchRoot
  ], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  const evidence = JSON.parse(readFileSync(path.join(matchRoot, "media.review_round_bundle.r21.evidence.json"), "utf8"));
  matchPackages.push({
    matchId: match.matchId,
    stage: match.stage,
    packageDigest: evidence.packageDigest,
    sealedMappingDigest: evidence.sealedMappingDigest,
    promptDigest: evidence.promptDigest,
    attachments: evidence.attachments,
    logSha256: createHash("sha256").update(log).digest("hex")
  });
}

const bracketRecord = {
  ...bracket,
  reviewPackages: matchPackages,
  finalResolution: bracket.matches.find((x) => x.stage === "final")?.reviewPackageRequired === false
    ? { state: "AWAITING_SEMIFINAL_WINNERS", deterministicSlots: true }
    : { state: "REVIEW_PACKAGE_READY", deterministicSlots: true }
};
writeStable(path.join(outputRoot, "media.review_tournament_bracket.r25.v1.json"), bracketRecord);

const payloadRoot = path.join(outputRoot, "payload");
mkdirSync(payloadRoot, { recursive: true });
for (const manifest of candidateManifests) {
  const srcDir = path.dirname(path.resolve(sandboxRoot, manifest.render.path));
  const dstDir = path.join(payloadRoot, "candidates", manifest.candidateId);
  copyStable(path.join(srcDir, "final.mp4"), path.join(dstDir, "final.mp4"));
  copyStable(path.resolve(sandboxRoot, manifest.renderExport.path), path.join(dstDir, "media.render_export.v1.json"));
  copyStable(path.resolve(sandboxRoot, manifest.captionSidecar.path), path.join(dstDir, "captions.srt"));
  copyStable(path.join(srcDir, "media.tournament_candidate_manifest.r25.v1.json"), path.join(dstDir, "media.tournament_candidate_manifest.r25.v1.json"));
}
copyStable(path.join(outputRoot, "media.review_tournament_bracket.r25.v1.json"), path.join(payloadRoot, "media.review_tournament_bracket.r25.v1.json"));
for (const pkg of matchPackages) {
  const src = path.join(outputRoot, "review-bracket", pkg.matchId);
  const dst = path.join(payloadRoot, "review-bracket", pkg.matchId);
  for (const name of [
    "review-A.mp4", "review-B.mp4",
    "model-review-prompt.txt.json",
    "media.review_round_bundle.r21.v1.json",
    "media.review_round_sealed_mapping.r21.v1.json",
    "media.review_round_transport_handoff.r21.v1.json",
    "media.review_round_bundle.r21.evidence.json"
  ]) copyStable(path.join(src, name), path.join(dst, name));
}

const payloadFiles = listFiles(payloadRoot);
const archivePath = path.join(outputRoot, "media-r25-tournament.tar");
const archive = createDeterministicTar(payloadRoot, payloadFiles, archivePath);
const parsedArchive = readDeterministicTar(archivePath);
if (parsedArchive.sha256 !== archive.sha256 || parsedArchive.size !== archive.size || parsedArchive.entries.size !== payloadFiles.length) {
  throw new Error("R25 deterministic archive verification failed");
}
for (const name of payloadFiles) {
  const original = readFileSync(path.join(payloadRoot, name));
  const archived = parsedArchive.entries.get(name);
  if (!archived || !archived.equals(original)) throw new Error(`R25 archive entry mismatch: ${name}`);
}

const evidence = {
  evidenceVersion: MEDIA_TOURNAMENT_EVIDENCE_VERSION,
  state: TOURNAMENT_ROUND_READY,
  producer: { repository: "foto6/video2", sha: producerSha },
  acceptedR24Authority: {
    producerSha: "244acdf154741e669991b17df3ef2a47e2dfdfa9",
    ciRunId: 37195239582,
    artifactId: 11301055747,
    artifactDigest: "sha256:fc5c9b9635d49b643e66efafe602d21ce1ef695a553f81a797bdf16d7b8cf228"
  },
  tournamentId: request.tournamentId,
  requestIdentityDigest,
  source: request.source,
  briefDigest: request.brief.digest,
  roundNumber: request.roundNumber,
  candidateCount: candidateManifests.length,
  candidates: candidateManifests.map((m) => ({
    candidateId: m.candidateId,
    strategy: m.strategy,
    manifestDigest: fingerprint(m),
    renderSha256: m.render.sha256,
    renderSize: m.render.size,
    operationGraphDigest: m.operationGraphDigest,
    technicalGatePassed: m.technicalGate.passed,
    avSyncDeltaMs: m.ffprobe.avSyncDeltaMs
  })),
  bracket: {
    digest: fingerprint(bracketRecord),
    matches: bracketRecord.matches,
    reviewPackages: matchPackages
  },
  r16: {
    manifestDigest: batchEvidence.manifestDigest,
    metrics: batchEvidence.metrics,
    resourceEnvelope: batchEvidence.resourceEnvelope,
    runnerLogSha256: createHash("sha256").update(r16Log).digest("hex")
  },
  archive: {
    sha256: archive.sha256,
    size: archive.size,
    entries: archive.entries.length
  },
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false
};
writeFileSync(path.join(outputRoot, "media.edit_tournament.r25.evidence.json"), stableStringify(evidence) + "\n");
console.log("R25_TOURNAMENT", stableStringify(evidence));
