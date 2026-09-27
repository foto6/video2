import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_ARTIFACT_MANIFEST_VERSION,
  MEDIA_JOB_CONTRACT_VERSION,
  MediaJobProtocolHarness,
  MediaJobProtocolV1,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  artifactManifestDigest,
  buildArtifactManifest,
  evaluateRenderQa,
  evidenceDigest,
  outputDigestSync,
  tempOutputPath,
  validateArtifactManifest,
  validatedProfileDigest,
  validatedRequestDigest
} from "../src/index.js";

const corpusUrl = new URL("../conformance/media.artifact_manifest.v1/", import.meta.url);
const reportUrl = new URL("../reports/WAVE7_ARTIFACT_INTEGRITY.json", import.meta.url);

function tempRoot(prefix = "media-wave7-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function request(jobId, { profile = "standard", dryRun = false } = {}) {
  return {
    contractVersion:"media.render.v1",
    jobId,
    timeline:{
      id:jobId,
      version:1,
      canvas:{width:64,height:64,fps:10,durationMs:300},
      tracks:[]
    },
    exportSpec:{
      videoCodec:"libx264",
      audioCodec:"aac",
      videoBitrate:"250k",
      audioBitrate:"64k",
      pixelFormat:"yuv420p",
      runtimeProfile:profile
    },
    outputPath:`outputs/${jobId}.mp4`,
    dryRun
  };
}

function probe() {
  return {
    hasVideo:true,
    hasAudio:false,
    width:64,
    height:64,
    fps:10,
    durationMs:300,
    videoCodec:"h264",
    audioCodec:null,
    blackFrameRatio:0.01
  };
}

function processResult() {
  return {
    ok:true,
    code:0,
    signal:null,
    timedOut:false,
    cancelled:false,
    stdout:"",
    stderr:"",
    stdoutTruncated:false,
    stderrTruncated:false,
    durationMs:1
  };
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeFor(root, { bytes = "wave7-artifact\n", onExecute = null } = {}) {
  let executorCalls = 0;
  const store = new PersistentRenderJobStore({ filePath:path.join(root,"jobs.json") });
  const runtime = new RenderRuntimeV2({
    store,
    executor:{
      async run(command) {
        executorCalls += 1;
        if (onExecute) onExecute(executorCalls);
        mkdirSync(path.dirname(command.args.at(-1)), { recursive:true });
        writeFileSync(command.args.at(-1), bytes, "utf8");
        return processResult();
      }
    },
    probe:{async inspect(){return probe();}},
    sandboxRoot:root,
    liveExecutionEnabled:true,
    maxConcurrency:4,
    resourceLimits:{cpu:4,gpu:1,render:2,probe:2,qa:2}
  });
  return { runtime, store, calls:()=>executorCalls };
}

async function complete(root, jobId, options = {}) {
  const env = runtimeFor(root, options);
  const req = request(jobId, options);
  const idempotencyKey = `creator:wave7:${jobId}`;
  env.runtime.submit(req,{idempotencyKey});
  const job = await env.runtime.runAcceptedJob(jobId);
  assert.equal(job.status,"succeeded");
  return { ...env, request:req, idempotencyKey, job };
}

function seedSuccessBeforeManifest({ root, jobId, cancellationRequested = false }) {
  const env = runtimeFor(root, { onExecute(){ throw new Error("seed executor must not run"); } });
  const req = request(jobId);
  const idempotencyKey = `creator:wave7:${jobId}`;
  env.runtime.submit(req,{idempotencyKey});
  let job = env.store.get(jobId);
  const bytes = `precommitted-${jobId}\n`;
  mkdirSync(path.dirname(job.resolvedOutputPath), { recursive:true });
  writeFileSync(job.resolvedOutputPath, bytes, "utf8");
  const digest = outputDigestSync(job.resolvedOutputPath);
  const qa = evaluateRenderQa(job.timeline, probe());
  const partial = tempOutputPath(job.resolvedOutputPath, job.id);
  const token = `${job.id}:render:1`;
  const telemetry = JSON.parse(JSON.stringify(job.telemetry));
  telemetry.sideEffects.executorInvocations = 1;
  telemetry.sideEffects.probeInvocations = 1;
  telemetry.sideEffects.qaEvaluations = 1;
  telemetry.sideEffects.finalizeInvocations = 1;
  telemetry.sideEffects.successfulFinalizations = 0;
  job = {
    ...job,
    status:"qa",
    attempts:1,
    tempOutputPath:partial,
    probe:probe(),
    qa,
    cancellationRequested,
    currentAttempt:{
      token,
      renderInvocation:1,
      state:"atomic_finalized",
      startedAtMs:100,
      finalizedAtMs:200
    },
    telemetry,
    pendingArtifact:{
      version:"media.artifact_pending.v1",
      attemptToken:token,
      renderFingerprint:job.renderFingerprint,
      validatedRequestDigest:validatedRequestDigest(job),
      profileDigest:validatedProfileDigest(job),
      preparedDigest:digest,
      probeEvidenceDigest:evidenceDigest(probe()),
      qaEvidenceDigest:evidenceDigest(qa),
      preparedAtMs:150,
      finalizedAtMs:200
    }
  };
  env.store.put(job);
  return { ...env, request:req, idempotencyKey, seeded:job, digest };
}

test("canonical artifact manifest fixture corpus is strict, hashed and path-free", () => {
  const index = JSON.parse(readFileSync(new URL("manifest.json", corpusUrl), "utf8"));
  assert.equal(index.fixtureVersion,"media.artifact_manifest.v1.fixture.1");
  assert.equal(index.contractVersion,MEDIA_ARTIFACT_MANIFEST_VERSION);
  assert.equal(index.fixtures.length,3);

  const values = [];
  for (const fixture of index.fixtures) {
    const raw = readFileSync(new URL(fixture.path, corpusUrl));
    assert.equal(sha256Bytes(raw),fixture.sha256);
    const value = validateArtifactManifest(JSON.parse(raw.toString("utf8")));
    assert.equal(artifactManifestDigest(value),fixture.artifactManifestSha256);
    assert.equal(value.content.contentId,fixture.contentId);
    assert.doesNotMatch(JSON.stringify(value),/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i);
    values.push(value);
  }
  assert.equal(values[0].content.contentId,values[1].content.contentId);
  assert.notEqual(values[0].logicalJobId,values[1].logicalJobId);
});

test("successful live render commits content-addressed manifest and releases scheduler resources", async () => {
  const root=tempRoot();
  try {
    const {runtime,job,calls}=await complete(root,"manifest-success");
    assert.equal(calls(),1);
    assert.equal(job.artifactManifest.contractVersion,MEDIA_ARTIFACT_MANIFEST_VERSION);
    assert.equal(job.artifactManifest.content.sha256,job.telemetry.outputSha256);
    assert.equal(job.artifactManifest.content.size,job.telemetry.outputSize);
    assert.equal(job.artifactManifest.content.contentId,`sha256:${job.telemetry.outputSha256}`);
    assert.equal(job.artifactManifest.logicalJobId,job.id);
    assert.equal(job.artifactManifest.attemptToken,job.currentAttempt.token);
    assert.equal(job.artifactManifest.validatedRequestDigest,validatedRequestDigest(job));
    assert.equal(job.artifactManifest.profileDigest,validatedProfileDigest(job));
    assert.equal(job.artifactManifestSha256,artifactManifestDigest(job.artifactManifest));
    assert.equal(job.telemetry.sideEffects.successfulFinalizations,1);
    assert.deepEqual(runtime.getSchedulerDiagnostics().resources.used,{
      cpu:0,gpu:0,render:0,probe:0,qa:0
    });

    const exported=runtime.exportArtifactManifest(job.id);
    assert.deepEqual(exported,job.artifactManifest);
    assert.equal(Object.keys(exported).some((key)=>/path/i.test(key)),false);
    assert.doesNotMatch(JSON.stringify(exported),/([A-Za-z]:[\\/]|file:\/\/|\.partial)/i);

    const harness=new MediaJobProtocolHarness(new MediaJobProtocolV1(runtime));
    const status=await harness.exchange({
      contractVersion:MEDIA_JOB_CONTRACT_VERSION,action:"status",jobId:job.id
    });
    assert.equal(status.status,"succeeded");
    assert.equal(Object.hasOwn(status,"artifactManifest"),false);
    assert.equal(status.finalArtifact.sha256,exported.content.sha256);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("status, resume and export fail explicitly on tampered truncated missing or substituted artifact bytes", async (t) => {
  for (const mode of ["tampered","truncated","missing","substituted"]) {
    await t.test(mode,async()=>{
      const root=tempRoot(`media-wave7-${mode}-`);
      try {
        const {runtime,job}=await complete(root,`integrity-${mode}`,{bytes:"0123456789abcdef\n"});
        const file=job.resolvedOutputPath;
        if (mode==="tampered") writeFileSync(file,"tampered-content\n","utf8");
        if (mode==="truncated") writeFileSync(file,"01","utf8");
        if (mode==="missing") unlinkSync(file);
        if (mode==="substituted") writeFileSync(file,"fedcba9876543210\n","utf8");

        const harness=new MediaJobProtocolHarness(new MediaJobProtocolV1(runtime));
        for (const action of ["status","resume_or_poll"]) {
          const response=await harness.exchange({
            contractVersion:MEDIA_JOB_CONTRACT_VERSION,action,jobId:job.id
          });
          assert.equal(response.accepted,false);
          assert.equal(response.error.code,"artifact_integrity_failure");
        }
        assert.throws(
          ()=>runtime.exportArtifactManifest(job.id),
          (error)=>error.code==="artifact_integrity_failure"
        );
      } finally { rmSync(root,{recursive:true,force:true}); }
    });
  }
});

test("manifest binding rejects wrong job render fingerprint and QA evidence", async () => {
  const root=tempRoot("media-wave7-bindings-");
  try {
    const first=await complete(root,"binding-a");
    const secondRequest=request("binding-b");
    first.runtime.submit(secondRequest,{idempotencyKey:"creator:wave7:binding-b"});
    const second=await first.runtime.runAcceptedJob("binding-b");

    const variants=[
      ["wrong-job",()=>second.artifactManifest],
      ["wrong-render",()=>{
        const value=JSON.parse(JSON.stringify(first.job.artifactManifest));
        value.renderFingerprint="f".repeat(64);
        return value;
      }],
      ["qa-evidence",()=>{
        const value=JSON.parse(JSON.stringify(first.job.artifactManifest));
        value.qaEvidence.value.expected.width=65;
        value.qaEvidence.sha256=evidenceDigest(value.qaEvidence.value);
        return value;
      }]
    ];

    for (const [name,build] of variants) {
      let job=first.store.get(first.job.id);
      job={...job,artifactManifest:build()};
      job.artifactManifestSha256=artifactManifestDigest(job.artifactManifest);
      first.store.put(job);
      assert.throws(
        ()=>first.runtime.exportArtifactManifest(job.id),
        (error)=>error.code==="artifact_integrity_failure",
        name
      );
      first.store.put({
        ...job,
        artifactManifest:first.job.artifactManifest,
        artifactManifestSha256:first.job.artifactManifestSha256
      });
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("content identity is independent of temporary path", () => {
  const finalDigest={
    sha256:"a".repeat(64),
    size:123
  };
  const base={
    id:"same-job",
    idempotencyKey:"same-idem",
    renderFingerprint:"b".repeat(64),
    dryRun:false,
    timeline:{id:"same-job",version:1,canvas:{width:64,height:64,fps:10,durationMs:300},tracks:[]},
    exportSpec:{runtimeProfile:"standard"},
    outputPath:"outputs/same-job.mp4",
    createdAtMs:100,
    scheduling:{
      profile:"standard",priorityClass:"normal",
      requirements:{
        render:{cpu:1,gpu:0,render:1,probe:0,qa:0},
        probe:{cpu:1,gpu:0,render:0,probe:1,qa:0},
        qa:{cpu:1,gpu:0,render:0,probe:0,qa:1}
      }
    },
    currentAttempt:{token:"same-job:render:1"},
    probe:probe()
  };
  base.qa=evaluateRenderQa(base.timeline,base.probe);
  const one=buildArtifactManifest({...base,tempOutputPath:"tmp/one.partial"},{
    finalDigest,preparedDigest:finalDigest,preparedAtMs:200,finalizedAtMs:300,manifestCommittedAtMs:400
  });
  const two=buildArtifactManifest({...base,tempOutputPath:"elsewhere/two.partial"},{
    finalDigest,preparedDigest:finalDigest,preparedAtMs:200,finalizedAtMs:300,manifestCommittedAtMs:400
  });
  assert.equal(one.content.contentId,two.content.contentId);
  assert.equal(artifactManifestDigest(one),artifactManifestDigest(two));
});

test("restart after atomic finalize before manifest commit reconciles without rerender", async () => {
  const root=tempRoot("media-wave7-crash-window-");
  try {
    const seeded=seedSuccessBeforeManifest({root,jobId:"crash-before-manifest"});
    const restarted=runtimeFor(root);
    const recovered=restarted.runtime.recoverInterruptedJobs();
    const job=restarted.store.get("crash-before-manifest");
    assert.equal(job.status,"succeeded");
    assert.equal(restarted.calls(),0);
    assert.equal(job.artifactManifest.content.sha256,seeded.digest.sha256);
    assert.equal(job.telemetry.sideEffects.executorInvocations,1);
    assert.equal(job.telemetry.sideEffects.successfulFinalizations,1);
    assert.equal(recovered.some((item)=>item.id===job.id),true);
    assert.deepEqual(restarted.runtime.getSchedulerDiagnostics().resources.used,{
      cpu:0,gpu:0,render:0,probe:0,qa:0
    });
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("restart after manifest commit is idempotent and concurrent status reads are integrity-checked", async () => {
  const root=tempRoot("media-wave7-committed-restart-");
  try {
    const first=await complete(root,"committed-restart");
    const manifestDigest=first.job.artifactManifestSha256;
    const finalizeCount=first.job.telemetry.sideEffects.successfulFinalizations;

    const restarted=runtimeFor(root);
    restarted.runtime.recoverInterruptedJobs();
    restarted.runtime.recoverInterruptedJobs();
    assert.equal(restarted.calls(),0);

    const harness=new MediaJobProtocolHarness(new MediaJobProtocolV1(restarted.runtime));
    const statuses=await Promise.all(Array.from({length:24},()=>harness.exchange({
      contractVersion:MEDIA_JOB_CONTRACT_VERSION,
      action:"status",
      jobId:first.job.id
    })));
    assert.equal(statuses.every((value)=>value.status==="succeeded"),true);
    const after=restarted.store.get(first.job.id);
    assert.equal(after.artifactManifestSha256,manifestDigest);
    assert.equal(after.telemetry.sideEffects.successfulFinalizations,finalizeCount);
    assert.equal(after.telemetry.sideEffects.executorInvocations,1);
    assert.equal(restarted.calls(),0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("cancel race after atomic finalize suppresses manifest and removes final bytes", () => {
  const root=tempRoot("media-wave7-cancel-race-");
  try {
    seedSuccessBeforeManifest({root,jobId:"cancel-race",cancellationRequested:true});
    const restarted=runtimeFor(root);
    restarted.runtime.recoverInterruptedJobs();
    const job=restarted.store.get("cancel-race");
    assert.equal(job.status,"cancelled");
    assert.equal(job.artifactManifest??null,null);
    assert.equal(job.pendingArtifact??null,null);
    assert.equal(existsSync(job.resolvedOutputPath),false);
    assert.equal(restarted.calls(),0);
    assert.deepEqual(restarted.runtime.getSchedulerDiagnostics().resources.used,{
      cpu:0,gpu:0,render:0,probe:0,qa:0
    });
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("Wave 7 report pins fixture corpus and compatibility invariants", () => {
  const report=JSON.parse(readFileSync(reportUrl,"utf8"));
  assert.equal(report.reportVersion,"primary-media.wave7.artifact-integrity.v1");
  assert.equal(report.compatibilityHead,"e14140cafdf435c653b5b49432e7288ec25d06de");
  assert.equal(report.fixtureCount,3);
  assert.equal(report.integrityCases.length>=8,true);
  assert.equal(report.mediaRenderV1Preserved,true);
  assert.equal(report.mediaJobV1Preserved,true);
  assert.equal(report.publishing,false);
});
