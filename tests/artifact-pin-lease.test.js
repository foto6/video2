import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ArtifactGcExecutor,
  MEDIA_ARTIFACT_PIN_LEASE_VERSION,
  PersistentArtifactPinLeaseStore,
  PersistentArtifactRetentionStore,
  artifactManifestDigest,
  artifactPinLeaseDigest,
  buildArtifactManifest,
  buildArtifactRetentionMetadata,
  createArtifactPinLease,
  evidenceDigest,
  isArtifactPinLeaseActive,
  makeInternalRetentionRecord,
  planArtifactGc,
  runPinLeaseStress,
  validateArtifactPinLease
} from "../src/index.js";

const corpusUrl = new URL("../conformance/media.artifact_pin_lease.v1/", import.meta.url);
const reportUrl = new URL("../reports/WAVE9_PIN_LEASES.json", import.meta.url);

function tmp(prefix="media-wave9-") {
  return mkdtempSync(path.join(os.tmpdir(),prefix));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function orphanManifest(jobId,bytes,at=1000) {
  const digest=sha256(bytes);
  const probe={fixture:"probe",jobId};
  const qa={fixture:"qa",jobId,passed:true};
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
    probe,qa
  };
  return buildArtifactManifest(job,{
    finalDigest:{sha256:digest,size:Buffer.byteLength(bytes)},
    preparedDigest:{sha256:digest,size:Buffer.byteLength(bytes)},
    preparedAtMs:at+10,finalizedAtMs:at+20,manifestCommittedAtMs:at+30
  });
}

function orphanRecord(storageKey,jobId,bytes,{retentionClass="cacheable"}={}) {
  const manifest=orphanManifest(jobId,bytes);
  const metadata=buildArtifactRetentionMetadata({
    artifactDigest:manifest.content.sha256,
    logicalJobId:jobId,
    manifestDigest:artifactManifestDigest(manifest),
    createdAtMs:manifest.timestamps.jobCreatedAtMs,
    finalizedAtMs:manifest.finalization.finalizedAtMs,
    retentionClass,
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

test("canonical lease fixture and manifest hashes are exact and path-free",()=>{
  const manifest=JSON.parse(readFileSync(new URL("manifest.json",corpusUrl),"utf8"));
  for(const entry of manifest.files){
    const raw=readFileSync(new URL(entry.path,corpusUrl));
    assert.equal(sha256(raw),entry.sha256,entry.path);
  }
  const lease=validateArtifactPinLease(JSON.parse(
    readFileSync(new URL("fixtures/canonical.json",corpusUrl),"utf8")
  ));
  assert.equal(lease.contractVersion,MEDIA_ARTIFACT_PIN_LEASE_VERSION);
  assert.equal(lease.canonicalDigest,artifactPinLeaseDigest(lease));
  assert.equal(manifest.consumerRules.siblingImportRequired,false);
  assert.equal(manifest.consumerRules.filesystemPathFieldsPresent,false);
  assert.doesNotMatch(JSON.stringify({manifest,lease}),/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i);
});

test("concurrent duplicate acquire converges and stale release generation fails closed",async()=>{
  const root=tmp("media-wave9-cas-");
  let now=1000;
  try {
    const filePath=path.join(root,"leases.json");
    const a=new PersistentArtifactPinLeaseStore({filePath,clock:()=>now});
    const b=new PersistentArtifactPinLeaseStore({filePath,clock:()=>now});
    const input={
      artifactDigest:"a".repeat(64),
      manifestDigest:"b".repeat(64),
      ownerKind:"creator_checkpoint",
      ownerId:"checkpoint-concurrent",
      pinReason:"checkpoint_active",
      expiresAtMs:5000
    };
    const [first,second]=await Promise.all([
      Promise.resolve().then(()=>a.acquire(input)),
      Promise.resolve().then(()=>b.acquire(input))
    ]);
    assert.deepEqual([first.duplicate,second.duplicate].sort(),[false,true]);
    assert.equal(first.lease.canonicalDigest,second.lease.canonicalDigest);

    now=1100;
    const renewed=a.renew({
      ownerKind:input.ownerKind,ownerId:input.ownerId,
      expectedGeneration:1,expiresAtMs:6000
    });
    assert.equal(renewed.generation,2);
    assert.throws(
      ()=>b.release({
        ownerKind:input.ownerKind,ownerId:input.ownerId,expectedGeneration:1
      }),
      (error)=>error.code==="pin_lease_generation_conflict"
    );
    const released=b.release({
      ownerKind:input.ownerKind,ownerId:input.ownerId,expectedGeneration:2
    });
    assert.equal(released.released,true);
    assert.equal(a.inspect({ownerKind:input.ownerKind,ownerId:input.ownerId}).lease,null);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("duplicate owner IDs are isolated by owner kind and active identity conflicts fail",()=>{
  const root=tmp("media-wave9-owner-");
  let now=2000;
  try {
    const store=new PersistentArtifactPinLeaseStore({
      filePath:path.join(root,"leases.json"),clock:()=>now
    });
    const common={
      artifactDigest:"c".repeat(64),
      manifestDigest:"d".repeat(64),
      ownerId:"same-id",
      pinReason:"active",
      expiresAtMs:null
    };
    const checkpoint=store.acquire({...common,ownerKind:"creator_checkpoint"});
    const release=store.acquire({...common,ownerKind:"release_candidate"});
    assert.equal(checkpoint.duplicate,false);
    assert.equal(release.duplicate,false);
    assert.equal(store.listActive().length,2);

    assert.throws(
      ()=>store.acquire({
        ...common,
        ownerKind:"creator_checkpoint",
        manifestDigest:"e".repeat(64)
      }),
      (error)=>error.code==="pin_lease_conflict"
    );
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("expiry boundary is deterministic and expired lease stops pinning exactly at expiry",()=>{
  const record=orphanRecord("gc/expiry.bin","expiry","expiry-bytes\n");
  const lease=createArtifactPinLease({
    artifactDigest:record.metadata.artifactDigest,
    manifestDigest:record.metadata.manifestDigest,
    ownerKind:"creator_checkpoint",
    ownerId:"expiry-boundary",
    pinReason:"checkpoint_active",
    createdAtMs:100,renewedAtMs:100,expiresAtMs:200,generation:1
  });
  assert.equal(isArtifactPinLeaseActive(lease,{nowMs:199}),true);
  assert.equal(isArtifactPinLeaseActive(lease,{nowMs:200}),false);
  assert.equal(planArtifactGc({records:[record],pinLeases:[lease],nowMs:199}).summary.eligible,0);
  assert.equal(planArtifactGc({records:[record],pinLeases:[lease],nowMs:200}).summary.eligible,1);
});

test("restart preserves active lease and generation watermark",()=>{
  const root=tmp("media-wave9-restart-");
  let now=3000;
  try {
    const filePath=path.join(root,"leases.json");
    const first=new PersistentArtifactPinLeaseStore({filePath,clock:()=>now});
    const acquired=first.acquire({
      artifactDigest:"1".repeat(64),manifestDigest:"2".repeat(64),
      ownerKind:"creator_checkpoint",ownerId:"restart",
      pinReason:"checkpoint_active",expiresAtMs:9000
    });
    assert.equal(acquired.lease.generation,1);

    const restarted=new PersistentArtifactPinLeaseStore({filePath,clock:()=>now});
    const inspection=restarted.inspect({ownerKind:"creator_checkpoint",ownerId:"restart"});
    assert.equal(inspection.active,true);
    assert.equal(inspection.lease.canonicalDigest,acquired.lease.canonicalDigest);

    restarted.release({ownerKind:"creator_checkpoint",ownerId:"restart",expectedGeneration:1});
    now=3100;
    const reacquired=first.acquire({
      artifactDigest:"1".repeat(64),manifestDigest:"2".repeat(64),
      ownerKind:"creator_checkpoint",ownerId:"restart",
      pinReason:"checkpoint_active",expiresAtMs:9000
    });
    assert.equal(reacquired.lease.generation,2);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("artifact plus manifest binding is exact for GC reachability",()=>{
  const record=orphanRecord("gc/binding.bin","binding","binding-bytes\n");
  const wrong=createArtifactPinLease({
    artifactDigest:record.metadata.artifactDigest,
    manifestDigest:"f".repeat(64),
    ownerKind:"creator_checkpoint",ownerId:"wrong-manifest",
    pinReason:"checkpoint_active",
    createdAtMs:100,renewedAtMs:100,expiresAtMs:null,generation:1
  });
  const exact=createArtifactPinLease({
    artifactDigest:record.metadata.artifactDigest,
    manifestDigest:record.metadata.manifestDigest,
    ownerKind:"creator_checkpoint",ownerId:"exact-manifest",
    pinReason:"checkpoint_active",
    createdAtMs:100,renewedAtMs:100,expiresAtMs:null,generation:1
  });
  const wrongPlan=planArtifactGc({records:[record],pinLeases:[wrong],nowMs:500});
  assert.equal(wrongPlan.summary.eligible,1);
  const exactPlan=planArtifactGc({records:[record],pinLeases:[exact],nowMs:500});
  assert.equal(exactPlan.summary.eligible,0);
  assert.equal(exactPlan.entries[0].reasons.includes("external_pin_lease"),true);
});

test("pin acquired after GC plan blocks delete through lease-store TOCTOU re-read",()=>{
  const root=tmp("media-wave9-toctou-");
  let now=4000;
  try {
    const bytes="toctou-bytes\n";
    const record=orphanRecord("gc/toctou.bin","toctou",bytes);
    const target=putFile(root,record.storageKey,bytes);
    const retentionStore=new PersistentArtifactRetentionStore({
      filePath:path.join(root,"retention.json")
    });
    retentionStore.put(record);
    const leaseStore=new PersistentArtifactPinLeaseStore({
      filePath:path.join(root,"leases.json"),clock:()=>now
    });

    const plan=planArtifactGc({records:retentionStore.list(),nowMs:now});
    assert.equal(plan.summary.eligible,1);

    leaseStore.acquire({
      artifactDigest:record.metadata.artifactDigest,
      manifestDigest:record.metadata.manifestDigest,
      ownerKind:"release_candidate",ownerId:"release-after-plan",
      pinReason:"release_candidate_active",expiresAtMs:null
    });

    now=4100;
    const executor=new ArtifactGcExecutor({
      store:retentionStore,sandboxRoot:root,pinLeaseStore:leaseStore,clock:()=>now
    });
    const result=executor.execute(plan,{dryRun:false});
    assert.equal(result.outcomes[0].status,"stale_plan_rejected");
    assert.match(result.outcomes[0].reason,/external_pin_lease/);
    assert.equal(existsSync(target),true);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("protected/path-like lease fields fail closed and protected retention remains unreachable",()=>{
  assert.throws(
    ()=>createArtifactPinLease({
      artifactDigest:"3".repeat(64),manifestDigest:"4".repeat(64),
      ownerKind:"creator_checkpoint",ownerId:"E:\\manhwa\\checkpoint",
      pinReason:"checkpoint_active",
      createdAtMs:1,renewedAtMs:1,expiresAtMs:null,generation:1
    }),
    (error)=>error.code==="pin_lease_invalid"
  );
  const protectedRecord=orphanRecord("gc/protected.bin","protected-artifact","protected\n",{
    retentionClass:"protected"
  });
  const plan=planArtifactGc({records:[protectedRecord],pinLeases:[],nowMs:100});
  assert.equal(plan.summary.eligible,0);
  assert.equal(plan.entries[0].reasons.includes("retention_class:protected"),true);
});

test("10k lease stress blocks every matched record with bounded indexed planner work",()=>{
  const fixture=JSON.parse(readFileSync(new URL("fixtures/stress.json",corpusUrl),"utf8"));
  const summary=runPinLeaseStress({
    seed:fixture.seed,
    leaseCount:fixture.leaseCount,
    retentionRecordCount:fixture.retentionRecordCount,
    nowMs:2000000
  });
  assert.equal(summary.leaseCount,fixture.leaseCount);
  assert.equal(summary.activeLeases,fixture.expected.activeLeases);
  assert.equal(summary.expiredLeases,fixture.expected.expiredLeases);
  assert.equal(summary.recordsPinnedByActiveLease,fixture.expected.recordsPinnedByActiveLease);
  assert.equal(summary.eligibleAfterLeases,fixture.expected.eligibleAfterLeases);
  assert.equal(summary.blockedAfterLeases,fixture.expected.blockedAfterLeases);
  assert.equal(summary.reachableEligibilityViolations,0);
  assert.equal(summary.plannerWorkUnits,fixture.expected.plannerWorkUnits);
  assert.equal(summary.plannerWorkUnits<summary.leaseCount*2,true);

  console.log("WAVE9_PIN_LEASE_SUMMARY",JSON.stringify(summary));
});

test("Wave 9 report pins fixture manifest hash, dry-run policy and no publishing",()=>{
  const report=JSON.parse(readFileSync(reportUrl,"utf8"));
  const manifestBytes=readFileSync(new URL("manifest.json",corpusUrl));
  assert.equal(sha256(manifestBytes),report.fixtureManifestSha256);
  assert.equal(report.stress.leases,10000);
  assert.equal(report.stress.reachableEligibilityViolations,0);
  assert.equal(report.stress.liveCleanupInCi,false);
  assert.equal(report.publishing,false);
  assert.equal(report.accountMutation,false);
});
