import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_DIRECT_MODEL_REVIEW_PACKAGE_VERSION,
  MEDIA_DIRECT_MODEL_REVIEW_PROMPT_VERSION,
  R18_ACCEPTED_R17_AUTHORITY,
  R18_CONSUMER_BINDINGS,
  buildDirectModelReviewPackage,
  directModelReviewPackageDigest,
  stableStringify
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
function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return { sha256: sha256Bytes(bytes), size: bytes.length };
}

const args = parseArgs(process.argv.slice(2));
const r17Root = path.resolve(args["r17-root"] ?? path.join(repoRoot, ".artifacts", "r17-accepted"));
const outputRoot = path.resolve(args["output-dir"] ?? path.join(repoRoot, ".artifacts", "r18-direct-model-review"));
const bundlePath = path.join(r17Root, R18_ACCEPTED_R17_AUTHORITY.bundleFile.name);

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked-out HEAD ${producerSha}`);
}

const bundleBytes = readFileSync(bundlePath);
const bundleFileSha256 = sha256Bytes(bundleBytes);
const r17Bundle = JSON.parse(bundleBytes);
mkdirSync(outputRoot, { recursive: true });

const pkg = buildDirectModelReviewPackage({
  r17Bundle,
  r17Root,
  outputRoot,
  packageProducerSha: producerSha,
  r17BundleFileSha256: bundleFileSha256
});
const packagePath = path.join(outputRoot, "media.direct_model_review_package.v1.json");
const promptPath = path.join(outputRoot, "model-review-prompt.json");
writeFileSync(packagePath, `${stableStringify(pkg)}\n`);
writeFileSync(promptPath, `${stableStringify(pkg.promptManifest)}\n`);

const packageDigest = directModelReviewPackageDigest(pkg);
const promptDigest = sha256Bytes(readFileSync(promptPath));

const handoff = {
  handoffVersion: "media.direct_model_review_handoff.r18.v1",
  package: {
    contractVersion: MEDIA_DIRECT_MODEL_REVIEW_PACKAGE_VERSION,
    path: path.basename(packagePath),
    digest: packageDigest,
    fileSha256: hashFile(packagePath).sha256
  },
  prompt: {
    contractVersion: MEDIA_DIRECT_MODEL_REVIEW_PROMPT_VERSION,
    path: path.basename(promptPath),
    sha256: promptDigest,
    promptTextSha256: sha256Bytes(Buffer.from(pkg.promptManifest.promptText, "utf8"))
  },
  bridge: {
    contractVersion: R18_CONSUMER_BINDINGS.bridge.contractVersion,
    exactSha: R18_CONSUMER_BINDINGS.bridge.exactSha,
    r25Branch: R18_CONSUMER_BINDINGS.bridge.r25Branch,
    r26Branch: R18_CONSUMER_BINDINGS.bridge.r26Branch,
    maxFileBytes: R18_CONSUMER_BINDINGS.bridge.maxFileBytes,
    liveUploadPerformed: false,
    attachments: pkg.attachments.map((entry) => ({
      blindLabel: entry.blindLabel,
      path: entry.file.path,
      expectedSha256: entry.file.sha256,
      expectedSize: entry.file.size,
      mimeType: entry.file.mimeType
    }))
  },
  growth: {
    repository: R18_CONSUMER_BINDINGS.growth.repository,
    exactSha: R18_CONSUMER_BINDINGS.growth.exactSha,
    r22Branch: R18_CONSUMER_BINDINGS.growth.r22Branch,
    r23Branch: R18_CONSUMER_BINDINGS.growth.r23Branch,
    criticContract: R18_CONSUMER_BINDINGS.growth.criticContract,
    pairwiseContract: R18_CONSUMER_BINDINGS.growth.pairwiseContract,
    integrationState: R18_CONSUMER_BINDINGS.growth.integrationState,
    source: {
      source_id: pkg.source.sourceId,
      sha256: pkg.source.sha256,
      size: pkg.source.size
    },
    media: {
      repository: "foto6/video2",
      producer_sha: pkg.attachments[0].candidateBinding.renderProducerSha
    },
    candidateBindings: pkg.attachments.map((entry) => ({
      blindLabel: entry.blindLabel,
      candidate_id: entry.candidateBinding.candidateId,
      render_sha256: entry.candidateBinding.renderSha256,
      render_size: entry.candidateBinding.renderSize,
      render_export_sha256: entry.candidateBinding.renderExportFileSha256,
      attachment_sha256: entry.file.sha256,
      attachment_size: entry.file.size
    })),
    evidenceBoundary: {
      human_ground_truth: false,
      human_label: false,
      live_platform_evidence: false,
      human_parity_gate_eligible: false
    }
  }
};
writeFileSync(path.join(outputRoot, "bridge-growth-handoff.json"), `${stableStringify(handoff)}\n`);

const evidence = {
  evidenceVersion: "media.direct_model_review_package.r18.evidence.v1",
  producerSha,
  upstreamR17: R18_ACCEPTED_R17_AUTHORITY,
  source: pkg.source,
  packageDigest,
  packageFileSha256: hashFile(packagePath).sha256,
  promptFileSha256: promptDigest,
  selectedCandidateCount: pkg.attachments.length,
  modelReviewPerformed: false,
  liveUploadPerformed: false,
  attachments: pkg.attachments.map((entry) => ({
    blindLabel: entry.blindLabel,
    genericFileName: entry.genericFileName,
    candidateId: entry.candidateBinding.candidateId,
    sourceSha256: entry.candidateBinding.sourceSha256,
    renderSha256: entry.candidateBinding.renderSha256,
    renderSize: entry.candidateBinding.renderSize,
    renderExportDigest: entry.candidateBinding.renderExportDigest,
    renderExportFileSha256: entry.candidateBinding.renderExportFileSha256,
    renderProducerSha: entry.candidateBinding.renderProducerSha,
    technicalQaEvidenceSha256: entry.candidateBinding.technicalQa.evidenceSha256,
    packagedSha256: entry.file.sha256,
    packagedSize: entry.file.size,
    derivative_for_model_review: entry.derivative?.derivative_for_model_review === true,
    eligible: entry.attachmentEligibility.eligible
  }))
};
writeFileSync(
  path.join(outputRoot, "media.direct_model_review_package.r18.evidence.json"),
  `${stableStringify(evidence)}\n`
);

console.log("R18_DIRECT_MODEL_REVIEW", stableStringify({
  producerSha,
  packageDigest,
  promptFileSha256: promptDigest,
  attachments: evidence.attachments
}));
