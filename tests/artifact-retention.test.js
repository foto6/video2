import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ArtifactGcExecutor,
  MEDIA_ARTIFACT_RETENTION_VERSION,
  MEDIA_JOB_CONTRACT_VERSION,
  MediaJobProtocolHarness,
  MediaJobProtocolV1,
  PersistentArtifactRetentionStore,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  artifactManifestDigest,
  buildArtifactManifest,
  buildArtifactRetentionMetadata,
  buildRetentionStressCorpus,
  evidenceDigest,
  makeInternalRetentionRecord,
  makeInternalRetentionRecordFromJob,
  planArtifactGc,
  runRetentionPlannerStress,
  validateArtifactRetentionMetadata
} from "../src/index.js";

const corpusUrl = new URL("../conformance/media.artifact_retention.v1/", import.meta.url);
const reportUrl = new URL("../reports/WAVE8_GC_DRY_RUN.json", import.meta.url);

function tmp(prefix="media-wave8-") {
  return mkdtempSync(path.join(os.tmpdir(),prefix));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function probe() {
  return {
    hasVideo:true,hasAudio:false,width:64,height:64,fps:10,durationMs:300,
    videoCodec:"h264",audioCodec:null,blackFrameRatio:0.01
  };
}

function request(jobId,{dryRun=false}={}) {
  return {
    contractVersion:"media.render.v1",
    jobId,
    timeline:{id:jobId,version:1,canvas:{width:64,height:64,fps:10,durationMs:300},tracks:[]},
    exportSpec:{
      videoCodec:"libx264",audioCodec:"aac",videoBitrate:"250k",audioBitrate:"64k",
      pixelFormat:"yuv420p",runtimeProfile:"standard"
    },
    outputPath:`outputs/${jobId}.mp4`,
    dryRun
  };
}

function runtimeFor(root) {
  let calls=0;
  const store=new PersistentRenderJobStore({filePath:path.join(root,"jobs.json")});
  const runtime=new RenderRuntimeV2({
    store,
    executor:{
      async run(command){
        calls+=1;
        mkdirSync(path.dirname(command.args.at(-1)),{recursive:true});
        writeFileSync(command.args.at(-1),`wave8:${calls}\n`,"utf8");
        return {
          ok:true,code:0,signal:null,timedOut:false,cancelled:false,
          stdout:"",stderr:"",stdoutTruncated:false,stderrTruncated:false,durationMs:1
        };
      }
    },
    probe:{async inspect(){return probe();}},
    sandboxRoot:root,
    liveExecutionEnabled:true,
    resourceLimits:{cpu:2,gpu:0,render:1,probe:1,qa:1}
  });
  return {runtime,store,calls:()=>calls};
}

async function complete(root,jobId) {
  const env=runtimeFor(root);
  env.runtime.submit(request(jobId),{idempotencyKey:`creator:wave8:${jobId}`});
  const job=await env.runtime.runAcceptedJob(jobId);
  assert.equal(job.status,"succeeded");
  return {...env,job};
}

function orphanManifest(jobId,bytes,at=1000) {
  const digest=sha256(bytes);
  const p={fixture:"probe",jobId};
  const q={fixture:"qa",jobId,passed:true};
  const job={
    id:jobId,
    idempotencyKey:`orphan:${jobId}`,
    renderFingerprint:sha256(`render:${jobId}`),
    dryRun:false,
    timeline:{id:jobId,version:1,canvas:{width:64,height:64,fps:10,durationMs:300},tracks:[]},
    exportSpec:{runtimeProfile:"standard"},
    outputPath:`gc/${jobId}.bin`,
    createdAtMs:at,
    scheduling:{
      profile:"standard",priorityClass:"normal",
      requirements:{
        render:{cpu:1,gpu:0,render:1,probe:0,qa:0},
        probe:{cpu:1,gpu:0,render:0,probe:1,qa:0},
        qa:{cpu:1,gpu:0,render:0,probe:0,qa:1}
      }
    },
    currentAttempt:{token:`${jobId}:render:1`},
    probe:p,
    qa:q
  };
  return buildArtifactManifest(job,{
    finalDigest:{sha256:digest,size:Buffer.byteLength(bytes)},
    preparedDigest:{sha256:digest,size:Buffer.byteLength(bytes)},
    preparedAtMs:at+10,
    finalizedAtMs:at+20,
    manifestCommittedAtMs:at+30
  });
}

function orphanRecord(storageKey,jobId,bytes,{retentionClass="cacheable",pinReasons=[],references=[]}={}) {
  const manifest=orphanManifest(jobId,bytes);
  const metadata=buildArtifactRetentionMetadata({
    artifactDigest:manifest.content.sha256,
    logicalJobId:jobId,
    manifestDigest:artifactManifestDigest(manifest),
    createdAtMs:manifest.timestamps.jobCreatedAtMs,
    finalizedAtMs:manifest.finalization.finalizedAtMs,
    retentionClass,
    pinReasons,
    references,
    lastVerifiedIntegrity:{
      verifiedAtMs:manifest.timestamps.manifestCommittedAtMs,
      ok:true,sha256:manifest.content.sha256,size:manifest.content.size
    }
  });
  return makeInternalRetentionRecord({storageKey,metadata,manifest});
}

function putFile(root,storageKey,bytes) {
  const target=path.join(root,storageKey);
  mkdirSync(path.dirname(target),{recursive:true});
  writeFileSync(target,bytes,"utf8");
  return target;
}

test("canonical retention and Creator pin fixtures are strict, hashed and path-free",()=>{
  const fixtureManifest=JSON.parse(readFileSync(new URL("manifest.json",corpusUrl),"utf8"));
  for(const entry of fixtureManifest.files){
    const raw=readFileSync(new URL(entry.path,corpusUrl));
    assert.equal(sha256(raw),entry.sha256,entry.path);
  }
  const metadata=JSON.parse(readFileSync(new URL("fixtures/canonical.json",corpusUrl),"utf8"));
  const pins=JSON.parse(readFileSync(new URL("fixtures/creator-pins.json",corpusUrl),"utf8"));
  const value=validateArtifactRetentionMetadata(metadata);
  assert.equal(value.contractVersion,MEDIA_ARTIFACT_RETENTION_VERSION);
  assert.equal(value.retentionClass,"checkpoint_pinned");
  assert.equal(pins.checkpointPins.length,2);
  assert.equal(pins.releasePins.length,1);
  assert.equal(fixtureManifest.publicPathPolicy.storageKeysExposed,false);
  assert.doesNotMatch(JSON.stringify({value,pins,fixtureManifest}),/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i);
});

test("succeeded live job persists path-free retention metadata and restart preserves its pin",async()=>{
  const root=tmp("media-wave8-runtime-");
  try {
    const first=await complete(root,"retention-live");
    const meta=first.runtime.exportArtifactRetentionMetadata(first.job.id);
    assert.equal(meta.artifactDigest,first.job.artifactManifest.content.sha256);
    assert.equal(meta.manifestDigest,first.job.artifactManifestSha256);
    assert.equal(meta.pinReasons.includes("succeeded_job_manifest"),true);
    assert.equal(meta.deletionEligibility.eligible,false);
    assert.doesNotMatch(JSON.stringify(meta),/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i);

    const persisted=first.store.get(first.job.id);
    assert.equal(persisted.artifactRetention.contractVersion,MEDIA_ARTIFACT_RETENTION_VERSION);
    const record=makeInternalRetentionRecordFromJob(persisted);
    const plan=planArtifactGc({records:[record],jobs:[persisted],nowMs:5000});
    assert.equal(plan.summary.eligible,0);
    assert.equal(plan.entries[0].reasons.includes("succeeded_job_manifest"),true);

    const restarted=runtimeFor(root);
    restarted.runtime.recoverInterruptedJobs();
    assert.equal(restarted.calls(),0);
    const after=restarted.runtime.exportArtifactRetentionMetadata(first.job.id);
    assert.equal(after.artifactDigest,meta.artifactDigest);
    assert.equal(after.manifestDigest,meta.manifestDigest);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("planner deduplicates references and blocks job, checkpoint, release and reconciliation reachability",()=>{
  const a=orphanRecord("gc/a.bin","a","planner-a\n");
  const b=orphanRecord("gc/b.bin","b","planner-b\n");
  const c=orphanRecord("gc/c.bin","c","planner-c\n");
  const d=orphanRecord("gc/d.bin","d","planner-d\n");
  const e=orphanRecord("gc/e.bin","e","planner-e\n");
  const pins=JSON.parse(readFileSync(new URL("fixtures/creator-pins.json",corpusUrl),"utf8"));

  const checkpointPins=[
    ...pins.checkpointPins.map((pin)=>({
      ...pin,
      artifactDigest:b.metadata.artifactDigest,
      logicalJobId:b.metadata.logicalJobId,
      manifestDigest:b.metadata.manifestDigest
    }))
  ];
  const releasePins=[
    ...pins.releasePins.map((pin)=>({
      ...pin,
      artifactDigest:c.metadata.artifactDigest,
      logicalJobId:c.metadata.logicalJobId,
      manifestDigest:c.metadata.manifestDigest
    }))
  ];
  const jobs=[
    {
      id:a.metadata.logicalJobId,status:"succeeded",dryRun:false,
      artifactManifest:a.manifest,artifactManifestSha256:a.metadata.manifestDigest,
      reconciliation:{required:false}
    },
    {
      id:d.metadata.logicalJobId,status:"retry_wait",dryRun:false,
      reconciliation:{required:true,reason:"uncertain_render_attempt"}
    }
  ];
  const plan=planArtifactGc({
    records:[a,b,c,d,e],jobs,checkpointPins,releasePins,nowMs:6000
  });
  const byJob=new Map(plan.entries.map((entry)=>[entry.logicalJobId,entry]));
  assert.equal(byJob.get("a").eligible,false);
  assert.equal(byJob.get("b").eligible,false);
  assert.equal(byJob.get("c").eligible,false);
  assert.equal(byJob.get("d").eligible,false);
  assert.equal(byJob.get("e").eligible,true);
  assert.equal(byJob.get("b").references.filter((ref)=>ref.kind==="creator_checkpoint").length,1);
});

test("GC executor defaults to dry-run and a pin added after plan blocks explicit deletion",()=>{
  const root=tmp("media-wave8-pin-race-");
  try {
    const bytes="pin-race\n";
    const record=orphanRecord("gc/pin-race.bin","pin-race",bytes);
    const target=putFile(root,record.storageKey,bytes);
    const store=new PersistentArtifactRetentionStore({filePath:path.join(root,"retention.json")});
    store.put(record);
    const plan=planArtifactGc({records:store.list(),nowMs:7000});
    assert.equal(plan.summary.eligible,1);
    assert.equal(JSON.stringify(plan).includes("storageKey"),false);
    assert.doesNotMatch(JSON.stringify(plan),/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i);

    let checkpointPins=[];
    const executor=new ArtifactGcExecutor({
      store,sandboxRoot:root,
      referenceProvider:()=>({jobs:[],checkpointPins,releasePins:[]}),
      clock:()=>7100
    });
    const dry=executor.execute(plan);
    assert.equal(dry.dryRun,true);
    assert.equal(dry.outcomes[0].status,"would_delete");
    assert.equal(existsSync(target),true);

    checkpointPins=[{
      referenceId:"checkpoint-after-plan",
      artifactDigest:record.metadata.artifactDigest,
      logicalJobId:record.metadata.logicalJobId,
      manifestDigest:record.metadata.manifestDigest
    }];
    const live=executor.execute(plan,{dryRun:false});
    assert.equal(live.outcomes[0].status,"stale_plan_rejected");
    assert.match(live.outcomes[0].reason,/creator_checkpoint_pin/);
    assert.equal(existsSync(target),true);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("GC fails closed for manifest tamper, traversal, protected path and symlink escape",async(t)=>{
  await t.test("manifest tamper",()=>{
    const root=tmp("media-wave8-manifest-tamper-");
    try {
      const bytes="tamper\n";
      const record=orphanRecord("gc/tamper.bin","tamper",bytes);
      const target=putFile(root,record.storageKey,bytes);
      const filePath=path.join(root,"retention.json");
      const store=new PersistentArtifactRetentionStore({filePath});
      store.put(record);
      const plan=planArtifactGc({records:store.list(),nowMs:8000});
      const raw=JSON.parse(readFileSync(filePath,"utf8"));
      raw.records[record.recordId].manifest.renderFingerprint="f".repeat(64);
      writeFileSync(filePath,JSON.stringify(raw,null,2)+"\n","utf8");
      const executor=new ArtifactGcExecutor({store,sandboxRoot:root,clock:()=>8100});
      const result=executor.execute(plan,{dryRun:false});
      assert.equal(result.status,"failed_closed");
      assert.equal(result.error.code,"retention_state_corrupt");
      assert.equal(existsSync(target),true);
    } finally { rmSync(root,{recursive:true,force:true}); }
  });

  await t.test("path traversal",()=>{
    const root=tmp("media-wave8-traversal-");
    const outside=path.join(path.dirname(root),`outside-${path.basename(root)}.bin`);
    try {
      writeFileSync(outside,"outside\n","utf8");
      const record=orphanRecord("../"+path.basename(outside),"traversal","outside\n");
      const store=new PersistentArtifactRetentionStore({filePath:path.join(root,"retention.json")});
      store.put(record);
      const plan=planArtifactGc({records:store.list(),nowMs:8200});
      const executor=new ArtifactGcExecutor({store,sandboxRoot:root,clock:()=>8300});
      const result=executor.execute(plan,{dryRun:false});
      assert.equal(result.outcomes[0].status,"failed");
      assert.equal(result.outcomes[0].error.code,"path_outside_sandbox");
      assert.equal(existsSync(outside),true);
    } finally {
      rmSync(root,{recursive:true,force:true});
      rmSync(outside,{force:true});
    }
  });

  await t.test("protected path lexical veto",()=>{
    const manifest=orphanManifest("protected","protected\n");
    const metadata=buildArtifactRetentionMetadata({
      artifactDigest:manifest.content.sha256,
      logicalJobId:"protected",
      manifestDigest:artifactManifestDigest(manifest),
      createdAtMs:manifest.timestamps.jobCreatedAtMs,
      finalizedAtMs:manifest.finalization.finalizedAtMs,
      retentionClass:"protected",
      lastVerifiedIntegrity:{
        verifiedAtMs:manifest.timestamps.manifestCommittedAtMs,
        ok:true,sha256:manifest.content.sha256,size:manifest.content.size
      }
    });
    assert.throws(
      ()=>makeInternalRetentionRecord({
        storageKey:"E:\\manhwa\\never-touch.bin",metadata,manifest
      }),
      (error)=>error.code==="path_protected"
    );
  });

  await t.test("symlink/reparse-like target",()=>{
    const root=tmp("media-wave8-symlink-");
    const outsideRoot=tmp("media-wave8-symlink-target-");
    try {
      const outside=path.join(outsideRoot,"target.bin");
      writeFileSync(outside,"symlink-target\n","utf8");
      const record=orphanRecord("gc/link.bin","symlink","symlink-target\n");
      mkdirSync(path.join(root,"gc"),{recursive:true});
      try {
        symlinkSync(outside,path.join(root,record.storageKey));
      } catch {
        t.skip("symlink creation is unavailable on this platform");
        return;
      }
      const store=new PersistentArtifactRetentionStore({filePath:path.join(root,"retention.json")});
      store.put(record);
      const plan=planArtifactGc({records:store.list(),nowMs:8400});
      const executor=new ArtifactGcExecutor({store,sandboxRoot:root,clock:()=>8500});
      const result=executor.execute(plan,{dryRun:false});
      assert.equal(result.outcomes[0].status,"failed");
      assert.equal(result.outcomes[0].error.code,"path_symlink_rejected");
      assert.equal(existsSync(outside),true);
    } finally {
      rmSync(root,{recursive:true,force:true});
      rmSync(outsideRoot,{recursive:true,force:true});
    }
  });
});

test("partial cleanup records per-artifact outcomes and retry never broadens deletion",()=>{
  const root=tmp("media-wave8-partial-");
  try {
    const good=orphanRecord("gc/good.bin","good","good-bytes\n");
    const corrupt=orphanRecord("gc/corrupt.bin","corrupt","expected-bytes\n");
    const missing=orphanRecord("gc/missing.bin","missing","missing-bytes\n");
    const sentinel=path.join(root,"sentinel.bin");
    putFile(root,good.storageKey,"good-bytes\n");
    putFile(root,corrupt.storageKey,"wrong-bytes\n");
    writeFileSync(sentinel,"sentinel\n","utf8");

    const store=new PersistentArtifactRetentionStore({filePath:path.join(root,"retention.json")});
    for(const record of [good,corrupt,missing]) store.put(record);
    const plan=planArtifactGc({records:store.list(),nowMs:9000});
    assert.equal(plan.summary.eligible,3);

    const executor=new ArtifactGcExecutor({store,sandboxRoot:root,clock:()=>9100});
    const first=executor.execute(plan,{dryRun:false});
    assert.equal(first.status,"partial_failure");
    const statuses=new Set(first.outcomes.map((value)=>value.status));
    assert.equal(statuses.has("deleted"),true);
    assert.equal(statuses.has("integrity_failure"),true);
    assert.equal(statuses.has("already_missing"),true);
    assert.equal(existsSync(sentinel),true);

    const retry=executor.execute(plan,{dryRun:false});
    const goodRetry=retry.outcomes.find((value)=>value.recordId===good.recordId);
    assert.equal(goodRetry.status,"already_missing");
    assert.equal(existsSync(sentinel),true);
    assert.equal(store.gcEvents().length>=6,true);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("concurrent status reads and cancel/reconciliation race cannot make reachable artifact collectible",async()=>{
  const root=tmp("media-wave8-concurrent-");
  try {
    const live=await complete(root,"status-live");
    const liveRecord=makeInternalRetentionRecordFromJob(live.store.get(live.job.id));
    const orphan=orphanRecord("gc/unrelated.bin","unrelated","unrelated\n");
    const orphanPath=putFile(root,orphan.storageKey,"unrelated\n");
    const retentionStore=new PersistentArtifactRetentionStore({filePath:path.join(root,"retention.json")});
    retentionStore.put(liveRecord);
    retentionStore.put(orphan);

    let jobs=[live.store.get(live.job.id)];
    const plan=planArtifactGc({records:retentionStore.list(),jobs,nowMs:10000});
    assert.equal(plan.entries.find((e)=>e.logicalJobId===live.job.id).eligible,false);
    assert.equal(plan.entries.find((e)=>e.logicalJobId==="unrelated").eligible,true);

    const harness=new MediaJobProtocolHarness(new MediaJobProtocolV1(live.runtime));
    const reads=Promise.all(Array.from({length:24},()=>harness.exchange({
      contractVersion:MEDIA_JOB_CONTRACT_VERSION,action:"status",jobId:live.job.id
    })));
    const executor=new ArtifactGcExecutor({
      store:retentionStore,sandboxRoot:root,
      referenceProvider:()=>({jobs,checkpointPins:[],releasePins:[]}),
      clock:()=>10100
    });
    const deletion=executor.execute(plan,{dryRun:false});
    const statuses=await reads;
    assert.equal(statuses.every((value)=>value.status==="succeeded"),true);
    assert.equal(existsSync(live.job.resolvedOutputPath),true);
    assert.equal(existsSync(orphanPath),false);
    assert.equal(deletion.outcomes.some((value)=>value.recordId===liveRecord.recordId),false);

    const race=orphanRecord("gc/cancel-race.bin","cancel-race","cancel-race\n");
    const racePath=putFile(root,race.storageKey,"cancel-race\n");
    retentionStore.put(race);
    const racePlan=planArtifactGc({records:[race],nowMs:10200});
    jobs=[...jobs,{
      id:"cancel-race",status:"rendering",dryRun:false,cancellationRequested:true,
      reconciliation:{required:true,reason:"cancel_uncertain_render"}
    }];
    const raced=executor.execute(racePlan,{dryRun:false});
    assert.equal(raced.outcomes[0].status,"stale_plan_rejected");
    assert.match(raced.outcomes[0].reason,/unresolved_reconciliation/);
    assert.equal(existsSync(racePath),true);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("already missing eligible artifact is an idempotent no-op",()=>{
  const root=tmp("media-wave8-missing-");
  try {
    const record=orphanRecord("gc/already-missing.bin","already-missing","missing\n");
    const store=new PersistentArtifactRetentionStore({filePath:path.join(root,"retention.json")});
    store.put(record);
    const plan=planArtifactGc({records:store.list(),nowMs:11000});
    const executor=new ArtifactGcExecutor({store,sandboxRoot:root,clock:()=>11100});
    const result=executor.execute(plan,{dryRun:false});
    assert.equal(result.outcomes[0].status,"already_missing");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("1200-record deterministic stress proves reachable artifacts are never GC candidates with bounded planner work",()=>{
  const fixture=JSON.parse(readFileSync(new URL("fixtures/stress.json",corpusUrl),"utf8"));
  const summary=runRetentionPlannerStress({
    seed:fixture.seed,
    recordCount:fixture.recordCount
  });
  assert.deepEqual(summary.classCounts,fixture.expected.classCounts);
  assert.equal(summary.jobReferences,fixture.expected.jobReferences);
  assert.equal(summary.checkpointPinDeliveries,fixture.expected.checkpointPinDeliveries);
  assert.equal(summary.releasePinDeliveries,fixture.expected.releasePinDeliveries);
  assert.equal(summary.eligible,fixture.expected.eligible);
  assert.equal(summary.blocked,fixture.expected.blocked);
  assert.equal(summary.workUnits,fixture.expected.workUnits);
  assert.equal(summary.recordCount>=1000,true);
  assert.equal(summary.eligible+summary.blocked,summary.recordCount);
  assert.equal(summary.workUnits<=summary.recordCount*2,true);
  assert.equal(summary.reachableRecordCount,fixture.expected.blocked);
  assert.equal(summary.reachableEligibleViolations,0);

  const corpus=buildRetentionStressCorpus({
    seed:fixture.seed,recordCount:fixture.recordCount
  });
  const plan=planArtifactGc({
    records:corpus.records,jobs:corpus.jobs,
    checkpointPins:corpus.checkpointPins,releasePins:corpus.releasePins,
    nowMs:2000000
  });
  const eligibleIds=new Set(plan.entries.filter((entry)=>entry.eligible).map((entry)=>entry.recordId));
  for(const entry of plan.entries.filter((value)=>!value.eligible)){
    assert.equal(eligibleIds.has(entry.recordId),false);
  }
  console.log("WAVE8_GC_DRY_RUN_SUMMARY",JSON.stringify({
    seed:summary.seed,records:summary.recordCount,
    eligible:summary.eligible,blocked:summary.blocked,
    jobReferences:summary.jobReferences,
    checkpointPinDeliveries:summary.checkpointPinDeliveries,
    releasePinDeliveries:summary.releasePinDeliveries,
    workUnits:summary.workUnits,
    reachableRecords:summary.reachableRecordCount,
    reachableEligibilityViolations:summary.reachableEligibleViolations,
    reachableArtifactsDeleted:0,
    planDigest:summary.planDigest
  }));
});

test("machine-readable GC report pins dry-run-only CI and no publishing/account mutation",()=>{
  const report=JSON.parse(readFileSync(reportUrl,"utf8"));
  assert.equal(report.reportVersion,"primary-media.wave8.gc-dry-run.v1");
  assert.equal(report.stress.records,1200);
  assert.equal(report.stress.reachableArtifactsDeleted,0);
  assert.equal(report.liveCleanupInCi,false);
  assert.equal(report.publishing,false);
  assert.equal(report.accountMutation,false);
});
