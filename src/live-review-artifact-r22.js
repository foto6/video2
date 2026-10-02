import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import {
  MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
  MEDIA_REVIEW_ROUND_HANDOFF_VERSION,
  ROUND_PAIR_PACKAGE_READY,
  validateReviewRoundBundle
} from "./review-round-r21.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_LIVE_REVIEW_ARTIFACT_VERSION = "media.live_review_artifact.r22.v1";
export const MEDIA_LIVE_REVIEW_PACKAGE_MANIFEST_VERSION = "media.live_review_package_manifest.r22.v1";
export const MEDIA_LIVE_REVIEW_AUTHORITY_PROFILE_VERSION = "media.live_review_authority_profile.r22.v1";
export const MEDIA_LIVE_REVIEW_OPERATOR_MANIFEST_VERSION = "media.live_review_operator_manifest.r22.v1";
export const MEDIA_LIVE_REVIEW_VERIFICATION_VERSION = "media.live_review_verification.r22.v1";
export const LIVE_REVIEW_ARTIFACT_READY = "LIVE_REVIEW_ARTIFACT_READY";

export const R22_R21_AUTHORITY = Object.freeze({
  repository: "foto6/video2",
  branch: "agent/media-r21-round-pair-review-bundle-20261002",
  producerSha: "d753e9e4c1f4448386608a1425232dbc1dba87ea",
  ciRunId: 36994000619,
  ciConclusion: "success",
  artifactId: 11221240371,
  artifactName: "media-r21-round-pair-review",
  artifactDigest: "sha256:1036800923196882590ace62edbaa123ab4250b9d242e14adba909ba256ab022",
  bundleContract: MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
  handoffContract: MEDIA_REVIEW_ROUND_HANDOFF_VERSION,
  evidenceContract: "media.review_round_bundle.r21.evidence.v1",
  state: ROUND_PAIR_PACKAGE_READY,
  blobs: Object.freeze({
    implementation: "c6f556b8a177b6182d787356625094cdcad5a58e",
    runner: "c93e9a69de31b66189031932ccfa7f2c83cf043c",
    contract: "65358261775f0fcd2ab9e21f3f621aee977f29da",
    schema: "f04925e317d849434852e6b706533f909da47b22",
    conformanceManifest: "f76033375e7ee03b56491722e2e99e7334bd2cad"
  })
});

export const R22_BRIDGE_R31_AUTHORITY = Object.freeze({
  repository: "foto6/WebAIBridge",
  branch: "agent/bridge-r31-live-dynamic-operator-20261002",
  producerSha: "31cfef82663d72d53e69e6345b50073ffcd461ca",
  ciRunId: 36997793086,
  ciConclusion: "success",
  mediaOperatorImplementationBlob: "38509af174fc25aa4229c084fc3cd9b2e35b539e",
  operatorManifestSchemaBlob: "f90cd2aa4bdc868af845bfba58c612ebef3f32ad",
  authorityProfileSchemaBlob: "25e2cbfe487ba88f70d233774e585691ad4f70c6",
  expectedMediaProducerSha: R22_R21_AUTHORITY.producerSha,
  expectedMediaCiRunId: R22_R21_AUTHORITY.ciRunId,
  expectedBundleContract: MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
  expectedHandoffContract: MEDIA_REVIEW_ROUND_HANDOFF_VERSION
});

export const R22_REQUIRED_R21_FILES = Object.freeze({
  bundle: "media.review_round_bundle.r21.v1.json",
  handoff: "media.review_round_transport_handoff.r21.v1.json",
  sealed: "media.review_round_sealed_mapping.r21.v1.json",
  promptJson: "model-review-prompt.txt.json",
  evidence: "media.review_round_bundle.r21.evidence.json",
  attachmentA: "review-A.mp4",
  attachmentB: "review-B.mp4"
});

const PROMPT_RAW_FILE = "model-facing-prompt.txt";
const AUTHORITY_FILE = "media.live_review_authority_profile.r22.v1.json";
const PACKAGE_MANIFEST_FILE = "media.live_review_package_manifest.r22.v1.json";
const OPERATOR_MANIFEST_FILE = "media.live_review_operator_manifest.r22.v1.json";
const ARCHIVE_FILE = "media-r22-live-package.tar";

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashText(value) {
  return hashBytes(Buffer.from(String(value), "utf8"));
}
function hashFile(filePath) {
  if (!existsSync(filePath)) fail("live_review_missing_file", `missing file: ${filePath}`);
  const bytes = readFileSync(filePath);
  return { sha256: hashBytes(bytes), size: bytes.length };
}
function safeChild(root, relativePath, label = "path") {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    fail("live_review_path_escape", `${label} must be a confined relative path`);
  }
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail("live_review_path_escape", `${label} escapes root`);
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
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
function writeStable(filePath, value) {
  const content = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : `${stableStringify(value)}\n`;
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    const prior = readFileSync(filePath);
    if (!prior.equals(bytes)) fail("live_review_replay_conflict", `existing file differs: ${path.basename(filePath)}`);
  } else {
    writeFileSync(filePath, bytes);
  }
  return { sha256: hashBytes(bytes), size: bytes.length };
}
function exactJson(a, b) {
  return stableStringify(a) === stableStringify(b);
}
function r21BundleCore(bundle) {
  return {
    contractVersion: bundle.contractVersion,
    state: bundle.state,
    producer: bundle.producer,
    bridgeAuthority: bundle.bridgeAuthority,
    mode: bundle.mode,
    source: bundle.source,
    briefLineageDigest: bundle.briefLineageDigest,
    reviewRound: bundle.reviewRound,
    attachments: bundle.attachments,
    prompt: bundle.prompt,
    r20PackageDigest: bundle.r20PackageDigest,
    r20SealedMappingDigest: bundle.r20SealedMappingDigest,
    sealedMapping: bundle.sealedMapping,
    roundLineage: bundle.roundLineage,
    modelReviewPerformed: bundle.modelReviewPerformed,
    liveModelReviewed: bundle.liveModelReviewed,
    providerPublish: bundle.providerPublish,
    humanQuality: bundle.humanQuality
  };
}
function forbiddenPromptSecrets(bundle) {
  const out = ["baseline", "challenger", "winner", "parent", "child"];
  for (const entry of bundle.sealedMapping?.entries ?? []) {
    for (const value of [
      entry.candidateId,
      entry.briefLineageDigest,
      entry.render?.sha256,
      entry.renderExport?.digest,
      entry.renderExport?.fileSha256,
      entry.renderProducerSha,
      entry.growthHandoffDigest,
      entry.mediaApplicationDigest,
      entry.editorialApplication?.digest,
      entry.editorialApplication?.fileSha256,
      entry.editorialApplication?.handoffDigest
    ]) {
      if (typeof value === "string" && value) out.push(value);
    }
  }
  return out;
}

export function verifyExactR21RoundDirectory(sourceDir) {
  const root = path.resolve(sourceDir);
  const files = {};
  for (const [key, name] of Object.entries(R22_REQUIRED_R21_FILES)) {
    const item = safeChild(root, name, key);
    if (!existsSync(item.absolute) || !statSync(item.absolute).isFile()) {
      fail("live_review_missing_file", `R21 required file missing: ${name}`);
    }
    files[key] = item.absolute;
  }

  const bundle = validateReviewRoundBundle(readJson(files.bundle));
  const handoff = readJson(files.handoff);
  const sealed = readJson(files.sealed);
  const promptJson = readJson(files.promptJson);
  const evidence = readJson(files.evidence);

  if (
    bundle.producer?.repository !== R22_R21_AUTHORITY.repository ||
    bundle.producer?.sha !== R22_R21_AUTHORITY.producerSha ||
    evidence.producer?.repository !== R22_R21_AUTHORITY.repository ||
    evidence.producer?.sha !== R22_R21_AUTHORITY.producerSha
  ) fail("live_review_authority_mismatch", "R21 producer authority mismatch");
  if (
    bundle.contractVersion !== R22_R21_AUTHORITY.bundleContract ||
    handoff.contractVersion !== R22_R21_AUTHORITY.handoffContract ||
    evidence.evidenceVersion !== R22_R21_AUTHORITY.evidenceContract ||
    bundle.state !== R22_R21_AUTHORITY.state ||
    handoff.state !== R22_R21_AUTHORITY.state ||
    evidence.state !== R22_R21_AUTHORITY.state
  ) fail("live_review_authority_mismatch", "R21 contract/state mismatch");

  const packageDigest = fingerprint(r21BundleCore(bundle));
  if (
    handoff.packageDigest !== packageDigest ||
    evidence.packageDigest !== packageDigest ||
    bundle.transportHandoff?.packageDigest !== packageDigest ||
    !exactJson(bundle.transportHandoff, handoff)
  ) fail("live_review_package_drift", "R21 package/handoff digest mismatch");

  const sealedDigest = fingerprint(sealed.entries);
  if (
    sealed.digest !== sealedDigest ||
    bundle.sealedMapping?.digest !== sealedDigest ||
    handoff.sealedMappingDigest !== sealedDigest ||
    evidence.sealedMappingDigest !== sealedDigest ||
    !exactJson(bundle.sealedMapping, sealed)
  ) fail("live_review_mapping_drift", "R21 sealed mapping mismatch");

  if (
    typeof promptJson.text !== "string" ||
    promptJson.text !== bundle.prompt.text ||
    promptJson.text !== handoff.promptText ||
    promptJson.digest !== hashText(promptJson.text) ||
    promptJson.digest !== bundle.prompt.digest ||
    promptJson.digest !== handoff.promptDigest ||
    promptJson.digest !== evidence.promptDigest ||
    promptJson.bytes !== Buffer.byteLength(promptJson.text, "utf8") ||
    handoff.promptBytes !== promptJson.bytes
  ) fail("live_review_prompt_drift", "R21 prompt bytes/digest mismatch");

  const promptLower = promptJson.text.toLowerCase();
  for (const secret of forbiddenPromptSecrets(bundle)) {
    if (secret.length < 8) {
      if (["baseline", "challenger", "winner", "parent", "child"].includes(secret) && promptLower.includes(secret)) {
        fail("live_review_blinding_failed", `model-facing prompt leaks role: ${secret}`);
      }
    } else if (promptJson.text.includes(secret)) {
      fail("live_review_blinding_failed", "model-facing prompt leaks sealed identity");
    }
  }

  const sourceFileHashes = {};
  for (const [key, filePath] of Object.entries(files)) sourceFileHashes[key] = hashFile(filePath);
  if (sourceFileHashes.bundle.sha256 !== evidence.bundleFileSha256) fail("live_review_package_drift", "R21 bundle file hash mismatch");
  if (sourceFileHashes.handoff.sha256 !== evidence.transportHandoffFileSha256) fail("live_review_package_drift", "R21 handoff file hash mismatch");
  if (sourceFileHashes.sealed.sha256 !== evidence.sealedMappingFileSha256) fail("live_review_mapping_drift", "R21 sealed file hash mismatch");
  if (sourceFileHashes.promptJson.sha256 !== evidence.promptFileSha256) fail("live_review_prompt_drift", "R21 prompt file hash mismatch");

  const attachmentByLabel = new Map(bundle.attachments.map((entry) => [entry.blindLabel, entry]));
  const attachmentRecords = [];
  for (const [label, key] of [["A", "attachmentA"], ["B", "attachmentB"]]) {
    const expected = attachmentByLabel.get(label);
    if (!expected) fail("live_review_attachment_drift", `missing R21 attachment label ${label}`);
    if (expected.path !== `review-${label}.mp4` || expected.mimeType !== "video/mp4") {
      fail("live_review_blinding_failed", "R21 attachment name/MIME is not blind canonical MP4");
    }
    const actual = sourceFileHashes[key];
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size || actual.size > 500_000_000) {
      fail("live_review_attachment_drift", `R21 attachment ${label} bytes differ`);
    }
    const mapped = sealed.entries.find((entry) => entry.blindLabel === label);
    if (!mapped) fail("live_review_mapping_drift", `sealed mapping missing ${label}`);
    if (!expected.derivative_for_model_review && mapped.render?.sha256 !== actual.sha256) {
      fail("live_review_mapping_drift", `original attachment ${label} no longer matches mapped render`);
    }
    attachmentRecords.push({
      blindLabel: label,
      name: expected.path,
      sha256: actual.sha256,
      size: actual.size,
      mime: "video/mp4",
      derivative_for_model_review: expected.derivative_for_model_review
    });
  }
  if (attachmentRecords[0].sha256 === attachmentRecords[1].sha256) {
    fail("live_review_duplicate_render", "R21 pair contains byte-identical review attachments");
  }

  if (bundle.mode === "targeted_reedit") {
    const lineage = bundle.roundLineage;
    const child = sealed.entries.find((entry) => entry.candidateId === lineage?.childReviewCandidateId);
    const parent = sealed.entries.find((entry) => entry.candidateId === lineage?.baselineReviewCandidateId);
    if (!lineage || !child || !parent) {
      fail("live_review_lineage_mismatch", "round-1 R19 lineage missing");
    }
    if (
      lineage.parentRenderSha256 !== parent.render.sha256 ||
      lineage.childRenderSha256 !== child.render.sha256 ||
      lineage.mediaApplicationDigest !== child.mediaApplicationDigest ||
      lineage.growthHandoffDigest !== child.growthHandoffDigest ||
      lineage.applicationParentCandidateId !== child.applicationParentCandidateId ||
      lineage.baselineReviewCandidateId !== child.baselineReviewCandidateId ||
      child.parentRenderSha256 !== parent.render.sha256 ||
      child.roundNumber !== lineage.childRound ||
      parent.roundNumber !== lineage.parentRound ||
      bundle.reviewRound !== child.roundNumber ||
      typeof lineage.mediaApplicationFileSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(lineage.mediaApplicationFileSha256)
    ) fail("live_review_lineage_mismatch", "stale R15/R19 parent-child evidence detected");
  }

  if (
    bundle.modelReviewPerformed !== false ||
    bundle.liveModelReviewed !== false ||
    bundle.providerPublish !== false ||
    bundle.humanQuality !== false
  ) fail("live_review_evidence_boundary", "R21 source claims forbidden live/human state");

  return {
    root,
    bundle,
    handoff,
    sealed,
    promptJson,
    evidence,
    packageDigest,
    sealedMappingDigest: sealedDigest,
    promptDigest: promptJson.digest,
    promptBytes: Buffer.byteLength(promptJson.text, "utf8"),
    sourceFileHashes,
    attachments: attachmentRecords
  };
}

function octal(value, width) {
  const text = Math.trunc(value).toString(8);
  if (text.length > width - 1) fail("live_review_archive_invalid", "tar numeric field overflow");
  return `${"0".repeat(width - 1 - text.length)}${text}\0`;
}
function tarHeader(name, size) {
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length > 100) fail("live_review_archive_invalid", `tar path too long: ${name}`);
  const h = Buffer.alloc(512, 0);
  nameBytes.copy(h, 0);
  Buffer.from(octal(0o644, 8), "ascii").copy(h, 100);
  Buffer.from(octal(0, 8), "ascii").copy(h, 108);
  Buffer.from(octal(0, 8), "ascii").copy(h, 116);
  Buffer.from(octal(size, 12), "ascii").copy(h, 124);
  Buffer.from(octal(0, 12), "ascii").copy(h, 136);
  h.fill(0x20, 148, 156);
  h[156] = "0".charCodeAt(0);
  Buffer.from("ustar\0", "ascii").copy(h, 257);
  Buffer.from("00", "ascii").copy(h, 263);
  const checksum = [...h].reduce((sum, byte) => sum + byte, 0);
  const checkText = `${"0".repeat(6 - checksum.toString(8).length)}${checksum.toString(8)}\0 `;
  Buffer.from(checkText, "ascii").copy(h, 148);
  return h;
}
export function createDeterministicTar(payloadRoot, relativeFiles, archivePath) {
  const names = [...new Set(relativeFiles)].sort();
  const parts = [];
  for (const name of names) {
    const item = safeChild(payloadRoot, name, "archive entry");
    const bytes = readFileSync(item.absolute);
    parts.push(tarHeader(item.relative, bytes.length), bytes);
    const pad = (512 - (bytes.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  const archive = Buffer.concat(parts);
  const identity = writeStable(archivePath, archive);
  return { ...identity, entries: names };
}

export function readDeterministicTar(archivePath) {
  const archive = readFileSync(archivePath);
  const entries = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;
    const storedChecksum = Number.parseInt(header.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = [...checksumHeader].reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) fail("live_review_archive_invalid", "tar header checksum mismatch");
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name || path.isAbsolute(name) || name.split("/").includes("..")) fail("live_review_archive_invalid", "tar path escape");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > archive.length) {
      fail("live_review_archive_invalid", "tar entry size invalid");
    }
    if (entries.has(name)) fail("live_review_archive_invalid", "duplicate tar entry");
    entries.set(name, Buffer.from(archive.subarray(offset, offset + size)));
    offset += size;
    offset += (512 - (size % 512)) % 512;
  }
  if (zeroBlocks < 2) fail("live_review_archive_invalid", "tar missing terminal zero blocks");
  return { sha256: hashBytes(archive), size: archive.length, entries };
}

function payloadFileRecord(payloadRoot, relativePath) {
  const item = safeChild(payloadRoot, relativePath, "payload file");
  const actual = hashFile(item.absolute);
  return {
    path: item.relative,
    sha256: actual.sha256,
    size: actual.size,
    mime: mimeFor(item.relative)
  };
}
function allFiles(root) {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const st = statSync(absolute);
      if (st.isDirectory()) walk(absolute);
      else if (st.isFile()) out.push(path.relative(root, absolute).split(path.sep).join("/"));
      else fail("live_review_path_escape", "non-regular payload entry");
    }
  }
  walk(root);
  return out;
}

export function materializeLiveReviewArtifact({
  r21RoundDir,
  outputDir,
  materializerProducerSha,
  materializerCiRunId = null,
  materializerBlobs = {}
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(String(materializerProducerSha ?? ""))) {
    fail("live_review_invalid", "materializerProducerSha must be exact Git SHA");
  }
  const verified = verifyExactR21RoundDirectory(r21RoundDir);
  const out = path.resolve(outputDir);
  const payloadRoot = path.join(out, "payload");
  mkdirSync(payloadRoot, { recursive: true });

  for (const name of Object.values(R22_REQUIRED_R21_FILES)) {
    const source = safeChild(verified.root, name, "R21 source file");
    const target = path.join(payloadRoot, name);
    if (existsSync(target)) {
      const current = hashFile(target);
      const expected = hashFile(source.absolute);
      if (current.sha256 !== expected.sha256 || current.size !== expected.size) {
        fail("live_review_replay_conflict", `existing materialized R21 file differs: ${name}`);
      }
    } else {
      copyFileSync(source.absolute, target);
    }
  }
  writeStable(path.join(payloadRoot, PROMPT_RAW_FILE), verified.promptJson.text);

  const authorityProfile = {
    contractVersion: MEDIA_LIVE_REVIEW_AUTHORITY_PROFILE_VERSION,
    state: LIVE_REVIEW_ARTIFACT_READY,
    sourceMediaR21: clone(R22_R21_AUTHORITY),
    materializerR22: {
      repository: "foto6/video2",
      producerSha: materializerProducerSha,
      ciRunId: Number.isInteger(materializerCiRunId) ? materializerCiRunId : null,
      blobs: clone(materializerBlobs)
    },
    bridgeR31: clone(R22_BRIDGE_R31_AUTHORITY),
    contracts: {
      bundle: MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
      handoff: MEDIA_REVIEW_ROUND_HANDOFF_VERSION,
      packageManifest: MEDIA_LIVE_REVIEW_PACKAGE_MANIFEST_VERSION,
      operatorManifest: MEDIA_LIVE_REVIEW_OPERATOR_MANIFEST_VERSION
    },
    evidenceBoundary: {
      modelReviewPerformed: false,
      liveModelReviewed: false,
      browserMutationPerformed: false,
      providerPublish: false,
      humanQuality: false
    }
  };
  writeStable(path.join(payloadRoot, AUTHORITY_FILE), authorityProfile);

  const payloadBeforeManifest = allFiles(payloadRoot).filter((name) => name !== PACKAGE_MANIFEST_FILE);
  const packageManifest = {
    contractVersion: MEDIA_LIVE_REVIEW_PACKAGE_MANIFEST_VERSION,
    state: LIVE_REVIEW_ARTIFACT_READY,
    sourceMediaR21: {
      producerSha: R22_R21_AUTHORITY.producerSha,
      ciRunId: R22_R21_AUTHORITY.ciRunId,
      packageDigest: verified.packageDigest,
      sealedMappingDigest: verified.sealedMappingDigest,
      promptDigest: verified.promptDigest,
      mode: verified.bundle.mode,
      reviewRound: verified.bundle.reviewRound
    },
    files: payloadBeforeManifest.map((name) => payloadFileRecord(payloadRoot, name)),
    fileSetDigest: fingerprint(payloadBeforeManifest.map((name) => payloadFileRecord(payloadRoot, name))),
    manifestSelfHashRecordedExternally: true,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
  const manifestIdentity = writeStable(path.join(payloadRoot, PACKAGE_MANIFEST_FILE), packageManifest);

  const payloadFiles = allFiles(payloadRoot);
  const archivePath = path.join(out, ARCHIVE_FILE);
  const archive = createDeterministicTar(payloadRoot, payloadFiles, archivePath);

  const operatorManifest = {
    contractVersion: MEDIA_LIVE_REVIEW_OPERATOR_MANIFEST_VERSION,
    state: LIVE_REVIEW_ARTIFACT_READY,
    sourceState: ROUND_PAIR_PACKAGE_READY,
    bridgeR31Authority: clone(R22_BRIDGE_R31_AUTHORITY),
    bridgeR31Inputs: {
      artifactDirRelative: "payload",
      archiveRelative: ARCHIVE_FILE,
      expectedArchiveSha256: archive.sha256,
      requiredMediaProducerSha: R22_R21_AUTHORITY.producerSha,
      requiredMediaCiRunId: R22_R21_AUTHORITY.ciRunId
    },
    package: {
      packageManifestRelative: `payload/${PACKAGE_MANIFEST_FILE}`,
      packageManifestSha256: manifestIdentity.sha256,
      archiveSha256: archive.sha256,
      archiveSize: archive.size,
      r21PackageDigest: verified.packageDigest,
      sealedMappingDigest: verified.sealedMappingDigest,
      promptDigest: verified.promptDigest
    },
    prompt: {
      rawRelativePath: `payload/${PROMPT_RAW_FILE}`,
      r21JsonRelativePath: `payload/${R22_REQUIRED_R21_FILES.promptJson}`,
      sha256: verified.promptDigest,
      bytes: verified.promptBytes
    },
    attachments: verified.attachments.map((entry) => ({
      blindLabel: entry.blindLabel,
      relativePath: `payload/${entry.name}`,
      name: entry.name,
      sha256: entry.sha256,
      size: entry.size,
      mime: entry.mime
    })),
    sealedMapping: {
      machineSideRelativePath: `payload/${R22_REQUIRED_R21_FILES.sealed}`,
      digest: verified.sealedMappingDigest,
      contentsModelFacing: false
    },
    sourceLineage: {
      source: clone(verified.bundle.source),
      briefLineageDigest: verified.bundle.briefLineageDigest,
      mode: verified.bundle.mode,
      reviewRound: verified.bundle.reviewRound,
      roundLineage: clone(verified.bundle.roundLineage)
    },
    invocation: {
      bridgeR31PrepareScript: "app/r31-prepare-media-r21.js",
      argsRelativeToOperatorDir: [
        "--artifact-dir", "payload",
        "--archive", ARCHIVE_FILE,
        "--expected-archive-sha256", archive.sha256,
        "--out-dir", "r31-source"
      ]
    },
    modelReviewPerformed: false,
    liveModelReviewed: false,
    browserMutationPerformed: false,
    providerPublish: false,
    humanQuality: false
  };
  const operatorIdentity = writeStable(path.join(out, OPERATOR_MANIFEST_FILE), operatorManifest);

  const verification = verifyMaterializedLiveReviewArtifact(out);
  if (!verification.ok) fail("live_review_verification_failed", "materialized R22 artifact failed self-verification", verification.errors);

  return {
    operatorDir: out,
    payloadRoot,
    archivePath,
    archiveSha256: archive.sha256,
    archiveSize: archive.size,
    packageManifestSha256: manifestIdentity.sha256,
    operatorManifestSha256: operatorIdentity.sha256,
    packageDigest: verified.packageDigest,
    sealedMappingDigest: verified.sealedMappingDigest,
    promptDigest: verified.promptDigest,
    attachments: verified.attachments,
    mode: verified.bundle.mode,
    reviewRound: verified.bundle.reviewRound,
    verification
  };
}

export function verifyMaterializedLiveReviewArtifact(operatorDir) {
  const errors = [];
  const root = path.resolve(operatorDir);
  try {
    const operatorPath = safeChild(root, OPERATOR_MANIFEST_FILE, "operator manifest");
    if (!existsSync(operatorPath.absolute)) return { ok: false, errors: ["operator_manifest_missing"] };
    const operator = readJson(operatorPath.absolute);
    if (
      operator.contractVersion !== MEDIA_LIVE_REVIEW_OPERATOR_MANIFEST_VERSION ||
      operator.state !== LIVE_REVIEW_ARTIFACT_READY ||
      operator.sourceState !== ROUND_PAIR_PACKAGE_READY
    ) errors.push("operator_manifest_contract_or_state_mismatch");
    if (!exactJson(operator.bridgeR31Authority, R22_BRIDGE_R31_AUTHORITY)) errors.push("bridge_r31_authority_mismatch");

    const payloadRoot = safeChild(root, operator.bridgeR31Inputs?.artifactDirRelative, "artifactDir").absolute;
    const archivePath = safeChild(root, operator.bridgeR31Inputs?.archiveRelative, "archive").absolute;
    const packageManifestPath = safeChild(root, operator.package?.packageManifestRelative, "package manifest").absolute;
    const archiveIdentity = hashFile(archivePath);
    if (
      archiveIdentity.sha256 !== operator.bridgeR31Inputs.expectedArchiveSha256 ||
      archiveIdentity.sha256 !== operator.package.archiveSha256 ||
      archiveIdentity.size !== operator.package.archiveSize
    ) errors.push("archive_identity_mismatch");

    const packageManifestIdentity = hashFile(packageManifestPath);
    if (packageManifestIdentity.sha256 !== operator.package.packageManifestSha256) {
      errors.push("package_manifest_sha256_mismatch");
    }
    const packageManifest = readJson(packageManifestPath);
    if (
      packageManifest.contractVersion !== MEDIA_LIVE_REVIEW_PACKAGE_MANIFEST_VERSION ||
      packageManifest.state !== LIVE_REVIEW_ARTIFACT_READY
    ) errors.push("package_manifest_contract_or_state_mismatch");

    const listed = packageManifest.files ?? [];
    const listedPaths = new Set();
    for (const record of listed) {
      if (listedPaths.has(record.path)) errors.push("duplicate_package_manifest_path");
      listedPaths.add(record.path);
      const item = safeChild(payloadRoot, record.path, "manifest file");
      if (!existsSync(item.absolute) || !statSync(item.absolute).isFile()) {
        errors.push(`missing_payload_file:${record.path}`);
        continue;
      }
      const actual = hashFile(item.absolute);
      if (actual.sha256 !== record.sha256 || actual.size !== record.size || mimeFor(record.path) !== record.mime) {
        errors.push(`payload_identity_mismatch:${record.path}`);
      }
    }
    if (fingerprint(listed) !== packageManifest.fileSetDigest) errors.push("package_file_set_digest_mismatch");

    const actualPayloadFiles = allFiles(payloadRoot);
    const expectedPayloadFiles = [...listedPaths, PACKAGE_MANIFEST_FILE].sort();
    if (stableStringify(actualPayloadFiles) !== stableStringify(expectedPayloadFiles)) {
      errors.push("payload_file_set_mismatch");
    }

    const sourceVerified = verifyExactR21RoundDirectory(payloadRoot);
    if (
      sourceVerified.packageDigest !== operator.package.r21PackageDigest ||
      sourceVerified.sealedMappingDigest !== operator.package.sealedMappingDigest ||
      sourceVerified.promptDigest !== operator.package.promptDigest
    ) errors.push("operator_to_r21_digest_mismatch");

    const rawPromptPath = safeChild(root, operator.prompt.rawRelativePath, "raw prompt");
    const rawPrompt = readFileSync(rawPromptPath.absolute);
    if (
      hashBytes(rawPrompt) !== operator.prompt.sha256 ||
      rawPrompt.length !== operator.prompt.bytes ||
      rawPrompt.toString("utf8") !== sourceVerified.promptJson.text
    ) errors.push("raw_prompt_bytes_mismatch");

    const tar = readDeterministicTar(archivePath);
    const archiveEntries = [...tar.entries.keys()].sort();
    if (stableStringify(archiveEntries) !== stableStringify(actualPayloadFiles)) {
      errors.push("archive_entry_set_mismatch");
    }
    for (const name of actualPayloadFiles) {
      const archived = tar.entries.get(name);
      const disk = readFileSync(path.join(payloadRoot, name));
      if (!archived || !archived.equals(disk)) {
        errors.push(`archive_payload_mismatch:${name}`);
      }
    }

    const promptText = sourceVerified.promptJson.text;
    if (promptText.includes(sourceVerified.sealedMappingDigest)) errors.push("sealed_mapping_leaked_to_prompt");
    for (const secret of forbiddenPromptSecrets(sourceVerified.bundle)) {
      if (secret.length >= 8 && promptText.includes(secret)) errors.push("sealed_identity_leaked_to_prompt");
    }

    if (
      operator.modelReviewPerformed !== false ||
      operator.liveModelReviewed !== false ||
      operator.browserMutationPerformed !== false ||
      operator.providerPublish !== false ||
      operator.humanQuality !== false
    ) errors.push("operator_evidence_boundary_violation");

    return {
      ok: errors.length === 0,
      errors,
      operatorDir: root,
      archive: archiveIdentity,
      packageManifest: packageManifestIdentity,
      operatorManifest: hashFile(operatorPath.absolute),
      mode: sourceVerified.bundle.mode,
      reviewRound: sourceVerified.bundle.reviewRound,
      packageDigest: sourceVerified.packageDigest,
      sealedMappingDigest: sourceVerified.sealedMappingDigest,
      promptDigest: sourceVerified.promptDigest,
      attachments: sourceVerified.attachments,
      fileCount: actualPayloadFiles.length
    };
  } catch (error) {
    return { ok: false, errors: [String(error?.message ?? error)] };
  }
}

export function extractAndVerifyLiveReviewArchive({
  operatorDir,
  destinationDir
} = {}) {
  const preflight = verifyMaterializedLiveReviewArtifact(operatorDir);
  if (!preflight.ok) fail("live_review_verification_failed", "operator directory failed before extraction", preflight.errors);
  const operator = readJson(path.join(operatorDir, OPERATOR_MANIFEST_FILE));
  const archivePath = path.join(operatorDir, operator.bridgeR31Inputs.archiveRelative);
  const tar = readDeterministicTar(archivePath);
  const destination = path.resolve(destinationDir);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const [name, bytes] of tar.entries) {
    const target = safeChild(destination, name, "extraction entry");
    mkdirSync(path.dirname(target.absolute), { recursive: true });
    writeFileSync(target.absolute, bytes);
  }
  const extractedFiles = allFiles(destination);
  const sourceFiles = allFiles(path.join(operatorDir, operator.bridgeR31Inputs.artifactDirRelative));
  if (stableStringify(extractedFiles) !== stableStringify(sourceFiles)) {
    fail("live_review_archive_invalid", "extracted file set differs from verified payload");
  }
  for (const name of sourceFiles) {
    const a = hashFile(path.join(destination, name));
    const b = hashFile(path.join(operatorDir, operator.bridgeR31Inputs.artifactDirRelative, name));
    if (a.sha256 !== b.sha256 || a.size !== b.size) {
      fail("live_review_archive_invalid", `extracted file differs: ${name}`);
    }
  }
  return {
    ok: true,
    destination,
    archiveSha256: tar.sha256,
    extractedFiles
  };
}
