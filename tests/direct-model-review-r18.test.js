import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MEDIA_DIRECT_MODEL_REVIEW_PACKAGE_VERSION,
  MEDIA_DIRECT_MODEL_REVIEW_PROMPT_VERSION,
  R18_ACCEPTED_R17_AUTHORITY,
  WEB_CHAT_REVIEW_MAX_FILE_BYTES,
  buildDirectModelReviewPackage,
  buildDirectModelReviewPromptManifest,
  directModelReviewPackageDigest,
  validateDirectModelReviewPackage,
  validateDirectModelReviewPromptManifest,
  validateR18AcceptedR17Bundle
} from "../src/index.js";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const acceptedRoot = path.resolve(
  process.env.R18_UPSTREAM_ROOT ?? path.join(repoRoot, ".artifacts", "r17-accepted")
);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function loadAcceptedBundle(root = acceptedRoot) {
  const file = path.join(root, R18_ACCEPTED_R17_AUTHORITY.bundleFile.name);
  const bytes = readFileSync(file);
  return {
    bytes,
    sha256: sha256Bytes(bytes),
    bundle: JSON.parse(bytes)
  };
}
function tempCopy() {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-r18-"));
  cpSync(acceptedRoot, root, { recursive: true });
  return root;
}
function buildFrom(root) {
  const loaded = loadAcceptedBundle(root);
  const output = mkdtempSync(path.join(os.tmpdir(), "media-r18-out-"));
  const pkg = buildDirectModelReviewPackage({
    r17Bundle: loaded.bundle,
    r17Root: root,
    outputRoot: output,
    packageProducerSha: "1".repeat(40),
    r17BundleFileSha256: loaded.sha256
  });
  return { pkg, output };
}

test("R18 prompt is blinded and requests timestamped defects plus coverage uncertainty", () => {
  const prompt = buildDirectModelReviewPromptManifest({
    attachments: [
      { blindLabel: "A", genericFileName: "review-A.mp4" },
      { blindLabel: "B", genericFileName: "review-B.mp4" }
    ]
  });
  assert.equal(prompt.contractVersion, MEDIA_DIRECT_MODEL_REVIEW_PROMPT_VERSION);
  assert.match(prompt.promptText, /start_ms/);
  assert.match(prompt.promptText, /severity/);
  assert.match(prompt.promptText, /evidence/);
  assert.match(prompt.promptText, /proposed_edit/);
  assert.match(prompt.promptText, /uninspected_possible=true/);
  assert.match(prompt.promptText, /every_frame_inspected=false/);
  assert.doesNotMatch(JSON.stringify(prompt), /candidate-[0-9]+|foto6\/video2/);
  assert.doesNotThrow(() => validateDirectModelReviewPromptManifest(prompt));
});

test("R18 exact R17 artifact builds two distinct original-byte blinded attachments", {
  skip: !existsSync(acceptedRoot)
}, () => {
  const loaded = loadAcceptedBundle();
  assert.equal(loaded.sha256, R18_ACCEPTED_R17_AUTHORITY.bundleFile.sha256);
  const { pkg, output } = buildFrom(acceptedRoot);
  assert.equal(pkg.contractVersion, MEDIA_DIRECT_MODEL_REVIEW_PACKAGE_VERSION);
  assert.equal(pkg.attachments.length, 2);
  assert.deepEqual(pkg.attachments.map((x) => x.blindLabel), ["A", "B"]);
  assert.deepEqual(pkg.attachments.map((x) => x.genericFileName), ["review-A.mp4", "review-B.mp4"]);
  assert.notEqual(pkg.attachments[0].file.sha256, pkg.attachments[1].file.sha256);
  for (const entry of pkg.attachments) {
    assert.equal(entry.derivative, null);
    assert.equal(entry.file.sha256, entry.candidateBinding.renderSha256);
    assert.equal(entry.file.size, entry.candidateBinding.renderSize);
    assert.ok(entry.file.size <= WEB_CHAT_REVIEW_MAX_FILE_BYTES);
    const copied = readFileSync(path.join(output, entry.genericFileName));
    assert.equal(sha256Bytes(copied), entry.file.sha256);
  }
  assert.equal(pkg.modelReview.performed, false);
  assert.equal(pkg.modelReview.verdict, null);
  assert.equal(pkg.modelReview.liveUploadPerformed, false);
  assert.match(directModelReviewPackageDigest(pkg), /^[a-f0-9]{64}$/);
});

test("R18 missing attachment fails closed", { skip: !existsSync(acceptedRoot) }, () => {
  const root = tempCopy();
  unlinkSync(path.join(root, "attachments", "candidate-1", "final.mp4"));
  const loaded = loadAcceptedBundle(root);
  const output = mkdtempSync(path.join(os.tmpdir(), "media-r18-missing-"));
  assert.throws(() => buildDirectModelReviewPackage({
    r17Bundle: loaded.bundle,
    r17Root: root,
    outputRoot: output,
    packageProducerSha: "1".repeat(40),
    r17BundleFileSha256: loaded.sha256
  }), /file is missing/);
  rmSync(root, { recursive: true, force: true });
});

test("R18 changed attachment hash fails closed", { skip: !existsSync(acceptedRoot) }, () => {
  const root = tempCopy();
  const file = path.join(root, "attachments", "candidate-1", "final.mp4");
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("tamper")]));
  const loaded = loadAcceptedBundle(root);
  assert.throws(() => buildDirectModelReviewPackage({
    r17Bundle: loaded.bundle,
    r17Root: root,
    outputRoot: mkdtempSync(path.join(os.tmpdir(), "media-r18-hash-")),
    packageProducerSha: "1".repeat(40),
    r17BundleFileSha256: loaded.sha256
  }), /attachment bytes changed/);
  rmSync(root, { recursive: true, force: true });
});

test("R18 wrong source and stale render-export lineage fail closed", { skip: !existsSync(acceptedRoot) }, () => {
  const loaded = loadAcceptedBundle();
  const wrongSource = structuredClone(loaded.bundle);
  wrongSource.source.sha256 = "f".repeat(64);
  assert.throws(() => validateR18AcceptedR17Bundle(wrongSource), /source|upstream/i);

  const stale = structuredClone(loaded.bundle);
  stale.candidates[0].renderExport.digest = "e".repeat(64);
  assert.throws(() => validateR18AcceptedR17Bundle(stale), /render export|upstream|lineage/i);
});

test("R18 oversize, duplicate candidate and derivative provenance mismatch fail closed", {
  skip: !existsSync(acceptedRoot)
}, () => {
  const { pkg } = buildFrom(acceptedRoot);

  const oversizeAuthority = structuredClone(R18_ACCEPTED_R17_AUTHORITY);
  oversizeAuthority.selectedCandidates[0].finalSize = WEB_CHAT_REVIEW_MAX_FILE_BYTES + 1;
  const oversize = structuredClone(pkg);
  oversize.upstreamReviewAuthority = oversizeAuthority;
  oversize.attachments[0].candidateBinding.renderSize = WEB_CHAT_REVIEW_MAX_FILE_BYTES + 1;
  oversize.attachments[0].file.size = WEB_CHAT_REVIEW_MAX_FILE_BYTES + 1;
  assert.throws(() => validateDirectModelReviewPackage(oversize, { authority: oversizeAuthority }), /exceeds 500 MB/);

  const duplicateAuthority = structuredClone(R18_ACCEPTED_R17_AUTHORITY);
  duplicateAuthority.selectedCandidates[1].candidateId = duplicateAuthority.selectedCandidates[0].candidateId;
  const duplicate = structuredClone(pkg);
  duplicate.upstreamReviewAuthority = duplicateAuthority;
  duplicate.attachments[1].candidateBinding.candidateId = duplicate.attachments[0].candidateBinding.candidateId;
  assert.throws(() => validateDirectModelReviewPackage(duplicate, { authority: duplicateAuthority }), /duplicate candidate/);

  const derivative = structuredClone(pkg);
  derivative.attachments[0].derivative = {
    derivative_for_model_review: true,
    originalSha256: "0".repeat(64),
    originalSize: derivative.attachments[0].candidateBinding.renderSize,
    derivativeSha256: derivative.attachments[0].file.sha256,
    derivativeSize: derivative.attachments[0].file.size,
    settings: {
      transformVersion: "media.web_chat_review_derivative.v1",
      videoCodec: "libx264",
      audioCodec: "aac",
      width: 720,
      height: 1280,
      fps: 30,
      crf: 28,
      preset: "medium",
      audioBitrate: "128k",
      pixelFormat: "yuv420p",
      metadata: "stripped",
      threads: 1
    },
    settingsDigest: "0".repeat(64)
  };
  assert.throws(() => validateDirectModelReviewPackage(derivative), /settings digest mismatch|original SHA mismatch/);
});

test("R18 bundle file hash pin rejects regenerated/stale R17 manifest", { skip: !existsSync(acceptedRoot) }, () => {
  const loaded = loadAcceptedBundle();
  assert.throws(() => validateR18AcceptedR17Bundle(loaded.bundle, {
    bundleFileSha256: "9".repeat(64)
  }), /bundle file hash mismatch/);
});
