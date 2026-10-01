import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  inspectShortformSources,
  materializeShortformArtifacts,
  stableStringify
} from "../src/index.js";

const root = path.resolve(process.env.R11_DEMO_DIR ?? ".artifacts/r11-demo");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
mkdirSync(path.join(root, "inputs"), { recursive: true });
mkdirSync(path.join(root, "outputs"), { recursive: true });
mkdirSync(path.join(root, "bundle"), { recursive: true });

const processExecutor = new DeterministicProcessExecutor({ defaultTimeoutMs: 180000, maxOutputBytes: 2 * 1024 * 1024 });

async function run(command, label) {
  const result = await processExecutor.run(command, { timeoutMs: 180000 });
  if (!result.ok) throw new Error(`${label} failed: ${result.stderr.slice(-3000)}`);
}

const clipA = path.join(root, "inputs", "clip-a.mp4");
const clipB = path.join(root, "inputs", "clip-b.mp4");
const voice = path.join(root, "inputs", "voice.wav");
const music = path.join(root, "inputs", "music.wav");

await run({ binary: "ffmpeg", args: [
  "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=5",
  "-an", "-map_metadata", "-1", "-threads", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-f", "mp4", clipA
]}, "clip-a generation");
await run({ binary: "ffmpeg", args: [
  "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "smptebars=s=540x960:r=30:d=4",
  "-an", "-map_metadata", "-1", "-threads", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-f", "mp4", clipB
]}, "clip-b generation");
await run({ binary: "ffmpeg", args: [
  "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=8",
  "-map_metadata", "-1", "-c:a", "pcm_s16le", voice
]}, "voice generation");
await run({ binary: "ffmpeg", args: [
  "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=8",
  "-map_metadata", "-1", "-c:a", "pcm_s16le", music
]}, "music generation");

function source(id, uri) {
  return { id, uri, inMs: 0 };
}

let timeline = {
  id: "r11-synthetic-demo",
  version: 1,
  profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
  canvas: { width: 1080, height: 1920, fps: 30, durationMs: 8000 },
  tracks: [
    {
      id: "video", kind: "video", items: [
        { id: "cut-a", startMs: 0, endMs: 4000, role: "intro", speed: 1.25, source: source("clip-a", clipA), fadeInMs: 180 },
        { id: "cut-b", startMs: 4000, endMs: 8000, role: "outro", source: source("clip-b", clipB), fadeOutMs: 180 }
      ]
    },
    {
      id: "captions", kind: "caption", items: [
        { id: "caption", startMs: 500, endMs: 3500, text: "CUT. MIX. CAPTION.", style: { fontSize: 64, y: 1450, maxWidth: 900 } }
      ]
    },
    {
      id: "overlays", kind: "overlay", items: [
        { id: "intro-title", startMs: 0, endMs: 1200, role: "intro", text: "MEDIA R11", position: { x: 90, y: 220 }, style: { fontSize: 72 } },
        { id: "cta", startMs: 6500, endMs: 7900, role: "cta", text: "SAVE + SHARE", position: { x: 90, y: 300 }, style: { fontSize: 64 } }
      ]
    },
    {
      id: "audio", kind: "audio", items: [
        { id: "voice", startMs: 0, endMs: 8000, role: "voiceover", source: source("voice", voice), gainDb: -3, fadeInMs: 120, fadeOutMs: 120 },
        { id: "music", startMs: 0, endMs: 8000, role: "music", source: source("music", music), gainDb: -18, duckUnderVoice: true }
      ]
    }
  ]
};

const initialEvidence = await inspectShortformSources(timeline, { sandboxRoot: root });
const byId = new Map(initialEvidence.map((entry) => [entry.sourceId, entry]));
timeline = JSON.parse(JSON.stringify(timeline));
for (const track of timeline.tracks) {
  for (const item of track.items) {
    if (!item.source) continue;
    const evidence = byId.get(item.source.id);
    item.source.sha256 = evidence.sha256;
    item.source.size = evidence.size;
  }
}

const exportSpec = {
  format: "mp4",
  videoCodec: "libx264",
  audioCodec: "aac",
  videoBitrate: "2M",
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
const submit = {
  contractVersion: MEDIA_JOB_CONTRACT_VERSION,
  action: "submit",
  idempotencyKey: "creator:r11:synthetic-demo:1",
  request: {
    contractVersion: "media.render.v1",
    jobId: "r11-synthetic-demo",
    timeline,
    exportSpec,
    outputPath: "outputs/r11-synthetic-demo.mp4",
    dryRun: false
  }
};

const first = await protocol.handle(submit);
const duplicate = await protocol.handle(JSON.parse(JSON.stringify(submit)));
if (first.duplicate !== false || duplicate.duplicate !== true) throw new Error("media.job.v1 duplicate semantics regressed");
const result = await protocol.handle({
  contractVersion: MEDIA_JOB_CONTRACT_VERSION,
  action: "resume_or_poll",
  jobId: submit.request.jobId
});
if (result.status !== "succeeded") throw new Error(`R11 render failed: ${stableStringify(result.failure ?? result)}`);

const job = store.get(submit.request.jobId);
const artifactManifest = runtime.exportArtifactManifest(job.id);
const artifacts = await materializeShortformArtifacts({
  finalPath: job.resolvedOutputPath,
  timeline: job.timeline,
  exportSpec: job.exportSpec,
  qa: job.qa,
  artifactManifest,
  sourceEvidence: job.probe.sourceEvidence,
  outputDir: path.join(root, "bundle"),
  executor: processExecutor
});

const evidence = {
  evidenceVersion: "media.shortform_editor.r11.demo_evidence.v1",
  jobId: job.id,
  idempotencyKey: job.idempotencyKey,
  status: job.status,
  renderFingerprint: job.renderFingerprint,
  executorInvocations: job.telemetry.sideEffects.executorInvocations,
  duplicateSubmits: job.telemetry.protocol.duplicateSubmits,
  finalArtifact: {
    sha256: job.artifactManifest.content.sha256,
    size: job.artifactManifest.content.size,
    manifestSha256: artifactManifestDigest(artifactManifest)
  },
  qaPassed: job.qa.passed,
  qaChecks: job.qa.checks.map((entry) => ({ name: entry.name, pass: entry.pass })),
  bundle: {
    sha256: artifacts.bundleArtifact.sha256,
    previewSha256: artifacts.preview.sha256,
    thumbnailSha256: artifacts.thumbnail.sha256,
    timelineSha256: artifacts.timelineArtifact.sha256
  },
  sourceHashes: artifacts.bundle.sources.map((entry) => ({ sourceId: entry.sourceId, sha256: entry.sha256, size: entry.size }))
};
writeFileSync(path.join(root, "evidence.json"), `${stableStringify(evidence)}\n`);
console.log("R11_DEMO_EVIDENCE", stableStringify(evidence));
