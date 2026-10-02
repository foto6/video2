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
  DeterministicProcessExecutor,
  FfmpegQaProbe,
  MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION,
  MEDIA_JOB_CONTRACT_VERSION,
  MediaJobProtocolV1,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  ShortformFfmpegExecutor,
  buildEditorialReeditApplicationSidecar,
  buildFailedRenderExport,
  buildSucceededRenderExport,
  compileEditorialReeditPlan,
  editorialReeditReplayIdentity,
  stableStringify,
  verifyEditorialReeditReplay,
  writeRenderExportSidecar
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
function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const content = `${stableStringify(value)}\n`;
  writeFileSync(filePath, content);
  return {
    path: filePath,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content)
  };
}
function relativeWithin(root, filePath) {
  const rel = path.relative(root, filePath).split(path.sep).join("/");
  if (!rel || rel.startsWith("../") || path.isAbsolute(rel)) {
    throw new Error(`output path escapes sandbox root: ${filePath}`);
  }
  return rel;
}

const args = parseArgs(process.argv.slice(2));
if (!args.request) throw new Error("--request is required");
const requestPath = path.resolve(args.request);
const request = JSON.parse(readFileSync(requestPath, "utf8"));
if (request.contractVersion !== "media.editorial_reedit_request.r19.v1") {
  throw new Error("request must use media.editorial_reedit_request.r19.v1");
}
const sandboxRoot = path.resolve(args["sandbox-root"] ?? path.dirname(requestPath));
const outputRoot = path.resolve(
  args["output-dir"] ?? path.join(sandboxRoot, ".r19-editorial-reedit", request.requestId)
);
relativeWithin(sandboxRoot, outputRoot);
mkdirSync(outputRoot, { recursive: true });
process.chdir(sandboxRoot);

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked-out HEAD ${producerSha}`);
}

const plan = compileEditorialReeditPlan({
  handoff: request.handoff,
  candidate: request.candidate,
  timeline: request.timeline,
  exportSpec: request.exportSpec
}, {
  sandboxRoot,
  expectedPlanDigest: request.expectedPlanDigest ?? null
});

if (plan.unsupported.length > 0) {
  const unsupported = {
    contractVersion: "media.editorial_reedit_failure.r19.v1",
    status: "failed",
    code: "unsupported_required_layer",
    humanQuality: false,
    producerSha,
    handoff: plan.handoff,
    planDigest: plan.planDigest,
    applications: plan.applications,
    unsupported: plan.unsupported
  };
  writeJson(path.join(outputRoot, "media.editorial_reedit_failure.r19.v1.json"), unsupported);
  throw new Error(`R19 has unsupported required directives: ${stableStringify(plan.unsupported)}`);
}

const finalPath = path.join(outputRoot, "final.mp4");
const renderExportPath = path.join(outputRoot, "media.render_export.v1.json");
const applicationPath = path.join(outputRoot, "media.editorial_reedit_application.v1.json");
const planPath = path.join(outputRoot, "media.editorial_reedit_plan.r19.v1.json");

if (existsSync(applicationPath) || existsSync(finalPath) || existsSync(renderExportPath)) {
  if (!(existsSync(applicationPath) && existsSync(finalPath) && existsSync(renderExportPath))) {
    throw new Error("partial R19 replay evidence exists; blind overwrite is prohibited");
  }
  const replay = verifyEditorialReeditReplay({
    existingSidecar: JSON.parse(readFileSync(applicationPath, "utf8")),
    plan,
    outputPath: finalPath,
    renderExportPath
  });
  console.log("R19_EDITORIAL_REEDIT", stableStringify({
    producerSha,
    requestId: request.requestId,
    status: "succeeded",
    replayed: true,
    identity: replay.identity,
    planDigest: plan.planDigest,
    output: replay.output,
    humanQuality: false
  }));
  process.exit(0);
}

writeJson(planPath, {
  contractVersion: "media.editorial_reedit_plan.r19.v1",
  producerSha,
  planDigest: plan.planDigest,
  handoff: plan.handoff,
  input: plan.input,
  directiveDigest: plan.directiveDigest,
  applications: plan.applications,
  outputTimelineDigest: plan.outputTimelineDigest,
  ffmpegPlanDigest: plan.ffmpegPlanDigest,
  timeline: plan.timeline,
  exportSpec: plan.exportSpec,
  humanQuality: false
});

const store = new PersistentRenderJobStore({
  filePath: path.join(outputRoot, "render-jobs.json")
});
const processExecutor = new DeterministicProcessExecutor({
  defaultTimeoutMs: 180000,
  maxOutputBytes: 4 * 1024 * 1024
});
const renderer = new ShortformFfmpegExecutor({
  store,
  sandboxRoot,
  executor: processExecutor
});
const probe = new FfmpegQaProbe({ store, sandboxRoot });
const runtime = new RenderRuntimeV2({
  store,
  executor: renderer,
  probe,
  sandboxRoot,
  liveExecutionEnabled: true,
  maxConcurrency: 1,
  resourceLimits: { render: 1, probe: 1 },
  processTimeoutMs: 180000
});
const protocol = new MediaJobProtocolV1(runtime);

const replayIdentity = editorialReeditReplayIdentity(plan);
const jobId = `r19-${request.requestId}-${plan.planDigest.slice(0, 16)}`;
await protocol.handle({
  contractVersion: MEDIA_JOB_CONTRACT_VERSION,
  action: "submit",
  idempotencyKey: replayIdentity,
  request: {
    contractVersion: "media.render.v1",
    jobId,
    timeline: plan.timeline,
    exportSpec: plan.exportSpec,
    outputPath: relativeWithin(sandboxRoot, finalPath),
    dryRun: false
  }
});

let response = null;
for (let attempt = 0; attempt < 32; attempt += 1) {
  response = await protocol.handle({
    contractVersion: MEDIA_JOB_CONTRACT_VERSION,
    action: "resume_or_poll",
    jobId
  });
  if (response.terminal) break;
}
const job = store.get(jobId);
if (!job || !response?.terminal) throw new Error("R19 render did not reach terminal state");

if (job.status !== "succeeded") {
  const failure = buildFailedRenderExport({ job, producerSha });
  writeRenderExportSidecar(failure, renderExportPath);
  writeJson(path.join(outputRoot, "media.editorial_reedit_failure.r19.v1.json"), {
    contractVersion: "media.editorial_reedit_failure.r19.v1",
    status: "failed",
    code: job.failure?.code ?? "render_failed",
    message: job.failure?.message ?? "R19 render failed",
    producerSha,
    handoff: plan.handoff,
    planDigest: plan.planDigest,
    applications: plan.applications,
    humanQuality: false
  });
  throw new Error(job.failure?.message ?? "R19 render failed");
}

const artifactManifest = runtime.exportArtifactManifest(jobId);
const renderExport = buildSucceededRenderExport({
  job,
  finalPath: job.resolvedOutputPath,
  artifactManifest,
  producerSha
});
const renderExportWrite = writeRenderExportSidecar(renderExport, renderExportPath);
const outputBytes = hashFile(job.resolvedOutputPath);

const application = buildEditorialReeditApplicationSidecar({
  plan,
  producerSha,
  output: outputBytes,
  technicalQa: job.qa,
  renderExportSha256: renderExportWrite.sha256
});
const applicationWrite = writeJson(applicationPath, application);

const evidence = {
  evidenceVersion: "media.editorial_reedit_runtime.r19.evidence.v1",
  producer: { repository: "foto6/video2", sha: producerSha },
  requestId: request.requestId,
  replayIdentity,
  growthHandoff: plan.handoff,
  input: plan.input,
  directiveDigest: plan.directiveDigest,
  planDigest: plan.planDigest,
  outputTimelineDigest: plan.outputTimelineDigest,
  ffmpegPlanDigest: plan.ffmpegPlanDigest,
  applications: plan.applications,
  output: {
    sha256: outputBytes.sha256,
    size: outputBytes.size,
    renderExportSha256: renderExportWrite.sha256,
    applicationSidecarSha256: applicationWrite.sha256
  },
  technicalQa: {
    passed: job.qa.passed,
    evidenceSha256: createHash("sha256").update(stableStringify(job.qa)).digest("hex"),
    checks: job.qa.checks
  },
  probe: job.probe,
  telemetry: job.telemetry,
  humanQuality: false,
  aestheticQualityProven: false,
  providerUploadPerformed: false,
  publishPerformed: false
};
const evidenceWrite = writeJson(
  path.join(outputRoot, "media.editorial_reedit_runtime.r19.evidence.json"),
  evidence
);

console.log("R19_EDITORIAL_REEDIT", stableStringify({
  producerSha,
  requestId: request.requestId,
  status: "succeeded",
  replayed: false,
  identity: replayIdentity,
  planDigest: plan.planDigest,
  applications: plan.applications.map((row) => ({
    directiveId: row.directiveId,
    operation: row.operation,
    status: row.status
  })),
  output: {
    sha256: outputBytes.sha256,
    size: outputBytes.size,
    renderExportSha256: renderExportWrite.sha256,
    applicationSidecarSha256: applicationWrite.sha256,
    evidenceSha256: evidenceWrite.sha256
  },
  technicalQaPassed: job.qa.passed,
  humanQuality: false
}));
