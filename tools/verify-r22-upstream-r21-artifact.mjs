import {
  R22_R21_AUTHORITY,
  stableStringify
} from "../src/index.js";

const token=process.env.GITHUB_TOKEN;
if(!token)throw new Error("GITHUB_TOKEN is required to verify exact R21 Actions authority");

async function githubJson(path){
  const response=await fetch(`https://api.github.com${path}`,{
    headers:{
      Accept:"application/vnd.github+json",
      Authorization:`Bearer ${token}`,
      "X-GitHub-Api-Version":"2022-11-28",
      "User-Agent":"foto6-video2-r22-authority-verifier"
    }
  });
  if(!response.ok)throw new Error(`GitHub API ${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

const run=await githubJson(`/repos/foto6/video2/actions/runs/${R22_R21_AUTHORITY.ciRunId}`);
if(run.head_sha!==R22_R21_AUTHORITY.producerSha||run.conclusion!=="success"){
  throw new Error(`R21 CI authority mismatch: ${stableStringify({head_sha:run.head_sha,conclusion:run.conclusion})}`);
}
const artifacts=await githubJson(`/repos/foto6/video2/actions/runs/${R22_R21_AUTHORITY.ciRunId}/artifacts?per_page=100`);
const artifact=(artifacts.artifacts??[]).find((entry)=>entry.id===R22_R21_AUTHORITY.artifactId);
if(!artifact)throw new Error("accepted R21 Actions artifact not found");
if(
  artifact.name!==R22_R21_AUTHORITY.artifactName||
  artifact.digest!==R22_R21_AUTHORITY.artifactDigest||
  artifact.expired===true
){
  throw new Error(`R21 artifact authority mismatch: ${stableStringify({
    id:artifact.id,name:artifact.name,digest:artifact.digest,expired:artifact.expired
  })}`);
}
console.log("R22_UPSTREAM_R21",stableStringify({
  producerSha:R22_R21_AUTHORITY.producerSha,
  ciRunId:R22_R21_AUTHORITY.ciRunId,
  artifactId:artifact.id,
  artifactName:artifact.name,
  artifactDigest:artifact.digest,
  ciConclusion:run.conclusion
}));
