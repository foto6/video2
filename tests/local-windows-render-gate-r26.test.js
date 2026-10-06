import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION,
  R26_LOCAL_PHASES,
  R26LocalRenderGateError,
  beginR26Invocation,
  bindR26RenderGraph,
  completeR26Phase,
  createR26Ledger,
  loadOrCreateR26Ledger,
  r26Digest,
  r26Sha256File,
  r26Status,
  recordR26Cancellation,
  runR26DurablePhase,
  validateR26Ledger,
  verifyR26Artifacts
} from "../src/local-windows-render-gate-r26.js";

const H = (c) => c.repeat(64);
const bootstrap = (overrides = {}) => ({
  operationId: "r26-local-op",
  producerSha: "1".repeat(40),
  runtimeManifestSha256: H("a"),
  ...overrides
});
const binding = (overrides = {}) => ({
  source: { sha256: H("b"), size: 11 },
  requestSha256: H("c"),
  planDigest: H("d"),
  renderGraphDigest: H("e"),
  ...overrides
});
function root() {
  return mkdtempSync(path.join(os.tmpdir(), "media-r26-"));
}
function paths() {
  const dir = root();
  return { dir, ledger: path.join(dir, "ledger.json") };
}
function evidence(dir, name, text = name) {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return { artifacts: [{ path: file, ...r26Sha256File(file) }], elapsedMs: 7 };
}
function completeThrough(file, boot, dir, lastIndex) {
  for (let i = 0; i <= lastIndex; i += 1) {
    completeR26Phase(file, boot, R26_LOCAL_PHASES[i], evidence(dir, `${i}.bin`));
  }
}

test("R26 contract and phase order are frozen", () => {
  assert.equal(MEDIA_LOCAL_WINDOWS_RENDER_GATE_VERSION, "media.local_windows_render_gate.r26.v1");
  assert.deepEqual(R26_LOCAL_PHASES.slice(0, 3), ["pair-1", "candidate-3", "candidate-4-segment-1"]);
  assert.equal(R26_LOCAL_PHASES.at(-1), "verify");
});

test("R26 creates a fail-closed ledger with live authorization false", () => {
  const ledger = createR26Ledger(bootstrap());
  assert.equal(ledger.state, "RUNNABLE");
  assert.equal(ledger.liveAuthorization, false);
  assert.equal(ledger.providerCalls, false);
  assert.equal(ledger.browserCalls, false);
  assert.equal(ledger.socialPublish, false);
});

test("R26 rejects a wrong contract version", () => {
  const ledger = createR26Ledger(bootstrap());
  ledger.contractVersion = "wrong";
  assert.throws(() => validateR26Ledger(ledger), /wrong R26 ledger contract/);
});

test("R26 rejects bootstrap digest corruption", () => {
  const ledger = createR26Ledger(bootstrap());
  ledger.bootstrapDigest = H("f");
  assert.throws(() => validateR26Ledger(ledger), /bootstrap digest mismatch/);
});

test("R26 operation identity conflicts when producer changes", () => {
  const { ledger } = paths();
  loadOrCreateR26Ledger(ledger, bootstrap());
  assert.throws(
    () => loadOrCreateR26Ledger(ledger, bootstrap({ producerSha: "2".repeat(40) })),
    (error) => error instanceof R26LocalRenderGateError && error.code === "R26_OPERATION_CONFLICT"
  );
});

test("R26 operation identity conflicts when runtime changes", () => {
  const { ledger } = paths();
  loadOrCreateR26Ledger(ledger, bootstrap());
  assert.throws(
    () => loadOrCreateR26Ledger(ledger, bootstrap({ runtimeManifestSha256: H("9") })),
    /operation ID, producer SHA, or FFmpeg runtime changed/
  );
});

test("R26 binds exact source/request/plan/render graph once", () => {
  const { ledger } = paths();
  const out = bindR26RenderGraph(ledger, bootstrap(), binding());
  assert.equal(out.renderBinding.value.source.sha256, H("b"));
  assert.match(out.renderBinding.digest, /^[a-f0-9]{64}$/);
});

test("R26 changed render graph under same operation ID conflicts", () => {
  const { ledger } = paths();
  bindR26RenderGraph(ledger, bootstrap(), binding());
  assert.throws(
    () => bindR26RenderGraph(ledger, bootstrap(), binding({ renderGraphDigest: H("8") })),
    (error) => error.code === "R26_OPERATION_CONFLICT"
  );
});

test("R26 changed source under same operation ID conflicts", () => {
  const { ledger } = paths();
  bindR26RenderGraph(ledger, bootstrap(), binding());
  assert.throws(
    () => bindR26RenderGraph(ledger, bootstrap(), binding({
      source: { sha256: H("7"), size: 11 }
    })),
    /changed source\/request\/render graph/
  );
});

test("R26 cannot skip durable phase order", () => {
  const { dir, ledger } = paths();
  assert.throws(
    () => completeR26Phase(ledger, bootstrap(), "candidate-3", evidence(dir, "c3.bin")),
    (error) => error.code === "R26_PHASE_ORDER"
  );
});

test("R26 exact phase replay is idempotent", () => {
  const { dir, ledger } = paths();
  const e = evidence(dir, "p1.bin");
  const first = completeR26Phase(ledger, bootstrap(), "pair-1", e);
  const second = completeR26Phase(ledger, bootstrap(), "pair-1", e);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
});

test("R26 altered completed phase evidence conflicts", () => {
  const { dir, ledger } = paths();
  completeR26Phase(ledger, bootstrap(), "pair-1", evidence(dir, "p1.bin", "one"));
  assert.throws(
    () => completeR26Phase(ledger, bootstrap(), "pair-1", evidence(dir, "p2.bin", "two")),
    (error) => error.code === "R26_PHASE_CONFLICT"
  );
});

test("R26 completed phase artifact bytes are reverified before reuse", () => {
  const { dir } = paths();
  const e = evidence(dir, "artifact.bin", "stable");
  assert.equal(verifyR26Artifacts(e.artifacts), true);
  writeFileSync(e.artifacts[0].path, "tampered");
  assert.throws(
    () => verifyR26Artifacts(e.artifacts),
    (error) => error.code === "R26_CHECKPOINT_CORRUPT"
  );
});

test("R26 corrupt JSON ledger fails closed", () => {
  const { ledger } = paths();
  writeFileSync(ledger, "{not-json");
  assert.throws(
    () => loadOrCreateR26Ledger(ledger, bootstrap()),
    (error) => error.code === "R26_LEDGER_CORRUPT"
  );
});

test("R26 kill/restart between durable phases reuses completed work", async () => {
  const { dir, ledger } = paths();
  let calls = 0;
  await runR26DurablePhase({
    ledgerPath: ledger,
    bootstrap: bootstrap(),
    phase: "pair-1",
    verifyCompleted: async (record) => verifyR26Artifacts(record.evidence.artifacts),
    execute: async () => {
      calls += 1;
      return evidence(dir, "pair.bin", "real-bytes");
    }
  });
  const recovered = JSON.parse(readFileSync(ledger, "utf8"));
  validateR26Ledger(recovered, bootstrap());
  const resumed = await runR26DurablePhase({
    ledgerPath: ledger,
    bootstrap: bootstrap(),
    phase: "pair-1",
    verifyCompleted: async (record) => verifyR26Artifacts(record.evidence.artifacts),
    execute: async () => {
      calls += 1;
      throw new Error("must not rerender");
    }
  });
  assert.equal(resumed.reused, true);
  assert.equal(calls, 1);
});

test("R26 corrupt checkpoint on restart fails instead of rerendering", async () => {
  const { dir, ledger } = paths();
  const e = evidence(dir, "pair.bin", "good");
  completeR26Phase(ledger, bootstrap(), "pair-1", e);
  writeFileSync(e.artifacts[0].path, "bad");
  let rerenders = 0;
  await assert.rejects(
    runR26DurablePhase({
      ledgerPath: ledger,
      bootstrap: bootstrap(),
      phase: "pair-1",
      verifyCompleted: async (record) => verifyR26Artifacts(record.evidence.artifacts),
      execute: async () => {
        rerenders += 1;
        return e;
      }
    }),
    (error) => error.code === "R26_CHECKPOINT_CORRUPT"
  );
  assert.equal(rerenders, 0);
});

test("R26 invocation ledger exposes resume evidence", () => {
  const { dir, ledger } = paths();
  completeR26Phase(ledger, bootstrap(), "pair-1", evidence(dir, "pair.bin"));
  const inv = beginR26Invocation(ledger, bootstrap(), { host: "fixture" });
  assert.equal(inv.sequence, 1);
  assert.deepEqual(inv.resumedCompletedPhases, ["pair-1"]);
});

test("R26 cancellation is durable but does not mark a phase complete", () => {
  const { ledger } = paths();
  const event = recordR26Cancellation(ledger, bootstrap(), { phase: "candidate-3", reason: "SIGINT" });
  assert.equal(event.sequence, 1);
  const loaded = loadOrCreateR26Ledger(ledger, bootstrap());
  assert.equal(loaded.cancellationEvents.length, 1);
  assert.equal(loaded.phases["candidate-3"], undefined);
});

test("R26 full control-plane replay reaches LOCAL_REHEARSAL_COMPLETE", () => {
  const { dir, ledger } = paths();
  completeThrough(ledger, bootstrap(), dir, R26_LOCAL_PHASES.length - 1);
  const status = r26Status(loadOrCreateR26Ledger(ledger, bootstrap()));
  assert.equal(status.state, "LOCAL_REHEARSAL_COMPLETE");
  assert.equal(status.nextPhase, null);
  assert.equal(status.liveAuthorization, false);
});

test("R26 evidence digests are canonical", () => {
  assert.equal(r26Digest({ b: 2, a: 1 }), r26Digest({ a: 1, b: 2 }));
});
