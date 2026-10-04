import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CANONICAL_LIVE_REVIEW_ARTIFACT_READY,
  MEDIA_CANONICAL_LIVE_REVIEW_EXPORT_VERSION,
  R24_R23_AUTHORITY,
  materializeCanonicalLiveReviewExport,
  verifyCanonicalLiveReviewExport
} from "../src/index.js";

const repoRoot=path.resolve(new URL("..",import.meta.url).pathname);
const acceptedRoot=path.resolve(process.env.R24_UPSTREAM_ROOT??path.join(repoRoot,".artifacts","r23-accepted"));

test("R24 pins exact green R23 authority",()=>{
  assert.equal(R24_R23_AUTHORITY.producerSha,"78c6982a91d7e3e8c037cd9ce740ee077babdccc");
  assert.equal(R24_R23_AUTHORITY.ciRunId,37007419237);
  assert.equal(R24_R23_AUTHORITY.artifactId,11226183002);
  assert.equal(R24_R23_AUTHORITY.artifactDigest,"sha256:5170ada97f8c86421f4bee34c97fbfa5701bef74ef406f18889a1a790ae3ac66");
});

test("R24 missing export fails independent verification",()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),"media-r24-missing-"));
  const result=verifyCanonicalLiveReviewExport(root);
  assert.equal(result.ok,false);
  assert.deepEqual(result.errors,["export_index_missing"]);
});

test("R24 exact accepted round-0 materializes deterministically and tamper fails closed",{
  skip:!existsSync(path.join(acceptedRoot,"round-0","media.review_session_package.r23.v1.json"))
},()=>{
  const out=mkdtempSync(path.join(os.tmpdir(),"media-r24-export-"));
  const args={
    r23SessionDir:path.join(acceptedRoot,"round-0"),
    outputDir:path.join(out,"round-0"),
    producerSha:"1".repeat(40),
    producerCiRunId:123,
    producerBlobs:{
      implementation:"2".repeat(40),exporter:"3".repeat(40),verifier:"4".repeat(40),
      contract:"5".repeat(40),schema:"6".repeat(40)
    }
  };
  const first=materializeCanonicalLiveReviewExport(args);
  const archiveBefore=readFileSync(first.archivePath);
  const indexBefore=readFileSync(path.join(first.exportDir,"media.canonical_live_review_export.r24.v1.json"));
  const second=materializeCanonicalLiveReviewExport(args);
  assert.equal(second.verification.ok,true);
  assert.ok(archiveBefore.equals(readFileSync(second.archivePath)));
  assert.ok(indexBefore.equals(readFileSync(path.join(second.exportDir,"media.canonical_live_review_export.r24.v1.json"))));
  assert.equal(first.exportIndex.state,CANONICAL_LIVE_REVIEW_ARTIFACT_READY);
  assert.equal(first.exportIndex.contractVersion,MEDIA_CANONICAL_LIVE_REVIEW_EXPORT_VERSION);
  assert.equal(first.exportIndex.modelReviewPerformed,false);
  assert.equal(first.exportIndex.humanQuality,false);
  assert.notEqual(first.attachments[0].sha256,first.attachments[1].sha256);

  const promptPath=path.join(first.payloadRoot,"model-facing-prompt.txt");
  writeFileSync(promptPath,Buffer.concat([readFileSync(promptPath),Buffer.from("\ntamper")]));
  const tampered=verifyCanonicalLiveReviewExport(first.exportDir);
  assert.equal(tampered.ok,false);
  assert.ok(tampered.errors.some((x)=>/payload|prompt|archive/i.test(x)));
});

test("R24 conformance manifest pins exact current implementation and frozen R23 authority",()=>{
  const manifest=JSON.parse(readFileSync(
    new URL("../conformance/media.canonical_live_review_export.r24.v1/manifest.json",import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion,MEDIA_CANONICAL_LIVE_REVIEW_EXPORT_VERSION);
  assert.equal(manifest.acceptedR23Authority.producerSha,R24_R23_AUTHORITY.producerSha);
  assert.equal(manifest.acceptedR23Authority.ciRunId,R24_R23_AUTHORITY.ciRunId);
  assert.equal(manifest.humanQuality,false);
  for(const [name,pin] of Object.entries(manifest.pins)){
    if(name==="tests")continue;
    const actual=execFileSync("git",["hash-object",pin.path],{cwd:repoRoot,encoding:"utf8"}).trim();
    assert.equal(actual,pin.gitBlobSha,name);
  }
  assert.match(manifest.pins.tests.gitBlobSha,/^[a-f0-9]{40}$/);
});
