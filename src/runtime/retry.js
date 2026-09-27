import { RenderRuntimeError } from "./errors.js";

export function classifyRuntimeFailure(error) {
  if (error?.code === "cancelled" || error?.name === "AbortError") {
    return { code: "cancelled", retryable: false, category: "cancelled" };
  }

  const code = error instanceof RenderRuntimeError ? error.code : error?.code;
  if (["path_invalid", "path_protected", "path_outside_sandbox", "path_remote_not_allowed", "invalid_request", "state_corrupt"].includes(code)) {
    return { code: code ?? "invalid_request", retryable: false, category: "policy" };
  }
  if (code === "qa_failed") return { code, retryable: false, category: "qa" };
  if (code === "probe_failed") return { code, retryable: true, category: "probe" };
  if (code === "process_timeout") return { code, retryable: true, category: "process" };
  if (code === "process_failed" || code === "spawn_failed") return { code: code ?? "process_failed", retryable: true, category: "process" };
  if (code === "finalize_failed") return { code, retryable: true, category: "output" };
  return { code: code ?? "runtime_failed", retryable: false, category: "runtime" };
}

export class RetryPolicy {
  constructor({ maxAttempts = 3, retryQaFailures = false } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError("maxAttempts must be a positive integer");
    this.maxAttempts = maxAttempts;
    this.retryQaFailures = retryQaFailures;
  }

  decide(error, attempt) {
    const classification = classifyRuntimeFailure(error);
    const retryable = classification.code === "qa_failed" ? this.retryQaFailures : classification.retryable;
    return {
      ...classification,
      retry: retryable && attempt < this.maxAttempts,
      exhausted: retryable && attempt >= this.maxAttempts
    };
  }
}
