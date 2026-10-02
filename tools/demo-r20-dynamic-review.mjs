import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeterministicProcessExecutor,
  FfmpegQaProbe,
  MEDIA_JOB_CONTRACT_VERSION,
  MediaJobProtocolV1,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  ShortformFfmpegExecutor,
  buildSucceededRenderExport,
  fingerprint,
  renderExportDigest,
  stableStringify,
  writeRenderExportSidecar
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r19Root = path.join(repoRoot, ".artifacts", "r19-demo");
const root = path.join(repoRoot, ".artifacts", "r20-demo");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

function run(binary, args, options = {}) {
  return execFileSync(binary, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
}
function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}
function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${stableStringify(value)}\n`);
}
function repoRel(filePath) {
  const rel = path.relative(repoRoot, filePath).split(path.sep).join("/");
  if (!rel || rel.startsWith("../") || path.isAbsolute(rel)) throw new Error("path escapes repo root");
  return rel;
}
function prefixTimelineSources(timeline) {
  const copy = structuredClone(timeline);
  for (const track of copy.tracks ?? []) {
    for (const item of track.items ?? []) {
      if (item.source?.uri) {
        item.source.uri = path.posix.join(".artifacts/r19-demo", item.source.uri.replaceAll("\\", "/"));
      }
    }
  }
  return copy;
}

if (!existsSync(path.join(r19Root, "cases", "talking-head-vertical", "after", "final.mp4"))) {
  run(process.execPath, [path.join(repoRoot, "tools", "demo-r19-editorial-reedit.mjs")]);
}

const producerSha = run("git", ["rev-parse", "HEAD"]).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}

const caseRoot = path.join(r19Root, "cases", "talking-head-vertical");
const r19Request = JSON.parse(readFileSync(path.join(caseRoot, "request.json"), "utf8"));
const sourcePath = path.join(r19Root, "corpus", "talking-head-pauses.mp4");
const sourceBytes = hashFile(sourcePath);
if (
  sourceBytes.sha256 !== r19Request.candidate.source.sha256 ||
  sourceBytes.size !== r19Request.candidate.source.size
) throw new Error("R19 rehearsal source bytes drifted");

function descriptorFromExisting({
  candidateId,
  roundNumber,
  finalPath,
  renderExportPath,
  editorialApplicationPath = null
}) {
  const final = hashFile(finalPath);
  const renderExportFile = hashFile(renderExportPath);
  const renderExport = JSON.parse(readFileSync(renderExportPath, "utf8"));
  const descriptor = {
    candidateId,
    roundNumber,
    source: {
      sourceId: r19Request.candidate.source.sourceId,
      sha256: sourceBytes.sha256,
      size: sourceBytes.size,
      path: repoRel(sourcePath)
    },
    render: {
      path: repoRel(finalPath),
      sha256: final.sha256,
      size: final.size
    },
    renderExport: {
      path: repoRel(renderExportPath),
      fileSha256: renderExportFile.sha256,
      digest: renderExportDigest(renderExport)
    },
    renderProducerSha: renderExport.producer.sha,
    editorialApplication: null,
    reviewDerivative: null
  };
  if (editorialApplicationPath) {
    const appFile = hashFile(editorialApplicationPath);
    const app = JSON.parse(readFileSync(editorialApplicationPath, "utf8"));
    descriptor.editorialApplication = {
      path: repoRel(editorialApplicationPath),
      fileSha256: appFile.sha256,
      digest: fingerprint(app)
    };
  }
  return descriptor;
}

const baseline = descriptorFromExisting({
  candidateId: "r20-initial-control",
  roundNumber: 0,
  finalPath: path.join(caseRoot, "before", "final.mp4"),
  renderExportPath: path.join(caseRoot, "before", "media.render_export.v1.json")
});

async function renderInitialAlternative() {
  const outputRoot = path.join(root, "initial-alt");
  mkdirSync(outputRoot, { recursive: true });
  const timeline = prefixTimelineSources(r19Request.timeline);
  timeline.id = "r20-initial-alternative";
  const video = timeline.tracks.find((track) => track.kind === "video");
  if (!video?.items?.length) throw new Error("R19 baseline timeline has no video");
  video.items[0].motion = { type: "punch_in", zoom: 1.04 };

  const store = new PersistentRenderJobStore({
    filePath: path.join(outputRoot, "render-jobs.json")
  });
  const processExecutor = new DeterministicProcessExecutor({
    defaultTimeoutMs: 180000,
    maxOutputBytes: 4 * 1024 * 1024
  });
  const renderer = new ShortformFfmpegExecutor({
    store,
    sandboxRoot: repoRoot,
    executor: processExecutor
  });
  const probe = new FfmpegQaProbe({ store, sandboxRoot: repoRoot });
  const runtime = new RenderRuntimeV2({
    store,
    executor: renderer,
    probe,
    sandboxRoot: repoRoot,
    liveExecutionEnabled: true,
    maxConcurrency: 1,
    resourceLimits: { render: 1, probe: 1 },
    processTimeoutMs: 180000
  });
  const protocol = new MediaJobProtocolV1(runtime);
  const finalPath = path.join(outputRoot, "final.mp4");
  const jobId = "r20-initial-alternative";
  await protocol.handle({
    contractVersion: MEDIA_JOB_CONTRACT_VERSION,
    action: "submit",
    idempotencyKey: `r20:initial-alt:${producerSha}`,
    request: {
      contractVersion: "media.render.v1",
      jobId,
      timeline,
      exportSpec: r19Request.exportSpec,
      outputPath: repoRel(finalPath),
      dryRun: false
    }
  });
  let response;
  for (let i = 0; i < 32; i += 1) {
    response = await protocol.handle({
      contractVersion: MEDIA_JOB_CONTRACT_VERSION,
      action: "resume_or_poll",
      jobId
    });
    if (response.terminal) break;
  }
  const job = store.get(jobId);
  if (!job || job.status !== "succeeded") {
    throw new Error(`R20 initial alternative render failed: ${stableStringify(job?.failure ?? null)}`);
  }
  const artifactManifest = runtime.exportArtifactManifest(jobId);
  const exportRecord = buildSucceededRenderExport({
    job,
    finalPath: job.resolvedOutputPath,
    artifactManifest,
    producerSha
  });
  const renderExportPath = path.join(outputRoot, "media.render_export.v1.json");
  writeRenderExportSidecar(exportRecord, renderExportPath);
  return descriptorFromExisting({
    candidateId: "r20-initial-alternative",
    roundNumber: 0,
    finalPath,
    renderExportPath
  });
}

const initialAlternative = await renderInitialAlternative();
if (initialAlternative.render.sha256 === baseline.render.sha256) {
  throw new Error("initial R20 candidates are byte-identical");
}

const reedit = descriptorFromExisting({
  candidateId: "r20-targeted-reedit-round-1",
  roundNumber: 1,
  finalPath: path.join(caseRoot, "after", "final.mp4"),
  renderExportPath: path.join(caseRoot, "after", "media.render_export.v1.json"),
  editorialApplicationPath: path.join(caseRoot, "after", "media.editorial_reedit_application.v1.json")
});
if (!reedit.editorialApplication) throw new Error("round-1 R19 application missing");

const bridgeTarget = {
  managedChatId: "r20-rehearsal-managed-chat",
  profileId: "r20-rehearsal-profile",
  conversationId: "r20-rehearsal-conversation",
  titleHint: "R20 isolated rehearsal target",
  expectedAccountMarkerHash: ""
};

function runPackage(name, candidates) {
  const outputRoot = path.join(root, name);
  const request = {
    contractVersion: "media.dynamic_review_request.r20.v1",
    duplicatePolicy: "reject",
    bridgeTarget,
    candidates
  };
  const requestPath = path.join(root, `${name}-request.json`);
  writeJson(requestPath, request);
  const args = [
    path.join(repoRoot, "tools", "build-r20-dynamic-review.mjs"),
    "--request", requestPath,
    "--sandbox-root", repoRoot,
    "--output-dir", outputRoot
  ];
  const first = run(process.execPath, args);
  const packagePath = path.join(outputRoot, "media.dynamic_review_package.r20.v1.json");
  const packageBeforeReplay = readFileSync(packagePath, "utf8");
  const replay = run(process.execPath, args);
  const packageAfterReplay = readFileSync(packagePath, "utf8");
  if (packageBeforeReplay !== packageAfterReplay) throw new Error(`${name} package changed on replay`);

  const pkg = JSON.parse(packageBeforeReplay);
  const evidence = JSON.parse(readFileSync(
    path.join(outputRoot, "media.dynamic_review_package.r20.evidence.json"),
    "utf8"
  ));
  const bridgeRequest = JSON.parse(readFileSync(
    path.join(outputRoot, "bridge.existing_chat_video_review_request.v1.json"),
    "utf8"
  ));
  const promptText = JSON.stringify(pkg.promptManifest);
  const secrets = [
    ...candidates.flatMap((candidate) => [
      candidate.candidateId,
      candidate.source.sourceId,
      candidate.source.sha256,
      candidate.render.sha256,
      candidate.renderExport.digest,
      candidate.renderProducerSha,
      candidate.editorialApplication?.digest ?? ""
    ])
  ].filter(Boolean);
  for (const secret of secrets) {
    if (promptText.includes(secret)) throw new Error(`${name} prompt leaked sealed lineage`);
  }
  if (pkg.state !== "DYNAMIC_REVIEW_PACKAGE_READY") throw new Error("R20 package state mismatch");
  if (pkg.modelReview.performed !== false || pkg.modelReview.nextState !== "LIVE_MODEL_REVIEWED") {
    throw new Error("R20 model-review state boundary mismatch");
  }
  if (pkg.humanQuality !== false || evidence.humanQuality !== false) throw new Error("R20 human-quality claim forbidden");
  if (bridgeRequest.contract !== "bridge.existing_chat_video_review_request.v1") {
    throw new Error("R20 Bridge request contract mismatch");
  }

  const mappingByLabel = new Map(pkg.sealedMapping.entries.map((entry) => [entry.blindLabel, entry]));
  for (const attachment of pkg.attachments) {
    const mapping = mappingByLabel.get(attachment.blindLabel);
    if (!mapping) throw new Error("sealed mapping missing attachment label");
    const attachmentBytes = hashFile(path.join(outputRoot, attachment.file.path));
    if (
      attachmentBytes.sha256 !== attachment.file.sha256 ||
      attachmentBytes.size !== attachment.file.size
    ) throw new Error("packaged attachment bytes differ from package identity");
    if (mapping.attachment.derivative_for_model_review !== true &&
        attachmentBytes.sha256 !== mapping.render.sha256) {
      throw new Error("non-derivative review attachment did not preserve render bytes");
    }
  }

  return {
    request,
    pkg,
    evidence,
    bridgeRequest,
    packageFile: hashFile(packagePath),
    sealedMappingFile: hashFile(path.join(outputRoot, "media.dynamic_review_sealed_mapping.r20.v1.json")),
    promptFile: hashFile(path.join(outputRoot, "media.direct_model_review_prompt.v1.json")),
    handoffFile: hashFile(path.join(outputRoot, "media.bridge_live_review_handoff.r20.v1.json")),
    bridgeRequestFile: hashFile(path.join(outputRoot, "bridge.existing_chat_video_review_request.v1.json")),
    firstRunLogSha256: createHash("sha256").update(first).digest("hex"),
    replayLogSha256: createHash("sha256").update(replay).digest("hex"),
    replayStable: true
  };
}

const initial = runPackage("initial-review", [baseline, initialAlternative]);
if (initial.pkg.reviewContext.intent !== "initial_candidate_review" ||
    initial.pkg.reviewContext.reviewRound !== 0) {
  throw new Error("initial R20 review context mismatch");
}

const targeted = runPackage("targeted-reedit-review", [baseline, reedit]);
if (targeted.pkg.reviewContext.intent !== "targeted_reedit_review" ||
    targeted.pkg.reviewContext.reviewRound !== 1) {
  throw new Error("targeted R20 review context mismatch");
}
const roundOneMapping = targeted.pkg.sealedMapping.entries.find((entry) => entry.roundNumber === 1);
if (
  !roundOneMapping ||
  roundOneMapping.editorialApplication?.digest !== reedit.editorialApplication.digest ||
  roundOneMapping.render.sha256 !== reedit.render.sha256 ||
  roundOneMapping.source.sha256 !== reedit.source.sha256
) throw new Error("targeted R20 sealed mapping lost R19 re-edit lineage");

const summary = {
  evidenceVersion: "media.dynamic_review_package.r20.demo.v1",
  producer: { repository: "foto6/video2", sha: producerSha },
  state: "DYNAMIC_REVIEW_PACKAGE_READY",
  nextState: "LIVE_MODEL_REVIEWED",
  bridgeAuthority: targeted.pkg.bridgeAuthority,
  source: {
    sourceId: baseline.source.sourceId,
    sha256: baseline.source.sha256,
    size: baseline.source.size
  },
  initialReview: {
    reviewContext: initial.pkg.reviewContext,
    packageDigest: fingerprint(initial.pkg),
    packageFileSha256: initial.packageFile.sha256,
    sealedMappingDigest: initial.pkg.sealedMapping.digest,
    sealedMappingFileSha256: initial.sealedMappingFile.sha256,
    promptDigest: initial.pkg.promptDigest,
    promptFileSha256: initial.promptFile.sha256,
    handoffFileSha256: initial.handoffFile.sha256,
    bridgeRequestFileSha256: initial.bridgeRequestFile.sha256,
    attachments: initial.pkg.attachments.map((attachment) => ({
      blindLabel: attachment.blindLabel,
      fileName: attachment.genericFileName,
      sha256: attachment.file.sha256,
      size: attachment.file.size,
      derivative_for_model_review: attachment.derivative?.derivative_for_model_review === true
    })),
    sealedMapping: initial.pkg.sealedMapping,
    replayStable: initial.replayStable
  },
  targetedReeditReview: {
    reviewContext: targeted.pkg.reviewContext,
    packageDigest: fingerprint(targeted.pkg),
    packageFileSha256: targeted.packageFile.sha256,
    sealedMappingDigest: targeted.pkg.sealedMapping.digest,
    sealedMappingFileSha256: targeted.sealedMappingFile.sha256,
    promptDigest: targeted.pkg.promptDigest,
    promptFileSha256: targeted.promptFile.sha256,
    handoffFileSha256: targeted.handoffFile.sha256,
    bridgeRequestFileSha256: targeted.bridgeRequestFile.sha256,
    attachments: targeted.pkg.attachments.map((attachment) => ({
      blindLabel: attachment.blindLabel,
      fileName: attachment.genericFileName,
      sha256: attachment.file.sha256,
      size: attachment.file.size,
      derivative_for_model_review: attachment.derivative?.derivative_for_model_review === true
    })),
    sealedMapping: targeted.pkg.sealedMapping,
    roundOneLineage: roundOneMapping,
    replayStable: targeted.replayStable
  },
  initialCandidatesDistinct: baseline.render.sha256 !== initialAlternative.render.sha256,
  targetedCandidatesDistinct: baseline.render.sha256 !== reedit.render.sha256,
  allAttachmentsOriginalBytes: [...initial.pkg.attachments, ...targeted.pkg.attachments]
    .every((attachment) => attachment.derivative === null),
  modelReviewPerformed: false,
  liveModelReviewed: false,
  liveUploadPerformed: false,
  providerPublishPerformed: false,
  humanQuality: false
};
writeJson(path.join(root, "r20-readiness-evidence.json"), summary);
console.log("R20_DEMO", stableStringify(summary));
