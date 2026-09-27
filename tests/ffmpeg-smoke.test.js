import {
  existsSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { DeterministicProcessExecutor, compileFfmpegCommand } from "../src/index.js";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

test("optional local ffmpeg smoke renders deterministic synthetic video", { skip: !ffmpegAvailable && "ffmpeg not available" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-ffmpeg-smoke-"));
  try {
    const output = path.join(root, "smoke.mp4");
    const timeline = {
      id: "ffmpeg-smoke",
      version: 1,
      canvas: { width: 64, height: 64, fps: 10, durationMs: 300 },
      tracks: []
    };
    const command = compileFfmpegCommand(
      timeline,
      { videoCodec: "mpeg4", videoBitrate: "250k", pixelFormat: "yuv420p" },
      output
    );
    const result = await new DeterministicProcessExecutor({ defaultTimeoutMs: 10000 }).run(command);
    assert.equal(result.ok, true, result.stderr);
    assert.equal(existsSync(output), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
