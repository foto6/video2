import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_MULTICANDIDATE_ROUND_VERSION,
  candidateManifestDigest,
  fingerprint,
  readDeterministicTar,
  stableStringify,
  validateMulticandidateRoundAuthority,
  validateTournamentBracket,
  validateTournamentCandidateManifest
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else out[key] = true;
  }
  return out;
}
function hashFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`R25 verifier missing file: ${filePath}`);
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
function listFiles(root) {
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  walk(root);
  return out;
}
function verifyArchive(payloadRoot, archivePath) {
  const parsed = readDeterministicTar(archivePath);
  const files = listFiles(payloadRoot);
  if (parsed.entries.size !== files.length) {
    throw new Error(`R25 archive entry count mismatch for ${archivePath}`);
  }
  for (const name of files) {
    const expected = readFileSync(path.join(payloadRoot, name));
    const actual = parsed.entries.get(name);
    if (!actual || !actual.equals(expected)) {
      throw new Error(`R25 archive entry mismatch: ${name}`);
    }
  }
  return {
    sha256: parsed.sha256,
    size: parsed.size,
    entries: parsed.entries.size
  };
}
function gitBlob(pathName) {
  return execFileSync("git", ["hash-object", pathName], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  }).trim();
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? path.join(repoRoot, ".artifacts", "r25-demo"));
const initialRoot = path.join(root, "initial");
const batchRoot = path.join(initialRoot, "render-batch");

const firstEvidence = readJson(path.join(initialRoot, "media.edit_tournament.r25.evidence.json"));
if (firstEvidence.candidateCount !== 4 || firstEvidence.candidates.length !== 4) {
  throw new Error("R25 verifier requires exact four-candidate materialization");
}
if (firstEvidence.state !== "TOURNAMENT_ROUND_READY") {
  throw new Error("R25 initial state mismatch");
}
const candidateRenderSet = new Set();
const operationGraphSet = new Set();
const candidateEvidence = [];
for (const candidate of firstEvidence.candidates) {
  const dir = path.join(batchRoot, "candidates", candidate.candidateId);
  const manifestPath = path.join(dir, "media.tournament_candidate_manifest.r25.v1.json");
  const manifest = validateTournamentCandidateManifest(readJson(manifestPath));
  const final = hashFile(path.join(dir, "final.mp4"));
  const renderExport = hashFile(path.join(dir, "media.render_export.v1.json"));
  const caption = hashFile(path.join(dir, "captions.srt"));
  if (
    final.sha256 !== manifest.render.sha256 ||
    final.size !== manifest.render.size ||
    renderExport.sha256 !== manifest.renderExport.fileSha256 ||
    caption.sha256 !== manifest.captionSidecar.sha256 ||
    caption.size !== manifest.captionSidecar.size ||
    manifest.technicalGate.passed !== true
  ) throw new Error(`R25 candidate file/manifest mismatch: ${candidate.candidateId}`);
  if (candidate.manifestDigest !== candidateManifestDigest(manifest)) {
    throw new Error(`R25 candidate manifest digest mismatch: ${candidate.candidateId}`);
  }
  candidateRenderSet.add(final.sha256);
  operationGraphSet.add(fingerprint(manifest.operationGraph.operations));
  candidateEvidence.push({
    candidateId: candidate.candidateId,
    renderSha256: final.sha256,
    renderSize: final.size,
    manifestDigest: candidate.manifestDigest,
    operationGraphDigest: manifest.operationGraphDigest,
    technicalGatePassed: true,
    avSyncDeltaMs: manifest.ffprobe.avSyncDeltaMs
  });
}
if (candidateRenderSet.size !== 4) throw new Error("R25 verifier found duplicate candidate MP4 bytes");
if (operationGraphSet.size !== 4) throw new Error("R25 verifier found non-structural candidate diversity");

const bracketPath = path.join(initialRoot, "media.review_tournament_bracket.r25.v1.json");
const bracket = validateTournamentBracket(readJson(bracketPath));
if (bracket.candidateCount !== 4) throw new Error("R25 verifier bracket candidate count mismatch");
if (bracket.matches.filter((m) => m.stage === "semifinal").length !== 2) {
  throw new Error("R25 verifier requires two deterministic semifinals");
}
if (bracket.matches.filter((m) => m.stage === "final").length !== 1) {
  throw new Error("R25 verifier requires one deterministic final slot");
}
if (fingerprint(bracket) !== firstEvidence.bracket.digest) {
  throw new Error("R25 bracket digest mismatch");
}
for (const pkg of firstEvidence.bracket.reviewPackages) {
  const dir = path.join(initialRoot, "review-bracket", pkg.matchId);
  for (const attachment of pkg.attachments) {
    const candidatePath = path.join(dir, attachment.fileName ?? attachment.genericFileName ?? attachment.relativePath ?? "");
    if (!existsSync(candidatePath)) {
      const fallback = path.join(dir, attachment.blindLabel === "A" ? "review-A.mp4" : "review-B.mp4");
      if (!existsSync(fallback)) throw new Error(`R25 review attachment missing: ${pkg.matchId}/${attachment.blindLabel}`);
    }
  }
}

let checkpointReplay;
const phasedCheckpointPath = path.join(initialRoot, "phased-checkpoints.json");
if (existsSync(phasedCheckpointPath)) {
  const phased = readJson(phasedCheckpointPath);
  if (
    phased.contractVersion !== "media.r25.rehearsal_checkpoints.v1" ||
    !Array.isArray(phased.phases) ||
    phased.phases.length !== 2 ||
    !Array.isArray(phased.completedCandidates) ||
    phased.completedCandidates.length !== 4 ||
    phased.exactReplayProjection?.cacheHits !== 4 ||
    phased.exactReplayProjection?.renderCalls !== 0 ||
    phased.exactReplayProjection?.duplicateWorkAuthorized !== false
  ) throw new Error("R25 phased checkpoint summary mismatch");
  const seen = new Set();
  const completedHashes = [];
  for (const phase of phased.phases) {
    if (!["pair-1", "pair-2"].includes(phase.phase) || !Array.isArray(phase.candidates) || phase.candidates.length !== 2) {
      throw new Error("R25 phased checkpoint shape mismatch");
    }
    for (const entry of phase.candidates) {
      if (seen.has(entry.candidateId)) throw new Error("R25 phased checkpoint duplicate candidate");
      seen.add(entry.candidateId);
      const manifest = candidateEvidence.find((x) => x.candidateId === entry.candidateId);
      if (
        !manifest ||
        manifest.renderSha256 !== entry.renderSha256 ||
        manifest.renderSize !== entry.renderSize ||
        manifest.manifestDigest !== entry.manifestDigest
      ) throw new Error(`R25 phased checkpoint candidate mismatch: ${entry.candidateId}`);
      completedHashes.push({
        candidateId: entry.candidateId,
        renderSha256: entry.renderSha256,
        renderSize: entry.renderSize
      });
    }
  }
  checkpointReplay = {
    method: "phased-r16-checkpoint-and-output-validation",
    completedCandidates: completedHashes,
    cacheHitsOnExactReplay: 4,
    renderCallsOnExactReplay: 0,
    duplicateWorkAuthorized: false
  };
} else {
  const state = readJson(path.join(batchRoot, "candidate-batch-state.json"));
  const cache = readJson(path.join(initialRoot, "candidate-cache.json"));
  const orderedState = Object.values(state.candidates ?? {}).sort((a, b) => a.order - b.order);
  if (orderedState.length !== 4) throw new Error("R25 checkpoint candidate count mismatch");
  const completedHashes = [];
  for (const entry of orderedState) {
    if (entry.status !== "succeeded") throw new Error(`R25 checkpoint not terminal: ${entry.candidateId}`);
    const cached = cache.entries?.[entry.cacheIdentityDigest];
    if (!cached) throw new Error(`R25 checkpoint cache missing: ${entry.candidateId}`);
    if (
      cached.final?.sha256 !== entry.result?.final?.sha256 ||
      cached.final?.size !== entry.result?.final?.size
    ) throw new Error(`R25 checkpoint result/cache mismatch: ${entry.candidateId}`);
    completedHashes.push({
      candidateId: entry.candidateId,
      cacheIdentityDigest: entry.cacheIdentityDigest,
      renderSha256: entry.result.final.sha256,
      renderSize: entry.result.final.size
    });
  }
  checkpointReplay = {
    method: "persistent-r16-state-cache-and-output-validation",
    completedCandidates: completedHashes,
    cacheHitsOnExactReplay: 4,
    renderCallsOnExactReplay: 0,
    duplicateWorkAuthorized: false
  };
}

const initialArchive = verifyArchive(
  path.join(initialRoot, "payload"),
  path.join(initialRoot, "media-r25-tournament.tar")
);
if (
  initialArchive.sha256 !== firstEvidence.archive.sha256 ||
  initialArchive.size !== firstEvidence.archive.size
) throw new Error("R25 initial deterministic archive identity mismatch");

const targetedRoot = path.join(root, "targeted-reedit");
const targeted = readJson(path.join(targetedRoot, "media.tournament_targeted_reedit.r25.v1.json"));
if (
  targeted.parentRound !== 0 ||
  targeted.childRound !== 1 ||
  targeted.humanQuality !== false ||
  targeted.modelReviewPerformed !== false ||
  targeted.providerPublish !== false
) throw new Error("R25 targeted re-edit evidence boundary/round mismatch");
if (targeted.unaffectedRegionEvidence?.method !== "normalized-source-window-lineage-outside-declared-edit-intervals") {
  throw new Error("R25 targeted unaffected-region evidence method mismatch");
}

const challengerRoot = path.join(targetedRoot, "r19");
const challengerManifest = validateTournamentCandidateManifest(
  readJson(path.join(challengerRoot, "media.tournament_candidate_manifest.r25.v1.json"))
);
const challengerFinal = hashFile(path.join(challengerRoot, "final.mp4"));
if (
  challengerManifest.roundNumber !== 1 ||
  challengerFinal.sha256 !== challengerManifest.render.sha256 ||
  challengerFinal.size !== challengerManifest.render.size ||
  candidateRenderSet.has(challengerFinal.sha256)
) throw new Error("R25 targeted challenger lineage/distinctness mismatch");

const targetedReviewEvidence = readJson(
  path.join(targetedRoot, "review-package", "media.review_round_bundle.r21.evidence.json")
);
if (
  targetedReviewEvidence.reviewRound !== 1 ||
  targetedReviewEvidence.mode !== "targeted_reedit"
) throw new Error("R25 targeted review package round/mode mismatch");

const outerArchive = verifyArchive(
  path.join(root, "rehearsal-payload"),
  path.join(root, "media-r25-rehearsal.tar")
);
const summary = readJson(path.join(root, "r25-readiness-evidence.json"));
if (
  summary.outerArchive.sha256 !== outerArchive.sha256 ||
  summary.outerArchive.size !== outerArchive.size ||
  summary.initialRound.candidateCount !== 4 ||
  summary.actualEncodedMp4 !== true ||
  summary.modelReviewPerformed !== false ||
  summary.providerPublish !== false ||
  summary.humanQuality !== false
) throw new Error("R25 readiness summary mismatch");

const umbrella = validateMulticandidateRoundAuthority(
  readJson(path.join(root, "media.multicandidate_round.r25.v1.json"))
);
if (umbrella.contractVersion !== MEDIA_MULTICANDIDATE_ROUND_VERSION) {
  throw new Error("R25 external umbrella contract mismatch");
}
for (const [name, relativePath] of Object.entries({
  tournamentImplementation: "src/tournament-r25.js",
  umbrellaImplementation: "src/multicandidate-round-r25.js",
  runner: "tools/run-r25-tournament.mjs",
  phaseMaterializer: "tools/materialize-r25-ci-phase.mjs",
  rehearsal: "tools/demo-r25-tournament.mjs",
  verifier: "tools/verify-r25-rehearsal.mjs",
  externalContract: "conformance/media.multicandidate_round.r25.v1/contract.json",
  externalSchema: "conformance/media.multicandidate_round.r25.v1/schema.json"
})) {
  if (umbrella.implementationBlobs[name] !== gitBlob(relativePath)) {
    throw new Error(`R25 umbrella implementation blob mismatch: ${name}`);
  }
}
if (
  umbrella.internalContracts.request !== "media.edit_tournament_request.r25.v1" ||
  umbrella.acceptedR24Authority.artifactId !== 11301055747
) throw new Error("R25 umbrella internal/R24 mapping mismatch");

const evidence = {
  verificationVersion: "media.multicandidate_round.r25.verification.v1",
  contractVersion: MEDIA_MULTICANDIDATE_ROUND_VERSION,
  producerSha: umbrella.producer.sha,
  candidateCount: 4,
  candidates: candidateEvidence,
  bracketDigest: firstEvidence.bracket.digest,
  reviewPackageDigests: firstEvidence.bracket.reviewPackages.map((pkg) => ({
    matchId: pkg.matchId,
    packageDigest: pkg.packageDigest,
    sealedMappingDigest: pkg.sealedMappingDigest,
    promptDigest: pkg.promptDigest
  })),
  targetedReedit: {
    challengerRenderSha256: challengerFinal.sha256,
    growthHandoffDigest: targeted.growthHandoffDigest,
    directiveDigest: targeted.directiveDigest,
    mediaApplicationDigest: targeted.mediaApplicationDigest,
    reviewPackageDigest: targetedReviewEvidence.packageDigest
  },
  checkpointReplay,
  initialArchive,
  outerArchive,
  umbrellaDigest: fingerprint(umbrella),
  modelReviewPerformed: false,
  providerPublish: false,
  humanQuality: false
};
const outputPath = path.resolve(args.output ?? path.join(root, "r25-verification-evidence.json"));
writeFileSync(outputPath, stableStringify(evidence) + "\n");
console.log("R25_VERIFY", stableStringify(evidence));
