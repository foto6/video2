import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_CANDIDATE_BATCH_VERSION,
  MEDIA_SHORTFORM_PROFILE_VERSION,
  candidateRendererConfigDigest,
  compileCreativeEditPlan,
  fingerprint,
  stableStringify
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, ".artifacts", "r16-demo");
const batchRoot = path.join(root, "batch");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const sourcePath = path.join(root, "source.mp4");
execFileSync("ffmpeg", [
  "-hide_banner", "-nostdin", "-y",
  "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=5",
  "-vf", "hue=h=0.25*sin(2*t):s=0.8",
  "-t", "5",
  "-map_metadata", "-1",
  "-metadata", "creation_time=1970-01-01T00:00:00Z",
  "-fflags", "+bitexact",
  "-flags:v", "+bitexact",
  "-threads", "1",
  "-c:v", "libx264",
  "-preset", "ultrafast",
  "-crf", "30",
  "-pix_fmt", "yuv420p",
  "-an",
  "-movflags", "+faststart",
  "-f", "mp4",
  sourcePath
], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

const sourceBytes = readFileSync(sourcePath);
const source = {
  sourceId: "r16-demo-source",
  sha256: createHash("sha256").update(sourceBytes).digest("hex"),
  size: statSync(sourcePath).size
};

const baseTimeline = {
  id: "r16-demo-base",
  version: 1,
  profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
  canvas: { width: 1080, height: 1920, fps: 30, durationMs: 5000 },
  tracks: [{
    id: "video",
    kind: "video",
    items: [{
      id: "main",
      startMs: 0,
      endMs: 5000,
      role: "body",
      source: {
        id: source.sourceId,
        uri: "source.mp4",
        inMs: 0,
        outMs: 5000,
        sha256: source.sha256,
        size: source.size
      }
    }]
  }]
};

const styles = ["clean_podcast", "aggressive_shortform", "cinematic_minimal"];
const exportSpec = {
  format: "mp4",
  videoCodec: "libx264",
  audioCodec: "aac",
  videoBitrate: "900k",
  audioBitrate: "128k",
  pixelFormat: "yuv420p",
  preset: "ultrafast",
  loudness: false
};
const candidates = styles.map((style, index) => {
  const creative = compileCreativeEditPlan({
    style,
    timeline: { ...baseTimeline, id: `r16-demo-base-${index + 1}` },
    hints: index === 1
      ? { sentenceBoundariesMs: [0, 1200, 2500, 3800, 5000], beatMarkersMs: [1000, 2000, 3000, 4000] }
      : {},
    loopFriendly: false,
    cta: false
  });
  return {
    candidateId: `candidate-${index + 1}`,
    plan: {
      timeline: creative.timeline,
      exportSpec
    }
  };
});

const request = {
  contractVersion: MEDIA_CANDIDATE_BATCH_VERSION,
  batchId: "r16-demo-batch",
  source,
  renderer: { configDigest: candidateRendererConfigDigest({ maxParallel: 2 }) },
  candidates
};
const requestPath = path.join(root, "request.json");
writeFileSync(requestPath, `${stableStringify(request)}\n`);

function runBatch() {
  const output = execFileSync(process.execPath, [
    path.join(repoRoot, "tools", "run-r16-candidate-batch.mjs"),
    "--request", requestPath,
    "--sandbox-root", root,
    "--output-dir", batchRoot,
    "--max-parallel", "2"
  ], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  return output;
}

const firstOutput = runBatch();
const manifestPath = path.join(batchRoot, "media.candidate_batch.v1.json");
const evidencePath = path.join(batchRoot, "media.candidate_batch.r16.evidence.json");
const firstManifest = readFileSync(manifestPath, "utf8");
const firstEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
copyFileSync(evidencePath, path.join(root, "first-run-evidence.json"));

const replayOutput = runBatch();
const replayManifest = readFileSync(manifestPath, "utf8");
const replayEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
copyFileSync(evidencePath, path.join(root, "replay-evidence.json"));

if (firstManifest !== replayManifest) throw new Error("canonical R16 manifest changed on duplicate replay");
if (firstEvidence.metrics.renderCalls !== 3) throw new Error("first run must render all three candidates");
if (firstEvidence.metrics.detectorCalls !== 1) throw new Error("first run must detect source exactly once");
if (firstEvidence.metrics.peakConcurrentCandidates > 2) throw new Error("candidate parallelism exceeded bound");
if (firstEvidence.metrics.processCalls <= 0) throw new Error("first run process count missing");
if (replayEvidence.metrics.renderCalls !== 0 || replayEvidence.metrics.cacheHits !== 3) {
  throw new Error("duplicate replay did not reuse all exact candidates");
}

const summary = {
  evidenceVersion: "media.candidate_batch.r16.demo.v1",
  producerSha: firstEvidence.producer.sha,
  source,
  requestDigest: fingerprint(request),
  candidateCount: candidates.length,
  manifestSha256: createHash("sha256").update(firstManifest).digest("hex"),
  firstRun: firstEvidence.metrics,
  replay: replayEvidence.metrics,
  resourceEnvelope: firstEvidence.resourceEnvelope,
  canonicalManifestByteStableOnReplay: true,
  allCandidatesSucceeded: JSON.parse(firstManifest).status === "succeeded",
  firstRunLogSha256: createHash("sha256").update(firstOutput).digest("hex"),
  replayLogSha256: createHash("sha256").update(replayOutput).digest("hex")
};
writeFileSync(path.join(root, "demo-summary.json"), `${stableStringify(summary)}\n`);
console.log("R16_DEMO", stableStringify(summary));
