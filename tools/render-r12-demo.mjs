import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DeterministicProcessExecutor,
  FfmpegQaProbe,
  MEDIA_JOB_CONTRACT_VERSION,
  MEDIA_SHORTFORM_PROFILE_VERSION,
  MediaJobProtocolV1,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  ShortformFfmpegExecutor,
  artifactManifestDigest,
  compileCreativeEditPlan,
  creativeMetrics,
  evaluateCreativeQuality,
  materializeShortformArtifacts,
  stableStringify
} from "../src/index.js";

const root = path.resolve(process.env.R12_DEMO_DIR ?? ".artifacts/r12-demo");
rmSync(root, { recursive: true, force: true });
for (const dir of ["inputs", "outputs", "before-bundle", "after-bundle"]) {
  mkdirSync(path.join(root, dir), { recursive: true });
}

const processExecutor = new DeterministicProcessExecutor({
  defaultTimeoutMs: 180000,
  maxOutputBytes: 2 * 1024 * 1024
});

async function run(command, label) {
  const result = await processExecutor.run(command, { timeoutMs: 180000 });
  if (!result.ok) throw new Error(`${label} failed: ${result.stderr.slice(-3000)}`);
}

const mainPath = path.join(root, "inputs", "main.mp4");
const brollPath = path.join(root, "inputs", "broll.mp4");
const voicePath = path.join(root, "inputs", "voice.wav");
const musicPath = path.join(root, "inputs", "music.wav");

await run({ binary: "ffmpeg", args: [
  "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=6",
  "-an", "-map_metadata", "-1", "-threads", "1", "-c:v", "libx264", "-preset", "ultrafast",
  "-pix_fmt", "yuv420p", "-f", "mp4", mainPath
]}, "main source generation");

await run({ binary: "ffmpeg", args: [
  "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=s=360x640:r=30:d=2",
  "-vf", "hue=h=2*PI*t:s=1.2", "-an", "-map_metadata", "-1", "-threads", "1",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-f", "mp4", brollPath
]}, "b-roll generation");

await run({ binary: "ffmpeg", args: [
  "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i",
  "sine=frequency=760:sample_rate=48000:duration=6",
  "-map_metadata", "-1", "-c:a", "pcm_s16le", voicePath
]}, "voice generation");

await run({ binary: "ffmpeg", args: [
  "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i",
  "sine=frequency=190:sample_rate=48000:duration=6",
  "-map_metadata", "-1", "-c:a", "pcm_s16le", musicPath
]}, "music generation");

function digest(relativePath) {
  const bytes = readFileSync(path.join(root, relativePath));
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: statSync(path.join(root, relativePath)).size
  };
}

const sourceDigests = {
  main: digest("inputs/main.mp4"),
  broll: digest("inputs/broll.mp4"),
  voice: digest("inputs/voice.wav"),
  music: digest("inputs/music.wav")
};

process.chdir(root);

function source(id, uri, key, outMs) {
  return {
    id,
    uri,
    inMs: 0,
    ...(outMs ? { outMs } : {}),
    sha256: sourceDigests[key].sha256,
    size: sourceDigests[key].size
  };
}

const baselineTimeline = {
  id: "r12-before",
  version: 1,
  profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
  canvas: { width: 1080, height: 1920, fps: 30, durationMs: 6000 },
  tracks: [
    {
      id: "video", kind: "video",
      items: [{
        id: "main", startMs: 0, endMs: 6000, role: "body",
        source: source("main-source", "inputs/main.mp4", "main", 6000)
      }]
    },
    {
      id: "captions", kind: "caption",
      items: [
        { id: "caption-a", startMs: 350, endMs: 2600, text: "Here is the result first", style: { fontSize: 62, y: 1460, maxWidth: 860 } },
        { id: "caption-b", startMs: 2500, endMs: 3600, text: "Then remove the pauses", style: { fontSize: 62, y: 1460, maxWidth: 860 } }
      ]
    },
    {
      id: "audio", kind: "audio",
      items: [
        {
          id: "voice", startMs: 0, endMs: 6000, role: "voiceover",
          source: source("voice-source", "inputs/voice.wav", "voice", 6000), gainDb: -3
        },
        {
          id: "music", startMs: 0, endMs: 6000, role: "music",
          source: source("music-source", "inputs/music.wav", "music", 6000), gainDb: -18, duckUnderVoice: true
        }
      ]
    }
  ]
};

const creative = compileCreativeEditPlan({
  style: "aggressive_shortform",
  timeline: baselineTimeline,
  loopFriendly: true,
  ctaText: "SAVE THIS EDIT",
  hints: {
    silenceRanges: [
      { startMs: 1500, endMs: 1900 },
      { startMs: 3500, endMs: 3950 }
    ],
    sentenceBoundariesMs: [0, 1450, 1950, 3450, 4050, 6000],
    beatMarkersMs: Array.from({ length: 12 }, (_, index) => index * 500),
    saliency: [
      { startMs: 0, endMs: 3000, centerX: 0.43, centerY: 0.45, confidence: 0.96 },
      { startMs: 3000, endMs: 6000, centerX: 0.57, centerY: 0.46, confidence: 0.93 }
    ],
    brollCandidates: [{
      id: "proof-broll",
      score: 0.98,
      durationMs: 1800,
      source: source("broll-source", "inputs/broll.mp4", "broll")
    }],
    captionTokens: [
      { id: "tok-1", text: "RESULT", startMs: 200, endMs: 700, emphasis: true },
      { id: "tok-2", text: "first", startMs: 750, endMs: 1250 },
      { id: "tok-3", text: "CUT THE PAUSE", startMs: 2100, endMs: 2850, emphasis: true },
      { id: "tok-4", text: "keep the proof", startMs: 2900, endMs: 3600 },
      { id: "tok-5", text: "finish clean", startMs: 3900, endMs: 4300 }
    ]
  }
});

const exportSpec = {
  format: "mp4",
  videoCodec: "libx264",
  audioCodec: "aac",
  videoBitrate: "1M",
  audioBitrate: "160k",
  pixelFormat: "yuv420p",
  preset: "ultrafast",
  loudness: { integratedLufs: -16, truePeakDb: -1.5, lra: 11 }
};

const store = new PersistentRenderJobStore({ filePath: path.join(root, "jobs.json") });
const executor = new ShortformFfmpegExecutor({ store, sandboxRoot: root, executor: processExecutor });
const probe = new FfmpegQaProbe({ store, sandboxRoot: root });
const runtime = new RenderRuntimeV2({
  store,
  executor,
  probe,
  sandboxRoot: root,
  liveExecutionEnabled: true,
  processTimeoutMs: 180000
});
const protocol = new MediaJobProtocolV1(runtime);

async function render(jobId, idempotencyKey, timeline, outputPath) {
  const submit = {
    contractVersion: MEDIA_JOB_CONTRACT_VERSION,
    action: "submit",
    idempotencyKey,
    request: {
      contractVersion: "media.render.v1",
      jobId,
      timeline,
      exportSpec,
      outputPath,
      dryRun: false
    }
  };
  const first = await protocol.handle(submit);
  const duplicate = await protocol.handle(structuredClone(submit));
  if (first.duplicate !== false || duplicate.duplicate !== true) throw new Error(`${jobId} idempotency regression`);
  const result = await protocol.handle({
    contractVersion: MEDIA_JOB_CONTRACT_VERSION,
    action: "resume_or_poll",
    jobId
  });
  if (result.status !== "succeeded") throw new Error(`${jobId} render failed: ${stableStringify(result.failure ?? result)}`);
  return store.get(jobId);
}

const beforeJob = await render("r12-before", "creator:r12:before:1", baselineTimeline, "outputs/before.mp4");
const afterJob = await render("r12-after", "creator:r12:after:1", creative.timeline, "outputs/after.mp4");

const beforeManifest = runtime.exportArtifactManifest(beforeJob.id);
const afterManifest = runtime.exportArtifactManifest(afterJob.id);
const beforeBundle = await materializeShortformArtifacts({
  finalPath: beforeJob.resolvedOutputPath,
  timeline: beforeJob.timeline,
  exportSpec: beforeJob.exportSpec,
  qa: beforeJob.qa,
  artifactManifest: beforeManifest,
  sourceEvidence: beforeJob.probe.sourceEvidence,
  outputDir: path.join(root, "before-bundle"),
  executor: processExecutor,
  previewDurationMs: 1000
});
const afterBundle = await materializeShortformArtifacts({
  finalPath: afterJob.resolvedOutputPath,
  timeline: afterJob.timeline,
  exportSpec: afterJob.exportSpec,
  qa: afterJob.qa,
  artifactManifest: afterManifest,
  sourceEvidence: afterJob.probe.sourceEvidence,
  outputDir: path.join(root, "after-bundle"),
  executor: processExecutor,
  previewDurationMs: 1000
});

const beforeMetrics = creativeMetrics(beforeJob.timeline);
const qualityReport = evaluateCreativeQuality(afterJob.timeline, afterJob.probe);
if (!qualityReport.passed) throw new Error(`R12 creative quality report failed: ${stableStringify(qualityReport)}`);

const report = {
  reportVersion: "media.creative_quality_report.r12.v1",
  style: creative.style,
  planDigest: creative.planDigest,
  passed: qualityReport.passed,
  before: {
    durationMs: beforeJob.timeline.canvas.durationMs,
    renderFingerprint: beforeJob.renderFingerprint,
    artifactSha256: beforeManifest.content.sha256,
    artifactManifestSha256: artifactManifestDigest(beforeManifest),
    bundleSha256: beforeBundle.bundleArtifact.sha256,
    metrics: beforeMetrics
  },
  after: {
    durationMs: afterJob.timeline.canvas.durationMs,
    renderFingerprint: afterJob.renderFingerprint,
    artifactSha256: afterManifest.content.sha256,
    artifactManifestSha256: artifactManifestDigest(afterManifest),
    bundleSha256: afterBundle.bundleArtifact.sha256,
    metrics: qualityReport.metrics,
    guardrails: qualityReport.guardrails,
    visualQa: qualityReport.visualQa.checks
  },
  deltas: {
    removedDurationMs: beforeJob.timeline.canvas.durationMs - afterJob.timeline.canvas.durationMs,
    addedCuts: qualityReport.metrics.cuts - beforeMetrics.cuts,
    addedMotions: qualityReport.metrics.zooms - beforeMetrics.zooms
  },
  execution: {
    beforeExecutorInvocations: beforeJob.telemetry.sideEffects.executorInvocations,
    afterExecutorInvocations: afterJob.telemetry.sideEffects.executorInvocations,
    beforeDuplicateSubmits: beforeJob.telemetry.protocol.duplicateSubmits,
    afterDuplicateSubmits: afterJob.telemetry.protocol.duplicateSubmits
  },
  sourceHashes: Object.entries(sourceDigests).map(([id, value]) => ({ id, ...value }))
};

writeFileSync(path.join(root, "creative-quality-report.json"), `${stableStringify(report)}\n`);
console.log("R12_CREATIVE_QUALITY_REPORT", stableStringify(report));
