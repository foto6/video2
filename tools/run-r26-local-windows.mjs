import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTournamentCandidatePlans,
  fingerprint,
  stableStringify
} from "../src/index.js";
import {
  MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION,
  R26_LOCAL_PHASES,
  beginR26Invocation,
  bindR26RenderGraph,
  loadOrCreateR26Ledger,
  r26Digest,
  r26Sha256File,
  r26Status,
  recordR26Cancellation,
  runR26DurablePhase,
  validateR26Ledger,
  verifyR26Artifacts
} from "../src/local-windows-render-gate-r26.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r25Root = path.join(repoRoot, ".artifacts", "r25-demo");
const r26Root = path.join(repoRoot, ".artifacts", "r26-local");
const ledgerPath = path.join(r26Root, "ledger.json");
const evidencePath = path.join(r26Root, "media.local_windows_render_gate.r26.evidence.json");
const runtimeRoot = path.join(r25Root, "ci-ffmpeg-runtime");
const runtimeBin = path.join(runtimeRoot, "bin");
const runtimeManifestPath = path.join(runtimeRoot, "runtime.manifest.sha256");
const EXPECTED_BRANCH = "agent/media-r26-local-windows-render-gate-20261006";
const MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024;
const MIN_RAM_BYTES = 4 * 1024 * 1024 * 1024;
const MIN_CPU_COUNT = 2;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function rel(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function writeStable(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, stableStringify(value) + "\n", "utf8");
  return r26Sha256File(filePath);
}
function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function parseManifest() {
  if (!existsSync(runtimeManifestPath)) fail("R26_RUNTIME_MISSING", "checkpointed FFmpeg manifest missing");
  const lines = readFileSync(runtimeManifestPath, "utf8").split(/\r?\n/).filter(Boolean);
  if (!lines.length) fail("R26_RUNTIME_INVALID", "checkpointed FFmpeg manifest is empty");
  const files = [];
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) fail("R26_RUNTIME_INVALID", `invalid runtime manifest line: ${line}`);
    const relative = match[2].replace(/^\*/, "").replaceAll("/", path.sep);
    const filePath = path.resolve(runtimeRoot, relative);
    const relativeCheck = path.relative(runtimeRoot, filePath);
    if (!relativeCheck || relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
      fail("R26_RUNTIME_INVALID", "runtime manifest path escape");
    }
    const actual = r26Sha256File(filePath);
    if (actual.sha256 !== match[1]) {
      fail("R26_RUNTIME_DRIFT", `runtime digest mismatch: ${relative}`);
    }
    files.push({ path: relative.replaceAll(path.sep, "/"), ...actual });
  }
  return {
    manifest: r26Sha256File(runtimeManifestPath),
    files
  };
}
function versionOf(binary) {
  const output = execFileSync(binary, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return output.split(/\r?\n/)[0].trim();
}
function discoverWindowsBinary(name) {
  const out = execFileSync("where.exe", [name], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const first = out.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  if (!first || !existsSync(first)) fail("R26_PREFLIGHT_FFMPEG", `${name} not found on PATH`);
  return path.resolve(first);
}
function checkpointRuntime() {
  if (existsSync(runtimeManifestPath)) {
    const verified = parseManifest();
    const ffmpeg = path.join(runtimeBin, "ffmpeg.exe");
    const ffprobe = path.join(runtimeBin, "ffprobe.exe");
    if (!existsSync(ffmpeg) || !existsSync(ffprobe)) {
      fail("R26_RUNTIME_INVALID", "checkpoint runtime lacks ffmpeg.exe or ffprobe.exe");
    }
    return {
      ...verified,
      ffmpeg,
      ffprobe,
      ffmpegVersion: versionOf(ffmpeg),
      ffprobeVersion: versionOf(ffprobe),
      source: "existing_verified_checkpoint"
    };
  }
  const ffmpegSource = discoverWindowsBinary("ffmpeg.exe");
  const ffprobeSource = discoverWindowsBinary("ffprobe.exe");
  const ffmpegDir = path.dirname(ffmpegSource);
  const ffprobeDir = path.dirname(ffprobeSource);
  if (ffmpegDir.toLowerCase() !== ffprobeDir.toLowerCase()) {
    fail("R26_PREFLIGHT_FFMPEG", "ffmpeg.exe and ffprobe.exe must come from the same runtime directory");
  }
  mkdirSync(runtimeBin, { recursive: true });
  const names = readdirSync(ffmpegDir)
    .filter((name) => /\.dll$/i.test(name) || /^ff(?:mpeg|probe)\.exe$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  if (!names.some((name) => /^ffmpeg\.exe$/i.test(name)) || !names.some((name) => /^ffprobe\.exe$/i.test(name))) {
    fail("R26_PREFLIGHT_FFMPEG", "resolved FFmpeg directory is incomplete");
  }
  for (const name of names) copyFileSync(path.join(ffmpegDir, name), path.join(runtimeBin, name));
  const manifestLines = readdirSync(runtimeBin)
    .filter((name) => existsSync(path.join(runtimeBin, name)))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const id = r26Sha256File(path.join(runtimeBin, name));
      return `${id.sha256}  bin/${name}`;
    });
  writeFileSync(runtimeManifestPath, manifestLines.join("\n") + "\n", "utf8");
  const verified = parseManifest();
  const ffmpeg = path.join(runtimeBin, "ffmpeg.exe");
  const ffprobe = path.join(runtimeBin, "ffprobe.exe");
  return {
    ...verified,
    ffmpeg,
    ffprobe,
    ffmpegVersion: versionOf(ffmpeg),
    ffprobeVersion: versionOf(ffprobe),
    source: "fresh_checkpoint_from_path_runtime",
    sourceDirectory: ffmpegDir
  };
}
function runtimeEnv() {
  const current = process.env.Path ?? process.env.PATH ?? "";
  return {
    ...process.env,
    Path: `${runtimeBin};${current}`,
    PATH: `${runtimeBin};${current}`
  };
}
function preflight() {
  if (process.platform !== "win32") {
    fail("R26_WINDOWS_REQUIRED", "real R26 render path must run on Windows; hosted CI uses tiny control fixtures only");
  }
  const branch = git(["branch", "--show-current"]);
  if (branch !== EXPECTED_BRANCH) fail("R26_BRANCH_MISMATCH", `expected branch ${EXPECTED_BRANCH}, got ${branch}`);
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) fail("R26_WORKTREE_DIRTY", "tracked worktree changes are not allowed for evidence collection");
  const producerSha = git(["rev-parse", "HEAD"]);
  const cpuCount = os.cpus().length;
  const totalRamBytes = os.totalmem();
  if (cpuCount < MIN_CPU_COUNT) fail("R26_PREFLIGHT_CPU", `requires at least ${MIN_CPU_COUNT} logical CPUs`);
  if (totalRamBytes < MIN_RAM_BYTES) fail("R26_PREFLIGHT_RAM", "requires at least 4 GiB RAM");
  mkdirSync(r26Root, { recursive: true });
  mkdirSync(r25Root, { recursive: true });
  const disk = statfsSync(repoRoot);
  const freeDiskBytes = Number(disk.bavail) * Number(disk.bsize);
  if (freeDiskBytes < MIN_FREE_BYTES) fail("R26_PREFLIGHT_DISK", "requires at least 4 GiB free on the repository volume");
  const runtime = checkpointRuntime();
  const check = execFileSync(runtime.ffmpeg, [
    "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.05",
    "-frames:v", "1", "-f", "null", "-"
  ], {
    env: runtimeEnv(),
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  void check;
  return {
    producerSha,
    branch,
    cpuCount,
    totalRamBytes,
    freeDiskBytes,
    runtime,
    nodeVersion: process.version
  };
}
function phaseOutputPaths(phase) {
  const initial = path.join(r25Root, "initial");
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
    path.join(r25Root, "targeted-reedit", "r19", "final.mp4"),
    path.join(r25Root, "targeted-reedit", "media.tournament_targeted_reedit.r25.v1.json"),
    path.join(r25Root, "r25-readiness-evidence.json"),
    path.join(r25Root, "media-r25-rehearsal.tar")
  ];
  if (phase === "verify") return [
    path.join(r25Root, "r25-verification-evidence.json")
  ];
  fail("R26_PHASE_INVALID", `no output map for ${phase}`);
}
function phaseCommand(phase) {
  if (phase === "pair-1") return ["tools/materialize-r25-ci-phase.mjs", ["--phase", "pair-1"]];
  if (phase === "candidate-3") return ["tools/materialize-r25-ci-phase.mjs", ["--phase", "candidate-3"]];
  const segment = phase.match(/^candidate-4-(segment-[1-6])$/)?.[1];
  if (segment) return ["tools/materialize-r25-candidate4-subphase.mjs", ["--phase", segment]];
  if (phase === "candidate-4-assemble") return ["tools/materialize-r25-candidate4-subphase.mjs", ["--phase", "assemble"]];
  if (phase === "initial-finalize") return ["tools/materialize-r25-ci-phase.mjs", ["--phase", "finalize"]];
  if (phase === "targeted-reedit") return ["tools/demo-r25-tournament.mjs", []];
  if (phase === "verify") return ["tools/verify-r25-rehearsal.mjs", []];
  fail("R26_PHASE_INVALID", `no command for ${phase}`);
}
let activeChild = null;
let activePhase = null;
let activeBootstrap = null;
let cancellationRequested = false;

function runChild(script, args, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, script), ...args], {
      cwd: repoRoot,
      env: { ...runtimeEnv(), ...envExtra },
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
          ? `R26 cancelled during ${activePhase}`
          : `R26 phase ${activePhase} failed: code=${code} signal=${signal ?? "none"}`);
        error.code = cancellationRequested ? "R26_CANCELLED" : "R26_PHASE_FAILED";
        reject(error);
      }
    });
  });
}
function artifactEvidence(paths) {
  return paths.map((filePath) => ({ path: filePath, relativePath: rel(filePath), ...r26Sha256File(filePath) }));
}
function ensureRenderBinding(bootstrap) {
  const requestPath = path.join(r25Root, "request.json");
  const sourcePath = path.join(r25Root, "source.mp4");
  if (!existsSync(requestPath) || !existsSync(sourcePath)) fail("R26_BINDING_MISSING", "pair-1 did not materialize request/source");
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  const source = r26Sha256File(sourcePath);
  if (source.sha256 !== request.source.sha256 || source.size !== request.source.size) {
    fail("R26_SOURCE_DRIFT", "source bytes no longer match R25 request");
  }
  const plans = buildTournamentCandidatePlans(request);
  const planProjection = plans.map((entry) => ({
    candidateId: entry.candidateId,
    strategy: entry.strategy,
    operationGraphDigest: entry.operationGraphDigest,
    planDigest: fingerprint(entry.plan)
  }));
  return bindR26RenderGraph(ledgerPath, bootstrap, {
    source,
    requestSha256: r26Sha256File(requestPath).sha256,
    planDigest: r26Digest(planProjection),
    renderGraphDigest: r26Digest(planProjection.map((x) => ({
      candidateId: x.candidateId,
      operationGraphDigest: x.operationGraphDigest
    })))
  });
}
async function runPhase(bootstrap, phase, index) {
  activePhase = phase;
  const [script, args] = phaseCommand(phase);
  console.log(`[R26] ${index + 1}/${R26_LOCAL_PHASES.length} ${phase}`);
  const result = await runR26DurablePhase({
    ledgerPath,
    bootstrap,
    phase,
    verifyCompleted: async (record) => {
      parseManifest();
      verifyR26Artifacts(record.evidence.artifacts);
      console.log(`[R26] verified/reused ${phase}`);
      return true;
    },
    execute: async () => {
      parseManifest();
      const started = process.hrtime.bigint();
      const extra = phase === "targeted-reedit" ? { R25_INITIAL_PREMATERIALIZED: "1" } : {};
      await runChild(script, args, extra);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      const outputs = phaseOutputPaths(phase);
      const artifacts = artifactEvidence(outputs);
      return {
        producerSha: bootstrap.producerSha,
        runtimeManifestSha256: bootstrap.runtimeManifestSha256,
        commandDigest: r26Digest({ script, args, extra }),
        elapsedMs: Number(elapsedMs.toFixed(3)),
        artifacts
      };
    }
  });
  if (phase === "pair-1") ensureRenderBinding(bootstrap);
  return result;
}
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
function collectEvidence(pre, bootstrap) {
  const ledger = loadOrCreateR26Ledger(ledgerPath, bootstrap);
  validateR26Ledger(ledger, bootstrap);
  if (ledger.state !== "LOCAL_REHEARSAL_COMPLETE") fail("R26_NOT_COMPLETE", "all durable phases must complete before evidence collection");
  for (const phase of R26_LOCAL_PHASES) verifyR26Artifacts(ledger.phases[phase].evidence.artifacts);

  const requestPath = path.join(r25Root, "request.json");
  const sourcePath = path.join(r25Root, "source.mp4");
  const initialEvidence = readJson(path.join(r25Root, "initial", "media.edit_tournament.r25.evidence.json"));
  const readiness = readJson(path.join(r25Root, "r25-readiness-evidence.json"));
  const candidateHashes = [1, 2, 3, 4].map((n) => {
    const filePath = path.join(r25Root, "initial", "render-batch", "candidates", `candidate-${n}`, "final.mp4");
    return { candidateId: `candidate-${n}`, path: rel(filePath), ...r26Sha256File(filePath) };
  });
  const targetedPath = path.join(r25Root, "targeted-reedit", "r19", "final.mp4");
  const final = r26Sha256File(targetedPath);
  const runtime = parseManifest();
  const evidence = {
    contractVersion: MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION,
    state: "LOCAL_REAL_RENDER_COMPLETE",
    producer: {
      repository: "foto6/video2",
      branch: EXPECTED_BRANCH,
      sha: bootstrap.producerSha
    },
    operationId: bootstrap.operationId,
    renderBinding: ledger.renderBinding,
    source: {
      path: rel(sourcePath),
      ...r26Sha256File(sourcePath),
      classification: "deterministic_ffmpeg_fixture_real_encoded_mp4"
    },
    request: {
      path: rel(requestPath),
      ...r26Sha256File(requestPath)
    },
    runtime: {
      manifestPath: rel(runtimeManifestPath),
      manifestSha256: runtime.manifest.sha256,
      files: runtime.files,
      ffmpegVersion: pre.runtime.ffmpegVersion,
      ffprobeVersion: pre.runtime.ffprobeVersion
    },
    candidates: candidateHashes,
    bracket: {
      digest: initialEvidence.bracket.digest,
      reviewPackages: initialEvidence.bracket.reviewPackages,
      selectionEvidenceClass: "fixture_rehearsal_no_live_model_judgment"
    },
    targetedReedit: {
      baselineCandidateId: readiness.targetedReedit.baselineCandidateId,
      baselineRenderSha256: readiness.targetedReedit.baselineRenderSha256,
      challengerCandidateId: readiness.targetedReedit.challengerCandidateId,
      challengerRenderSha256: readiness.targetedReedit.challengerRenderSha256,
      file: { path: rel(targetedPath), ...final },
      targetedEvidenceDigest: r26Sha256File(path.join(r25Root, "targeted-reedit", "media.tournament_targeted_reedit.r25.v1.json")).sha256
    },
    finalArtifact: {
      selectionClass: "fixture_targeted_reedit_challenger",
      path: rel(targetedPath),
      ...final
    },
    timingsMs: Object.fromEntries(R26_LOCAL_PHASES.map((phase) => [
      phase,
      ledger.phases[phase].evidence.elapsedMs
    ])),
    resumeRestartEvidence: {
      invocationCount: ledger.invocations.length,
      invocations: ledger.invocations,
      cancellationEvents: ledger.cancellationEvents,
      completedPhases: R26_LOCAL_PHASES
    },
    controls: {
      actualEncodedMp4BytesRequired: true,
      syntheticPlaceholderAcceptedAsLiveEvidence: false,
      completedPhaseReuseRequiresHashVerification: true,
      changedGraphSameOperationIdFailsClosed: true,
      modelReviewPerformed: false,
      providerCalls: false,
      browserCalls: false,
      socialPublish: false,
      credentialsRequired: false,
      adminRequired: false,
      liveAuthorization: false
    }
  };
  const id = writeStable(evidencePath, evidence);
  console.log(`[R26] evidence ${rel(evidencePath)} sha256=${id.sha256}`);
  return { evidence, id };
}
function printStatus() {
  if (!existsSync(ledgerPath)) {
    console.log(stableStringify({
      contractVersion: MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION,
      state: "NOT_STARTED",
      nextPhase: R26_LOCAL_PHASES[0],
      liveAuthorization: false
    }));
    return;
  }
  const ledger = validateR26Ledger(JSON.parse(readFileSync(ledgerPath, "utf8")));
  const status = r26Status(ledger);
  if (existsSync(evidencePath)) status.evidence = { path: rel(evidencePath), ...r26Sha256File(evidencePath) };
  console.log(stableStringify(status));
}
function verifyOnly() {
  if (!existsSync(ledgerPath)) fail("R26_NOT_STARTED", "R26 ledger does not exist");
  const ledger = validateR26Ledger(JSON.parse(readFileSync(ledgerPath, "utf8")));
  parseManifest();
  for (const phase of Object.keys(ledger.phases)) verifyR26Artifacts(ledger.phases[phase].evidence.artifacts);
  if (ledger.state === "LOCAL_REHEARSAL_COMPLETE" && !existsSync(evidencePath)) {
    fail("R26_EVIDENCE_MISSING", "completed render is missing collected R26 evidence");
  }
  if (existsSync(evidencePath)) {
    const evidence = readJson(evidencePath);
    if (evidence.contractVersion !== MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION) fail("R26_EVIDENCE_INVALID", "wrong evidence contract");
    const final = r26Sha256File(path.resolve(repoRoot, evidence.finalArtifact.path));
    if (final.sha256 !== evidence.finalArtifact.sha256 || final.size !== evidence.finalArtifact.size) {
      fail("R26_EVIDENCE_DRIFT", "final artifact no longer matches collected evidence");
    }
  }
  console.log(stableStringify({ verified: true, ...r26Status(ledger) }));
}

process.on("SIGINT", () => {
  cancellationRequested = true;
  if (activeBootstrap && existsSync(ledgerPath)) {
    try {
      recordR26Cancellation(ledgerPath, activeBootstrap, {
        phase: activePhase,
        reason: "SIGINT",
        completedPhases: Object.keys(loadOrCreateR26Ledger(ledgerPath, activeBootstrap).phases)
      });
    } catch {}
  }
  if (activeChild) activeChild.kill("SIGINT");
});

const mode = String(process.argv[2] ?? "run").toLowerCase();
try {
  if (mode === "status") {
    printStatus();
  } else if (mode === "verify") {
    verifyOnly();
  } else if (mode === "run") {
    const pre = preflight();
    console.log(stableStringify({
      event: "R26_PREFLIGHT_OK",
      branch: pre.branch,
      producerSha: pre.producerSha,
      cpuCount: pre.cpuCount,
      totalRamBytes: pre.totalRamBytes,
      freeDiskBytes: pre.freeDiskBytes,
      ffmpegVersion: pre.runtime.ffmpegVersion,
      runtimeManifestSha256: pre.runtime.manifest.sha256
    }));
    const bootstrap = {
      operationId: process.env.R26_OPERATION_ID ?? "media-r26-local-windows-real-render",
      producerSha: pre.producerSha,
      runtimeManifestSha256: pre.runtime.manifest.sha256
    };
    activeBootstrap = bootstrap;
    loadOrCreateR26Ledger(ledgerPath, bootstrap);
    beginR26Invocation(ledgerPath, bootstrap, {
      hostPlatform: process.platform,
      hostArch: process.arch,
      cpuCount: pre.cpuCount,
      totalRamBytes: pre.totalRamBytes
    });
    for (let index = 0; index < R26_LOCAL_PHASES.length; index += 1) {
      await runPhase(bootstrap, R26_LOCAL_PHASES[index], index);
      if (cancellationRequested) fail("R26_CANCELLED", "cancellation requested");
    }
    const result = collectEvidence(pre, bootstrap);
    console.log(stableStringify({
      event: "R26_LOCAL_REAL_RENDER_COMPLETE",
      evidenceSha256: result.id.sha256,
      finalArtifact: result.evidence.finalArtifact,
      liveAuthorization: false
    }));
  } else {
    fail("R26_MODE_INVALID", "mode must be run, status, or verify");
  }
} catch (error) {
  console.error(`[R26] ${error.code ?? "ERROR"}: ${error.message}`);
  process.exitCode = 1;
}
