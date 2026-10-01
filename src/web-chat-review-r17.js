import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync
} from "node:fs";
import path from "node:path";

import {
  MEDIA_RENDER_EXPORT_FILENAME,
  renderExportDigest,
  validateRenderExportAgainstFinal
} from "./render-export-r15.js";
import { validateCandidateBatchManifest } from "./candidate-batch-r16.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION = "media.web_chat_review_bundle.v1";
export const WEB_CHAT_REVIEW_MAX_FILE_BYTES = 500_000_000;
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
  "contractVersion", "source", "producer", "candidateBatch",
  "attachmentPolicy", "candidates"
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
    fail("web_chat_review_derivative_oversize", "deterministic review derivative still exceeds 500 MB", {
      derivativeSize: derivative.size,
      maxBytes: WEB_CHAT_REVIEW_MAX_FILE_BYTES
    });
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
  if (input.derivative_for_model_review !== true) {
    fail("web_chat_review_derivative_invalid", "derivative_for_model_review must be true");
  }
  sha256(input.originalSha256, "derivative.originalSha256");
  positiveInt(input.originalSize, "derivative.originalSize");
  sha256(input.derivativeSha256, "derivative.derivativeSha256");
  positiveInt(input.derivativeSize, "derivative.derivativeSize");
  if (input.derivativeSize > WEB_CHAT_REVIEW_MAX_FILE_BYTES) {
    fail("web_chat_review_derivative_oversize", "derivative exceeds 500 MB");
  }
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

function summarizeTechnicalQa(renderExport) {
  const technical = renderExport.qa?.technical;
  if (!technical || technical.passed !== true || technical.value?.passed !== true) {
    fail("web_chat_review_technical_qa_failed", "candidate technical QA is not passing");
  }
  const checks = technical.value.checks ?? [];
  return {
    passed: true,
    evidenceSha256: technical.sha256,
    checkCount: checks.length,
    failedChecks: checks.filter((entry) => entry?.pass !== true).map((entry) => entry?.name ?? "unknown")
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

export function validateWebChatReviewBundle(input) {
  const bundle = clone(input);
  exactKeys(bundle, TOP_FIELDS, "review bundle");
  if (bundle.contractVersion !== MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION) {
    fail("web_chat_review_invalid", "review bundle contractVersion mismatch");
  }
  exactKeys(bundle.source, ["sourceId", "sha256", "size"], "source");
  sha256(bundle.source.sha256, "source.sha256");
  positiveInt(bundle.source.size, "source.size");
  exactKeys(bundle.producer, ["repository", "sha"], "producer");
  if (bundle.producer.repository !== "foto6/video2") fail("web_chat_review_invalid", "producer repository mismatch");
  gitSha(bundle.producer.sha, "producer.sha");
  exactKeys(bundle.candidateBatch, ["manifestDigest", "producerSha"], "candidateBatch");
  sha256(bundle.candidateBatch.manifestDigest, "candidateBatch.manifestDigest");
  if (bundle.candidateBatch.producerSha !== bundle.producer.sha) {
    fail("web_chat_review_invalid", "candidate batch producer mismatch");
  }
  exactKeys(bundle.attachmentPolicy, ["maxBytesPerFile", "oversizeBehavior"], "attachmentPolicy");
  if (bundle.attachmentPolicy.maxBytesPerFile !== WEB_CHAT_REVIEW_MAX_FILE_BYTES) {
    fail("web_chat_review_invalid", "attachment limit mismatch");
  }
  if (bundle.attachmentPolicy.oversizeBehavior !== "ineligible_without_explicit_derivative") {
    fail("web_chat_review_invalid", "oversize behavior mismatch");
  }
  if (!Array.isArray(bundle.candidates) || bundle.candidates.length < 1) {
    fail("web_chat_review_invalid", "review bundle requires candidates");
  }
  const seen = new Set();
  bundle.candidates.forEach((candidate, index) => {
    exactKeys(candidate, [
      "order", "candidateId", "final", "renderExport", "technicalQa",
      "attachmentEligibility", "reviewAttachment"
    ], `candidates[${index}]`);
    if (candidate.order !== index) fail("web_chat_review_invalid", "candidate order must be stable and contiguous");
    if (seen.has(candidate.candidateId)) fail("web_chat_review_duplicate_candidate", "duplicate candidate ID");
    seen.add(candidate.candidateId);
    if (!plain(candidate.final)) fail("web_chat_review_invalid", "candidate.final is required");
    sha256(candidate.final.sha256, "candidate.final.sha256");
    positiveInt(candidate.final.size, "candidate.final.size");
    sha256(candidate.renderExport.digest, "candidate.renderExport.digest");
    sha256(candidate.renderExport.fileSha256, "candidate.renderExport.fileSha256");
    if (candidate.technicalQa?.passed !== true || candidate.technicalQa.failedChecks?.length !== 0) {
      fail("web_chat_review_technical_qa_failed", "candidate technical QA summary is not passing");
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
    sha256(candidate.reviewAttachment.file.sha256, "reviewAttachment.file.sha256");
    positiveInt(candidate.reviewAttachment.file.size, "reviewAttachment.file.size");
    if (candidate.reviewAttachment.file.size > WEB_CHAT_REVIEW_MAX_FILE_BYTES) {
      fail("web_chat_review_oversize", "review attachment exceeds 500 MB");
    }
    if (candidate.reviewAttachment.derivative === null) {
      if (
        candidate.reviewAttachment.file.sha256 !== candidate.final.sha256 ||
        candidate.reviewAttachment.file.size !== candidate.final.size
      ) fail("web_chat_review_invalid", "original review attachment does not match final.mp4");
    } else {
      validateReviewDerivativeProvenance(candidate.reviewAttachment.derivative, {
        expectedOriginalSha256: candidate.final.sha256,
        expectedDerivativeSha256: candidate.reviewAttachment.file.sha256
      });
    }
  });
  return bundle;
}

export function buildWebChatReviewBundle({
  candidateBatchManifest,
  batchRoot,
  sourcePath,
  producerSha,
  attachmentRoot = null,
  transcodeOversize = false,
  derivativeSettings = WEB_CHAT_REVIEW_DERIVATIVE_SETTINGS
} = {}) {
  const batch = validateCandidateBatchManifest(candidateBatchManifest);
  gitSha(producerSha, "producerSha");
  if (batch.producer.sha !== producerSha) {
    fail("web_chat_review_stale_producer", "candidate batch producer SHA does not match current producer");
  }
  const sourceBytes = hashFile(sourcePath);
  if (sourceBytes.sha256 !== batch.source.sha256 || sourceBytes.size !== batch.source.size) {
    fail("web_chat_review_wrong_source", "exact source bytes do not match candidate batch source");
  }
  const outputRoot = attachmentRoot ? path.resolve(attachmentRoot) : null;
  if (outputRoot) mkdirSync(outputRoot, { recursive: true });

  const seen = new Set();
  const candidates = batch.candidates.map((entry, order) => {
    if (seen.has(entry.candidateId)) fail("web_chat_review_duplicate_candidate", "duplicate candidate ID");
    seen.add(entry.candidateId);
    if (entry.status !== "succeeded" || !entry.final) {
      fail("web_chat_review_candidate_failed", `candidate ${entry.candidateId} is not a successful review candidate`);
    }
    const finalPath = safeRelative(batchRoot, entry.final.relativePath, "candidate final path");
    const sidecarPath = safeRelative(batchRoot, entry.final.renderExportRelativePath, "render export path");
    const finalBytes = hashFile(finalPath);
    if (finalBytes.sha256 !== entry.final.sha256 || finalBytes.size !== entry.final.size) {
      fail("web_chat_review_hash_mismatch", `candidate ${entry.candidateId} final.mp4 hash/size mismatch`);
    }
    const sidecarBytes = hashFile(sidecarPath);
    if (sidecarBytes.sha256 !== entry.final.renderExportSha256) {
      fail("web_chat_review_stale_render_export", `candidate ${entry.candidateId} render export sidecar hash mismatch`);
    }
    const renderExport = JSON.parse(readFileSync(sidecarPath, "utf8"));
    validateRenderExportAgainstFinal(renderExport, finalPath);
    if (renderExport.producer.sha !== producerSha) {
      fail("web_chat_review_stale_render_export", `candidate ${entry.candidateId} render export producer mismatch`);
    }
    if (
      renderExport.artifact.sha256 !== entry.final.sha256 ||
      renderExport.artifact.size !== entry.final.size
    ) {
      fail("web_chat_review_stale_render_export", `candidate ${entry.candidateId} render export final identity mismatch`);
    }
    if (!sourceMatchesRenderExport(renderExport, batch.source)) {
      fail("web_chat_review_wrong_source", `candidate ${entry.candidateId} render export does not bind exact source`);
    }

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
      if (copied.sha256 !== finalBytes.sha256 || copied.size !== finalBytes.size) {
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
        digest: renderExportDigest(renderExport),
        fileSha256: sidecarBytes.sha256
      },
      technicalQa: summarizeTechnicalQa(renderExport),
      attachmentEligibility: eligibility,
      reviewAttachment
    };
  });

  return validateWebChatReviewBundle({
    contractVersion: MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION,
    source: clone(batch.source),
    producer: { repository: "foto6/video2", sha: producerSha },
    candidateBatch: {
      manifestDigest: fingerprint(batch),
      producerSha: batch.producer.sha
    },
    attachmentPolicy: {
      maxBytesPerFile: WEB_CHAT_REVIEW_MAX_FILE_BYTES,
      oversizeBehavior: "ineligible_without_explicit_derivative"
    },
    candidates
  });
}
