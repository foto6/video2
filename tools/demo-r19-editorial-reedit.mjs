import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
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
  MEDIA_SHORTFORM_PROFILE_VERSION,
  MediaJobProtocolV1,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  ShortformFfmpegExecutor,
  buildSucceededRenderExport,
  compileEditorialReeditPlan,
  fingerprint,
  stableStringify,
  writeRenderExportSidecar
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, ".artifacts", "r19-demo");
const corpusRoot = path.join(root, "corpus");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

execFileSync(process.execPath, [path.join(repoRoot, "tools", "generate-r14-corpus.mjs")], {
  cwd: repoRoot,
  env: { ...process.env, R14_CORPUS_DIR: corpusRoot },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024
});

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}
process.chdir(root);

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
function rel(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}
function probeMedia(filePath) {
  const parsed = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration",
    "-of", "json",
    filePath
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
  const video = (parsed.streams ?? []).find((x) => x.codec_type === "video");
  const audio = (parsed.streams ?? []).find((x) => x.codec_type === "audio");
  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000)
  };
}

const exportSpec = {
  format: "mp4",
  videoCodec: "libx264",
  audioCodec: "aac",
  videoBitrate: "900k",
  audioBitrate: "128k",
  pixelFormat: "yuv420p",
  preset: "ultrafast",
  loudness: { integratedLufs: -16, truePeakDb: -1.5, lra: 11 }
};

const store = new PersistentRenderJobStore({ filePath: path.join(root, "baseline-render-jobs.json") });
const processExecutor = new DeterministicProcessExecutor({
  defaultTimeoutMs: 180000,
  maxOutputBytes: 4 * 1024 * 1024
});
const renderer = new ShortformFfmpegExecutor({
  store,
  sandboxRoot: root,
  executor: processExecutor
});
const qaProbe = new FfmpegQaProbe({ store, sandboxRoot: root });
const runtime = new RenderRuntimeV2({
  store,
  executor: renderer,
  probe: qaProbe,
  sandboxRoot: root,
  liveExecutionEnabled: true,
  maxConcurrency: 1,
  resourceLimits: { render: 1, probe: 1 },
  processTimeoutMs: 180000
});
const protocol = new MediaJobProtocolV1(runtime);

const BRIDGE = {
  repository: "foto6/WebAIBridge",
  branch: "agent/bridge-r26-file-attachment-rehearsal-20261002",
  source_sha: "73c13f9eed2a2cbcea881dd8c5452d054bfef940",
  attachment_contract: "bridge.chat_file_attachment.v1",
  rehearsal_request_contract: "bridge.chat_file_attachment_rehearsal_request.v1",
  rehearsal_result_contract: "bridge.chat_file_attachment_rehearsal_result.v1",
  dom_probe_contract: "bridge.chat_file_attachment_dom_probe.v1",
  operator_evidence_contract: "bridge.chat_file_attachment_operator_evidence.v1",
  max_file_bytes: 500000000,
  disposition: "READY_FOR_EXPLICIT_LIVE_REHEARSAL",
  live_pass: false,
  real_upload_proven: false,
  real_prompt_send_proven: false,
  no_live_deploy: true,
  no_cutover: true
};
const MEDIA_R18 = {
  repository: "foto6/video2",
  branch: "agent/media-r18-direct-model-review-package-20261002",
  source_sha: "2c41f084e000eca5efd9a51d2d3752bec1bd1311",
  ci_run_id: 36967381891,
  contract: "media.direct_model_review_package.v1",
  max_file_bytes: 500000000,
  live_upload_performed: false,
  model_judgment_performed: false
};

function directive(binding, row) {
  const body = {
    operation: row.operation,
    start_ms: row.start,
    end_ms: row.end,
    defect_category: row.defect,
    severity: row.severity ?? "major",
    source_observation_id: `r19:${row.id}`,
    evidence: `deterministic R19 rehearsal evidence for ${row.id}`,
    confidence: 0.88,
    uncertainty: "synthetic model-review-shaped rehearsal; not human ground truth",
    upstream_proposed_edit: "audit-only free-form text; Media ignores this field",
    upstream_proposed_edit_executable: false,
    binding
  };
  return { ...body, directive_id: `gcrd1:${fingerprint(body)}` };
}

function growthHandoff(binding, rows, durationMs) {
  const directives = rows.map((row) => directive(binding, row));
  const pairwise = { selection: null, mapped_candidate_id: null, output_digest: null };
  const handoff = {
    contract_version: "growth.creator_reedit_handoff.v1",
    adapter_version: "growth.web_video_critic_reedit_adapter.v1",
    handoff_id: `gcrh1:${fingerprint({
      critic_output_digest: binding.critic_output_digest,
      pairwise_output_digest: null,
      reedit_round: 0
    })}`,
    handoff_digest: "",
    state: "targeted_reedit",
    reedit_round: 0,
    max_reedit_rounds: 2,
    binding,
    pairwise,
    coverage: {
      method: "full_duration_rehearsal",
      inspected_ranges: [{ start_ms: 0, end_ms: durationMs, kind: "targeted_recheck" }],
      uninspected_possible: true,
      every_frame_inspected: false,
      notes: "R19 deterministic rehearsal preserves Growth uncertainty; no human quality label.",
      coverage_uncertainty_preserved: true
    },
    summary_uncertainty: "Synthetic contract rehearsal only.",
    directives,
    bridge_r26_authority: BRIDGE,
    media_r18_authority: MEDIA_R18,
    evidence_boundary: {
      model_review_only: true,
      human_ground_truth: false,
      human_label: false,
      live_platform_evidence: false,
      live_video_review_fabricated: false
    },
    authority: {
      advisory_only: true,
      creator_mutation: false,
      media_mutation: false,
      provider_mutation: false,
      upload_performed: false,
      publish_authorized: false,
      release_authorized: false
    }
  };
  const material = structuredClone(handoff);
  material.handoff_digest = "";
  handoff.handoff_digest = fingerprint(material);
  return handoff;
}

async function baselineCandidate(caseId, sourceName, durationMs) {
  const caseRoot = path.join(root, "cases", caseId);
  const beforeRoot = path.join(caseRoot, "before");
  mkdirSync(beforeRoot, { recursive: true });

  const sourcePath = path.join(corpusRoot, sourceName);
  const source = hashFile(sourcePath);
  const media = probeMedia(sourcePath);
  const musicPath = path.join(corpusRoot, "music-bed.wav");
  const music = hashFile(musicPath);
  const sourceId = `${caseId}-source`;
  const mainDescriptor = {
    id: sourceId,
    uri: rel(sourcePath),
    inMs: 0,
    outMs: durationMs,
    sha256: source.sha256,
    size: source.size
  };
  const musicDescriptor = {
    id: `${caseId}-music`,
    uri: rel(musicPath),
    inMs: 0,
    outMs: durationMs,
    sha256: music.sha256,
    size: music.size
  };
  const timeline = {
    id: `r19-${caseId}-candidate-timeline`,
    version: 1,
    profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
    canvas: { width: 1080, height: 1920, fps: 30, durationMs },
    tracks: [
      {
        id: "video",
        kind: "video",
        items: [{
          id: "main",
          startMs: 0,
          endMs: durationMs,
          role: "body",
          source: mainDescriptor
        }]
      },
      {
        id: "caption",
        kind: "caption",
        items: [{
          id: "caption-key",
          startMs: 2000,
          endMs: 2600,
          text: "KEY IDEA",
          style: { fontSize: 60, box: true }
        }]
      },
      {
        id: "overlay",
        kind: "overlay",
        items: [
          {
            id: "label-focus",
            startMs: 2800,
            endMs: 3400,
            role: "label",
            text: "FOCUS",
            position: { x: 120, y: 220 },
            style: { fontSize: 52, box: true }
          },
          {
            id: "cta-next",
            startMs: durationMs - 800,
            endMs: durationMs - 200,
            role: "cta",
            text: "NEXT",
            position: { x: 120, y: 360 },
            style: { fontSize: 54, box: true }
          }
        ]
      }
    ]
  };
  const audioItems = [];
  if (media.hasAudio) {
    audioItems.push({
      id: "voice",
      startMs: 0,
      endMs: durationMs,
      role: "voiceover",
      source: mainDescriptor,
      gainDb: -3
    });
  }
  audioItems.push({
    id: "music",
    startMs: 0,
    endMs: durationMs,
    role: "music",
    source: musicDescriptor,
    gainDb: -18,
    duckUnderVoice: false
  });
  timeline.tracks.push({ id: "audio", kind: "audio", items: audioItems });

  const jobId = `r19-baseline-${caseId}`;
  const finalPath = path.join(beforeRoot, "final.mp4");
  await protocol.handle({
    contractVersion: MEDIA_JOB_CONTRACT_VERSION,
    action: "submit",
    idempotencyKey: `r19:baseline:${caseId}:${producerSha}`,
    request: {
      contractVersion: "media.render.v1",
      jobId,
      timeline,
      exportSpec,
      outputPath: rel(finalPath),
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
    throw new Error(`baseline render failed for ${caseId}: ${stableStringify(job?.failure ?? null)}`);
  }
  const artifactManifest = runtime.exportArtifactManifest(jobId);
  const renderExport = buildSucceededRenderExport({
    job,
    finalPath: job.resolvedOutputPath,
    artifactManifest,
    producerSha
  });
  const sidecarPath = path.join(beforeRoot, "media.render_export.v1.json");
  const sidecar = writeRenderExportSidecar(renderExport, sidecarPath);
  const final = hashFile(finalPath);

  return {
    caseRoot,
    timeline,
    source: { sourceId, sha256: source.sha256, size: source.size },
    candidate: {
      candidateId: `${caseId}-candidate`,
      source: { sourceId, sha256: source.sha256, size: source.size },
      finalPath: rel(finalPath),
      renderSha256: final.sha256,
      renderSize: final.size,
      renderExportPath: rel(sidecarPath),
      renderExportSha256: sidecar.sha256,
      renderProducerSha: producerSha
    },
    before: {
      sha256: final.sha256,
      size: final.size,
      durationMs: job.probe.durationMs,
      width: job.probe.width,
      height: job.probe.height,
      technicalQaPassed: job.qa.passed
    }
  };
}

const cases = [
  {
    id: "talking-head-vertical",
    sourceName: "talking-head-pauses.mp4",
    durationMs: 6000,
    expectedInputShape: "talking_head_vertical_with_pauses",
    directives: [
      { id: "speed", operation: "speed_change", start: 400, end: 1000, defect: "pacing_coherence", severity: "major" },
      { id: "trim", operation: "trim", start: 1400, end: 1550, defect: "awkward_dead_moment", severity: "major" },
      { id: "cut", operation: "cut", start: 1750, end: 1900, defect: "semantic_cut_correctness", severity: "major" },
      { id: "caption", operation: "subtitles_captions", start: 2200, end: 2600, defect: "caption_readability_emphasis_relevance", severity: "minor" },
      { id: "audio", operation: "audio_duck_mix", start: 3000, end: 3600, defect: "audio_voice_music_balance", severity: "major" },
      { id: "cta", operation: "intro_outro_cta", start: 5200, end: 5800, defect: "payoff_cta_loop_coherence", severity: "minor" }
    ]
  },
  {
    id: "landscape-to-vertical",
    sourceName: "landscape-reframe.mp4",
    durationMs: 5000,
    expectedInputShape: "landscape_source_reframed_to_vertical",
    directives: [
      { id: "reframe", operation: "crop_scale_reframe", start: 400, end: 1200, defect: "subject_framing_crop_quality", severity: "major" },
      { id: "fade", operation: "fade_transition", start: 1500, end: 2100, defect: "visual_continuity", severity: "minor" },
      { id: "overlay", operation: "text_overlay", start: 2800, end: 3400, defect: "hook_clarity", severity: "minor" },
      { id: "cta", operation: "intro_outro_cta", start: 4200, end: 4800, defect: "payoff_cta_loop_coherence", severity: "minor" }
    ]
  },
  {
    id: "motion-heavy-shortform",
    sourceName: "fast-motion.mp4",
    durationMs: 5000,
    expectedInputShape: "motion_heavy_shortform",
    directives: [
      { id: "reframe", operation: "crop_scale_reframe", start: 300, end: 1000, defect: "motion_zoom_appropriateness", severity: "minor" },
      { id: "fade", operation: "fade_transition", start: 1200, end: 1800, defect: "visual_continuity", severity: "minor" },
      { id: "caption", operation: "subtitles_captions", start: 2000, end: 2600, defect: "caption_readability_emphasis_relevance", severity: "minor" },
      { id: "overlay", operation: "text_overlay", start: 2800, end: 3400, defect: "hook_clarity", severity: "minor" }
    ]
  }
];

const results = [];
for (const spec of cases) {
  const baseline = await baselineCandidate(spec.id, spec.sourceName, spec.durationMs);
  const binding = {
    source_id: baseline.source.sourceId,
    source_sha256: baseline.source.sha256,
    source_size: baseline.source.size,
    media_repository: "foto6/video2",
    media_producer_sha: producerSha,
    candidate_id: baseline.candidate.candidateId,
    render_sha256: baseline.candidate.renderSha256,
    render_size: baseline.candidate.renderSize,
    render_export_sha256: baseline.candidate.renderExportSha256,
    attachment_sha256: baseline.candidate.renderSha256,
    attachment_size: baseline.candidate.renderSize,
    attachment_identity: `gvwa1:${fingerprint({
      candidateId: baseline.candidate.candidateId,
      sha256: baseline.candidate.renderSha256,
      size: baseline.candidate.renderSize
    })}`,
    review_bundle_digest: fingerprint({ caseId: spec.id, before: baseline.before }),
    critic_input_digest: fingerprint({ caseId: spec.id, stage: "critic_input" }),
    critic_output_digest: fingerprint({ caseId: spec.id, stage: "critic_output", directives: spec.directives })
  };
  const handoff = growthHandoff(binding, spec.directives, spec.durationMs);
  const compiled = compileEditorialReeditPlan({
    handoff,
    candidate: baseline.candidate,
    timeline: baseline.timeline,
    exportSpec
  }, { sandboxRoot: root });
  const replayCompile = compileEditorialReeditPlan({
    handoff,
    candidate: baseline.candidate,
    timeline: baseline.timeline,
    exportSpec
  }, { sandboxRoot: root, expectedPlanDigest: compiled.planDigest });
  if (replayCompile.planDigest !== compiled.planDigest) throw new Error("R19 compile digest drift");

  const request = {
    contractVersion: "media.editorial_reedit_request.r19.v1",
    requestId: spec.id,
    handoff,
    candidate: baseline.candidate,
    timeline: baseline.timeline,
    exportSpec,
    expectedPlanDigest: compiled.planDigest
  };
  const requestPath = path.join(baseline.caseRoot, "request.json");
  writeJson(requestPath, request);
  const afterRoot = path.join(baseline.caseRoot, "after");
  const runArgs = [
    path.join(repoRoot, "tools", "run-r19-editorial-reedit.mjs"),
    "--request", requestPath,
    "--sandbox-root", root,
    "--output-dir", afterRoot
  ];
  const first = execFileSync(process.execPath, runArgs, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  const second = execFileSync(process.execPath, runArgs, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (!second.includes('"replayed":true')) throw new Error(`R19 replay did not reuse exact output for ${spec.id}`);

  const afterEvidence = JSON.parse(readFileSync(
    path.join(afterRoot, "media.editorial_reedit_runtime.r19.evidence.json"),
    "utf8"
  ));
  const application = JSON.parse(readFileSync(
    path.join(afterRoot, "media.editorial_reedit_application.v1.json"),
    "utf8"
  ));
  const after = hashFile(path.join(afterRoot, "final.mp4"));
  if (after.sha256 === baseline.before.sha256) throw new Error(`R19 ${spec.id} output did not change bytes`);
  if (application.humanQuality !== false || afterEvidence.humanQuality !== false) {
    throw new Error("R19 must not claim human quality");
  }
  if (!afterEvidence.technicalQa?.passed) throw new Error(`R19 technical QA failed for ${spec.id}`);
  if (application.applications.some((row) => row.status !== "applied")) {
    throw new Error(`R19 demo contains unsupported directive for ${spec.id}`);
  }
  results.push({
    caseId: spec.id,
    inputShape: spec.expectedInputShape,
    source: baseline.source,
    candidate: {
      id: baseline.candidate.candidateId,
      renderSha256: baseline.candidate.renderSha256,
      renderSize: baseline.candidate.renderSize,
      renderExportSha256: baseline.candidate.renderExportSha256
    },
    handoff: { id: handoff.handoff_id, digest: handoff.handoff_digest },
    planDigest: compiled.planDigest,
    directiveDigest: compiled.directiveDigest,
    operations: application.applications.map((row) => ({
      directiveId: row.directiveId,
      operation: row.operation,
      status: row.status,
      exactOperations: row.exactOperations
    })),
    before: baseline.before,
    after: {
      sha256: after.sha256,
      size: after.size,
      durationMs: afterEvidence.probe.durationMs,
      width: afterEvidence.probe.width,
      height: afterEvidence.probe.height,
      hasAudio: afterEvidence.probe.hasAudio,
      peakDb: Number.isFinite(afterEvidence.probe.peakDb) ? afterEvidence.probe.peakDb : null,
      blackFrameRatio: afterEvidence.probe.blackFrameRatio,
      maxFreezeDurationMs: afterEvidence.probe.maxFreezeDurationMs,
      silenceRatio: afterEvidence.probe.silenceRatio,
      renderExportSha256: application.output.renderExportSha256,
      applicationSidecarSha256: hashFile(path.join(afterRoot, "media.editorial_reedit_application.v1.json")).sha256,
      technicalQaPassed: afterEvidence.technicalQa.passed
    },
    replayByteStable: true,
    firstRunLogSha256: createHash("sha256").update(first).digest("hex"),
    replayLogSha256: createHash("sha256").update(second).digest("hex"),
    humanQuality: false
  });
}

const summary = {
  evidenceVersion: "media.editorial_reedit_runtime.r19.demo.v1",
  producer: { repository: "foto6/video2", sha: producerSha },
  growthR23: {
    repository: "foto6/video3",
    sha: "26f769abceb43a63677ea8f7ba028369db371696",
    ciRunId: 36974062565,
    contract: "growth.creator_reedit_handoff.v1"
  },
  realFixtureCount: results.length,
  allTechnicalQaPassed: results.every((entry) => entry.after.technicalQaPassed),
  allOutputsChangedBytes: results.every((entry) => entry.before.sha256 !== entry.after.sha256),
  allReplaysByteStable: results.every((entry) => entry.replayByteStable),
  humanQuality: false,
  aestheticQualityProven: false,
  providerUploadPerformed: false,
  publishPerformed: false,
  results
};
writeJson(path.join(root, "r19-readiness-evidence.json"), summary);
console.log("R19_DEMO", stableStringify(summary));
