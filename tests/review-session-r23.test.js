import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MEDIA_REVIEW_SESSION_PACKAGE_VERSION,
  MEDIA_REVIEW_SESSION_REQUEST_VERSION,
  REVIEW_SESSION_PACKAGE_READY,
  R23_R21_AUTHORITY,
  R23_R22_AUTHORITY,
  reviewSessionIdentity,
  reviewSessionToR21Request,
  validateReviewSessionPackage,
  validateReviewSessionRequest
} from "../src/index.js";

const H=(c)=>c.repeat(64);
const G=(c)=>c.repeat(40);

function candidate({
  id="c0",
  round=0,
  renderSha=H("a"),
  renderSize=100,
  sourceSha=H("b"),
  sourceSize=200,
  producer=G("c"),
  app=true
}={}){
  return {
    candidateId:id,
    roundNumber:round,
    source:{sourceId:"source-1",sha256:sourceSha,size:sourceSize,path:"media/source.mp4"},
    render:{path:`renders/${id}.mp4`,sha256:renderSha,size:renderSize},
    renderExport:{path:`renders/${id}.render.json`,fileSha256:H("d"),digest:H("e")},
    renderProducerSha:producer,
    editorialApplication:round===0||!app?null:{
      path:`renders/${id}.r19.json`,
      fileSha256:H("f"),
      digest:H("1")
    },
    reviewDerivative:null
  };
}
function initialRequest(){
  return {
    contractVersion:MEDIA_REVIEW_SESSION_REQUEST_VERSION,
    sessionId:"session-0",
    mode:"initial",
    reviewRound:0,
    source:{sourceId:"source-1",sha256:H("b"),size:200},
    briefLineageDigest:H("2"),
    growthSelectedEnvelopeDigest:null,
    growthHandoffDigest:null,
    initial:{
      left:candidate({id:"left",renderSha:H("3")}),
      right:candidate({id:"right",renderSha:H("4")})
    }
  };
}
function targetedRequest(round=1){
  return {
    contractVersion:MEDIA_REVIEW_SESSION_REQUEST_VERSION,
    sessionId:`session-${round}`,
    mode:"targeted_reedit",
    reviewRound:round,
    source:{sourceId:"source-1",sha256:H("b"),size:200},
    briefLineageDigest:H("2"),
    growthSelectedEnvelopeDigest:H("5"),
    growthHandoffDigest:H("6"),
    baseline:{
      candidate:candidate({id:`base-${round-1}`,round:round-1,renderSha:H("7"),app:round-1>0}),
      priorReviewPackageDigest:H("8"),
      priorSealedMappingDigest:H("9")
    },
    challenger:candidate({id:`child-${round}`,round,renderSha:H("a")})
  };
}

test("R23 pins exact green R21 and R22 authorities",()=>{
  assert.equal(R23_R21_AUTHORITY.producerSha,"d753e9e4c1f4448386608a1425232dbc1dba87ea");
  assert.equal(R23_R21_AUTHORITY.ciRunId,36994000619);
  assert.equal(R23_R22_AUTHORITY.producerSha,"e82a7ac04f3758d0e3e21ea3d05265dbc2822132");
  assert.equal(R23_R22_AUTHORITY.ciRunId,37001071721);
  assert.equal(R23_R22_AUTHORITY.artifactId,11224061610);
});

test("R23 accepts initial round and emits exact R21 initial request",()=>{
  const request=validateReviewSessionRequest(initialRequest());
  const r21=reviewSessionToR21Request(request);
  assert.equal(r21.mode,"initial");
  assert.equal(r21.left.candidate.candidateId,"left");
  assert.equal(r21.right.candidate.candidateId,"right");
  assert.match(reviewSessionIdentity(request),/^[a-f0-9]{64}$/);
});

test("R23 accepts targeted round 1 and round 2 with exact prior selection binding",()=>{
  for(const round of [1,2]){
    const request=validateReviewSessionRequest(targetedRequest(round));
    const r21=reviewSessionToR21Request(request);
    assert.equal(r21.mode,"targeted_reedit");
    assert.equal(r21.baseline.candidate.roundNumber,round-1);
    assert.equal(r21.challenger.candidate.roundNumber,round);
    assert.equal(r21.priorReview.decisionEvidenceDigest,request.growthHandoffDigest);
    assert.equal(r21.priorReview.reviewPackageDigest,request.baseline.priorReviewPackageDigest);
    assert.equal(r21.priorReview.sealedMappingDigest,request.baseline.priorSealedMappingDigest);
  }
});

test("R23 rejects round skips and missing R19 application evidence",()=>{
  const skipped=targetedRequest(2);
  skipped.baseline.candidate.roundNumber=0;
  skipped.baseline.candidate.editorialApplication=null;
  assert.throws(()=>validateReviewSessionRequest(skipped),/N -> N\+1/);

  const missing=targetedRequest(1);
  missing.challenger.editorialApplication=null;
  assert.throws(()=>validateReviewSessionRequest(missing),/(requires R19 application|requires R19 editorial application)/);
});

test("R23 rejects identical bytes, unrelated source and path traversal",()=>{
  const identical=targetedRequest(1);
  identical.challenger.render.sha256=identical.baseline.candidate.render.sha256;
  assert.throws(()=>validateReviewSessionRequest(identical),/bytes are identical/);

  const wrong=targetedRequest(1);
  wrong.challenger.source.sha256=H("0");
  assert.throws(()=>validateReviewSessionRequest(wrong),/do not bind request source/);

  const traversal=targetedRequest(1);
  traversal.challenger.render.path="../escape.mp4";
  assert.throws(()=>validateReviewSessionRequest(traversal),/path|traversal/i);
});

test("R23 session identity changes on selected envelope, handoff or candidate evidence drift",()=>{
  const base=targetedRequest(1);
  const id=reviewSessionIdentity(base);
  for(const mutate of [
    (x)=>x.growthSelectedEnvelopeDigest=H("a"),
    (x)=>x.growthHandoffDigest=H("b"),
    (x)=>x.challenger.render.sha256=H("c"),
    (x)=>x.challenger.editorialApplication.digest=H("d")
  ]){
    const copy=structuredClone(base);
    mutate(copy);
    assert.notEqual(reviewSessionIdentity(copy),id);
  }
});

test("R23 package validator preserves exact producer CI and no-live/human boundary",()=>{
  const pkg={
    contractVersion:MEDIA_REVIEW_SESSION_PACKAGE_VERSION,
    state:REVIEW_SESSION_PACKAGE_READY,
    producer:{repository:"foto6/video2",sha:G("a"),ciRunId:123},
    sessionId:"s",
    mode:"targeted_reedit",
    reviewRound:1,
    source:{sourceId:"source-1",sha256:H("b"),size:200},
    briefLineageDigest:H("c"),
    growthSelectedEnvelopeDigest:H("d"),
    growthHandoffDigest:H("e"),
    baseline:{candidateId:"base",roundNumber:0,render:{sha256:H("1"),size:10},renderExport:{digest:H("2"),fileSha256:H("3")},renderProducerSha:G("b"),editorialApplication:null},
    challenger:{candidateId:"child",roundNumber:1,render:{sha256:H("4"),size:11},renderExport:{digest:H("5"),fileSha256:H("6")},renderProducerSha:G("b"),editorialApplication:{digest:H("7"),fileSha256:H("8")}},
    r21:{packageDigest:H("9")},
    r22:{directoryDigest:H("a"),archiveSha256:H("b")},
    attachments:[
      {blindLabel:"A",name:"review-A.mp4",sha256:H("1"),size:10,mime:"video/mp4"},
      {blindLabel:"B",name:"review-B.mp4",sha256:H("4"),size:11,mime:"video/mp4"}
    ],
    promptDigest:H("c"),
    sealedMappingDigest:H("d"),
    sessionIdentity:H("e"),
    modelReviewPerformed:false,
    liveModelReviewed:false,
    providerPublish:false,
    humanQuality:false
  };
  const parsed=validateReviewSessionPackage(pkg);
  assert.equal(parsed.producer.ciRunId,123);
  const bad=structuredClone(pkg);
  bad.humanQuality=true;
  assert.throws(()=>validateReviewSessionPackage(bad),/evidence boundary/);
});


test("R23 conformance manifest pins exact implementation and frozen R21/R22 authorities",()=>{
  const repoRoot=path.resolve(new URL("..",import.meta.url).pathname);
  const manifest=JSON.parse(readFileSync(
    new URL("../conformance/media.review_session_package.r23.v1/manifest.json",import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion,MEDIA_REVIEW_SESSION_PACKAGE_VERSION);
  assert.equal(manifest.r21Authority.producerSha,R23_R21_AUTHORITY.producerSha);
  assert.equal(manifest.r22Authority.producerSha,R23_R22_AUTHORITY.producerSha);
  assert.equal(manifest.r22Authority.ciRunId,R23_R22_AUTHORITY.ciRunId);
  assert.deepEqual(manifest.realRehearsalRounds,[0,1,2]);
  assert.equal(manifest.humanQuality,false);
  for(const [name,pin] of Object.entries(manifest.pins)){
    if(name==="tests")continue;
    const actual=execFileSync("git",["hash-object",pin.path],{cwd:repoRoot,encoding:"utf8"}).trim();
    assert.equal(actual,pin.gitBlobSha,name);
  }
  assert.match(manifest.pins.tests.gitBlobSha,/^[a-f0-9]{40}$/);
});
