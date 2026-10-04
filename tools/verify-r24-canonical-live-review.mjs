import path from "node:path";
import { verifyCanonicalLiveReviewExport, stableStringify } from "../src/index.js";

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

const args = parseArgs(process.argv.slice(2));
if (!args["export-dir"]) throw new Error("--export-dir is required");
const result = verifyCanonicalLiveReviewExport(path.resolve(args["export-dir"]));
console.log("R24_CANONICAL_VERIFY", stableStringify(result));
if (!result.ok) process.exitCode = 1;
