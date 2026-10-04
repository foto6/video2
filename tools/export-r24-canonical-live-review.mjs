import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  materializeCanonicalLiveReviewExport,
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
function confined(root, target, label) {
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes sandbox root`);
  }
  return resolved;
}
function gitBlob(relativePath) {
  return execFileSync("git", ["hash-object", relativePath], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  }).trim();
}

const args = parseArgs(process.argv.slice(2));
if (!args["session-dir"]) throw new Error("--session-dir is required");
if (!args["output-dir"]) throw new Error("--output-dir is required");
const sandboxRoot = path.resolve(args["sandbox-root"] ?? repoRoot);
const sessionDir = confined(sandboxRoot, path.resolve(args["session-dir"]), "session dir");
const outputDir = confined(sandboxRoot, path.resolve(args["output-dir"]), "output dir");

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}
const producerCiRunId = args["producer-ci-run-id"]
  ? Number(args["producer-ci-run-id"])
  : Number(process.env.GITHUB_RUN_ID ?? "");
if (!Number.isInteger(producerCiRunId) || producerCiRunId <= 0) {
  throw new Error("--producer-ci-run-id or GITHUB_RUN_ID positive integer is required");
}

const blobs = {
  implementation: gitBlob("src/canonical-live-review-r24.js"),
  exporter: gitBlob("tools/export-r24-canonical-live-review.mjs"),
  verifier: gitBlob("tools/verify-r24-canonical-live-review.mjs"),
  contract: gitBlob("conformance/media.canonical_live_review_export.r24.v1/contract.json"),
  schema: gitBlob("conformance/media.canonical_live_review_export.r24.v1/schema.json")
};

const result = materializeCanonicalLiveReviewExport({
  r23SessionDir: sessionDir,
  outputDir,
  producerSha,
  producerCiRunId,
  producerBlobs: blobs
});

console.log("R24_CANONICAL_EXPORT", stableStringify({
  producerSha,
  producerCiRunId,
  state: result.exportIndex.state,
  mode: result.mode,
  reviewRound: result.reviewRound,
  packageDigest: result.packageDigest,
  payloadDirectoryDigest: result.payloadDirectoryDigest,
  archiveSha256: result.archiveSha256,
  archiveSize: result.archiveSize,
  exportIndexSha256: result.exportIndexSha256,
  packageManifestSha256: result.packageManifestSha256,
  bridgeHandoffSha256: result.bridgeHandoffSha256,
  authorityProfileSha256: result.authorityProfileSha256,
  promptDigest: result.promptDigest,
  sealedMappingDigest: result.sealedMappingDigest,
  attachments: result.attachments,
  verified: result.verification.ok,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false
}));
