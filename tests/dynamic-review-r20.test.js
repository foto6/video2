import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DYNAMIC_REVIEW_PACKAGE_READY,
  LIVE_MODEL_REVIEWED,
  MEDIA_DYNAMIC_REVIEW_HANDOFF_VERSION,
  MEDIA_DYNAMIC_REVIEW_PACKAGE_VERSION,
  R20_BRIDGE_R29_AUTHORITY,
  buildDirectModelReviewPromptManifest,
  deterministicBlindAssignment,
  dynamicReviewIntent,
  fingerprint,
  materializeBridgeExistingChatReviewRequest,
  validateDynamicCandidateDescriptor,
  validateDynamicReviewPackage
} from "../src/index.js";

const H = (c) => c.repeat(64);
const G = (c) => c.repeat(40);

function candidate({
  id = "alpha-current",
  round = 0,
  renderSha = H("a"),
  renderSize = 100,
  exportDigest = H("b"),
  producer = G("c"),
  application = undefined
} = {}) {
  return {
    candidateId: id,
    roundNumber: round,
    source: {
      sourceId: "source-stable",
      sha256: H("d"),
      size: 1234,
      path: "source.mp4"
    },
    render: {
      path: `${id}.mp4`,
      sha256: renderSha,
      size: renderSize
    },
    renderExport: {
      path: `${id}.render.json`,
      fileSha256: H("e"),
      digest: exportDigest
    },
    renderProducerSha: producer,
    editorialApplication: application === undefined
      ? (round === 0 ? null : {
          path: `${id}.r19.json`,
          fileSha256: H("f"),
          digest: H("1")
        })
      : application,
    reviewDerivative: null
  };
}

test("R20 pins current Bridge R29 branch to exact green R28 wire authority", () => {
  assert.equal(R20_BRIDGE_R29_AUTHORITY.branchHeadSha, "8b314bd020b05d90f6c45fa861727df5e78e5a39");
  assert.equal(R20_BRIDGE_R29_AUTHORITY.inheritedGreenCiRunId, 36983797963);
  assert.equal(R20_BRIDGE_R29_AUTHORITY.requestContract, "bridge.existing_chat_video_review_request.v1");
  assert.equal(R20_BRIDGE_R29_AUTHORITY.r29WireFormatDivergedFromR28, false);
});

test("R20 accepts round-0 candidates without R19 application", () => {
  const parsed = validateDynamicCandidateDescriptor(candidate());
  assert.equal(parsed.roundNumber, 0);
  assert.equal(parsed.editorialApplication, null);
});

test("R20 requires exact R19 application binding on re-edit rounds", () => {
  assert.throws(
    () => validateDynamicCandidateDescriptor(candidate({ round: 1, application: null })),
    /requires R19 editorial application/
  );
  assert.throws(
    () => validateDynamicCandidateDescriptor(candidate({
      round: 0,
      application: { path: "x.json", fileSha256: H("f"), digest: H("1") }
    })),
    /round 0 candidate cannot bind/
  );
});

test("R20 distinguishes initial review from targeted re-edit review", () => {
  assert.deepEqual(dynamicReviewIntent([
    candidate({ id: "a", renderSha: H("a") }),
    candidate({ id: "b", renderSha: H("b"), exportDigest: H("c") })
  ]), { reviewRound: 0, intent: "initial_candidate_review" });

  assert.deepEqual(dynamicReviewIntent([
    candidate({ id: "base", round: 0, renderSha: H("a") }),
    candidate({ id: "reedit", round: 1, renderSha: H("b"), exportDigest: H("c") })
  ]), { reviewRound: 1, intent: "targeted_reedit_review" });
});

test("R20 rejects skipped round comparisons", () => {
  assert.throws(() => dynamicReviewIntent([
    candidate({ id: "r0", round: 0, renderSha: H("a") }),
    candidate({ id: "r2", round: 2, renderSha: H("b"), exportDigest: H("c") })
  ]), /cannot skip an intermediate re-edit round/);
});

test("R20 never silently compares byte-identical candidates", () => {
  assert.throws(() => deterministicBlindAssignment([
    candidate({ id: "one", renderSha: H("a") }),
    candidate({ id: "two", renderSha: H("a"), exportDigest: H("c") })
  ]), /byte-identical candidates are rejected/);
});

test("R20 blinded assignment is deterministic and independent of input order", () => {
  const a = candidate({ id: "internal-first", renderSha: H("1"), exportDigest: H("2") });
  const b = candidate({ id: "internal-second", renderSha: H("3"), exportDigest: H("4") });
  const forward = deterministicBlindAssignment([a, b]);
  const reverse = deterministicBlindAssignment([b, a]);
  assert.deepEqual(
    forward.map((x) => [x.blindLabel, x.candidate.candidateId]),
    reverse.map((x) => [x.blindLabel, x.candidate.candidateId])
  );
  assert.deepEqual(forward.map((x) => x.genericFileName), ["review-A.mp4", "review-B.mp4"]);
});

function syntheticPackage(root) {
  const aBytes = Buffer.from("r20-review-a");
  const bBytes = Buffer.from("r20-review-b");
  writeFileSync(path.join(root, "review-A.mp4"), aBytes);
  writeFileSync(path.join(root, "review-B.mp4"), bBytes);
  const attachments = [
    {
      blindLabel: "A",
      genericFileName: "review-A.mp4",
      mimeType: "video/mp4",
      file: {
        path: "review-A.mp4",
        sha256: createHash("sha256").update(aBytes).digest("hex"),
        size: aBytes.length
      },
      derivative: null
    },
    {
      blindLabel: "B",
      genericFileName: "review-B.mp4",
      mimeType: "video/mp4",
      file: {
        path: "review-B.mp4",
        sha256: createHash("sha256").update(bBytes).digest("hex"),
        size: bBytes.length
      },
      derivative: null
    }
  ];
  const promptManifest = buildDirectModelReviewPromptManifest({ attachments });
  const promptDigest = createHash("sha256").update(promptManifest.promptText, "utf8").digest("hex");
  const entries = [
    { blindLabel: "A", candidateId: "hidden-a" },
    { blindLabel: "B", candidateId: "hidden-b" }
  ];
  const sealedMapping = { entries, digest: fingerprint(entries) };
  return {
    contractVersion: MEDIA_DYNAMIC_REVIEW_PACKAGE_VERSION,
    state: DYNAMIC_REVIEW_PACKAGE_READY,
    packageProducer: { repository: "foto6/video2", sha: G("a") },
    bridgeAuthority: R20_BRIDGE_R29_AUTHORITY,
    source: { sourceId: "hidden-source", sha256: H("b"), size: 123, path: "source.mp4" },
    reviewContext: { reviewRound: 1, intent: "targeted_reedit_review" },
    attachments,
    promptManifest,
    promptDigest,
    sealedMapping,
    bridgeHandoff: {
      contractVersion: MEDIA_DYNAMIC_REVIEW_HANDOFF_VERSION,
      state: DYNAMIC_REVIEW_PACKAGE_READY,
      promptDigest,
      sealedMappingDigest: sealedMapping.digest,
      requestId: "r20-test",
      idempotencyKey: "r20:test",
      target: {
        managedChatId: "managed-test",
        profileId: "profile-test",
        conversationId: "conversation-test",
        titleHint: "test",
        expectedAccountMarkerHash: ""
      }
    },
    modelReview: {
      performed: false,
      state: DYNAMIC_REVIEW_PACKAGE_READY,
      nextState: LIVE_MODEL_REVIEWED,
      capture: null
    },
    humanQuality: false
  };
}

test("R20 package state is READY and explicitly not LIVE_MODEL_REVIEWED", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r20-state-"));
  const pkg = syntheticPackage(root);
  const parsed = validateDynamicReviewPackage(pkg);
  assert.equal(parsed.state, DYNAMIC_REVIEW_PACKAGE_READY);
  assert.equal(parsed.modelReview.performed, false);
  assert.equal(parsed.modelReview.nextState, LIVE_MODEL_REVIEWED);
  assert.equal(parsed.humanQuality, false);

  const bad = structuredClone(pkg);
  bad.state = LIVE_MODEL_REVIEWED;
  assert.throws(() => validateDynamicReviewPackage(bad), /only emit DYNAMIC_REVIEW_PACKAGE_READY/);
});

test("R20 materializes exact Bridge R29/R28 request with blinded basenames and byte identities", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r20-bridge-"));
  const pkg = syntheticPackage(root);
  const request = materializeBridgeExistingChatReviewRequest(pkg, root);
  assert.equal(request.contract, "bridge.existing_chat_video_review_request.v1");
  assert.equal(request.attachments.length, 2);
  assert.deepEqual(request.attachments.map((x) => x.blindedName), ["review-A.mp4", "review-B.mp4"]);
  for (const row of request.attachments) {
    assert.equal(path.basename(row.filePath), row.blindedName);
    assert.match(row.expectedSha256, /^[a-f0-9]{64}$/);
    assert.ok(row.expectedSize > 0);
  }
  assert.equal(
    createHash("sha256").update(request.prompt, "utf8").digest("hex"),
    pkg.promptDigest
  );
});
