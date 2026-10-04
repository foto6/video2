import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import {
  createDeterministicTar,
  readDeterministicTar,
  verifyMaterializedLiveReviewArtifact
} from "./live-review-artifact-r22.js";
import { validateReviewRoundBundle } from "./review-round-r21.js";
import { validateReviewSessionPackage } from "./review-session-r23.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_CANONICAL_LIVE_REVIEW_EXPORT_VERSION = "media.canonical_live_review_export.r24.v1";
export const MEDIA_CANONICAL_LIVE_REVIEW_MANIFEST_VERSION = "media.canonical_live_review_package_manifest.r24.v1";
export const MEDIA_CANONICAL_LIVE_REVIEW_AUTHORITY_VERSION = "media.canonical_live_review_authority.r24.v1";
export const MEDIA_CANONICAL_LIVE_REVIEW_HANDOFF_VERSION = "media.bridge_live_review_handoff.r24.v1";
export const MEDIA_CANONICAL_LIVE_REVIEW_VERIFICATION_VERSION = "media.canonical_live_review_verification.r24.v1";
export const CANONICAL_LIVE_REVIEW_ARTIFACT_READY = "CANONICAL_LIVE_REVIEW_ARTIFACT_READY";

export const R24_R23_AUTHORITY = Object.freeze({
  repository: "foto6/video2",
  branch: "agent/media-r23-next-round-export-20261002",
  producerSha: "78c6982a91d7e3e8c037cd9ce740ee077babdccc",
  ciRunId: 37007419237,
  ciConclusion: "success",
  artifactId: 11226183002,
  artifactName: "media-r23-review-session-package",
  artifactDigest: "sha256:5170ada97f8c86421f4bee34c97fbfa5701bef74ef406f18889a1a790ae3ac66",
  contractVersion: "media.review_session_package.r23.v1",
  requestVersion: "media.review_session_request.r23.v1",
  blobs: Object.freeze({
    implementation: "442ca6a46cbf107d29e6cd320fbb1a4cb38951b0",
    exporter: "4799338cf58edee89bebd773eb544719cdb7f56d",
    contract: "63f863493054dea4ad0e2ebf3a996137602f8940",
    schema: "92470d29b4a524ee6d797194f023a20c5b0dbaa6",
    conformanceManifest: "09564e2d530a7315f58856c55b33bb52534e05c1"
  })
});

const PAYLOAD_DIR = "payload";
const ARCHIVE_FILE = "media-r24-canonical-live-review.tar";
const EXPORT_INDEX_FILE = "media.canonical_live_review_export.r24.v1.json";
const PACKAGE_MANIFEST_FILE = "media.canonical_live_review_package_manifest.r24.v1.json";
const AUTHORITY_FILE = "media.canonical_live_review_authority.r24.v1.json";
const BRIDGE_HANDOFF_FILE = "media.bridge_live_review_handoff.r24.v1.json";
const PROMPT_FILE = "model-facing-prompt.txt";
const SESSION_FILE = "media.review_session_package.r23.v1.json";
const SESSION_EVIDENCE_FILE = "media.review_session_package.r23.evidence.json";
const SESSION_REQUEST_FILE = "media.review_session_request.r23.v1.json";

const R21_FILES = Object.freeze({
  bundle: "media.review_round_bundle.r21.v1.json",
  handoff: "media.review_round_transport_handoff.r21.v1.json",
  evidence: "media.review_round_bundle.r21.evidence.json",
  sealed: "media.review_round_sealed_mapping.r21.v1.json"
});

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashText(text) {
  return hashBytes(Buffer.from(String(text), "utf8"));
}
function hashFile(filePath) {
  if (!existsSync(filePath)) fail("canonical_live_review_missing_file", `missing file: ${filePath}`);
  const bytes = readFileSync(filePath);
  return { sha256: hashBytes(bytes), size: bytes.length };
}
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
function writeStable(filePath, value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : `${stableStringify(value)}\n`, "utf8");
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    const prior = readFileSync(filePath);
    if (!prior.equals(bytes)) fail("canonical_live_review_replay_conflict", `existing file differs: ${filePath}`);
    return { sha256: hashBytes(bytes), size: bytes.length, replayed: true };
  }
  writeFileSync(filePath, bytes);
  return { sha256: hashBytes(bytes), size: bytes.length, replayed: false };
}
function safeChild(root, relativePath, label = "path") {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    fail("canonical_live_review_path_escape", `${label} must be confined relative path`);
  }
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail("canonical_live_review_path_escape", `${label} escapes root`);
  }
  return { absolute: resolved, relative: rel.split(path.sep).join("/") };
}
function mimeFor(name) {
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (name.endsWith(".tar")) return "application/x-tar";
  return "application/octet-stream";
}
function allFiles(root) {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const st = statSync(absolute);
      if (st.isDirectory()) walk(absolute);
      else if (st.isFile()) out.push(path.relative(root, absolute).split(path.sep).join("/"));
      else fail("canonical_live_review_path_escape", "non-regular export entry");
    }
  }
  walk(root);
  return out;
}
function fileRecord(root, relativePath) {
  const item = safeChild(root, relativePath, "manifest file");
  const id = hashFile(item.absolute);
  return {
    path: item.relative,
    sha256: id.sha256,
    size: id.size,
    mime: mimeFor(item.relative)
  };
}
function directoryIdentity(root) {
  const records = allFiles(root).map((name) => fileRecord(root, name));
  return { digest: fingerprint(records), records };
}
function frozenR23DirectoryIdentity(root) {
  const records = allFiles(root).map((relativePath) => {
    const id = hashFile(path.join(root, relativePath));
    return { path: relativePath, sha256: id.sha256, size: id.size };
  });
  return { digest: fingerprint(records), records };
}
function copyStable(source, target) {
  const expected = hashFile(source);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) {
    const actual = hashFile(target);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      fail("canonical_live_review_replay_conflict", `existing copied file differs: ${target}`);
    }
  } else {
    copyFileSync(source, target);
  }
  return expected;
}
function copyTreeStable(sourceRoot, targetRoot) {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot);
  const records = [];
  for (const relativePath of allFiles(source)) {
    const src = safeChild(source, relativePath, "source tree file");
    const dst = safeChild(target, relativePath, "target tree file");
    const id = copyStable(src.absolute, dst.absolute);
    records.push({ path: relativePath, ...id });
  }
  return records;
}
function exactJson(a, b) {
  return stableStringify(a) === stableStringify(b);
}
function sha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("canonical_live_review_invalid", `${label} must be lowercase SHA-256 hex`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("canonical_live_review_invalid", `${label} must be exact Git SHA`);
  }
}
function positive(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail("canonical_live_review_invalid", `${label} must be positive integer`);
}
function validateAuthorityBlobs(blobs) {
  if (!blobs || typeof blobs !== "object" || Array.isArray(blobs)) fail("canonical_live_review_invalid", "producer blobs required");
  for (const [name, value] of Object.entries(blobs)) gitSha(value, `producerBlobs.${name}`);
  for (const required of ["implementation", "exporter", "verifier", "contract", "schema"]) {
    if (!blobs[required]) fail("canonical_live_review_invalid", `producerBlobs.${required} required`);
  }
  return clone(blobs);
}

function verifyR23SessionSource(sessionDir) {
  const root = path.resolve(sessionDir);
  const sessionPath = safeChild(root, SESSION_FILE, "R23 session").absolute;
  const evidencePath = safeChild(root, SESSION_EVIDENCE_FILE, "R23 evidence").absolute;
  const requestPath = safeChild(root, SESSION_REQUEST_FILE, "R23 request").absolute;
  const r21Root = safeChild(root, "r21-round", "R21 directory").absolute;
  const operatorRoot = safeChild(root, "operator", "R22 operator directory").absolute;
  for (const file of [sessionPath, evidencePath, requestPath]) {
    if (!existsSync(file) || !statSync(file).isFile()) fail("canonical_live_review_missing_file", `R23 required file missing: ${file}`);
  }
  const session = validateReviewSessionPackage(readJson(sessionPath));
  if (
    session.producer.sha !== R24_R23_AUTHORITY.producerSha ||
    session.producer.ciRunId !== R24_R23_AUTHORITY.ciRunId
  ) fail("canonical_live_review_authority_mismatch", "R23 session producer/CI is not the exact accepted authority");

  const evidence = readJson(evidencePath);
  if (
    evidence.state !== "REVIEW_SESSION_PACKAGE_READY" ||
    evidence.sessionIdentity !== session.sessionIdentity ||
    evidence.sessionPackageSha256 !== hashFile(sessionPath).sha256 ||
    evidence.promptDigest !== session.promptDigest ||
    evidence.sealedMappingDigest !== session.sealedMappingDigest ||
    evidence.r21?.packageDigest !== session.r21.packageDigest ||
    evidence.r22?.archiveSha256 !== session.r22.archiveSha256 ||
    evidence.modelReviewPerformed !== false ||
    evidence.liveModelReviewed !== false ||
    evidence.providerPublish !== false ||
    evidence.humanQuality !== false
  ) fail("canonical_live_review_session_drift", "R23 session evidence does not bind session package");

  const r21BundlePath = safeChild(r21Root, R21_FILES.bundle, "R21 bundle").absolute;
  const r21HandoffPath = safeChild(r21Root, R21_FILES.handoff, "R21 handoff").absolute;
  const r21EvidencePath = safeChild(r21Root, R21_FILES.evidence, "R21 evidence").absolute;
  const r21SealedPath = safeChild(r21Root, R21_FILES.sealed, "R21 sealed mapping").absolute;
  for (const file of [r21BundlePath, r21HandoffPath, r21EvidencePath, r21SealedPath]) {
    if (!existsSync(file) || !statSync(file).isFile()) fail("canonical_live_review_missing_file", `nested R21 file missing: ${file}`);
  }
  const bundle = validateReviewRoundBundle(readJson(r21BundlePath));
  const r21Handoff = readJson(r21HandoffPath);
  const r21Evidence = readJson(r21EvidencePath);
  const sealed = readJson(r21SealedPath);
  if (
    bundle.transportHandoff?.packageDigest !== session.r21.packageDigest ||
    r21Handoff.packageDigest !== session.r21.packageDigest ||
    r21Evidence.packageDigest !== session.r21.packageDigest ||
    sealed.digest !== session.sealedMappingDigest ||
    bundle.sealedMapping?.digest !== session.sealedMappingDigest ||
    bundle.prompt?.digest !== session.promptDigest ||
    bundle.reviewRound !== session.reviewRound ||
    bundle.briefLineageDigest !== session.briefLineageDigest ||
    bundle.source?.sha256 !== session.source.sha256
  ) fail("canonical_live_review_lineage_mismatch", "R21 nested evidence differs from R23 session");

  const r22 = verifyMaterializedLiveReviewArtifact(operatorRoot);
  if (!r22.ok) fail("canonical_live_review_nested_r22_invalid", "nested R22 operator directory failed verification", r22.errors);
  if (
    r22.archive.sha256 !== session.r22.archiveSha256 ||
    r22.archive.size !== session.r22.archiveSize ||
    r22.packageDigest !== session.r21.packageDigest ||
    r22.sealedMappingDigest !== session.sealedMappingDigest ||
    r22.promptDigest !== session.promptDigest ||
    r22.reviewRound !== session.reviewRound
  ) fail("canonical_live_review_lineage_mismatch", "R22 nested operator evidence differs from R23 session");

  const operatorIdentity = frozenR23DirectoryIdentity(operatorRoot);
  if (operatorIdentity.digest !== session.r22.directoryDigest) {
    fail("canonical_live_review_lineage_mismatch", "R22 operator directory digest differs from R23 session");
  }

  const promptPath = path.join(operatorRoot, "payload", PROMPT_FILE);
  const prompt = readFileSync(promptPath);
  if (hashBytes(prompt) !== session.promptDigest) fail("canonical_live_review_prompt_drift", "raw prompt bytes differ from R23 prompt digest");

  const attachments = session.attachments.map((entry) => {
    const filePath = path.join(operatorRoot, "payload", entry.name);
    const actual = hashFile(filePath);
    if (actual.sha256 !== entry.sha256 || actual.size !== entry.size || entry.mime !== "video/mp4") {
      fail("canonical_live_review_attachment_drift", `R23 attachment differs: ${entry.name}`);
    }
    return { ...clone(entry), sourcePath: filePath };
  });
  if (attachments[0].sha256 === attachments[1].sha256) {
    fail("canonical_live_review_duplicate_render", "R23 session contains byte-identical attachments");
  }

  const promptText = prompt.toString("utf8");
  for (const entry of sealed.entries ?? []) {
    for (const secret of [
      entry.candidateId,
      entry.role,
      entry.render?.sha256,
      entry.renderProducerSha,
      entry.mediaApplicationDigest,
      entry.growthHandoffDigest
    ].filter((value) => typeof value === "string" && value.length >= 8)) {
      if (promptText.includes(secret)) fail("canonical_live_review_blinding_failed", "model prompt leaks sealed candidate/role identity");
    }
  }

  return {
    root,
    session,
    evidence,
    request: readJson(requestPath),
    sessionPath,
    evidencePath,
    requestPath,
    r21Root,
    r21BundlePath,
    r21HandoffPath,
    r21EvidencePath,
    r21SealedPath,
    operatorRoot,
    bundle,
    sealed,
    r22,
    operatorIdentity,
    prompt,
    attachments
  };
}

function canonicalPackageCore({ producer, source, session, attachments, promptDigest, sealedMappingDigest, authorityProfileDigest }) {
  return {
    contractVersion: MEDIA_CANONICAL_LIVE_REVIEW_EXPORT_VERSION,
    state: CANONICAL_LIVE_REVIEW_ARTIFACT_READY,
    producer,
    source,
    session: {
      sessionId: session.sessionId,
      sessionIdentity: session.sessionIdentity,
      mode: session.mode,
      reviewRound: session.reviewRound,
      briefLineageDigest: session.briefLineageDigest,
      growthSelectedEnvelopeDigest: session.growthSelectedEnvelopeDigest,
      growthHandoffDigest: session.growthHandoffDigest,
      r21PackageDigest: session.r21.packageDigest,
      r22DirectoryDigest: session.r22.directoryDigest,
      r22ArchiveSha256: session.r22.archiveSha256
    },
    attachments,
    promptDigest,
    sealedMappingDigest,
    authorityProfileDigest,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
}

export function materializeCanonicalLiveReviewExport({
  r23SessionDir,
  outputDir,
  producerSha,
  producerCiRunId,
  producerBlobs
} = {}) {
  gitSha(producerSha, "producerSha");
  positive(producerCiRunId, "producerCiRunId");
  const blobs = validateAuthorityBlobs(producerBlobs);
  const source = verifyR23SessionSource(r23SessionDir);
  const out = path.resolve(outputDir);
  const payloadRoot = path.join(out, PAYLOAD_DIR);
  mkdirSync(payloadRoot, { recursive: true });

  for (const attachment of source.attachments) {
    copyStable(attachment.sourcePath, path.join(payloadRoot, attachment.name));
  }
  writeStable(path.join(payloadRoot, PROMPT_FILE), source.prompt);

  copyStable(source.sessionPath, path.join(payloadRoot, "r23", SESSION_FILE));
  copyStable(source.evidencePath, path.join(payloadRoot, "r23", SESSION_EVIDENCE_FILE));
  copyStable(source.requestPath, path.join(payloadRoot, "machine", "r23", SESSION_REQUEST_FILE));

  copyStable(source.r21BundlePath, path.join(payloadRoot, "r21", R21_FILES.bundle));
  copyStable(source.r21HandoffPath, path.join(payloadRoot, "r21", R21_FILES.handoff));
  copyStable(source.r21EvidencePath, path.join(payloadRoot, "r21", R21_FILES.evidence));
  copyStable(source.r21SealedPath, path.join(payloadRoot, "machine", "r21", R21_FILES.sealed));

  copyTreeStable(source.operatorRoot, path.join(payloadRoot, "nested", "r22-operator"));

  const authority = {
    contractVersion: MEDIA_CANONICAL_LIVE_REVIEW_AUTHORITY_VERSION,
    state: CANONICAL_LIVE_REVIEW_ARTIFACT_READY,
    producerR24: {
      repository: "foto6/video2",
      producerSha,
      ciRunId: producerCiRunId,
      blobs
    },
    acceptedR23: clone(R24_R23_AUTHORITY),
    inputSession: {
      producerSha: source.session.producer.sha,
      ciRunId: source.session.producer.ciRunId,
      sessionId: source.session.sessionId,
      sessionIdentity: source.session.sessionIdentity,
      contractVersion: source.session.contractVersion
    },
    nestedAuthorities: {
      r21: clone(source.session.r21.authority),
      r22: clone(source.session.r22.authority),
      bridgeR31: clone(readJson(path.join(source.operatorRoot, "media.live_review_operator_manifest.r22.v1.json")).bridgeR31Authority)
    },
    contracts: {
      export: MEDIA_CANONICAL_LIVE_REVIEW_EXPORT_VERSION,
      packageManifest: MEDIA_CANONICAL_LIVE_REVIEW_MANIFEST_VERSION,
      bridgeHandoff: MEDIA_CANONICAL_LIVE_REVIEW_HANDOFF_VERSION,
      verification: MEDIA_CANONICAL_LIVE_REVIEW_VERIFICATION_VERSION,
      r23Session: source.session.contractVersion,
      r21Bundle: source.bundle.contractVersion,
      r21Handoff: source.bundle.transportHandoff.contractVersion,
      r22Operator: "media.live_review_operator_manifest.r22.v1"
    },
    evidenceBoundary: {
      nonHumanGroundTruthDemoAllowed: true,
      modelReviewPerformed: false,
      liveModelReviewed: false,
      browserMutationPerformed: false,
      providerPublish: false,
      humanQuality: false
    }
  };
  const authorityWrite = writeStable(path.join(payloadRoot, AUTHORITY_FILE), authority);
  const authorityProfileDigest = fingerprint(authority);

  const attachments = source.attachments.map((entry) => ({
    blindLabel: entry.blindLabel,
    relativePath: entry.name,
    sha256: entry.sha256,
    size: entry.size,
    mime: entry.mime
  }));
  const producer = { repository: "foto6/video2", sha: producerSha, ciRunId: producerCiRunId };
  const core = canonicalPackageCore({
    producer,
    source: clone(source.session.source),
    session: source.session,
    attachments,
    promptDigest: source.session.promptDigest,
    sealedMappingDigest: source.session.sealedMappingDigest,
    authorityProfileDigest
  });
  const packageDigest = fingerprint(core);

  const bridgeHandoff = {
    contractVersion: MEDIA_CANONICAL_LIVE_REVIEW_HANDOFF_VERSION,
    state: CANONICAL_LIVE_REVIEW_ARTIFACT_READY,
    packageDigest,
    bridgeR31Authority: clone(authority.nestedAuthorities.bridgeR31),
    sourceLineage: {
      source: clone(source.session.source),
      briefLineageDigest: source.session.briefLineageDigest,
      mode: source.session.mode,
      reviewRound: source.session.reviewRound,
      sessionId: source.session.sessionId,
      sessionIdentity: source.session.sessionIdentity
    },
    prompt: {
      relativePath: PROMPT_FILE,
      sha256: source.session.promptDigest,
      size: source.prompt.length,
      mime: "text/plain; charset=utf-8"
    },
    attachments,
    sealedMapping: {
      digest: source.session.sealedMappingDigest,
      machineSideRelativePath: `machine/r21/${R21_FILES.sealed}`,
      contentsModelFacing: false
    },
    nestedR22Operator: {
      operatorDirRelative: "nested/r22-operator",
      operatorManifestRelative: "nested/r22-operator/media.live_review_operator_manifest.r22.v1.json",
      artifactDirRelative: "nested/r22-operator/payload",
      archiveRelative: "nested/r22-operator/media-r22-live-package.tar",
      expectedArchiveSha256: source.session.r22.archiveSha256
    },
    modelFacingFiles: [PROMPT_FILE, "review-A.mp4", "review-B.mp4"],
    modelReviewPerformed: false,
    liveModelReviewed: false,
    browserMutationPerformed: false,
    providerPublish: false,
    humanQuality: false
  };
  const handoffWrite = writeStable(path.join(payloadRoot, BRIDGE_HANDOFF_FILE), bridgeHandoff);

  const beforeManifest = allFiles(payloadRoot).filter((name) => name !== PACKAGE_MANIFEST_FILE);
  const beforeRecords = beforeManifest.map((name) => fileRecord(payloadRoot, name));
  const packageManifest = {
    contractVersion: MEDIA_CANONICAL_LIVE_REVIEW_MANIFEST_VERSION,
    state: CANONICAL_LIVE_REVIEW_ARTIFACT_READY,
    packageDigest,
    sourceSession: {
      sessionId: source.session.sessionId,
      sessionIdentity: source.session.sessionIdentity,
      mode: source.session.mode,
      reviewRound: source.session.reviewRound,
      source: clone(source.session.source),
      briefLineageDigest: source.session.briefLineageDigest
    },
    promptDigest: source.session.promptDigest,
    sealedMappingDigest: source.session.sealedMappingDigest,
    authorityProfileSha256: authorityWrite.sha256,
    bridgeHandoffSha256: handoffWrite.sha256,
    files: beforeRecords,
    fileSetDigest: fingerprint(beforeRecords),
    manifestSelfHashRecordedInExportIndex: true,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
  const manifestWrite = writeStable(path.join(payloadRoot, PACKAGE_MANIFEST_FILE), packageManifest);

  const payloadIdentity = directoryIdentity(payloadRoot);
  const archivePath = path.join(out, ARCHIVE_FILE);
  const archive = createDeterministicTar(payloadRoot, allFiles(payloadRoot), archivePath);

  const exportIndex = {
    contractVersion: MEDIA_CANONICAL_LIVE_REVIEW_EXPORT_VERSION,
    state: CANONICAL_LIVE_REVIEW_ARTIFACT_READY,
    producer,
    packageDigest,
    payloadDirectory: {
      relativePath: PAYLOAD_DIR,
      digest: payloadIdentity.digest,
      fileCount: payloadIdentity.records.length
    },
    archive: {
      relativePath: ARCHIVE_FILE,
      sha256: archive.sha256,
      size: archive.size,
      mime: "application/x-tar"
    },
    packageManifest: {
      relativePath: `${PAYLOAD_DIR}/${PACKAGE_MANIFEST_FILE}`,
      sha256: manifestWrite.sha256
    },
    authorityProfile: {
      relativePath: `${PAYLOAD_DIR}/${AUTHORITY_FILE}`,
      sha256: authorityWrite.sha256,
      digest: authorityProfileDigest
    },
    bridgeHandoff: {
      relativePath: `${PAYLOAD_DIR}/${BRIDGE_HANDOFF_FILE}`,
      sha256: handoffWrite.sha256
    },
    sourceLineage: clone(bridgeHandoff.sourceLineage),
    promptDigest: source.session.promptDigest,
    sealedMappingDigest: source.session.sealedMappingDigest,
    attachments,
    nestedR23: {
      sessionPackageRelativePath: `${PAYLOAD_DIR}/r23/${SESSION_FILE}`,
      sessionPackageSha256: hashFile(source.sessionPath).sha256,
      sessionEvidenceRelativePath: `${PAYLOAD_DIR}/r23/${SESSION_EVIDENCE_FILE}`,
      sessionEvidenceSha256: hashFile(source.evidencePath).sha256
    },
    nonHumanGroundTruthDemo: true,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    browserMutationPerformed: false,
    providerPublish: false,
    humanQuality: false
  };
  const indexWrite = writeStable(path.join(out, EXPORT_INDEX_FILE), exportIndex);

  const verification = verifyCanonicalLiveReviewExport(out);
  if (!verification.ok) fail("canonical_live_review_verification_failed", "new canonical export failed verification", verification.errors);

  return {
    exportDir: out,
    payloadRoot,
    archivePath,
    exportIndex,
    exportIndexSha256: indexWrite.sha256,
    packageDigest,
    payloadDirectoryDigest: payloadIdentity.digest,
    archiveSha256: archive.sha256,
    archiveSize: archive.size,
    packageManifestSha256: manifestWrite.sha256,
    bridgeHandoffSha256: handoffWrite.sha256,
    authorityProfileSha256: authorityWrite.sha256,
    authorityProfileDigest,
    attachments,
    promptDigest: source.session.promptDigest,
    sealedMappingDigest: source.session.sealedMappingDigest,
    mode: source.session.mode,
    reviewRound: source.session.reviewRound,
    verification
  };
}

export function verifyCanonicalLiveReviewExport(exportDir) {
  const errors = [];
  const root = path.resolve(exportDir);
  try {
    const indexPath = safeChild(root, EXPORT_INDEX_FILE, "export index").absolute;
    if (!existsSync(indexPath)) return { ok: false, errors: ["export_index_missing"] };
    const index = readJson(indexPath);
    if (
      index.contractVersion !== MEDIA_CANONICAL_LIVE_REVIEW_EXPORT_VERSION ||
      index.state !== CANONICAL_LIVE_REVIEW_ARTIFACT_READY
    ) errors.push("export_contract_or_state_mismatch");
    if (
      index.modelReviewPerformed !== false ||
      index.liveModelReviewed !== false ||
      index.browserMutationPerformed !== false ||
      index.providerPublish !== false ||
      index.humanQuality !== false
    ) errors.push("export_evidence_boundary_violation");

    const payloadRoot = safeChild(root, index.payloadDirectory?.relativePath, "payload directory").absolute;
    const archivePath = safeChild(root, index.archive?.relativePath, "archive").absolute;
    const archiveIdentity = hashFile(archivePath);
    if (
      archiveIdentity.sha256 !== index.archive?.sha256 ||
      archiveIdentity.size !== index.archive?.size ||
      index.archive?.mime !== "application/x-tar"
    ) errors.push("archive_identity_mismatch");

    const manifestPath = safeChild(root, index.packageManifest?.relativePath, "package manifest").absolute;
    const manifestIdentity = hashFile(manifestPath);
    if (manifestIdentity.sha256 !== index.packageManifest?.sha256) errors.push("package_manifest_sha_mismatch");
    const manifest = readJson(manifestPath);
    if (
      manifest.contractVersion !== MEDIA_CANONICAL_LIVE_REVIEW_MANIFEST_VERSION ||
      manifest.state !== CANONICAL_LIVE_REVIEW_ARTIFACT_READY ||
      manifest.packageDigest !== index.packageDigest
    ) errors.push("package_manifest_contract_or_digest_mismatch");

    const listed = manifest.files ?? [];
    const listedPaths = new Set();
    for (const record of listed) {
      if (listedPaths.has(record.path)) errors.push("duplicate_manifest_path");
      listedPaths.add(record.path);
      const item = safeChild(payloadRoot, record.path, "manifest file").absolute;
      if (!existsSync(item) || !statSync(item).isFile()) {
        errors.push(`missing_payload_file:${record.path}`);
        continue;
      }
      const actual = hashFile(item);
      if (actual.sha256 !== record.sha256 || actual.size !== record.size || mimeFor(record.path) !== record.mime) {
        errors.push(`payload_identity_mismatch:${record.path}`);
      }
    }
    if (fingerprint(listed) !== manifest.fileSetDigest) errors.push("package_file_set_digest_mismatch");

    const payloadFiles = allFiles(payloadRoot);
    const expectedPayload = [...listedPaths, PACKAGE_MANIFEST_FILE].sort();
    if (stableStringify(payloadFiles) !== stableStringify(expectedPayload)) errors.push("payload_file_set_mismatch");

    const payloadIdentity = directoryIdentity(payloadRoot);
    if (
      payloadIdentity.digest !== index.payloadDirectory?.digest ||
      payloadIdentity.records.length !== index.payloadDirectory?.fileCount
    ) errors.push("payload_directory_digest_mismatch");

    const tar = readDeterministicTar(archivePath);
    const tarNames = [...tar.entries.keys()].sort();
    if (stableStringify(tarNames) !== stableStringify(payloadFiles)) errors.push("archive_entry_set_mismatch");
    for (const name of payloadFiles) {
      const archived = tar.entries.get(name);
      const disk = readFileSync(path.join(payloadRoot, name));
      if (!archived || !archived.equals(disk)) errors.push(`archive_payload_mismatch:${name}`);
    }

    const sessionPath = safeChild(payloadRoot, `r23/${SESSION_FILE}`, "R23 session").absolute;
    const session = validateReviewSessionPackage(readJson(sessionPath));
    if (
      hashFile(sessionPath).sha256 !== index.nestedR23?.sessionPackageSha256 ||
      session.sessionIdentity !== index.sourceLineage?.sessionIdentity ||
      session.reviewRound !== index.sourceLineage?.reviewRound ||
      session.briefLineageDigest !== index.sourceLineage?.briefLineageDigest ||
      session.source.sha256 !== index.sourceLineage?.source?.sha256
    ) errors.push("r23_session_lineage_mismatch");
    const sessionEvidencePath = safeChild(payloadRoot, `r23/${SESSION_EVIDENCE_FILE}`, "R23 evidence").absolute;
    if (hashFile(sessionEvidencePath).sha256 !== index.nestedR23?.sessionEvidenceSha256) {
      errors.push("r23_session_evidence_sha_mismatch");
    }
    if (
      session.promptDigest !== index.promptDigest ||
      session.sealedMappingDigest !== index.sealedMappingDigest
    ) errors.push("r23_session_review_digest_mismatch");

    const r21BundlePath = path.join(payloadRoot, "r21", R21_FILES.bundle);
    const r21Bundle = validateReviewRoundBundle(readJson(r21BundlePath));
    const sealedPath = path.join(payloadRoot, "machine", "r21", R21_FILES.sealed);
    const sealed = readJson(sealedPath);
    if (
      r21Bundle.transportHandoff?.packageDigest !== session.r21.packageDigest ||
      sealed.digest !== session.sealedMappingDigest ||
      fingerprint(sealed.entries) !== sealed.digest
    ) errors.push("r21_nested_lineage_mismatch");

    const promptPath = path.join(payloadRoot, PROMPT_FILE);
    const prompt = readFileSync(promptPath);
    if (hashBytes(prompt) !== index.promptDigest || prompt.toString("utf8") !== r21Bundle.prompt.text) {
      errors.push("model_prompt_bytes_mismatch");
    }
    for (const entry of sealed.entries ?? []) {
      for (const secret of [
        entry.candidateId,
        entry.role,
        entry.render?.sha256,
        entry.renderProducerSha,
        entry.mediaApplicationDigest,
        entry.growthHandoffDigest
      ].filter((value) => typeof value === "string" && value.length >= 8)) {
        if (prompt.toString("utf8").includes(secret)) errors.push("model_prompt_identity_leak");
      }
    }

    const handoffPath = safeChild(root, index.bridgeHandoff?.relativePath, "Bridge handoff").absolute;
    const handoff = readJson(handoffPath);
    if (
      hashFile(handoffPath).sha256 !== index.bridgeHandoff?.sha256 ||
      handoff.contractVersion !== MEDIA_CANONICAL_LIVE_REVIEW_HANDOFF_VERSION ||
      handoff.state !== CANONICAL_LIVE_REVIEW_ARTIFACT_READY ||
      handoff.packageDigest !== index.packageDigest ||
      handoff.prompt?.sha256 !== index.promptDigest ||
      handoff.sealedMapping?.digest !== index.sealedMappingDigest ||
      handoff.sealedMapping?.contentsModelFacing !== false
    ) errors.push("bridge_handoff_mismatch");
    if (stableStringify(handoff.attachments) !== stableStringify(index.attachments)) {
      errors.push("bridge_attachment_mapping_mismatch");
    }
    if (
      JSON.stringify(handoff).includes('"candidateId"') ||
      JSON.stringify(handoff).includes('"baseline"') ||
      JSON.stringify(handoff).includes('"challenger"')
    ) errors.push("bridge_handoff_sealed_role_leak");

    for (const attachment of index.attachments ?? []) {
      const filePath = safeChild(payloadRoot, attachment.relativePath, "attachment").absolute;
      const actual = hashFile(filePath);
      if (
        actual.sha256 !== attachment.sha256 ||
        actual.size !== attachment.size ||
        attachment.mime !== "video/mp4"
      ) errors.push(`attachment_identity_mismatch:${attachment.blindLabel}`);
    }
    if (index.attachments?.[0]?.sha256 === index.attachments?.[1]?.sha256) errors.push("duplicate_review_attachment_bytes");

    const nestedOperatorDir = path.join(payloadRoot, "nested", "r22-operator");
    const nestedR22 = verifyMaterializedLiveReviewArtifact(nestedOperatorDir);
    if (!nestedR22.ok) errors.push(...nestedR22.errors.map((error) => `nested_r22:${error}`));
    else if (
      nestedR22.archive.sha256 !== session.r22.archiveSha256 ||
      nestedR22.packageDigest !== session.r21.packageDigest ||
      nestedR22.promptDigest !== session.promptDigest ||
      nestedR22.sealedMappingDigest !== session.sealedMappingDigest
    ) errors.push("nested_r22_session_mismatch");

    const authorityPath = safeChild(root, index.authorityProfile?.relativePath, "authority profile").absolute;
    const authority = readJson(authorityPath);
    if (
      hashFile(authorityPath).sha256 !== index.authorityProfile?.sha256 ||
      fingerprint(authority) !== index.authorityProfile?.digest ||
      authority.contractVersion !== MEDIA_CANONICAL_LIVE_REVIEW_AUTHORITY_VERSION ||
      authority.acceptedR23?.producerSha !== R24_R23_AUTHORITY.producerSha ||
      authority.acceptedR23?.ciRunId !== R24_R23_AUTHORITY.ciRunId ||
      authority.inputSession?.producerSha !== R24_R23_AUTHORITY.producerSha ||
      authority.inputSession?.ciRunId !== R24_R23_AUTHORITY.ciRunId ||
      authority.evidenceBoundary?.modelReviewPerformed !== false ||
      authority.evidenceBoundary?.humanQuality !== false
    ) errors.push("authority_profile_mismatch");

    const recomputedPackageDigest = fingerprint(canonicalPackageCore({
      producer: index.producer,
      source: session.source,
      session,
      attachments: index.attachments,
      promptDigest: index.promptDigest,
      sealedMappingDigest: index.sealedMappingDigest,
      authorityProfileDigest: index.authorityProfile?.digest
    }));
    if (recomputedPackageDigest !== index.packageDigest || recomputedPackageDigest !== manifest.packageDigest) {
      errors.push("canonical_package_digest_mismatch");
    }

    return {
      contractVersion: MEDIA_CANONICAL_LIVE_REVIEW_VERIFICATION_VERSION,
      ok: errors.length === 0,
      errors,
      exportDir: root,
      exportIndex: hashFile(indexPath),
      packageDigest: index.packageDigest,
      payloadDirectoryDigest: payloadIdentity.digest,
      archive: archiveIdentity,
      mode: session.mode,
      reviewRound: session.reviewRound,
      sessionId: session.sessionId,
      sessionIdentity: session.sessionIdentity,
      source: clone(session.source),
      briefLineageDigest: session.briefLineageDigest,
      promptDigest: session.promptDigest,
      sealedMappingDigest: session.sealedMappingDigest,
      attachments: clone(index.attachments),
      fileCount: payloadFiles.length,
      modelReviewPerformed: false,
      liveModelReviewed: false,
      providerPublish: false,
      humanQuality: false
    };
  } catch (error) {
    return {
      contractVersion: MEDIA_CANONICAL_LIVE_REVIEW_VERIFICATION_VERSION,
      ok: false,
      errors: [String(error?.message ?? error)]
    };
  }
}
