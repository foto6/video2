import test from "node:test";
import assert from "node:assert/strict";
import {
  MediaEngine,
  buildRenderPlan,
  captionsToSrt,
  compileClipExtraction,
  compileFfmpegCommand,
  createProviderBoundaries,
  createRenderJob,
  evaluateRenderQa,
  transitionRenderJob
} from "../src/index.js";

function timeline() {
  return {
    id: "tl-1",
    version: 1,
    canvas: { width: 1080, height: 1920, fps: 30, durationMs: 5000 },
    tracks: [
      {
        id: "captions",
        kind: "caption",
        items: [{ id: "cap-1", startMs: 500, endMs: 1800, text: "Hello: world", style: { fontSize: 42 } }]
      },
      {
        id: "music",
        kind: "audio",
        items: [
          { id: "aud-1", startMs: 0, endMs: 5000, source: { uri: "music.wav", inMs: 0 }, gainDb: -6 }
        ]
      },
      {
        id: "video",
        kind: "video",
        items: [
          {
            id: "vid-2",
            startMs: 2500,
            endMs: 5000,
            source: { uri: "b.mp4", inMs: 1000 },
            crop: { width: 720, height: 1280, x: 10, y: 20 }
          },
          {
            id: "vid-1",
            startMs: 0,
            endMs: 2500,
            source: { uri: "a.mp4", inMs: 0 },
            reframe: { x: 120, y: 0 },
            transitionOut: { type: "fade", durationMs: 500 }
          }
        ]
      },
      {
        id: "overlay",
        kind: "overlay",
        items: [{ id: "ov-1", startMs: 1000, endMs: 2000, text: "SALE", position: { x: 50, y: 70 } }]
      }
    ]
  };
}

test("render plan is canonical and deterministic", () => {
  const first = timeline();
  const second = timeline();
  second.tracks.reverse();
  for (const track of second.tracks) track.items.reverse();

  const a = buildRenderPlan(first);
  const b = buildRenderPlan(second);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.inputs.map((x) => x.uri), ["a.mp4", "b.mp4", "music.wav"]);
  assert.equal(a.composition.type, "remotion-style");
  assert.ok(a.operations.some((x) => x.type === "transition.apply"));
  assert.ok(a.operations.some((x) => x.type === "caption.render"));
  assert.ok(a.operations.some((x) => x.type === "video.reframe"));
  assert.ok(a.operations.some((x) => x.type === "audio.mix"));
  assert.ok(a.operations.some((x) => x.type === "overlay.compose"));
});

test("FFmpeg command covers clip, crop/reframe, transition, captions, overlay and audio mix", () => {
  const command = compileFfmpegCommand(timeline(), {}, "out.mp4");
  assert.equal(command.binary, "ffmpeg");
  const text = command.args.join(" ");
  assert.match(text, /trim=start=/);
  assert.match(text, /crop=/);
  assert.match(text, /xfade=transition=fade/);
  assert.match(text, /drawtext=text=/);
  assert.match(text, /volume=-6dB/);
  assert.match(text, /\+bitexact/);
  assert.match(text, /-threads 1/);
  assert.equal(command.args.at(-1), "out.mp4");
});

test("clip extraction is explicit and reproducible", () => {
  const command = compileClipExtraction({
    inputPath: "source.mp4",
    outputPath: "clip.mp4",
    startMs: 1250,
    durationMs: 2200
  });
  assert.deepEqual(command.args.slice(0, 8), ["-hide_banner", "-nostdin", "-y", "-ss", "1.250", "-i", "source.mp4", "-t"]);
  assert.equal(command.args.at(-1), "clip.mp4");
});

test("captions export deterministic SRT", () => {
  const srt = captionsToSrt(timeline());
  assert.match(srt, /00:00:00,500 --> 00:00:01,800/);
  assert.match(srt, /Hello: world/);
});

test("automated QA accepts matching render metadata and rejects broken renders", () => {
  const good = evaluateRenderQa(timeline(), {
    hasVideo: true,
    hasAudio: true,
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: 5005,
    blackFrameRatio: 0.1,
    silenceRatio: 0.2
  });
  assert.equal(good.passed, true);

  const bad = evaluateRenderQa(timeline(), {
    hasVideo: true,
    hasAudio: false,
    width: 720,
    height: 1280,
    fps: 24,
    durationMs: 4200
  });
  assert.equal(bad.passed, false);
  assert.ok(bad.checks.some((entry) => entry.name === "audio-present" && !entry.pass));
});

test("render jobs use a closed state machine with no publishing state", () => {
  let job = createRenderJob({ id: "job-1", timelineId: "tl-1", outputPath: "out.mp4" });
  job = transitionRenderJob(job, "start");
  job = transitionRenderJob(job, "planned");
  job = transitionRenderJob(job, "rendered");
  job = transitionRenderJob(job, "qa_passed");
  assert.equal(job.status, "completed");
  assert.equal(job.attempt, 1);
  assert.equal(job.events.some((event) => event.status === "published"), false);
  assert.throws(() => transitionRenderJob(job, "publish"), /invalid render job transition/);
});

test("Runway and Descript remain optional adapter boundaries", async () => {
  const calls = [];
  const runway = { async generateVideo(request) { calls.push(["runway", request.id]); return { uri: "generated.mp4" }; } };
  const descript = {
    async transcribe(request) { calls.push(["transcribe", request.id]); return { text: "ok" }; },
    async synthesizeVoice(request) { calls.push(["voice", request.id]); return { uri: "voice.wav" }; }
  };
  const boundaries = createProviderBoundaries({ runway, descript });
  await boundaries.runway.generateVideo({ id: "r1" });
  await boundaries.descript.transcribe({ id: "d1" });
  await boundaries.descript.synthesizeVoice({ id: "d2" });
  assert.deepEqual(calls, [["runway", "r1"], ["transcribe", "d1"], ["voice", "d2"]]);
  assert.deepEqual(createProviderBoundaries(), { runway: null, descript: null });
});

test("headless MediaEngine executes, probes, QA-checks and emits export metadata", async () => {
  const commands = [];
  const engine = new MediaEngine({
    executor: { async run(command) { commands.push(command); return { code: 0 }; } },
    probe: {
      async inspect(path) {
        assert.equal(path, "out.mp4");
        return {
          hasVideo: true,
          hasAudio: true,
          width: 1080,
          height: 1920,
          fps: 30,
          durationMs: 5000,
          videoCodec: "h264",
          audioCodec: "aac"
        };
      }
    }
  });
  const result = await engine.render({
    jobId: "job-2",
    timeline: timeline(),
    outputPath: "out.mp4",
    completedAt: "2026-09-27T06:10:00Z"
  });
  assert.equal(result.job.status, "completed");
  assert.equal(result.qa.passed, true);
  assert.equal(result.exportMetadata.outputPath, "out.mp4");
  assert.equal(result.exportMetadata.completedAt, "2026-09-27T06:10:00Z");
  assert.equal(commands.length, 1);
});
