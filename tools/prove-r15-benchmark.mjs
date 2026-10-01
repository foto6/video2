import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_RENDER_EXPORT_FILENAME,
  R15_BOSS_BENCHMARK_BINDING,
  renderExportDigest,
  stableStringify,
  validateRenderExportAgainstFinal
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

function findFiles(root, name, out = []) {
  for (const entry of readdirSync(root)) {
    const filePath = path.join(root, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) findFiles(filePath, name, out);
    else if (entry === name) out.push(filePath);
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
const inputRoot = path.resolve(args["input-root"] ?? path.join(repoRoot, ".artifacts", "r14-shards"));
const outputRoot = path.resolve(args["output-dir"] ?? path.join(repoRoot, ".artifacts", "r15-benchmark-proof"));
if (!existsSync(inputRoot)) throw new Error(`input root does not exist: ${inputRoot}`);
mkdirSync(outputRoot, { recursive: true });

const producerSha = gitHead();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked-out HEAD ${producerSha}`);
}

const finals = findFiles(inputRoot, "final.mp4").sort();
if (finals.length === 0) throw new Error("no real generated final.mp4 found");
const proofs = [];
for (const finalPath of finals) {
  const dir = path.dirname(finalPath);
  const sidecarPath = path.join(dir, MEDIA_RENDER_EXPORT_FILENAME);
  if (!existsSync(sidecarPath)) throw new Error(`missing canonical render export beside ${finalPath}`);
  const record = JSON.parse(readFileSync(sidecarPath, "utf8"));
  validateRenderExportAgainstFinal(record, finalPath);
  if (record.producer.sha !== producerSha) {
    throw new Error(`stale producer SHA beside ${finalPath}: ${record.producer.sha}`);
  }

  const required = [
    "render-manifest.json",
    "probe.json",
    "technical-qa.json",
    "creative-quality.json",
    "acceptance.json",
    "human-review-targets.json"
  ];
  const missing = required.filter((name) => !existsSync(path.join(dir, name)));
  const contactSheet = existsSync(path.join(dir, "contact-sheet.jpg"));
  const bundleDir = path.join(dir, "bundle");
  const preview = existsSync(bundleDir) &&
    readdirSync(bundleDir, { withFileTypes: true })
      .some((entry) => entry.isFile() && /^preview\.sha256-[a-f0-9]{64}\.mp4$/.test(entry.name));
  if (missing.length || (!contactSheet && !preview)) {
    throw new Error(`boss benchmark bundle incomplete for ${finalPath}: ${missing.join(",")}`);
  }
  if (readFileSync(path.join(dir, "render-manifest.json"), "utf8") !== readFileSync(sidecarPath, "utf8")) {
    throw new Error(`render-manifest.json differs from canonical export for ${finalPath}`);
  }
  if (record.benchmark.technicalDq !== false || record.benchmark.technicalDqReasons.length !== 0) {
    throw new Error(`technical DQ in generated benchmark proof for ${finalPath}`);
  }
  proofs.push({
    finalMp4: path.relative(inputRoot, finalPath).split(path.sep).join("/"),
    renderExportDigest: renderExportDigest(record),
    finalSha256: record.artifact.sha256,
    finalSize: record.artifact.size,
    dimensions: [record.probe.width, record.probe.height],
    fps: record.probe.fps,
    durationMs: record.probe.durationMs,
    technicalQaPassed: record.qa.technical.passed,
    creativeQaPassed: record.qa.creative.passed,
    technicalDq: false
  });
}

const evidence = {
  evidenceVersion: "media.r15.benchmark_readiness.v1",
  producer: { repository: "foto6/video2", sha: producerSha },
  benchmark: R15_BOSS_BENCHMARK_BINDING,
  generatedMediaParityEligible: false,
  note: "Generated media proves engineering compatibility and technical-DQ handling only; it counts as zero human-parity samples.",
  realGeneratedMp4Count: proofs.length,
  proof: proofs[0],
  allProofsTechnicalDqFree: proofs.every((entry) => entry.technicalDq === false)
};
writeFileSync(
  path.join(outputRoot, "media.r15.benchmark_readiness.v1.json"),
  `${stableStringify(evidence)}\n`
);
console.log("R15_BENCHMARK_PROOF", stableStringify(evidence));
