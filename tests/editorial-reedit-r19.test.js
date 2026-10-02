import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GROWTH_CREATOR_REEDIT_HANDOFF_VERSION,
  GROWTH_REEDIT_ADAPTER_VERSION,
  MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION,
  R19_GROWTH_R23_AUTHORITY,
  fingerprint,
  stableStringify,
  validateEditorialDirectiveSet,
  validateEditorialReeditApplicationSidecar,
  validateEditorialReeditInput,
  validateGrowthR23Handoff,
  verifyEditorialReeditReplay
} from "../src/index.js";

const H = "a".repeat(64);
const I = "b".repeat(64);
const J = "c".repeat(64);
const K = "d".repeat(64);
const L = "e".repeat(64);
const M = "f".repeat(64);
const PRODUCER = "1".repeat(40);

const BRIDGE = {
  repository: "foto6/WebAIBridge",
  branch: "agent/bridge-r26-file-attachment-rehearsal-20261002",
  source_sha: "73c13f9eed2a2cbcea881dd8c5452d054bfef940",
  attachment_contract: "bridge.chat_file_attachment.v1",
  rehearsal_request_contract: "bridge.chat_file_attachment_rehearsal_request.v1",
  rehearsal_result_contract: "bridge.chat_file_attachment_rehearsal_result.v1",
  dom_probe_contract: "bridge.chat_file_attachment_dom_probe.v1",
  operator_evidence_contract: "bridge.chat_file_attachment_operator_evidence.v1",
  max_file_bytes: 500000000,
  disposition: "READY_FOR_EXPLICIT_LIVE_REHEARSAL",
  live_pass: false,
  real_upload_proven: false,
  real_prompt_send_proven: false,
  no_live_deploy: true,
  no_cutover: true
};
const MEDIA_R18 = {
  repository: "foto6/video2",
  branch: "agent/media-r18-direct-model-review-package-20261002",
  source_sha: "2c41f084e000eca5efd9a51d2d3752bec1bd1311",
  ci_run_id: 36967381891,
  contract: "media.direct_model_review_package.v1",
  max_file_bytes: 500000000,
  live_upload_performed: false,
  model_judgment_performed: false
};
const EVIDENCE = {
  model_review_only: true,
  human_ground_truth: false,
  human_label: false,
  live_platform_evidence: false,
  live_video_review_fabricated: false
};
const AUTHORITY = {
  advisory_only: true,
  creator_mutation: false,
  media_mutation: false,
  provider_mutation: false,
  upload_performed: false,
  publish_authorized: false,
  release_authorized: false
};

function binding(overrides = {}) {
  return {
    source_id: "source-1",
    source_sha256: H,
    source_size: 1000,
    media_repository: "foto6/video2",
    media_producer_sha: PRODUCER,
    candidate_id: "candidate-1",
    render_sha256: I,
    render_size: 2000,
    render_export_sha256: J,
    attachment_sha256: I,
    attachment_size: 2000,
    attachment_identity: `gvwa1:${K}`,
    review_bundle_digest: L,
    critic_input_digest: M,
    critic_output_digest: H,
    ...overrides
  };
}

function directive({
  idSeed = "obs-1",
  operation = "crop_scale_reframe",
  start = 500,
  end = 1200,
  defect = "subject_framing_crop_quality",
  severity = "major",
  bind = binding(),
  executable = false
} = {}) {
  const body = {
    operation,
    start_ms: start,
    end_ms: end,
    defect_category: defect,
    severity,
    source_observation_id: idSeed,
    evidence: `evidence:${idSeed}`,
    confidence: 0.85,
    uncertainty: "model review is non-human evidence",
    upstream_proposed_edit: "free-form suggestion retained for audit only",
    upstream_proposed_edit_executable: executable,
    binding: bind
  };
  return { ...body, directive_id: `gcrd1:${fingerprint(body)}` };
}

function handoff(directives = [directive()], overrides = {}) {
  const b = overrides.binding ?? binding();
  const normalized = directives.map((row) => ({ ...row, binding: b }));
  for (const row of normalized) {
    const body = { ...row };
    delete body.directive_id;
    row.directive_id = `gcrd1:${fingerprint(body)}`;
  }
  const pairwise = overrides.pairwise ?? {
    selection: null,
    mapped_candidate_id: null,
    output_digest: null
  };
  const round = overrides.reedit_round ?? 0;
  const out = {
    contract_version: GROWTH_CREATOR_REEDIT_HANDOFF_VERSION,
    adapter_version: GROWTH_REEDIT_ADAPTER_VERSION,
    handoff_id: `gcrh1:${fingerprint({
      critic_output_digest: b.critic_output_digest,
      pairwise_output_digest: pairwise.output_digest,
      reedit_round: round
    })}`,
    handoff_digest: "",
    state: "targeted_reedit",
    reedit_round: round,
    max_reedit_rounds: 2,
    binding: b,
    pairwise,
    coverage: {
      method: "targeted_ranges",
      inspected_ranges: [{ start_ms: 0, end_ms: 6000, kind: "targeted_recheck" }],
      uninspected_possible: true,
      every_frame_inspected: false,
      notes: "Only reported ranges are considered inspected.",
      coverage_uncertainty_preserved: true
    },
    summary_uncertainty: "Coverage is incomplete.",
    directives: normalized,
    bridge_r26_authority: BRIDGE,
    media_r18_authority: MEDIA_R18,
    evidence_boundary: EVIDENCE,
    authority: AUTHORITY
  };
  Object.assign(out, overrides.top ?? {});
  const material = structuredClone(out);
  material.handoff_digest = "";
  out.handoff_digest = fingerprint(material);
  return out;
}

test("R19 accepts exact Growth R23 targeted handoff and authority pin", () => {
  const parsed = validateGrowthR23Handoff(handoff());
  assert.equal(parsed.contract_version, GROWTH_CREATOR_REEDIT_HANDOFF_VERSION);
  assert.equal(parsed.directives.length, 1);
  assert.equal(R19_GROWTH_R23_AUTHORITY.sourceSha, "26f769abceb43a63677ea8f7ba028369db371696");
  assert.equal(R19_GROWTH_R23_AUTHORITY.ciRunId, 36974062565);
});

test("R19 rejects stale handoff/directive digests and executable free-form edits", () => {
  const stale = handoff();
  stale.handoff_digest = "0".repeat(64);
  assert.throws(() => validateGrowthR23Handoff(stale), /handoff digest mismatch/);

  const badDirective = handoff();
  badDirective.directives[0].directive_id = `gcrd1:${"0".repeat(64)}`;
  const material = structuredClone(badDirective);
  material.handoff_digest = "";
  badDirective.handoff_digest = fingerprint(material);
  assert.throws(() => validateGrowthR23Handoff(badDirective), /directive digest\/id mismatch/);

  const freeform = handoff([directive({ executable: true })]);
  assert.throws(() => validateGrowthR23Handoff(freeform), /free-form proposed edit is never executable/);
});

test("R19 rejects unsupported external-media/free-form operations", () => {
  const unsupported = handoff([directive({ operation: "broll_insert", defect: "broll_relevance" })]);
  assert.throws(() => validateGrowthR23Handoff(unsupported), /unsupported operation/);
});

test("R19 rejects contradictory, out-of-range and overlapping conflicting directives", () => {
  const contradictory = handoff([directive({ start: 1200, end: 800 })]);
  assert.throws(() => validateGrowthR23Handoff(contradictory), /interval is contradictory/);

  const outOfRange = handoff([directive({ start: 5200, end: 6100 })]);
  assert.throws(() => validateEditorialDirectiveSet(outOfRange, 6000), /exceeds candidate timeline duration/);

  const duplicateCrop = handoff([
    directive({ idSeed: "a", operation: "crop_scale_reframe", start: 500, end: 1500 }),
    directive({ idSeed: "b", operation: "crop_scale_reframe", start: 1000, end: 1800 })
  ]);
  assert.throws(() => validateEditorialDirectiveSet(duplicateCrop, 6000), /overlapping duplicate operation/);

  const cutOverlap = handoff([
    directive({ idSeed: "c", operation: "cut", start: 1000, end: 1300, defect: "semantic_cut_correctness" }),
    directive({ idSeed: "d", operation: "text_overlay", start: 1100, end: 1500, defect: "hook_clarity" })
  ]);
  assert.throws(() => validateEditorialDirectiveSet(cutOverlap, 6000), /cut\/trim interval cannot overlap/);
});

test("R19 rejects stale source/render binding before file execution", () => {
  const h = handoff();
  const candidate = {
    candidateId: "candidate-1",
    source: { sourceId: "source-1", sha256: "0".repeat(64), size: 1000 },
    finalPath: "candidate/final.mp4",
    renderSha256: I,
    renderSize: 2000,
    renderExportPath: "candidate/media.render_export.v1.json",
    renderExportSha256: J,
    renderProducerSha: PRODUCER
  };
  assert.throws(() => validateEditorialReeditInput({
    handoff: h,
    candidate,
    timeline: { id: "x", version: 1, canvas: { width: 1080, height: 1920, fps: 30, durationMs: 6000 }, tracks: [] },
    sandboxRoot: process.cwd()
  }), /metadata is stale/);
});

test("R19 rejects path traversal before touching candidate bytes", () => {
  const h = handoff();
  const candidate = {
    candidateId: "candidate-1",
    source: { sourceId: "source-1", sha256: H, size: 1000 },
    finalPath: "../outside.mp4",
    renderSha256: I,
    renderSize: 2000,
    renderExportPath: "../outside.json",
    renderExportSha256: J,
    renderProducerSha: PRODUCER
  };
  assert.throws(() => validateEditorialReeditInput({
    handoff: h,
    candidate,
    timeline: { id: "x", version: 1, canvas: { width: 1080, height: 1920, fps: 30, durationMs: 6000 }, tracks: [] },
    sandboxRoot: path.join(process.cwd(), ".sandbox")
  }), /sandbox|protected|escapes|path/i);
});

test("R19 replay is byte-idempotent and detects changed output", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r19-replay-"));
  const outputPath = path.join(root, "final.mp4");
  const renderExportPath = path.join(root, "media.render_export.v1.json");
  writeFileSync(outputPath, "render-bytes");
  writeFileSync(renderExportPath, "render-export-bytes");
  const output = readFileSync(outputPath);
  const renderExport = readFileSync(renderExportPath);
  const outputSha = createHash("sha256").update(output).digest("hex");
  const exportSha = createHash("sha256").update(renderExport).digest("hex");

  const plan = {
    contractVersion: MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION,
    handoff: { id: "gcrh1:" + "1".repeat(64), digest: "2".repeat(64), reeditRound: 0 },
    planDigest: "3".repeat(64)
  };
  const sidecar = validateEditorialReeditApplicationSidecar({
    contractVersion: MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION,
    producer: { repository: "foto6/video2", sha: PRODUCER },
    growthAuthority: R19_GROWTH_R23_AUTHORITY,
    handoff: plan.handoff,
    input: { candidateId: "candidate-1" },
    directiveDigest: "4".repeat(64),
    applications: [{ directiveId: "gcrd1:" + "5".repeat(64), operation: "cut", status: "applied" }],
    ffmpegPlanDigest: "6".repeat(64),
    outputTimelineDigest: "7".repeat(64),
    planDigest: plan.planDigest,
    output: { status: "succeeded", sha256: outputSha, size: output.length, renderExportSha256: exportSha },
    qa: { technicalPassed: true, technicalEvidenceSha256: "8".repeat(64), measurable: {} },
    humanQuality: false
  });

  const replay = verifyEditorialReeditReplay({
    existingSidecar: sidecar,
    plan,
    outputPath,
    renderExportPath
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.output.sha256, outputSha);

  writeFileSync(outputPath, "changed-render-bytes");
  assert.throws(() => verifyEditorialReeditReplay({
    existingSidecar: sidecar,
    plan,
    outputPath,
    renderExportPath
  }), /output bytes differ/);
});

test("R19 sidecar forbids human-quality claims", () => {
  const sidecar = {
    contractVersion: MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION,
    producer: { repository: "foto6/video2", sha: PRODUCER },
    growthAuthority: R19_GROWTH_R23_AUTHORITY,
    handoff: { id: "gcrh1:" + "1".repeat(64), digest: "2".repeat(64), reeditRound: 0 },
    input: { candidateId: "candidate-1" },
    directiveDigest: "3".repeat(64),
    applications: [{ directiveId: "gcrd1:" + "4".repeat(64), operation: "cut", status: "applied" }],
    ffmpegPlanDigest: "5".repeat(64),
    outputTimelineDigest: "6".repeat(64),
    planDigest: "7".repeat(64),
    output: { status: "succeeded", sha256: "8".repeat(64), size: 10, renderExportSha256: "9".repeat(64) },
    qa: { technicalPassed: true, technicalEvidenceSha256: "a".repeat(64), measurable: {} },
    humanQuality: true
  };
  assert.throws(() => validateEditorialReeditApplicationSidecar(sidecar), /human-quality claim must remain false/);
});

test("R19 stable handoff serialization is deterministic", () => {
  const a = handoff();
  const b = JSON.parse(stableStringify(a));
  assert.equal(fingerprint(a), fingerprint(b));
  assert.deepEqual(validateGrowthR23Handoff(a), validateGrowthR23Handoff(b));
});


test("R19 conformance manifest pins exact runtime, runner, tests and preserved authorities", () => {
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(
    new URL("../conformance/media.editorial_reedit_application.v1/manifest.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion, MEDIA_EDITORIAL_REEDIT_APPLICATION_VERSION);
  assert.equal(manifest.growthR23Authority.sourceSha, R19_GROWTH_R23_AUTHORITY.sourceSha);
  assert.equal(manifest.growthR23Authority.ciRunId, R19_GROWTH_R23_AUTHORITY.ciRunId);
  assert.equal(manifest.humanQuality, false);
  const r19ProducerSha = "31409de4bef473417a33a8c698507f7cfb1905e1";
  for (const [name, pin] of Object.entries(manifest.pins)) {
    const actual = execFileSync("git", ["rev-parse", `${r19ProducerSha}:${pin.path}`], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    assert.equal(actual, pin.gitBlobSha, name);
  }
});
