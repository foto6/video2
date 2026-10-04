import {
  R24_R23_AUTHORITY,
  stableStringify
} from "../src/index.js";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required to verify accepted R23 Actions authority");

async function githubJson(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "foto6-video2-r24-upstream-verifier"
    }
  });
  if (!response.ok) throw new Error(`GitHub API ${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

const run = await githubJson(`/repos/foto6/video2/actions/runs/${R24_R23_AUTHORITY.ciRunId}`);
if (
  run.id !== R24_R23_AUTHORITY.ciRunId ||
  run.head_sha !== R24_R23_AUTHORITY.producerSha ||
  run.conclusion !== "success"
) {
  throw new Error(`accepted R23 run mismatch: ${stableStringify({
    id: run.id,
    head_sha: run.head_sha,
    conclusion: run.conclusion
  })}`);
}

const artifacts = await githubJson(
  `/repos/foto6/video2/actions/runs/${R24_R23_AUTHORITY.ciRunId}/artifacts?per_page=100`
);
const artifact = (artifacts.artifacts ?? []).find((entry) => entry.id === R24_R23_AUTHORITY.artifactId);
if (!artifact) throw new Error(`accepted R23 artifact id ${R24_R23_AUTHORITY.artifactId} not found`);
if (
  artifact.name !== R24_R23_AUTHORITY.artifactName ||
  artifact.digest !== R24_R23_AUTHORITY.artifactDigest ||
  artifact.expired === true
) {
  throw new Error(`accepted R23 artifact mismatch: ${stableStringify({
    id: artifact.id,
    name: artifact.name,
    digest: artifact.digest ?? null,
    expired: artifact.expired
  })}`);
}
console.log("R24_UPSTREAM_R23", stableStringify({
  producerSha: R24_R23_AUTHORITY.producerSha,
  ciRunId: R24_R23_AUTHORITY.ciRunId,
  artifactId: artifact.id,
  artifactName: artifact.name,
  artifactDigest: artifact.digest,
  conclusion: run.conclusion
}));
