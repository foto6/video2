import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MEDIA_PRIOR_REVIEW_SELECTION_VERSION,
  MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
  MEDIA_REVIEW_ROUND_HANDOFF_VERSION,
  ROUND_PAIR_PACKAGE_READY,
  R21_BRIDGE_R30_AUTHORITY,
  fingerprint,
  validatePriorReviewSelection,
  validateReviewRoundBundle,
  validateReviewRoundRequest
} from "../src/index.js";

const H = (c) => c.repeat(64);
const G = (c) => c.repeat(40);

function candidate({ id, round = 0, renderSha, application = undefined } = {}) {
  return {
    candidateId: id ?? `candidate-${round}`,
    roundNumber: round,
    source: {
      sourceId: "shared-source",
      sha256: H("a"),
      size: 1234,
      path: "source.mp4"
    },
    render: {
      path: `${id ?? "candidate"}.mp4`,
      sha256: renderSha ?? H(round === 0 ? "b" : "c"),
      size: 456
    },
    renderExport: {
      path: `${id ?? "candidate"}.render.json`,
      fileSha256: H("d"),
      digest: H("e")
    },
    renderProducerSha: G("f"),
    editorialApplication: application === undefined
      ? (round === 0 ? null : {
          path: `${id ?? "candidate"}.r19.json`,
          fileSha256: H("1"),
          digest: H("2")
        })
      : application,
    reviewDerivative: null
  };
}
function participant(options = {}) {
  return {
    candidate: candidate(options),
    briefLineageDigest: H("9")
  };
}
function priorReview({ selected = "baseline", round = 0, evidenceType = "model_review_capture" } = {}) {
  return {
    contractVersion: MEDIA_PRIOR_REVIEW_SELECTION_VERSION,
    selectedCandidateId: selected,
    reviewRound: round,
    reviewPackageDigest: H("3"),
    sealedMappingDigest: H("4"),
    decisionEvidenceDigest: H("5"),
    evidenceType
  };
}

test("R21 pins Bridge R30 branch to exact green R29 implementation head", () => {
  assert.equal(R21_BRIDGE_R30_AUTHORITY.branchHeadSha, "ed9a35290f94607d7577f1ee9301de1bb44334f2");
  assert.equal(R21_BRIDGE_R30_AUTHORITY.provenImplementationCiRunId, 36989658042);
  assert.equal(R21_BRIDGE_R30_AUTHORITY.nativeR30RoundPairConsumerPresentAtPin, false);
  assert.equal(R21_BRIDGE_R30_AUTHORITY.transportNeutralMediaHandoff, MEDIA_REVIEW_ROUND_HANDOFF_VERSION);
});

test("R21 initial review requires exactly round-0 same-brief participants", () => {
  const parsed = validateReviewRoundRequest({
    mode: "initial",
    left: participant({ id: "a", renderSha: H("6") }),
    right: participant({ id: "b", renderSha: H("7") })
  });
  assert.equal(parsed.mode, "initial");
  assert.equal(parsed.left.candidate.roundNumber, 0);
  assert.equal(parsed.right.candidate.roundNumber, 0);

  const mismatch = {
    mode: "initial",
    left: participant({ id: "a", renderSha: H("6") }),
    right: participant({ id: "b", renderSha: H("7") })
  };
  mismatch.right.briefLineageDigest = H("8");
  assert.throws(() => validateReviewRoundRequest(mismatch), /same brief lineage/);

  const wrongRound = {
    mode: "initial",
    left: participant({ id: "a", renderSha: H("6") }),
    right: participant({ id: "b", round: 1, renderSha: H("7") })
  };
  assert.throws(() => validateReviewRoundRequest(wrongRound), /round-0/);
});

test("R21 rejects unrelated sources and byte-identical initial candidates before artifact work", () => {
  const unrelated = {
    mode: "initial",
    left: participant({ id: "left", renderSha: H("6") }),
    right: participant({ id: "right", renderSha: H("7") })
  };
  unrelated.right.candidate.source.sha256 = H("8");
  assert.throws(() => validateReviewRoundRequest(unrelated), /same exact source/);

  assert.throws(() => validateReviewRoundRequest({
    mode: "initial",
    left: participant({ id: "left", renderSha: H("6") }),
    right: participant({ id: "right", renderSha: H("6") })
  }), /byte-identical renders/);
});

test("R21 targeted review requires selected baseline and exactly N+1 challenger", () => {
  const parsed = validateReviewRoundRequest({
    mode: "targeted_reedit",
    baseline: participant({ id: "baseline", round: 0, renderSha: H("6") }),
    challenger: participant({ id: "challenger", round: 1, renderSha: H("7") }),
    priorReview: priorReview()
  });
  assert.equal(parsed.priorReview.selectedCandidateId, "baseline");

  assert.throws(() => validateReviewRoundRequest({
    mode: "targeted_reedit",
    baseline: participant({ id: "baseline", round: 0, renderSha: H("6") }),
    challenger: participant({ id: "challenger", round: 2, renderSha: H("7") }),
    priorReview: priorReview()
  }), /exactly baseline round N\+1/);

  assert.throws(() => validateReviewRoundRequest({
    mode: "targeted_reedit",
    baseline: participant({ id: "baseline", round: 0, renderSha: H("6") }),
    challenger: participant({ id: "challenger", round: 1, renderSha: H("7") }),
    priorReview: priorReview({ selected: "different" })
  }), /does not identify the baseline/);
});

test("R21 lineage model keeps review alias separate from canonical R19 parent identity", () => {
  const bundle = syntheticBundle();
  assert.equal(bundle.roundLineage.baselineReviewCandidateId, "baseline");
  assert.equal(bundle.roundLineage.applicationParentCandidateId, "canonical-parent");
  assert.equal(bundle.roundLineage.parentRenderSha256, H("b"));
  assert.doesNotThrow(() => validateReviewRoundBundle(bundle));
});

test("R21 prior selection distinguishes real-model/growth evidence from fixture rehearsal", () => {
  for (const evidenceType of ["model_review_capture", "growth_reedit_handoff", "fixture_rehearsal"]) {
    const parsed = validatePriorReviewSelection(priorReview({ evidenceType }), {
      baselineCandidateId: "baseline",
      baselineRound: 0
    });
    assert.equal(parsed.evidenceType, evidenceType);
  }
  assert.throws(() => validatePriorReviewSelection(priorReview({ evidenceType: "fabricated_winner" })), /unsupported/);
});

function syntheticBundle() {
  const entries = [
    {
      blindLabel: "A",
      genericFileName: "review-A.mp4",
      role: "baseline",
      candidateId: "baseline",
      roundNumber: 0,
      briefLineageDigest: H("9"),
      source: { sourceId: "s", sha256: H("a"), size: 10, artifactPath: "s.mp4" },
      render: { sha256: H("b"), size: 20, artifactPath: "a.mp4" },
      renderExport: { digest: H("c"), fileSha256: H("d"), artifactPath: "a.json" },
      renderProducerSha: G("e"),
      parentCandidateId: null,
      parentRenderSha256: null,
      growthHandoffDigest: null,
      mediaApplicationDigest: null,
      attachment: { sha256: H("b"), size: 20, mimeType: "video/mp4", derivative_for_model_review: false, derivative: null }
    },
    {
      blindLabel: "B",
      genericFileName: "review-B.mp4",
      role: "challenger",
      candidateId: "challenger",
      roundNumber: 1,
      briefLineageDigest: H("9"),
      source: { sourceId: "s", sha256: H("a"), size: 10, artifactPath: "s.mp4" },
      render: { sha256: H("f"), size: 21, artifactPath: "b.mp4" },
      renderExport: { digest: H("1"), fileSha256: H("2"), artifactPath: "b.json" },
      renderProducerSha: G("e"),
      parentCandidateId: "baseline",
      parentRenderSha256: H("b"),
      growthHandoffDigest: H("6"),
      mediaApplicationDigest: H("7"),
      attachment: { sha256: H("f"), size: 21, mimeType: "video/mp4", derivative_for_model_review: false, derivative: null }
    }
  ];
  const sealedMapping = { entries, digest: fingerprint(entries) };
  const promptText = "Review the two attached MP4 files as blinded candidates A and B.";
  const prompt = {
    text: promptText,
    digest: createHash("sha256").update(promptText, "utf8").digest("hex")
  };
  const roundLineage = {
    baselineReviewCandidateId: "baseline",
    applicationParentCandidateId: "canonical-parent",
    parentRenderSha256: H("b"),
    parentRound: 0,
    childReviewCandidateId: "challenger",
    childRenderSha256: H("f"),
    childRound: 1,
    growthHandoffDigest: H("6"),
    mediaApplicationDigest: H("7"),
    mediaApplicationFileSha256: H("8"),
    priorReview: priorReview()
  };
  const core = {
    contractVersion: MEDIA_REVIEW_ROUND_BUNDLE_VERSION,
    state: ROUND_PAIR_PACKAGE_READY,
    producer: { repository: "foto6/video2", sha: G("a") },
    bridgeAuthority: R21_BRIDGE_R30_AUTHORITY,
    mode: "targeted_reedit",
    source: { sourceId: "s", sha256: H("a"), size: 10 },
    briefLineageDigest: H("9"),
    reviewRound: 1,
    attachments: [
      { blindLabel: "A", path: "review-A.mp4", sha256: H("b"), size: 20, mimeType: "video/mp4", derivative_for_model_review: false },
      { blindLabel: "B", path: "review-B.mp4", sha256: H("f"), size: 21, mimeType: "video/mp4", derivative_for_model_review: false }
    ],
    prompt,
    r20PackageDigest: H("3"),
    r20SealedMappingDigest: H("4"),
    sealedMapping,
    roundLineage,
    modelReviewPerformed: false,
    liveModelReviewed: false,
    providerPublish: false,
    humanQuality: false
  };
  const packageDigest = fingerprint(core);
  return {
    ...core,
    transportHandoff: {
      contractVersion: MEDIA_REVIEW_ROUND_HANDOFF_VERSION,
      state: ROUND_PAIR_PACKAGE_READY,
      bridgeAuthority: R21_BRIDGE_R30_AUTHORITY,
      packageDigest,
      sealedMappingDigest: sealedMapping.digest,
      promptBytes: Buffer.byteLength(promptText),
      promptText,
      promptDigest: prompt.digest,
      sourceLineage: {
        sourceId: "s",
        sha256: H("a"),
        size: 10,
        briefLineageDigest: H("9")
      },
      roundLineage: {
        mode: "targeted_reedit",
        reviewRound: 1,
        digest: fingerprint({
          source: core.source,
          briefLineageDigest: core.briefLineageDigest,
          reviewRound: core.reviewRound,
          roundLineage
        })
      },
      attachments: core.attachments,
      modelReviewPerformed: false,
      liveModelReviewed: false,
      providerPublish: false,
      humanQuality: false
    }
  };
}

test("R21 bundle validator enforces READY state and exact transport binding", () => {
  const bundle = syntheticBundle();
  const parsed = validateReviewRoundBundle(bundle);
  assert.equal(parsed.state, ROUND_PAIR_PACKAGE_READY);
  assert.equal(parsed.modelReviewPerformed, false);
  assert.equal(parsed.liveModelReviewed, false);
  assert.equal(parsed.providerPublish, false);
  assert.equal(parsed.humanQuality, false);

  const bad = structuredClone(bundle);
  bad.transportHandoff.packageDigest = H("0");
  assert.throws(() => validateReviewRoundBundle(bad), /does not bind bundle/);
});

test("R21 conformance manifest pins implementation and frozen consumer authorities", () => {
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(
    new URL("../conformance/media.review_round_bundle.r21.v1/manifest.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion, MEDIA_REVIEW_ROUND_BUNDLE_VERSION);
  assert.equal(manifest.bridgeR30Authority.branchHeadSha, R21_BRIDGE_R30_AUTHORITY.branchHeadSha);
  assert.equal(manifest.bridgeR30Authority.provenImplementationCiRunId, R21_BRIDGE_R30_AUTHORITY.provenImplementationCiRunId);
  assert.equal(manifest.requiredState, ROUND_PAIR_PACKAGE_READY);
  assert.equal(manifest.humanQuality, false);
  const r21ProducerSha = "d753e9e4c1f4448386608a1425232dbc1dba87ea";
  for (const [name, pin] of Object.entries(manifest.pins)) {
    const actual = execFileSync("git", ["rev-parse", `${r21ProducerSha}:${pin.path}`], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    assert.equal(actual, pin.gitBlobSha, name);
  }
});
