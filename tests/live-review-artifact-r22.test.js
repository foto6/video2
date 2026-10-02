import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LIVE_REVIEW_ARTIFACT_READY,
  MEDIA_BRIDGE_DYNAMIC_HANDOFF_VERSION,
  MEDIA_LIVE_REVIEW_ARCHIVE_INDEX_VERSION,
  MEDIA_LIVE_REVIEW_ARTIFACT_VERSION,
  MEDIA_LIVE_REVIEW_AUTHORITY_PROFILE_VERSION,
  MEDIA_LIVE_REVIEW_PACKAGE_MANIFEST_VERSION,
  R22_BRIDGE_R31_AUTHORITY,
  R22_R21_AUTHORITY,
  buildDeterministicTar,
  buildLiveReviewArtifact,
  computeBridgeDynamicPackageDigest
} from "../src/index.js";

const REQUIRED = [
  "review-A.mp4",
  "review-B.mp4",
  "model-review-prompt.txt",
  "media.review_round_bundle.r21.v1.json",
  "media.review_round_transport_handoff.r21.v1.json",
  "media.review_round_sealed_mapping.r21.v1.json",
  "media.live_review_authority_profile.r22.v1.json",
  "media.dynamic_review_handoff.v1.json",
  "media.live_review_package_manifest.r22.v1.json"
];

function fakeBundleDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r22-tar-"));
  for (const [index, name] of REQUIRED.entries()) {
    writeFileSync(path.join(root, name), Buffer.from(`r22-${index}-${name}`, "utf8"));
  }
  return root;
}

function fakeBridgeHandoff() {
  return {
    contract: MEDIA_BRIDGE_DYNAMIC_HANDOFF_VERSION,
    producer: {
      repository: "foto6/video2",
      sha: "a".repeat(40),
      round: "R21",
      contract: {
        name: "media.review_round_bundle.r21.v1",
        schemaVersion: "v1",
        blob: {
          relativePath: "media.review_round_bundle.r21.v1.json",
          sha256: "1".repeat(64)
        }
      }
    },
    package: {
      digestAlgorithm: "bridge.dynamic_review_package.sha256.v1",
      digest: ""
    },
    prompt: {
      relativePath: "model-review-prompt.txt",
      fileSha256: "2".repeat(64),
      textSha256: "3".repeat(64),
      format: "utf8_text"
    },
    attachments: [
      {
        blindLabel: "B",
        blindedName: "review-B.mp4",
        relativePath: "review-B.mp4",
        size: 12,
        sha256: "5".repeat(64),
        mime: "video/mp4"
      },
      {
        blindLabel: "A",
        blindedName: "review-A.mp4",
        relativePath: "review-A.mp4",
        size: 11,
        sha256: "4".repeat(64),
        mime: "video/mp4"
      }
    ],
    sealedMapping: {
      digest: "6".repeat(64),
      contract: "media.review_round_sealed_mapping.r21.v1"
    },
    sourceLineage: {
      source: {
        sourceId: "source",
        sha256: "7".repeat(64),
        size: 100
      },
      briefLineageDigest: "8".repeat(64),
      mode: "targeted_reedit",
      reviewRound: 1
    }
  };
}

test("R22 constants pin exact R21 and current Bridge R31/R30 authority", () => {
  assert.equal(MEDIA_LIVE_REVIEW_ARTIFACT_VERSION, "media.live_review_artifact.r22.v1");
  assert.equal(MEDIA_LIVE_REVIEW_AUTHORITY_PROFILE_VERSION, "media.live_review_authority_profile.r22.v1");
  assert.equal(MEDIA_LIVE_REVIEW_PACKAGE_MANIFEST_VERSION, "media.live_review_package_manifest.r22.v1");
  assert.equal(MEDIA_LIVE_REVIEW_ARCHIVE_INDEX_VERSION, "media.live_review_archive_index.r22.v1");
  assert.equal(LIVE_REVIEW_ARTIFACT_READY, "LIVE_REVIEW_ARTIFACT_READY");
  assert.equal(R22_R21_AUTHORITY.producerSha, "d753e9e4c1f4448386608a1425232dbc1dba87ea");
  assert.equal(R22_R21_AUTHORITY.ciRunId, 36994000619);
  assert.equal(R22_BRIDGE_R31_AUTHORITY.branchHeadSha, "ceaee873231a8552c5b7324083baa800eec566a8");
  assert.equal(R22_BRIDGE_R31_AUTHORITY.inheritedGreenCiRunId, 36993885456);
  assert.equal(R22_BRIDGE_R31_AUTHORITY.r31WireFormatDivergedFromR30, false);
});

test("R22 deterministic USTAR is byte-identical for identical bundle files", () => {
  const left = fakeBundleDir();
  const right = fakeBundleDir();
  const leftTar = path.join(mkdtempSync(path.join(os.tmpdir(), "r22-left-")), "bundle.tar");
  const rightTar = path.join(mkdtempSync(path.join(os.tmpdir(), "r22-right-")), "bundle.tar");
  const a = buildDeterministicTar(left, leftTar);
  const b = buildDeterministicTar(right, rightTar);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.size, b.size);
  assert.equal(a.fileCount, 9);
});

test("R22 deterministic archive digest changes when one payload byte changes", () => {
  const left = fakeBundleDir();
  const right = fakeBundleDir();
  writeFileSync(path.join(right, "review-B.mp4"), "changed-byte");
  const leftTar = path.join(mkdtempSync(path.join(os.tmpdir(), "r22-left2-")), "bundle.tar");
  const rightTar = path.join(mkdtempSync(path.join(os.tmpdir(), "r22-right2-")), "bundle.tar");
  assert.notEqual(
    buildDeterministicTar(left, leftTar).sha256,
    buildDeterministicTar(right, rightTar).sha256
  );
});

test("R22 deterministic archive rejects extra unmanifested files", () => {
  const root = fakeBundleDir();
  writeFileSync(path.join(root, "hidden-candidate-id.txt"), "secret");
  assert.throws(
    () => buildDeterministicTar(root, path.join(root, "..", "bad.tar")),
    /unexpected or missing files/
  );
});

test("R22 Bridge package digest is stable regardless attachment input order", () => {
  const a = fakeBridgeHandoff();
  const b = structuredClone(a);
  b.attachments.reverse();
  assert.equal(computeBridgeDynamicPackageDigest(a), computeBridgeDynamicPackageDigest(b));
});

test("R22 Bridge package digest binds source lineage and prompt identity", () => {
  const a = fakeBridgeHandoff();
  const sourceChanged = structuredClone(a);
  sourceChanged.sourceLineage.reviewRound = 2;
  assert.notEqual(
    computeBridgeDynamicPackageDigest(a),
    computeBridgeDynamicPackageDigest(sourceChanged)
  );
  const promptChanged = structuredClone(a);
  promptChanged.prompt.textSha256 = "9".repeat(64);
  assert.notEqual(
    computeBridgeDynamicPackageDigest(a),
    computeBridgeDynamicPackageDigest(promptChanged)
  );
});

test("R22 rejects output traversal before reading source bundle", () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "media-r22-sandbox-"));
  const outside = path.join(os.tmpdir(), "media-r22-outside-" + Date.now());
  mkdirSync(outside, { recursive: true });
  assert.throws(() => buildLiveReviewArtifact({
    sourceBundleRoot: path.join(sandbox, "missing"),
    sandboxRoot: sandbox,
    outputRoot: outside,
    producerSha: "a".repeat(40),
    ciRunId: 123,
    repoRoot: process.cwd()
  }), /escapes sandboxRoot/);
});
