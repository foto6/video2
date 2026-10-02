import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  materializeLiveReviewArtifact,
  stableStringify
} from "../src/index.js";

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
function arg(flag){const i=process.argv.indexOf(flag);return i>=0&&process.argv[i+1]?process.argv[i+1]:"";}
function git(args){return execFileSync("git",args,{cwd:repoRoot,encoding:"utf8",windowsHide:true}).trim();}
function blob(file){return git(["hash-object",file]);}

const sourceDir=arg("--r21-round-dir");
const outDir=arg("--out-dir");
if(!sourceDir||!outDir)throw new Error("--r21-round-dir and --out-dir are required");

const producerSha=git(["rev-parse","HEAD"]);
if(process.env.GITHUB_SHA&&process.env.GITHUB_SHA!==producerSha){
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}
const runId=process.env.GITHUB_RUN_ID?Number(process.env.GITHUB_RUN_ID):null;
const materializerBlobs={
  implementation:blob("src/live-review-artifact-r22.js"),
  materializer:blob("tools/materialize-r22-live-review.mjs"),
  verifier:blob("tools/verify-r22-live-review.mjs"),
  extractor:blob("tools/extract-r22-live-review.mjs"),
  contract:blob("conformance/media.live_review_artifact.r22.v1/contract.json"),
  operatorManifestSchema:blob("conformance/media.live_review_artifact.r22.v1/operator-manifest.schema.json")
};
const result=materializeLiveReviewArtifact({
  r21RoundDir:path.resolve(sourceDir),
  outputDir:path.resolve(outDir),
  materializerProducerSha:producerSha,
  materializerCiRunId:Number.isInteger(runId)?runId:null,
  materializerBlobs
});
console.log("R22_MATERIALIZED",stableStringify({
  producerSha,
  materializerCiRunId:Number.isInteger(runId)?runId:null,
  operatorDir:result.operatorDir,
  mode:result.mode,
  reviewRound:result.reviewRound,
  packageDigest:result.packageDigest,
  sealedMappingDigest:result.sealedMappingDigest,
  promptDigest:result.promptDigest,
  packageManifestSha256:result.packageManifestSha256,
  operatorManifestSha256:result.operatorManifestSha256,
  archiveSha256:result.archiveSha256,
  archiveSize:result.archiveSize,
  attachments:result.attachments,
  verified:result.verification.ok,
  liveModelReviewed:false,
  humanQuality:false
}));
