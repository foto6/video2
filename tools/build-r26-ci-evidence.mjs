import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION,
  R26_LOCAL_PHASES,
  bindR26RenderGraph,
  beginR26Invocation,
  loadOrCreateR26Ledger,
  r26Digest,
  r26Sha256File,
  r26Status,
  runR26DurablePhase,
  stableStringify
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, ".artifacts", "r26-ci");
const ledgerPath = path.join(root, "ledger.json");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const H = (c) => c.repeat(64);
const bootstrap = {
  operationId: "r26-ci-control-fixture",
  producerSha: process.env.GITHUB_SHA ?? "1".repeat(40),
  runtimeManifestSha256: H("a")
};
loadOrCreateR26Ledger(ledgerPath, bootstrap);
bindR26RenderGraph(ledgerPath, bootstrap, {
  source: { sha256: H("b"), size: 8 },
  requestSha256: H("c"),
  planDigest: H("d"),
  renderGraphDigest: H("e")
});
beginR26Invocation(ledgerPath, bootstrap, { fixture: true, preemptionPoint: "between_durable_phases" });

let executeCalls = 0;
for (let i = 0; i < R26_LOCAL_PHASES.length; i += 1) {
  const phase = R26_LOCAL_PHASES[i];
  await runR26DurablePhase({
    ledgerPath,
    bootstrap,
    phase,
    verifyCompleted: async (record) => {
      for (const artifact of record.evidence.artifacts) {
        const actual = r26Sha256File(artifact.path);
        if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size) return false;
      }
      return true;
    },
    execute: async () => {
      executeCalls += 1;
      const filePath = path.join(root, "tiny", `${String(i).padStart(2, "0")}-${phase}.bin`);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, Buffer.from(`r26-fixture:${phase}\n`, "utf8"));
      return {
        elapsedMs: i + 1,
        fixture: true,
        artifacts: [{ path: filePath, ...r26Sha256File(filePath) }]
      };
    }
  });
}

const callsBeforeReplay = executeCalls;
const first = loadOrCreateR26Ledger(ledgerPath, bootstrap);
beginR26Invocation(ledgerPath, bootstrap, { fixture: true, replay: true });
for (const phase of R26_LOCAL_PHASES) {
  await runR26DurablePhase({
    ledgerPath,
    bootstrap,
    phase,
    verifyCompleted: async (record) => {
      for (const artifact of record.evidence.artifacts) {
        const actual = r26Sha256File(artifact.path);
        if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size) return false;
      }
      return true;
    },
    execute: async () => {
      executeCalls += 1;
      throw new Error("completed fixture phase must not rerun");
    }
  });
}
if (executeCalls !== callsBeforeReplay) throw new Error("R26 fixture replay reran completed work");

const ledger = loadOrCreateR26Ledger(ledgerPath, bootstrap);
const report = {
  contractVersion: MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION,
  evidenceClass: "tiny_deterministic_control_fixture",
  hostedCiRealEncoding: false,
  longFfmpegEncodingRequired: false,
  producerSha: bootstrap.producerSha,
  bindingDigest: ledger.renderBinding.digest,
  phaseCount: R26_LOCAL_PHASES.length,
  firstPassExecuteCalls: callsBeforeReplay,
  replayExecuteCalls: executeCalls - callsBeforeReplay,
  status: r26Status(ledger),
  checkpointRestartVerified: true,
  hashVerificationVerified: true,
  changedGraphSameOperationIdCoveredByUnitTest: true,
  realLocalRenderRequiredForMp4Evidence: true,
  liveAuthorization: false
};
const reportPath = path.join(root, "media.local_windows_render_gate.r26.ci-evidence.json");
writeFileSync(reportPath, stableStringify(report) + "\n", "utf8");
const id = r26Sha256File(reportPath);
writeFileSync(path.join(root, "SHA256SUMS.txt"), `${id.sha256}  media.local_windows_render_gate.r26.ci-evidence.json\n`, "utf8");
console.log("R26_CI_EVIDENCE", stableStringify({ ...report, evidenceSha256: id.sha256, evidenceDigest: r26Digest(report) }));
