import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LIVE_REVIEW_ARTIFACT_READY,
  MEDIA_LIVE_REVIEW_OPERATOR_MANIFEST_VERSION,
  R22_BRIDGE_R31_AUTHORITY,
  R22_R21_AUTHORITY,
  createDeterministicTar,
  readDeterministicTar,
  verifyMaterializedLiveReviewArtifact
} from "../src/index.js";

const repoRoot=path.resolve(new URL("..",import.meta.url).pathname);
const demoRoot=path.join(repoRoot,".artifacts","r22-live-package");

function hashFile(file){
  const bytes=readFileSync(file);
  return createHash("sha256").update(bytes).digest("hex");
}
function copied(name){
  const src=path.join(demoRoot,name);
  const dst=mkdtempSync(path.join(os.tmpdir(),`media-r22-${name}-`));
  cpSync(src,dst,{recursive:true});
  return dst;
}

test("R22 pins exact green R21 Actions and green Bridge R31 authorities",()=>{
  assert.equal(R22_R21_AUTHORITY.producerSha,"d753e9e4c1f4448386608a1425232dbc1dba87ea");
  assert.equal(R22_R21_AUTHORITY.ciRunId,36994000619);
  assert.equal(R22_R21_AUTHORITY.artifactId,11221240371);
  assert.equal(R22_R21_AUTHORITY.artifactDigest,"sha256:1036800923196882590ace62edbaa123ab4250b9d242e14adba909ba256ab022");
  assert.equal(R22_BRIDGE_R31_AUTHORITY.producerSha,"31cfef82663d72d53e69e6345b50073ffcd461ca");
  assert.equal(R22_BRIDGE_R31_AUTHORITY.ciRunId,36997793086);
  assert.equal(R22_BRIDGE_R31_AUTHORITY.expectedMediaProducerSha,R22_R21_AUTHORITY.producerSha);
});

test("R22 deterministic tar is byte-stable and rejects entry-order drift",()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),"media-r22-tar-"));
  writeFileSync(path.join(root,"a.txt"),"a");
  writeFileSync(path.join(root,"b.json"),"{\"b\":1}\n");
  const one=path.join(root,"one.tar");
  const two=path.join(root,"two.tar");
  const a=createDeterministicTar(root,["b.json","a.txt"],one);
  const b=createDeterministicTar(root,["a.txt","b.json"],two);
  assert.equal(a.sha256,b.sha256);
  assert.deepEqual(readFileSync(one),readFileSync(two));
  const parsed=readDeterministicTar(one);
  assert.deepEqual([...parsed.entries.keys()],["a.txt","b.json"]);
  assert.equal(parsed.entries.get("a.txt").toString("utf8"),"a");
});

test("R22 exact initial materialized directory verifies independently",{
  skip:!existsSync(path.join(demoRoot,"initial"))
},()=>{
  const verified=verifyMaterializedLiveReviewArtifact(path.join(demoRoot,"initial"));
  assert.equal(verified.ok,true,JSON.stringify(verified.errors));
  assert.equal(verified.mode,"initial");
  assert.equal(verified.reviewRound,0);
  assert.equal(verified.attachments.length,2);
  assert.notEqual(verified.attachments[0].sha256,verified.attachments[1].sha256);
});

test("R22 exact round-1 directory preserves R19 parent-child lineage and verifies",{
  skip:!existsSync(path.join(demoRoot,"round-1"))
},()=>{
  const root=path.join(demoRoot,"round-1");
  const verified=verifyMaterializedLiveReviewArtifact(root);
  assert.equal(verified.ok,true,JSON.stringify(verified.errors));
  assert.equal(verified.mode,"targeted_reedit");
  assert.equal(verified.reviewRound,1);
  const bundle=JSON.parse(readFileSync(path.join(root,"payload","media.review_round_bundle.r21.v1.json"),"utf8"));
  assert.equal(bundle.roundLineage.childRound,bundle.roundLineage.parentRound+1);
  assert.match(bundle.roundLineage.growthHandoffDigest,/^[a-f0-9]{64}$/);
  assert.match(bundle.roundLineage.mediaApplicationDigest,/^[a-f0-9]{64}$/);
});

test("R22 tampered MP4 fails independent verification",{
  skip:!existsSync(path.join(demoRoot,"initial"))
},()=>{
  const root=copied("initial");
  const file=path.join(root,"payload","review-A.mp4");
  writeFileSync(file,Buffer.concat([readFileSync(file),Buffer.from("tamper")]));
  const verified=verifyMaterializedLiveReviewArtifact(root);
  assert.equal(verified.ok,false);
  assert.match(verified.errors.join("\n"),/payload_identity_mismatch|attachment|hash|bytes/i);
});

test("R22 tampered deterministic archive fails closed",{
  skip:!existsSync(path.join(demoRoot,"initial"))
},()=>{
  const root=copied("initial");
  const file=path.join(root,"media-r22-live-package.tar");
  writeFileSync(file,Buffer.concat([readFileSync(file),Buffer.from("tamper")]));
  const verified=verifyMaterializedLiveReviewArtifact(root);
  assert.equal(verified.ok,false);
  assert.match(verified.errors.join("\n"),/archive_identity_mismatch|tar/i);
});

test("R22 operator path escape fails before payload use",{
  skip:!existsSync(path.join(demoRoot,"initial"))
},()=>{
  const root=copied("initial");
  const file=path.join(root,"media.live_review_operator_manifest.r22.v1.json");
  const manifest=JSON.parse(readFileSync(file,"utf8"));
  manifest.bridgeR31Inputs.artifactDirRelative="../outside";
  writeFileSync(file,`${JSON.stringify(manifest)}\n`);
  const verified=verifyMaterializedLiveReviewArtifact(root);
  assert.equal(verified.ok,false);
  assert.match(verified.errors.join("\n"),/escapes root|path/i);
});

test("R22 raw prompt is model-facing blind while sealed mapping remains separate",{
  skip:!existsSync(path.join(demoRoot,"round-1"))
},()=>{
  const root=path.join(demoRoot,"round-1");
  const prompt=readFileSync(path.join(root,"payload","model-facing-prompt.txt"),"utf8");
  const sealed=JSON.parse(readFileSync(path.join(root,"payload","media.review_round_sealed_mapping.r21.v1.json"),"utf8"));
  for(const word of ["baseline","challenger","winner","parent","child"]){
    assert.equal(prompt.toLowerCase().includes(word),false,word);
  }
  for(const entry of sealed.entries){
    for(const secret of [
      entry.candidateId,
      entry.render?.sha256,
      entry.renderProducerSha,
      entry.editorialApplication?.digest,
      entry.editorialApplication?.handoffDigest
    ].filter(Boolean)){
      assert.equal(prompt.includes(secret),false,secret);
    }
  }
});

test("R22 sanitized operator manifest is SOURCE_READY input metadata only",{
  skip:!existsSync(path.join(demoRoot,"initial"))
},()=>{
  const root=path.join(demoRoot,"initial");
  const operator=JSON.parse(readFileSync(path.join(root,"media.live_review_operator_manifest.r22.v1.json"),"utf8"));
  assert.equal(operator.contractVersion,MEDIA_LIVE_REVIEW_OPERATOR_MANIFEST_VERSION);
  assert.equal(operator.state,LIVE_REVIEW_ARTIFACT_READY);
  assert.equal(operator.bridgeR31Inputs.artifactDirRelative,"payload");
  assert.equal(operator.bridgeR31Inputs.archiveRelative,"media-r22-live-package.tar");
  assert.equal(operator.modelReviewPerformed,false);
  assert.equal(operator.liveModelReviewed,false);
  assert.equal(operator.browserMutationPerformed,false);
  assert.equal(operator.providerPublish,false);
  assert.equal(operator.humanQuality,false);
  assert.equal(Object.hasOwn(operator.sealedMapping,"entries"),false);
  assert.match(operator.bridgeR31Inputs.expectedArchiveSha256,/^[a-f0-9]{64}$/);
  assert.equal(hashFile(path.join(root,"media-r22-live-package.tar")),operator.bridgeR31Inputs.expectedArchiveSha256);
});


test("R22 conformance manifest pins exact materializer surface and frozen authorities",()=>{
  const manifest=JSON.parse(readFileSync(
    new URL("../conformance/media.live_review_artifact.r22.v1/manifest.json",import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion,"media.live_review_artifact.r22.v1");
  assert.equal(manifest.r21Authority.producerSha,R22_R21_AUTHORITY.producerSha);
  assert.equal(manifest.r21Authority.ciRunId,R22_R21_AUTHORITY.ciRunId);
  assert.equal(manifest.bridgeR31Authority.producerSha,R22_BRIDGE_R31_AUTHORITY.producerSha);
  assert.equal(manifest.requiredState,LIVE_REVIEW_ARTIFACT_READY);
  assert.equal(manifest.liveModelReviewed,false);
  const r22ProducerSha="e82a7ac04f3758d0e3e21ea3d05265dbc2822132";
  for(const [name,pin] of Object.entries(manifest.pins)){
    const actual=execFileSync("git",["rev-parse",r22ProducerSha+":"+pin.path],{
      cwd:repoRoot,
      encoding:"utf8"
    }).trim();
    assert.equal(actual,pin.gitBlobSha,name);
  }
});
