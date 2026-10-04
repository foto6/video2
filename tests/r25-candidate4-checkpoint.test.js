import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MEDIA_R25_CANDIDATE4_CHECKPOINT_VERSION,
  buildR25Candidate4Checkpoint,
  buildR25Candidate4Decomposition,
  r25Candidate4ResumeState,
  sliceTimelineForR25Checkpoint,
  stableStringify,
  validateR25Candidate4Checkpoint
} from "../src/index.js";

const SHA = (c) => c.repeat(64);
const GIT = (c) => c.repeat(40);

function timeline() {
  return {
    id: "r25-c4-test",
    version: 1,
    profileVersion: "media.shortform_profile.r11.v1",
    canvas: { width: 1080, height: 1920, fps: 30, durationMs: 5000 },
    tracks: [
      {
        id: "video",
        kind: "video",
        items: [
          {
            id: "motion",
            startMs: 0,
            endMs: 1200,
            role: "body",
            source: {
              id: "src",
              uri: "source.mp4",
              inMs: 0,
              outMs: 1200,
              sha256: SHA("a"),
              size: 1000
            },
            motion: { type: "slow_push", zoom: 1.05 }
          },
          {
            id: "tail",
            startMs: 1200,
            endMs: 5000,
            role: "body",
            source: {
              id: "src",
              uri: "source.mp4",
              inMs: 1200,
              outMs: 5000,
              sha256: SHA("a"),
              size: 1000
            }
          }
        ]
      },
      {
        id: "audio",
        kind: "audio",
        items: [{
          id: "voice",
          startMs: 0,
          endMs: 5000,
          role: "voiceover",
          source: {
            id: "src",
            uri: "source.mp4",
            inMs: 0,
            outMs: 5000,
            sha256: SHA("a"),
            size: 1000
          },
          gainDb: -3
        }]
      },
      {
        id: "caption",
        kind: "caption",
        items: [{
          id: "caption",
          startMs: 800,
          endMs: 1800,
          text: "CHECKPOINT",
          style: { fontSize: 58, box: true }
        }]
      }
    ]
  };
}

function decomposition(overrides = {}) {
  return buildR25Candidate4Decomposition({
    tournamentId: "r25-test",
    candidateId: "candidate-4",
    producerSha: GIT("1"),
    source: { sourceId: "src", sha256: SHA("a"), size: 1000 },
    operationGraphDigest: SHA("b"),
    runtimeManifestSha256: SHA("c"),
    timeline: timeline(),
    ...overrides
  });
}

function outputFile(root, name, bytes = name) {
  const filePath = path.join(root, name);
  writeFileSync(filePath, bytes);
  const buf = Buffer.from(bytes);
  return {
    filePath,
    identity: {
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.length
    }
  };
}

function checkpoint(dec, index, output) {
  return buildR25Candidate4Checkpoint({
    decomposition: dec,
    segment: dec.segments[index],
    inputs: [{ kind: "source", sha256: SHA("a"), size: 1000 }],
    output,
    durationMs: dec.segments[index].endMs - dec.segments[index].startMs,
    elapsedMs: 1234 + index
  });
}

test("R25 candidate-4 decomposition bounds kinetic motion into deterministic global-progress chunks", () => {
  const dec = decomposition();
  assert.equal(dec.maxMotionChunkMs, 800);
  assert.deepEqual(dec.segments.map((x) => [x.phase, x.startMs, x.endMs]), [
    ["segment-1", 0, 800],
    ["segment-2", 800, 1200],
    ["segment-3", 1200, 5000]
  ]);
  const one = sliceTimelineForR25Checkpoint(timeline(), 0, 800);
  const two = sliceTimelineForR25Checkpoint(timeline(), 800, 1200);
  assert.equal(one.canvas.durationMs, 800);
  assert.equal(two.canvas.durationMs, 400);
  assert.equal(one.profileVersion, undefined);
  assert.equal(two.profileVersion, undefined);
  const firstMotion = one.tracks.find((x) => x.kind === "video").items[0].motion;
  const secondMotion = two.tracks.find((x) => x.kind === "video").items[0].motion;
  assert.equal(firstMotion.type, "slow_push");
  assert.equal(firstMotion.checkpointProgressStartFrame, 0);
  assert.equal(firstMotion.checkpointProgressTotalFrames, 36);
  assert.equal(secondMotion.checkpointProgressStartFrame, 24);
  assert.equal(secondMotion.checkpointProgressTotalFrames, 36);
  assert.equal(timeline().profileVersion, "media.shortform_profile.r11.v1");
});

test("R25 checkpoint slicer preserves global motion progress instead of restarting motion", () => {
  const clipped = sliceTimelineForR25Checkpoint(timeline(), 400, 800);
  const motion = clipped.tracks.find((x) => x.kind === "video").items[0].motion;
  assert.equal(motion.checkpointProgressStartFrame, 12);
  assert.equal(motion.checkpointProgressTotalFrames, 36);
});

test("R25 simulates SIGTERM after each expensive subphase and resumes only the next phase", () => {
  const dec = decomposition();
  const cps = dec.segments.map((segment, index) =>
    checkpoint(dec, index, { sha256: String(index + 4).repeat(64), size: 10 + index })
  );

  assert.deepEqual(r25Candidate4ResumeState({ decomposition: dec }), {
    nextPhase: "segment-1",
    reused: []
  });
  for (let count = 1; count < cps.length; count += 1) {
    assert.deepEqual(r25Candidate4ResumeState({
      decomposition: dec,
      checkpoints: cps.slice(0, count)
    }), {
      nextPhase: dec.segments[count].phase,
      reused: dec.segments.slice(0, count).map((x) => x.phase)
    });
  }
  assert.deepEqual(r25Candidate4ResumeState({ decomposition: dec, checkpoints: cps }), {
    nextPhase: "assemble",
    reused: dec.segments.map((x) => x.phase)
  });
  assert.deepEqual(r25Candidate4ResumeState({
    decomposition: dec,
    checkpoints: cps,
    final: { sha256: SHA("f"), size: 12 }
  }), {
    nextPhase: "complete",
    reused: [...dec.segments.map((x) => x.phase), "assemble"]
  });
});

test("R25 missing or corrupt checkpoint output fails closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "r25-c4-corrupt-"));
  const dec = decomposition();
  const file = outputFile(root, "segment.mp4", "segment-one");
  const cp = checkpoint(dec, 0, file.identity);
  assert.doesNotThrow(() => validateR25Candidate4Checkpoint(cp, {
    decomposition: dec,
    segment: dec.segments[0],
    outputPath: file.filePath
  }));

  writeFileSync(file.filePath, "corrupted");
  assert.throws(() => validateR25Candidate4Checkpoint(cp, {
    decomposition: dec,
    segment: dec.segments[0],
    outputPath: file.filePath
  }), /bytes\/hash mismatch/);

  assert.throws(() => validateR25Candidate4Checkpoint(cp, {
    decomposition: dec,
    segment: dec.segments[0],
    outputPath: path.join(root, "missing.mp4")
  }), /missing checkpoint artifact/);
});

test("R25 checkpoint from wrong source graph or runtime conflicts under the phase boundary", () => {
  const dec = decomposition();
  const cp = checkpoint(dec, 0, { sha256: SHA("d"), size: 10 });

  for (const changed of [
    decomposition({ source: { sourceId: "src", sha256: SHA("9"), size: 1000 } }),
    decomposition({ operationGraphDigest: SHA("8") }),
    decomposition({ runtimeManifestSha256: SHA("7") })
  ]) {
    assert.throws(() => validateR25Candidate4Checkpoint(cp, {
      decomposition: changed,
      segment: changed.segments[0]
    }), /authority\/source\/graph\/runtime mismatch/);
  }
});

test("R25 exact duplicate checkpoint is idempotent but conflicting duplicate is rejected", () => {
  const dec = decomposition();
  const cp = checkpoint(dec, 0, { sha256: SHA("d"), size: 10 });
  const duplicate = JSON.parse(stableStringify(cp));
  assert.deepEqual(
    validateR25Candidate4Checkpoint(cp, { decomposition: dec, segment: dec.segments[0] }),
    validateR25Candidate4Checkpoint(duplicate, { decomposition: dec, segment: dec.segments[0] })
  );

  const conflict = structuredClone(cp);
  conflict.operationId = "r25c4:" + SHA("0");
  assert.throws(() => validateR25Candidate4Checkpoint(conflict, {
    decomposition: dec,
    segment: dec.segments[0]
  }), /phase operation identity mismatch/);
});

test("R25 resumed final hash mismatch is detected instead of accepted as replay", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "r25-c4-final-"));
  const dec = decomposition();
  const file = outputFile(root, "final.mp4", "candidate-four");
  const cp = checkpoint(dec, 1, file.identity);
  validateR25Candidate4Checkpoint(cp, {
    decomposition: dec,
    segment: dec.segments[1],
    outputPath: file.filePath
  });
  writeFileSync(file.filePath, "different-candidate-four");
  assert.throws(() => validateR25Candidate4Checkpoint(cp, {
    decomposition: dec,
    segment: dec.segments[1],
    outputPath: file.filePath
  }), /bytes\/hash mismatch/);
});

test("R25 checkpoint contract and operation identities are byte-stable on exact replay", () => {
  const a = decomposition();
  const b = decomposition();
  assert.equal(a.decompositionDigest, b.decompositionDigest);
  assert.deepEqual(a.segments.map((x) => x.operationId), b.segments.map((x) => x.operationId));
  const cpa = checkpoint(a, 0, { sha256: SHA("d"), size: 10 });
  const cpb = checkpoint(b, 0, { sha256: SHA("d"), size: 10 });
  assert.equal(cpa.contractVersion, MEDIA_R25_CANDIDATE4_CHECKPOINT_VERSION);
  assert.equal(stableStringify(cpa), stableStringify(cpb));
});
