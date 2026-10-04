import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stableStringify } from "../src/index.js";

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const token=process.env.GITHUB_TOKEN;
const runId=Number(process.env.GITHUB_RUN_ID??"");
const headSha=process.env.GITHUB_SHA??"";
if(!token)throw new Error("GITHUB_TOKEN required");
if(!Number.isInteger(runId)||runId<=0)throw new Error("GITHUB_RUN_ID required");
if(!/^[a-f0-9]{40}$/.test(headSha))throw new Error("GITHUB_SHA required");

async function githubJson(url){
  const res=await fetch(url,{headers:{
    Accept:"application/vnd.github+json",
    Authorization:`Bearer ${token}`,
    "X-GitHub-Api-Version":"2022-11-28",
    "User-Agent":"foto6-video2-r24-readiness-recorder"
  }});
  if(!res.ok)throw new Error(`GitHub API failed ${res.status}: ${await res.text()}`);
  return res.json();
}

const data=await githubJson(`https://api.github.com/repos/foto6/video2/actions/runs/${runId}/artifacts?per_page=100`);
const artifact=(data.artifacts??[]).find((a)=>a.name==="media-r24-canonical-live-review-export");
if(!artifact)throw new Error("media-r24-canonical-live-review-export not visible in current run");
if(artifact.expired)throw new Error("R24 artifact unexpectedly expired");
if(typeof artifact.digest!=="string"||!artifact.digest.startsWith("sha256:"))throw new Error("R24 artifact digest missing");

const evidencePath=path.join(repoRoot,".artifacts","r24-demo","r24-readiness-evidence.json");
const evidence=JSON.parse(readFileSync(evidencePath,"utf8"));
const report={
  reportVersion:"media.r24.actions_readiness.v1",
  repository:"foto6/video2",
  branch:"agent/media-r24-canonical-live-artifact-20261002",
  headSha,
  runId,
  artifact:{
    id:artifact.id,
    name:artifact.name,
    digest:artifact.digest,
    size:artifact.size_in_bytes,
    createdAt:artifact.created_at,
    expiresAt:artifact.expires_at
  },
  canonicalExports:evidence.rounds.map((round)=>({
    mode:round.mode,
    reviewRound:round.reviewRound,
    sessionId:round.sessionId,
    packageDigest:round.packageDigest,
    payloadDirectoryDigest:round.payloadDirectoryDigest,
    archiveSha256:round.archive.sha256,
    archiveSize:round.archive.size,
    promptDigest:round.promptDigest,
    sealedMappingDigest:round.sealedMappingDigest,
    attachments:round.attachments
  })),
  modelReviewPerformed:false,
  liveModelReviewed:false,
  providerPublish:false,
  humanQuality:false
};
const out=path.join(repoRoot,".artifacts","r24-actions-readiness.json");
mkdirSync(path.dirname(out),{recursive:true});
writeFileSync(out,stableStringify(report)+"\n");
console.log("R24_ACTIONS_READINESS",stableStringify(report));
