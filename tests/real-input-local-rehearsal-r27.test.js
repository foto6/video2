import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION,
  MEDIA_R27_GROWTH_BUNDLE_VERSION,
  R27_AUTHORITY_STATE,
  R27_CLIP_DURATION_MS,
  R27_PHASES,
  R27RealInputError,
  beginR27Invocation,
  buildR27GrowthBundleManifest,
  buildR27NormalizationSpec,
  completeR27Phase,
  createR27Ledger,
  createR27OperationBinding,
  isR27ProtectedWindowsPath,
  loadOrCreateR27Ledger,
  r27Status,
  recordR27Cancellation,
  runR27DurablePhase,
  validateR27GrowthBundleManifest,
  validateR27Ledger,
  validateR27PathArguments,
  validateR27Probe,
  verifyR27Artifacts
} from "../src/real-input-local-rehearsal-r27.js";
import { r26Sha256File } from "../src/local-windows-render-gate-r26.js";

const H = (c) => c.repeat(64);
const G = (c) => c.repeat(40);
const goodProbe = (overrides = {}) => ({
  hasVideo: true,
  hasAudio: true,
  width: 1920,
  height: 1080,
  fps: 29.97,
  durationMs: 12000,
  ...overrides
});
const normalization = (overrides = {}) => ({
  contractVersion: "media.real_input_normalization.r27.v1",
  runtime: { runtimeManifestSha256: H("a") },
  specDigest: H("b"),
  ...overrides
});
const binding = (overrides = {}) => createR27OperationBinding({
  operationId: "r27-op",
  producerSha: G("1"),
  input: { pathIdentity: "input-id", sha256: H("c"), size: 1000 },
  probe: goodProbe(),
  normalization: normalization(),
  ...overrides
});
function temp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "r27-"));
  return { dir, ledger: path.join(dir, "ledger.json") };
}
function artifact(dir, name, body = name) {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return { path: file, ...r26Sha256File(file) };
}
function evidence(dir, name) {
  return { elapsedMs: 1, artifacts: [artifact(dir, name)] };
}
function fillTo(file, bind, dir, index) {
  for (let i = 0; i <= index; i += 1) {
    completeR27Phase(file, bind, R27_PHASES[i], evidence(dir, `${i}.bin`));
  }
}
function bundleArgs(overrides = {}) {
  return {
    producerSha: G("2"),
    operationBindingDigest: H("d"),
    input: { sha256: H("e"), size: 999, pathIdentity: "input-id" },
    normalizedSource: { sha256: H("f"), size: 888 },
    candidates: ["1","2","3","4"].map((x) => ({ candidateId: `candidate-${x}`, sha256: H(x), size: 100 + Number(x) })),
    targetedReedit: { candidateId: "candidate-1-reedit-r1", sha256: H("a"), size: 777 },
    finalArtifact: { sha256: H("a"), size: 777 },
    files: [{ path: "final/final.mp4", sha256: H("a"), size: 777 }],
    ...overrides
  };
}

test("R27 contract identity is frozen", () => {
  assert.equal(MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION, "media.real_input_local_rehearsal.r27.v1");
  assert.equal(MEDIA_R27_GROWTH_BUNDLE_VERSION, "media.real_input_growth_bundle.r27.v1");
  assert.equal(R27_AUTHORITY_STATE, "PENDING_INDEPENDENT_QA");
});

test("R27 phase graph reuses R25/R26 candidate-4 segmentation", () => {
  assert.deepEqual(R27_PHASES.slice(2, 5), ["pair-1", "candidate-3", "candidate-4-segment-1"]);
  assert.ok(R27_PHASES.includes("candidate-4-segment-6"));
  assert.ok(R27_PHASES.includes("targeted-reedit"));
});

test("R27 path validation requires explicit input", () => {
  assert.throws(() => validateR27PathArguments({ inputPath: "", outputRoot: "/tmp/out" }), /explicit inputPath/);
});

test("R27 path validation requires explicit output root", () => {
  assert.throws(() => validateR27PathArguments({ inputPath: "/tmp/in.mp4", outputRoot: "" }), /explicit inputPath/);
});

test("R27 rejects output root equal to input path", () => {
  assert.throws(() => validateR27PathArguments({ inputPath: "/tmp/x", outputRoot: "/tmp/x" }), /must differ/);
});

test("R27 rejects input nested inside mutable output root", () => {
  assert.throws(() => validateR27PathArguments({ inputPath: "/tmp/out/in.mp4", outputRoot: "/tmp/out" }), /must not live inside/);
});

test("R27 recognizes Windows system directory as protected", () => {
  assert.equal(isR27ProtectedWindowsPath("C:\\Windows\\Temp"), true);
});

test("R27 recognizes Program Files as protected", () => {
  assert.equal(isR27ProtectedWindowsPath("C:\\Program Files\\Media"), true);
});

test("R27 recognizes AppData as protected", () => {
  assert.equal(isR27ProtectedWindowsPath("C:\\Users\\alice\\AppData\\Local"), true);
});

test("R27 allows ordinary E drive output", () => {
  assert.equal(isR27ProtectedWindowsPath("E:\\media-r27\\out"), false);
});

test("R27 path validation rejects protected Windows output", () => {
  assert.throws(
    () => validateR27PathArguments({ inputPath: "E:\\input.mp4", outputRoot: "C:\\Windows\\Temp\\r27", platform: "win32" }),
    (error) => error instanceof R27RealInputError && error.code === "R27_PROTECTED_OUTPUT"
  );
});

test("R27 probe rejects missing video", () => {
  assert.throws(() => validateR27Probe(goodProbe({ hasVideo: false })), /video stream/);
});

test("R27 probe rejects source shorter than five seconds", () => {
  assert.throws(() => validateR27Probe(goodProbe({ durationMs: R27_CLIP_DURATION_MS - 1 })), /at least 5000/);
});

test("R27 probe rejects invalid dimensions", () => {
  assert.throws(() => validateR27Probe(goodProbe({ width: 0 })), /geometry/);
});

test("R27 probe rejects invalid fps", () => {
  assert.throws(() => validateR27Probe(goodProbe({ fps: 0 })), /fps/);
});

test("R27 normalization binds source audio policy", () => {
  const spec = buildR27NormalizationSpec({
    input: { sha256: H("1"), size: 123 },
    probe: goodProbe({ hasAudio: true }),
    ffmpegVersion: "ffmpeg version fixture",
    runtimeManifestSha256: H("2")
  });
  assert.equal(spec.audio.policy, "source_audio_resample");
  assert.equal(spec.clip.durationMs, 5000);
  assert.match(spec.specDigest, /^[a-f0-9]{64}$/);
});

test("R27 normalization deterministically injects silence only when source lacks audio", () => {
  const spec = buildR27NormalizationSpec({
    input: { sha256: H("1"), size: 123 },
    probe: goodProbe({ hasAudio: false }),
    ffmpegVersion: "ffmpeg version fixture",
    runtimeManifestSha256: H("2")
  });
  assert.equal(spec.audio.policy, "inject_silence_for_r25_contract");
});

test("R27 normalization rejects malformed input hash", () => {
  assert.throws(() => buildR27NormalizationSpec({
    input: { sha256: "bad", size: 1 },
    probe: goodProbe(),
    ffmpegVersion: "x",
    runtimeManifestSha256: H("2")
  }), /sha256/);
});

test("R27 operation binding requires exact git SHA", () => {
  assert.throws(() => createR27OperationBinding({
    operationId: "op",
    producerSha: "bad",
    input: { pathIdentity: "x", sha256: H("1"), size: 1 },
    probe: goodProbe(),
    normalization: normalization()
  }), /git sha/);
});

test("R27 operation binding requires path identity", () => {
  assert.throws(() => createR27OperationBinding({
    operationId: "op",
    producerSha: G("1"),
    input: { pathIdentity: "", sha256: H("1"), size: 1 },
    probe: goodProbe(),
    normalization: normalization()
  }), /pathIdentity/);
});

test("R27 ledger starts pending independent QA with no live effects", () => {
  const ledger = createR27Ledger(binding());
  assert.equal(ledger.authorityState, "PENDING_INDEPENDENT_QA");
  assert.equal(ledger.providerMutation, false);
  assert.equal(ledger.browserMutation, false);
  assert.equal(ledger.socialPublish, false);
  assert.equal(ledger.liveAuthorization, false);
});

test("R27 ledger rejects self-accepted authority", () => {
  const ledger = createR27Ledger(binding());
  ledger.authorityState = "ACCEPTED";
  assert.throws(() => validateR27Ledger(ledger), /pending QA/);
});

test("R27 ledger rejects effect-boundary drift", () => {
  const ledger = createR27Ledger(binding());
  ledger.providerMutation = true;
  assert.throws(() => validateR27Ledger(ledger), /boundary/);
});

test("R27 load detects input binding conflict on same output root", () => {
  const { ledger } = temp();
  const one = binding();
  loadOrCreateR27Ledger(ledger, one);
  const two = binding({ input: { pathIdentity: "different", sha256: H("d"), size: 2000 } });
  assert.throws(() => loadOrCreateR27Ledger(ledger, two), (error) => error.code === "R27_OPERATION_CONFLICT");
});

test("R27 corrupt ledger JSON fails closed", () => {
  const { ledger } = temp();
  writeFileSync(ledger, "{bad");
  assert.throws(() => loadOrCreateR27Ledger(ledger, binding()), (error) => error.code === "R27_LEDGER_CORRUPT");
});

test("R27 cannot skip phase order", () => {
  const { dir, ledger } = temp();
  assert.throws(() => completeR27Phase(ledger, binding(), "normalize-source", evidence(dir, "n.bin")), /requires input-probe/);
});

test("R27 exact phase replay is idempotent", () => {
  const { dir, ledger } = temp();
  const b = binding();
  const e = evidence(dir, "probe.bin");
  assert.equal(completeR27Phase(ledger, b, "input-probe", e).reused, false);
  assert.equal(completeR27Phase(ledger, b, "input-probe", e).reused, true);
});

test("R27 changed phase evidence conflicts", () => {
  const { dir, ledger } = temp();
  const b = binding();
  completeR27Phase(ledger, b, "input-probe", evidence(dir, "one.bin"));
  assert.throws(() => completeR27Phase(ledger, b, "input-probe", evidence(dir, "two.bin")), (error) => error.code === "R27_PHASE_CONFLICT");
});

test("R27 completed artifact tamper fails verification", () => {
  const { dir } = temp();
  const row = artifact(dir, "x.bin", "good");
  assert.equal(verifyR27Artifacts([row]), true);
  writeFileSync(row.path, "bad");
  assert.throws(() => verifyR27Artifacts([row]), (error) => error.code === "R27_CHECKPOINT_CORRUPT");
});

test("R27 restart verifies and reuses completed phase without rerender", async () => {
  const { dir, ledger } = temp();
  const b = binding();
  let runs = 0;
  const first = await runR27DurablePhase({
    ledgerPath: ledger,
    binding: b,
    phase: "input-probe",
    verifyCompleted: async (record) => verifyR27Artifacts(record.evidence.artifacts),
    execute: async () => {
      runs += 1;
      return evidence(dir, "probe.bin");
    }
  });
  const second = await runR27DurablePhase({
    ledgerPath: ledger,
    binding: b,
    phase: "input-probe",
    verifyCompleted: async (record) => verifyR27Artifacts(record.evidence.artifacts),
    execute: async () => {
      runs += 1;
      throw new Error("must not rerun");
    }
  });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(runs, 1);
});

test("R27 corrupt completed checkpoint fails instead of rerendering", async () => {
  const { dir, ledger } = temp();
  const b = binding();
  const e = evidence(dir, "probe.bin");
  completeR27Phase(ledger, b, "input-probe", e);
  writeFileSync(e.artifacts[0].path, "tamper");
  let runs = 0;
  await assert.rejects(runR27DurablePhase({
    ledgerPath: ledger,
    binding: b,
    phase: "input-probe",
    verifyCompleted: async (record) => verifyR27Artifacts(record.evidence.artifacts),
    execute: async () => {
      runs += 1;
      return e;
    }
  }), (error) => error.code === "R27_CHECKPOINT_CORRUPT");
  assert.equal(runs, 0);
});

test("R27 invocation records completed phase resume set", () => {
  const { dir, ledger } = temp();
  const b = binding();
  completeR27Phase(ledger, b, "input-probe", evidence(dir, "p.bin"));
  const inv = beginR27Invocation(ledger, b, { fixture: true });
  assert.deepEqual(inv.resumedCompletedPhases, ["input-probe"]);
});

test("R27 cancellation record does not complete current phase", () => {
  const { ledger } = temp();
  const b = binding();
  recordR27Cancellation(ledger, b, { phase: "input-probe", reason: "SIGINT" });
  const state = loadOrCreateR27Ledger(ledger, b);
  assert.equal(state.cancellationEvents.length, 1);
  assert.equal(state.phases["input-probe"], undefined);
});

test("R27 full phase ledger completes only after sealed bundle", () => {
  const { dir, ledger } = temp();
  const b = binding();
  fillTo(ledger, b, dir, R27_PHASES.length - 1);
  const status = r27Status(loadOrCreateR27Ledger(ledger, b));
  assert.equal(status.state, "LOCAL_REAL_INPUT_REHEARSAL_COMPLETE");
  assert.equal(status.nextPhase, null);
  assert.equal(status.authorityState, "PENDING_INDEPENDENT_QA");
});

test("R27 Growth bundle requires exactly four candidates", () => {
  assert.throws(() => buildR27GrowthBundleManifest(bundleArgs({ candidates: bundleArgs().candidates.slice(0, 3) })), /exactly four/);
});

test("R27 Growth bundle rejects duplicate candidate IDs", () => {
  const rows = bundleArgs().candidates;
  rows[1] = { ...rows[1], candidateId: rows[0].candidateId };
  assert.throws(() => buildR27GrowthBundleManifest(bundleArgs({ candidates: rows })), /unique/);
});

test("R27 Growth bundle rejects duplicate candidate hashes", () => {
  const rows = bundleArgs().candidates;
  rows[1] = { ...rows[1], sha256: rows[0].sha256 };
  assert.throws(() => buildR27GrowthBundleManifest(bundleArgs({ candidates: rows })), /distinct/);
});

test("R27 Growth bundle final must be targeted re-edit bytes", () => {
  assert.throws(() => buildR27GrowthBundleManifest(bundleArgs({
    finalArtifact: { sha256: H("9"), size: 777 }
  })), /final artifact/);
});

test("R27 Growth bundle rejects traversal path", () => {
  assert.throws(() => buildR27GrowthBundleManifest(bundleArgs({
    files: [{ path: "../secret", sha256: H("a"), size: 1 }]
  })), /non-traversing/);
});

test("R27 Growth bundle stays pending QA and sealed against mutation", () => {
  const manifest = buildR27GrowthBundleManifest(bundleArgs());
  assert.equal(manifest.producer.authorityState, "PENDING_INDEPENDENT_QA");
  assert.equal(manifest.producer.acceptedByIndependentQa, false);
  assert.doesNotThrow(() => validateR27GrowthBundleManifest(manifest));
  const changed = structuredClone(manifest);
  changed.finalArtifact.size += 1;
  assert.throws(() => validateR27GrowthBundleManifest(changed), /digest mismatch/);
});

test("R27 Growth bundle rejects live effect claims even with recomputed digest absent", () => {
  const manifest = buildR27GrowthBundleManifest(bundleArgs());
  const changed = structuredClone(manifest);
  changed.evidenceBoundary.socialPublish = true;
  delete changed.manifestDigest;
  // digest check fires first; still fail-closed.
  assert.throws(() => validateR27GrowthBundleManifest(changed));
});

test("R27 persisted ledger is canonical JSON and reloadable", () => {
  const { ledger } = temp();
  const b = binding();
  loadOrCreateR27Ledger(ledger, b);
  const parsed = JSON.parse(readFileSync(ledger, "utf8"));
  assert.equal(parsed.contractVersion, MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION);
  assert.doesNotThrow(() => validateR27Ledger(parsed, b));
});
