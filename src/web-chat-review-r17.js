import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import path from "node:path";

import {
  renderExportDigest,
  validateRenderExportAgainstFinal
} from "./render-export-r15.js";
import { validateCandidateBatchManifest } from "./candidate-batch-r16.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION = "media.web_chat_review_bundle.v1";
export const WEB_CHAT_REVIEW_MAX_FILE_BYTES = 500_000_000;

export const R17_ACCEPTED_R16_UPSTREAM_AUTHORITY = Object.freeze({
  contractVersion: "media.candidate_batch.v1",
  repository: "foto6/video2",
  producerSha: "231a0680c8939cfec77aaa283e507e93f383ad73",
  ciRunId: 36865890506,
  artifact: {
    id: 11163920921,
    name: "media-r16-candidate-batch-demo",
    archiveDigest: "sha256:d929b592c76ec93e41b54701376f4b02366a3bdbd127d3472d73ae277d450d0f"
  },
  candidateBatch: {
    manifestFileSha256: "44ab0a7dd761bbc79e554a21003b7e67b65b6e80b6c1b3830179caedab509872",
    manifestDigest: "ec75baee68bc73b8c8e1812dddbf6dbe5cc0dfdc4d0a66938a16c6db87536dbf"
  },
  source: {
    sourceId: "r16-demo-source",
    sha256: "7b484abef5de1569e1b7f91a5d780f17c6d687ef68b3c42c9e54375f4e5e434b",
    size: 763377
  },
  candidates: [
    {
      order: 0,
      candidateId: "candidate-1",
      finalSha256: "3bd12d999264cb932cb3ef15dfbd96e002ede517f2273795b593553b9642d864",
      finalSize: 575465,
      renderExportFileSha256: "2b5177c00bb054184a239c7eddb1383ad253922e8eb686f5aa2e56c91a1335ac",
      renderExportDigest: "6a005607dd463643a908a35ce24f411ae74be4100c349a212bd70b59e449a2b5",
      technicalQaEvidenceSha256: "7e836b809da7fe483ee140c5115e8a58b4b299109c279ccb16c0197be827ff0f"
    },
    {
      order: 1,
      candidateId: "candidate-2",
      finalSha256: "cdae63d5ccce67332e607af7fd87b18c31da8dc77c2f0ce5182550321767286c",
      finalSize: 576763,
      renderExportFileSha256: "b349b897f8f86bc9257e2622f564d6430f3864ff605ae4b82ba0cb09c59298f6",
      renderExportDigest: "47b7d0dcaaf0277274c1990825025042e89272dd153e3752b15d29a515041d82",
      technicalQaEvidenceSha256: "41bce4934320d225e6a58847233702b4ae706a5bed85427272a1f309acb50d79"
    },
    {
      order: 2,
      candidateId: "candidate-3",
      finalSha256: "3bd12d999264cb932cb3ef15dfbd96e002ede517f2273795b593553b9642d864",
      finalSize: 575465,
      renderExportFileSha256: "26fe61f0644e263ce047869334ba65c5973eba809ff45f76286490f573d61b8e",
      renderExportDigest: "d31f45e0b29b1c002e8a9b3d52f54d69838ebcb902b04cfbde963cd82e2c2233",
      technicalQaEvidenceSha256: "7e836b809da7fe483ee140c5115e8a58b4b299109c279ccb16c0197be827ff0f"
    }
  ]
});

export const WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS = Object.freeze({
  transformVersion: "media.web_chat_review_derivative.v1",
  videoCodec: "libx264",
  audioCodec: "aac",
  width: 720,
  height: 1280,
  fps: 30,
  crf: 28,
  preset: "medium",
  audioBitrate: "128k",
  pixelFormat: "yuv420p",
  metadata: "stripped",
  threads: 1
});

const TOP_FIELDS = new Set([
  "contractVersion", "review_bundle_producer", "upstream_media_authority",
  "source", "candidate_batch", "attachment_policy", "candidates"
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
    fail("web_chat_review_invalid", `${label} must be lowercase SHA-256 hex`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("web_chat_review_invalid", `${label} must be exact Git SHA`);
  }
}
function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail("web_chat_review_invalid", `${label} must be a positive integer`);
  }
}
function exactKeys(value, fields, label) {
  if (!plain(value)) fail("web_chat_review_invalid", `${label} must be an object`);
  const expected = new Set(fields);
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length) fail("web_chat_review_invalid", `${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail("web_chat_review_invalid", `${label} unknown fields: ${extra.sort().join(", ")}`);
}
function hashFile(filePath) {
  if (!existsSync(filePath)) fail("web_chat_review_missing_file", `file is missing: ${filePath}`);
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}
function safeRelative(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    fail("web_chat_review_invalid", `${label} must be a relative path`);
  }
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("web_chat_review_invalid", `${label} escapes review root`);
  }
  return resolved;
}
function reviewFileIdentity(filePath, root) {
  const digest = hashFile(filePath);
  return {
    path: path.relative(root, filePath).split(path.sep).join("/"),
    name: path.basename(filePath),
    sha256: digest.sha256,
    size: digest.size
  };
}

export function validateAcceptedR16UpstreamAuthority(input) {
  if (stableStringify(input) !== stableStringify(R17_ACCEPTED_R16_UPSTREAM_AUTHORITY)) {
    fail("web_chat_review_upstream_authority_mismatch", "upstream Media authority is not the exact accepted R16 pin/artifact");
  }
  return clone(input);
}

export function attachmentEligibility(size) {
  if (!Number.isInteger(size) || size < 0) throw new TypeError("size must be a non-negative integer");
  return {
    eligible: size <= WEB_CHAT_REVIEW_MAX_FILE_BYTES,
    maxBytes: WEB_CHAT_REVIEW_MAX_FILE_BYTES,
    reason: size <= WEB_CHAT_REVIEW_MAX_FILE_BYTES ? null : "file_exceeds_500mb_limit"
  };
}

export function reviewDerivativeSettingsDigest(settings = WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS) {
  return fingerprint(settings);
}

export function createBoundedReviewDerivative({
  originalPath,
  derivativePath,
  settings = WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS,
  ffmpegBinary = "ffmpeg"
} = {}) {
  const original = hashFile(originalPath);
  mkdirSync(path.dirname(derivativePath), { recursive: true });
  const s = { ...WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS, ...clone(settings) };
  const vf = [
    `scale=w=${s.width}:h=${s.height}:force_original_aspect_ratio=decrease`,
    `pad=${s.width}:${s.height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${s.fps}`
  ].join(",");
  try {
    execFileSync(ffmpegBinary, [
      "-hide_banner", "-nostdin", "-y",
      "-i", originalPath,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-vf", vf,
      "-map_metadata", "-1",
      "-metadata", "creation_time=1970-01-01T00:00:00Z",
      "-fflags", "+bitexact",
      "-flags:v", "+bitexact",
      "-threads", String(s.threads),
      "-c:v", s.videoCodec,
      "-preset", s.preset,
      "-crf", String(s.crf),
      "-pix_fmt", s.pixelFormat,
      "-c:a", s.audioCodec,
      "-b:a", s.audioBitrate,
      "-movflags", "+faststart",
      "-f", "mp4",
      derivativePath
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    fail("web_chat_review_derivative_failed", `review derivative transcode failed: ${error.message}`);
  }
  const derivative = hashFile(derivativePath);
  if (derivative.size > WEB_CHAT_REVIEW_MAX_FILE_BYTES) {
    fail("web_chat_review_derivative_oversize", "deterministic review derivative still exceeds 500 MB");
  }
  return validateReviewDerivativeProvenance({
    derivative_for_model_review: true,
    originalSha256: original.sha256,
    originalSize: original.size,
    derivativeSha256: derivative.sha256,
    derivativeSize: derivative.size,
    settings: s,
    settingsDigest: reviewDerivativeSettingsDigest(s)
  });
}

export function validateReviewDerivativeProvenance(input, {
  expectedOriginalSha256 = null,
  expectedDerivativeSha256 = null
} = {}) {
  exactKeys(input, [
    "derivative_for_model_review", "originalSha256", "originalSize",
    "derivativeSha256", "derivativeSize", "settings", "settingsDigest"
  ], "derivative");
  if (input.derivative_for_model_review !== true) fail("web_chat_review_derivative_invalid", "derivative_for_model_review must be true");
  sha256(input.originalSha256, "derivative.originalSha256");
  positiveInt(input.originalSize, "derivative.originalSize");
  sha256(input.derivativeSha256, "derivative.derivativeSha256");
  positiveInt(input.derivativeSize, "derivative.derivativeSize");
  if (input.derivativeSize > WEB_CHAT_REVIEW_MAX_FILE_BYTES) fail("web_chat_review_derivative_oversize", "derivative exceeds 500 MB");
  if (!plain(input.settings)) fail("web_chat_review_derivative_invalid", "derivative.settings must be an object");
  sha256(input.settingsDigest, "derivative.settingsDigest");
  if (reviewDerivativeSettingsDigest(input.settings) !== input.settingsDigest) {
    fail("web_chat_review_derivative_invalid", "derivative transform settings digest mismatch");
  }
  if (expectedOriginalSha256 && input.originalSha256 !== expectedOriginalSha256) {
    fail("web_chat_review_derivative_invalid", "derivative original SHA mismatch");
  }
  if (expectedDerivativeSha256 && input.derivativeSha256 !== expectedDerivativeSha256) {
    fail("web_chat_review_derivative_invalid", "derivative bytes SHA mismatch");
  }
  return clone(input);
}

function summarizeTechnicalQa(renderExport, expectedQaSha) {
  const technical = renderExport.qa?.technical;
  if (!technical || technical.passed !== true || technical.value?.passed !== true) {
    fail("web_chat_review_technical_qa_failed", "candidate technical QA is not passing");
  }
  if (technical.sha256 !== expectedQaSha) {
    fail("web_chat_review_upstream_provenance_mismatch", "technical QA lineage does not match accepted R16 evidence");
  }
  const checks = technical.value.checks ?? [];
  const failedChecks = checks.filter((entry) => entry?.pass !== true).map((entry) => entry?.name ?? "unknown");
  if (failedChecks.length) fail("web_chat_review_technical_qa_failed", "candidate technical QA contains failed checks");
  return {
    passed: true,
    evidenceSha256: technical.sha256,
    checkCount: checks.length,
    failedChecks
  };
}

function sourceMatchesRenderExport(renderExport, source) {
  return (renderExport.evidence?.sources?.items ?? []).some((entry) =>
    entry.sourceId === source.sourceId &&
    entry.sha256 === source.sha256 &&
    entry.size === source.size &&
    entry.probeOk === true
  );
}

export function verifyReviewSourceFile(sourcePath, expectedSource) {
  const sourceBytes = hashFile(sourcePath);
  if (
    sourceBytes.sha256 !== expectedSource.sha256 ||
    sourceBytes.size !== expectedSource.size
  ) {
    fail("web_chat_review_wrong_source", "exact source bytes do not match expected upstream source");
  }
  return sourceBytes;
}

export function verifyReviewCandidateAgainstPin({
  finalPath,
  sidecarPath,
  expectedCandidate,
  expectedSource,
  upstreamProducerSha
} = {}) {
  const finalBytes = hashFile(finalPath);
  if (
    finalBytes.sha256 !== expectedCandidate.finalSha256 ||
    finalBytes.size !== expectedCandidate.finalSize
  ) {
    fail("web_chat_review_hash_mismatch", "candidate final.mp4 differs from pinned upstream bytes");
  }

  const sidecarBytes = hashFile(sidecarPath);
  if (sidecarBytes.sha256 !== expectedCandidate.renderExportFileSha256) {
    fail("web_chat_review_stale_render_export", "candidate render-export sidecar bytes differ from pinned upstream evidence");
  }

  const renderExport = JSON.parse(readFileSync(sidecarPath, "utf8"));
  validateRenderExportAgainstFinal(renderExport, finalPath);
  const semanticDigest = renderExportDigest(renderExport);
  if (
    renderExport.producer.sha !== upstreamProducerSha ||
    semanticDigest !== expectedCandidate.renderExportDigest ||
    renderExport.artifact.sha256 !== expectedCandidate.finalSha256 ||
    renderExport.artifact.size !== expectedCandidate.finalSize
  ) {
    fail("web_chat_review_upstream_provenance_mismatch", "candidate render-export provenance differs from pinned upstream evidence");
  }
  if (!sourceMatchesRenderExport(renderExport, expectedSource)) {
    fail("web_chat_review_wrong_source", "candidate render export does not bind expected upstream source");
  }

  return {
    finalBytes,
    sidecarBytes,
    renderExport,
    semanticDigest,
    technicalQa: summarizeTechnicalQa(renderExport, expectedCandidate.technicalQaEvidenceSha256)
  };
}

export function validateWebChatReviewBundle(input) {
  const bundle = clone(input);
  exactKeys(bundle, TOP_FIELDS, "review bundle");
  if (bundle.contractVersion !== MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION) fail("web_chat_review_invalid", "contractVersion mismatch");
  exactKeys(bundle.review_bundle_producer, ["repository", "sha"], "review_bundle_producer");
  if (bundle.review_bundle_producer.repository !== "foto6/video2") fail("web_chat_review_invalid", "review bundle producer repository mismatch");
  gitSha(bundle.review_bundle_producer.sha, "review_bundle_producer.sha");
  validateAcceptedR16UpstreamAuthority(bundle.upstream_media_authority);
  if (stableStringify(bundle.source) !== stableStringify(bundle.upstream_media_authority.source)) {
    fail("web_chat_review_upstream_provenance_mismatch", "bundle source differs from accepted R16 source");
  }
  exactKeys(bundle.candidate_batch, ["manifestFileSha256", "manifestDigest"], "candidate_batch");
  if (stableStringify(bundle.candidate_batch) !== stableStringify(bundle.upstream_media_authority.candidateBatch)) {
    fail("web_chat_review_upstream_provenance_mismatch", "candidate batch identity differs from accepted R16");
  }
  exactKeys(bundle.attachment_policy, ["maxBytesPerFile", "oversizeBehavior"], "attachment_policy");
  if (bundle.attachment_policy.maxBytesPerFile !== WEB_CHAT_REVIEW_MAX_FILE_BYTES) fail("web_chat_review_invalid", "attachment limit mismatch");
  if (bundle.attachment_policy.oversizeBehavior !== "ineligible_without_explicit_derivative") fail("web_chat_review_invalid", "oversize behavior mismatch");
  if (!Array.isArray(bundle.candidates) || bundle.candidates.length !== bundle.upstream_media_authority.candidates.length) {
    fail("web_chat_review_invalid", "review bundle candidate count mismatch");
  }
  const seen = new Set();
  bundle.candidates.forEach((candidate, index) => {
    const accepted = bundle.upstream_media_authority.candidates[index];
    exactKeys(candidate, [
      "order", "candidateId", "final", "renderExport", "technicalQa",
      "attachmentEligibility", "reviewAttachment"
    ], `candidates[${index}]`);
    if (seen.has(candidate.candidateId)) fail("web_chat_review_duplicate_candidate", "duplicate candidate ID");
    seen.add(candidate.candidateId);
    if (candidate.order !== accepted.order || candidate.candidateId !== accepted.candidateId) {
      fail("web_chat_review_upstream_provenance_mismatch", "candidate ID/order differs from accepted R16");
    }
    if (candidate.final.sha256 !== accepted.finalSha256 || candidate.final.size !== accepted.finalSize) {
      fail("web_chat_review_upstream_provenance_mismatch", "candidate final identity differs from accepted R16");
    }
    if (
      candidate.renderExport.fileSha256 !== accepted.renderExportFileSha256 ||
      candidate.renderExport.digest !== accepted.renderExportDigest ||
      candidate.renderExport.producerSha !== bundle.upstream_media_authority.producerSha
    ) fail("web_chat_review_upstream_provenance_mismatch", "candidate render export differs from accepted R16");
    if (candidate.technicalQa?.passed !== true || candidate.technicalQa.evidenceSha256 !== accepted.technicalQaEvidenceSha256) {
      fail("web_chat_review_upstream_provenance_mismatch", "candidate technical QA lineage differs from accepted R16");
    }
    const eligibility = attachmentEligibility(candidate.final.size);
    if (stableStringify(eligibility) !== stableStringify(candidate.attachmentEligibility)) {
      fail("web_chat_review_invalid", "attachment eligibility does not match final file size");
    }
    if (!candidate.reviewAttachment) {
      if (eligibility.eligible) fail("web_chat_review_invalid", "eligible candidate is missing review attachment");
      return;
    }
    exactKeys(candidate.reviewAttachment, ["file", "derivative"], "reviewAttachment");
    if (candidate.reviewAttachment.file.size > WEB_CHAT_REVIEW_MAX_FILE_BYTES) fail("web_chat_review_oversize", "review attachment exceeds 500 MB");
    if (candidate.reviewAttachment.derivative === null) {
      if (
        candidate.reviewAttachment.file.sha256 !== accepted.finalSha256 ||
        candidate.reviewAttachment.file.size !== accepted.finalSize
      ) fail("web_chat_review_upstream_provenance_mismatch", "original review attachment differs from accepted R16 MP4");
    } else {
      validateReviewDerivativeProvenance(candidate.reviewAttachment.derivative, {
        expectedOriginalSha256: accepted.finalSha256,
        expectedDerivativeSha256: candidate.reviewAttachment.file.sha256
      });
    }
  });
  return bundle;
}

export function buildWebChatReviewBundle({
  candidateBatchManifest,
  candidateBatchManifestFileSha256,
  batchRoot,
  sourcePath,
  reviewBundleProducerSha,
  upstreamMediaAuthority = R17_ACCEPTED_R16_UPSTREAM_AUTHORITY,
  attachmentRoot = null,
  transcodeOversize = false,
  derivativeSettings = WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS
} = {}) {
  const authority = validateAcceptedR16UpstreamAuthority(upstreamMediaAuthority);
  const batch = validateCandidateBatchManifest(candidateBatchManifest);
  gitSha(reviewBundleProducerSha, "reviewBundleProducerSha");
  sha256(candidateBatchManifestFileSha256, "candidateBatchManifestFileSha256");

  if (batch.producer.sha !== authority.producerSha) {
    fail("web_chat_review_upstream_provenance_mismatch", "candidate batch producer is not accepted R16");
  }
  if (candidateBatchManifestFileSha256 !== authority.candidateBatch.manifestFileSha256) {
    fail("web_chat_review_upstream_provenance_mismatch", "candidate batch manifest file SHA differs from accepted R16 artifact");
  }
  if (fingerprint(batch) !== authority.candidateBatch.manifestDigest) {
    fail("web_chat_review_upstream_provenance_mismatch", "candidate batch semantic digest differs from accepted R16");
  }
  if (stableStringify(batch.source) !== stableStringify(authority.source)) {
    fail("web_chat_review_upstream_provenance_mismatch", "candidate batch source differs from accepted R16");
  }

  verifyReviewSourceFile(sourcePath, authority.source);
  const outputRoot = attachmentRoot ? path.resolve(attachmentRoot) : null;
  if (outputRoot) mkdirSync(outputRoot, { recursive: true });

  if (batch.candidates.length !== authority.candidates.length) {
    fail("web_chat_review_upstream_provenance_mismatch", "candidate count differs from accepted R16");
  }

  const seen = new Set();
  const candidates = batch.candidates.map((entry, order) => {
    const accepted = authority.candidates[order];
    if (
      entry.order !== accepted.order ||
      entry.candidateId !== accepted.candidateId ||
      entry.status !== "succeeded" ||
      !entry.final
    ) fail("web_chat_review_upstream_provenance_mismatch", "candidate terminal identity differs from accepted R16");
    if (seen.has(entry.candidateId)) fail("web_chat_review_duplicate_candidate", "duplicate candidate ID");
    seen.add(entry.candidateId);
    if (
      entry.final.sha256 !== accepted.finalSha256 ||
      entry.final.size !== accepted.finalSize ||
      entry.final.renderExportSha256 !== accepted.renderExportFileSha256
    ) fail("web_chat_review_upstream_provenance_mismatch", "candidate manifest evidence differs from accepted R16");

    const finalPath = safeRelative(batchRoot, entry.final.relativePath, "candidate final path");
    const sidecarPath = safeRelative(batchRoot, entry.final.renderExportRelativePath, "render export path");
    const verified = verifyReviewCandidateAgainstPin({
      finalPath,
      sidecarPath,
      expectedCandidate: accepted,
      expectedSource: authority.source,
      upstreamProducerSha: authority.producerSha
    });
    const { finalBytes, sidecarBytes, renderExport, semanticDigest, technicalQa } = verified;

    const eligibility = attachmentEligibility(finalBytes.size);
    let reviewAttachment = null;
    if (eligibility.eligible) {
      const destination = outputRoot
        ? path.join(outputRoot, "attachments", entry.candidateId, "final.mp4")
        : finalPath;
      if (outputRoot) {
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(finalPath, destination);
      }
      const copied = hashFile(destination);
      if (copied.sha256 !== accepted.finalSha256 || copied.size !== accepted.finalSize) {
        fail("web_chat_review_hash_mismatch", "copied attachment bytes changed");
      }
      reviewAttachment = {
        file: reviewFileIdentity(destination, outputRoot ?? batchRoot),
        derivative: null
      };
    } else if (transcodeOversize) {
      if (!outputRoot) fail("web_chat_review_invalid", "attachmentRoot is required for derivative generation");
      const destination = path.join(outputRoot, "attachments", entry.candidateId, "review-derivative.mp4");
      const derivative = createBoundedReviewDerivative({
        originalPath: finalPath,
        derivativePath: destination,
        settings: derivativeSettings
      });
      reviewAttachment = {
        file: reviewFileIdentity(destination, outputRoot),
        derivative
      };
    }

    return {
      order,
      candidateId: entry.candidateId,
      final: {
        path: entry.final.relativePath,
        name: entry.final.fileName,
        sha256: finalBytes.sha256,
        size: finalBytes.size
      },
      renderExport: {
        path: entry.final.renderExportRelativePath,
        digest: semanticDigest,
        fileSha256: sidecarBytes.sha256,
        producerSha: renderExport.producer.sha
      },
      technicalQa,
      attachmentEligibility: eligibility,
      reviewAttachment
    };
  });

  return validateWebChatReviewBundle({
    contractVersion: MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION,
    review_bundle_producer: { repository: "foto6/video2", sha: reviewBundleProducerSha },
    upstream_media_authority: clone(authority),
    source: clone(authority.source),
    candidate_batch: clone(authority.candidateBatch),
    attachment_policy: {
      maxBytesPerFile: WEB_CHAT_REVIEW_MAX_FILE_BYTES,
      oversizeBehavior: "ineligible_without_explicit_derivative"
    },
    candidates
  });
}
