import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprint, stableStringify } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r20EvidencePath = path.join(repoRoot, ".artifacts", "r20-demo", "r20-readiness-evidence.json");
const root = path.join(repoRoot, ".artifacts", "r21-demo");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

function run(binary, args) {
  return execFileSync(binary, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
}
function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}
function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${stableStringify(value)}\n`);
}
function descriptor(entry) {
  return {
    candidateId: entry.candidateId,
    roundNumber: entry.roundNumber,
    source: {
      sourceId: entry.source.sourceId,
      sha256: entry.source.sha256,
      size: entry.source.size,
      path: entry.source.artifactPath
    },
    render: {
      path: entry.render.artifactPath,
      sha256: entry.render.sha256,
      size: entry.render.size
    },
    renderExport: {
      path: entry.renderExport.artifactPath,
      fileSha256: entry.renderExport.fileSha256,
      digest: entry.renderExport.digest
    },
    renderProducerSha: entry.renderProducerSha,
    editorialApplication: entry.editorialApplication === null
      ? null
      : {
          path: entry.editorialApplication.artifactPath,
          fileSha256: entry.editorialApplication.fileSha256,
          digest: entry.editorialApplication.digest
        },
    reviewDerivative: null
  };
}

if (!existsSync(r20EvidencePath)) {
  run(process.execPath, [path.join(repoRoot, "tools", "demo-r20-dynamic-review.mjs")]);
}
const r20 = JSON.parse(readFileSync(r20EvidencePath, "utf8"));
if (r20.state !== "DYNAMIC_REVIEW_PACKAGE_READY" || r20.liveModelReviewed !== false) {
  throw new Error("R20 prerequisite evidence state mismatch");
}
const producerSha = run("git", ["rev-parse", "HEAD"]).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} != HEAD ${producerSha}`);
}

const briefLineageDigest = fingerprint({
  contractVersion: "media.r21_demo_brief_lineage.v1",
  source: r20.source,
  editorialGoal: "talking-head vertical short-form round-pair review rehearsal"
});

function participantFromEntry(entry) {
  return {
    candidate: descriptor(entry),
    briefLineageDigest
  };
}

const initialEntries = r20.initialReview.sealedMapping.entries;
if (!Array.isArray(initialEntries) || initialEntries.length !== 2) {
  throw new Error("R20 initial review sealed mapping missing");
}
const targetedEntries = r20.targetedReeditReview.sealedMapping.entries;
if (!Array.isArray(targetedEntries) || targetedEntries.length !== 2) {
  throw new Error("R20 targeted review sealed mapping missing");
}
const baselineEntry = targetedEntries.find((entry) => entry.roundNumber === 0);
const challengerEntry = targetedEntries.find((entry) => entry.roundNumber === 1);
if (!baselineEntry || !challengerEntry?.editorialApplication) {
  throw new Error("R20 targeted R19 parent/child lineage missing");
}

const initialRequest = {
  contractVersion: "media.review_round_request.r21.v1",
  review: {
    mode: "initial",
    left: participantFromEntry(initialEntries[0]),
    right: participantFromEntry(initialEntries[1])
  }
};

const decisionEvidenceDigest = fingerprint({
  evidenceType: "fixture_rehearsal",
  selectedCandidateId: baselineEntry.candidateId,
  selectedRenderSha256: baselineEntry.render.sha256,
  note: "Lineage rehearsal only; no model verdict or human-quality selection is claimed."
});
const targetedRequest = {
  contractVersion: "media.review_round_request.r21.v1",
  review: {
    mode: "targeted_reedit",
    baseline: participantFromEntry(baselineEntry),
    challenger: participantFromEntry(challengerEntry),
    priorReview: {
      contractVersion: "media.prior_review_selection.r21.v1",
      selectedCandidateId: baselineEntry.candidateId,
      reviewRound: 0,
      reviewPackageDigest: r20.initialReview.packageDigest,
      sealedMappingDigest: r20.initialReview.sealedMappingDigest,
      decisionEvidenceDigest,
      evidenceType: "fixture_rehearsal"
    }
  }
};

function build(name, request) {
  const outputRoot = path.join(root, name);
  const requestPath = path.join(root, `${name}-request.json`);
  writeJson(requestPath, request);
  const args = [
    path.join(repoRoot, "tools", "build-r21-review-round.mjs"),
    "--request", requestPath,
    "--sandbox-root", repoRoot,
    "--output-dir", outputRoot
  ];
  const first = run(process.execPath, args);
  const bundlePath = path.join(outputRoot, "media.review_round_bundle.r21.v1.json");
  const before = readFileSync(bundlePath, "utf8");
  const second = run(process.execPath, args);
  const after = readFileSync(bundlePath, "utf8");
  if (before !== after) throw new Error(`${name} R21 bundle changed on replay`);
  const bundle = JSON.parse(before);
  if (bundle.state !== "ROUND_PAIR_PACKAGE_READY") throw new Error("R21 state mismatch");
  if (
    bundle.modelReviewPerformed !== false ||
    bundle.liveModelReviewed !== false ||
    bundle.providerPublish !== false ||
    bundle.humanQuality !== false
  ) throw new Error("R21 evidence boundary mismatch");

  const mapping = new Map(bundle.sealedMapping.entries.map((entry) => [entry.blindLabel, entry]));
  for (const attachment of bundle.attachments) {
    const filePath = path.join(outputRoot, attachment.path);
    const actual = hashFile(filePath);
    if (actual.sha256 !== attachment.sha256 || actual.size !== attachment.size) {
      throw new Error(`${name} attachment bytes drifted`);
    }
    const sealed = mapping.get(attachment.blindLabel);
    if (!sealed) throw new Error(`${name} sealed mapping label missing`);
    if (!attachment.derivative_for_model_review && actual.sha256 !== sealed.render.sha256) {
      throw new Error(`${name} original review attachment does not equal render bytes`);
    }
  }

  const handoffPath = path.join(outputRoot, "media.review_round_transport_handoff.r21.v1.json");
  const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
  if (handoff.promptDigest !== bundle.prompt.digest ||
      handoff.sealedMappingDigest !== bundle.sealedMapping.digest) {
    throw new Error(`${name} transport handoff binding mismatch`);
  }

  return {
    bundle,
    bundleFile: hashFile(bundlePath),
    sealedFile: hashFile(path.join(outputRoot, "media.review_round_sealed_mapping.r21.v1.json")),
    handoff,
    handoffFile: hashFile(handoffPath),
    evidenceFile: hashFile(path.join(outputRoot, "media.review_round_bundle.r21.evidence.json")),
    replayStable: true,
    firstLogSha256: createHash("sha256").update(first).digest("hex"),
    secondLogSha256: createHash("sha256").update(second).digest("hex")
  };
}

const initial = build("initial", initialRequest);
if (initial.bundle.mode !== "initial" || initial.bundle.reviewRound !== 0 || initial.bundle.roundLineage !== null) {
  throw new Error("R21 initial semantics mismatch");
}

const targeted = build("round-1", targetedRequest);
if (targeted.bundle.mode !== "targeted_reedit" || targeted.bundle.reviewRound !== 1) {
  throw new Error("R21 targeted semantics mismatch");
}
const lineage = targeted.bundle.roundLineage;
if (
  lineage.parentCandidateId !== baselineEntry.candidateId ||
  lineage.parentRenderSha256 !== baselineEntry.render.sha256 ||
  lineage.childCandidateId !== challengerEntry.candidateId ||
  lineage.childRenderSha256 !== challengerEntry.render.sha256 ||
  lineage.growthHandoffDigest !== challengerEntry.editorialApplication.handoffDigest ||
  lineage.mediaApplicationDigest !== challengerEntry.editorialApplication.digest
) throw new Error("R21 exact R19 parent/child lineage mismatch");

const promptSerialized = JSON.stringify(targeted.bundle.prompt);
for (const secret of [
  baselineEntry.candidateId,
  challengerEntry.candidateId,
  "baseline",
  "challenger",
  challengerEntry.editorialApplication.handoffDigest,
  challengerEntry.editorialApplication.digest
]) {
  if (promptSerialized.toLowerCase().includes(secret.toLowerCase())) {
    throw new Error(`R21 model-facing prompt leaked: ${secret}`);
  }
}

const summary = {
  evidenceVersion: "media.review_round_bundle.r21.demo.v1",
  producer: { repository: "foto6/video2", sha: producerSha },
  state: "ROUND_PAIR_PACKAGE_READY",
  bridgeAuthority: targeted.bundle.bridgeAuthority,
  source: targeted.bundle.source,
  briefLineageDigest,
  initial: {
    packageDigest: initial.bundle.transportHandoff.packageDigest,
    bundleFileSha256: initial.bundleFile.sha256,
    sealedMappingDigest: initial.bundle.sealedMapping.digest,
    sealedMappingFileSha256: initial.sealedFile.sha256,
    roundLineageDigest: initial.bundle.transportHandoff.roundLineage.digest,
    promptDigest: initial.bundle.prompt.digest,
    handoffFileSha256: initial.handoffFile.sha256,
    evidenceFileSha256: initial.evidenceFile.sha256,
    attachments: initial.bundle.attachments,
    sealedMapping: initial.bundle.sealedMapping,
    replayStable: initial.replayStable
  },
  targetedRound1: {
    packageDigest: targeted.bundle.transportHandoff.packageDigest,
    bundleFileSha256: targeted.bundleFile.sha256,
    sealedMappingDigest: targeted.bundle.sealedMapping.digest,
    sealedMappingFileSha256: targeted.sealedFile.sha256,
    roundLineageDigest: targeted.bundle.transportHandoff.roundLineage.digest,
    promptDigest: targeted.bundle.prompt.digest,
    handoffFileSha256: targeted.handoffFile.sha256,
    evidenceFileSha256: targeted.evidenceFile.sha256,
    attachments: targeted.bundle.attachments,
    sealedMapping: targeted.bundle.sealedMapping,
    roundLineage: targeted.bundle.roundLineage,
    replayStable: targeted.replayStable
  },
  allAttachmentsOriginalBytes: [
    ...initial.bundle.attachments,
    ...targeted.bundle.attachments
  ].every((entry) => entry.derivative_for_model_review === false),
  fixturePriorSelectionOnly: true,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  providerPublish: false,
  humanQuality: false
};
writeJson(path.join(root, "r21-readiness-evidence.json"), summary);
console.log("R21_DEMO", stableStringify(summary));
