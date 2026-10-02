import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_REVIEW_ROUND_EVIDENCE_VERSION,
  ROUND_PAIR_PACKAGE_READY,
  buildReviewRoundBundle,
  fingerprint,
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
function writeStable(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const content = `${stableStringify(value)}\n`;
  if (existsSync(filePath)) {
    const prior = readFileSync(filePath, "utf8");
    if (prior !== content) throw new Error(`R21 replay conflict: ${path.basename(filePath)} changed`);
    return { replayed: true, ...hashFile(filePath) };
  }
  writeFileSync(filePath, content);
  return { replayed: false, ...hashFile(filePath) };
}

const args = parseArgs(process.argv.slice(2));
if (!args.request) throw new Error("--request is required");
const requestPath = path.resolve(args.request);
const request = JSON.parse(readFileSync(requestPath, "utf8"));
if (request.contractVersion !== "media.review_round_request.r21.v1") {
  throw new Error("request must use media.review_round_request.r21.v1");
}

const sandboxRoot = path.resolve(args["sandbox-root"] ?? repoRoot);
const outputRoot = path.resolve(args["output-dir"] ?? path.join(sandboxRoot, ".artifacts", "r21-round-review"));
const rel = path.relative(sandboxRoot, outputRoot);
if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("output root escapes sandbox");
mkdirSync(outputRoot, { recursive: true });

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}

const built = buildReviewRoundBundle({
  request: request.review,
  producerSha,
  sandboxRoot,
  outputRoot
});

const bundleWrite = writeStable(
  path.join(outputRoot, "media.review_round_bundle.r21.v1.json"),
  built.bundle
);
const sealedWrite = writeStable(
  path.join(outputRoot, "media.review_round_sealed_mapping.r21.v1.json"),
  built.bundle.sealedMapping
);
const handoffWrite = writeStable(
  path.join(outputRoot, "media.review_round_transport_handoff.r21.v1.json"),
  built.bundle.transportHandoff
);
const promptWrite = writeStable(
  path.join(outputRoot, "model-review-prompt.txt.json"),
  {
    text: built.bundle.prompt.text,
    digest: built.bundle.prompt.digest,
    bytes: Buffer.byteLength(built.bundle.prompt.text, "utf8")
  }
);

for (const attachment of built.bundle.attachments) {
  const filePath = path.join(outputRoot, attachment.path);
  const actual = hashFile(filePath);
  if (actual.sha256 !== attachment.sha256 || actual.size !== attachment.size) {
    throw new Error(`R21 attachment drift: ${attachment.path}`);
  }
}

const evidence = {
  evidenceVersion: MEDIA_REVIEW_ROUND_EVIDENCE_VERSION,
  producer: { repository: "foto6/video2", sha: producerSha },
  state: ROUND_PAIR_PACKAGE_READY,
  mode: built.bundle.mode,
  reviewRound: built.bundle.reviewRound,
  source: built.bundle.source,
  briefLineageDigest: built.bundle.briefLineageDigest,
  packageDigest: built.packageDigest,
  bundleFileSha256: bundleWrite.sha256,
  sealedMappingDigest: built.sealedMappingDigest,
  sealedMappingFileSha256: sealedWrite.sha256,
  roundLineageDigest: built.roundLineageDigest,
  promptDigest: built.bundle.prompt.digest,
  promptFileSha256: promptWrite.sha256,
  transportHandoffFileSha256: handoffWrite.sha256,
  r20PackageDigest: built.r20PackageDigest,
  attachments: built.bundle.attachments,
  roundLineage: built.bundle.roundLineage,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false,
  requestDigest: fingerprint(request.review)
};
const evidenceWrite = writeStable(
  path.join(outputRoot, "media.review_round_bundle.r21.evidence.json"),
  evidence
);

console.log("R21_REVIEW_ROUND", stableStringify({
  producerSha,
  state: evidence.state,
  mode: evidence.mode,
  reviewRound: evidence.reviewRound,
  packageDigest: evidence.packageDigest,
  sealedMappingDigest: evidence.sealedMappingDigest,
  roundLineageDigest: evidence.roundLineageDigest,
  promptDigest: evidence.promptDigest,
  evidenceFileSha256: evidenceWrite.sha256,
  attachments: evidence.attachments,
  roundLineage: evidence.roundLineage,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false
}));
