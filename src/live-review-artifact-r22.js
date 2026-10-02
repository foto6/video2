import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
  MEDIA_REVIEW_ROUND_HANDOFF_VERSION,
  ROUND_PAIR_PACKAGE_READY,
  validateReviewRoundBundle
} from "./review-round-r21.js";
import {
  renderExportDigest,
  validateRenderExportAgainstFinal
} from "./render-export-r15.js";
import {
  validateEditorialReeditApplicationSidecar
} from "./editorial-reedit-r19.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_LIVE_REVIEW_ARTIFACT_VERSION = "media.live_review_artifact.r22.v1";
export const MEDIA_LIVE_REVIEW_AUTHORITY_PROFILE_VERSION = "media.live_review_authority_profile.r22.v1";
export const MEDIA_LIVE_REVIEW_PACKAGE_MANIFEST_VERSION = "media.live_review_package_manifest.r22.v1";
export const MEDIA_LIVE_REVIEW_ARCHIVE_INDEX_VERSION = "media.live_review_archive_index.r22.v1";
export const MEDIA_BRIDGE_DYNAMIC_HANDOFF_VERSION = "media.dynamic_review_handoff.v1";
export const LIVE_REVIEW_ARTIFACT_READY = "LIVE_REVIEW_ARTIFACT_READY";

export const R22_R21_AUTHORITY = Object.freeze({
  repository: "foto6/video2",
  branch: "agent/media-r21-round-pair-review-bundle-20261002",
  producerSha: "d753e9e4c1f4448386608a1425232dbc1dba87ea",
  ciRunId: 36994000619,
  contractVersion: MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
  contract: {
    path: "conformance/media.review_round_bundle.r21.v1/contract.json",
    gitBlobSha: "65358261775f0fcd2ab9e21f3f621aee977f29da"
  },
  schema: {
    path: "conformance/media.review_round_bundle.r21.v1/schema.json",
    gitBlobSha: "f04925e317d849434852e6b706533f909da47b22"
  },
  implementation: {
    path: "src/review-round-r21.js",
    gitBlobSha: "c6f556b8a177b6182d787356625094cdcad5a58e"
  }
});

export const R22_BRIDGE_R31_AUTHORITY = Object.freeze({
  repository: "foto6/WebAIBridge",
  branch: "agent/bridge-r31-live-dynamic-operator-20261002",
  branchHeadSha: "ceaee873231a8552c5b7324083baa800eec566a8",
  inheritedGreenBranch: "agent/bridge-r30-dynamic-review-transport-20261002",
  inheritedGreenCiRunId: 36993885456,
  handoffContract: MEDIA_BRIDGE_DYNAMIC_HANDOFF_VERSION,
  captureContract: "bridge.dynamic_existing_chat_video_review_capture.v1",
  resultContract: "bridge.r30_dynamic_review_transport_result.v1",
  packageDigestAlgorithm: "bridge.dynamic_review_package.sha256.v1",
  maxFileBytes: 500_000_000,
  r31WireFormatDivergedFromR30: false,
  implementationBlobSha: "c5bd2f95a6d58a86cddd9a6fdc127e68e3346c20",
  verifierBlobSha: "343ee5cb41a443932a0a944eac2957dd36836dec",
  handoffSchemaBlobSha: "93968dc1fb65a334493acdb587b20753f0a8494a",
  documentationBlobSha: "b2108090701d8df261bdfa37cd9c63ec4d3cdec1",
  modelCallPerformed: false
});

const REQUIRED_BUNDLE_FILENAMES = Object.freeze([
  "review-A.mp4",
  "review-B.mp4",
  "model-review-prompt.txt",
  "media.review_round_bundle.r21.v1.json",
  "media.review_round_transport_handoff.r21.v1.json",
  "media.review_round_sealed_mapping.r21.v1.json",
  "media.live_review_authority_profile.r22.v1.json",
  "media.dynamic_review_handoff.v1.json",
  "media.live_review_package_manifest.r22.v1.json"
]);

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("live_review_artifact_invalid", `${label} must be lowercase SHA-256 hex`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("live_review_artifact_invalid", `${label} must be exact Git SHA`);
  }
}
function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail("live_review_artifact_invalid", `${label} must be positive integer`);
  }
}
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashText(text) {
  return hashBytes(Buffer.from(String(text), "utf8"));
}
function hashFile(filePath) {
  if (!existsSync(filePath)) fail("live_review_artifact_missing_file", `missing file: ${filePath}`);
  const bytes = readFileSync(filePath);
  return { sha256: hashBytes(bytes), size: bytes.length };
}
function mimeFor(fileName) {
  if (fileName.endsWith(".mp4")) return "video/mp4";
  if (fileName.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (fileName.endsWith(".json")) return "application/json";
  if (fileName.endsWith(".tar")) return "application/x-tar";
  return "application/octet-stream";
}
function safePath(root, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath) {
    fail("live_review_artifact_invalid", `${label} path required`);
  }
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    fail("live_review_artifact_path_escape", `${label} path must be relative`);
  }
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("live_review_artifact_path_escape", `${label} escapes sandbox root`);
  }
  return { absolute: resolved, relative: rel.split(path.sep).join("/") };
}
function exactFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}
function writeStable(filePath, value) {
  const content = `${stableStringify(value)}\n`;
  writeFileSync(filePath, content);
  return { sha256: hashBytes(Buffer.from(content, "utf8")), size: Buffer.byteLength(content) };
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeBridgeDynamicPackageDigest(handoff, actual = {}) {
  const stable = {
    contract: MEDIA_BRIDGE_DYNAMIC_HANDOFF_VERSION,
    producer: {
      repository: handoff.producer.repository,
      sha: handoff.producer.sha,
      round: handoff.producer.round,
      contract: {
        name: handoff.producer.contract.name,
        schemaVersion: handoff.producer.contract.schemaVersion,
        blobSha256: actual.contractBlobSha256 ?? handoff.producer.contract.blob.sha256
      }
    },
    prompt: {
      fileSha256: actual.promptFileSha256 ?? handoff.prompt.fileSha256,
      textSha256: actual.promptTextSha256 ?? handoff.prompt.textSha256,
      format: handoff.prompt.format
    },
    attachments: (actual.attachments ?? handoff.attachments)
      .map((entry) => ({
        blindLabel: entry.blindLabel,
        blindedName: entry.blindedName,
        size: entry.size,
        sha256: entry.sha256,
        mime: entry.mime ?? "video/mp4"
      }))
      .sort((a, b) => a.blindLabel.localeCompare(b.blindLabel)),
    sealedMappingDigest: handoff.sealedMapping.digest,
    sourceLineage: handoff.sourceLineage
  };
  return hashBytes(Buffer.from(canonicalJson(stable), "utf8"));
}

function verifySourceLineageEntry(entry, sandboxRoot) {
  const sourcePath = safePath(sandboxRoot, entry.source.artifactPath, "sealed source");
  const renderPath = safePath(sandboxRoot, entry.render.artifactPath, "sealed render");
  const renderExportPath = safePath(sandboxRoot, entry.renderExport.artifactPath, "sealed render export");

  const sourceBytes = hashFile(sourcePath.absolute);
  if (sourceBytes.sha256 !== entry.source.sha256 || sourceBytes.size !== entry.source.size) {
    fail("live_review_artifact_stale_source", "sealed source bytes drifted");
  }
  const renderBytes = hashFile(renderPath.absolute);
  if (renderBytes.sha256 !== entry.render.sha256 || renderBytes.size !== entry.render.size) {
    fail("live_review_artifact_stale_render", "sealed render bytes drifted");
  }
  const renderExportBytes = hashFile(renderExportPath.absolute);
  if (renderExportBytes.sha256 !== entry.renderExport.fileSha256) {
    fail("live_review_artifact_stale_render_export", "sealed R15 render-export file drifted");
  }
  const renderExport = validateRenderExportAgainstFinal(
    JSON.parse(readFileSync(renderExportPath.absolute, "utf8")),
    renderPath.absolute
  );
  if (
    renderExportDigest(renderExport) !== entry.renderExport.digest ||
    renderExport.producer.sha !== entry.renderProducerSha ||
    renderExport.artifact.sha256 !== entry.render.sha256 ||
    renderExport.artifact.size !== entry.render.size
  ) {
    fail("live_review_artifact_stale_render_export", "sealed R15 render-export semantic lineage drifted");
  }

  let editorialApplication = null;
  if (entry.editorialApplication !== null) {
    const applicationPath = safePath(
      sandboxRoot,
      entry.editorialApplication.artifactPath,
      "sealed editorial application"
    );
    const applicationBytes = hashFile(applicationPath.absolute);
    if (applicationBytes.sha256 !== entry.editorialApplication.fileSha256) {
      fail("live_review_artifact_stale_editorial_application", "sealed R19 application file drifted");
    }
    editorialApplication = validateEditorialReeditApplicationSidecar(
      JSON.parse(readFileSync(applicationPath.absolute, "utf8"))
    );
    if (
      fingerprint(editorialApplication) !== entry.editorialApplication.digest ||
      editorialApplication.output.sha256 !== entry.render.sha256 ||
      editorialApplication.output.size !== entry.render.size ||
      editorialApplication.output.renderExportSha256 !== entry.renderExport.fileSha256
    ) {
      fail("live_review_artifact_stale_editorial_application", "sealed R19 application semantic lineage drifted");
    }
  }
  return {
    entry,
    sourcePath,
    renderPath,
    renderExportPath,
    sourceBytes,
    renderBytes,
    renderExportBytes,
    renderExport,
    editorialApplication
  };
}

function validateRoundBundleForExport(bundleInput, sandboxRoot) {
  const bundle = validateReviewRoundBundle(bundleInput);
  if (bundle.state !== ROUND_PAIR_PACKAGE_READY) {
    fail("live_review_artifact_invalid", "R21 bundle is not ROUND_PAIR_PACKAGE_READY");
  }
  if (
    bundle.modelReviewPerformed !== false ||
    bundle.liveModelReviewed !== false ||
    bundle.providerPublish !== false ||
    bundle.humanQuality !== false
  ) {
    fail("live_review_artifact_boundary_violation", "R21 evidence boundary invalid");
  }
  if (!Array.isArray(bundle.sealedMapping?.entries) || bundle.sealedMapping.entries.length !== 2) {
    fail("live_review_artifact_invalid", "R21 sealed mapping requires two entries");
  }
  if (fingerprint(bundle.sealedMapping.entries) !== bundle.sealedMapping.digest) {
    fail("live_review_artifact_mapping_drift", "R21 sealed mapping digest mismatch");
  }

  const verified = bundle.sealedMapping.entries.map((entry) =>
    verifySourceLineageEntry(entry, sandboxRoot)
  );
  const renderHashes = new Set(verified.map((row) => row.entry.render.sha256));
  if (renderHashes.size !== 2) {
    fail("live_review_artifact_duplicate_render", "byte-identical review candidates are forbidden");
  }
  const sourceKeys = new Set(verified.map((row) =>
    stableStringify({
      sourceId: row.entry.source.sourceId,
      sha256: row.entry.source.sha256,
      size: row.entry.source.size,
      briefLineageDigest: row.entry.briefLineageDigest
    })
  ));
  if (sourceKeys.size !== 1) {
    fail("live_review_artifact_unrelated_lineage", "review pair source/brief lineage differs");
  }

  const mapping = new Map(verified.map((row) => [row.entry.blindLabel, row]));
  for (const attachment of bundle.attachments) {
    const row = mapping.get(attachment.blindLabel);
    if (!row) fail("live_review_artifact_mapping_drift", "attachment label missing from sealed mapping");
    if (
      attachment.derivative_for_model_review === false &&
      (attachment.sha256 !== row.entry.render.sha256 || attachment.size !== row.entry.render.size)
    ) {
      fail("live_review_artifact_mapping_drift", "original attachment does not equal sealed render identity");
    }
  }

  if (bundle.mode === "targeted_reedit") {
    const child = verified.find((row) => row.entry.roundNumber === bundle.reviewRound);
    if (!child?.editorialApplication) {
      fail("live_review_artifact_stale_editorial_application", "targeted challenger lacks validated R19 application");
    }
    if (
      child.editorialApplication.handoff.digest !== bundle.roundLineage.growthHandoffDigest ||
      fingerprint(child.editorialApplication) !== bundle.roundLineage.mediaApplicationDigest ||
      child.editorialApplication.output.sha256 !== bundle.roundLineage.childRenderSha256 ||
      child.editorialApplication.input.renderSha256 !== bundle.roundLineage.parentRenderSha256
    ) {
      fail("live_review_artifact_lineage_drift", "R21 round lineage differs from validated R19 application");
    }
  }

  const prompt = bundle.prompt.text;
  const lowerPrompt = prompt.toLowerCase();
  for (const word of ["baseline", "challenger", "winner", "parent", "child"]) {
    if (lowerPrompt.includes(word)) {
      fail("live_review_artifact_blinding_failed", `model prompt leaks role: ${word}`);
    }
  }
  for (const row of verified) {
    const secrets = [
      row.entry.candidateId,
      row.entry.source.sourceId,
      row.entry.source.sha256,
      row.entry.render.sha256,
      row.entry.renderExport.digest,
      row.entry.renderExport.fileSha256,
      row.entry.renderProducerSha,
      row.entry.editorialApplication?.digest,
      row.entry.editorialApplication?.fileSha256,
      row.entry.editorialApplication?.handoffDigest
    ].filter(Boolean);
    for (const secret of secrets) {
      if (prompt.includes(secret)) {
        fail("live_review_artifact_blinding_failed", "model prompt leaks sealed lineage");
      }
    }
  }

  return { bundle, verified };
}

function gitBlobIdentity(repoRoot, ref, relativePath) {
  const gitBlobSha = execFileSync("git", ["rev-parse", `${ref}:${relativePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  }).trim();
  const bytes = execFileSync("git", ["show", `${ref}:${relativePath}`], {
    cwd: repoRoot,
    encoding: null,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    path: relativePath,
    gitBlobSha,
    sha256: hashBytes(bytes),
    size: bytes.length
  };
}

function authorityProfile({ producerSha, ciRunId, repoRoot }) {
  gitSha(producerSha, "producerSha");
  if (!Number.isInteger(ciRunId) || ciRunId <= 0) {
    fail("live_review_artifact_invalid", "ciRunId must be positive integer");
  }
  return {
    contractVersion: MEDIA_LIVE_REVIEW_AUTHORITY_PROFILE_VERSION,
    artifactProducer: {
      repository: "foto6/video2",
      branch: "agent/media-r22-live-review-artifact-20261002",
      sha: producerSha,
      ciRunId
    },
    r21Authority: {
      ...clone(R22_R21_AUTHORITY),
      contractIdentity: gitBlobIdentity(repoRoot, R22_R21_AUTHORITY.producerSha, R22_R21_AUTHORITY.contract.path),
      schemaIdentity: gitBlobIdentity(repoRoot, R22_R21_AUTHORITY.producerSha, R22_R21_AUTHORITY.schema.path),
      implementationIdentity: gitBlobIdentity(repoRoot, R22_R21_AUTHORITY.producerSha, R22_R21_AUTHORITY.implementation.path)
    },
    r22Authority: {
      contractVersion: MEDIA_LIVE_REVIEW_ARTIFACT_VERSION,
      contractIdentity: gitBlobIdentity(
        repoRoot,
        producerSha,
        "conformance/media.live_review_artifact.r22.v1/contract.json"
      ),
      schemaIdentity: gitBlobIdentity(
        repoRoot,
        producerSha,
        "conformance/media.live_review_artifact.r22.v1/schema.json"
      ),
      implementationIdentity: gitBlobIdentity(
        repoRoot,
        producerSha,
        "src/live-review-artifact-r22.js"
      ),
      exporterIdentity: gitBlobIdentity(
        repoRoot,
        producerSha,
        "tools/export-r22-live-review-artifact.mjs"
      ),
      verifierIdentity: gitBlobIdentity(
        repoRoot,
        producerSha,
        "tools/verify-r22-live-review-artifact.mjs"
      )
    },
    bridgeR31Authority: clone(R22_BRIDGE_R31_AUTHORITY),
    boundary: {
      modelCallPerformed: false,
      browserUploadPerformed: false,
      providerPublishPerformed: false,
      liveModelReviewed: false,
      humanQuality: false
    }
  };
}

function bridgeSourceLineage(bundle) {
  return {
    source: clone(bundle.source),
    briefLineageDigest: bundle.briefLineageDigest,
    mode: bundle.mode,
    reviewRound: bundle.reviewRound,
    r21PackageDigest: bundle.transportHandoff.packageDigest,
    r21SealedMappingDigest: bundle.sealedMapping.digest,
    r21RoundLineageDigest: bundle.transportHandoff.roundLineage.digest,
    roundLineage: clone(bundle.roundLineage)
  };
}

function buildBridgeOperatorHandoff({
  bundle,
  producerSha,
  bundleFileSha256,
  promptFileSha256
}) {
  const handoff = {
    contract: MEDIA_BRIDGE_DYNAMIC_HANDOFF_VERSION,
    producer: {
      repository: "foto6/video2",
      sha: producerSha,
      round: "R21",
      contract: {
        name: MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
        schemaVersion: "v1",
        blob: {
          relativePath: "media.review_round_bundle.r21.v1.json",
          sha256: bundleFileSha256
        }
      }
    },
    package: {
      digestAlgorithm: R22_BRIDGE_R31_AUTHORITY.packageDigestAlgorithm,
      digest: ""
    },
    prompt: {
      relativePath: "model-review-prompt.txt",
      fileSha256: promptFileSha256,
      textSha256: bundle.prompt.digest,
      format: "utf8_text"
    },
    attachments: bundle.attachments.map((attachment) => ({
      blindLabel: attachment.blindLabel,
      blindedName: attachment.path,
      relativePath: attachment.path,
      size: attachment.size,
      sha256: attachment.sha256,
      mime: attachment.mimeType
    })),
    sealedMapping: {
      digest: bundle.sealedMapping.digest,
      contract: "media.review_round_sealed_mapping.r21.v1"
    },
    sourceLineage: bridgeSourceLineage(bundle)
  };
  handoff.package.digest = computeBridgeDynamicPackageDigest(handoff);
  return handoff;
}

function validateBridgeOperatorHandoff(handoff, bundleRoot) {
  if (handoff.contract !== MEDIA_BRIDGE_DYNAMIC_HANDOFF_VERSION) {
    fail("live_review_artifact_bridge_invalid", "Bridge handoff contract mismatch");
  }
  if (handoff.producer.round !== "R21") {
    fail("live_review_artifact_bridge_invalid", "Bridge producer round must be R21");
  }
  const contractPath = safePath(bundleRoot, handoff.producer.contract.blob.relativePath, "Bridge contract blob");
  const promptPath = safePath(bundleRoot, handoff.prompt.relativePath, "Bridge prompt");
  const contractBytes = hashFile(contractPath.absolute);
  const promptBytes = hashFile(promptPath.absolute);
  if (contractBytes.sha256 !== handoff.producer.contract.blob.sha256) {
    fail("live_review_artifact_bridge_invalid", "Bridge contract blob hash mismatch");
  }
  if (
    promptBytes.sha256 !== handoff.prompt.fileSha256 ||
    hashText(readFileSync(promptPath.absolute, "utf8")) !== handoff.prompt.textSha256
  ) {
    fail("live_review_artifact_bridge_invalid", "Bridge prompt bytes/hash mismatch");
  }
  const actualAttachments = handoff.attachments.map((attachment) => {
    const file = safePath(bundleRoot, attachment.relativePath, "Bridge attachment");
    const bytes = hashFile(file.absolute);
    if (
      bytes.sha256 !== attachment.sha256 ||
      bytes.size !== attachment.size ||
      bytes.size > R22_BRIDGE_R31_AUTHORITY.maxFileBytes ||
      path.basename(file.absolute) !== attachment.blindedName ||
      attachment.mime !== "video/mp4"
    ) {
      fail("live_review_artifact_bridge_invalid", `Bridge attachment mismatch: ${attachment.blindLabel}`);
    }
    return { ...attachment, size: bytes.size, sha256: bytes.sha256 };
  });
  const digest = computeBridgeDynamicPackageDigest(handoff, {
    contractBlobSha256: contractBytes.sha256,
    promptFileSha256: promptBytes.sha256,
    promptTextSha256: handoff.prompt.textSha256,
    attachments: actualAttachments
  });
  if (digest !== handoff.package.digest) {
    fail("live_review_artifact_bridge_invalid", "Bridge package digest mismatch");
  }
  return { digest, attachments: actualAttachments };
}

function packageManifestPayload(bundleRoot, bundle) {
  const visibility = new Map([
    ["review-A.mp4", "model-facing"],
    ["review-B.mp4", "model-facing"],
    ["model-review-prompt.txt", "model-facing"]
  ]);
  const files = REQUIRED_BUNDLE_FILENAMES
    .filter((name) => name !== "media.live_review_package_manifest.r22.v1.json")
    .map((name) => {
      const filePath = path.join(bundleRoot, name);
      const identity = hashFile(filePath);
      return {
        path: name,
        sha256: identity.sha256,
        size: identity.size,
        mime: mimeFor(name),
        visibility: visibility.get(name) ?? "machine-side"
      };
    });
  return {
    contractVersion: MEDIA_LIVE_REVIEW_PACKAGE_MANIFEST_VERSION,
    state: LIVE_REVIEW_ARTIFACT_READY,
    bundleMode: bundle.mode,
    reviewRound: bundle.reviewRound,
    r21PackageDigest: bundle.transportHandoff.packageDigest,
    sealedMappingDigest: bundle.sealedMapping.digest,
    promptDigest: bundle.prompt.digest,
    payloadDigest: fingerprint(files),
    files,
    manifestSelf: {
      path: "media.live_review_package_manifest.r22.v1.json",
      mime: "application/json",
      sha256RecordedExternally: true
    },
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
}

function tarOctal(value, length) {
  const text = Math.trunc(value).toString(8);
  if (text.length + 1 > length) fail("live_review_archive_invalid", "tar numeric field overflow");
  return `${text.padStart(length - 1, "0")}\0`;
}
function writeField(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > length) fail("live_review_archive_invalid", `tar field too long: ${value}`);
  bytes.copy(buffer, offset);
}
function tarHeader(name, size) {
  if (Buffer.byteLength(name, "utf8") > 100) fail("live_review_archive_invalid", `tar path too long: ${name}`);
  const header = Buffer.alloc(512, 0);
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, tarOctal(0o644, 8));
  writeField(header, 108, 8, tarOctal(0, 8));
  writeField(header, 116, 8, tarOctal(0, 8));
  writeField(header, 124, 12, tarOctal(size, 12));
  writeField(header, 136, 12, tarOctal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeField(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function buildDeterministicTar(bundleRoot, outputPath) {
  const files = exactFiles(bundleRoot);
  if (stableStringify(files) !== stableStringify([...REQUIRED_BUNDLE_FILENAMES].sort())) {
    fail("live_review_archive_invalid", "bundle directory contains unexpected or missing files");
  }
  const chunks = [];
  for (const name of files) {
    const bytes = readFileSync(path.join(bundleRoot, name));
    chunks.push(tarHeader(name, bytes.length));
    chunks.push(bytes);
    const remainder = bytes.length % 512;
    if (remainder) chunks.push(Buffer.alloc(512 - remainder, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  const archive = Buffer.concat(chunks);
  writeFileSync(outputPath, archive);
  return { sha256: hashBytes(archive), size: archive.length, fileCount: files.length };
}

export function validateLiveReviewArtifactDirectory(bundleRoot, {
  expectedManifestSha256 = null
} = {}) {
  const files = exactFiles(bundleRoot);
  if (stableStringify(files) !== stableStringify([...REQUIRED_BUNDLE_FILENAMES].sort())) {
    fail("live_review_artifact_invalid", "bundle directory file set differs from required R22 layout");
  }
  const manifestPath = path.join(bundleRoot, "media.live_review_package_manifest.r22.v1.json");
  const manifestIdentity = hashFile(manifestPath);
  if (expectedManifestSha256 !== null && manifestIdentity.sha256 !== expectedManifestSha256) {
    fail("live_review_artifact_manifest_drift", "package manifest hash differs from archive index");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.contractVersion !== MEDIA_LIVE_REVIEW_PACKAGE_MANIFEST_VERSION ||
    manifest.state !== LIVE_REVIEW_ARTIFACT_READY ||
    manifest.modelReviewPerformed !== false ||
    manifest.liveModelReviewed !== false ||
    manifest.providerPublish !== false ||
    manifest.humanQuality !== false
  ) {
    fail("live_review_artifact_invalid", "package manifest state/boundary mismatch");
  }
  const expectedPayload = REQUIRED_BUNDLE_FILENAMES
    .filter((name) => name !== "media.live_review_package_manifest.r22.v1.json")
    .sort();
  const actualPayload = manifest.files.map((entry) => entry.path).sort();
  if (stableStringify(actualPayload) !== stableStringify(expectedPayload)) {
    fail("live_review_artifact_manifest_drift", "package manifest payload file set mismatch");
  }
  for (const entry of manifest.files) {
    const file = safePath(bundleRoot, entry.path, "manifest payload");
    const identity = hashFile(file.absolute);
    if (
      identity.sha256 !== entry.sha256 ||
      identity.size !== entry.size ||
      mimeFor(entry.path) !== entry.mime
    ) {
      fail("live_review_artifact_manifest_drift", `package file identity mismatch: ${entry.path}`);
    }
  }
  if (fingerprint(manifest.files) !== manifest.payloadDigest) {
    fail("live_review_artifact_manifest_drift", "payload digest mismatch");
  }

  const bundle = validateReviewRoundBundle(JSON.parse(readFileSync(
    path.join(bundleRoot, "media.review_round_bundle.r21.v1.json"),
    "utf8"
  )));
  const handoff = JSON.parse(readFileSync(
    path.join(bundleRoot, "media.review_round_transport_handoff.r21.v1.json"),
    "utf8"
  ));
  if (stableStringify(handoff) !== stableStringify(bundle.transportHandoff)) {
    fail("live_review_artifact_manifest_drift", "R21 transport handoff differs from bundle");
  }
  const sealed = JSON.parse(readFileSync(
    path.join(bundleRoot, "media.review_round_sealed_mapping.r21.v1.json"),
    "utf8"
  ));
  if (
    fingerprint(sealed.entries) !== sealed.digest ||
    stableStringify(sealed) !== stableStringify(bundle.sealedMapping)
  ) {
    fail("live_review_artifact_mapping_drift", "sealed mapping differs from R21 bundle");
  }
  const promptBytes = readFileSync(path.join(bundleRoot, "model-review-prompt.txt"));
  if (
    promptBytes.toString("utf8") !== bundle.prompt.text ||
    hashBytes(promptBytes) !== bundle.prompt.digest
  ) {
    fail("live_review_artifact_prompt_drift", "prompt bytes differ from exact R21 model-facing prompt");
  }
  for (const attachment of bundle.attachments) {
    const bytes = hashFile(path.join(bundleRoot, attachment.path));
    if (bytes.sha256 !== attachment.sha256 || bytes.size !== attachment.size) {
      fail("live_review_artifact_attachment_drift", `attachment differs from R21 bundle: ${attachment.path}`);
    }
  }
  const bridge = JSON.parse(readFileSync(
    path.join(bundleRoot, "media.dynamic_review_handoff.v1.json"),
    "utf8"
  ));
  const bridgeVerified = validateBridgeOperatorHandoff(bridge, bundleRoot);
  if (
    bridge.sealedMapping.digest !== bundle.sealedMapping.digest ||
    bridge.prompt.textSha256 !== bundle.prompt.digest
  ) {
    fail("live_review_artifact_bridge_invalid", "Bridge handoff lineage differs from R21 bundle");
  }

  return {
    state: LIVE_REVIEW_ARTIFACT_READY,
    manifest,
    manifestIdentity,
    bundle,
    bridge,
    bridgeVerified,
    verifiedFileCount: files.length,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    humanQuality: false
  };
}

export function buildLiveReviewArtifact({
  sourceBundleRoot,
  sandboxRoot,
  outputRoot,
  producerSha,
  ciRunId,
  repoRoot
} = {}) {
  gitSha(producerSha, "producerSha");
  positiveInt(ciRunId, "ciRunId");
  const sourceRoot = path.resolve(sourceBundleRoot);
  const targetRoot = path.resolve(outputRoot);
  const rel = path.relative(sandboxRoot, targetRoot);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("live_review_artifact_path_escape", "outputRoot escapes sandboxRoot");
  }
  mkdirSync(targetRoot, { recursive: true });
  if (readdirSync(targetRoot).length !== 0) {
    fail("live_review_artifact_partial_output", "output directory must be empty");
  }

  const sourceBundlePath = path.join(sourceRoot, "media.review_round_bundle.r21.v1.json");
  const sourceHandoffPath = path.join(sourceRoot, "media.review_round_transport_handoff.r21.v1.json");
  const sourceSealedPath = path.join(sourceRoot, "media.review_round_sealed_mapping.r21.v1.json");
  const sourceBundle = JSON.parse(readFileSync(sourceBundlePath, "utf8"));
  const { bundle } = validateRoundBundleForExport(sourceBundle, sandboxRoot);

  const sourceHandoff = JSON.parse(readFileSync(sourceHandoffPath, "utf8"));
  if (stableStringify(sourceHandoff) !== stableStringify(bundle.transportHandoff)) {
    fail("live_review_artifact_manifest_drift", "source R21 transport handoff differs from bundle");
  }
  const sourceSealed = JSON.parse(readFileSync(sourceSealedPath, "utf8"));
  if (stableStringify(sourceSealed) !== stableStringify(bundle.sealedMapping)) {
    fail("live_review_artifact_mapping_drift", "source sealed mapping differs from bundle");
  }

  for (const attachment of bundle.attachments) {
    const sourceAttachment = path.join(sourceRoot, attachment.path);
    const identity = hashFile(sourceAttachment);
    if (identity.sha256 !== attachment.sha256 || identity.size !== attachment.size) {
      fail("live_review_artifact_attachment_drift", "source R21 attachment bytes differ from bundle");
    }
    copyFileSync(sourceAttachment, path.join(targetRoot, attachment.path));
  }

  const promptBytes = Buffer.from(bundle.prompt.text, "utf8");
  if (hashBytes(promptBytes) !== bundle.prompt.digest) {
    fail("live_review_artifact_prompt_drift", "R21 prompt digest does not match exact model-facing bytes");
  }
  writeFileSync(path.join(targetRoot, "model-review-prompt.txt"), promptBytes);

  const bundleWrite = writeStable(
    path.join(targetRoot, "media.review_round_bundle.r21.v1.json"),
    bundle
  );
  writeStable(
    path.join(targetRoot, "media.review_round_transport_handoff.r21.v1.json"),
    bundle.transportHandoff
  );
  writeStable(
    path.join(targetRoot, "media.review_round_sealed_mapping.r21.v1.json"),
    bundle.sealedMapping
  );

  const authority = authorityProfile({ producerSha, ciRunId, repoRoot });
  writeStable(
    path.join(targetRoot, "media.live_review_authority_profile.r22.v1.json"),
    authority
  );

  const bridgeHandoff = buildBridgeOperatorHandoff({
    bundle,
    producerSha,
    bundleFileSha256: bundleWrite.sha256,
    promptFileSha256: hashBytes(promptBytes)
  });
  writeStable(
    path.join(targetRoot, "media.dynamic_review_handoff.v1.json"),
    bridgeHandoff
  );

  const manifest = packageManifestPayload(targetRoot, bundle);
  const manifestWrite = writeStable(
    path.join(targetRoot, "media.live_review_package_manifest.r22.v1.json"),
    manifest
  );

  const verified = validateLiveReviewArtifactDirectory(targetRoot, {
    expectedManifestSha256: manifestWrite.sha256
  });

  return {
    state: LIVE_REVIEW_ARTIFACT_READY,
    outputRoot: targetRoot,
    packageManifestSha256: manifestWrite.sha256,
    packageManifestSize: manifestWrite.size,
    payloadDigest: manifest.payloadDigest,
    bridgePackageDigest: bridgeHandoff.package.digest,
    promptDigest: bundle.prompt.digest,
    sealedMappingDigest: bundle.sealedMapping.digest,
    r21PackageDigest: bundle.transportHandoff.packageDigest,
    mode: bundle.mode,
    reviewRound: bundle.reviewRound,
    attachments: bundle.attachments.map(clone),
    verifiedFileCount: verified.verifiedFileCount,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
}
