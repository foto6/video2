import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_JOB_CONTRACT_VERSION,
  MediaJobProtocolHarness,
  MediaJobProtocolV1,
  PersistentRenderJobStore,
  RenderRuntimeV2,
  buildRenderPlan,
  handleMediaRenderRequest,
  parseMediaJobConformanceFixture,
  parseMediaJobEnvelope,
  serializeMediaJobEnvelope,
  serializeMediaJobWireResponse,
  tempOutputPath,
  validateMediaJobPublicResponse
} from "../src/index.js";

const rootUrl = new URL("../", import.meta.url);
const packUrl = new URL("../conformance/media.job.v1/", import.meta.url);
const fixturesUrl = new URL("../conformance/media.job.v1/fixtures/", import.meta.url);
const runtimeFixtureUrl = new URL("../fixtures/runtime-v2/full-pipeline.request.json", import.meta.url);
const probeUrl = new URL("../fixtures/runtime-v2/probe-success.json", import.meta.url);
const renderV1Url = new URL("../fixtures/media.render.v1.request.json", import.meta.url);

function json(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), "media-job-conformance-"));
}
function store(dir) {
  return new PersistentRenderJobStore({ filePath: path.join(dir, "jobs.json") });
}
function probe() {
  return json(probeUrl);
}
function liveRequest(jobId, outputPath) {
  const request = json(runtimeFixtureUrl);
  request.jobId = jobId;
  request.outputPath = outputPath;
  request.dryRun = false;
  return request;
}
function successResult(command, content = "rendered") {
  writeFileSync(command.args.at(-1), content);
  return {
    ok:true, code:0, signal:null, timedOut:false, cancelled:false,
    stdout:"", stderr:"", stdoutTruncated:false, stderrTruncated:false, durationMs:1
  };
}

test("consumer manifest pins every canonical fixture and preserved media.render.v1 bytes", () => {
  const manifest = json(new URL("consumer-manifest.json", packUrl));
  assert.equal(manifest.contractVersion, MEDIA_JOB_CONTRACT_VERSION);
  assert.equal(manifest.producer.compatibilityBaseHead, "cc542d626622c780fba2d03d094815d3dca240f9");
  assert.equal(manifest.creatorReference.head, "7ece5182bdf0791eadda28f10e7316f3a496ded4");
  assert.equal(manifest.retryOwnership.afterAcceptance, "creator_resumes_same_job");
  assert.equal(manifest.retryOwnership.uncertainRestart, "reconciliation_required_before_new_executor");

  const actualNames = readdirSync(fixturesUrl).filter((name) => name.endsWith(".json")).sort();
  const manifestNames = manifest.fixtures.map((entry) => path.basename(entry.path)).sort();
  assert.deepEqual(actualNames, manifestNames);

  for (const entry of manifest.fixtures) {
    const file = new URL(entry.path.replace("conformance/media.job.v1/", ""), packUrl);
    const bytes = readFileSync(file);
    assert.equal(sha256(bytes), entry.sha256, entry.path);
    const parsed = parseMediaJobConformanceFixture(bytes.toString("utf8"));
    assert.equal(parsed.request.action, entry.action);
  }

  assert.equal(
    sha256(readFileSync(renderV1Url)),
    manifest.preservedContracts.mediaRenderV1.sha256
  );
});

test("every frozen response is strict and deterministic serializers round-trip", () => {
  const names = readdirSync(fixturesUrl).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const item = parseMediaJobConformanceFixture(readFileSync(new URL(name, fixturesUrl), "utf8"));
    assert.deepEqual(
      parseMediaJobEnvelope(serializeMediaJobEnvelope(item.request)),
      item.request,
      name
    );
    assert.doesNotThrow(() =>
      serializeMediaJobWireResponse(item.response, { action:item.request.action })
    );
  }
});

test("strict envelope parser fails closed on unknown fields/actions and publish drift", () => {
  const accepted = json(new URL("fixtures/submit.accepted.json", packUrl));
  assert.throws(
    () => parseMediaJobEnvelope({...accepted.request, extra:true}),
    /unknown fields/
  );
  assert.throws(
    () => parseMediaJobEnvelope({...accepted.request, action:"publish"}),
    /unsupported media.job.v1 action/
  );
  assert.throws(
    () => parseMediaJobEnvelope({...accepted.request, publish:true}),
    /unknown fields/
  );
  assert.throws(
    () => parseMediaJobEnvelope({
      ...accepted.request,
      request:{...accepted.request.request, extra:"drift"}
    }),
    /submit.request unknown fields/
  );
});

test("public response validator rejects impossible status/artifact combinations and extra fields", () => {
  const queued = json(new URL("fixtures/status.queued.json", packUrl)).response;
  const succeeded = json(new URL("fixtures/status.succeeded.json", packUrl)).response;
  const dry = json(new URL("fixtures/resume_or_poll.succeeded.json", packUrl)).response;

  assert.throws(
    () => validateMediaJobPublicResponse({...queued, extra:true}, {action:"status"}),
    /unknown fields/
  );
  assert.throws(
    () => validateMediaJobPublicResponse({...queued, terminal:true}, {action:"status"}),
    /terminal/
  );
  assert.throws(
    () => validateMediaJobPublicResponse({...queued, finalArtifact:succeeded.finalArtifact}, {action:"status"}),
    /finalArtifact is only valid/
  );
  assert.throws(
    () => validateMediaJobPublicResponse({...dry, finalArtifact:succeeded.finalArtifact}, {action:"resume_or_poll"}),
    /finalArtifact is only valid/
  );
  assert.throws(
    () => validateMediaJobPublicResponse({
      ...succeeded,
      finalArtifact:{...succeeded.finalArtifact, outputPath:".video.partial"}
    }, {action:"status"}),
    /partial\/temp/
  );
  assert.throws(
    () => validateMediaJobPublicResponse({
      ...succeeded,
      finalArtifact:{...succeeded.finalArtifact, outputPath:"E:\\manhwa\\artifact.mp4"}
    }, {action:"status"}),
    /protected/
  );
});

test("protocol harness freezes accepted duplicate/idempotency_conflict/job_conflict behavior", async () => {
  const dir = tmp();
  try {
    let executorCalls = 0;
    const runtime = new RenderRuntimeV2({
      store:store(dir),
      executor:{async run(){executorCalls += 1; throw new Error("dry run must not execute");}},
      probe:{async inspect(){throw new Error("dry run must not probe");}},
      sandboxRoot:dir,
      liveExecutionEnabled:true
    });
    const harness = new MediaJobProtocolHarness(new MediaJobProtocolV1(runtime));
    const acceptedFixture = json(new URL("fixtures/submit.accepted.json", packUrl));
    const duplicateFixture = json(new URL("fixtures/submit.duplicate.json", packUrl));
    const conflictFixture = json(new URL("fixtures/error.idempotency_conflict.json", packUrl));
    const jobConflictFixture = json(new URL("fixtures/error.job_conflict.json", packUrl));

    const accepted = await harness.exchange(acceptedFixture.request);
    const duplicate = await harness.exchange(duplicateFixture.request);
    const idemConflict = await harness.exchange(conflictFixture.request);
    const jobConflict = await harness.exchange(jobConflictFixture.request);

    assert.equal(accepted.accepted, true);
    assert.equal(accepted.duplicate, false);
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.jobId, accepted.jobId);
    assert.equal(duplicate.renderFingerprint, accepted.renderFingerprint);
    assert.equal(idemConflict.accepted, false);
    assert.equal(idemConflict.error.code, "idempotency_conflict");
    assert.equal(jobConflict.accepted, false);
    assert.equal(jobConflict.error.code, "job_conflict");
    assert.equal(executorCalls, 0);

    const jsonl = await harness.exchangeJsonLine(JSON.stringify({
      contractVersion:"media.job.v1",action:"status",jobId:accepted.jobId
    }));
    assert.equal(JSON.parse(jsonl).jobId, accepted.jobId);
    const rpc = await harness.exchangeRpc({
      contractVersion:"media.job.v1",action:"get",jobId:accepted.jobId
    });
    assert.equal(rpc.jobId, accepted.jobId);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test("caller timeout after acceptance resubmits same identity without extra executor invocation", async () => {
  const dir = tmp();
  try {
    let calls = 0;
    let started;
    let release;
    const startedP = new Promise((resolve)=>{started=resolve;});
    const releaseP = new Promise((resolve)=>{release=resolve;});
    const runtime = new RenderRuntimeV2({
      store:store(dir),
      executor:{
        async run(command){
          calls += 1;
          started();
          await releaseP;
          return successResult(command,"caller-timeout");
        }
      },
      probe:{async inspect(){return probe();}},
      sandboxRoot:dir,
      liveExecutionEnabled:true
    });
    const harness = new MediaJobProtocolHarness(new MediaJobProtocolV1(runtime));
    const request = liveRequest("caller-timeout-conformance","outputs/caller-timeout-conformance.mp4");
    const submit = {
      contractVersion:"media.job.v1",action:"submit",
      idempotencyKey:"creator:caller-timeout-conformance",request
    };
    const accepted = await harness.exchange(submit);
    const running = harness.exchange({
      contractVersion:"media.job.v1",action:"resume_or_poll",jobId:accepted.jobId
    });
    await startedP;

    const retrySubmit = await harness.exchange(submit);
    assert.equal(retrySubmit.duplicate,true);
    assert.equal(retrySubmit.jobId,accepted.jobId);
    assert.equal(retrySubmit.telemetry.sideEffects.executorInvocations,1);
    assert.equal(calls,1);

    release();
    const done = await running;
    assert.equal(done.status,"succeeded");
    assert.equal(done.telemetry.sideEffects.executorInvocations,1);
    assert.equal(calls,1);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test("uncertain restart stays reconciliation-blocked and cannot spawn executor until not_running", async () => {
  const dir = tmp();
  try {
    const initialStore = store(dir);
    const seed = new RenderRuntimeV2({
      store:initialStore,
      executor:{async run(){throw new Error("seed executor unused");}},
      probe:{async inspect(){return probe();}},
      sandboxRoot:dir,
      liveExecutionEnabled:true
    });
    const request = liveRequest("restart-conformance","outputs/restart-conformance.mp4");
    seed.submit(request,{idempotencyKey:"creator:restart-conformance"});
    let persisted = initialStore.get(request.jobId);
    const partial = tempOutputPath(persisted.resolvedOutputPath,persisted.id);
    mkdirSync(path.dirname(partial),{recursive:true});
    writeFileSync(partial,"uncertain");
    persisted = {
      ...persisted,
      status:"rendering",
      attempts:1,
      tempOutputPath:partial,
      currentAttempt:{
        token:`${persisted.id}:render:1`,
        renderInvocation:1,state:"started",startedAtMs:1
      },
      telemetry:{
        ...persisted.telemetry,
        sideEffects:{...persisted.telemetry.sideEffects,executorInvocations:1}
      }
    };
    initialStore.put(persisted);

    let calls = 0;
    const restarted = new RenderRuntimeV2({
      store:new PersistentRenderJobStore({filePath:initialStore.filePath}),
      executor:{async run(command){calls += 1; return successResult(command,"reconciled");}},
      probe:{async inspect(){return probe();}},
      sandboxRoot:dir,
      liveExecutionEnabled:true
    });
    restarted.recoverInterruptedJobs();
    const harness = new MediaJobProtocolHarness(new MediaJobProtocolV1(restarted));

    const status = await harness.exchange({
      contractVersion:"media.job.v1",action:"status",jobId:request.jobId
    });
    assert.equal(status.reconciliation.required,true);
    assert.equal(status.telemetry.sideEffects.executorInvocations,1);

    const blocked = await harness.exchange({
      contractVersion:"media.job.v1",action:"resume_or_poll",jobId:request.jobId
    });
    assert.equal(blocked.reconciliation.required,true);
    assert.equal(calls,0);

    restarted.reconcileAttempt(request.jobId,{outcome:"not_running"});
    const finished = await harness.exchange({
      contractVersion:"media.job.v1",action:"resume_or_poll",jobId:request.jobId
    });
    assert.equal(finished.status,"succeeded");
    assert.equal(finished.telemetry.sideEffects.executorInvocations,2);
    assert.equal(calls,1);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test("finalArtifact is exposed only after live QA atomic finalize; dry-run and partial paths never surface", async () => {
  const dir = tmp();
  try {
    const runtime = new RenderRuntimeV2({
      store:store(dir),
      executor:{async run(command){return successResult(command,"final-artifact");}},
      probe:{async inspect(){return probe();}},
      sandboxRoot:dir,
      liveExecutionEnabled:true
    });
    const harness = new MediaJobProtocolHarness(new MediaJobProtocolV1(runtime));

    const dryFixture = json(new URL("fixtures/submit.accepted.json", packUrl));
    const dryAccepted = await harness.exchange(dryFixture.request);
    const dryDone = await harness.exchange({
      contractVersion:"media.job.v1",action:"resume_or_poll",jobId:dryAccepted.jobId
    });
    assert.equal(dryDone.status,"succeeded");
    assert.equal(dryDone.finalArtifact,null);
    assert.equal(dryDone.telemetry.sideEffects.executorInvocations,0);

    const request = liveRequest("artifact-conformance","outputs/artifact-conformance.mp4");
    const liveAccepted = await harness.exchange({
      contractVersion:"media.job.v1",action:"submit",
      idempotencyKey:"creator:artifact-conformance",request
    });
    assert.equal(liveAccepted.finalArtifact,null);
    assert.equal(Object.hasOwn(liveAccepted,"tempOutputPath"),false);

    const done = await harness.exchange({
      contractVersion:"media.job.v1",action:"resume_or_poll",jobId:request.jobId
    });
    assert.equal(done.status,"succeeded");
    assert.equal(done.finalArtifact.outputPath,request.outputPath);
    assert.equal(existsSync(path.join(dir,request.outputPath)),true);
    assert.equal(existsSync(tempOutputPath(path.join(dir,request.outputPath),request.jobId)),false);
    assert.doesNotMatch(JSON.stringify(done),/\.partial/);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test("media.render.v1 planning fingerprint behavior remains unchanged", () => {
  const request = json(renderV1Url);
  const result = handleMediaRenderRequest(request);
  assert.equal(result.contractVersion,"media.render.v1");
  assert.equal(result.dryRun,true);
  assert.equal(result.renderFingerprint,buildRenderPlan(request.timeline,request.exportSpec).fingerprint);
});
