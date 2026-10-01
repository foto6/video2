import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableStringify } from "../src/index.js";
import { summarizeMvpAcceptance } from "../src/acceptance-r14.js";

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

const args = parseArgs(process.argv.slice(2));
const inputRoot = path.resolve(args["input-dir"] ?? path.join(repoRoot, ".artifacts", "r14-shards"));
const outputRoot = path.resolve(args["output-dir"] ?? path.join(repoRoot, ".artifacts", "r14-aggregate"));
if (!existsSync(inputRoot)) throw new Error(`R14 shard directory does not exist: ${inputRoot}`);
mkdirSync(outputRoot, { recursive: true });

const producerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked-out HEAD ${producerSha}`);
}

const summaryFiles = findFiles(inputRoot, "mvp-acceptance-summary.json").sort();
if (summaryFiles.length !== 7) {
  throw new Error(`expected 7 R14 shard summaries, found ${summaryFiles.length}`);
}

const results = [];
const seenCases = new Set();
for (const filePath of summaryFiles) {
  const shard = JSON.parse(readFileSync(filePath, "utf8"));
  if (shard?.producer?.sha !== producerSha) {
    throw new Error(`stale producer SHA in ${filePath}: ${shard?.producer?.sha}`);
  }
  const caseIds = new Set((shard.results ?? []).map((entry) => entry.caseId));
  if (caseIds.size !== 1) throw new Error(`shard must contain exactly one case: ${filePath}`);
  const caseId = [...caseIds][0];
  if (seenCases.has(caseId)) throw new Error(`duplicate R14 shard for case ${caseId}`);
  seenCases.add(caseId);
  for (const entry of shard.results ?? []) {
    results.push({
      ...entry,
      ciShard: path.relative(inputRoot, path.dirname(filePath)).split(path.sep).join("/")
    });
  }
}

const expectedCases = new Set([
  "talking-head-pauses",
  "landscape-reframe",
  "fast-motion",
  "low-motion",
  "speech-music",
  "subtitle-heavy",
  "broll-insert"
]);
for (const id of expectedCases) {
  if (!seenCases.has(id)) throw new Error(`missing R14 shard for case ${id}`);
}
if (results.length !== 14) throw new Error(`expected 14 case/style results, found ${results.length}`);

const summary = summarizeMvpAcceptance({
  producerSha,
  sourceRoot: "CI matrix shards",
  outputRoot,
  results
});
writeFileSync(path.join(outputRoot, "mvp-acceptance-summary.json"), `${stableStringify(summary)}\n`);

let markdown = "# R14 human review checklist\n\n";
markdown += "Objective QA can reject defects, but it cannot prove aesthetic quality. Every rendered output below requires visual inspection.\n\n";
for (const entry of results.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.style.localeCompare(b.style))) {
  markdown += `## ${entry.caseId} / ${entry.style} — ${entry.acceptance.status}\n\n`;
  markdown += `- CI shard: \`${entry.ciShard}\`\n`;
  if (entry.outputs?.finalMp4) markdown += `- Final MP4: \`${entry.outputs.finalMp4}\`\n`;
  if (entry.outputs?.contactSheetJpeg) markdown += `- Contact sheet: \`${entry.outputs.contactSheetJpeg}\`\n`;
  const aesthetic = (entry.acceptance.warnings ?? []).filter((warning) => warning.code === "human_aesthetic_review");
  for (const warning of aesthetic) markdown += `- Review: ${warning.message}\n`;
  markdown += "\n";
}
writeFileSync(path.join(outputRoot, "human-review.md"), markdown);

console.log("R14_AGGREGATE", stableStringify({
  producerSha,
  shardCount: summaryFiles.length,
  resultCount: summary.resultCount,
  status: summary.status,
  counts: summary.counts,
  failures: summary.failures.length,
  warnings: summary.warnings.length
}));

if (summary.counts.fail > 0) process.exitCode = 1;
