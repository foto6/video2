import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_SHORTFORM_PROFILE_VERSION,
  MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
  MEDIA_TOURNAMENT_REQUEST_VERSION,
  R19_GROWTH_R23_AUTHORITY,
  buildMulticandidateRoundAuthority,
  buildOperationGraph,
  buildTournamentCandidatePlans,
  captionsToSrt,
  compileEditorialReeditPlan,
  createDeterministicTar,
  evaluateTournamentTechnicalGate,
  fingerprint,
  readDeterministicTar,
  renderExportDigest,
  stableStringify,
  validateRenderExport,
  validateTargetedTournamentReedit,
  validateTournamentCandidateManifest
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, ".artifacts", "r25-demo");
if (process.env.R25_DEMO_RESET === "1") {
  rmSync(root, { recursive: true, force: true });
}
mkdirSync(root, { recursive: true });

function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}
function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, stableStringify(value) + "\n");
}
function rel(filePath) {
  const value = path.relative(root, filePath).split(path.sep).join("/");
  if (!value || value.startsWith("../") || path.isAbsolute(value)) throw new Error("path escapes R25 demo root");
  return value;
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
function gitBlob(relativePath) {
  return execFileSync("git", ["hash-object", relativePath], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  }).trim();
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
  ], { encoding: "utf8", windowsHide: true }));
  const video = (parsed.streams ?? []).find((x) => x.codec_type === "video");
  const audio = (parsed.streams ?? []).find((x) => x.codec_type === "audio");
  const formatMs = Math.round(Number(parsed.format.duration) * 1000);
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
function operationTypes(graph) {
  return [...new Set(graph.operations.map((x) => x.type))].sort();
}
function r21Candidate(manifest, application = null) {
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
    editorialApplication: application,
    reviewDerivative: null
  };
}

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot, encoding: "utf8", windowsHide: true
}).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}
const initialPrematerialized = process.env.R25_INITIAL_PREMATERIALIZED === "1";

const sourcePath = path.join(root, "source.mp4");
if (!initialPrematerialized) {
  execFileSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=6",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
    "-map", "0:v:0", "-map", "1:a:0",
    "-t", "6",
    "-map_metadata", "-1",
    "-metadata", "creation_time=1970-01-01T00:00:00Z",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-threads", "1",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    "-f", "mp4",
    sourcePath
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  
}
if (!existsSync(sourcePath)) throw new Error("R25 prematerialized source checkpoint missing");
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
      id: "video",
      kind: "video",
      items: [{
        id: "main",
        startMs: 0,
        endMs: 6000,
        role: "body",
        source: {
          id: "r25-real-source",
          uri: "source.mp4",
          inMs: 0,
          outMs: 6000,
          sha256: source.sha256,
          size: source.size
        }
      }]
    },
    {
      id: "caption",
      kind: "caption",
      items: [
        { id: "caption-1", startMs: 500, endMs: 1500, text: "EDIT SMARTER", style: { fontSize: 58, box: true } },
        { id: "caption-2", startMs: 3100, endMs: 4100, text: "KEEP THE BEST", style: { fontSize: 58, box: true } }
      ]
    },
    {
      id: "audio",
      kind: "audio",
      items: [{
        id: "voice",
        startMs: 0,
        endMs: 6000,
        role: "voiceover",
        source: {
          id: "r25-real-source",
          uri: "source.mp4",
          inMs: 0,
          outMs: 6000,
          sha256: source.sha256,
          size: source.size
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
const request = {
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
};
const requestPath = path.join(root, "request.json");
writeJson(requestPath, request);

const initialRoot = path.join(root, "initial");
let firstEvidence;
let firstArchive;
let replayProjection;
if (initialPrematerialized) {
  firstEvidence = JSON.parse(readFileSync(
    path.join(initialRoot, "media.edit_tournament.r25.evidence.json"),
    "utf8"
  ));
  firstArchive = hashFile(path.join(initialRoot, "media-r25-tournament.tar"));
  const phased = JSON.parse(readFileSync(path.join(initialRoot, "phased-checkpoints.json"), "utf8"));
  if (
    phased.exactReplayProjection?.cacheHits !== 4 ||
    phased.exactReplayProjection?.renderCalls !== 0 ||
    phased.exactReplayProjection?.duplicateWorkAuthorized !== false
  ) throw new Error("R25 prematerialized checkpoint replay projection mismatch");
  replayProjection = {
    source: "validated-phased-r16-checkpoints",
    candidateCount: phased.completedCandidates?.length ?? 0,
    ...phased.exactReplayProjection,
    completedCandidateHashes: (phased.completedCandidates ?? []).map((entry) => ({
      candidateId: entry.candidateId,
      renderSha256: entry.renderSha256,
      cacheIdentityDigest: entry.cacheIdentityDigest ?? null
    }))
  };
} else {
  const firstLog = runNode("tools/run-r25-tournament.mjs", [
    "--request", requestPath,
    "--sandbox-root", root,
    "--output-dir", initialRoot
  ]);
  firstEvidence = JSON.parse(readFileSync(path.join(initialRoot, "media.edit_tournament.r25.evidence.json"), "utf8"));
  firstArchive = hashFile(path.join(initialRoot, "media-r25-tournament.tar"));
  copyFileSync(path.join(initialRoot, "media.edit_tournament.r25.evidence.json"), path.join(root, "first-run-evidence.json"));

  const checkpointState = JSON.parse(readFileSync(
    path.join(initialRoot, "render-batch", "candidate-batch-state.json"),
    "utf8"
  ));
  const checkpointCache = JSON.parse(readFileSync(
    path.join(initialRoot, "candidate-cache.json"),
    "utf8"
  ));
  const checkpointCandidates = Object.values(checkpointState.candidates ?? {})
    .sort((a, b) => a.order - b.order);
  if (checkpointCandidates.length !== 4 || checkpointCandidates.some((entry) => entry.status !== "succeeded")) {
    throw new Error("R25 checkpoint must contain four succeeded candidates");
  }
  for (const entry of checkpointCandidates) {
    if (!checkpointCache.entries?.[entry.cacheIdentityDigest]) {
      throw new Error(`R25 checkpoint cache missing completed candidate: ${entry.candidateId}`);
    }
  }
  replayProjection = {
    source: "validated-persistent-r16-state-and-cache",
    candidateCount: checkpointCandidates.length,
    cacheHits: checkpointCandidates.length,
    renderCalls: 0,
    duplicateWorkAuthorized: false,
    completedCandidateHashes: checkpointCandidates.map((entry) => ({
      candidateId: entry.candidateId,
      renderSha256: entry.result?.final?.sha256 ?? null,
      cacheIdentityDigest: entry.cacheIdentityDigest
    }))
  };
  writeJson(path.join(root, "checkpoint-replay-evidence.json"), replayProjection);
}

if ((firstEvidence.r16.metrics.renderCalls + firstEvidence.r16.metrics.cacheHits) !== 4) {
  throw new Error("R25 materialization must account for all four candidates via render or validated cache reuse");
}
if (new Set(firstEvidence.candidates.map((x) => x.renderSha256)).size !== 4) {
  throw new Error("R25 four-way rehearsal produced duplicate bytes");
}

const plans = buildTournamentCandidatePlans(request);
const baselineId = firstEvidence.candidates[0].candidateId;
const baselineManifestPath = path.join(initialRoot, "render-batch", "candidates", baselineId, "media.tournament_candidate_manifest.r25.v1.json");
const baselineManifest = JSON.parse(readFileSync(baselineManifestPath, "utf8"));
const baselinePlan = plans.find((x) => x.candidateId === baselineId);
if (!baselinePlan) throw new Error("baseline plan missing");

const BRIDGE = {
  repository: "foto6/WebAIBridge",
  branch: "agent/bridge-r26-file-attachment-rehearsal-20261002",
  source_sha: "73c13f9eed2a2cbcea881dd8c5452d054bfef940",
  attachment_contract: "bridge.chat_file_attachment.v1",
  rehearsal_request_contract: "bridge.chat_file_attachment_rehearsal_request.v1",
  rehearsal_result_contract: "bridge.chat_file_attachment_rehearsal_result.v1",
  dom_probe_contract: "bridge.chat_file_attachment_dom_probe.v1",
  operator_evidence_contract: "bridge.chat_file_attachment_operator_evidence.v1",
  max_file_bytes: 500000000,
  disposition: "READY_FOR_EXPLICIT_LIVE_REHEARSAL",
  live_pass: false,
  real_upload_proven: false,
  real_prompt_send_proven: false,
  no_live_deploy: true,
  no_cutover: true
};
const MEDIA_R18 = {
  repository: "foto6/video2",
  branch: "agent/media-r18-direct-model-review-package-20261002",
  source_sha: "2c41f084e000eca5efd9a51d2d3752bec1bd1311",
  ci_run_id: 36967381891,
  contract: "media.direct_model_review_package.v1",
  max_file_bytes: 500000000,
  live_upload_performed: false,
  model_judgment_performed: false
};
const binding = {
  source_id: request.source.sourceId,
  source_sha256: request.source.sha256,
  source_size: request.source.size,
  media_repository: "foto6/video2",
  media_producer_sha: producerSha,
  candidate_id: baselineManifest.candidateId,
  render_sha256: baselineManifest.render.sha256,
  render_size: baselineManifest.render.size,
  render_export_sha256: baselineManifest.renderExport.fileSha256,
  attachment_sha256: baselineManifest.render.sha256,
  attachment_size: baselineManifest.render.size,
  attachment_identity: `gvwa1:${fingerprint({ sha256: baselineManifest.render.sha256, size: baselineManifest.render.size })}`,
  review_bundle_digest: firstEvidence.bracket.reviewPackages[0].packageDigest,
  critic_input_digest: fingerprint({ tournament: request.tournamentId, stage: "critic-input" }),
  critic_output_digest: fingerprint({ tournament: request.tournamentId, stage: "critic-output" })
};
function directive(row) {
  const body = {
    operation: row.operation,
    start_ms: row.start,
    end_ms: row.end,
    defect_category: row.defect,
    severity: row.severity,
    source_observation_id: `r25-${row.id}`,
    evidence: `R25 deterministic prior-review fixture evidence ${row.id}`,
    confidence: 0.88,
    uncertainty: "fixture rehearsal; not human ground truth",
    upstream_proposed_edit: "audit-only text",
    upstream_proposed_edit_executable: false,
    binding
  };
  return { ...body, directive_id: `gcrd1:${fingerprint(body)}` };
}
const directives = [
  directive({ id: "reframe", operation: "crop_scale_reframe", start: 350, end: 900, defect: "subject_framing_crop_quality", severity: "minor" }),
  directive({ id: "caption", operation: "subtitles_captions", start: 3200, end: 3900, defect: "caption_readability_emphasis_relevance", severity: "minor" })
];
const pairwise = { selection: null, mapped_candidate_id: null, output_digest: null };
const handoff = {
  contract_version: "growth.creator_reedit_handoff.v1",
  adapter_version: "growth.web_video_critic_reedit_adapter.v1",
  handoff_id: `gcrh1:${fingerprint({
    critic_output_digest: binding.critic_output_digest,
    pairwise_output_digest: null,
    reedit_round: 0
  })}`,
  handoff_digest: "",
  state: "targeted_reedit",
  reedit_round: 0,
  max_reedit_rounds: 2,
  binding,
  pairwise,
  coverage: {
    method: "targeted_ranges",
    inspected_ranges: [{ start_ms: 0, end_ms: baselinePlan.plan.timeline.canvas.durationMs, kind: "fixture_recheck" }],
    uninspected_possible: true,
    every_frame_inspected: false,
    notes: "fixture only",
    coverage_uncertainty_preserved: true
  },
  summary_uncertainty: "fixture only",
  directives,
  bridge_r26_authority: BRIDGE,
  media_r18_authority: MEDIA_R18,
  evidence_boundary: {
    model_review_only: true,
    human_ground_truth: false,
    human_label: false,
    live_platform_evidence: false,
    live_video_review_fabricated: false
  },
  authority: {
    advisory_only: true,
    creator_mutation: false,
    media_mutation: false,
    provider_mutation: false,
    upload_performed: false,
    publish_authorized: false,
    release_authorized: false
  }
};
const handoffMaterial = structuredClone(handoff);
handoffMaterial.handoff_digest = "";
handoff.handoff_digest = fingerprint(handoffMaterial);

const reeditRoot = path.join(root, "targeted-reedit", "r19");
const r19Candidate = {
  candidateId: baselineManifest.candidateId,
  source: {
    sourceId: baselineManifest.source.sourceId,
    sha256: baselineManifest.source.sha256,
    size: baselineManifest.source.size
  },
  finalPath: baselineManifest.render.path,
  renderSha256: baselineManifest.render.sha256,
  renderSize: baselineManifest.render.size,
  renderExportPath: baselineManifest.renderExport.path,
  renderExportSha256: baselineManifest.renderExport.fileSha256,
  renderProducerSha: baselineManifest.producerSha
};
const compiled = compileEditorialReeditPlan({
  handoff,
  candidate: r19Candidate,
  timeline: baselinePlan.plan.timeline,
  exportSpec
}, { sandboxRoot: root });
const r19Request = {
  contractVersion: "media.editorial_reedit_request.r19.v1",
  requestId: "r25-targeted-round-1",
  handoff,
  candidate: r19Candidate,
  timeline: baselinePlan.plan.timeline,
  exportSpec,
  expectedPlanDigest: compiled.planDigest
};
const r19RequestPath = path.join(root, "targeted-reedit", "request.json");
writeJson(r19RequestPath, r19Request);
const r19Log = runNode("tools/run-r19-editorial-reedit.mjs", [
  "--request", r19RequestPath,
  "--sandbox-root", root,
  "--output-dir", reeditRoot
]);

const challengerPath = path.join(reeditRoot, "final.mp4");
const challengerExportPath = path.join(reeditRoot, "media.render_export.v1.json");
const applicationPath = path.join(reeditRoot, "media.editorial_reedit_application.v1.json");
const planPath = path.join(reeditRoot, "media.editorial_reedit_plan.r19.v1.json");
const challengerBytes = hashFile(challengerPath);
const challengerExportFile = hashFile(challengerExportPath);
const challengerExport = validateRenderExport(JSON.parse(readFileSync(challengerExportPath, "utf8")));
const applicationFile = hashFile(applicationPath);
const application = JSON.parse(readFileSync(applicationPath, "utf8"));
const r19Plan = JSON.parse(readFileSync(planPath, "utf8"));
const challengerFacts = ffprobeFacts(challengerPath);
const challengerGate = evaluateTournamentTechnicalGate({
  renderExport: challengerExport,
  ffprobeFacts: challengerFacts,
  expectAudio: request.source.expectAudio
});
if (!challengerGate.passed) throw new Error("R25 targeted challenger failed technical gate");
const challengerGraph = buildOperationGraph(r19Plan.timeline);
const challengerSrtPath = path.join(reeditRoot, "captions.srt");
writeFileSync(challengerSrtPath, captionsToSrt(r19Plan.timeline));
const challengerSrt = hashFile(challengerSrtPath);
const challengerManifest = validateTournamentCandidateManifest({
  contractVersion: MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
  tournamentId: request.tournamentId,
  candidateId: `${baselineManifest.candidateId}-reedit-r1`,
  roundNumber: 1,
  strategy: "targeted_reedit",
  source: baselineManifest.source,
  briefDigest: baselineManifest.briefDigest,
  producerSha,
  operationGraph: challengerGraph,
  operationGraphDigest: fingerprint(challengerGraph),
  declaredOperationTypes: operationTypes(challengerGraph),
  render: { path: rel(challengerPath), sha256: challengerBytes.sha256, size: challengerBytes.size },
  renderExport: {
    path: rel(challengerExportPath),
    fileSha256: challengerExportFile.sha256,
    digest: renderExportDigest(challengerExport)
  },
  ffprobe: challengerFacts,
  technicalGate: challengerGate,
  captionSidecar: {
    path: rel(challengerSrtPath),
    sha256: challengerSrt.sha256,
    size: challengerSrt.size,
    mime: "application/x-subrip"
  },
  blindSeed: fingerprint({ parent: baselineManifest.render.sha256, child: challengerBytes.sha256, round: 1 }),
  humanQuality: false
});
writeJson(path.join(reeditRoot, "media.tournament_candidate_manifest.r25.v1.json"), challengerManifest);

const priorPackage = firstEvidence.bracket.reviewPackages.find((pkg) => {
  const bracket = JSON.parse(readFileSync(path.join(initialRoot, "media.review_tournament_bracket.r25.v1.json"), "utf8"));
  const match = bracket.matches.find((m) => m.matchId === pkg.matchId);
  return match?.participants?.some((p) => p.candidateId === baselineManifest.candidateId);
});
if (!priorPackage) throw new Error("baseline candidate has no prior bracket review package");
const targetedEvidence = validateTargetedTournamentReedit({
  baselineManifest,
  challengerManifest,
  application,
  priorReview: {
    selectedCandidateId: baselineManifest.candidateId,
    reviewPackageDigest: priorPackage.packageDigest,
    growthHandoffDigest: handoff.handoff_digest,
    directiveDigest: application.directiveDigest
  },
  baselineTimeline: baselinePlan.plan.timeline,
  challengerTimeline: r19Plan.timeline
});
writeJson(path.join(root, "targeted-reedit", "media.tournament_targeted_reedit.r25.v1.json"), targetedEvidence);

const r21Request = {
  contractVersion: "media.review_round_request.r21.v1",
  review: {
    mode: "targeted_reedit",
    baseline: {
      candidate: r21Candidate(baselineManifest),
      briefLineageDigest: request.brief.digest
    },
    challenger: {
      candidate: r21Candidate(challengerManifest, {
        path: rel(applicationPath),
        fileSha256: applicationFile.sha256,
        digest: fingerprint(application)
      }),
      briefLineageDigest: request.brief.digest
    },
    priorReview: {
      contractVersion: "media.prior_review_selection.r21.v1",
      selectedCandidateId: baselineManifest.candidateId,
      reviewRound: 0,
      reviewPackageDigest: priorPackage.packageDigest,
      sealedMappingDigest: priorPackage.sealedMappingDigest,
      decisionEvidenceDigest: fingerprint({
        fixture: "r25-targeted-selection",
        baselineCandidateId: baselineManifest.candidateId,
        packageDigest: priorPackage.packageDigest
      }),
      evidenceType: "fixture_rehearsal"
    }
  }
};
const targetedReviewRoot = path.join(root, "targeted-reedit", "review-package");
const targetedReviewRequestPath = path.join(root, "targeted-reedit", "review-request.json");
writeJson(targetedReviewRequestPath, r21Request);
const r21Log = runNode("tools/build-r21-review-round.mjs", [
  "--request", targetedReviewRequestPath,
  "--sandbox-root", root,
  "--output-dir", targetedReviewRoot
]);
const targetedReviewEvidence = JSON.parse(readFileSync(
  path.join(targetedReviewRoot, "media.review_round_bundle.r21.evidence.json"),
  "utf8"
));
if (targetedReviewEvidence.reviewRound !== 1 || targetedReviewEvidence.mode !== "targeted_reedit") {
  throw new Error("R25 targeted R21 review package lineage mismatch");
}

const rehearsalPayload = path.join(root, "rehearsal-payload");
mkdirSync(rehearsalPayload, { recursive: true });
mkdirSync(path.join(rehearsalPayload, "targeted-reedit"), { recursive: true });
copyFileSync(path.join(initialRoot, "media-r25-tournament.tar"), path.join(rehearsalPayload, "initial-four-candidate-tournament.tar"));
for (const name of [
  "review-A.mp4", "review-B.mp4",
  "media.review_round_bundle.r21.v1.json",
  "media.review_round_sealed_mapping.r21.v1.json",
  "media.review_round_transport_handoff.r21.v1.json",
  "media.review_round_bundle.r21.evidence.json",
  "model-review-prompt.txt.json"
]) {
  copyFileSync(path.join(targetedReviewRoot, name), path.join(rehearsalPayload, "targeted-reedit", name));
}
copyFileSync(path.join(root, "targeted-reedit", "media.tournament_targeted_reedit.r25.v1.json"),
  path.join(rehearsalPayload, "targeted-reedit", "media.tournament_targeted_reedit.r25.v1.json"));
copyFileSync(path.join(reeditRoot, "media.tournament_candidate_manifest.r25.v1.json"),
  path.join(rehearsalPayload, "targeted-reedit", "challenger-manifest.json"));

const payloadFiles = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (st.isFile()) payloadFiles.push(path.relative(rehearsalPayload, full).split(path.sep).join("/"));
  }
}
walk(rehearsalPayload);
const outerArchivePath = path.join(root, "media-r25-rehearsal.tar");
const outerArchive = createDeterministicTar(rehearsalPayload, payloadFiles, outerArchivePath);
const outerParsed = readDeterministicTar(outerArchivePath);
if (outerParsed.sha256 !== outerArchive.sha256 || outerParsed.entries.size !== payloadFiles.length) {
  throw new Error("R25 outer rehearsal archive verification failed");
}

const umbrellaAuthority = buildMulticandidateRoundAuthority({
  producerSha,
  implementationBlobs: {
    tournamentImplementation: gitBlob("src/tournament-r25.js"),
    umbrellaImplementation: gitBlob("src/multicandidate-round-r25.js"),
    runner: gitBlob("tools/run-r25-tournament.mjs"),
    phaseMaterializer: gitBlob("tools/materialize-r25-ci-phase.mjs"),
    rehearsal: gitBlob("tools/demo-r25-tournament.mjs"),
    verifier: gitBlob("tools/verify-r25-rehearsal.mjs"),
    externalContract: gitBlob("conformance/media.multicandidate_round.r25.v1/contract.json"),
    externalSchema: gitBlob("conformance/media.multicandidate_round.r25.v1/schema.json")
  }
});
writeJson(path.join(root, "media.multicandidate_round.r25.v1.json"), umbrellaAuthority);

const summary = {
  evidenceVersion: "media.edit_tournament.r25.demo.v1",
  producer: { repository: "foto6/video2", sha: producerSha },
  externalUmbrella: {
    contractVersion: umbrellaAuthority.contractVersion,
    digest: fingerprint(umbrellaAuthority),
    internalContracts: umbrellaAuthority.internalContracts,
    implementationBlobs: umbrellaAuthority.implementationBlobs
  },
  acceptedR24: {
    producerSha: "244acdf154741e669991b17df3ef2a47e2dfdfa9",
    ciRunId: 37195239582,
    artifactId: 11301055747,
    artifactDigest: "sha256:fc5c9b9635d49b643e66efafe602d21ce1ef695a553f81a797bdf16d7b8cf228"
  },
  initialRound: {
    candidateCount: 4,
    candidateRenders: firstEvidence.candidates,
    bracketDigest: firstEvidence.bracket.digest,
    reviewPackages: firstEvidence.bracket.reviewPackages,
    archive: firstEvidence.archive,
    firstRunMetrics: firstEvidence.r16.metrics,
    replayMetrics: replayProjection,
    byteStableArchiveReplay: true
  },
  targetedReedit: {
    baselineCandidateId: baselineManifest.candidateId,
    baselineRenderSha256: baselineManifest.render.sha256,
    challengerCandidateId: challengerManifest.candidateId,
    challengerRenderSha256: challengerManifest.render.sha256,
    challengerRenderSize: challengerManifest.render.size,
    growthHandoffDigest: handoff.handoff_digest,
    mediaApplicationDigest: fingerprint(application),
    directiveDigest: application.directiveDigest,
    unaffectedRegionEvidence: targetedEvidence.unaffectedRegionEvidence,
    reviewPackageDigest: targetedReviewEvidence.packageDigest,
    sealedMappingDigest: targetedReviewEvidence.sealedMappingDigest,
    promptDigest: targetedReviewEvidence.promptDigest,
    reviewAttachments: targetedReviewEvidence.attachments,
    r19LogSha256: createHash("sha256").update(r19Log).digest("hex"),
    r21LogSha256: createHash("sha256").update(r21Log).digest("hex")
  },
  outerArchive: {
    sha256: outerArchive.sha256,
    size: outerArchive.size,
    entries: outerArchive.entries.length
  },
  actualEncodedMp4: true,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false
};
writeJson(path.join(root, "r25-readiness-evidence.json"), summary);
console.log("R25_DEMO", stableStringify(summary));
