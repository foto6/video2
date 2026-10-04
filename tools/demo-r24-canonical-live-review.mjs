import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  stableStringify,
  verifyCanonicalLiveReviewExport
} from "../src/index.js";

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const acceptedRoot=path.resolve(process.env.R24_UPSTREAM_ROOT??path.join(repoRoot,".artifacts","r23-accepted"));
const root=path.join(repoRoot,".artifacts","r24-demo");
rmSync(root,{recursive:true,force:true});
mkdirSync(root,{recursive:true});

function run(args){
  return execFileSync(process.execPath,args,{
    cwd:repoRoot,env:process.env,encoding:"utf8",windowsHide:true,maxBuffer:32*1024*1024
  });
}
function hashFile(file){
  const b=readFileSync(file);
  return {sha256:createHash("sha256").update(b).digest("hex"),size:b.length};
}
function writeJson(file,value){
  mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file,stableStringify(value)+"\n");
}
function exportRound(name){
  const sourceDir=path.join(acceptedRoot,name);
  if(!existsSync(path.join(sourceDir,"media.review_session_package.r23.v1.json"))){
    throw new Error("accepted R23 source missing "+name);
  }
  const out=path.join(root,name);
  const ci=process.env.GITHUB_RUN_ID||"424242";
  const args=[
    path.join(repoRoot,"tools","export-r24-canonical-live-review.mjs"),
    "--session-dir",sourceDir,
    "--sandbox-root",repoRoot,
    "--output-dir",out,
    "--producer-ci-run-id",ci
  ];
  const first=run(args);
  const archivePath=path.join(out,"media-r24-canonical-live-review.tar");
  const indexPath=path.join(out,"media.canonical_live_review_export.r24.v1.json");
  const beforeArchive=readFileSync(archivePath);
  const beforeIndex=readFileSync(indexPath);
  const second=run(args);
  if(!beforeArchive.equals(readFileSync(archivePath))||!beforeIndex.equals(readFileSync(indexPath))){
    throw new Error(name+" replay changed canonical bytes");
  }
  const verify=verifyCanonicalLiveReviewExport(out);
  if(!verify.ok)throw new Error(name+" verification failed: "+stableStringify(verify.errors));
  const index=JSON.parse(beforeIndex);
  const handoff=JSON.parse(readFileSync(path.join(out,"payload","media.bridge_live_review_handoff.r24.v1.json"),"utf8"));
  const sealed=JSON.parse(readFileSync(path.join(out,"payload","machine","r21","media.review_round_sealed_mapping.r21.v1.json"),"utf8"));
  const prompt=readFileSync(path.join(out,"payload","model-facing-prompt.txt"),"utf8");
  for(const entry of sealed.entries??[]){
    for(const secret of [
      entry.candidateId,entry.role,entry.render&&entry.render.sha256,
      entry.renderProducerSha,entry.mediaApplicationDigest,entry.growthHandoffDigest
    ].filter(Boolean)){
      if(String(secret).length>=8&&prompt.includes(String(secret)))throw new Error(name+" prompt leaked sealed identity");
    }
  }
  if(JSON.stringify(handoff).includes('"candidateId"')||JSON.stringify(handoff).includes('"baseline"')||JSON.stringify(handoff).includes('"challenger"')){
    throw new Error(name+" Bridge handoff leaked sealed role identity");
  }
  for(const attachment of index.attachments){
    const actual=hashFile(path.join(out,"payload",attachment.relativePath));
    if(actual.sha256!==attachment.sha256||actual.size!==attachment.size)throw new Error(name+" attachment drift");
  }
  return {
    name,
    mode:index.sourceLineage.mode,
    reviewRound:index.sourceLineage.reviewRound,
    sessionId:index.sourceLineage.sessionId,
    sessionIdentity:index.sourceLineage.sessionIdentity,
    source:index.sourceLineage.source,
    briefLineageDigest:index.sourceLineage.briefLineageDigest,
    packageDigest:index.packageDigest,
    payloadDirectoryDigest:index.payloadDirectory.digest,
    archive:index.archive,
    exportIndex:hashFile(indexPath),
    packageManifest:index.packageManifest,
    authorityProfile:index.authorityProfile,
    bridgeHandoff:index.bridgeHandoff,
    promptDigest:index.promptDigest,
    sealedMappingDigest:index.sealedMappingDigest,
    attachments:index.attachments,
    nestedR23:index.nestedR23,
    replayByteStable:true,
    firstLogSha256:createHash("sha256").update(first).digest("hex"),
    secondLogSha256:createHash("sha256").update(second).digest("hex"),
    verified:true
  };
}

for(const name of ["round-0","round-1"]){
  if(!existsSync(path.join(acceptedRoot,name))){
    throw new Error("R24 requires exact accepted R23 artifact extracted under "+acceptedRoot);
  }
}
const round0=exportRound("round-0");
const round1=exportRound("round-1");
if(round0.reviewRound!==0||round0.mode!=="initial")throw new Error("round-0 context mismatch");
if(round1.reviewRound!==1||round1.mode!=="targeted_reedit")throw new Error("round-1 context mismatch");
if(round0.source.sha256!==round1.source.sha256||round0.briefLineageDigest!==round1.briefLineageDigest){
  throw new Error("round-0/round-1 source or brief lineage drift");
}
const summary={
  evidenceVersion:"media.canonical_live_review_export.r24.demo.v1",
  producer:{
    repository:"foto6/video2",
    sha:execFileSync("git",["rev-parse","HEAD"],{cwd:repoRoot,encoding:"utf8"}).trim(),
    ciRunId:Number(process.env.GITHUB_RUN_ID||424242)
  },
  state:"CANONICAL_LIVE_REVIEW_ARTIFACT_READY",
  source:round0.source,
  briefLineageDigest:round0.briefLineageDigest,
  rounds:[round0,round1],
  actualEncodedMp4Bytes:true,
  nonHumanGroundTruthDemo:true,
  modelReviewPerformed:false,
  liveModelReviewed:false,
  browserMutationPerformed:false,
  providerPublish:false,
  humanQuality:false
};
writeJson(path.join(root,"r24-readiness-evidence.json"),summary);
console.log("R24_DEMO",stableStringify(summary));
