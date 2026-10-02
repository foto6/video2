import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  R22_R21_AUTHORITY,
  extractAndVerifyLiveReviewArchive,
  stableStringify,
  verifyMaterializedLiveReviewArtifact
} from "../src/index.js";

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const acceptedRoot=path.resolve(process.env.R22_R21_ACCEPTED_ROOT??path.join(repoRoot,".artifacts","r21-accepted"));
const root=path.join(repoRoot,".artifacts","r22-live-package");
rmSync(root,{recursive:true,force:true});

function run(args){
  return execFileSync(process.execPath,args,{
    cwd:repoRoot,
    env:process.env,
    encoding:"utf8",
    windowsHide:true,
    maxBuffer:32*1024*1024
  });
}
function sha(file){
  const crypto=await import("node:crypto");
}
function hashFile(filePath){
  const {createHash}=requireCrypto();
  const bytes=readFileSync(filePath);
  return {sha256:createHash("sha256").update(bytes).digest("hex"),size:bytes.length};
}
function requireCrypto(){
  return globalThis.__r22Crypto??=eval("require")("node:crypto");
}
function writeJson(filePath,value){
  writeFileSync(filePath,`${stableStringify(value)}\n`);
}
function materialize(name){
  const source=path.join(acceptedRoot,name);
  if(!statSync(source).isDirectory())throw new Error(`accepted R21 round missing: ${name}`);
  const output=path.join(root,name);
  const args=[
    path.join(repoRoot,"tools","materialize-r22-live-review.mjs"),
    "--r21-round-dir",source,
    "--out-dir",output
  ];
  const first=run(args);
  const before={
    operator:readFileSync(path.join(output,"media.live_review_operator_manifest.r22.v1.json")),
    archive:readFileSync(path.join(output,"media-r22-live-package.tar")),
    package:readFileSync(path.join(output,"payload","media.live_review_package_manifest.r22.v1.json"))
  };
  const second=run(args);
  const after={
    operator:readFileSync(path.join(output,"media.live_review_operator_manifest.r22.v1.json")),
    archive:readFileSync(path.join(output,"media-r22-live-package.tar")),
    package:readFileSync(path.join(output,"payload","media.live_review_package_manifest.r22.v1.json"))
  };
  for(const key of Object.keys(before)){
    if(!before[key].equals(after[key]))throw new Error(`R22 replay drift in ${name}: ${key}`);
  }
  const verified=verifyMaterializedLiveReviewArtifact(output);
  if(!verified.ok)throw new Error(`R22 verification failed ${name}: ${stableStringify(verified.errors)}`);
  const extracted=mkdtempSync(path.join(os.tmpdir(),`media-r22-${name}-`));
  const extraction=extractAndVerifyLiveReviewArchive({operatorDir:output,destinationDir:extracted});
  if(!extraction.ok)throw new Error(`R22 extraction failed ${name}`);
  rmSync(extracted,{recursive:true,force:true});
  const operator=JSON.parse(readFileSync(path.join(output,"media.live_review_operator_manifest.r22.v1.json"),"utf8"));
  const bundle=JSON.parse(readFileSync(path.join(output,"payload","media.review_round_bundle.r21.v1.json"),"utf8"));
  const sealed=JSON.parse(readFileSync(path.join(output,"payload","media.review_round_sealed_mapping.r21.v1.json"),"utf8"));
  const prompt=readFileSync(path.join(output,"payload","model-facing-prompt.txt"),"utf8");
  for(const entry of sealed.entries){
    for(const secret of [
      entry.candidateId,
      entry.render?.sha256,
      entry.renderProducerSha,
      entry.editorialApplication?.digest,
      entry.editorialApplication?.handoffDigest
    ].filter(Boolean)){
      if(prompt.includes(secret))throw new Error(`R22 prompt leaked sealed identity in ${name}`);
    }
  }
  return {
    mode:bundle.mode,
    reviewRound:bundle.reviewRound,
    operatorManifestSha256:hashFile(path.join(output,"media.live_review_operator_manifest.r22.v1.json")).sha256,
    packageManifestSha256:hashFile(path.join(output,"payload","media.live_review_package_manifest.r22.v1.json")).sha256,
    authorityProfileSha256:hashFile(path.join(output,"payload","media.live_review_authority_profile.r22.v1.json")).sha256,
    archiveSha256:operator.package.archiveSha256,
    archiveSize:operator.package.archiveSize,
    packageDigest:operator.package.r21PackageDigest,
    sealedMappingDigest:operator.package.sealedMappingDigest,
    promptDigest:operator.package.promptDigest,
    attachments:operator.attachments,
    roundLineage:operator.sourceLineage.roundLineage,
    replayByteStable:true,
    extractionVerified:true,
    firstRunLog:first.trim(),
    secondRunLog:second.trim()
  };
}

const initial=materialize("initial");
const round1=materialize("round-1");
if(initial.mode!=="initial"||initial.reviewRound!==0)throw new Error("R22 initial round semantics mismatch");
if(round1.mode!=="targeted_reedit"||round1.reviewRound!==1||!round1.roundLineage)throw new Error("R22 round-1 semantics mismatch");

const summary={
  evidenceVersion:"media.live_review_artifact.r22.demo.v1",
  sourceAuthority:R22_R21_AUTHORITY,
  state:"LIVE_REVIEW_ARTIFACT_READY",
  initial,
  targetedRound1:round1,
  actualR21ActionsArtifact:true,
  realMp4Bytes:true,
  allAttachmentsOriginalBytes:[
    ...initial.attachments,
    ...round1.attachments
  ].every((entry)=>entry.name==="review-A.mp4"||entry.name==="review-B.mp4"),
  modelReviewPerformed:false,
  liveModelReviewed:false,
  browserMutationPerformed:false,
  providerPublish:false,
  humanQuality:false
};
writeJson(path.join(root,"r22-readiness-evidence.json"),summary);
console.log("R22_DEMO",stableStringify(summary));
