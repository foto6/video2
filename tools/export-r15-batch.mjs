import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFailedRenderExport,
  buildSucceededRenderExport,
  renderExportDigest,
  stableStringify,
  validateRenderExportAgainstFinal,
  writeRenderExportSidecar
} from "../src/index.js";

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
    } else out[key] = true;
  }
  return out;
}

function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  }).trim();
}

const args = parseArgs(process.argv.slice(2));
const jobsFile = path.resolve(args["jobs-file"] ?? path.join(repoRoot, ".artifacts", "r14-acceptance", "jobs.json"));
if (!existsSync(jobsFile)) throw new Error(`jobs file does not exist: ${jobsFile}`);
const producerSha = gitHead();
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid producer SHA");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked-out HEAD ${producerSha}`);
}

const root = path.dirname(jobsFile);
const store = JSON.parse(readFileSync(jobsFile, "utf8"));
const jobs = Object.values(store.jobs ?? {}).sort((a, b) => String(a.id).localeCompare(String(b.id)));
if (jobs.length === 0) throw new Error("jobs file contains no jobs");

const results = [];
for (const job of jobs) {
  const outputPath = path.resolve(root, job.outputPath ?? path.join("renders", job.id, "final.mp4"));
  const renderDir = path.dirname(outputPath);
  mkdirSync(renderDir, { recursive: true });
  let record;
  if (job.status === "succeeded") {
    if (!job.artifactManifest) throw new Error(`succeeded job ${job.id} is missing artifact manifest`);
    record = buildSucceededRenderExport({
      job,
      finalPath: outputPath,
      artifactManifest: job.artifactManifest,
      producerSha
    });
    validateRenderExportAgainstFinal(record, outputPath);
  } else {
    record = buildFailedRenderExport({ job, producerSha });
  }

  const sidecarPath = path.join(renderDir, "media.render_export.v1.json");
  const sidecar = writeRenderExportSidecar(record, sidecarPath);
  const compatibilityPath = path.join(renderDir, "render-manifest.json");
  const compatibilityContent = `${stableStringify(record)}\n`;
  if (existsSync(compatibilityPath)) {
    if (readFileSync(compatibilityPath, "utf8") !== compatibilityContent) {
      throw new Error(`render-manifest replay conflict for ${job.id}`);
    }
  } else {
    writeFileSync(compatibilityPath, compatibilityContent);
  }
  results.push({
    jobId: job.id,
    status: record.status,
    outputPath: path.relative(root, outputPath).split(path.sep).join("/"),
    sidecarPath: path.relative(root, sidecarPath).split(path.sep).join("/"),
    renderExportDigest: renderExportDigest(record),
    replayed: sidecar.replayed
  });
}

const summary = {
  summaryVersion: "media.render_export_batch.r15.v1",
  producer: { repository: "foto6/video2", sha: producerSha },
  jobsFile: path.basename(jobsFile),
  count: results.length,
  succeeded: results.filter((entry) => entry.status === "succeeded").length,
  failed: results.filter((entry) => entry.status === "failed").length,
  results
};
const summaryPath = path.resolve(args["summary"] ?? path.join(root, "media.render_export.batch.json"));
writeFileSync(summaryPath, `${stableStringify(summary)}\n`);
console.log("R15_BATCH_EXPORT", stableStringify(summary));
