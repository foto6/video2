import path from "node:path";
import {
  stableStringify,
  verifyMaterializedLiveReviewArtifact
} from "../src/index.js";

function arg(flag){const i=process.argv.indexOf(flag);return i>=0&&process.argv[i+1]?process.argv[i+1]:"";}
const operatorDir=arg("--operator-dir");
if(!operatorDir)throw new Error("--operator-dir is required");
const result=verifyMaterializedLiveReviewArtifact(path.resolve(operatorDir));
console.log("R22_VERIFY",stableStringify(result));
if(!result.ok)process.exitCode=2;
