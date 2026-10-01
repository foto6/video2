import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(repoRoot, ".artifacts", "r13-compat", "compatibility-bundle.json");
const envelopePath = path.join(repoRoot, ".artifacts", "r13-compat", "demo-consumer-envelope.json");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function runOnce() {
  execFileSync(process.execPath, ["tools/render-r12-demo.mjs"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit"
  });
  execFileSync(process.execPath, ["tools/render-r13-compat.mjs"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit"
  });
  return {
    bundle: readFileSync(bundlePath, "utf8"),
    envelope: readFileSync(envelopePath, "utf8")
  };
}

const first = runOnce();
const second = runOnce();
if (first.bundle !== second.bundle) throw new Error("R13 compatibility bundle is not byte-deterministic");
if (first.envelope !== second.envelope) throw new Error("R13 demo consumer envelope is not byte-deterministic");

console.log("R13_DETERMINISM", JSON.stringify({
  bundleSha256: sha256(first.bundle),
  envelopeSha256: sha256(first.envelope),
  repeatCount: 2,
  byteIdentical: true
}));
