import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEDIA_CREATOR_CONSUMER_COMPAT_VERSION,
  buildCreatorConsumerEnvelope,
  evaluateCreativeQuality,
  fingerprint,
  stableStringify,
  validateCreatorConsumerEnvelope
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r12Root = path.join(repoRoot, ".artifacts", "r12-demo");
const outDir = path.join(repoRoot, ".artifacts", "r13-compat");
mkdirSync(outDir, { recursive: true });

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

const producerSha = git(["rev-parse", "HEAD"]);
if (!/^[a-f0-9]{40}$/.test(producerSha)) throw new Error("invalid git HEAD");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== producerSha) {
  throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} does not match checked-out HEAD ${producerSha}`);
}

const manifestPath = path.join(
  repoRoot,
  "conformance",
  "media.creator_consumer_compat.r13.v1",
  "manifest.json"
);
const compatibilityManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (compatibilityManifest.contractVersion !== MEDIA_CREATOR_CONSUMER_COMPAT_VERSION) {
  throw new Error("compatibility manifest contract version mismatch");
}

const contractDigests = {};
for (const [name, pin] of Object.entries(compatibilityManifest.pins)) {
  const actual = git(["hash-object", pin.path]);
  if (actual !== pin.gitBlobSha) {
    throw new Error(`pinned blob mismatch for ${name}: expected ${pin.gitBlobSha}, got ${actual}`);
  }
  contractDigests[name] = { path: pin.path, gitBlobSha: actual };
}
contractDigests.creatorCompatManifest = {
  path: "conformance/media.creator_consumer_compat.r13.v1/manifest.json",
  gitBlobSha: git(["hash-object", "conformance/media.creator_consumer_compat.r13.v1/manifest.json"])
};

const jobs = JSON.parse(readFileSync(path.join(r12Root, "jobs.json"), "utf8"));
const job = jobs.jobs?.["r12-after"];
if (!job) throw new Error("R12 demo job r12-after is missing; run npm run demo:r12 first");
if (!job.artifactManifest) throw new Error("R12 demo job is missing its final artifact manifest");

const creativeQualityReport = evaluateCreativeQuality(job.timeline, job.probe ?? {});
const envelope = buildCreatorConsumerEnvelope({
  job,
  artifactManifest: job.artifactManifest,
  creativeQualityReport,
  producerSha,
  contractDigests
});
validateCreatorConsumerEnvelope(envelope, {
  artifactManifest: job.artifactManifest,
  timeline: job.timeline,
  expectedProducerSha: producerSha,
  expectedContractDigests: contractDigests
});

const bundleCore = {
  contractVersion: MEDIA_CREATOR_CONSUMER_COMPAT_VERSION,
  producer: {
    repository: "foto6/video2",
    sha: producerSha
  },
  compatibilityManifest: {
    path: "conformance/media.creator_consumer_compat.r13.v1/manifest.json",
    gitBlobSha: contractDigests.creatorCompatManifest.gitBlobSha
  },
  contractDigests,
  demoConsumerEnvelope: envelope
};
const bundle = {
  ...bundleCore,
  bundleDigest: fingerprint(bundleCore)
};

writeFileSync(path.join(outDir, "demo-consumer-envelope.json"), `${stableStringify(envelope)}\n`);
writeFileSync(path.join(outDir, "compatibility-bundle.json"), `${stableStringify(bundle)}\n`);

console.log("R13_COMPATIBILITY_BUNDLE", stableStringify({
  producerSha,
  compatibilityManifestGitBlobSha: contractDigests.creatorCompatManifest.gitBlobSha,
  bundleDigest: bundle.bundleDigest,
  logicalJobId: envelope.logicalJobId,
  renderFingerprint: envelope.renderFingerprint,
  creativePlanDigest: envelope.creativePlanDigest,
  finalContent: envelope.finalContent,
  artifactManifestDigest: envelope.artifactManifestDigest,
  timelineDigest: envelope.timelineDigest,
  technicalQaPassed: envelope.technicalQa.passed,
  creativeQualityPassed: envelope.creativeQuality.passed,
  pinnedBlobCount: Object.keys(contractDigests).length
}));
