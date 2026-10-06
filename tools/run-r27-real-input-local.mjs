import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
  buildOperationGraph,
  buildR27GrowthBundleManifest,
  buildR27NormalizationSpec,
  buildTournamentCandidatePlans,
  captionsToSrt,
  compileEditorialReeditPlan,
  createDeterministicTar,
  createR27OperationBinding,
  evaluateTournamentTechnicalGate,
  fingerprint,
  readDeterministicTar,
  renderExportDigest,
  stableStringify,
  validateR27GrowthBundleManifest,
  validateRenderExport,
  validateTargetedTournamentReedit,
  validateTournamentCandidateManifest
} from "../src/index.js";
import {
  MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION,
  R27_AUTHORITY_STATE,
  R27_PHASES,
  beginR27Invocation,
  loadOrCreateR27Ledger,
  r27Status,
  recordR27Cancellation,
  runR27DurablePhase,
  validateR27Ledger,
  validateR27PathArguments,
  verifyR27Artifacts
} from "../src/real-input-local-rehearsal-r27.js";
import { r26Digest, r26Sha256File } from "../src/local-windows-render-gate-r26.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_BRANCH = "agent/media-r27-real-input-local-rehearsal-20261006";
const MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024;
const MIN_RAM_BYTES = 4 * 1024 * 1024 * 1024;
const MIN_CPU_COUNT = 2;

function parseArgs(argv) {
  const out = { mode: "run" };
  let first = true;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (first && !token.startsWith("--")) {
      out.mode = token.toLowerCase();
      first = false;
      continue;
    }
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
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function rel(base, filePath) {
  const value = path.relative(base, filePath).split(path.sep).join("/");
  if (!value || value.startsWith("../") || path.isAbsolute(value)) fail("R27_PATH_ESCAPE", `path escapes root: ${filePath}`);
  return value;
}
function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}
function writeStable(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.from(stableStringify(value) + "\n", "utf8");
  if (existsSync(filePath)) {
    const prior = readFileSync(filePath);
    if (!prior.equals(bytes)) fail("R27_REPLAY_CONFLICT", `stable file conflict: ${filePath}`);
  } else writeFileSync(filePath, bytes);
  return r26Sha256File(filePath);
}
function copyStable(source, target) {
  const expected = r26Sha256File(source);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) {
    const actual = r26Sha256File(target);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) fail("R27_REPLAY_CONFLICT", `copy target drift: ${target}`);
  } else copyFileSync(source, target);
  return expected;
}
function parseRate(value) {
  const [n, d] = String(value ?? "").split("/").map(Number);
  return Number.isFinite(n) && Number.isFinite(d) && d ? Number((n / d).toFixed(6)) : null;
}
function probeMedia(ffprobe, filePath) {
  const parsed = JSON.parse(execFileSync(ffprobe, [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,duration:format=duration",
    "-of", "json",
    filePath
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
  const video = (parsed.streams ?? []).find((x) => x.codec_type === "video");
  const audio = (parsed.streams ?? []).find((x) => x.codec_type === "audio");
  const durationMs = Math.round(Number(parsed.format?.duration ?? video?.duration ?? 0) * 1000);
  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseRate(video?.r_frame_rate),
    durationMs
  };
}
function versionOf(binary) {
  return execFileSync(binary, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).split(/\r?\n/)[0].trim();
}
function discoverWindowsBinary(name) {
  const out = execFileSync("where.exe", [name], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const first = out.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  if (!first || !existsSync(first)) fail("R27_PREFLIGHT_FFMPEG", `${name} not found on PATH`);
  return path.resolve(first);
}
function runtimePaths(outputRoot) {
  const runtimeRoot = path.join(outputRoot, "runtime", "ffmpeg");
  return {
    runtimeRoot,
    runtimeBin: path.join(runtimeRoot, "bin"),
    manifestPath: path.join(runtimeRoot, "runtime.manifest.sha256")
  };
}
function parseRuntimeManifest(paths) {
  if (!existsSync(paths.manifestPath)) fail("R27_RUNTIME_MISSING", "runtime manifest missing");
  const lines = readFileSync(paths.manifestPath, "utf8").split(/\r?\n/).filter(Boolean);
  if (!lines.length) fail("R27_RUNTIME_INVALID", "runtime manifest empty");
  const files = [];
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) fail("R27_RUNTIME_INVALID", `invalid runtime manifest line: ${line}`);
    const relative = match[2].replace(/^\*/, "").replaceAll("/", path.sep);
    const filePath = path.resolve(paths.runtimeRoot, relative);
    const check = path.relative(paths.runtimeRoot, filePath);
    if (!check || check.startsWith("..") || path.isAbsolute(check)) fail("R27_RUNTIME_INVALID", "runtime manifest path escape");
    const actual = r26Sha256File(filePath);
    if (actual.sha256 !== match[1]) fail("R27_RUNTIME_DRIFT", `runtime digest mismatch: ${relative}`);
    files.push({ path: relative.replaceAll(path.sep, "/"), ...actual });
  }
  return { manifest: r26Sha256File(paths.manifestPath), files };
}
function checkpointRuntime(outputRoot) {
  const paths = runtimePaths(outputRoot);
  if (!existsSync(paths.manifestPath)) {
    const ffmpegSource = discoverWindowsBinary("ffmpeg.exe");
    const ffprobeSource = discoverWindowsBinary("ffprobe.exe");
    if (path.dirname(ffmpegSource).toLowerCase() !== path.dirname(ffprobeSource).toLowerCase()) {
      fail("R27_PREFLIGHT_FFMPEG", "ffmpeg.exe and ffprobe.exe must be from one runtime directory");
    }
    mkdirSync(paths.runtimeBin, { recursive: true });
    const sourceDir = path.dirname(ffmpegSource);
    const names = readdirSync(sourceDir)
      .filter((name) => /\.dll$/i.test(name) || /^ff(?:mpeg|probe)\.exe$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
    if (!names.some((x) => /^ffmpeg\.exe$/i.test(x)) || !names.some((x) => /^ffprobe\.exe$/i.test(x))) {
      fail("R27_PREFLIGHT_FFMPEG", "FFmpeg runtime directory is incomplete");
    }
    for (const name of names) copyFileSync(path.join(sourceDir, name), path.join(paths.runtimeBin, name));
    const manifest = readdirSync(paths.runtimeBin)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const id = r26Sha256File(path.join(paths.runtimeBin, name));
        return `${id.sha256}  bin/${name}`;
      }).join("\n") + "\n";
    writeFileSync(paths.manifestPath, manifest, "utf8");
  }
  const verified = parseRuntimeManifest(paths);
  const ffmpeg = path.join(paths.runtimeBin, "ffmpeg.exe");
  const ffprobe = path.join(paths.runtimeBin, "ffprobe.exe");
  if (!existsSync(ffmpeg) || !existsSync(ffprobe)) fail("R27_RUNTIME_INVALID", "checkpointed runtime lacks ffmpeg/ffprobe");
  return {
    ...paths,
    ...verified,
    ffmpeg,
    ffprobe,
    ffmpegVersion: versionOf(ffmpeg),
    ffprobeVersion: versionOf(ffprobe)
  };
}
function runtimeEnv(runtime) {
  const current = process.env.Path ?? process.env.PATH ?? "";
  return { ...process.env, Path: `${runtime.runtimeBin};${current}`, PATH: `${runtime.runtimeBin};${current}` };
}
function preflight(inputPath, outputRoot) {
  if (process.platform !== "win32") fail("R27_WINDOWS_REQUIRED", "R27 real-input render must run on Windows");
  const paths = validateR27PathArguments({ inputPath, outputRoot, platform: "win32" });
  if (!existsSync(paths.inputPath) || !statSync(paths.inputPath).isFile()) fail("R27_INPUT_MISSING", "input video file does not exist");
  mkdirSync(paths.outputRoot, { recursive: true });
  const branch = git(["branch", "--show-current"]);
  if (branch !== EXPECTED_BRANCH) fail("R27_BRANCH_MISMATCH", `expected ${EXPECTED_BRANCH}, got ${branch}`);
  if (git(["status", "--porcelain", "--untracked-files=no"])) fail("R27_WORKTREE_DIRTY", "tracked worktree changes are not allowed");
  const producerSha = git(["rev-parse", "HEAD"]);
  const cpuCount = os.cpus().length;
  const totalRamBytes = os.totalmem();
  const disk = statfsSync(paths.outputRoot);
  const freeDiskBytes = Number(disk.bavail) * Number(disk.bsize);
  if (cpuCount < MIN_CPU_COUNT) fail("R27_PREFLIGHT_CPU", "at least 2 logical CPUs required");
  if (totalRamBytes < MIN_RAM_BYTES) fail("R27_PREFLIGHT_RAM", "at least 4 GiB RAM required");
  if (freeDiskBytes < MIN_FREE_BYTES) fail("R27_PREFLIGHT_DISK", "at least 4 GiB free disk required");
  const runtime = checkpointRuntime(paths.outputRoot);
  execFileSync(runtime.ffmpeg, [
    "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.05",
    "-frames:v", "1", "-f", "null", "-"
  ], { env: runtimeEnv(runtime), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  return { ...paths, producerSha, branch, cpuCount, totalRamBytes, freeDiskBytes, runtime };
}
function normalizedCommand(runtime, inputPath, outputPath, probe) {
  const common = [
    "-hide_banner", "-nostdin", "-y",
    "-ss", "0", "-i", inputPath
  ];
  if (!probe.hasAudio) common.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  common.push(
    "-t", "5",
    "-map", "0:v:0",
    "-map", probe.hasAudio ? "0:a:0" : "1:a:0",
    "-vf", "scale=360:640:force_original_aspect_ratio=increase,crop=360:640:(in_w-360)/2:(in_h-640)/2,fps=30,setsar=1",
    "-af", "aresample=48000",
    "-map_metadata", "-1",
    "-metadata", "creation_time=1970-01-01T00:00:00Z",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-threads", "1",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    "-shortest", "-f", "mp4", outputPath
  );
  return { binary: runtime.ffmpeg, args: common };
}
function runSync(command, env) {
  const started = process.hrtime.bigint();
  execFileSync(command.binary, command.args, {
    cwd: repoRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "inherit", "pipe"],
    maxBuffer: 32 * 1024 * 1024
  });
  return Number(process.hrtime.bigint() - started) / 1e6;
}

let activeChild = null;
let activePhase = null;
let activeContext = null;
let cancellationRequested = false;
function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, script), ...args], {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      windowsHide: true
    });
    activeChild = child;
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      activeChild = null;
      if (code === 0 && !cancellationRequested) resolve();
      else {
        const error = new Error(cancellationRequested
          ? `R27 cancelled during ${activePhase}`
          : `R27 phase ${activePhase} failed code=${code} signal=${signal ?? "none"}`);
        error.code = cancellationRequested ? "R27_CANCELLED" : "R27_PHASE_FAILED";
        reject(error);
      }
    });
  });
}
function allOperationTypes(graph) {
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
    render: manifest.render,
    renderExport: manifest.renderExport,
    renderProducerSha: manifest.producerSha,
    editorialApplication: application,
    reviewDerivative: null
  };
}
function targetedReedit({ workRoot, producerSha, env, ffprobe }) {
  const request = JSON.parse(readFileSync(path.join(workRoot, "request.json"), "utf8"));
  const firstEvidence = JSON.parse(readFileSync(path.join(workRoot, "initial", "media.edit_tournament.r25.evidence.json"), "utf8"));
  const plans = buildTournamentCandidatePlans(request);
  const baselineId = firstEvidence.candidates[0].candidateId;
  const baselineManifestPath = path.join(workRoot, "initial", "render-batch", "candidates", baselineId, "media.tournament_candidate_manifest.r25.v1.json");
  const baselineManifest = JSON.parse(readFileSync(baselineManifestPath, "utf8"));
  const baselinePlan = plans.find((x) => x.candidateId === baselineId);
  if (!baselinePlan) fail("R27_TARGETED_BASELINE", "baseline plan missing");

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
    critic_input_digest: fingerprint({ tournament: request.tournamentId, stage: "r27-real-input-critic-input" }),
    critic_output_digest: fingerprint({ tournament: request.tournamentId, stage: "r27-fixture-critic-output" })
  };
  function directive(row) {
    const body = {
      operation: row.operation,
      start_ms: row.start,
      end_ms: row.end,
      defect_category: row.defect,
      severity: "minor",
      source_observation_id: `r27-${row.id}`,
      evidence: `R27 deterministic offline rehearsal directive ${row.id}`,
      confidence: 0.88,
      uncertainty: "offline fixture decision only; no model or human review performed",
      upstream_proposed_edit: "audit-only fixture directive",
      upstream_proposed_edit_executable: false,
      binding
    };
    return { ...body, directive_id: `gcrd1:${fingerprint(body)}` };
  }
  const directives = [
    directive({ id: "reframe", operation: "crop_scale_reframe", start: 350, end: 900, defect: "subject_framing_crop_quality" }),
    directive({ id: "caption", operation: "subtitles_captions", start: 3200, end: 3900, defect: "caption_readability_emphasis_relevance" })
  ];
  const handoff = {
    contract_version: "growth.creator_reedit_handoff.v1",
    adapter_version: "growth.web_video_critic_reedit_adapter.v1",
    handoff_id: `gcrh1:${fingerprint({ critic_output_digest: binding.critic_output_digest, reedit_round: 0 })}`,
    handoff_digest: "",
    state: "targeted_reedit",
    reedit_round: 0,
    max_reedit_rounds: 2,
    binding,
    pairwise: { selection: null, mapped_candidate_id: null, output_digest: null },
    coverage: {
      method: "targeted_ranges",
      inspected_ranges: [{ start_ms: 0, end_ms: 5000, kind: "offline_fixture_recheck" }],
      uninspected_possible: true,
      every_frame_inspected: false,
      notes: "R27 offline real-input render; review decision is deterministic fixture evidence",
      coverage_uncertainty_preserved: true
    },
    summary_uncertainty: "fixture decision only",
    directives,
    bridge_r26_authority: {
      repository: "foto6/WebAIBridge",
      source_sha: "73c13f9eed2a2cbcea881dd8c5452d054bfef940",
      attachment_contract: "bridge.chat_file_attachment.v1",
      disposition: "NOT_INVOKED_BY_R27",
      live_pass: false,
      no_live_deploy: true
    },
    media_r18_authority: {
      repository: "foto6/video2",
      source_sha: "2c41f084e000eca5efd9a51d2d3752bec1bd1311",
      contract: "media.direct_model_review_package.v1",
      live_upload_performed: false,
      model_judgment_performed: false
    },
    evidence_boundary: {
      model_review_only: false,
      fixture_rehearsal: true,
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
  const material = structuredClone(handoff);
  material.handoff_digest = "";
  handoff.handoff_digest = fingerprint(material);

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
    exportSpec: request.exportSpec
  }, { sandboxRoot: workRoot });
  const targetRoot = path.join(workRoot, "targeted-reedit");
  const r19Root = path.join(targetRoot, "r19");
  const requestPath = path.join(targetRoot, "request.json");
  writeStable(requestPath, {
    contractVersion: "media.editorial_reedit_request.r19.v1",
    requestId: "r27-targeted-round-1",
    handoff,
    candidate: r19Candidate,
    timeline: baselinePlan.plan.timeline,
    exportSpec: request.exportSpec,
    expectedPlanDigest: compiled.planDigest
  });
  execFileSync(process.execPath, [
    path.join(repoRoot, "tools/run-r19-editorial-reedit.mjs"),
    "--request", requestPath,
    "--sandbox-root", workRoot,
    "--output-dir", r19Root
  ], { cwd: repoRoot, env, windowsHide: true, stdio: ["ignore", "inherit", "pipe"], maxBuffer: 32 * 1024 * 1024 });

  const finalPath = path.join(r19Root, "final.mp4");
  const exportPath = path.join(r19Root, "media.render_export.v1.json");
  const applicationPath = path.join(r19Root, "media.editorial_reedit_application.v1.json");
  const planPath = path.join(r19Root, "media.editorial_reedit_plan.r19.v1.json");
  const finalId = r26Sha256File(finalPath);
  const exportFile = r26Sha256File(exportPath);
  const applicationFile = r26Sha256File(applicationPath);
  const application = JSON.parse(readFileSync(applicationPath, "utf8"));
  const reeditPlan = JSON.parse(readFileSync(planPath, "utf8"));
  const renderExport = validateRenderExport(JSON.parse(readFileSync(exportPath, "utf8")));
  const facts = probeMedia(ffprobe, finalPath);
  const gate = evaluateTournamentTechnicalGate({
    renderExport,
    ffprobeFacts: { ...facts, videoDurationMs: facts.durationMs, audioDurationMs: facts.durationMs, avSyncDeltaMs: 0 },
    expectAudio: true
  });
  if (!gate.passed) fail("R27_TARGETED_GATE", "targeted re-edit technical gate failed");
  const graph = buildOperationGraph(reeditPlan.timeline);
  const captionPath = path.join(r19Root, "captions.srt");
  writeFileSync(captionPath, captionsToSrt(reeditPlan.timeline), "utf8");
  const caption = r26Sha256File(captionPath);
  const challengerManifest = validateTournamentCandidateManifest({
    contractVersion: MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
    tournamentId: request.tournamentId,
    candidateId: `${baselineManifest.candidateId}-reedit-r1`,
    roundNumber: 1,
    strategy: "targeted_reedit",
    source: baselineManifest.source,
    briefDigest: baselineManifest.briefDigest,
    producerSha,
    operationGraph: graph,
    operationGraphDigest: fingerprint(graph),
    declaredOperationTypes: allOperationTypes(graph),
    render: { path: rel(workRoot, finalPath), sha256: finalId.sha256, size: finalId.size },
    renderExport: {
      path: rel(workRoot, exportPath),
      fileSha256: exportFile.sha256,
      digest: renderExportDigest(renderExport)
    },
    ffprobe: { ...facts, videoDurationMs: facts.durationMs, audioDurationMs: facts.durationMs, avSyncDeltaMs: 0 },
    technicalGate: gate,
    captionSidecar: { path: rel(workRoot, captionPath), sha256: caption.sha256, size: caption.size, mime: "application/x-subrip" },
    blindSeed: fingerprint({ parent: baselineManifest.render.sha256, child: finalId.sha256, round: 1 }),
    humanQuality: false
  });
  const challengerManifestPath = path.join(r19Root, "media.tournament_candidate_manifest.r25.v1.json");
  writeStable(challengerManifestPath, challengerManifest);

  const bracket = JSON.parse(readFileSync(path.join(workRoot, "initial", "media.review_tournament_bracket.r25.v1.json"), "utf8"));
  const priorPackage = firstEvidence.bracket.reviewPackages.find((pkg) => {
    const match = bracket.matches.find((m) => m.matchId === pkg.matchId);
    return match?.participants?.some((p) => p.candidateId === baselineManifest.candidateId);
  });
  if (!priorPackage) fail("R27_TARGETED_REVIEW", "baseline has no prior review package");
  const targeted = validateTargetedTournamentReedit({
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
    challengerTimeline: reeditPlan.timeline
  });
  const targetedPath = path.join(targetRoot, "media.tournament_targeted_reedit.r25.v1.json");
  writeStable(targetedPath, targeted);

  const reviewRequest = {
    contractVersion: "media.review_round_request.r21.v1",
    review: {
      mode: "targeted_reedit",
      baseline: { candidate: r21Candidate(baselineManifest), briefLineageDigest: request.brief.digest },
      challenger: {
        candidate: r21Candidate(challengerManifest, {
          path: rel(workRoot, applicationPath),
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
          fixture: "r27-targeted-selection",
          baselineCandidateId: baselineManifest.candidateId,
          packageDigest: priorPackage.packageDigest
        }),
        evidenceType: "fixture_rehearsal"
      }
    }
  };
  const reviewRoot = path.join(targetRoot, "review-package");
  const reviewRequestPath = path.join(targetRoot, "review-request.json");
  writeStable(reviewRequestPath, reviewRequest);
  execFileSync(process.execPath, [
    path.join(repoRoot, "tools/build-r21-review-round.mjs"),
    "--request", reviewRequestPath,
    "--sandbox-root", workRoot,
    "--output-dir", reviewRoot
  ], { cwd: repoRoot, env, windowsHide: true, stdio: ["ignore", "inherit", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  const reviewEvidencePath = path.join(reviewRoot, "media.review_round_bundle.r21.evidence.json");
  const reviewEvidence = JSON.parse(readFileSync(reviewEvidencePath, "utf8"));
  if (reviewEvidence.reviewRound !== 1 || reviewEvidence.mode !== "targeted_reedit") fail("R27_TARGETED_REVIEW", "targeted review package mismatch");

  const r27EvidencePath = path.join(targetRoot, "r27-targeted-reedit-evidence.json");
  writeStable(r27EvidencePath, {
    contractVersion: "media.real_input_targeted_reedit.r27.v1",
    decisionClass: "DETERMINISTIC_OFFLINE_FIXTURE",
    modelReviewPerformed: false,
    humanReviewPerformed: false,
    baselineCandidateId: baselineManifest.candidateId,
    baselineRenderSha256: baselineManifest.render.sha256,
    challengerCandidateId: challengerManifest.candidateId,
    challengerRenderSha256: finalId.sha256,
    targetedEvidenceDigest: fingerprint(targeted),
    reviewPackageDigest: reviewEvidence.packageDigest,
    sealedMappingDigest: reviewEvidence.sealedMappingDigest,
    growthHandoffDigest: handoff.handoff_digest,
    providerMutation: false,
    socialPublish: false
  });
  return {
    finalPath,
    finalId,
    challengerManifestPath,
    targetedPath,
    r27EvidencePath,
    reviewEvidencePath
  };
}
function phasePaths(workRoot, outputRoot, phase) {
  const initial = path.join(workRoot, "initial");
  if (phase === "input-probe") return [path.join(outputRoot, "evidence", "input-probe.json")];
  if (phase === "normalize-source") return [path.join(workRoot, "source.mp4"), path.join(outputRoot, "evidence", "normalization.json")];
  if (phase === "pair-1") return [
    path.join(initial, "phases", "pair-1", "r25-phase-checkpoint.json"),
    path.join(initial, "render-batch", "candidates", "candidate-1", "final.mp4"),
    path.join(initial, "render-batch", "candidates", "candidate-2", "final.mp4")
  ];
  if (phase === "candidate-3") return [
    path.join(initial, "phases", "candidate-3", "r25-phase-checkpoint.json"),
    path.join(initial, "render-batch", "candidates", "candidate-3", "final.mp4")
  ];
  const segment = phase.match(/^candidate-4-(segment-[1-6])$/)?.[1];
  if (segment) return [
    path.join(initial, "phases", "candidate-4-subphases", segment, "r25-candidate4-checkpoint.json"),
    path.join(initial, "phases", "candidate-4-subphases", segment, "segment.mp4")
  ];
  if (phase === "candidate-4-assemble") return [
    path.join(initial, "phases", "candidate-4", "r25-phase-checkpoint.json"),
    path.join(initial, "render-batch", "candidates", "candidate-4", "final.mp4")
  ];
  if (phase === "initial-finalize") return [
    path.join(initial, "media.edit_tournament.r25.evidence.json"),
    path.join(initial, "media.review_tournament_bracket.r25.v1.json"),
    path.join(initial, "media-r25-tournament.tar")
  ];
  if (phase === "targeted-reedit") return [
    path.join(workRoot, "targeted-reedit", "r19", "final.mp4"),
    path.join(workRoot, "targeted-reedit", "r27-targeted-reedit-evidence.json")
  ];
  if (phase === "verify-r25") return [path.join(workRoot, "r25-verification-evidence.json")];
  if (phase === "final-artifact") return [path.join(outputRoot, "final", "final.mp4")];
  if (phase === "seal-growth-bundle") return [
    path.join(outputRoot, "evidence", "media.real_input_local_rehearsal.r27.evidence.json"),
    path.join(outputRoot, "growth", "media.real_input_growth_bundle.r27.manifest.json"),
    path.join(outputRoot, "growth", "media-r27-growth-bundle.tar")
  ];
  fail("R27_PHASE_INVALID", `unknown phase paths: ${phase}`);
}
function artifactEvidence(base, paths) {
  return paths.map((filePath) => ({ path: filePath, relativePath: rel(base, filePath), ...r26Sha256File(filePath) }));
}
function childPhase(phase, workRoot) {
  if (phase === "pair-1") return ["tools/materialize-r25-ci-phase.mjs", ["--phase", "pair-1", "--root", workRoot]];
  if (phase === "candidate-3") return ["tools/materialize-r25-ci-phase.mjs", ["--phase", "candidate-3", "--root", workRoot]];
  const segment = phase.match(/^candidate-4-(segment-[1-6])$/)?.[1];
  if (segment) return ["tools/materialize-r25-candidate4-subphase.mjs", ["--phase", segment, "--root", workRoot]];
  if (phase === "candidate-4-assemble") return ["tools/materialize-r25-candidate4-subphase.mjs", ["--phase", "assemble", "--root", workRoot]];
  if (phase === "initial-finalize") return ["tools/materialize-r25-ci-phase.mjs", ["--phase", "finalize", "--root", workRoot]];
  if (phase === "verify-r25") return ["tools/verify-r25-rehearsal.mjs", ["--root", workRoot]];
  return null;
}
function copyBundleFile(source, payloadRoot, targetRelative) {
  const target = path.join(payloadRoot, ...targetRelative.split("/"));
  const id = copyStable(source, target);
  return { path: targetRelative, ...id };
}
function sealBundle(ctx) {
  const { outputRoot, workRoot, producerSha, binding, inputIdentity, originalProbe, normalization, runtime, ledgerPath } = ctx;
  const initialEvidence = JSON.parse(readFileSync(path.join(workRoot, "initial", "media.edit_tournament.r25.evidence.json"), "utf8"));
  const bracketPath = path.join(workRoot, "initial", "media.review_tournament_bracket.r25.v1.json");
  const targetedEvidence = JSON.parse(readFileSync(path.join(workRoot, "targeted-reedit", "r27-targeted-reedit-evidence.json"), "utf8"));
  const candidateRows = [1,2,3,4].map((n) => {
    const file = path.join(workRoot, "initial", "render-batch", "candidates", `candidate-${n}`, "final.mp4");
    return { candidateId: `candidate-${n}`, ...r26Sha256File(file), file };
  });
  const finalPath = path.join(outputRoot, "final", "final.mp4");
  const final = r26Sha256File(finalPath);
  const normalized = r26Sha256File(path.join(workRoot, "source.mp4"));
  const ledger = loadOrCreateR27Ledger(ledgerPath, binding);

  const summaryPath = path.join(outputRoot, "evidence", "media.real_input_local_rehearsal.r27.evidence.json");
  const summary = {
    contractVersion: MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION,
    state: "LOCAL_REAL_INPUT_REHEARSAL_COMPLETE",
    producer: {
      repository: "foto6/video2",
      branch: EXPECTED_BRANCH,
      sha: producerSha,
      authorityState: R27_AUTHORITY_STATE,
      acceptedByIndependentQa: false
    },
    operationBinding: binding,
    inputVideo: {
      pathIdentity: inputIdentity.pathIdentity,
      sha256: inputIdentity.sha256,
      size: inputIdentity.size,
      probe: originalProbe
    },
    normalization: {
      ...normalization,
      source: normalized
    },
    runtime: {
      manifestSha256: runtime.manifest.sha256,
      ffmpegVersion: runtime.ffmpegVersion,
      ffprobeVersion: runtime.ffprobeVersion,
      files: runtime.files
    },
    candidates: candidateRows.map(({ file, ...row }) => row),
    bracket: {
      digest: initialEvidence.bracket.digest,
      reviewPackages: initialEvidence.bracket.reviewPackages
    },
    targetedReedit: targetedEvidence,
    finalArtifact: {
      selectionClass: "DETERMINISTIC_OFFLINE_FIXTURE_TARGETED_REEDIT",
      sha256: final.sha256,
      size: final.size
    },
    phaseTimingsMs: Object.fromEntries(R27_PHASES.filter((p) => ledger.phases[p]).map((p) => [p, ledger.phases[p].evidence.elapsedMs])),
    resumeRestartEvidence: {
      invocationCount: ledger.invocations.length,
      invocations: ledger.invocations,
      cancellationEvents: ledger.cancellationEvents,
      completedBeforeSeal: R27_PHASES.filter((p) => ledger.phases[p])
    },
    controls: {
      realInputBytes: true,
      realEncodedMp4: true,
      sourceHashProbeBeforeRender: true,
      fourCandidatesRequired: true,
      fixtureReviewDecision: true,
      modelReviewPerformed: false,
      humanReviewPerformed: false,
      providerMutation: false,
      browserMutation: false,
      socialPublish: false,
      liveAuthorization: false
    }
  };
  writeStable(summaryPath, summary);

  const growthRoot = path.join(outputRoot, "growth");
  const payloadRoot = path.join(growthRoot, "payload");
  rmSync(payloadRoot, { recursive: true, force: true });
  mkdirSync(payloadRoot, { recursive: true });
  const files = [];
  files.push(copyBundleFile(summaryPath, payloadRoot, "evidence/media.real_input_local_rehearsal.r27.evidence.json"));
  files.push(copyBundleFile(path.join(outputRoot, "evidence", "normalization.json"), payloadRoot, "evidence/normalization.json"));
  files.push(copyBundleFile(bracketPath, payloadRoot, "initial/media.review_tournament_bracket.r25.v1.json"));
  for (const row of candidateRows) {
    files.push(copyBundleFile(row.file, payloadRoot, `candidates/${row.candidateId}/final.mp4`));
    files.push(copyBundleFile(
      path.join(workRoot, "initial", "render-batch", "candidates", row.candidateId, "media.tournament_candidate_manifest.r25.v1.json"),
      payloadRoot,
      `candidates/${row.candidateId}/media.tournament_candidate_manifest.r25.v1.json`
    ));
  }
  files.push(copyBundleFile(finalPath, payloadRoot, "final/final.mp4"));
  files.push(copyBundleFile(path.join(workRoot, "targeted-reedit", "r27-targeted-reedit-evidence.json"), payloadRoot, "targeted-reedit/r27-targeted-reedit-evidence.json"));
  files.push(copyBundleFile(path.join(workRoot, "targeted-reedit", "media.tournament_targeted_reedit.r25.v1.json"), payloadRoot, "targeted-reedit/media.tournament_targeted_reedit.r25.v1.json"));
  files.push(copyBundleFile(path.join(workRoot, "targeted-reedit", "review-package", "media.review_round_bundle.r21.evidence.json"), payloadRoot, "targeted-reedit/media.review_round_bundle.r21.evidence.json"));

  const bundleManifest = buildR27GrowthBundleManifest({
    producerSha,
    operationBindingDigest: binding.digest,
    input: {
      sha256: inputIdentity.sha256,
      size: inputIdentity.size,
      pathIdentity: inputIdentity.pathIdentity
    },
    normalizedSource: {
      sha256: normalized.sha256,
      size: normalized.size,
      normalizationSpecDigest: normalization.specDigest
    },
    candidates: candidateRows.map(({ file, ...row }) => row),
    targetedReedit: {
      candidateId: targetedEvidence.challengerCandidateId,
      sha256: targetedEvidence.challengerRenderSha256,
      size: final.size,
      decisionClass: targetedEvidence.decisionClass
    },
    finalArtifact: { sha256: final.sha256, size: final.size },
    files
  });
  validateR27GrowthBundleManifest(bundleManifest);
  const manifestPath = path.join(growthRoot, "media.real_input_growth_bundle.r27.manifest.json");
  writeStable(manifestPath, bundleManifest);
  copyStable(manifestPath, path.join(payloadRoot, "media.real_input_growth_bundle.r27.manifest.json"));
  const payloadFiles = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) payloadFiles.push(rel(payloadRoot, full));
    }
  }
  walk(payloadRoot);
  const archivePath = path.join(growthRoot, "media-r27-growth-bundle.tar");
  const archive = createDeterministicTar(payloadRoot, payloadFiles, archivePath);
  const parsed = readDeterministicTar(archivePath);
  if (parsed.sha256 !== archive.sha256 || parsed.entries.size !== payloadFiles.length) {
    fail("R27_BUNDLE_VERIFY", "sealed Growth archive verification failed");
  }
  return { summaryPath, manifestPath, archivePath, archive, bundleManifest };
}
async function runReal(args) {
  const pre = preflight(args.input, args["output-root"]);
  const outputRoot = pre.outputRoot;
  const workRoot = path.join(outputRoot, "work", "r25");
  const ledgerPath = path.join(outputRoot, "state", "r27-ledger.json");
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(path.join(outputRoot, "evidence"), { recursive: true });

  const inputIdentity = { ...r26Sha256File(pre.inputPath), pathIdentity: r26Digest({ canonicalPath: pre.inputPath.toLowerCase() }) };
  const originalProbe = probeMedia(pre.runtime.ffprobe, pre.inputPath);
  const normalization = buildR27NormalizationSpec({
    input: inputIdentity,
    probe: originalProbe,
    ffmpegVersion: pre.runtime.ffmpegVersion,
    runtimeManifestSha256: pre.runtime.manifest.sha256
  });
  const binding = createR27OperationBinding({
    operationId: process.env.R27_OPERATION_ID ?? "media-r27-real-input-local-rehearsal",
    producerSha: pre.producerSha,
    input: inputIdentity,
    probe: originalProbe,
    normalization
  });
  const ctx = {
    outputRoot,
    workRoot,
    ledgerPath,
    producerSha: pre.producerSha,
    binding,
    inputIdentity,
    originalProbe,
    normalization,
    runtime: pre.runtime,
    pre
  };
  activeContext = ctx;
  loadOrCreateR27Ledger(ledgerPath, binding);
  beginR27Invocation(ledgerPath, binding, {
    hostPlatform: process.platform,
    hostArch: process.arch,
    cpuCount: pre.cpuCount,
    totalRamBytes: pre.totalRamBytes,
    inputPathIdentity: inputIdentity.pathIdentity
  });
  console.log("R27_PREFLIGHT_OK", stableStringify({
    producerSha: pre.producerSha,
    inputSha256: inputIdentity.sha256,
    inputSize: inputIdentity.size,
    probe: originalProbe,
    normalizationSpecDigest: normalization.specDigest,
    runtimeManifestSha256: pre.runtime.manifest.sha256,
    outputRoot
  }));

  const env = runtimeEnv(pre.runtime);
  for (let index = 0; index < R27_PHASES.length; index += 1) {
    const phase = R27_PHASES[index];
    activePhase = phase;
    console.log(`[R27] ${index + 1}/${R27_PHASES.length} ${phase}`);
    await runR27DurablePhase({
      ledgerPath,
      binding,
      phase,
      verifyCompleted: async (record) => {
        parseRuntimeManifest(runtimePaths(outputRoot));
        verifyR27Artifacts(record.evidence.artifacts);
        console.log(`[R27] verified/reused ${phase}`);
        return true;
      },
      execute: async () => {
        const started = process.hrtime.bigint();
        if (phase === "input-probe") {
          const file = path.join(outputRoot, "evidence", "input-probe.json");
          writeStable(file, {
            contractVersion: "media.real_input_probe.r27.v1",
            input: inputIdentity,
            probe: originalProbe,
            ffprobeVersion: pre.runtime.ffprobeVersion,
            runtimeManifestSha256: pre.runtime.manifest.sha256,
            probedBeforeRendering: true
          });
        } else if (phase === "normalize-source") {
          const sourcePath = path.join(workRoot, "source.mp4");
          const command = normalizedCommand(pre.runtime, pre.inputPath, sourcePath, originalProbe);
          runSync(command, env);
          const normalizedProbe = probeMedia(pre.runtime.ffprobe, sourcePath);
          if (
            normalizedProbe.hasVideo !== true ||
            normalizedProbe.hasAudio !== true ||
            normalizedProbe.width !== 360 ||
            normalizedProbe.height !== 640 ||
            Math.abs((normalizedProbe.fps ?? 0) - 30) >= 0.01 ||
            normalizedProbe.durationMs < 4900 ||
            normalizedProbe.durationMs > 5100
          ) fail("R27_NORMALIZED_SOURCE_INVALID", `normalized source probe failed: ${stableStringify(normalizedProbe)}`);
          writeStable(path.join(outputRoot, "evidence", "normalization.json"), {
            ...normalization,
            commandDigest: r26Digest({
              binarySha256: r26Sha256File(pre.runtime.ffmpeg).sha256,
              args: command.args.map((x) => x === pre.inputPath ? "<INPUT_PATH>" : x === sourcePath ? "<NORMALIZED_SOURCE>" : x)
            }),
            normalizedSource: r26Sha256File(sourcePath),
            normalizedProbe
          });
        } else if (phase === "targeted-reedit") {
          targetedReedit({ workRoot, producerSha: pre.producerSha, env, ffprobe: pre.runtime.ffprobe });
        } else if (phase === "final-artifact") {
          copyStable(path.join(workRoot, "targeted-reedit", "r19", "final.mp4"), path.join(outputRoot, "final", "final.mp4"));
        } else if (phase === "seal-growth-bundle") {
          sealBundle(ctx);
        } else {
          const child = childPhase(phase, workRoot);
          if (!child) fail("R27_PHASE_INVALID", `no execution route for ${phase}`);
          await runNode(child[0], child[1], env);
        }
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        return {
          producerSha: pre.producerSha,
          bindingDigest: binding.digest,
          elapsedMs: Number(elapsedMs.toFixed(3)),
          artifacts: artifactEvidence(outputRoot, phasePaths(workRoot, outputRoot, phase))
        };
      }
    });
    if (cancellationRequested) fail("R27_CANCELLED", "cancellation requested");
  }
  const ledger = loadOrCreateR27Ledger(ledgerPath, binding);
  console.log("R27_LOCAL_REAL_INPUT_COMPLETE", stableStringify({
    ...r27Status(ledger),
    evidence: r26Sha256File(path.join(outputRoot, "evidence", "media.real_input_local_rehearsal.r27.evidence.json")),
    growthManifest: r26Sha256File(path.join(outputRoot, "growth", "media.real_input_growth_bundle.r27.manifest.json")),
    growthBundle: r26Sha256File(path.join(outputRoot, "growth", "media-r27-growth-bundle.tar")),
    finalArtifact: r26Sha256File(path.join(outputRoot, "final", "final.mp4")),
    authorityState: R27_AUTHORITY_STATE
  }));
}
function status(outputRootArg) {
  if (!outputRootArg) fail("R27_OUTPUT_REQUIRED", "--output-root is required");
  const outputRoot = path.resolve(outputRootArg);
  const ledgerPath = path.join(outputRoot, "state", "r27-ledger.json");
  if (!existsSync(ledgerPath)) {
    console.log(stableStringify({
      contractVersion: MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION,
      state: "NOT_STARTED",
      authorityState: R27_AUTHORITY_STATE,
      nextPhase: R27_PHASES[0],
      liveAuthorization: false
    }));
    return;
  }
  const ledger = validateR27Ledger(JSON.parse(readFileSync(ledgerPath, "utf8")));
  const out = r27Status(ledger);
  const evidence = path.join(outputRoot, "evidence", "media.real_input_local_rehearsal.r27.evidence.json");
  const bundle = path.join(outputRoot, "growth", "media-r27-growth-bundle.tar");
  if (existsSync(evidence)) out.evidence = r26Sha256File(evidence);
  if (existsSync(bundle)) out.growthBundle = r26Sha256File(bundle);
  console.log(stableStringify(out));
}
function verify(outputRootArg) {
  if (!outputRootArg) fail("R27_OUTPUT_REQUIRED", "--output-root is required");
  const outputRoot = path.resolve(outputRootArg);
  const ledgerPath = path.join(outputRoot, "state", "r27-ledger.json");
  if (!existsSync(ledgerPath)) fail("R27_NOT_STARTED", "R27 ledger missing");
  const ledger = validateR27Ledger(JSON.parse(readFileSync(ledgerPath, "utf8")));
  parseRuntimeManifest(runtimePaths(outputRoot));
  for (const phase of Object.keys(ledger.phases)) verifyR27Artifacts(ledger.phases[phase].evidence.artifacts);
  if (ledger.state !== "LOCAL_REAL_INPUT_REHEARSAL_COMPLETE") fail("R27_NOT_COMPLETE", `rehearsal incomplete; next=${r27Status(ledger).nextPhase}`);
  const manifestPath = path.join(outputRoot, "growth", "media.real_input_growth_bundle.r27.manifest.json");
  const manifest = validateR27GrowthBundleManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const final = r26Sha256File(path.join(outputRoot, "final", "final.mp4"));
  if (final.sha256 !== manifest.finalArtifact.sha256 || final.size !== manifest.finalArtifact.size) fail("R27_FINAL_DRIFT", "final artifact drift");
  const archivePath = path.join(outputRoot, "growth", "media-r27-growth-bundle.tar");
  const parsed = readDeterministicTar(archivePath);
  if (!parsed.entries.has("media.real_input_growth_bundle.r27.manifest.json")) fail("R27_BUNDLE_VERIFY", "sealed bundle missing manifest");
  console.log(stableStringify({
    verified: true,
    ...r27Status(ledger),
    finalArtifact: final,
    growthManifestDigest: manifest.manifestDigest,
    growthBundle: r26Sha256File(archivePath)
  }));
}

process.on("SIGINT", () => {
  cancellationRequested = true;
  if (activeContext?.binding && existsSync(activeContext.ledgerPath)) {
    try {
      recordR27Cancellation(activeContext.ledgerPath, activeContext.binding, {
        phase: activePhase,
        reason: "SIGINT",
        completedPhases: r27Status(loadOrCreateR27Ledger(activeContext.ledgerPath, activeContext.binding)).completedPhases
      });
    } catch {}
  }
  if (activeChild) activeChild.kill("SIGINT");
});

const args = parseArgs(process.argv.slice(2));
try {
  if (args.mode === "run") await runReal(args);
  else if (args.mode === "status") status(args["output-root"]);
  else if (args.mode === "verify") verify(args["output-root"]);
  else fail("R27_MODE_INVALID", "mode must be run, status, or verify");
} catch (error) {
  console.error(`[R27] ${error.code ?? "ERROR"}: ${error.message}`);
  process.exitCode = 1;
}
