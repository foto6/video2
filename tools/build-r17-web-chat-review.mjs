import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION,
  WEB_CHAT_REVIEW_MAX_FILE_BYTES,
  R17_ACCEPTED_R16_UPSTREAM_AUTHORITY,
  buildWebChatReviewBundle,
  stableStringify
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const r16Root = path.resolve(args["r16-root"] ?? path.join(repoRoot, ".artifacts", "r16-accepted"));
const batchRoot = path.resolve(args["batch-root"] ?? path.join(r16Root, "batch"));
const sourcePath = path.resolve(args["source"] ?? path.join(r16Root, "source.mp4"));
const outputRoot = path.resolve(args["output-dir"] ?? path.join(repoRoot, ".artifacts", "r17-web-chat-review"));
const manifestPath = path.resolve(args["batch-manifest"] ?? path.join(batchRoot, "media.candidate_batch.v1.json"));
const transcodeOversize = args["transcode-oversize"] === true || args["transcode-oversize"] === "true";

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked-out HEAD ${producerSha}`);
}

const candidateBatchManifestBytes = readFileSync(manifestPath);
const candidateBatchManifest = JSON.parse(candidateBatchManifestBytes);
const candidateBatchManifestFileSha256 = createHash("sha256").update(candidateBatchManifestBytes).digest("hex");
mkdirSync(outputRoot, { recursive: true });

const bundle = buildWebChatReviewBundle({
  candidateBatchManifest,
  batchRoot,
  sourcePath,
  reviewBundleProducerSha: producerSha,
  upstreamMediaAuthority: R17_ACCEPTED_R16_UPSTREAM_AUTHORITY,
  candidateBatchManifestFileSha256,
  attachmentRoot: outputRoot,
  transcodeOversize
});

const outputPath = path.join(outputRoot, "media.web_chat_review_bundle.v1.json");
writeFileSync(outputPath, `${stableStringify(bundle)}\n`);

const summary = {
  evidenceVersion: "media.web_chat_review_bundle.r17.evidence.v1",
  contractVersion: MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION,
  reviewBundleProducerSha: producerSha,
  upstreamMediaAuthority: bundle.upstream_media_authority,
  source: bundle.source,
  maxBytesPerFile: WEB_CHAT_REVIEW_MAX_FILE_BYTES,
  candidateCount: bundle.candidates.length,
  eligibleOriginalCount: bundle.candidates.filter((entry) =>
    entry.attachmentEligibility.eligible && entry.reviewAttachment?.derivative === null
  ).length,
  derivativeCount: bundle.candidates.filter((entry) =>
    entry.reviewAttachment?.derivative?.derivative_for_model_review === true
  ).length,
  ineligibleCount: bundle.candidates.filter((entry) => entry.reviewAttachment === null).length,
  attachments: bundle.candidates
    .filter((entry) => entry.reviewAttachment)
    .map((entry) => ({
      candidateId: entry.candidateId,
      path: entry.reviewAttachment.file.path,
      sha256: entry.reviewAttachment.file.sha256,
      size: entry.reviewAttachment.file.size,
      derivative_for_model_review: entry.reviewAttachment.derivative?.derivative_for_model_review === true
    }))
};
writeFileSync(
  path.join(outputRoot, "media.web_chat_review_bundle.r17.evidence.json"),
  `${stableStringify(summary)}\n`
);

if (summary.eligibleOriginalCount + summary.derivativeCount < 1) {
  throw new Error("review bundle contains no eligible attachment");
}

console.log("R17_WEB_CHAT_REVIEW", stableStringify(summary));
