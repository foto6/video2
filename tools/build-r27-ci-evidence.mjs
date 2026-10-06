import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION,
  R27_AUTHORITY_STATE,
  R27_PHASES,
  beginR27Invocation,
  buildR27GrowthBundleManifest,
  completeR27Phase,
  createR27Ledger,
  createR27OperationBinding,
  loadOrCreateR27Ledger,
  r27Status,
  runR27DurablePhase,
  validateR27GrowthBundleManifest,
  verifyR27Artifacts
} from "../src/real-input-local-rehearsal-r27.js";
import { r26Sha256File } from "../src/local-windows-render-gate-r26.js";
import { stableStringify } from "../src/stable.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, ".artifacts", "r27-ci");
const ledgerPath = path.join(root, "ledger.json");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const H = (c) => c.repeat(64);
const binding = createR27OperationBinding({
  operationId: "r27-ci-control-fixture",
  producerSha: process.env.GITHUB_SHA ?? "1".repeat(40),
  input: { pathIdentity: "fixture-input", sha256: H("a"), size: 1234 },
  probe: { hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30, durationMs: 12000 },
  normalization: {
    runtime: { runtimeManifestSha256: H("b") },
    specDigest: H("c")
  }
});
loadOrCreateR27Ledger(ledgerPath, binding);
beginR27Invocation(ledgerPath, binding, { fixture: true, preemptionPoint: "between_durable_phases" });

let executeCalls = 0;
for (let i = 0; i < R27_PHASES.length; i += 1) {
  const phase = R27_PHASES[i];
  await runR27DurablePhase({
    ledgerPath,
    binding,
    phase,
    verifyCompleted: async (record) => verifyR27Artifacts(record.evidence.artifacts),
    execute: async () => {
      executeCalls += 1;
      const filePath = path.join(root, "tiny", `${String(i).padStart(2, "0")}-${phase}.bin`);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, Buffer.from(`r27-fixture:${phase}\n`, "utf8"));
      return {
        elapsedMs: i + 1,
        fixture: true,
        artifacts: [{ path: filePath, ...r26Sha256File(filePath) }]
      };
    }
  });
}
const firstPassExecuteCalls = executeCalls;
beginR27Invocation(ledgerPath, binding, { fixture: true, replay: true });
for (const phase of R27_PHASES) {
  await runR27DurablePhase({
    ledgerPath,
    binding,
    phase,
    verifyCompleted: async (record) => verifyR27Artifacts(record.evidence.artifacts),
    execute: async () => {
      executeCalls += 1;
      throw new Error("completed R27 phase must not rerun");
    }
  });
}
if (executeCalls !== firstPassExecuteCalls) throw new Error("R27 exact replay reran completed work");

const bundle = buildR27GrowthBundleManifest({
  producerSha: binding.value.producerSha,
  operationBindingDigest: binding.digest,
  input: { pathIdentity: "fixture-input", sha256: H("a"), size: 1234 },
  normalizedSource: { sha256: H("d"), size: 1100, normalizationSpecDigest: H("c") },
  candidates: ["1","2","3","4"].map((x) => ({ candidateId: `candidate-${x}`, sha256: H(x), size: 100 + Number(x) })),
  targetedReedit: { candidateId: "candidate-1-reedit-r1", sha256: H("e"), size: 500, decisionClass: "DETERMINISTIC_OFFLINE_FIXTURE" },
  finalArtifact: { sha256: H("e"), size: 500 },
  files: [{ path: "final/final.mp4", sha256: H("e"), size: 500 }]
});
validateR27GrowthBundleManifest(bundle);

const ledger = loadOrCreateR27Ledger(ledgerPath, binding);
const report = {
  contractVersion: MEDIA_REAL_INPUT_LOCAL_REHEARSAL_VERSION,
  evidenceClass: "tiny_deterministic_control_fixture",
  producerSha: binding.value.producerSha,
  authorityState: R27_AUTHORITY_STATE,
  hostedCiRealEncoding: false,
  ffmpegRequiredInHostedCi: false,
  realInputLocalRunRequiredForMp4Evidence: true,
  phaseCount: R27_PHASES.length,
  firstPassExecuteCalls,
  replayExecuteCalls: executeCalls - firstPassExecuteCalls,
  checkpointRestartVerified: true,
  hashVerificationVerified: true,
  operationConflictCoveredByUnitTests: true,
  fourCandidateSealVerified: true,
  growthBundleManifestDigest: bundle.manifestDigest,
  status: r27Status(ledger),
  liveAuthorization: false,
  providerMutation: false,
  browserMutation: false,
  socialPublish: false
};
const reportPath = path.join(root, "media.real_input_local_rehearsal.r27.ci-evidence.json");
writeFileSync(reportPath, stableStringify(report) + "\n", "utf8");
const id = r26Sha256File(reportPath);
writeFileSync(path.join(root, "SHA256SUMS.txt"), `${id.sha256}  media.real_input_local_rehearsal.r27.ci-evidence.json\n`, "utf8");
console.log("R27_CI_EVIDENCE", stableStringify({ ...report, evidenceSha256: id.sha256 }));
