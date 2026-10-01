import {
  R17_ACCEPTED_R16_UPSTREAM_AUTHORITY,
  stableStringify,
  validateAcceptedR16UpstreamAuthority
} from "../src/index.js";

const authority = validateAcceptedR16UpstreamAuthority(R17_ACCEPTED_R16_UPSTREAM_AUTHORITY);
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required to verify accepted R16 Actions provenance");

async function githubJson(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "foto6-video2-r17-provenance-verifier"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const run = await githubJson(`/repos/foto6/video2/actions/runs/${authority.ciRunId}`);
if (
  run.id !== authority.ciRunId ||
  run.head_sha !== authority.producerSha ||
  run.conclusion !== "success"
) {
  throw new Error(`accepted R16 run mismatch: ${stableStringify({
    id: run.id,
    head_sha: run.head_sha,
    conclusion: run.conclusion
  })}`);
}

const artifacts = await githubJson(
  `/repos/foto6/video2/actions/runs/${authority.ciRunId}/artifacts?per_page=100`
);
const artifact = (artifacts.artifacts ?? []).find((entry) => entry.id === authority.artifact.id);
if (!artifact) throw new Error(`accepted R16 artifact id ${authority.artifact.id} not found in run`);
if (
  artifact.name !== authority.artifact.name ||
  artifact.digest !== authority.artifact.archiveDigest ||
  artifact.expired === true
) {
  throw new Error(`accepted R16 artifact metadata mismatch: ${stableStringify({
    id: artifact.id,
    name: artifact.name,
    digest: artifact.digest ?? null,
    expired: artifact.expired
  })}`);
}

console.log("R17_UPSTREAM_AUTHORITY", stableStringify({
  repository: authority.repository,
  producerSha: authority.producerSha,
  ciRunId: authority.ciRunId,
  artifactId: artifact.id,
  artifactName: artifact.name,
  archiveDigest: artifact.digest,
  runConclusion: run.conclusion
}));
