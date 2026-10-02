import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, stableStringify } from "../src/index.js";

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const root=path.join(repoRoot,".artifacts","r23-demo");
rmSync(root,{recursive:true,force:true});
mkdirSync(root,{recursive:true});

function run(args){return execFileSync(process.execPath,args,{cwd:repoRoot,env:process.env,encoding:"utf8",windowsHide:true,maxBuffer:32*1024*1024});}
function hashFile(file){const b=readFileSync(file);return {sha256:createHash("sha256").update(b).digest("hex"),size:b.length};}
function writeJson(file,value){mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,stableStringify(value)+"\n");}
function appHandoffDigest(candidate){
  const app=JSON.parse(readFileSync(path.join(repoRoot,candidate.editorialApplication.path),"utf8"));
  return app.handoff.digest;
}
function exportSession(name,request){
  const requestPath=path.join(root,name+"-request.json");
  const out=path.join(root,name);
  writeJson(requestPath,request);
  const ci=process.env.GITHUB_RUN_ID||"424242";
  const args=[path.join(repoRoot,"tools","export-r23-next-round.mjs"),"--request",requestPath,"--sandbox-root",repoRoot,"--output-dir",out,"--producer-ci-run-id",ci];
  const first=run(args);
  const sessionPath=path.join(out,"media.review_session_package.r23.v1.json");
  const archivePath=path.join(out,"operator","media-r22-live-package.tar");
  const beforeSession=readFileSync(sessionPath);
  const beforeArchive=readFileSync(archivePath);
  const second=run(args);
  if(!beforeSession.equals(readFileSync(sessionPath))||!beforeArchive.equals(readFileSync(archivePath)))throw new Error(name+" replay drift");
  const session=JSON.parse(beforeSession);
  const bundle=JSON.parse(readFileSync(path.join(out,"r21-round","media.review_round_bundle.r21.v1.json"),"utf8"));
  const sealed=JSON.parse(readFileSync(path.join(out,"r21-round","media.review_round_sealed_mapping.r21.v1.json"),"utf8"));
  for(const entry of sealed.entries){
    for(const secret of [entry.candidateId,entry.render&&entry.render.sha256,entry.renderProducerSha,entry.mediaApplicationDigest,entry.growthHandoffDigest].filter(Boolean)){
      if(bundle.prompt.text.includes(secret))throw new Error(name+" prompt leaked sealed identity");
    }
  }
  for(const a of session.attachments){
    const p=path.join(out,"operator","payload",a.name);
    const actual=hashFile(p);
    if(actual.sha256!==a.sha256||actual.size!==a.size)throw new Error(name+" attachment drift");
  }
  return {out,session,sessionFile:hashFile(sessionPath),archive:hashFile(archivePath),firstLogSha256:createHash("sha256").update(first).digest("hex"),secondLogSha256:createHash("sha256").update(second).digest("hex")};
}

if(!existsSync(path.join(repoRoot,".artifacts","r21-demo","initial-request.json"))){run([path.join(repoRoot,"tools","demo-r21-review-round.mjs")]);}
const initialR21=JSON.parse(readFileSync(path.join(repoRoot,".artifacts","r21-demo","initial-request.json"),"utf8"));
const round1R21=JSON.parse(readFileSync(path.join(repoRoot,".artifacts","r21-demo","round-1-request.json"),"utf8"));
const ir=initialR21.review;
const round0Request={
  contractVersion:"media.review_session_request.r23.v1",sessionId:"r23-real-session",mode:"initial",reviewRound:0,
  source:{sourceId:ir.left.candidate.source.sourceId,sha256:ir.left.candidate.source.sha256,size:ir.left.candidate.source.size},
  briefLineageDigest:ir.left.briefLineageDigest,growthSelectedEnvelopeDigest:null,growthHandoffDigest:null,
  initial:{left:ir.left.candidate,right:ir.right.candidate}
};
const round0=exportSession("round-0",round0Request);
const tr=round1R21.review;
const round1Request={
  contractVersion:"media.review_session_request.r23.v1",sessionId:"r23-real-session",mode:"targeted_reedit",reviewRound:1,
  source:{sourceId:tr.baseline.candidate.source.sourceId,sha256:tr.baseline.candidate.source.sha256,size:tr.baseline.candidate.source.size},
  briefLineageDigest:tr.baseline.briefLineageDigest,
  growthSelectedEnvelopeDigest:fingerprint({fixture:"growth-selected-envelope",round:1,render:tr.challenger.candidate.render.sha256}),
  growthHandoffDigest:appHandoffDigest(tr.challenger.candidate),
  baseline:{candidate:tr.baseline.candidate,priorReviewPackageDigest:round0.session.r21.packageDigest,priorSealedMappingDigest:round0.session.sealedMappingDigest},
  challenger:tr.challenger.candidate
};
const round1=exportSession("round-1",round1Request);
if(round1.session.challenger.editorialApplication.digest!==tr.challenger.candidate.editorialApplication.digest)throw new Error("round-1 application lineage lost");
if(round1.session.growthHandoffDigest!==appHandoffDigest(tr.challenger.candidate))throw new Error("round-1 Growth handoff digest lost");

const conflict=structuredClone(round1Request);
conflict.growthSelectedEnvelopeDigest=fingerprint({fixture:"changed-selected-envelope"});
const conflictPath=path.join(root,"round-1-conflict-request.json");
writeJson(conflictPath,conflict);
let conflictRejected=false;
try{run([path.join(repoRoot,"tools","export-r23-next-round.mjs"),"--request",conflictPath,"--sandbox-root",repoRoot,"--output-dir",round1.out,"--producer-ci-run-id",process.env.GITHUB_RUN_ID||"424242"]);}catch{conflictRejected=true;}
if(!conflictRejected)throw new Error("changed same-session/round input did not conflict");

const summary={
  evidenceVersion:"media.review_session_package.r23.demo.v1",
  producerSha:execFileSync("git",["rev-parse","HEAD"],{cwd:repoRoot,encoding:"utf8"}).trim(),
  producerCiRunId:Number(process.env.GITHUB_RUN_ID||424242),state:"REVIEW_SESSION_PACKAGE_READY",
  source:round0.session.source,briefLineageDigest:round0.session.briefLineageDigest,
  rounds:[round0,round1].map(function(row){return {mode:row.session.mode,reviewRound:row.session.reviewRound,sessionIdentity:row.session.sessionIdentity,sessionPackageSha256:row.sessionFile.sha256,r21PackageDigest:row.session.r21.packageDigest,r22DirectoryDigest:row.session.r22.directoryDigest,r22ArchiveSha256:row.session.r22.archiveSha256,r22ArchiveSize:row.session.r22.archiveSize,attachments:row.session.attachments,promptDigest:row.session.promptDigest,sealedMappingDigest:row.session.sealedMappingDigest,baseline:row.session.baseline,challenger:row.session.challenger,replayByteStable:true};}),
  round2RequestValidationCoveredByFocusedTests:true,
  round1GrowthSelectedEnvelopeDigest:round1.session.growthSelectedEnvelopeDigest,
  round1GrowthHandoffDigest:round1.session.growthHandoffDigest,
  changedSameSessionRoundConflictRejected:conflictRejected,actualRealMp4Bytes:true,modelReviewPerformed:false,liveModelReviewed:false,providerPublish:false,humanQuality:false
};
writeJson(path.join(root,"r23-readiness-evidence.json"),summary);
console.log("R23_DEMO",stableStringify(summary));
