import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  artifactManifestDigest,
  compileCreativeEditPlan,
  evaluateCreativeQuality,
  materializeShortformArtifacts,
  stableStringify
} from "../src/index.js";
import {
  classifyMvpAcceptance,
  summarizeMvpAcceptance
} from "../src/acceptance-r14.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const inputRoot = path.resolve(args["input-dir"] ?? process.env.R14_INPUT_DIR ?? path.join(repoRoot, ".artifacts", "r14-corpus"));
const outputRoot = path.resolve(args["output-dir"] ?? process.env.R14_OUTPUT_DIR ?? path.join(repoRoot, ".artifacts", "r14-acceptance"));
const manifestPath = args.manifest
  ? path.resolve(args.manifest)
  : process.env.R14_MANIFEST
    ? path.resolve(process.env.R14_MANIFEST)
    : null;

if (!existsSync(inputRoot)) throw new Error(`input directory does not exist: ${inputRoot}`);
if (inputRoot === outputRoot) throw new Error("input and output directories must differ");

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("unable to resolve exact producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked-out HEAD ${producerSha}`);
}

rmSync(outputRoot, { recursive: true, force: true });
for (const dir of ["sources", "renders", "reports"]) mkdirSync(path.join(outputRoot, dir), { recursive: true });
process.chdir(outputRoot);

const processExecutor = new DeterministicProcessExecutor({
  defaultTimeoutMs: 180000,
  maxOutputBytes: 4 * 1024 * 1024
});
const store = new PersistentRenderJobStore({ filePath: path.join(outputRoot, "jobs.json") });
const executor = new ShortformFfmpegExecutor({ store, sandboxRoot: outputRoot, executor: processExecutor });
const probe = new FfmpegQaProbe({ store, sandboxRoot: outputRoot });

let deterministicNowMs = 1810000000000;
const runtime = new RenderRuntimeV2({
  store,
  executor,
  probe,
  sandboxRoot: outputRoot,
  liveExecutionEnabled: true,
  processTimeoutMs: 180000,
  clock: () => {
    deterministicNowMs += 10;
    return deterministicNowMs;
  }
});
const protocol = new MediaJobProtocolV1(runtime);

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), size: statSync(filePath).size };
}

function ffprobe(filePath) {
  const parsed = JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,duration:format=duration,size",
    "-of", "json",
    filePath
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
  const streams = parsed.streams ?? [];
  const video = streams.find((entry) => entry.codec_type === "video") ?? null;
  const audio = streams.find((entry) => entry.codec_type === "audio") ?? null;
  const seconds = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration);
  return {
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
  };
}

function detectSilence(filePath, durationMs) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", filePath,
    "-af", "silencedetect=n=-40dB:d=0.25",
    "-vn", "-f", "null", "-"
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const text = result.stderr ?? "";
  const starts = [...text.matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]) * 1000);
  const ends = [...text.matchAll(/silence_end:\s*([0-9.]+)/g)].map((match) => Number(match[1]) * 1000);
  const ranges = [];
  for (let index = 0; index < starts.length; index += 1) {
    const startMs = Math.max(0, Math.round(starts[index]));
    const endMs = Math.min(durationMs, Math.round(ends[index] ?? durationMs));
    if (endMs > startMs) ranges.push({ startMs, endMs });
  }
  return ranges;
}

function loadCases() {
  if (manifestPath) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest.cases)) throw new Error("acceptance manifest must contain cases[]");
    return manifest.cases;
  }
  const extensions = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
  return readdirSync(inputRoot)
    .filter((name) => extensions.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => ({
      id: name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase(),
      file: name,
      styles: ["clean_podcast", "aggressive_shortform"],
      hints: {},
      humanReview: [
        "Inspect overall crop/composition, pacing, caption/CTA readability, and motion choices.",
        "If audio is present, judge speech clarity and subjective loudness balance."
      ]
    }));
}

function normalizeRelative(filePath) {
  return path.relative(outputRoot, filePath).split(path.sep).join("/");
}

async function stageSource(caseId, sourceName, role) {
  const original = path.resolve(inputRoot, sourceName);
  if (!original.startsWith(inputRoot + path.sep) && original !== inputRoot) {
    throw new Error(`source escapes input root: ${sourceName}`);
  }
  if (!existsSync(original)) throw new Error(`missing source: ${sourceName}`);
  const before = await hashFile(original);
  const stageDir = path.join(outputRoot, "sources", caseId);
  mkdirSync(stageDir, { recursive: true });
  const staged = path.join(stageDir, `${role}-${path.basename(sourceName)}`);
  copyFileSync(original, staged);
  const stagedDigest = await hashFile(staged);
  if (stableStringify(before) !== stableStringify(stagedDigest)) {
    throw new Error(`staged copy digest mismatch: ${sourceName}`);
  }
  return {
    role,
    original,
    staged,
    uri: normalizeRelative(staged),
    before,
    media: ffprobe(staged)
  };
}

async function sourcePreserved(stagedSources) {
  const checks = [];
  for (const source of stagedSources) {
    const after = await hashFile(source.original);
    checks.push({
      role: source.role,
      path: source.original,
      before: source.before,
      after,
      preserved: stableStringify(source.before) === stableStringify(after)
    });
  }
  return { passed: checks.every((entry) => entry.preserved), checks };
}

function sourceDescriptor(source, id, outMs = null) {
  return {
    id,
    uri: source.uri,
    inMs: 0,
    ...(outMs ? { outMs } : {}),
    sha256: source.before.sha256,
    size: source.before.size
  };
}

function createContactSheet(finalPath, outputPath) {
  execFileSync("ffmpeg", [
    "-hide_banner", "-nostdin", "-y",
    "-i", finalPath,
    "-vf", "fps=1,scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2:black,tile=3x2",
    "-frames:v", "1",
    "-map_metadata", "-1",
    "-q:v", "3",
    outputPath
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${stableStringify(value)}\n`);
}

let cases = loadCases();
if (args["case-id"]) {
  const requested = new Set(String(args["case-id"]).split(",").map((value) => value.trim()).filter(Boolean));
  const available = new Set(cases.map((entry) => entry.id));
  const missing = [...requested].filter((id) => !available.has(id));
  if (missing.length) throw new Error(`unknown acceptance case id(s): ${missing.join(", ")}`);
  cases = cases.filter((entry) => requested.has(entry.id));
}
if (args.style) {
  const style = String(args.style);
  if (!["clean_podcast", "aggressive_shortform"].includes(style)) {
    throw new Error(`unsupported acceptance style: ${style}`);
  }
  cases = cases.map((entry) => {
    if (!(entry.styles ?? []).includes(style)) {
      throw new Error(`case ${entry.id} does not declare style ${style}`);
    }
    return { ...entry, styles: [style] };
  });
}
if (cases.length === 0) throw new Error("no input video cases found");

const results = [];
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

for (const caseSpec of cases) {
  const staged = [];
  let main;
  try {
    main = await stageSource(caseSpec.id, caseSpec.file, "main");
    staged.push(main);
    if (!main.media.hasVideo) throw new Error("main source has no video stream");

    let durationMs = main.media.durationMs;
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("main source duration is unavailable");
    const caseWarnings = [];
    if (durationMs > 90000) {
      durationMs = 90000;
      caseWarnings.push("Source exceeds the R11 profile maximum; acceptance uses the first 90 seconds without modifying the original.");
    }
    if (durationMs < 5000) {
      const preservation = await sourcePreserved(staged);
      results.push({
        caseId: caseSpec.id,
        style: "n/a",
        source: caseSpec.file,
        acceptance: classifyMvpAcceptance({
          renderSucceeded: false,
          sourcePreserved: preservation.passed,
          technicalQa: null,
          creativeQuality: null,
          probe: null,
          humanReviewReasons: ["Source is shorter than the R11 5-second profile minimum; no aesthetic claim was made."]
        }),
        sourcePreservation: preservation,
        error: "source duration below 5000ms"
      });
      continue;
    }

    let music = null;
    if (caseSpec.musicFile) {
      music = await stageSource(caseSpec.id, caseSpec.musicFile, "music");
      staged.push(music);
      if (!music.media.hasAudio) throw new Error("configured music source has no audio stream");
    }

    let broll = null;
    if (caseSpec.brollFile) {
      broll = await stageSource(caseSpec.id, caseSpec.brollFile, "broll");
      staged.push(broll);
      if (!broll.media.hasVideo) throw new Error("configured B-roll source has no video stream");
    }

    const baseHints = structuredClone(caseSpec.hints ?? {});
    if (main.media.hasAudio && !Array.isArray(baseHints.silenceRanges)) {
      baseHints.silenceRanges = detectSilence(main.staged, durationMs);
      if (!Array.isArray(baseHints.sentenceBoundariesMs)) {
        baseHints.sentenceBoundariesMs = [
          0,
          ...baseHints.silenceRanges.flatMap((range) => [range.startMs, range.endMs]),
          durationMs
        ].filter((value) => value >= 0 && value <= durationMs);
      }
    }
    if (broll) {
      baseHints.brollCandidates = [{
        id: `${caseSpec.id}-broll`,
        score: 1,
        durationMs: broll.media.durationMs,
        source: sourceDescriptor(broll, `${caseSpec.id}-broll-source`, broll.media.durationMs)
      }];
    }

    for (const style of caseSpec.styles ?? ["clean_podcast", "aggressive_shortform"]) {
      const baseTimeline = {
        id: `r14-${caseSpec.id}-base`,
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
              source: sourceDescriptor(main, `${caseSpec.id}-main-source`, durationMs)
            }]
          }
        ]
      };
      if (main.media.hasAudio || music) {
        const audioItems = [];
        if (main.media.hasAudio) {
          audioItems.push({
            id: "voice",
            startMs: 0,
            endMs: durationMs,
            role: "voiceover",
            source: sourceDescriptor(main, `${caseSpec.id}-main-source`, durationMs),
            gainDb: -3
          });
        }
        if (music) {
          audioItems.push({
            id: "music",
            startMs: 0,
            endMs: durationMs,
            role: "music",
            source: sourceDescriptor(music, `${caseSpec.id}-music-source`, durationMs),
            gainDb: -18,
            duckUnderVoice: true
          });
        }
        baseTimeline.tracks.push({ id: "audio", kind: "audio", items: audioItems });
      }

      const creative = compileCreativeEditPlan({
        style,
        timeline: baseTimeline,
        hints: structuredClone(baseHints),
        loopFriendly: style === "aggressive_shortform",
        ctaText: "REVIEW THIS CUT"
      });

      const jobId = `r14-${caseSpec.id}-${style}`;
      const renderDir = path.join(outputRoot, "renders", caseSpec.id, style);
      mkdirSync(renderDir, { recursive: true });
      const outputPath = normalizeRelative(path.join(renderDir, "final.mp4"));

      const submit = {
        contractVersion: MEDIA_JOB_CONTRACT_VERSION,
        action: "submit",
        idempotencyKey: `r14:${caseSpec.id}:${style}:1`,
        request: {
          contractVersion: "media.render.v1",
          jobId,
          timeline: creative.timeline,
          exportSpec,
          outputPath,
          dryRun: false
        }
      };

      let renderResult;
      let job;
      let renderError = null;
      try {
        await protocol.handle(submit);
        renderResult = await protocol.handle({
          contractVersion: MEDIA_JOB_CONTRACT_VERSION,
          action: "resume_or_poll",
          jobId
        });
        job = store.get(jobId);
      } catch (error) {
        renderError = error;
        job = store.get(jobId);
      }

      const preservation = await sourcePreserved(staged);
      if (!job || renderResult?.status !== "succeeded") {
        const acceptance = classifyMvpAcceptance({
          renderSucceeded: false,
          sourcePreserved: preservation.passed,
          technicalQa: job?.qa ?? null,
          creativeQuality: job?.timeline ? evaluateCreativeQuality(job.timeline, job.probe ?? {}) : null,
          probe: job?.probe ?? null,
          humanReviewReasons: [
            ...(caseSpec.humanReview ?? []),
            ...caseWarnings
          ]
        });
        results.push({
          caseId: caseSpec.id,
          style,
          source: caseSpec.file,
          acceptance,
          sourcePreservation: preservation,
          error: renderError?.message ?? job?.failure?.message ?? "render did not succeed"
        });
        continue;
      }

      const artifactManifest = runtime.exportArtifactManifest(jobId);
      const quality = evaluateCreativeQuality(job.timeline, job.probe);
      const bundle = await materializeShortformArtifacts({
        finalPath: job.resolvedOutputPath,
        timeline: job.timeline,
        exportSpec: job.exportSpec,
        qa: job.qa,
        artifactManifest,
        sourceEvidence: job.probe.sourceEvidence,
        outputDir: path.join(renderDir, "bundle"),
        executor: processExecutor,
        previewDurationMs: Math.min(2000, job.timeline.canvas.durationMs)
      });

      const contactSheet = path.join(renderDir, "contact-sheet.jpg");
      createContactSheet(job.resolvedOutputPath, contactSheet);

      const probeReport = {
        reportVersion: "media.r14.probe_report.v1",
        caseId: caseSpec.id,
        style,
        value: job.probe
      };
      const qaReport = {
        reportVersion: "media.r14.technical_qa_report.v1",
        caseId: caseSpec.id,
        style,
        value: job.qa
      };
      const creativeReport = {
        reportVersion: "media.r14.creative_quality_report.v1",
        caseId: caseSpec.id,
        style,
        value: quality
      };
      writeJson(path.join(renderDir, "probe-report.json"), probeReport);
      writeJson(path.join(renderDir, "qa-report.json"), qaReport);
      writeJson(path.join(renderDir, "creative-quality-report.json"), creativeReport);

      const acceptance = classifyMvpAcceptance({
        renderSucceeded: true,
        sourcePreserved: preservation.passed,
        technicalQa: job.qa,
        creativeQuality: quality,
        probe: job.probe,
        humanReviewReasons: [
          "Machine checks cannot prove that pacing, crop composition, transition feel, or visual taste are aesthetically good; inspect the rendered MP4/contact sheet.",
          ...(caseSpec.humanReview ?? []),
          ...caseWarnings
        ]
      });

      const resultEntry = {
        caseId: caseSpec.id,
        style,
        source: caseSpec.file,
        acceptance,
        sourcePreservation: preservation,
        identities: {
          renderFingerprint: job.renderFingerprint,
          creativePlanDigest: job.timeline.creativePlan?.planDigest ?? null,
          finalContentSha256: artifactManifest.content.sha256,
          finalContentSize: artifactManifest.content.size,
          artifactManifestDigest: artifactManifestDigest(artifactManifest)
        },
        outputs: {
          finalMp4: normalizeRelative(job.resolvedOutputPath),
          previewMp4: normalizeRelative(bundle.preview.path),
          thumbnailJpeg: normalizeRelative(bundle.thumbnail.path),
          contactSheetJpeg: normalizeRelative(contactSheet),
          probeReport: normalizeRelative(path.join(renderDir, "probe-report.json")),
          qaReport: normalizeRelative(path.join(renderDir, "qa-report.json")),
          creativeQualityReport: normalizeRelative(path.join(renderDir, "creative-quality-report.json"))
        }
      };
      writeJson(path.join(renderDir, "acceptance.json"), resultEntry);
      results.push(resultEntry);
    }
  } catch (error) {
    const preservation = staged.length ? await sourcePreserved(staged) : { passed: true, checks: [] };
    results.push({
      caseId: caseSpec.id,
      style: "case-setup",
      source: caseSpec.file,
      acceptance: classifyMvpAcceptance({
        renderSucceeded: false,
        sourcePreserved: preservation.passed,
        technicalQa: null,
        creativeQuality: null,
        probe: null,
        humanReviewReasons: []
      }),
      sourcePreservation: preservation,
      error: error.message
    });
  }
}

const summary = summarizeMvpAcceptance({
  producerSha,
  sourceRoot: inputRoot,
  outputRoot,
  results
});
writeJson(path.join(outputRoot, "mvp-acceptance-summary.json"), summary);

const reviewRows = results
  .filter((entry) => entry.outputs?.finalMp4)
  .map((entry) => {
    const reasons = (entry.acceptance?.warnings ?? [])
      .filter((warning) => warning.code === "human_aesthetic_review")
      .map((warning) => warning.message);
    return {
      caseId: entry.caseId,
      style: entry.style,
      status: entry.acceptance.status,
      finalMp4: entry.outputs.finalMp4,
      contactSheet: entry.outputs.contactSheetJpeg,
      reasons
    };
  });

let markdown = "# R14 human review checklist\n\n";
markdown += "Machine PASS means only objective checks passed. Aesthetic quality remains a human judgment.\n\n";
for (const row of reviewRows) {
  markdown += `## ${row.caseId} / ${row.style} — ${row.status}\n\n`;
  markdown += `- Final: \`${row.finalMp4}\`\n`;
  markdown += `- Contact sheet: \`${row.contactSheet}\`\n`;
  for (const reason of row.reasons) markdown += `- Review: ${reason}\n`;
  markdown += "\n";
}
writeFileSync(path.join(outputRoot, "human-review.md"), markdown);

console.log("R14_ACCEPTANCE", stableStringify({
  producerSha,
  resultCount: summary.resultCount,
  status: summary.status,
  counts: summary.counts,
  failures: summary.failures.length,
  warnings: summary.warnings.length,
  summaryPath: path.join(outputRoot, "mvp-acceptance-summary.json")
}));
if (summary.failures.length > 0) {
  console.log("R14_ACCEPTANCE_FAILURES", stableStringify(summary.failures));
}
console.log("R14_ACCEPTANCE_WARNINGS", stableStringify(summary.warnings.map((entry) => ({
  caseId: entry.caseId,
  style: entry.style,
  code: entry.code
}))));

if (summary.counts.fail > 0) process.exitCode = 1;
