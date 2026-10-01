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

function deterministicMp4Args(outputPath, { audio = true } = {}) {
  return [
    "-t", "6",
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
  "color=c=0x26384a:s=360x640:r=30:d=6," +
  "noise=alls=2:allf=t," +
  "drawbox=x='118+12*sin(t*1.3)':y='145+7*cos(t)':w=124:h=190:color=0xd9aa7d:t=fill," +
  "drawbox=x='145+12*sin(t*1.3)':y='205+7*cos(t)':w=70:h=14:color=0x25150e:t=fill",
  "-i", speech,
  "-map", "0:v:0", "-map", "1:a:0",
  ...deterministicMp4Args(talking)
]);

const landscape = path.join(outputRoot, "landscape-reframe.mp4");
ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=6",
  "-vf", "drawbox=x='40+420*t/6':y=90:w=120:h=180:color=yellow@0.75:t=fill",
  ...deterministicMp4Args(landscape, { audio: false })
]);

const fast = path.join(outputRoot, "fast-motion.mp4");
ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=6",
  "-vf", "hue=h=4*PI*t:s=1.4,rotate='0.04*sin(6*t)':fillcolor=black",
  ...deterministicMp4Args(fast, { audio: false })
]);

const low = path.join(outputRoot, "low-motion.mp4");
ffmpeg([
  "-f", "lavfi", "-i",
  "color=c=0x38424a:s=360x640:r=30:d=6," +
  "noise=alls=2:allf=t," +
  "drawbox=x='75+18*sin(t/2)':y=170:w=210:h=280:color=0x6b7c8a:t=fill",
  ...deterministicMp4Args(low, { audio: false })
]);

const speechMusic = path.join(outputRoot, "speech-music.mp4");
ffmpeg([
  "-f", "lavfi", "-i",
  "color=c=0x182c3a:s=360x640:r=30:d=6," +
  "noise=alls=2:allf=t," +
  "drawbox=x='120+8*sin(t)':y=150:w=120:h=185:color=0xd3a273:t=fill",
  "-i", speech,
  "-map", "0:v:0", "-map", "1:a:0",
  ...deterministicMp4Args(speechMusic)
]);

const subtitleHeavy = path.join(outputRoot, "subtitle-heavy.mp4");
ffmpeg([
  "-f", "lavfi", "-i", "testsrc=s=360x640:r=30:d=6",
  "-i", speech,
  "-map", "0:v:0", "-map", "1:a:0",
  ...deterministicMp4Args(subtitleHeavy)
]);

const brollMain = path.join(outputRoot, "broll-main.mp4");
ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=6",
  "-vf", "eq=saturation=0.7:contrast=1.05",
  ...deterministicMp4Args(brollMain, { audio: false })
]);

const brollInsert = path.join(outputRoot, "broll-insert.mp4");
ffmpeg([
  "-f", "lavfi", "-i", "testsrc=s=360x640:r=30:d=2.5",
  "-vf", "hue=h=PI/2+2*PI*t:s=1.3",
  "-t", "2.5",
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
