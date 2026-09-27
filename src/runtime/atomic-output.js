import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import path from "node:path";

import { runtimeError } from "./errors.js";

export function tempOutputPath(finalPath, jobId) {
  const safeJobId = String(jobId).replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${safeJobId}.partial`);
}

export function prepareTempOutput(finalPath, jobId) {
  mkdirSync(path.dirname(finalPath), { recursive: true });
  const tempPath = tempOutputPath(finalPath, jobId);
  if (existsSync(tempPath)) unlinkSync(tempPath);
  return tempPath;
}

export function cleanupTempOutput(tempPath) {
  if (tempPath && existsSync(tempPath)) unlinkSync(tempPath);
}

export function atomicFinalize(tempPath, finalPath) {
  try {
    if (!existsSync(tempPath)) throw new Error("temporary render output does not exist");
    mkdirSync(path.dirname(finalPath), { recursive: true });
    if (existsSync(finalPath)) unlinkSync(finalPath);
    renameSync(tempPath, finalPath);
  } catch (error) {
    throw runtimeError("finalize_failed", `failed to finalize output: ${error.message}`);
  }
}

export async function outputDigest(filePath) {
  const size = statSync(filePath).size;
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { size, sha256: hash.digest("hex") };
}
