import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import path from "node:path";

import {
  MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION,
  WEB_CHAT_REVIEW_MAX_FILE_BYTES,
  validateWebChatReviewBundle,
  validateReviewDerivativeProvenance
} from "./web-chat-review-r17.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_DIRECT_MODEL_REVIEW_PACKAGE_VERSION = "media.direct_model_review_package.v1";
export const MEDIA_DIRECT_MODEL_REVIEW_PROMPT_VERSION = "media.direct_model_review_prompt.v1";

export const R18_ACCEPTED_R17_AUTHORITY = Object.freeze({
  contractVersion: MEDIA_WEB_CHAT_REVIEW_BUNDLE_VERSION,
  repository: "foto6/video2",
  producerSha: "e88f1791ae47e7333ce85db584f0a04dbf229809",
  ciRunId: 36890371410,
  artifact: {
    id: 11177570580,
    name: "media-r17-web-chat-review",
    archiveDigest: "sha256:37778b26f02b248f47a97046f87bf83b988191cb91e0486182c09e4d695e1ad2"
  },
  bundleFile: {
    name: "media.web_chat_review_bundle.v1.json",
    sha256: "96a8f5376daadb710916880c036c54154e28ccc63c05f15482cabc2d3bf465bc"
  },
  source: {
    sourceId: "r16-demo-source",
    sha256: "7b484abef5de1569e1b7f91a5d780f17c6d687ef68b3c42c9e54375f4e5e434b",
    size: 763377
  },
  selectedCandidates: [
    {
      blindLabel: "A",
      genericFileName: "review-A.mp4",
      candidateId: "candidate-1",
      finalSha256: "3bd12d999264cb932cb3ef15dfbd96e002ede517f2273795b593553b9642d864",
      finalSize: 575465,
      renderExportDigest: "6a005607dd463643a908a35ce24f411ae74be4100c349a212bd70b59e449a2b5",
      renderExportFileSha256: "2b5177c00bb054184a239c7eddb1383ad253922e8eb686f5aa2e56c91a1335ac",
      technicalQaEvidenceSha256: "7e836b809da7fe483ee140c5115e8a58b4b299109c279ccb16c0197be827ff0f"
    },
    {
      blindLabel: "B",
      genericFileName: "review-B.mp4",
      candidateId: "candidate-2",
      finalSha256: "cdae63d5ccce67332e607af7fd87b18c31da8dc77c2f0ce5182550321767286c",
      finalSize: 576763,
      renderExportDigest: "47b7d0dcaaf0277274c1990825025042e89272dd153e3752b15d29a515041d82",
      renderExportFileSha256: "b349b897f8f86bc9257e2622f564d6430f3864ff605ae4b82ba0cb09c59298f6",
      technicalQaEvidenceSha256: "41bce4934320d225e6a58847233702b4ae706a5bed85427272a1f309acb50d79"
    }
  ]
});

export const R18_CONSUMER_BINDINGS = Object.freeze({
  bridge: {
    contractVersion: "bridge.chat_file_attachment.v1",
    repository: "foto6/WebAIBridge",
    exactSha: "bfe6b043460b6c0c3d712cbcc7e0c9772d6bd3af",
    r25Branch: "agent/bridge-r25-file-attachment-20261001",
    r26Branch: "agent/bridge-r26-file-attachment-rehearsal-20261002",
    r25CiRunId: 36888741188,
    maxFileBytes: 500_000_000,
    livePass: false,
    noLiveDeploy: true,
    noCutover: true
  },
  growth: {
    repository: "foto6/video3",
    exactSha: "0f6824d7c3962ccee572b21a4e1a343e6470c1a9",
    r22Branch: "agent/growth-r22-direct-video-critic-20261001",
    r23Branch: "agent/growth-r23-critic-reedit-adapter-20261002",
    criticContract: "growth.web_video_critic.v1",
    pairwiseContract: "growth.web_video_critic_pairwise.v1",
    transportBindingContract: "growth.web_video_attachment_transport_binding.r22.v1",
    integrationState: "READY_FOR_EXPLICIT_LIVE_REHEARSAL",
    schemaBlobs: {
      manifest: "ab93d7d001f67b506b0829ada4a607d928d49e74",
      input: "b81dcc9d503c2d2386ce89538dfca1334f2f9e7c",
      output: "34c53a1f6159f6a9c21a6218ea706b08b2b23c8c",
      pairwise: "358382bea5147c5b2a893d9b758fa1220efc95a6"
    }
  }
});

function fail(code, message, details = null) {
  throw runtimeError(code, message, details);
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashFile(filePath) {
  if (!existsSync(filePath)) fail("direct_model_review_missing_file", `file is missing: ${filePath}`);
  const bytes = readFileSync(filePath);
  return { sha256: hashBytes(bytes), size: bytes.length };
}
function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("direct_model_review_invalid", `${label} must be lowercase SHA-256 hex`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("direct_model_review_invalid", `${label} must be exact Git SHA`);
  }
}
function exactKeys(value, fields, label) {
  if (!plain(value)) fail("direct_model_review_invalid", `${label} must be an object`);
  const expected = new Set(fields);
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length) fail("direct_model_review_invalid", `${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail("direct_model_review_invalid", `${label} unknown fields: ${extra.sort().join(", ")}`);
}
function safeChild(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("direct_model_review_invalid", `path escapes package root: ${relativePath}`);
  }
  return resolved;
}

export function validateR18AcceptedR17Bundle(bundle, {
  bundleFileSha256 = null,
  authority = R18_ACCEPTED_R17_AUTHORITY
} = {}) {
  const validated = validateWebChatReviewBundle(bundle);
  if (
    validated.review_bundle_producer.sha !== authority.producerSha ||
    stableStringify(validated.source) !== stableStringify(authority.source)
  ) fail("direct_model_review_upstream_mismatch", "R17 bundle authority/source mismatch");
  if (bundleFileSha256 !== null && bundleFileSha256 !== authority.bundleFile.sha256) {
    fail("direct_model_review_upstream_mismatch", "R17 bundle file hash mismatch");
  }
  for (const expected of authority.selectedCandidates) {
    const candidate = validated.candidates.find((entry) => entry.candidateId === expected.candidateId);
    if (!candidate) fail("direct_model_review_upstream_mismatch", `R17 candidate missing: ${expected.candidateId}`);
    if (
      candidate.final.sha256 !== expected.finalSha256 ||
      candidate.final.size !== expected.finalSize ||
      candidate.renderExport.digest !== expected.renderExportDigest ||
      candidate.renderExport.fileSha256 !== expected.renderExportFileSha256 ||
      candidate.technicalQa.evidenceSha256 !== expected.technicalQaEvidenceSha256 ||
      candidate.technicalQa.passed !== true
    ) fail("direct_model_review_upstream_mismatch", `R17 candidate lineage mismatch: ${expected.candidateId}`);
  }
  return validated;
}

export function buildDirectModelReviewPromptManifest({
  attachments,
  promptVersion = MEDIA_DIRECT_MODEL_REVIEW_PROMPT_VERSION
} = {}) {
  if (!Array.isArray(attachments) || attachments.length !== 2) {
    fail("direct_model_review_invalid", "prompt requires exactly two blinded attachments");
  }
  const prompt = {
    contractVersion: promptVersion,
    task: "blinded_pairwise_editorial_review",
    attachments: attachments.map((entry) => ({
      blindLabel: entry.blindLabel,
      fileName: entry.genericFileName,
      mimeType: "video/mp4"
    })),
    reviewInstructions: {
      inspectActualAttachedMp4: true,
      outputObservationShape: [
        "attachment_label",
        "start_ms",
        "end_ms",
        "defect_category",
        "severity",
        "evidence",
        "description",
        "proposed_edit",
        "confidence",
        "uncertainty"
      ],
      requiredMapping: "timestamp -> defect -> severity/evidence -> proposed edit",
      allowedSeverity: ["info", "minor", "major", "hard_failure"],
      requestPairwiseSelection: true,
      allowedPairwiseSelection: ["A", "B", "tie", "insufficient_evidence"],
      coverage: {
        requireInspectedRanges: true,
        uninspectedPossibleMustBeTrue: true,
        everyFrameInspectedMustBeFalse: true,
        requireNotes: true
      },
      evidenceBoundary: {
        humanGroundTruth: false,
        humanLabel: false,
        livePlatformEvidence: false,
        humanParityGateEligible: false,
        mediaTechnicalAuthorityOnly: true,
        modelVerdictPrepopulated: false
      }
    },
    growthOutputCompatibility: {
      criticContract: R18_CONSUMER_BINDINGS.growth.criticContract,
      pairwiseContract: R18_CONSUMER_BINDINGS.growth.pairwiseContract,
      integrationState: R18_CONSUMER_BINDINGS.growth.integrationState
    }
  };
  return validateDirectModelReviewPromptManifest(prompt);
}

export function validateDirectModelReviewPromptManifest(input) {
  const prompt = clone(input);
  exactKeys(prompt, [
    "contractVersion", "task", "attachments", "reviewInstructions",
    "growthOutputCompatibility"
  ], "prompt manifest");
  if (prompt.contractVersion !== MEDIA_DIRECT_MODEL_REVIEW_PROMPT_VERSION) {
    fail("direct_model_review_invalid", "prompt contractVersion mismatch");
  }
  if (prompt.task !== "blinded_pairwise_editorial_review") {
    fail("direct_model_review_invalid", "prompt task mismatch");
  }
  if (!Array.isArray(prompt.attachments) || prompt.attachments.length !== 2) {
    fail("direct_model_review_invalid", "prompt must contain two attachments");
  }
  if (stableStringify(prompt.attachments.map((x) => x.blindLabel)) !== stableStringify(["A", "B"])) {
    fail("direct_model_review_invalid", "prompt attachment order must be A then B");
  }
  for (const entry of prompt.attachments) {
    exactKeys(entry, ["blindLabel", "fileName", "mimeType"], "prompt attachment");
    if (!["A", "B"].includes(entry.blindLabel) || entry.mimeType !== "video/mp4") {
      fail("direct_model_review_invalid", "invalid prompt attachment");
    }
    if (!/^review-[AB]\.mp4$/.test(entry.fileName)) {
      fail("direct_model_review_blinding_failed", "model-facing attachment name is not generic");
    }
  }
  const serialized = stableStringify(prompt);
  if (/candidate-[0-9]+|foto6\/video2|[0-9a-f]{40}/.test(serialized)) {
    fail("direct_model_review_blinding_failed", "prompt leaks producer/candidate identity");
  }
  const instructions = prompt.reviewInstructions;
  if (
    instructions?.requiredMapping !== "timestamp -> defect -> severity/evidence -> proposed edit" ||
    instructions?.coverage?.uninspectedPossibleMustBeTrue !== true ||
    instructions?.coverage?.everyFrameInspectedMustBeFalse !== true ||
    instructions?.evidenceBoundary?.modelVerdictPrepopulated !== false
  ) fail("direct_model_review_invalid", "prompt review/coverage boundary mismatch");
  return prompt;
}

function validatePackagedAttachment(entry, expected) {
  exactKeys(entry, [
    "blindLabel", "genericFileName", "candidateBinding", "file",
    "attachmentEligibility", "derivative"
  ], "packaged attachment");
  if (entry.blindLabel !== expected.blindLabel || entry.genericFileName !== expected.genericFileName) {
    fail("direct_model_review_blinding_failed", "blind label/name mapping mismatch");
  }
  const binding = entry.candidateBinding;
  exactKeys(binding, [
    "candidateId", "sourceId", "sourceSha256", "sourceSize",
    "renderSha256", "renderSize", "renderExportDigest",
    "renderExportFileSha256", "renderProducerSha", "technicalQa"
  ], "candidate binding");
  if (
    binding.candidateId !== expected.candidateId ||
    binding.renderSha256 !== expected.finalSha256 ||
    binding.renderSize !== expected.finalSize ||
    binding.renderExportDigest !== expected.renderExportDigest ||
    binding.renderExportFileSha256 !== expected.renderExportFileSha256 ||
    binding.technicalQa.evidenceSha256 !== expected.technicalQaEvidenceSha256 ||
    binding.technicalQa.passed !== true
  ) fail("direct_model_review_upstream_mismatch", "candidate binding mismatch");
  sha256(entry.file.sha256, "attachment file sha256");
  if (!Number.isInteger(entry.file.size) || entry.file.size <= 0) fail("direct_model_review_invalid", "attachment file size invalid");
  if (entry.file.size > WEB_CHAT_REVIEW_MAX_FILE_BYTES) fail("direct_model_review_oversize", "attachment exceeds 500 MB");
  if (entry.derivative === null) {
    if (entry.file.sha256 !== expected.finalSha256 || entry.file.size !== expected.finalSize) {
      fail("direct_model_review_hash_mismatch", "original attachment bytes differ from selected candidate");
    }
  } else {
    validateReviewDerivativeProvenance(entry.derivative, {
      expectedOriginalSha256: expected.finalSha256,
      expectedDerivativeSha256: entry.file.sha256
    });
  }
}

export function validateDirectModelReviewPackage(input, {
  authority = R18_ACCEPTED_R17_AUTHORITY
} = {}) {
  const pkg = clone(input);
  exactKeys(pkg, [
    "contractVersion", "packageProducer", "upstreamReviewAuthority", "source",
    "reviewMode", "attachmentPolicy", "attachments", "promptManifest",
    "consumerBindings", "modelReview"
  ], "direct model review package");
  if (pkg.contractVersion !== MEDIA_DIRECT_MODEL_REVIEW_PACKAGE_VERSION) fail("direct_model_review_invalid", "package contractVersion mismatch");
  exactKeys(pkg.packageProducer, ["repository", "sha"], "packageProducer");
  if (pkg.packageProducer.repository !== "foto6/video2") fail("direct_model_review_invalid", "package producer repository mismatch");
  gitSha(pkg.packageProducer.sha, "packageProducer.sha");
  if (stableStringify(pkg.upstreamReviewAuthority) !== stableStringify(authority)) {
    fail("direct_model_review_upstream_mismatch", "R17 upstream authority mismatch");
  }
  if (stableStringify(pkg.source) !== stableStringify(authority.source)) fail("direct_model_review_upstream_mismatch", "package source mismatch");
  if (pkg.reviewMode !== "blinded_pairwise_actual_mp4") fail("direct_model_review_invalid", "review mode mismatch");
  if (
    pkg.attachmentPolicy?.maxBytesPerFile !== WEB_CHAT_REVIEW_MAX_FILE_BYTES ||
    pkg.attachmentPolicy?.derivativePolicy !== "explicit_and_provenance_bound_only"
  ) fail("direct_model_review_invalid", "attachment policy mismatch");
  if (!Array.isArray(pkg.attachments) || pkg.attachments.length !== 2) fail("direct_model_review_invalid", "package requires exactly two attachments");
  const ids = new Set();
  const hashes = new Set();
  pkg.attachments.forEach((entry, index) => {
    validatePackagedAttachment(entry, authority.selectedCandidates[index]);
    if (ids.has(entry.candidateBinding.candidateId)) fail("direct_model_review_duplicate_candidate", "duplicate candidate");
    ids.add(entry.candidateBinding.candidateId);
    if (hashes.has(entry.candidateBinding.renderSha256)) fail("direct_model_review_duplicate_render", "A/B requires distinct render bytes");
    hashes.add(entry.candidateBinding.renderSha256);
  });
  validateDirectModelReviewPromptManifest(pkg.promptManifest);
  if (stableStringify(pkg.consumerBindings) !== stableStringify(R18_CONSUMER_BINDINGS)) {
    fail("direct_model_review_consumer_binding_mismatch", "Bridge/Growth consumer binding mismatch");
  }
  if (
    pkg.modelReview?.performed !== false ||
    pkg.modelReview?.verdict !== null ||
    pkg.modelReview?.liveUploadPerformed !== false
  ) fail("direct_model_review_invalid", "Media must not fabricate model review or live upload");
  return pkg;
}

export function buildDirectModelReviewPackage({
  r17Bundle,
  r17Root,
  outputRoot,
  packageProducerSha,
  r17BundleFileSha256 = null,
  authority = R18_ACCEPTED_R17_AUTHORITY
} = {}) {
  gitSha(packageProducerSha, "packageProducerSha");
  const bundle = validateR18AcceptedR17Bundle(r17Bundle, {
    bundleFileSha256: r17BundleFileSha256,
    authority
  });
  mkdirSync(outputRoot, { recursive: true });

  const attachments = authority.selectedCandidates.map((expected) => {
    const candidate = bundle.candidates.find((entry) => entry.candidateId === expected.candidateId);
    if (!candidate) fail("direct_model_review_upstream_mismatch", "selected R17 candidate missing");
    if (candidate.attachmentEligibility?.eligible !== true || !candidate.reviewAttachment) {
      fail("direct_model_review_oversize", `selected candidate is not attachment-eligible: ${expected.candidateId}`);
    }

    const sourcePath = safeChild(r17Root, candidate.reviewAttachment.file.path);
    const sourceIdentity = hashFile(sourcePath);
    if (
      sourceIdentity.sha256 !== candidate.reviewAttachment.file.sha256 ||
      sourceIdentity.size !== candidate.reviewAttachment.file.size
    ) fail("direct_model_review_hash_mismatch", "R17 attachment bytes changed");

    const destinationPath = path.join(outputRoot, expected.genericFileName);
    copyFileSync(sourcePath, destinationPath);
    const copied = hashFile(destinationPath);
    if (copied.sha256 !== sourceIdentity.sha256 || copied.size !== sourceIdentity.size) {
      fail("direct_model_review_copy_mismatch", "blinded attachment copy changed bytes");
    }
    if (copied.size > WEB_CHAT_REVIEW_MAX_FILE_BYTES) {
      fail("direct_model_review_oversize", "selected attachment exceeds 500 MB");
    }

    let derivative = null;
    if (candidate.reviewAttachment.derivative !== null) {
      derivative = validateReviewDerivativeProvenance(candidate.reviewAttachment.derivative, {
        expectedOriginalSha256: expected.finalSha256,
        expectedDerivativeSha256: copied.sha256
      });
    }

    return {
      blindLabel: expected.blindLabel,
      genericFileName: expected.genericFileName,
      candidateBinding: {
        candidateId: expected.candidateId,
        sourceId: authority.source.sourceId,
        sourceSha256: authority.source.sha256,
        sourceSize: authority.source.size,
        renderSha256: expected.finalSha256,
        renderSize: expected.finalSize,
        renderExportDigest: expected.renderExportDigest,
        renderExportFileSha256: expected.renderExportFileSha256,
        renderProducerSha: bundle.upstream_media_authority.producerSha,
        technicalQa: clone(candidate.technicalQa)
      },
      file: {
        path: expected.genericFileName,
        name: expected.genericFileName,
        sha256: copied.sha256,
        size: copied.size,
        mimeType: "video/mp4"
      },
      attachmentEligibility: {
        eligible: true,
        maxBytes: WEB_CHAT_REVIEW_MAX_FILE_BYTES,
        reason: null
      },
      derivative
    };
  });

  const promptManifest = buildDirectModelReviewPromptManifest({ attachments });
  return validateDirectModelReviewPackage({
    contractVersion: MEDIA_DIRECT_MODEL_REVIEW_PACKAGE_VERSION,
    packageProducer: { repository: "foto6/video2", sha: packageProducerSha },
    upstreamReviewAuthority: clone(authority),
    source: clone(authority.source),
    reviewMode: "blinded_pairwise_actual_mp4",
    attachmentPolicy: {
      maxBytesPerFile: WEB_CHAT_REVIEW_MAX_FILE_BYTES,
      derivativePolicy: "explicit_and_provenance_bound_only"
    },
    attachments,
    promptManifest,
    consumerBindings: clone(R18_CONSUMER_BINDINGS),
    modelReview: {
      performed: false,
      verdict: null,
      liveUploadPerformed: false
    }
  }, { authority });
}

export function directModelReviewPackageDigest(pkg) {
  return fingerprint(validateDirectModelReviewPackage(pkg));
}
