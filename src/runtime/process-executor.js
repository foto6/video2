import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { runtimeError } from "./errors.js";

function createCapture(limit) {
  let buffer = Buffer.alloc(0);
  let truncated = false;
  return {
    append(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length >= limit) {
        truncated = true;
        return;
      }
      const remaining = limit - buffer.length;
      if (data.length > remaining) truncated = true;
      buffer = Buffer.concat([buffer, data.subarray(0, remaining)]);
    },
    value() {
      return { text: buffer.toString("utf8"), truncated };
    }
  };
}

export class DeterministicProcessExecutor {
  constructor({ spawnImpl = spawn, defaultTimeoutMs = 120000, maxOutputBytes = 64 * 1024 } = {}) {
    this.spawnImpl = spawnImpl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  run(command, { signal = null, timeoutMs = this.defaultTimeoutMs } = {}) {
    if (!command?.binary || !Array.isArray(command.args)) throw new TypeError("command requires binary and args");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");

    return new Promise((resolve, reject) => {
      const started = performance.now();
      const stdout = createCapture(this.maxOutputBytes);
      const stderr = createCapture(this.maxOutputBytes);
      let child;
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      try {
        child = this.spawnImpl(command.binary, command.args, {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        reject(runtimeError("spawn_failed", error.message));
        return;
      }

      child.stdout?.on?.("data", (chunk) => stdout.append(chunk));
      child.stderr?.on?.("data", (chunk) => stderr.append(chunk));

      const terminate = (kind) => {
        if (settled) return;
        if (kind === "timeout") timedOut = true;
        if (kind === "cancel") cancelled = true;
        child.kill?.("SIGTERM");
      };

      const timer = setTimeout(() => terminate("timeout"), timeoutMs);
      const onAbort = () => terminate("cancel");
      signal?.addEventListener?.("abort", onAbort, { once: true });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        reject(runtimeError("spawn_failed", error.message));
      });

      child.on("close", (code, closeSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        const out = stdout.value();
        const err = stderr.value();
        resolve({
          ok: code === 0 && !timedOut && !cancelled,
          code,
          signal: closeSignal,
          timedOut,
          cancelled,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          durationMs: Math.max(0, Math.round(performance.now() - started))
        });
      });
    });
  }
}
