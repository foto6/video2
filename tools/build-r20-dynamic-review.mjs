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
  MEDIA_DYNAMIC_REVIEW_EVIDENCE_VERSION,
  buildDynamicReviewPackage,
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
    const existing = readFileSync(filePath, "utf8");
    if (existing !== content) {
      throw new Error(`R20 replay conflict: ${path.basename(filePath)} differs`);
    }
    return {
      path: filePath,
      replayed: true,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content)
    };
  }
  writeFileSync(filePath, content);
  return {
    path: filePath,
    replayed: false,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content)
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.request) throw new Error("--request is required");
const requestPath = path.resolve(args.request);
const request = JSON.parse(readFileSync(requestPath, "utf8"));
if (request.contractVersion !== "media.dynamic_review_request.r20.v1") {
  throw new Error("request must use media.dynamic_review_request.r20.v1");
}
const sandboxRoot = path.resolve(args["sandbox-root"] ?? repoRoot);
const outputRoot = path.resolve(args["output-dir"] ?? path.join(sandboxRoot, ".artifacts", "r20-dynamic-review"));
const relativeOutput = path.relative(sandboxRoot, outputRoot);
if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
  throw new Error("output root escapes sandbox");
}
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

const built = buildDynamicReviewPackage({
  candidates: request.candidates,
  packageProducerSha: producerSha,
  sandboxRoot,
  outputRoot,
  bridgeTarget: request.bridgeTarget,
  duplicatePolicy: request.duplicatePolicy ?? "reject"
});

const packageWrite = writeStable(
  path.join(outputRoot, "media.dynamic_review_package.r20.v1.json"),
  built.package
);
const promptWrite = writeStable(
  path.join(outputRoot, "media.direct_model_review_prompt.v1.json"),
  built.package.promptManifest
);
const sealedWrite = writeStable(
  path.join(outputRoot, "media.dynamic_review_sealed_mapping.r20.v1.json"),
  built.package.sealedMapping
);
const handoffWrite = writeStable(
  path.join(outputRoot, "media.bridge_live_review_handoff.r20.v1.json"),
  built.package.bridgeHandoff
);
const bridgeRequestWrite = writeStable(
  path.join(outputRoot, "bridge.existing_chat_video_review_request.v1.json"),
  built.bridgeRequest
);

const attachmentEvidence = built.package.attachments.map((attachment) => {
  const filePath = path.join(outputRoot, attachment.file.path);
  const actual = hashFile(filePath);
  if (actual.sha256 !== attachment.file.sha256 || actual.size !== attachment.file.size) {
    throw new Error(`R20 packaged attachment drift: ${attachment.genericFileName}`);
  }
  return {
    blindLabel: attachment.blindLabel,
    genericFileName: attachment.genericFileName,
    mimeType: attachment.mimeType,
    sha256: actual.sha256,
    size: actual.size,
    derivative_for_model_review: attachment.derivative?.derivative_for_model_review === true,
    derivative: attachment.derivative
  };
});

const evidence = {
  evidenceVersion: MEDIA_DYNAMIC_REVIEW_EVIDENCE_VERSION,
  producer: { repository: "foto6/video2", sha: producerSha },
  state: built.package.state,
  nextState: built.package.modelReview.nextState,
  reviewContext: built.package.reviewContext,
  source: built.package.source,
  packageDigest: built.packageDigest,
  packageFileSha256: packageWrite.sha256,
  promptDigest: built.promptDigest,
  promptFileSha256: promptWrite.sha256,
  sealedMappingDigest: built.sealedMappingDigest,
  sealedMappingFileSha256: sealedWrite.sha256,
  bridgeHandoffFileSha256: handoffWrite.sha256,
  bridgeRequestFileSha256: bridgeRequestWrite.sha256,
  attachments: attachmentEvidence,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  liveUploadPerformed: false,
  providerPublishPerformed: false,
  humanQuality: false,
  requestDigest: fingerprint(request)
};
const evidenceWrite = writeStable(
  path.join(outputRoot, "media.dynamic_review_package.r20.evidence.json"),
  evidence
);

console.log("R20_DYNAMIC_REVIEW", stableStringify({
  producerSha,
  state: evidence.state,
  nextState: evidence.nextState,
  reviewContext: evidence.reviewContext,
  packageDigest: evidence.packageDigest,
  packageFileSha256: evidence.packageFileSha256,
  promptDigest: evidence.promptDigest,
  sealedMappingDigest: evidence.sealedMappingDigest,
  evidenceFileSha256: evidenceWrite.sha256,
  attachments: evidence.attachments,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  humanQuality: false
}));
