import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableStringify } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r21Root = path.join(repoRoot, ".artifacts", "r21-demo");
const root = path.join(repoRoot, ".artifacts", "r22-demo");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

function run(binary, args) {
  return execFileSync(binary, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
}
function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}
function writeJson(filePath, value) {
  writeFileSync(filePath, `${stableStringify(value)}\n`);
}

if (!existsSync(path.join(r21Root, "r21-readiness-evidence.json"))) {
  run(process.execPath, [path.join(repoRoot, "tools", "demo-r21-review-round.mjs")]);
}

const producerSha = run("git", ["rev-parse", "HEAD"]).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}
const ciRunId = Number(process.env.GITHUB_RUN_ID);
if (!Number.isSafeInteger(ciRunId) || ciRunId <= 0) {
  throw new Error("R22 demo requires exact GITHUB_RUN_ID");
}

function exportOne(name, sourceName) {
  const sourceRoot = path.join(r21Root, sourceName);
  const sourceRequestPath = path.join(r21Root, `${sourceName}-request.json`);
  const outputRoot = path.join(root, name);
  const archivePath = path.join(root, `${name}.tar`);
  const archiveIndexPath = path.join(root, `${name}.archive-index.json`);
  const args = [
    path.join(repoRoot, "tools", "export-r22-live-review-artifact.mjs"),
    "--source-bundle-root", sourceRoot,
    "--source-request", sourceRequestPath,
    "--sandbox-root", repoRoot,
    "--output-dir", outputRoot,
    "--archive", archivePath,
    "--archive-index", archiveIndexPath,
    "--ci-run-id", String(ciRunId)
  ];
  const first = run(process.execPath, args);
  const verified = run(process.execPath, [
    path.join(repoRoot, "tools", "verify-r22-live-review-artifact.mjs"),
    "--bundle-dir", outputRoot,
    "--archive", archivePath,
    "--archive-index", archiveIndexPath
  ]);

  const replayRoot = path.join(root, `.${name}-replay`);
  const replayArchive = path.join(root, `.${name}-replay.tar`);
  const replayIndex = path.join(root, `.${name}-replay.archive-index.json`);
  const replayArgs = [
    path.join(repoRoot, "tools", "export-r22-live-review-artifact.mjs"),
    "--source-bundle-root", sourceRoot,
    "--source-request", sourceRequestPath,
    "--sandbox-root", repoRoot,
    "--output-dir", replayRoot,
    "--archive", replayArchive,
    "--archive-index", replayIndex,
    "--ci-run-id", String(ciRunId)
  ];
  const second = run(process.execPath, replayArgs);

  const archive = hashFile(archivePath);
  const replayArchiveIdentity = hashFile(replayArchive);
  if (
    archive.sha256 !== replayArchiveIdentity.sha256 ||
    archive.size !== replayArchiveIdentity.size
  ) {
    throw new Error(`${name} deterministic archive changed on replay`);
  }

  const bundleFiles = [
    "review-A.mp4",
    "review-B.mp4",
    "model-review-prompt.txt",
    "media.review_round_bundle.r21.v1.json",
    "media.review_round_transport_handoff.r21.v1.json",
    "media.review_round_sealed_mapping.r21.v1.json",
    "media.live_review_authority_profile.r22.v1.json",
    "media.dynamic_review_handoff.v1.json",
    "media.live_review_package_manifest.r22.v1.json"
  ];
  for (const fileName of bundleFiles) {
    const left = hashFile(path.join(outputRoot, fileName));
    const right = hashFile(path.join(replayRoot, fileName));
    if (left.sha256 !== right.sha256 || left.size !== right.size) {
      throw new Error(`${name} file changed on replay: ${fileName}`);
    }
  }

  const archiveIndex = JSON.parse(readFileSync(archiveIndexPath, "utf8"));
  const bundle = JSON.parse(readFileSync(
    path.join(outputRoot, "media.review_round_bundle.r21.v1.json"),
    "utf8"
  ));
  const manifest = JSON.parse(readFileSync(
    path.join(outputRoot, "media.live_review_package_manifest.r22.v1.json"),
    "utf8"
  ));
  const operatorHandoff = JSON.parse(readFileSync(
    path.join(outputRoot, "media.dynamic_review_handoff.v1.json"),
    "utf8"
  ));
  const authority = JSON.parse(readFileSync(
    path.join(outputRoot, "media.live_review_authority_profile.r22.v1.json"),
    "utf8"
  ));

  for (const attachment of bundle.attachments) {
    const actual = hashFile(path.join(outputRoot, attachment.path));
    if (actual.sha256 !== attachment.sha256 || actual.size !== attachment.size) {
      throw new Error(`${name} real blinded MP4 drift: ${attachment.path}`);
    }
  }
  if (
    bundle.modelReviewPerformed !== false ||
    bundle.liveModelReviewed !== false ||
    bundle.providerPublish !== false ||
    bundle.humanQuality !== false
  ) {
    throw new Error(`${name} R21 boundary drift`);
  }
  if (
    authority.boundary.modelCallPerformed !== false ||
    authority.boundary.liveModelReviewed !== false ||
    authority.boundary.humanQuality !== false
  ) {
    throw new Error(`${name} R22 authority boundary drift`);
  }

  rmSync(replayRoot, { recursive: true, force: true });
  rmSync(replayArchive, { force: true });
  rmSync(replayIndex, { force: true });

  return {
    name,
    mode: bundle.mode,
    reviewRound: bundle.reviewRound,
    archive: {
      sha256: archive.sha256,
      size: archive.size,
      fileCount: archiveIndex.archive.fileCount
    },
    packageManifest: {
      sha256: hashFile(path.join(outputRoot, "media.live_review_package_manifest.r22.v1.json")).sha256,
      payloadDigest: manifest.payloadDigest
    },
    authorityProfileSha256: hashFile(
      path.join(outputRoot, "media.live_review_authority_profile.r22.v1.json")
    ).sha256,
    operatorHandoff: {
      sha256: hashFile(path.join(outputRoot, "media.dynamic_review_handoff.v1.json")).sha256,
      packageDigest: operatorHandoff.package.digest,
      contract: operatorHandoff.contract
    },
    r21PackageDigest: bundle.transportHandoff.packageDigest,
    sealedMappingDigest: bundle.sealedMapping.digest,
    promptDigest: bundle.prompt.digest,
    attachments: bundle.attachments.map((entry) => ({
      blindLabel: entry.blindLabel,
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size,
      mimeType: entry.mimeType,
      derivative_for_model_review: entry.derivative_for_model_review
    })),
    replayArchiveByteStable: true,
    firstExportLogSha256: createHash("sha256").update(first).digest("hex"),
    replayExportLogSha256: createHash("sha256").update(second).digest("hex"),
    verificationLogSha256: createHash("sha256").update(verified).digest("hex")
  };
}

const initial = exportOne("initial-live-review", "initial");
const round1 = exportOne("round-1-live-review", "round-1");

function expectStaleEvidenceRejection({ sourceName, evidencePath, label }) {
  const absoluteEvidencePath = path.join(repoRoot, evidencePath);
  const original = readFileSync(absoluteEvidencePath);
  const negativeRoot = path.join(root, `.${label}-negative`);
  const negativeArchive = path.join(root, `.${label}-negative.tar`);
  const negativeIndex = path.join(root, `.${label}-negative.archive-index.json`);
  try {
    writeFileSync(absoluteEvidencePath, Buffer.concat([original, Buffer.from("\nR22_STALE_EVIDENCE")]));
    let rejected = false;
    try {
      run(process.execPath, [
        path.join(repoRoot, "tools", "export-r22-live-review-artifact.mjs"),
        "--source-bundle-root", path.join(r21Root, sourceName),
        "--source-request", path.join(r21Root, `${sourceName}-request.json`),
        "--sandbox-root", repoRoot,
        "--output-dir", negativeRoot,
        "--archive", negativeArchive,
        "--archive-index", negativeIndex,
        "--ci-run-id", String(ciRunId)
      ]);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`R22 failed to reject stale ${label} evidence`);
  } finally {
    writeFileSync(absoluteEvidencePath, original);
    rmSync(negativeRoot, { recursive: true, force: true });
    rmSync(negativeArchive, { force: true });
    rmSync(negativeIndex, { force: true });
  }
  if (hashFile(absoluteEvidencePath).sha256 !== createHash("sha256").update(original).digest("hex")) {
    throw new Error(`R22 failed to restore exact ${label} evidence bytes`);
  }
}

const initialRequest = JSON.parse(readFileSync(
  path.join(r21Root, "initial-request.json"),
  "utf8"
));
const initialR15 = initialRequest.review?.left?.candidate?.renderExport?.path;
if (!initialR15) throw new Error("R22 initial request lacks R15 evidence path");
expectStaleEvidenceRejection({
  sourceName: "initial",
  evidencePath: initialR15,
  label: "r15"
});

const round1Request = JSON.parse(readFileSync(
  path.join(r21Root, "round-1-request.json"),
  "utf8"
));
const round1R19 = round1Request.review?.challenger?.candidate?.editorialApplication?.path;
if (!round1R19) throw new Error("R22 round-1 request lacks R19 evidence path");
expectStaleEvidenceRejection({
  sourceName: "round-1",
  evidencePath: round1R19,
  label: "r19"
});
if (initial.mode !== "initial" || initial.reviewRound !== 0) {
  throw new Error("R22 initial artifact semantics mismatch");
}
if (round1.mode !== "targeted_reedit" || round1.reviewRound !== 1) {
  throw new Error("R22 round-1 artifact semantics mismatch");
}

const r21Evidence = JSON.parse(readFileSync(
  path.join(r21Root, "r21-readiness-evidence.json"),
  "utf8"
));
const summary = {
  evidenceVersion: "media.live_review_artifact.r22.demo.v1",
  producer: {
    repository: "foto6/video2",
    sha: producerSha,
    ciRunId
  },
  state: "LIVE_REVIEW_ARTIFACT_READY",
  source: r21Evidence.source,
  initial,
  targetedRound1: round1,
  archiveReproducible: initial.replayArchiveByteStable && round1.replayArchiveByteStable,
  staleR15Rejected: true,
  staleR19Rejected: true,
  extractionVerificationRequired: true,
  bridgeR31RunPrepared: true,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  browserUploadPerformed: false,
  providerPublish: false,
  humanQuality: false
};
writeJson(path.join(root, "r22-readiness-evidence.json"), summary);
console.log("R22_DEMO", stableStringify(summary));
