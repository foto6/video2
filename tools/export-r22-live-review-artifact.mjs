import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_LIVE_REVIEW_ARCHIVE_INDEX_VERSION,
  R22_BRIDGE_R31_AUTHORITY,
  buildDeterministicTar,
  buildLiveReviewArtifact,
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
function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args["source-bundle-root"]) throw new Error("--source-bundle-root is required");
if (!args["source-request"]) throw new Error("--source-request is required");
if (!args["output-dir"]) throw new Error("--output-dir is required");
if (!args.archive) throw new Error("--archive is required");
if (!args["archive-index"]) throw new Error("--archive-index is required");

const sandboxRoot = path.resolve(args["sandbox-root"] ?? repoRoot);
const sourceBundleRoot = path.resolve(args["source-bundle-root"]);
const sourceRequestPath = path.resolve(args["source-request"]);
const outputRoot = path.resolve(args["output-dir"]);
const archivePath = path.resolve(args.archive);
const archiveIndexPath = path.resolve(args["archive-index"]);
for (const [label, target] of [
  ["source-bundle-root", sourceBundleRoot],
  ["source-request", sourceRequestPath],
  ["output-dir", outputRoot],
  ["archive", archivePath],
  ["archive-index", archiveIndexPath]
]) {
  const rel = path.relative(sandboxRoot, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes sandbox root`);
  }
}

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}
const ciRunId = Number(args["ci-run-id"] ?? process.env.GITHUB_RUN_ID);
if (!Number.isSafeInteger(ciRunId) || ciRunId <= 0) {
  throw new Error("--ci-run-id or GITHUB_RUN_ID must provide a positive exact CI run id");
}

mkdirSync(path.dirname(archivePath), { recursive: true });
mkdirSync(path.dirname(archiveIndexPath), { recursive: true });

const built = buildLiveReviewArtifact({
  sourceBundleRoot,
  sourceRequestPath,
  sandboxRoot,
  outputRoot,
  producerSha,
  ciRunId,
  repoRoot
});
const archive = buildDeterministicTar(outputRoot, archivePath);
const archiveActual = hashFile(archivePath);
if (archive.sha256 !== archiveActual.sha256 || archive.size !== archiveActual.size) {
  throw new Error("deterministic archive identity changed after write");
}

const index = {
  contractVersion: MEDIA_LIVE_REVIEW_ARCHIVE_INDEX_VERSION,
  state: "LIVE_REVIEW_ARTIFACT_READY",
  producer: {
    repository: "foto6/video2",
    sha: producerSha,
    ciRunId
  },
  bridgeR31Authority: R22_BRIDGE_R31_AUTHORITY,
  bundle: {
    directoryName: path.basename(outputRoot),
    packageManifestPath: "media.live_review_package_manifest.r22.v1.json",
    packageManifestSha256: built.packageManifestSha256,
    packageManifestSize: built.packageManifestSize,
    payloadDigest: built.payloadDigest,
    bridgePackageDigest: built.bridgePackageDigest,
    r21PackageDigest: built.r21PackageDigest,
    sealedMappingDigest: built.sealedMappingDigest,
    promptDigest: built.promptDigest,
    mode: built.mode,
    reviewRound: built.reviewRound
  },
  archive: {
    fileName: path.basename(archivePath),
    format: "ustar",
    sha256: archive.sha256,
    size: archive.size,
    fileCount: archive.fileCount
  },
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false
};
writeFileSync(archiveIndexPath, `${stableStringify(index)}\n`);

console.log("R22_LIVE_REVIEW_ARTIFACT", stableStringify({
  producerSha,
  ciRunId,
  state: index.state,
  mode: built.mode,
  reviewRound: built.reviewRound,
  packageManifestSha256: built.packageManifestSha256,
  payloadDigest: built.payloadDigest,
  bridgePackageDigest: built.bridgePackageDigest,
  sealedMappingDigest: built.sealedMappingDigest,
  promptDigest: built.promptDigest,
  archiveSha256: archive.sha256,
  archiveSize: archive.size,
  archiveFileCount: archive.fileCount,
  attachments: built.attachments,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  humanQuality: false
}));
