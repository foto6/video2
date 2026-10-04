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
  MEDIA_SHORTFORM_PROFILE_VERSION,
  MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
  MEDIA_TOURNAMENT_EVIDENCE_VERSION,
  MEDIA_TOURNAMENT_REQUEST_VERSION,
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
  tournamentRequestIdentityDigest,
  validateRenderExport,
  validateTournamentCandidateManifest
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else out[key] = true;
  }
  return out;
}
function hashFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`R25 phased materializer missing: ${filePath}`);
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
    if (!prior.equals(bytes)) throw new Error(`R25 phased replay conflict: ${filePath}`);
    return hashFile(filePath);
  }
  writeFileSync(filePath, bytes);
  return hashFile(filePath);
}
function copyStable(source, target) {
  const expected = hashFile(source);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) {
    const actual = hashFile(target);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`R25 phased copied-file drift: ${target}`);
    }
  } else copyFileSync(source, target);
  return expected;
}
function rel(root, filePath) {
  const value = path.relative(root, filePath).split(path.sep).join("/");
  if (!value || value.startsWith("../") || path.isAbsolute(value)) throw new Error(`path escapes R25 root: ${filePath}`);
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
function allOperationTypes(graph) {
  return [...new Set(graph.operations.map((x) => x.type))].sort();
}
function runNode(script, args = []) {
  return execFileSync(process.execPath, [path.join(repoRoot, script), ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
}
function makeR21Candidate(manifest) {
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
const phase = args.phase;
if (!["pair-1", "pair-2", "finalize"].includes(phase)) throw new Error("--phase must be pair-1, pair-2 or finalize");
const root = path.resolve(args.root ?? path.join(repoRoot, ".artifacts", "r25-demo"));
mkdirSync(root, { recursive: true });
const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot, encoding: "utf8", windowsHide: true
}).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}

const sourcePath = path.join(root, "source.mp4");
const requestPath = path.join(root, "request.json");
if (phase === "pair-1") {
  if (!existsSync(sourcePath)) {
    execFileSync("ffmpeg", [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=6",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
      "-map", "0:v:0", "-map", "1:a:0", "-t", "6",
      "-map_metadata", "-1",
      "-metadata", "creation_time=1970-01-01T00:00:00Z",
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-threads", "1",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-f", "mp4",
      sourcePath
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  }
  const source = hashFile(sourcePath);
  const brief = {
    briefId: "r25-real-edit-brief",
    digest: fingerprint({
      goal: "deterministic four-way short-form edit tournament",
      caption: "EDIT SMARTER",
      pacing: "compare clean/aggressive/cinematic/kinetic",
      humanGroundTruth: false
    }),
    sentenceBoundariesMs: [0, 900, 1800, 3000, 4500, 6000],
    beatMarkersMs: [750, 1500, 2250, 3000, 3750, 4500, 5250],
    silenceRanges: [{ startMs: 1100, endMs: 1550 }],
    loopFriendly: false
  };
  const baseTimeline = {
    id: "r25-real-base",
    version: 1,
    profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
    canvas: { width: 1080, height: 1920, fps: 30, durationMs: 6000 },
    tracks: [
      {
        id: "video", kind: "video",
        items: [{
          id: "main", startMs: 0, endMs: 6000, role: "body",
          source: {
            id: "r25-real-source", uri: "source.mp4", inMs: 0, outMs: 6000,
            sha256: source.sha256, size: source.size
          }
        }]
      },
      {
        id: "caption", kind: "caption",
        items: [
          { id: "caption-1", startMs: 500, endMs: 1500, text: "EDIT SMARTER", style: { fontSize: 58, box: true } },
          { id: "caption-2", startMs: 3100, endMs: 4100, text: "KEEP THE BEST", style: { fontSize: 58, box: true } }
        ]
      },
      {
        id: "audio", kind: "audio",
        items: [{
          id: "voice", startMs: 0, endMs: 6000, role: "voiceover",
          source: {
            id: "r25-real-source", uri: "source.mp4", inMs: 0, outMs: 6000,
            sha256: source.sha256, size: source.size
          },
          gainDb: -3
        }]
      }
    ]
  };
  const exportSpec = {
    format: "mp4",
    videoCodec: "libx264",
    audioCodec: "aac",
    videoBitrate: "900k",
    audioBitrate: "128k",
    pixelFormat: "yuv420p",
    preset: "ultrafast",
    loudness: { integratedLufs: -16, truePeakDb: -1.5, lra: 11 }
  };
  writeStable(requestPath, {
    contractVersion: MEDIA_TOURNAMENT_REQUEST_VERSION,
    tournamentId: "r25-real-four-way",
    source: {
      sourceId: "r25-real-source",
      path: "source.mp4",
      sha256: source.sha256,
      size: source.size,
      durationMs: 6000,
      expectAudio: true
    },
    brief,
    roundNumber: 0,
    candidateCount: 4,
    baseTimeline,
    exportSpec
  });
}
if (!existsSync(sourcePath) || !existsSync(requestPath)) throw new Error("R25 phased source/request checkpoint missing");

const request = JSON.parse(readFileSync(requestPath, "utf8"));
const sourceIdentity = hashFile(sourcePath);
if (sourceIdentity.sha256 !== request.source.sha256 || sourceIdentity.size !== request.source.size) {
  throw new Error("R25 phased source checkpoint drift");
}
const plans = buildTournamentCandidatePlans(request);
const initialRoot = path.join(root, "initial");
mkdirSync(initialRoot, { recursive: true });

if (phase === "pair-1" || phase === "pair-2") {
  const indexes = phase === "pair-1" ? [0, 1] : [2, 3];
  const selected = indexes.map((index) => plans[index]);
  const phaseRoot = path.join(initialRoot, "phases", phase);
  const batchRoot = path.join(phaseRoot, "render-batch");
  const batchRequest = {
    contractVersion: MEDIA_CANDIDATE_BATCH_VERSION,
    batchId: `${request.tournamentId}-round-0-${phase}`,
    source: {
      sourceId: request.source.sourceId,
      sha256: request.source.sha256,
      size: request.source.size
    },
    renderer: { configDigest: candidateRendererConfigDigest({ maxParallel: 2 }) },
    candidates: selected.map((entry) => ({ candidateId: entry.candidateId, plan: entry.plan }))
  };
  const batchRequestPath = path.join(phaseRoot, "media.candidate_batch.r16.request.json");
  writeStable(batchRequestPath, batchRequest);
  const log = runNode("tools/run-r16-candidate-batch.mjs", [
    "--request", batchRequestPath,
    "--sandbox-root", root,
    "--output-dir", batchRoot,
    "--cache-file", path.join(initialRoot, "candidate-cache.json"),
    "--max-parallel", "2"
  ]);
  const batchManifest = JSON.parse(readFileSync(path.join(batchRoot, "media.candidate_batch.v1.json"), "utf8"));
  const batchEvidence = JSON.parse(readFileSync(path.join(batchRoot, "media.candidate_batch.r16.evidence.json"), "utf8"));
  if (batchManifest.status !== "succeeded") throw new Error(`R25 ${phase} batch failed`);

  const phaseCandidates = [];
  for (const planEntry of selected) {
    const terminal = batchManifest.candidates.find((x) => x.candidateId === planEntry.candidateId);
    if (!terminal || terminal.status !== "succeeded") throw new Error(`R25 ${phase} candidate failed: ${planEntry.candidateId}`);
    const srcDir = path.join(batchRoot, "candidates", planEntry.candidateId);
    const dstDir = path.join(initialRoot, "render-batch", "candidates", planEntry.candidateId);
    const finalSource = path.join(srcDir, "final.mp4");
    const exportSource = path.join(srcDir, "media.render_export.v1.json");
    const finalId = hashFile(finalSource);
    const exportFile = hashFile(exportSource);
    const renderExport = validateRenderExport(JSON.parse(readFileSync(exportSource, "utf8")));
    const facts = ffprobeFacts(finalSource);
    const gate = evaluateTournamentTechnicalGate({
      renderExport,
      ffprobeFacts: facts,
      expectAudio: request.source.expectAudio
    });
    if (!gate.passed) throw new Error(`R25 ${phase} technical gate failed: ${planEntry.candidateId}`);

    copyStable(finalSource, path.join(dstDir, "final.mp4"));
    copyStable(exportSource, path.join(dstDir, "media.render_export.v1.json"));
    const srt = captionsToSrt(planEntry.plan.timeline);
    const captionPath = path.join(dstDir, "captions.srt");
    const caption = writeStable(captionPath, srt);
    const graph = planEntry.operationGraph;
    const manifest = validateTournamentCandidateManifest({
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
      operationGraph: graph,
      operationGraphDigest: fingerprint(graph),
      declaredOperationTypes: allOperationTypes(graph),
      render: {
        path: rel(root, path.join(dstDir, "final.mp4")),
        sha256: finalId.sha256,
        size: finalId.size
      },
      renderExport: {
        path: rel(root, path.join(dstDir, "media.render_export.v1.json")),
        fileSha256: exportFile.sha256,
        digest: renderExportDigest(renderExport)
      },
      ffprobe: facts,
      technicalGate: gate,
      captionSidecar: {
        path: rel(root, captionPath),
        sha256: caption.sha256,
        size: caption.size,
        mime: "application/x-subrip"
      },
      blindSeed: fingerprint({
        tournamentId: request.tournamentId,
        candidateId: planEntry.candidateId,
        operationGraphDigest: fingerprint(graph),
        renderSha256: finalId.sha256
      }),
      humanQuality: false
    });
    writeStable(path.join(dstDir, "media.tournament_candidate_manifest.r25.v1.json"), manifest);
    phaseCandidates.push({
      candidateId: manifest.candidateId,
      manifestDigest: fingerprint(manifest),
      renderSha256: manifest.render.sha256,
      renderSize: manifest.render.size,
      operationGraphDigest: manifest.operationGraphDigest
    });
  }
  writeStable(path.join(phaseRoot, "r25-phase-checkpoint.json"), {
    phase,
    producerSha,
    requestIdentityDigest: tournamentRequestIdentityDigest(request),
    batchManifestDigest: batchEvidence.manifestDigest,
    metrics: batchEvidence.metrics,
    candidates: phaseCandidates,
    runnerLogSha256: createHash("sha256").update(log).digest("hex"),
    modelReviewPerformed: false,
    providerPublish: false,
    humanQuality: false
  });
  console.log("R25_PHASE", stableStringify({ phase, candidates: phaseCandidates, metrics: batchEvidence.metrics }));
  process.exit(0);
}

// Finalize initial bracket/package/archive with no render invocation.
const candidateManifests = plans.map((plan) => validateTournamentCandidateManifest(
  JSON.parse(readFileSync(
    path.join(initialRoot, "render-batch", "candidates", plan.candidateId, "media.tournament_candidate_manifest.r25.v1.json"),
    "utf8"
  ))
));
if (new Set(candidateManifests.map((m) => m.render.sha256)).size !== 4) throw new Error("R25 phased finalize duplicate render bytes");
if (new Set(candidateManifests.map((m) => fingerprint(m.operationGraph.operations))).size !== 4) {
  throw new Error("R25 phased finalize lacks structural diversity");
}
const phase1 = JSON.parse(readFileSync(path.join(initialRoot, "phases", "pair-1", "r25-phase-checkpoint.json"), "utf8"));
const phase2 = JSON.parse(readFileSync(path.join(initialRoot, "phases", "pair-2", "r25-phase-checkpoint.json"), "utf8"));
writeStable(path.join(initialRoot, "phased-checkpoints.json"), {
  contractVersion: "media.r25.rehearsal_checkpoints.v1",
  requestIdentityDigest: tournamentRequestIdentityDigest(request),
  phases: [phase1, phase2],
  completedCandidates: [...phase1.candidates, ...phase2.candidates],
  exactReplayProjection: {
    cacheHits: 4,
    renderCalls: 0,
    duplicateWorkAuthorized: false
  }
});

const bracket = buildTournamentBracket(candidateManifests, {
  tournamentId: request.tournamentId,
  roundNumber: 0
});
const matchPackages = [];
for (const match of bracket.matches.filter((x) => x.reviewPackageRequired)) {
  const ids = match.participants.map((x) => x.candidateId);
  const left = candidateManifests.find((x) => x.candidateId === ids[0]);
  const right = candidateManifests.find((x) => x.candidateId === ids[1]);
  const review = {
    contractVersion: "media.review_round_request.r21.v1",
    review: {
      mode: "initial",
      left: { candidate: makeR21Candidate(left), briefLineageDigest: request.brief.digest },
      right: { candidate: makeR21Candidate(right), briefLineageDigest: request.brief.digest }
    }
  };
  const matchRoot = path.join(initialRoot, "review-bracket", match.matchId);
  const reviewPath = path.join(matchRoot, "request.json");
  writeStable(reviewPath, review);
  const log = runNode("tools/build-r21-review-round.mjs", [
    "--request", reviewPath,
    "--sandbox-root", root,
    "--output-dir", matchRoot
  ]);
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
  finalResolution: { state: "AWAITING_SEMIFINAL_WINNERS", deterministicSlots: true }
};
writeStable(path.join(initialRoot, "media.review_tournament_bracket.r25.v1.json"), bracketRecord);

const payloadRoot = path.join(initialRoot, "payload");
mkdirSync(payloadRoot, { recursive: true });
for (const manifest of candidateManifests) {
  const srcDir = path.dirname(path.resolve(root, manifest.render.path));
  const dstDir = path.join(payloadRoot, "candidates", manifest.candidateId);
  copyStable(path.join(srcDir, "final.mp4"), path.join(dstDir, "final.mp4"));
  copyStable(path.resolve(root, manifest.renderExport.path), path.join(dstDir, "media.render_export.v1.json"));
  copyStable(path.resolve(root, manifest.captionSidecar.path), path.join(dstDir, "captions.srt"));
  copyStable(path.join(srcDir, "media.tournament_candidate_manifest.r25.v1.json"), path.join(dstDir, "media.tournament_candidate_manifest.r25.v1.json"));
}
copyStable(path.join(initialRoot, "media.review_tournament_bracket.r25.v1.json"), path.join(payloadRoot, "media.review_tournament_bracket.r25.v1.json"));
for (const pkg of matchPackages) {
  const src = path.join(initialRoot, "review-bracket", pkg.matchId);
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
const archivePath = path.join(initialRoot, "media-r25-tournament.tar");
const archive = createDeterministicTar(payloadRoot, payloadFiles, archivePath);
const parsed = readDeterministicTar(archivePath);
if (parsed.sha256 !== archive.sha256 || parsed.entries.size !== payloadFiles.length) {
  throw new Error("R25 phased deterministic archive verification failed");
}
const metrics = {
  detectorCalls: (phase1.metrics.detectorCalls ?? 0) + (phase2.metrics.detectorCalls ?? 0),
  renderCalls: (phase1.metrics.renderCalls ?? 0) + (phase2.metrics.renderCalls ?? 0),
  probeCalls: (phase1.metrics.probeCalls ?? 0) + (phase2.metrics.probeCalls ?? 0),
  qaCalls: (phase1.metrics.qaCalls ?? 0) + (phase2.metrics.qaCalls ?? 0),
  processCalls: (phase1.metrics.processCalls ?? 0) + (phase2.metrics.processCalls ?? 0),
  cacheHits: (phase1.metrics.cacheHits ?? 0) + (phase2.metrics.cacheHits ?? 0),
  staleCacheInvalidations: (phase1.metrics.staleCacheInvalidations ?? 0) + (phase2.metrics.staleCacheInvalidations ?? 0),
  peakConcurrentCandidates: Math.max(phase1.metrics.peakConcurrentCandidates ?? 0, phase2.metrics.peakConcurrentCandidates ?? 0),
  maxParallel: 2,
  wallTimeMs: (phase1.metrics.wallTimeMs ?? 0) + (phase2.metrics.wallTimeMs ?? 0)
};
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
  requestIdentityDigest: tournamentRequestIdentityDigest(request),
  source: request.source,
  briefDigest: request.brief.digest,
  roundNumber: 0,
  candidateCount: 4,
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
    phased: true,
    phaseManifestDigests: [phase1.batchManifestDigest, phase2.batchManifestDigest],
    metrics,
    resourceEnvelope: {
      candidateParallelismLimit: 2,
      observedPeakConcurrentCandidates: metrics.peakConcurrentCandidates,
      renderSlots: 1,
      probeSlots: 1,
      runtimeMaxConcurrency: 2,
      unboundedSpawning: false
    },
    replayProjection: {
      cacheHits: 4,
      renderCalls: 0,
      duplicateWorkAuthorized: false
    }
  },
  archive: { sha256: archive.sha256, size: archive.size, entries: archive.entries.length },
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false
};
writeStable(path.join(initialRoot, "media.edit_tournament.r25.evidence.json"), evidence);
console.log("R25_PHASE", stableStringify({ phase: "finalize", archive: evidence.archive, candidates: evidence.candidates }));
