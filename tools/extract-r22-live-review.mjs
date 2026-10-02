import path from "node:path";
import {
  extractAndVerifyLiveReviewArchive,
  stableStringify
} from "../src/index.js";

function arg(flag){const i=process.argv.indexOf(flag);return i>=0&&process.argv[i+1]?process.argv[i+1]:"";}
const operatorDir=arg("--operator-dir");
const outDir=arg("--out-dir");
if(!operatorDir||!outDir)throw new Error("--operator-dir and --out-dir are required");
const result=extractAndVerifyLiveReviewArchive({
  operatorDir:path.resolve(operatorDir),
  destinationDir:path.resolve(outDir)
});
console.log("R22_EXTRACT_VERIFY",stableStringify(result));
