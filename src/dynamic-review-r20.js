import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import path from "node:path";

import {
  buildDirectModelReviewPromptManifest,
  validateDirectModelReviewPromptManifest
} from "./direct-model-review-r18.js";
import {
  createBoundedReviewDerivative,
  WEB_CHAT_REVIEW_MAX_FILE_BYTES
} from "./web-chat-review-r17.js";
import {
  renderExportDigest,
  validateRenderExportAgainstFinal
} from "./render-export-r15.js";
import {
  validateEditorialReeditApplicationSidecar
} from "./editorial-reedit-r19.js";
import { fingerprint, stableStringify } from "./stable.js";
import { runtimeError } from "./runtime/errors.js";

export const MEDIA_DYNAMIC_REVIEW_PACKAGE_VERSION = "media.dynamic_review_package.r20.v1";
export const MEDIA_DYNAMIC_REVIEW_HANDOFF_VERSION = "media.bridge_live_review_handoff.r20.v1";
export const MEDIA_DYNAMIC_REVIEW_EVIDENCE_VERSION = "media.dynamic_review_package.r20.evidence.v1";
export const DYNAMIC_REVIEW_PACKAGE_READY = "DYNAMIC_REVIEW_PACKAGE_READY";
export const LIVE_MODEL_REVIEWED = "LIVE_MODEL_REVIEWED";

export const R20_BRIDGE_R29_AUTHORITY = Object.freeze({
  repository: "foto6/WebAIBridge",
  branch: "agent/bridge-r29-isolated-live-video-review-20261002",
  branchHeadSha: "8b314bd020b05d90f6c45fa861727df5e78e5a39",
  inheritedGreenBranch: "agent/bridge-r28-live-existing-chat-review-20261002",
  inheritedGreenCiRunId: 36983797963,
  requestContract: "bridge.existing_chat_video_review_request.v1",
  captureContract: "bridge.existing_chat_video_review_capture.v1",
  maxFileBytes: 500_000_000,
  r29WireFormatDivergedFromR28: false,
  liveModelReviewed: false
});

const CANDIDATE_FIELDS = Object.freeze([
  "candidateId",
  "roundNumber",
  "source",
  "render",
  "renderExport",
  "renderProducerSha",
  "editorialApplication",
  "reviewDerivative"
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
function exactKeys(value, fields, label) {
  if (!plain(value)) fail("dynamic_review_invalid", `${label} must be an object`);
  const expected = new Set(fields);
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length) fail("dynamic_review_invalid", `${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail("dynamic_review_invalid", `${label} unknown fields: ${extra.sort().join(", ")}`);
}
function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("dynamic_review_invalid", `${label} must be lowercase SHA-256 hex`);
  }
}
function gitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("dynamic_review_invalid", `${label} must be exact Git SHA`);
  }
}
function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail("dynamic_review_invalid", `${label} must be positive integer`);
}
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
function hashFile(filePath) {
  if (!existsSync(filePath)) fail("dynamic_review_missing_file", `missing file: ${filePath}`);
  const bytes = readFileSync(filePath);
  return { sha256: hashBytes(bytes), size: bytes.length };
}
function safePath(root, inputPath, label) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    fail("dynamic_review_invalid", `${label} must be a non-empty path`);
  }
  const resolved = path.resolve(root, inputPath);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("dynamic_review_path_escape", `${label} escapes sandbox root`);
  }
  return {
    absolute: resolved,
    relative: rel.split(path.sep).join("/")
  };
}
function sourceEvidenceMatches(renderExport, source) {
  return (renderExport.evidence?.sources?.items ?? []).some((entry) =>
    entry.sourceId === source.sourceId &&
    entry.sha256 === source.sha256 &&
    entry.size === source.size &&
    entry.probeOk === true
  );
}
function validateSourceShape(source, label) {
  exactKeys(source, ["sourceId", "sha256", "size", "path"], label);
  if (typeof source.sourceId !== "string" || !source.sourceId) fail("dynamic_review_invalid", `${label}.sourceId required`);
  sha256(source.sha256, `${label}.sha256`);
  positiveInt(source.size, `${label}.size`);
}
function validateRenderShape(render, label) {
  exactKeys(render, ["path", "sha256", "size"], label);
  sha256(render.sha256, `${label}.sha256`);
  positiveInt(render.size, `${label}.size`);
}
function validateRenderExportShape(renderExport, label) {
  exactKeys(renderExport, ["path", "fileSha256", "digest"], label);
  sha256(renderExport.fileSha256, `${label}.fileSha256`);
  sha256(renderExport.digest, `${label}.digest`);
}
function validateApplicationShape(application, label) {
  if (application === null) return;
  exactKeys(application, ["path", "fileSha256", "digest"], label);
  sha256(application.fileSha256, `${label}.fileSha256`);
  sha256(application.digest, `${label}.digest`);
}
function validateDerivativeRequest(value, label) {
  if (value === null) return;
  exactKeys(value, ["required", "reason", "settings"], label);
  if (value.required !== true) fail("dynamic_review_invalid", `${label}.required must be true when derivative request is present`);
  if (typeof value.reason !== "string" || !value.reason.trim()) fail("dynamic_review_invalid", `${label}.reason required`);
  if (value.settings !== null && !plain(value.settings)) fail("dynamic_review_invalid", `${label}.settings must be object or null`);
}

export function validateDynamicCandidateDescriptor(candidate) {
  exactKeys(candidate, CANDIDATE_FIELDS, "candidate");
  if (typeof candidate.candidateId !== "string" || !candidate.candidateId) {
    fail("dynamic_review_invalid", "candidateId required");
  }
  if (!Number.isInteger(candidate.roundNumber) || candidate.roundNumber < 0 || candidate.roundNumber > 2) {
    fail("dynamic_review_invalid", "roundNumber must be 0, 1 or 2");
  }
  validateSourceShape(candidate.source, "candidate.source");
  validateRenderShape(candidate.render, "candidate.render");
  validateRenderExportShape(candidate.renderExport, "candidate.renderExport");
  gitSha(candidate.renderProducerSha, "candidate.renderProducerSha");
  validateApplicationShape(candidate.editorialApplication, "candidate.editorialApplication");
  validateDerivativeRequest(candidate.reviewDerivative, "candidate.reviewDerivative");
  if (candidate.roundNumber === 0 && candidate.editorialApplication !== null) {
    fail("dynamic_review_lineage_mismatch", "round 0 candidate cannot bind an R19 editorial application");
  }
  if (candidate.roundNumber > 0 && candidate.editorialApplication === null) {
    fail("dynamic_review_lineage_mismatch", "re-edit round candidate requires R19 editorial application");
  }
  return clone(candidate);
}

export function dynamicReviewIntent(candidates) {
  if (!Array.isArray(candidates) || candidates.length !== 2) {
    fail("dynamic_review_invalid", "dynamic pairwise review requires exactly two candidates");
  }
  const rounds = candidates.map((candidate) => candidate.roundNumber);
  const maxRound = Math.max(...rounds);
  const minRound = Math.min(...rounds);
  if (maxRound - minRound > 1) {
    fail("dynamic_review_round_gap", "pairwise review cannot skip an intermediate re-edit round");
  }
  return {
    reviewRound: maxRound,
    intent: maxRound === 0 ? "initial_candidate_review" : "targeted_reedit_review"
  };
}

export function deterministicBlindAssignment(candidatesInput) {
  if (!Array.isArray(candidatesInput) || candidatesInput.length !== 2) {
    fail("dynamic_review_invalid", "exactly two candidate descriptors are required");
  }
  const candidates = candidatesInput.map(validateDynamicCandidateDescriptor);
  const ids = new Set();
  const renders = new Set();
  for (const candidate of candidates) {
    if (ids.has(candidate.candidateId)) fail("dynamic_review_duplicate_candidate", "duplicate candidate id");
    ids.add(candidate.candidateId);
    if (renders.has(candidate.render.sha256)) {
      fail("dynamic_review_duplicate_render", "byte-identical candidates are rejected before blinded comparison");
    }
    renders.add(candidate.render.sha256);
  }
  dynamicReviewIntent(candidates);
  return candidates
    .map((candidate) => ({
      candidate,
      sortKey: fingerprint({
        renderSha256: candidate.render.sha256,
        renderSize: candidate.render.size,
        renderExportDigest: candidate.renderExport.digest,
        editorialApplicationDigest: candidate.editorialApplication?.digest ?? null,
        roundNumber: candidate.roundNumber
      })
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map((entry, index) => ({
      blindLabel: index === 0 ? "A" : "B",
      genericFileName: `review-${index === 0 ? "A" : "B"}.mp4`,
      candidate: entry.candidate,
      sortKey: entry.sortKey
    }));
}

function verifyCandidateFiles(candidateInput, sandboxRoot) {
  const candidate = validateDynamicCandidateDescriptor(candidateInput);
  const sourcePath = safePath(sandboxRoot, candidate.source.path, "candidate.source.path");
  const renderPath = safePath(sandboxRoot, candidate.render.path, "candidate.render.path");
  const renderExportPath = safePath(sandboxRoot, candidate.renderExport.path, "candidate.renderExport.path");

  const sourceBytes = hashFile(sourcePath.absolute);
  if (sourceBytes.sha256 !== candidate.source.sha256 || sourceBytes.size !== candidate.source.size) {
    fail("dynamic_review_stale_source", "source bytes differ from candidate source binding");
  }
  const renderBytes = hashFile(renderPath.absolute);
  if (renderBytes.sha256 !== candidate.render.sha256 || renderBytes.size !== candidate.render.size) {
    fail("dynamic_review_stale_render", "render bytes differ from candidate render binding");
  }
  const renderExportBytes = hashFile(renderExportPath.absolute);
  if (renderExportBytes.sha256 !== candidate.renderExport.fileSha256) {
    fail("dynamic_review_stale_render_export", "render-export file digest mismatch");
  }
  const renderExport = validateRenderExportAgainstFinal(
    JSON.parse(readFileSync(renderExportPath.absolute, "utf8")),
    renderPath.absolute
  );
  const semanticRenderExportDigest = renderExportDigest(renderExport);
  if (
    semanticRenderExportDigest !== candidate.renderExport.digest ||
    renderExport.producer.sha !== candidate.renderProducerSha ||
    renderExport.artifact.sha256 !== candidate.render.sha256 ||
    renderExport.artifact.size !== candidate.render.size
  ) fail("dynamic_review_lineage_mismatch", "render export semantic lineage mismatch");
  if (!sourceEvidenceMatches(renderExport, candidate.source)) {
    fail("dynamic_review_lineage_mismatch", "render export does not bind exact source");
  }
  if (
    renderExport.qa?.technical?.passed !== true ||
    renderExport.qa?.technical?.value?.passed !== true
  ) fail("dynamic_review_technical_qa_failed", "candidate technical QA must pass");

  let editorial = null;
  let editorialPath = null;
  let editorialBytes = null;
  if (candidate.editorialApplication !== null) {
    editorialPath = safePath(sandboxRoot, candidate.editorialApplication.path, "candidate.editorialApplication.path");
    editorialBytes = hashFile(editorialPath.absolute);
    if (editorialBytes.sha256 !== candidate.editorialApplication.fileSha256) {
      fail("dynamic_review_stale_editorial_application", "R19 application file digest mismatch");
    }
    editorial = validateEditorialReeditApplicationSidecar(
      JSON.parse(readFileSync(editorialPath.absolute, "utf8"))
    );
    const applicationDigest = fingerprint(editorial);
    if (applicationDigest !== candidate.editorialApplication.digest) {
      fail("dynamic_review_stale_editorial_application", "R19 application semantic digest mismatch");
    }
    if (
      editorial.output.sha256 !== candidate.render.sha256 ||
      editorial.output.size !== candidate.render.size ||
      editorial.output.renderExportSha256 !== candidate.renderExport.fileSha256 ||
      editorial.producer.sha !== candidate.renderProducerSha ||
      stableStringify(editorial.input.source) !== stableStringify({
        sourceId: candidate.source.sourceId,
        sha256: candidate.source.sha256,
        size: candidate.source.size
      }) ||
      candidate.roundNumber !== editorial.handoff.reeditRound + 1
    ) fail("dynamic_review_lineage_mismatch", "R19 application does not bind this exact re-edit candidate/round");
  }

  return {
    candidate,
    sourcePath,
    renderPath,
    renderExportPath,
    sourceBytes,
    renderBytes,
    renderExportBytes,
    renderExport,
    semanticRenderExportDigest,
    editorial,
    editorialPath,
    editorialBytes
  };
}

function assertCommonSource(verified) {
  const source = verified[0].candidate.source;
  for (const row of verified.slice(1)) {
    if (
      row.candidate.source.sourceId !== source.sourceId ||
      row.candidate.source.sha256 !== source.sha256 ||
      row.candidate.source.size !== source.size
    ) fail("dynamic_review_source_mismatch", "pairwise candidates must bind the same exact source");
  }
  return clone(source);
}

function assertPromptDoesNotLeak(prompt, verified) {
  const serialized = stableStringify(prompt);
  const secrets = new Set();
  for (const row of verified) {
    secrets.add(row.candidate.candidateId);
    secrets.add(row.candidate.source.sourceId);
    secrets.add(row.candidate.source.sha256);
    secrets.add(row.candidate.render.sha256);
    secrets.add(row.candidate.renderExport.digest);
    secrets.add(row.candidate.renderExport.fileSha256);
    secrets.add(row.candidate.renderProducerSha);
    if (row.candidate.editorialApplication) {
      secrets.add(row.candidate.editorialApplication.digest);
      secrets.add(row.candidate.editorialApplication.fileSha256);
    }
  }
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) {
      fail("dynamic_review_blinding_failed", "model-facing prompt leaks sealed candidate/source/producer lineage");
    }
  }
}

function packageAttachment({ assigned, verified, outputRoot }) {
  const destination = path.join(outputRoot, assigned.genericFileName);
  let derivative = null;
  if (verified.candidate.reviewDerivative?.required === true) {
    const provenance = createBoundedReviewDerivative({
      originalPath: verified.renderPath.absolute,
      derivativePath: destination,
      settings: verified.candidate.reviewDerivative.settings ?? undefined
    });
    derivative = {
      reason: verified.candidate.reviewDerivative.reason,
      ...provenance
    };
  } else {
    if (verified.renderBytes.size > WEB_CHAT_REVIEW_MAX_FILE_BYTES) {
      fail("dynamic_review_oversize", "original candidate exceeds 500 MB and no explicit derivative was requested");
    }
    copyFileSync(verified.renderPath.absolute, destination);
  }

  const packaged = hashFile(destination);
  if (packaged.size > WEB_CHAT_REVIEW_MAX_FILE_BYTES) {
    fail("dynamic_review_oversize", "review attachment exceeds 500 MB");
  }
  if (derivative === null && (
    packaged.sha256 !== verified.renderBytes.sha256 ||
    packaged.size !== verified.renderBytes.size
  )) fail("dynamic_review_copy_mismatch", "original-byte review copy changed bytes");

  return {
    blindLabel: assigned.blindLabel,
    genericFileName: assigned.genericFileName,
    mimeType: "video/mp4",
    file: {
      path: assigned.genericFileName,
      sha256: packaged.sha256,
      size: packaged.size
    },
    derivative
  };
}

export function validateDynamicReviewPackage(input) {
  const pkg = clone(input);
  exactKeys(pkg, [
    "contractVersion",
    "state",
    "packageProducer",
    "bridgeAuthority",
    "source",
    "reviewContext",
    "attachments",
    "promptManifest",
    "promptDigest",
    "sealedMapping",
    "bridgeHandoff",
    "modelReview",
    "humanQuality"
  ], "dynamic review package");
  if (pkg.contractVersion !== MEDIA_DYNAMIC_REVIEW_PACKAGE_VERSION) {
    fail("dynamic_review_invalid", "contractVersion mismatch");
  }
  if (pkg.state !== DYNAMIC_REVIEW_PACKAGE_READY) {
    fail("dynamic_review_invalid", "Media may only emit DYNAMIC_REVIEW_PACKAGE_READY");
  }
  exactKeys(pkg.packageProducer, ["repository", "sha"], "packageProducer");
  if (pkg.packageProducer.repository !== "foto6/video2") fail("dynamic_review_invalid", "package producer repository mismatch");
  gitSha(pkg.packageProducer.sha, "packageProducer.sha");
  if (stableStringify(pkg.bridgeAuthority) !== stableStringify(R20_BRIDGE_R29_AUTHORITY)) {
    fail("dynamic_review_consumer_binding_mismatch", "Bridge R29 authority drift");
  }
  validateSourceShape({ ...pkg.source, path: pkg.source.path ?? "sealed" }, "package.source");
  if (!["initial_candidate_review", "targeted_reedit_review"].includes(pkg.reviewContext?.intent)) {
    fail("dynamic_review_invalid", "review intent invalid");
  }
  if (!Number.isInteger(pkg.reviewContext?.reviewRound) || pkg.reviewContext.reviewRound < 0 || pkg.reviewContext.reviewRound > 2) {
    fail("dynamic_review_invalid", "review round invalid");
  }
  if (!Array.isArray(pkg.attachments) || pkg.attachments.length !== 2) fail("dynamic_review_invalid", "package requires A/B attachments");
  if (pkg.attachments[0].blindLabel !== "A" || pkg.attachments[1].blindLabel !== "B") {
    fail("dynamic_review_blinding_failed", "attachments must be ordered A then B");
  }
  for (const attachment of pkg.attachments) {
    if (!/^review-[AB]\.mp4$/.test(attachment.genericFileName) || attachment.mimeType !== "video/mp4") {
      fail("dynamic_review_blinding_failed", "model-facing attachment identity invalid");
    }
    sha256(attachment.file.sha256, "attachment.file.sha256");
    positiveInt(attachment.file.size, "attachment.file.size");
    if (attachment.file.size > WEB_CHAT_REVIEW_MAX_FILE_BYTES) fail("dynamic_review_oversize", "attachment exceeds Bridge limit");
    if (attachment.derivative !== null) {
      if (attachment.derivative.derivative_for_model_review !== true) {
        fail("dynamic_review_invalid", "derivative_for_model_review must be true");
      }
      sha256(attachment.derivative.originalSha256, "derivative.originalSha256");
      sha256(attachment.derivative.derivativeSha256, "derivative.derivativeSha256");
      sha256(attachment.derivative.settingsDigest, "derivative.settingsDigest");
    }
  }
  validateDirectModelReviewPromptManifest(pkg.promptManifest);
  if (hashText(pkg.promptManifest.promptText) !== pkg.promptDigest) {
    fail("dynamic_review_invalid", "prompt digest mismatch");
  }
  if (
    !plain(pkg.sealedMapping) ||
    !Array.isArray(pkg.sealedMapping.entries) ||
    pkg.sealedMapping.entries.length !== 2 ||
    fingerprint(pkg.sealedMapping.entries) !== pkg.sealedMapping.digest
  ) fail("dynamic_review_invalid", "sealed mapping digest mismatch");
  if (pkg.bridgeHandoff?.contractVersion !== MEDIA_DYNAMIC_REVIEW_HANDOFF_VERSION) {
    fail("dynamic_review_invalid", "Bridge handoff contract mismatch");
  }
  if (
    pkg.bridgeHandoff.state !== DYNAMIC_REVIEW_PACKAGE_READY ||
    pkg.bridgeHandoff.promptDigest !== pkg.promptDigest ||
    pkg.bridgeHandoff.sealedMappingDigest !== pkg.sealedMapping.digest
  ) fail("dynamic_review_invalid", "Bridge handoff/package binding mismatch");
  if (
    pkg.modelReview?.performed !== false ||
    pkg.modelReview?.state !== DYNAMIC_REVIEW_PACKAGE_READY ||
    pkg.modelReview?.nextState !== LIVE_MODEL_REVIEWED ||
    pkg.modelReview?.capture !== null
  ) fail("dynamic_review_invalid", "Media review state boundary invalid");
  if (pkg.humanQuality !== false) fail("dynamic_review_invalid", "humanQuality must remain false");
  return pkg;
}

export function materializeBridgeExistingChatReviewRequest(pkgInput, packageRoot) {
  const pkg = validateDynamicReviewPackage(pkgInput);
  const handoff = pkg.bridgeHandoff;
  const target = handoff.target;
  const request = {
    contract: R20_BRIDGE_R29_AUTHORITY.requestContract,
    requestId: handoff.requestId,
    idempotencyKey: handoff.idempotencyKey,
    managedChatId: target.managedChatId,
    profileId: target.profileId,
    conversationId: target.conversationId,
    titleHint: target.titleHint,
    expectedAccountMarkerHash: target.expectedAccountMarkerHash,
    prompt: pkg.promptManifest.promptText,
    attachments: pkg.attachments.map((attachment) => ({
      blindedName: attachment.genericFileName,
      filePath: path.resolve(packageRoot, attachment.file.path),
      expectedSize: attachment.file.size,
      expectedSha256: attachment.file.sha256
    }))
  };
  const names = new Set();
  for (const attachment of request.attachments) {
    if (path.basename(attachment.filePath) !== attachment.blindedName) {
      fail("dynamic_review_bridge_handoff_invalid", "Bridge blindedName must equal attachment basename");
    }
    if (names.has(attachment.blindedName)) fail("dynamic_review_bridge_handoff_invalid", "duplicate Bridge blindedName");
    names.add(attachment.blindedName);
    const actual = hashFile(attachment.filePath);
    if (actual.sha256 !== attachment.expectedSha256 || actual.size !== attachment.expectedSize) {
      fail("dynamic_review_bridge_handoff_invalid", "Bridge attachment bytes differ from package");
    }
  }
  if (
    typeof request.managedChatId !== "string" || !request.managedChatId ||
    typeof request.profileId !== "string" || !request.profileId ||
    typeof request.conversationId !== "string" || !request.conversationId
  ) fail("dynamic_review_bridge_handoff_invalid", "Bridge target routing is incomplete");
  return request;
}

export function buildDynamicReviewPackage({
  candidates,
  packageProducerSha,
  sandboxRoot = process.cwd(),
  outputRoot,
  bridgeTarget,
  duplicatePolicy = "reject"
} = {}) {
  gitSha(packageProducerSha, "packageProducerSha");
  if (duplicatePolicy !== "reject") fail("dynamic_review_invalid", "R20 duplicatePolicy currently supports explicit reject only");
  if (!outputRoot) fail("dynamic_review_invalid", "outputRoot required");
  const outputPath = safePath(sandboxRoot, path.relative(sandboxRoot, path.resolve(outputRoot)), "outputRoot");
  mkdirSync(outputPath.absolute, { recursive: true });
  if (!plain(bridgeTarget)) fail("dynamic_review_invalid", "bridgeTarget required");
  exactKeys(bridgeTarget, [
    "managedChatId",
    "profileId",
    "conversationId",
    "titleHint",
    "expectedAccountMarkerHash"
  ], "bridgeTarget");

  const assignments = deterministicBlindAssignment(candidates);
  const verifiedById = new Map(
    candidates.map((candidate) => {
      const verified = verifyCandidateFiles(candidate, sandboxRoot);
      return [verified.candidate.candidateId, verified];
    })
  );
  const verified = assignments.map((assignment) => verifiedById.get(assignment.candidate.candidateId));
  const commonSource = assertCommonSource(verified);
  const reviewContext = dynamicReviewIntent(verified.map((row) => row.candidate));

  const attachments = assignments.map((assignment) =>
    packageAttachment({
      assigned: assignment,
      verified: verifiedById.get(assignment.candidate.candidateId),
      outputRoot: outputPath.absolute
    })
  );

  const promptManifest = buildDirectModelReviewPromptManifest({ attachments });
  assertPromptDoesNotLeak(promptManifest, verified);
  const promptDigest = hashText(promptManifest.promptText);

  const sealedEntries = assignments.map((assignment, index) => {
    const row = verifiedById.get(assignment.candidate.candidateId);
    const attachment = attachments[index];
    return {
      blindLabel: assignment.blindLabel,
      genericFileName: assignment.genericFileName,
      candidateId: row.candidate.candidateId,
      roundNumber: row.candidate.roundNumber,
      source: {
        sourceId: row.candidate.source.sourceId,
        sha256: row.candidate.source.sha256,
        size: row.candidate.source.size,
        artifactPath: row.sourcePath.relative
      },
      render: {
        sha256: row.candidate.render.sha256,
        size: row.candidate.render.size,
        artifactPath: row.renderPath.relative
      },
      renderExport: {
        digest: row.candidate.renderExport.digest,
        fileSha256: row.candidate.renderExport.fileSha256,
        artifactPath: row.renderExportPath.relative
      },
      editorialApplication: row.candidate.editorialApplication === null ? null : {
        digest: row.candidate.editorialApplication.digest,
        fileSha256: row.candidate.editorialApplication.fileSha256,
        artifactPath: row.editorialPath.relative,
        inputCandidateId: row.editorial.input.candidateId,
        inputRenderSha256: row.editorial.input.renderSha256,
        handoffDigest: row.editorial.handoff.digest,
        reeditRound: row.editorial.handoff.reeditRound
      },
      renderProducerSha: row.candidate.renderProducerSha,
      attachment: {
        sha256: attachment.file.sha256,
        size: attachment.file.size,
        mimeType: attachment.mimeType,
        derivative_for_model_review: attachment.derivative?.derivative_for_model_review === true,
        derivative: attachment.derivative
      }
    };
  });
  const sealedMapping = {
    digest: fingerprint(sealedEntries),
    entries: sealedEntries
  };

  const requestCore = {
    sourceSha256: commonSource.sha256,
    sourceSize: commonSource.size,
    reviewRound: reviewContext.reviewRound,
    sealedMappingDigest: sealedMapping.digest,
    promptDigest
  };
  const requestId = `r20-review-${fingerprint(requestCore).slice(0, 24)}`;
  const idempotencyKey = `r20:${fingerprint({ ...requestCore, target: bridgeTarget })}`;

  const bridgeHandoff = {
    contractVersion: MEDIA_DYNAMIC_REVIEW_HANDOFF_VERSION,
    state: DYNAMIC_REVIEW_PACKAGE_READY,
    bridgeAuthority: clone(R20_BRIDGE_R29_AUTHORITY),
    requestId,
    idempotencyKey,
    target: clone(bridgeTarget),
    transportContract: R20_BRIDGE_R29_AUTHORITY.requestContract,
    promptDigest,
    sealedMappingDigest: sealedMapping.digest,
    attachments: attachments.map((attachment) => ({
      blindLabel: attachment.blindLabel,
      genericFileName: attachment.genericFileName,
      relativePath: attachment.file.path,
      sha256: attachment.file.sha256,
      size: attachment.file.size,
      mimeType: attachment.mimeType
    })),
    liveExecutionPerformed: false
  };

  const pkg = validateDynamicReviewPackage({
    contractVersion: MEDIA_DYNAMIC_REVIEW_PACKAGE_VERSION,
    state: DYNAMIC_REVIEW_PACKAGE_READY,
    packageProducer: { repository: "foto6/video2", sha: packageProducerSha },
    bridgeAuthority: clone(R20_BRIDGE_R29_AUTHORITY),
    source: {
      sourceId: commonSource.sourceId,
      sha256: commonSource.sha256,
      size: commonSource.size,
      path: commonSource.path
    },
    reviewContext,
    attachments,
    promptManifest,
    promptDigest,
    sealedMapping,
    bridgeHandoff,
    modelReview: {
      performed: false,
      state: DYNAMIC_REVIEW_PACKAGE_READY,
      nextState: LIVE_MODEL_REVIEWED,
      capture: null
    },
    humanQuality: false
  });

  return {
    package: pkg,
    packageDigest: fingerprint(pkg),
    sealedMappingDigest: sealedMapping.digest,
    promptDigest,
    bridgeRequest: materializeBridgeExistingChatReviewRequest(pkg, outputPath.absolute)
  };
}
