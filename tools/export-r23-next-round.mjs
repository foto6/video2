import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_REVIEW_ROUND_EVIDENCE_VERSION,
  MEDIA_REVIEW_SESSION_REQUEST_VERSION,
  REVIEW_SESSION_PACKAGE_READY,
  R23_R21_AUTHORITY,
  R23_R22_AUTHORITY,
  buildFrozenR21RoundForSession,
  buildReviewSessionPackage,
  fingerprint,
  materializeFrozenR22ForSession,
  reviewSessionIdentity,
  stableStringify,
  validateReviewSessionRequest,
  verifyMaterializedLiveReviewArtifact
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
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return { sha256: hashBytes(bytes), size: bytes.length };
}
function writeStable(filePath, value) {
  const bytes = Buffer.from(`${stableStringify(value)}\n`, "utf8");
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    const prior = readFileSync(filePath);
    if (!prior.equals(bytes)) {
      throw new Error(`R23 replay conflict: existing ${path.basename(filePath)} differs`);
    }
    return { replayed: true, sha256: hashBytes(bytes), size: bytes.length };
  }
  writeFileSync(filePath, bytes);
  return { replayed: false, sha256: hashBytes(bytes), size: bytes.length };
}
function safeWithin(root, target, label) {
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes sandbox root`);
  }
  return resolved;
}
function allFiles(root) {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(path.relative(root, p).split(path.sep).join("/"));
      else throw new Error("non-regular session artifact entry");
    }
  }
  walk(root);
  return out;
}
function directoryDigest(root) {
  const records = allFiles(root).map((relativePath) => {
    const id = hashFile(path.join(root, relativePath));
    return { path: relativePath, sha256: id.sha256, size: id.size };
  });
  return { digest: fingerprint(records), records };
}
function r21WriteSet(roundDir, built, request) {
  const bundle = built.bundle;
  const bundleWrite = writeStable(path.join(roundDir, "media.review_round_bundle.r21.v1.json"), bundle);
  const sealedWrite = writeStable(path.join(roundDir, "media.review_round_sealed_mapping.r21.v1.json"), bundle.sealedMapping);
  const handoffWrite = writeStable(path.join(roundDir, "media.review_round_transport_handoff.r21.v1.json"), bundle.transportHandoff);
  const promptWrite = writeStable(path.join(roundDir, "model-review-prompt.txt.json"), {
    text: bundle.prompt.text,
    digest: bundle.prompt.digest,
    bytes: Buffer.byteLength(bundle.prompt.text, "utf8")
  });
  const evidence = {
    evidenceVersion: MEDIA_REVIEW_ROUND_EVIDENCE_VERSION,
    producer: { repository: "foto6/video2", sha: R23_R21_AUTHORITY.producerSha },
    state: "ROUND_PAIR_PACKAGE_READY",
    mode: bundle.mode,
    reviewRound: bundle.reviewRound,
    source: bundle.source,
    briefLineageDigest: bundle.briefLineageDigest,
    packageDigest: built.packageDigest,
    bundleFileSha256: bundleWrite.sha256,
    sealedMappingDigest: built.sealedMappingDigest,
    sealedMappingFileSha256: sealedWrite.sha256,
    roundLineageDigest: built.roundLineageDigest,
    promptDigest: bundle.prompt.digest,
    promptFileSha256: promptWrite.sha256,
    transportHandoffFileSha256: handoffWrite.sha256,
    r20PackageDigest: built.r20PackageDigest,
    attachments: bundle.attachments,
    roundLineage: bundle.roundLineage,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false,
    requestDigest: fingerprint(request)
  };
  const evidenceWrite = writeStable(path.join(roundDir, "media.review_round_bundle.r21.evidence.json"), evidence);
  return { bundleWrite, sealedWrite, handoffWrite, promptWrite, evidenceWrite, evidence };
}

const args = parseArgs(process.argv.slice(2));
if (!args.request) throw new Error("--request is required");
const requestPath = path.resolve(args.request);
const requestRaw = JSON.parse(readFileSync(requestPath, "utf8"));
if (requestRaw.contractVersion !== MEDIA_REVIEW_SESSION_REQUEST_VERSION) {
  throw new Error(`request must use ${MEDIA_REVIEW_SESSION_REQUEST_VERSION}`);
}
const request = validateReviewSessionRequest(requestRaw);

const sandboxRoot = path.resolve(args["sandbox-root"] ?? repoRoot);
const outputRoot = safeWithin(
  sandboxRoot,
  path.resolve(args["output-dir"] ?? path.join(sandboxRoot, ".artifacts", "r23-session", request.sessionId, `round-${request.reviewRound}`)),
  "output root"
);
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
const producerCiRunId = args["producer-ci-run-id"]
  ? Number(args["producer-ci-run-id"])
  : Number(process.env.GITHUB_RUN_ID ?? "");
if (!Number.isInteger(producerCiRunId) || producerCiRunId <= 0) {
  throw new Error("--producer-ci-run-id or GITHUB_RUN_ID positive integer is required");
}

const requestLockPath = path.join(outputRoot, "media.review_session_request.r23.v1.json");
const requestLock = writeStable(requestLockPath, request);
const sessionIdentity = reviewSessionIdentity(request);

const r21Dir = path.join(outputRoot, "r21-round");
const operatorDir = path.join(outputRoot, "operator");
mkdirSync(r21Dir, { recursive: true });

const built = buildFrozenR21RoundForSession({
  request,
  sandboxRoot,
  outputRoot: r21Dir
});
const r21Files = r21WriteSet(r21Dir, built, request);

const materialized = materializeFrozenR22ForSession({
  r21RoundDir: r21Dir,
  outputDir: operatorDir
});
const verified = verifyMaterializedLiveReviewArtifact(operatorDir);
if (!verified.ok) throw new Error(`R23 nested R22 verification failed: ${stableStringify(verified.errors)}`);

const operatorDirectory = directoryDigest(operatorDir);
const sessionPackage = buildReviewSessionPackage({
  request,
  producerSha,
  producerCiRunId,
  r21Bundle: built.bundle,
  r21BundleFileSha256: r21Files.bundleWrite.sha256,
  r21RoundLineageDigest: built.roundLineageDigest,
  r22Materialized: materialized,
  r22DirectoryDigest: operatorDirectory.digest
});
if (sessionPackage.sessionIdentity !== sessionIdentity) throw new Error("R23 session identity drift");

const sessionWrite = writeStable(
  path.join(outputRoot, "media.review_session_package.r23.v1.json"),
  sessionPackage
);
const evidence = {
  evidenceVersion: "media.review_session_package.r23.evidence.v1",
  producer: sessionPackage.producer,
  state: REVIEW_SESSION_PACKAGE_READY,
  sessionId: request.sessionId,
  mode: request.mode,
  reviewRound: request.reviewRound,
  sessionIdentity,
  requestFileSha256: requestLock.sha256,
  sessionPackageSha256: sessionWrite.sha256,
  source: request.source,
  briefLineageDigest: request.briefLineageDigest,
  growthSelectedEnvelopeDigest: request.growthSelectedEnvelopeDigest,
  growthHandoffDigest: request.growthHandoffDigest,
  baseline: sessionPackage.baseline,
  challenger: sessionPackage.challenger,
  r21: sessionPackage.r21,
  r22: sessionPackage.r22,
  attachments: sessionPackage.attachments,
  promptDigest: sessionPackage.promptDigest,
  sealedMappingDigest: sessionPackage.sealedMappingDigest,
  operatorDirectoryDigest: operatorDirectory.digest,
  operatorDirectoryFiles: operatorDirectory.records,
  nestedR22Verified: true,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false
};
const evidenceWrite = writeStable(
  path.join(outputRoot, "media.review_session_package.r23.evidence.json"),
  evidence
);

console.log("R23_REVIEW_SESSION", stableStringify({
  producerSha,
  producerCiRunId,
  state: sessionPackage.state,
  sessionId: request.sessionId,
  mode: request.mode,
  reviewRound: request.reviewRound,
  sessionIdentity,
  sessionPackageSha256: sessionWrite.sha256,
  evidenceFileSha256: evidenceWrite.sha256,
  r21PackageDigest: sessionPackage.r21.packageDigest,
  r22DirectoryDigest: sessionPackage.r22.directoryDigest,
  r22ArchiveSha256: sessionPackage.r22.archiveSha256,
  r22ArchiveSize: sessionPackage.r22.archiveSize,
  attachments: sessionPackage.attachments,
  promptDigest: sessionPackage.promptDigest,
  sealedMappingDigest: sessionPackage.sealedMappingDigest,
  replayed: requestLock.replayed && sessionWrite.replayed,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false
}));
