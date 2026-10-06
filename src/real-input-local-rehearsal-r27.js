import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stableStringify } from "./stable.js";
import { r26Digest, r26Sha256File } from "./local-windows-render-gate-r26.js";

export const MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION = "media.real_input_local_rehearsal.r27.v1";
export const MEDIA_R27_GROWTH_BUNDLE_VERSION = "media.real_input_growth_bundle.r27.v1";
export const R27_AUTHORITY_STATE = "PENDING_INDEPENDENT_QA";
export const R27_CLIP_DURATION_MS = 5000;
export const R27_PHASES = Object.freeze([
  "input-probe",
  "normalize-source",
  "pair-1",
  "candidate-3",
  "candidate-4-segment-1",
  "candidate-4-segment-2",
  "candidate-4-segment-3",
  "candidate-4-segment-4",
  "candidate-4-segment-5",
  "candidate-4-segment-6",
  "candidate-4-assemble",
  "initial-finalize",
  "targeted-reedit",
  "verify-r25",
  "final-artifact",
  "seal-growth-bundle"
]);

export class R27RealInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "R27RealInputError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new R27RealInputError(code, message);
}

function atomicJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, stableStringify(value) + "\n", "utf8");
  try {
    renameSync(temp, filePath);
  } finally {
    rmSync(temp, { force: true });
  }
}

function requireSha(value, field) {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ""))) fail("R27_INVALID_SHA", `${field} must be sha256 hex`);
}

function requireGitSha(value, field) {
  if (!/^[a-f0-9]{40}$/.test(String(value ?? ""))) fail("R27_INVALID_GIT_SHA", `${field} must be git sha`);
}

function normalizePathText(value) {
  return String(value ?? "").replaceAll("/", "\\").replace(/\\+$/, "");
}

export function isR27ProtectedWindowsPath(value) {
  const v = normalizePathText(value).toLowerCase();
  return (
    /^c:\\windows(?:\\|$)/.test(v) ||
    /^c:\\program files(?: \(x86\))?(?:\\|$)/.test(v) ||
    /^c:\\programdata(?:\\|$)/.test(v) ||
    /^c:\\users\\[^\\]+\\appdata(?:\\|$)/.test(v)
  );
}

export function validateR27PathArguments({ inputPath, outputRoot, platform = process.platform }) {
  if (!inputPath || !outputRoot) fail("R27_PATH_REQUIRED", "explicit inputPath and outputRoot are required");
  const input = path.resolve(inputPath);
  const output = path.resolve(outputRoot);
  if (input === output) fail("R27_PATH_CONFLICT", "input path and output root must differ");
  const relInputFromOutput = path.relative(output, input);
  if (relInputFromOutput === "" || (!relInputFromOutput.startsWith("..") && !path.isAbsolute(relInputFromOutput))) {
    fail("R27_PATH_CONFLICT", "input video must not live inside the mutable output root");
  }
  const relOutputFromInputDir = path.relative(path.dirname(input), output);
  if (relOutputFromInputDir === "") fail("R27_PATH_CONFLICT", "output root must not be the input file directory");
  if (platform === "win32" && isR27ProtectedWindowsPath(outputRoot)) {
    fail("R27_PROTECTED_OUTPUT", "output root is inside a protected Windows directory");
  }
  return { inputPath: input, outputRoot: output };
}

export function validateR27Probe(probe) {
  if (!probe || typeof probe !== "object") fail("R27_PROBE_INVALID", "ffprobe evidence missing");
  if (probe.hasVideo !== true) fail("R27_PROBE_NO_VIDEO", "input must contain a video stream");
  if (!Number.isFinite(probe.durationMs) || probe.durationMs < R27_CLIP_DURATION_MS) {
    fail("R27_INPUT_TOO_SHORT", `input must be at least ${R27_CLIP_DURATION_MS} ms`);
  }
  if (!Number.isInteger(probe.width) || probe.width <= 0 || !Number.isInteger(probe.height) || probe.height <= 0) {
    fail("R27_PROBE_INVALID", "input video geometry is invalid");
  }
  if (!Number.isFinite(probe.fps) || probe.fps <= 0) fail("R27_PROBE_INVALID", "input fps is invalid");
  return {
    hasVideo: true,
    hasAudio: probe.hasAudio === true,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    durationMs: probe.durationMs
  };
}

export function buildR27NormalizationSpec({ input, probe, ffmpegVersion, runtimeManifestSha256 }) {
  requireSha(input.sha256, "input.sha256");
  requireSha(runtimeManifestSha256, "runtimeManifestSha256");
  if (!Number.isInteger(input.size) || input.size <= 0) fail("R27_INPUT_INVALID", "input.size must be positive");
  const checkedProbe = validateR27Probe(probe);
  if (!ffmpegVersion) fail("R27_RUNTIME_INVALID", "ffmpegVersion is required");
  const spec = {
    contractVersion: "media.real_input_normalization.r27.v1",
    input: { sha256: input.sha256, size: input.size },
    sourceProbe: checkedProbe,
    clip: { startMs: 0, durationMs: R27_CLIP_DURATION_MS },
    output: { width: 360, height: 640, fps: 30, pixelFormat: "yuv420p" },
    video: {
      codec: "libx264",
      preset: "ultrafast",
      crf: 18,
      scalePolicy: "cover_then_center_crop",
      deterministicThreads: 1
    },
    audio: checkedProbe.hasAudio
      ? { policy: "source_audio_resample", codec: "aac", sampleRate: 48000, bitrate: "128k" }
      : { policy: "inject_silence_for_r25_contract", codec: "aac", sampleRate: 48000, bitrate: "128k" },
    metadata: { stripped: true, creationTime: "1970-01-01T00:00:00Z", bitexactFlags: true },
    runtime: { ffmpegVersion, runtimeManifestSha256 }
  };
  return { ...spec, specDigest: r26Digest(spec) };
}

export function createR27OperationBinding({
  operationId,
  producerSha,
  input,
  probe,
  normalization
}) {
  if (!operationId) fail("R27_OPERATION_ID_REQUIRED", "operationId is required");
  requireGitSha(producerSha, "producerSha");
  requireSha(input.sha256, "input.sha256");
  validateR27Probe(probe);
  requireSha(normalization.specDigest, "normalization.specDigest");
  const value = {
    operationId,
    producerSha,
    input: {
      pathIdentity: input.pathIdentity,
      sha256: input.sha256,
      size: input.size
    },
    probe,
    normalization: {
      specDigest: normalization.specDigest,
      runtimeManifestSha256: normalization.runtime.runtimeManifestSha256
    }
  };
  if (!value.input.pathIdentity) fail("R27_PATH_IDENTITY_REQUIRED", "input.pathIdentity is required");
  return { value, digest: r26Digest(value) };
}

export function createR27Ledger(binding) {
  if (!binding || binding.digest !== r26Digest(binding.value)) fail("R27_BINDING_INVALID", "operation binding digest mismatch");
  return {
    contractVersion: MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION,
    state: "RUNNABLE",
    authorityState: R27_AUTHORITY_STATE,
    binding,
    phaseOrder: [...R27_PHASES],
    phases: {},
    invocations: [],
    cancellationEvents: [],
    providerMutation: false,
    browserMutation: false,
    socialPublish: false,
    liveAuthorization: false
  };
}

export function validateR27Ledger(ledger, expectedBinding = null) {
  if (!ledger || ledger.contractVersion !== MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION) {
    fail("R27_LEDGER_INVALID", "wrong R27 ledger contract");
  }
  if (ledger.authorityState !== R27_AUTHORITY_STATE) fail("R27_AUTHORITY_INVALID", "R27 authority must remain pending QA");
  if (!ledger.binding || ledger.binding.digest !== r26Digest(ledger.binding.value)) {
    fail("R27_LEDGER_CORRUPT", "operation binding digest mismatch");
  }
  if (expectedBinding && expectedBinding.digest !== ledger.binding.digest) {
    fail("R27_OPERATION_CONFLICT", "input/source/normalization changed under the same operation/output root");
  }
  if (stableStringify(ledger.phaseOrder) !== stableStringify(R27_PHASES)) {
    fail("R27_LEDGER_CORRUPT", "phase order drift");
  }
  if (ledger.providerMutation !== false || ledger.browserMutation !== false ||
      ledger.socialPublish !== false || ledger.liveAuthorization !== false) {
    fail("R27_EFFECT_BOUNDARY_BREACH", "live/provider/browser/publish boundary changed");
  }
  for (const [phase, record] of Object.entries(ledger.phases ?? {})) {
    if (!R27_PHASES.includes(phase)) fail("R27_LEDGER_CORRUPT", `unknown phase ${phase}`);
    if (record.phase !== phase || record.evidenceDigest !== r26Digest(record.evidence)) {
      fail("R27_LEDGER_CORRUPT", `phase evidence digest mismatch: ${phase}`);
    }
  }
  return ledger;
}

export function loadOrCreateR27Ledger(filePath, binding) {
  if (!existsSync(filePath)) {
    const ledger = createR27Ledger(binding);
    atomicJson(filePath, ledger);
    return ledger;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("R27_LEDGER_CORRUPT", `cannot parse ledger: ${error.message}`);
  }
  return validateR27Ledger(parsed, binding);
}

export function verifyR27Artifacts(artifacts) {
  for (const artifact of artifacts ?? []) {
    const actual = r26Sha256File(artifact.path);
    if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size) {
      fail("R27_CHECKPOINT_CORRUPT", `artifact drift: ${artifact.path}`);
    }
  }
  return true;
}

export function completeR27Phase(filePath, binding, phase, evidence) {
  if (!R27_PHASES.includes(phase)) fail("R27_PHASE_INVALID", `unknown phase: ${phase}`);
  const ledger = loadOrCreateR27Ledger(filePath, binding);
  const index = R27_PHASES.indexOf(phase);
  for (let i = 0; i < index; i += 1) {
    if (!ledger.phases[R27_PHASES[i]]) fail("R27_PHASE_ORDER", `${phase} requires ${R27_PHASES[i]}`);
  }
  const record = { phase, evidence, evidenceDigest: r26Digest(evidence) };
  const prior = ledger.phases[phase];
  if (prior) {
    if (prior.evidenceDigest !== record.evidenceDigest) fail("R27_PHASE_CONFLICT", `phase replay conflict: ${phase}`);
    return { reused: true, ledger, record: prior };
  }
  ledger.phases[phase] = record;
  if (phase === R27_PHASES.at(-1)) ledger.state = "LOCAL_REAL_INPUT_REHEARSAL_COMPLETE";
  atomicJson(filePath, ledger);
  return { reused: false, ledger: validateR27Ledger(ledger, binding), record };
}

export async function runR27DurablePhase({ ledgerPath, binding, phase, verifyCompleted, execute }) {
  const ledger = loadOrCreateR27Ledger(ledgerPath, binding);
  const prior = ledger.phases[phase];
  if (prior) {
    const ok = await verifyCompleted(prior);
    if (ok !== true) fail("R27_CHECKPOINT_CORRUPT", `completed phase verification failed: ${phase}`);
    return { reused: true, record: prior };
  }
  const evidence = await execute();
  return completeR27Phase(ledgerPath, binding, phase, evidence);
}

export function beginR27Invocation(filePath, binding, details = {}) {
  const ledger = loadOrCreateR27Ledger(filePath, binding);
  const row = {
    sequence: ledger.invocations.length + 1,
    resumedCompletedPhases: R27_PHASES.filter((phase) => ledger.phases[phase]),
    ...details
  };
  ledger.invocations.push(row);
  atomicJson(filePath, ledger);
  return row;
}

export function recordR27Cancellation(filePath, binding, details = {}) {
  const ledger = loadOrCreateR27Ledger(filePath, binding);
  const row = { sequence: ledger.cancellationEvents.length + 1, ...details };
  ledger.cancellationEvents.push(row);
  atomicJson(filePath, ledger);
  return row;
}

export function r27Status(ledger) {
  validateR27Ledger(ledger);
  const completedPhases = R27_PHASES.filter((phase) => ledger.phases[phase]);
  return {
    contractVersion: MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION,
    state: ledger.state,
    authorityState: ledger.authorityState,
    bindingDigest: ledger.binding.digest,
    completedPhases,
    nextPhase: R27_PHASES.find((phase) => !ledger.phases[phase]) ?? null,
    invocationCount: ledger.invocations.length,
    cancellationCount: ledger.cancellationEvents.length,
    liveAuthorization: false
  };
}

export function buildR27GrowthBundleManifest({
  producerSha,
  operationBindingDigest,
  input,
  normalizedSource,
  candidates,
  targetedReedit,
  finalArtifact,
  files
}) {
  requireGitSha(producerSha, "producerSha");
  requireSha(operationBindingDigest, "operationBindingDigest");
  requireSha(input.sha256, "input.sha256");
  requireSha(normalizedSource.sha256, "normalizedSource.sha256");
  if (!Array.isArray(candidates) || candidates.length !== 4) fail("R27_CANDIDATE_COUNT", "exactly four candidates required");
  const ids = new Set();
  const hashes = new Set();
  for (const candidate of candidates) {
    if (!candidate.candidateId || ids.has(candidate.candidateId)) fail("R27_CANDIDATE_ID", "candidate IDs must be unique");
    requireSha(candidate.sha256, `${candidate.candidateId}.sha256`);
    ids.add(candidate.candidateId);
    hashes.add(candidate.sha256);
  }
  if (hashes.size !== 4) fail("R27_CANDIDATE_HASH_COLLISION", "four real candidate hashes must be distinct");
  requireSha(targetedReedit.sha256, "targetedReedit.sha256");
  requireSha(finalArtifact.sha256, "finalArtifact.sha256");
  if (targetedReedit.sha256 !== finalArtifact.sha256) {
    fail("R27_FINAL_LINEAGE", "final artifact must be the sealed targeted re-edit output");
  }
  const sortedFiles = [...files].map((file) => {
    requireSha(file.sha256, `${file.path}.sha256`);
    if (!file.path || file.path.startsWith("/") || file.path.includes("..")) fail("R27_BUNDLE_PATH", "bundle paths must be relative and non-traversing");
    return { path: file.path.replaceAll("\\", "/"), sha256: file.sha256, size: file.size };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    contractVersion: MEDIA_R27_GROWTH_BUNDLE_VERSION,
    mediaContractId: MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION,
    producer: {
      repository: "foto6/video2",
      sha: producerSha,
      authorityState: R27_AUTHORITY_STATE,
      acceptedByIndependentQa: false
    },
    operationBindingDigest,
    inputVideo: input,
    normalizedSource,
    candidates: [...candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    targetedReedit,
    finalArtifact,
    files: sortedFiles,
    evidenceBoundary: {
      realInputBytes: true,
      realEncodedMp4: true,
      fixtureReviewDecision: true,
      liveModelReview: false,
      providerMutation: false,
      browserMutation: false,
      socialPublish: false,
      liveAuthorization: false
    }
  };
  return { ...manifest, manifestDigest: r26Digest(manifest) };
}

export function validateR27GrowthBundleManifest(manifest) {
  if (!manifest || manifest.contractVersion !== MEDIA_R27_GROWTH_BUNDLE_VERSION) fail("R27_BUNDLE_INVALID", "wrong Growth bundle contract");
  if (manifest.mediaContractId !== MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION) fail("R27_BUNDLE_INVALID", "wrong Media contract ID");
  if (manifest.producer?.authorityState !== R27_AUTHORITY_STATE || manifest.producer?.acceptedByIndependentQa !== false) {
    fail("R27_AUTHORITY_INVALID", "bundle cannot self-accept Media authority");
  }
  const copy = structuredClone(manifest);
  const digest = copy.manifestDigest;
  delete copy.manifestDigest;
  if (digest !== r26Digest(copy)) fail("R27_BUNDLE_CORRUPT", "Growth bundle manifest digest mismatch");
  if (manifest.evidenceBoundary?.liveModelReview !== false ||
      manifest.evidenceBoundary?.providerMutation !== false ||
      manifest.evidenceBoundary?.browserMutation !== false ||
      manifest.evidenceBoundary?.socialPublish !== false ||
      manifest.evidenceBoundary?.liveAuthorization !== false) {
    fail("R27_EFFECT_BOUNDARY_BREACH", "Growth bundle live-effect boundary invalid");
  }
  if (manifest.candidates?.length !== 4) fail("R27_CANDIDATE_COUNT", "Growth bundle requires four candidates");
  return manifest;
}
