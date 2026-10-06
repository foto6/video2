import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { stableStringify } from "./stable.js";

export const MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION = "media.local_windows_render_gate.r26.v1";
export const R26_LOCAL_PHASES = Object.freeze([
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
  "verify"
]);

export class R26LocalRenderGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "R26LocalRenderGateError";
    this.code = code;
  }
}

export function r26Sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function r26Sha256File(filePath) {
  if (!existsSync(filePath)) {
    throw new R26LocalRenderGateError("R26_ARTIFACT_MISSING", `missing artifact: ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  return { sha256: r26Sha256Bytes(bytes), size: bytes.length };
}

export function r26Digest(value) {
  return r26Sha256Bytes(Buffer.from(stableStringify(value), "utf8"));
}

function atomicWriteJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, stableStringify(value) + "\n", "utf8");
  try {
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function requireHex(value, field) {
  if (!/^[a-f0-9]{64}$/.test(String(value ?? ""))) {
    throw new R26LocalRenderGateError("R26_LEDGER_INVALID", `${field} must be sha256 hex`);
  }
}

function validateBootstrap(bootstrap) {
  if (!bootstrap || typeof bootstrap !== "object") {
    throw new R26LocalRenderGateError("R26_LEDGER_INVALID", "bootstrap missing");
  }
  if (!bootstrap.operationId || !bootstrap.producerSha) {
    throw new R26LocalRenderGateError("R26_LEDGER_INVALID", "bootstrap identity missing");
  }
  requireHex(bootstrap.runtimeManifestSha256, "runtimeManifestSha256");
  return bootstrap;
}

export function createR26Ledger(bootstrap) {
  validateBootstrap(bootstrap);
  const immutable = {
    operationId: bootstrap.operationId,
    producerSha: bootstrap.producerSha,
    runtimeManifestSha256: bootstrap.runtimeManifestSha256
  };
  return {
    contractVersion: MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION,
    state: "RUNNABLE",
    bootstrap: immutable,
    bootstrapDigest: r26Digest(immutable),
    renderBinding: null,
    phaseOrder: [...R26_LOCAL_PHASES],
    phases: {},
    invocations: [],
    cancellationEvents: [],
    liveAuthorization: false,
    providerCalls: false,
    browserCalls: false,
    socialPublish: false
  };
}

export function validateR26Ledger(ledger, expectedBootstrap = null) {
  if (!ledger || ledger.contractVersion !== MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION) {
    throw new R26LocalRenderGateError("R26_LEDGER_INVALID", "wrong R26 ledger contract");
  }
  validateBootstrap(ledger.bootstrap);
  if (ledger.bootstrapDigest !== r26Digest(ledger.bootstrap)) {
    throw new R26LocalRenderGateError("R26_LEDGER_CORRUPT", "bootstrap digest mismatch");
  }
  if (stableStringify(ledger.phaseOrder) !== stableStringify(R26_LOCAL_PHASES)) {
    throw new R26LocalRenderGateError("R26_LEDGER_CORRUPT", "phase order drift");
  }
  if (expectedBootstrap) {
    const expected = createR26Ledger(expectedBootstrap);
    if (expected.bootstrapDigest !== ledger.bootstrapDigest) {
      throw new R26LocalRenderGateError(
        "R26_OPERATION_CONFLICT",
        "operation ID, producer SHA, or FFmpeg runtime changed for existing ledger"
      );
    }
  }
  if (ledger.renderBinding) {
    if (ledger.renderBinding.digest !== r26Digest(ledger.renderBinding.value)) {
      throw new R26LocalRenderGateError("R26_LEDGER_CORRUPT", "render binding digest mismatch");
    }
    requireHex(ledger.renderBinding.value.source.sha256, "renderBinding.source.sha256");
    requireHex(ledger.renderBinding.value.requestSha256, "renderBinding.requestSha256");
    requireHex(ledger.renderBinding.value.planDigest, "renderBinding.planDigest");
    requireHex(ledger.renderBinding.value.renderGraphDigest, "renderBinding.renderGraphDigest");
  }
  for (const [phase, record] of Object.entries(ledger.phases ?? {})) {
    if (!R26_LOCAL_PHASES.includes(phase)) {
      throw new R26LocalRenderGateError("R26_LEDGER_CORRUPT", `unknown completed phase: ${phase}`);
    }
    if (!record || record.phase !== phase || record.evidenceDigest !== r26Digest(record.evidence)) {
      throw new R26LocalRenderGateError("R26_LEDGER_CORRUPT", `phase record digest mismatch: ${phase}`);
    }
  }
  return ledger;
}

export function loadOrCreateR26Ledger(filePath, bootstrap) {
  if (existsSync(filePath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new R26LocalRenderGateError("R26_LEDGER_CORRUPT", `cannot parse ledger: ${error.message}`);
    }
    return validateR26Ledger(parsed, bootstrap);
  }
  const created = createR26Ledger(bootstrap);
  atomicWriteJson(filePath, created);
  return created;
}

export function bindR26RenderGraph(filePath, bootstrap, value) {
  const ledger = loadOrCreateR26Ledger(filePath, bootstrap);
  const normalized = {
    source: {
      sha256: value.source.sha256,
      size: value.source.size
    },
    requestSha256: value.requestSha256,
    planDigest: value.planDigest,
    renderGraphDigest: value.renderGraphDigest
  };
  requireHex(normalized.source.sha256, "source.sha256");
  requireHex(normalized.requestSha256, "requestSha256");
  requireHex(normalized.planDigest, "planDigest");
  requireHex(normalized.renderGraphDigest, "renderGraphDigest");
  const digest = r26Digest(normalized);
  if (ledger.renderBinding && ledger.renderBinding.digest !== digest) {
    throw new R26LocalRenderGateError(
      "R26_OPERATION_CONFLICT",
      "changed source/request/render graph under the same operation ID"
    );
  }
  if (!ledger.renderBinding) {
    ledger.renderBinding = { digest, value: normalized };
    atomicWriteJson(filePath, ledger);
  }
  return validateR26Ledger(ledger, bootstrap);
}

export function verifyR26Artifacts(artifacts) {
  for (const artifact of artifacts ?? []) {
    const actual = r26Sha256File(artifact.path);
    if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size) {
      throw new R26LocalRenderGateError(
        "R26_CHECKPOINT_CORRUPT",
        `completed phase artifact drift: ${artifact.path}`
      );
    }
  }
  return true;
}

export function completeR26Phase(filePath, bootstrap, phase, evidence) {
  if (!R26_LOCAL_PHASES.includes(phase)) {
    throw new R26LocalRenderGateError("R26_PHASE_INVALID", `unknown phase: ${phase}`);
  }
  const ledger = loadOrCreateR26Ledger(filePath, bootstrap);
  const index = R26_LOCAL_PHASES.indexOf(phase);
  for (let i = 0; i < index; i += 1) {
    if (!ledger.phases[R26_LOCAL_PHASES[i]]) {
      throw new R26LocalRenderGateError(
        "R26_PHASE_ORDER",
        `${phase} cannot complete before ${R26_LOCAL_PHASES[i]}`
      );
    }
  }
  const record = { phase, evidence, evidenceDigest: r26Digest(evidence) };
  const prior = ledger.phases[phase];
  if (prior) {
    if (prior.evidenceDigest !== record.evidenceDigest) {
      throw new R26LocalRenderGateError("R26_PHASE_CONFLICT", `phase replay conflict: ${phase}`);
    }
    return { ledger, reused: true, record: prior };
  }
  ledger.phases[phase] = record;
  if (phase === R26_LOCAL_PHASES.at(-1)) ledger.state = "LOCAL_REHEARSAL_COMPLETE";
  atomicWriteJson(filePath, ledger);
  return { ledger: validateR26Ledger(ledger, bootstrap), reused: false, record };
}

export async function runR26DurablePhase({
  ledgerPath,
  bootstrap,
  phase,
  verifyCompleted,
  execute
}) {
  const ledger = loadOrCreateR26Ledger(ledgerPath, bootstrap);
  const prior = ledger.phases[phase];
  if (prior) {
    const ok = await verifyCompleted(prior);
    if (ok !== true) {
      throw new R26LocalRenderGateError("R26_CHECKPOINT_CORRUPT", `verification failed: ${phase}`);
    }
    return { reused: true, record: prior };
  }
  const evidence = await execute();
  const completed = completeR26Phase(ledgerPath, bootstrap, phase, evidence);
  return { reused: false, record: completed.record };
}

export function beginR26Invocation(filePath, bootstrap, details = {}) {
  const ledger = loadOrCreateR26Ledger(filePath, bootstrap);
  const invocation = {
    sequence: ledger.invocations.length + 1,
    resumedCompletedPhases: Object.keys(ledger.phases),
    ...details
  };
  ledger.invocations.push(invocation);
  atomicWriteJson(filePath, ledger);
  return invocation;
}

export function recordR26Cancellation(filePath, bootstrap, details = {}) {
  const ledger = loadOrCreateR26Ledger(filePath, bootstrap);
  ledger.cancellationEvents.push({
    sequence: ledger.cancellationEvents.length + 1,
    ...details
  });
  atomicWriteJson(filePath, ledger);
  return ledger.cancellationEvents.at(-1);
}

export function r26Status(ledger) {
  validateR26Ledger(ledger);
  const completed = R26_LOCAL_PHASES.filter((phase) => ledger.phases[phase]);
  const next = R26_LOCAL_PHASES.find((phase) => !ledger.phases[phase]) ?? null;
  return {
    contractVersion: MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION,
    state: ledger.state,
    operationId: ledger.bootstrap.operationId,
    producerSha: ledger.bootstrap.producerSha,
    renderBindingDigest: ledger.renderBinding?.digest ?? null,
    completedPhases: completed,
    nextPhase: next,
    invocationCount: ledger.invocations.length,
    cancellationCount: ledger.cancellationEvents.length,
    liveAuthorization: false
  };
}
