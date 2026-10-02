import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MEDIA_LIVE_REVIEW_ARCHIVE_INDEX_VERSION,
  validateLiveReviewArtifactDirectory,
  stableStringify
} from "../src/index.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else out[key] = true;
  }
  return out;
}
function hashFile(filePath) {
  const bytes = readFileSync(filePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args["bundle-dir"]) throw new Error("--bundle-dir is required");
if (!args["archive-index"]) throw new Error("--archive-index is required");
if (!args.archive) throw new Error("--archive is required");

const bundleDir = path.resolve(args["bundle-dir"]);
const archiveIndexPath = path.resolve(args["archive-index"]);
const archivePath = path.resolve(args.archive);
const index = JSON.parse(readFileSync(archiveIndexPath, "utf8"));
if (index.contractVersion !== MEDIA_LIVE_REVIEW_ARCHIVE_INDEX_VERSION) {
  throw new Error("archive index contract mismatch");
}
if (
  index.modelReviewPerformed !== false ||
  index.liveModelReviewed !== false ||
  index.providerPublish !== false ||
  index.humanQuality !== false
) {
  throw new Error("archive index evidence boundary mismatch");
}

const archive = hashFile(archivePath);
if (archive.sha256 !== index.archive.sha256 || archive.size !== index.archive.size) {
  throw new Error("archive SHA-256/size mismatch");
}
const verified = validateLiveReviewArtifactDirectory(bundleDir, {
  expectedManifestSha256: index.bundle.packageManifestSha256
});
if (
  verified.manifest.payloadDigest !== index.bundle.payloadDigest ||
  verified.bundle.transportHandoff.packageDigest !== index.bundle.r21PackageDigest ||
  verified.bundle.sealedMapping.digest !== index.bundle.sealedMappingDigest ||
  verified.bundle.prompt.digest !== index.bundle.promptDigest ||
  verified.bridge.package.digest !== index.bundle.bridgePackageDigest
) {
  throw new Error("archive index package lineage mismatch");
}

console.log("R22_LIVE_REVIEW_VERIFIED", stableStringify({
  state: "LIVE_REVIEW_ARTIFACT_VERIFIED",
  archiveSha256: archive.sha256,
  archiveSize: archive.size,
  packageManifestSha256: verified.manifestIdentity.sha256,
  payloadDigest: verified.manifest.payloadDigest,
  bridgePackageDigest: verified.bridge.package.digest,
  verifiedFileCount: verified.verifiedFileCount,
  modelReviewPerformed: false,
  liveModelReviewed: false,
  humanQuality: false
}));
