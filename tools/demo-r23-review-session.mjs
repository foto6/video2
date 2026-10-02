import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, renderExportDigest, stableStringify } from "../src/index.js";

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const root=path.join(repoRoot,".artifacts","r23-demo");
rmSync(root,{recursive:true,force:true});
mkdirSync(root,{recursive:true});

function run(args){return execFileSync(process.execPath,args,{cwd:repoRoot,env:process.env,encoding:"utf8",windowsHide:true,maxBuffer:32*1024*1024});}
function hashFile(file){const b=readFileSync(file);return {sha256:createHash("sha256").update(b).digest("hex"),size:b.length};}
function writeJson(file,value){mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,stableStringify(value)+"\n");}
function rel(file){const r=path.relative(repoRoot,file).split(path.sep).join("/");if(!r||r.startsWith("../")||path.isAbsolute(r))throw new Error("path escapes repo");return r;}
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

function makeRound2Candidate(){
  const parent=tr.challenger.candidate;
  const parentAppPath=path.join(repoRoot,parent.editorialApplication.path);
  const parentDir=path.dirname(parentAppPath);
  const plan=JSON.parse(readFileSync(path.join(parentDir,"media.editorial_reedit_plan.r19.v1.json"),"utf8"));
  const original=JSON.parse(readFileSync(path.join(repoRoot,".artifacts","r19-demo","cases","talking-head-vertical","request.json"),"utf8"));
  const binding={...original.handoff.binding,
    source_id:parent.source.sourceId,
    source_sha256:parent.source.sha256,
    source_size:parent.source.size,
    media_producer_sha:parent.renderProducerSha,
    candidate_id:parent.candidateId,
    render_sha256:parent.render.sha256,
    render_size:parent.render.size,
    render_export_sha256:parent.renderExport.fileSha256,
    attachment_sha256:parent.render.sha256,
    attachment_size:parent.render.size,
    attachment_identity:"r23:"+fingerprint({sha256:parent.render.sha256,size:parent.render.size}),
    review_bundle_digest:fingerprint({fixture:"r23-round2-review",parent:parent.render.sha256}),
    critic_input_digest:fingerprint({fixture:"r23-round2-input"}),
    critic_output_digest:fingerprint({fixture:"r23-round2-output"})
  };
  const body={
    operation:"crop_scale_reframe",
    start_ms:500,
    end_ms:900,
    defect_category:"subject_framing_crop_quality",
    severity:"minor",
    source_observation_id:"r23-round2-observation",
    evidence:"deterministic R23 second real re-edit rehearsal",
    confidence:0.87,
    uncertainty:"fixture contract rehearsal; not human ground truth",
    upstream_proposed_edit:"audit-only suggestion",
    upstream_proposed_edit_executable:false,
    binding
  };
  const directive={...body,directive_id:"gcrd1:"+fingerprint(body)};
  const handoff={...structuredClone(original.handoff),
    handoff_id:"",
    handoff_digest:"",
    state:"targeted_reedit",
    reedit_round:1,
    max_reedit_rounds:2,
    binding,
    pairwise:{selection:"A",mapped_candidate_id:parent.candidateId,output_digest:fingerprint({fixture:"r23-round2-pairwise"})},
    coverage:{
      method:"targeted_ranges",
      inspected_ranges:[{start_ms:0,end_ms:plan.timeline.canvas.durationMs,kind:"targeted_recheck"}],
      uninspected_possible:true,
      every_frame_inspected:false,
      notes:"R23 deterministic round-2 rehearsal.",
      coverage_uncertainty_preserved:true
    },
    summary_uncertainty:"Fixture rehearsal only.",
    directives:[directive]
  };
  handoff.handoff_id="gcrh1:"+fingerprint({
    critic_output_digest:binding.critic_output_digest,
    pairwise_output_digest:handoff.pairwise.output_digest,
    reedit_round:1
  });
  const hm=structuredClone(handoff);hm.handoff_digest="";
  handoff.handoff_digest=fingerprint(hm);
  const timeline=structuredClone(plan.timeline);
  for(const track of timeline.tracks??[]){
    for(const item of track.items??[]){
      if(item.source?.uri && !item.source.uri.startsWith(".artifacts/")){
        item.source.uri=path.posix.join(".artifacts/r19-demo",item.source.uri.replaceAll("\\","/"));
      }
    }
  }
  const request={
    contractVersion:"media.editorial_reedit_request.r19.v1",
    requestId:"r23-round2-real-reedit",
    handoff,
    candidate:{
      candidateId:parent.candidateId,
      source:{sourceId:parent.source.sourceId,sha256:parent.source.sha256,size:parent.source.size},
      finalPath:parent.render.path,
      renderSha256:parent.render.sha256,
      renderSize:parent.render.size,
      renderExportPath:parent.renderExport.path,
      renderExportSha256:parent.renderExport.fileSha256,
      renderProducerSha:parent.renderProducerSha
    },
    timeline,
    exportSpec:plan.exportSpec
  };
  const requestPath=path.join(root,"round2-r19-request.json");
  const out=path.join(root,"round2-r19");
  writeJson(requestPath,request);
  run([path.join(repoRoot,"tools","run-r19-editorial-reedit.mjs"),"--request",requestPath,"--sandbox-root",repoRoot,"--output-dir",out]);
  const finalPath=path.join(out,"final.mp4");
  const renderExportPath=path.join(out,"media.render_export.v1.json");
  const appPath=path.join(out,"media.editorial_reedit_application.v1.json");
  const render=hashFile(finalPath);
  const renderExportFile=hashFile(renderExportPath);
  const renderExport=JSON.parse(readFileSync(renderExportPath,"utf8"));
  const appFile=hashFile(appPath);
  const app=JSON.parse(readFileSync(appPath,"utf8"));
  return {
    candidateId:"r23-round2-challenger",
    roundNumber:2,
    source:{...parent.source},
    render:{path:rel(finalPath),sha256:render.sha256,size:render.size},
    renderExport:{path:rel(renderExportPath),fileSha256:renderExportFile.sha256,digest:renderExportDigest(renderExport)},
    renderProducerSha:renderExport.producer.sha,
    editorialApplication:{path:rel(appPath),fileSha256:appFile.sha256,digest:fingerprint(app)},
    reviewDerivative:null
  };
}
const challenger2=makeRound2Candidate();
const round2Request={
  contractVersion:"media.review_session_request.r23.v1",
  sessionId:"r23-real-session",
  mode:"targeted_reedit",
  reviewRound:2,
  source:{sourceId:tr.challenger.candidate.source.sourceId,sha256:tr.challenger.candidate.source.sha256,size:tr.challenger.candidate.source.size},
  briefLineageDigest:tr.challenger.briefLineageDigest,
  growthSelectedEnvelopeDigest:fingerprint({fixture:"growth-selected-envelope",round:2,render:challenger2.render.sha256}),
  growthHandoffDigest:appHandoffDigest(challenger2),
  baseline:{candidate:tr.challenger.candidate,priorReviewPackageDigest:round1.session.r21.packageDigest,priorSealedMappingDigest:round1.session.sealedMappingDigest},
  challenger:challenger2
};
const round2=exportSession("round-2",round2Request);
if(round2.session.reviewRound!==2||round2.session.baseline.render.sha256!==tr.challenger.candidate.render.sha256)throw new Error("round-2 parent lineage lost");
if(round2.session.challenger.render.sha256!==challenger2.render.sha256)throw new Error("round-2 challenger lineage lost");

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
  rounds:[round0,round1,round2].map(function(row){return {mode:row.session.mode,reviewRound:row.session.reviewRound,sessionIdentity:row.session.sessionIdentity,sessionPackageSha256:row.sessionFile.sha256,r21PackageDigest:row.session.r21.packageDigest,r22DirectoryDigest:row.session.r22.directoryDigest,r22ArchiveSha256:row.session.r22.archiveSha256,r22ArchiveSize:row.session.r22.archiveSize,attachments:row.session.attachments,promptDigest:row.session.promptDigest,sealedMappingDigest:row.session.sealedMappingDigest,baseline:row.session.baseline,challenger:row.session.challenger,replayByteStable:true};}),
  round2RealR19ApplicationDigest:round2.session.challenger.editorialApplication.digest,
  round1GrowthSelectedEnvelopeDigest:round1.session.growthSelectedEnvelopeDigest,
  round1GrowthHandoffDigest:round1.session.growthHandoffDigest,
  changedSameSessionRoundConflictRejected:conflictRejected,actualRealMp4Bytes:true,modelReviewPerformed:false,liveModelReviewed:false,providerPublish:false,humanQuality:false
};
writeJson(path.join(root,"r23-readiness-evidence.json"),summary);
console.log("R23_DEMO",stableStringify(summary));
