import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableStringify } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.env.R14_CORPUS_DIR ?? path.join(repoRoot, ".artifacts", "r14-corpus"));
const specPath = path.join(repoRoot, "tests", "fixtures", "r14-acceptance", "corpus.json");
const spec = JSON.parse(readFileSync(specPath, "utf8"));

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
mkdirSync(path.join(outputRoot, "_work"), { recursive: true });

function run(binary, args) {
  execFileSync(binary, args, {
    cwd: outputRoot,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
}

function ffmpeg(args) {
  run("ffmpeg", [
    "-hide_banner", "-nostdin", "-y",
    ...args
  ]);
}

function deterministicMp4Args(outputPath, { audio = true, durationSeconds = 6 } = {}) {
  return [
    "-t", String(durationSeconds),
    "-map_metadata", "-1",
    "-metadata", "creation_time=1970-01-01T00:00:00Z",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-threads", "1",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "31",
    "-pix_fmt", "yuv420p",
    ...(audio ? ["-c:a", "aac", "-b:a", "96k"] : ["-an"]),
    "-movflags", "+faststart",
    "-f", "mp4",
    outputPath
  ];
}

function caseDurationSeconds(id) {
  const entry = spec.cases.find((candidate) => candidate.id === id);
  const durationMs = entry?.durationMs ?? spec.durationMs;
  if (!Number.isInteger(durationMs) || durationMs < 5000) {
    throw new Error(`invalid acceptance duration for ${id}: ${durationMs}`);
  }
  return durationMs / 1000;
}

const work = path.join(outputRoot, "_work");
const seg1 = path.join(work, "speech-1.wav");
const seg2 = path.join(work, "speech-2.wav");
const seg3 = path.join(work, "speech-3.wav");

run("espeak-ng", ["-s", "170", "-w", seg1, "Start with the result."]);
run("espeak-ng", ["-s", "170", "-w", seg2, "Then remove the pause and show the proof."]);
run("espeak-ng", ["-s", "170", "-w", seg3, "Finish with one clear idea."]);

const speech = path.join(outputRoot, "speech-paused.wav");
ffmpeg([
  "-i", seg1, "-i", seg2, "-i", seg3,
  "-filter_complex",
  "[0:a]aresample=48000,apad=pad_dur=0.65[a0];" +
  "[1:a]aresample=48000,apad=pad_dur=0.75[a1];" +
  "[2:a]aresample=48000,apad=pad_dur=4[a2];" +
  "[a0][a1][a2]concat=n=3:v=0:a=1,atrim=duration=6,asetpts=PTS-STARTPTS[a]",
  "-map", "[a]",
  "-map_metadata", "-1",
  "-c:a", "pcm_s16le",
  speech
]);

const music = path.join(outputRoot, "music-bed.wav");
ffmpeg([
  "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=6",
  "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=6",
  "-filter_complex", "[0:a]volume=-15dB[a0];[1:a]volume=-20dB[a1];[a0][a1]amix=inputs=2:normalize=0[a]",
  "-map", "[a]",
  "-map_metadata", "-1",
  "-c:a", "pcm_s16le",
  music
]);

const talking = path.join(outputRoot, "talking-head-pauses.mp4");
ffmpeg([
  "-f", "lavfi", "-i",
  "testsrc2=s=360x640:r=30:d=6," +
  "hue=h=0.35*sin(2.4*t):s=0.55," +
  "eq=brightness=-0.16," +
  "drawbox=x='112+28*sin(t*1.7)':y='140+16*cos(1.3*t)':w=136:h=205:color=0xd9aa7d:t=fill," +
  "drawbox=x='145+12*sin(t*1.3)':y='205+7*cos(t)':w=70:h=14:color=0x25150e:t=fill",
  "-i", speech,
  "-map", "0:v:0", "-map", "1:a:0",
  ...deterministicMp4Args(talking)
]);

const landscapeDuration = caseDurationSeconds("landscape-reframe");
const landscape = path.join(outputRoot, "landscape-reframe.mp4");
ffmpeg([
  "-f", "lavfi", "-i",  `testsrc2=s=640x360:r=30:d=${landscapeDuration}`,
  "-vf", `drawbox=x='40+420*t/${landscapeDuration}':y=90:w=120:h=180:color=yellow@0.75:t=fill`,
  ...deterministicMp4Args(landscape, { audio: false, durationSeconds: landscapeDuration })
]);

const fastDuration = caseDurationSeconds("fast-motion");
const fast = path.join(outputRoot, "fast-motion.mp4");
ffmpeg([
  "-f", "lavfi", "-i", `testsrc2=s=360x640:r=30:d=${fastDuration}`,
  "-vf", "hue=h=4*PI*t:s=1.4,rotate='0.04*sin(6*t)':fillcolor=black",
  ...deterministicMp4Args(fast, { audio: false, durationSeconds: fastDuration })
]);

const lowDuration = caseDurationSeconds("low-motion");
const low = path.join(outputRoot, "low-motion.mp4");
ffmpeg([
  "-f", "lavfi", "-i",
  `testsrc2=s=360x640:r=2:d=${lowDuration},fps=30,` +
  "eq=saturation=0.18:brightness=-0.22," +
  "drawbox=x='75+12*sin(t/2)':y=170:w=210:h=280:color=0x6b7c8a@0.72:t=fill",
  ...deterministicMp4Args(low, { audio: false, durationSeconds: lowDuration })
]);

const speechMusicDuration = caseDurationSeconds("speech-music");
const speechMusic = path.join(outputRoot, "speech-music.mp4");
ffmpeg([
  "-f", "lavfi", "-i",
  `testsrc2=s=360x640:r=30:d=${speechMusicDuration},` +
  "eq=saturation=0.22:brightness=-0.20," +
  "drawbox=x='120+14*sin(t)':y=150:w=120:h=185:color=0xd3a273:t=fill",
  "-i", speech,
  "-map", "0:v:0", "-map", "1:a:0",
  ...deterministicMp4Args(speechMusic, { durationSeconds: speechMusicDuration })
]);

const subtitleHeavyDuration = caseDurationSeconds("subtitle-heavy");
const subtitleHeavy = path.join(outputRoot, "subtitle-heavy.mp4");
ffmpeg([
  "-f", "lavfi", "-i", `testsrc=s=360x640:r=30:d=${subtitleHeavyDuration}`,
  "-i", speech,
  "-map", "0:v:0", "-map", "1:a:0",
  ...deterministicMp4Args(subtitleHeavy, { durationSeconds: subtitleHeavyDuration })
]);

const brollDuration = caseDurationSeconds("broll-insert");
const brollMain = path.join(outputRoot, "broll-main.mp4");
ffmpeg([
  "-f", "lavfi", "-i", `testsrc2=s=360x640:r=30:d=${brollDuration}`,
  "-vf", "eq=saturation=0.7:contrast=1.05",
  ...deterministicMp4Args(brollMain, { audio: false, durationSeconds: brollDuration })
]);

const brollInsert = path.join(outputRoot, "broll-insert.mp4");
ffmpeg([
  "-f", "lavfi", "-i", `testsrc=s=360x640:r=30:d=${brollDuration}`,
  "-vf", "hue=h=PI/2+2*PI*t:s=1.3",
  "-t", String(brollDuration),
  "-map_metadata", "-1",
  "-metadata", "creation_time=1970-01-01T00:00:00Z",
  "-fflags", "+bitexact",
  "-flags:v", "+bitexact",
  "-threads", "1",
  "-c:v", "libx264",
  "-preset", "ultrafast",
  "-crf", "31",
  "-pix_fmt", "yuv420p",
  "-an",
  "-movflags", "+faststart",
  "-f", "mp4",
  brollInsert
]);

function fileSha256(filePath) {
  const bytes = readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function probe(filePath) {
  return JSON.parse(execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size",
    "-of", "json",
    filePath
  ], { encoding: "utf8", windowsHide: true }));
}

const generatedFiles = [
  "talking-head-pauses.mp4",
  "landscape-reframe.mp4",
  "fast-motion.mp4",
  "low-motion.mp4",
  "speech-music.mp4",
  "subtitle-heavy.mp4",
  "broll-main.mp4",
  "broll-insert.mp4",
  "speech-paused.wav",
  "music-bed.wav"
].map((name) => {
  const filePath = path.join(outputRoot, name);
  return {
    name,
    sha256: fileSha256(filePath),
    size: statSync(filePath).size,
    probe: probe(filePath)
  };
});

const report = {
  corpusVersion: spec.corpusVersion,
  generatedAt: "deterministic-no-wall-clock",
  files: generatedFiles
};
writeFileSync(path.join(outputRoot, "corpus-generated.json"), `${stableStringify(report)}\n`);

console.log("R14_CORPUS", stableStringify({
  corpusVersion: spec.corpusVersion,
  caseCount: spec.cases.length,
  mediaFileCount: generatedFiles.length,
  outputRoot
}));
