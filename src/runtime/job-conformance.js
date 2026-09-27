import { stableStringify } from "../stable.js";
import { RENDER_JOB_STATUSES, isTerminalRenderStatus } from "./lifecycle.js";
import { isProtectedPath } from "./path-policy.js";
import { runtimeError } from "./errors.js";

export const MEDIA_JOB_CONTRACT_VERSION = "media.job.v1";
export const MEDIA_JOB_FIXTURE_VERSION = "media.job.v1.fixture.1";

const ACTIONS = new Set(["submit", "get", "status", "cancel", "resume_or_poll"]);
const STATUSES = new Set(RENDER_JOB_STATUSES);
const RENDER_REQUEST_FIELDS = new Set([
  "contractVersion", "jobId", "timeline", "exportSpec", "outputPath", "dryRun"
]);
const BASE_RESPONSE_FIELDS = new Set([
  "contractVersion", "accepted", "jobId", "idempotencyKey", "status", "terminal",
  "dryRun", "renderFingerprint", "retryOwner", "reconciliation", "failure",
  "finalArtifact", "telemetry"
]);
const TELEMETRY_FIELDS = new Set([
  "planningMs", "queueWaitMs", "renderMs", "probeMs", "qaMs", "retries",
  "outputSize", "outputSha256", "sideEffects", "protocol"
]);
const SIDE_EFFECT_FIELDS = new Set([
  "executorInvocations", "probeInvocations", "qaEvaluations",
  "finalizeInvocations", "successfulFinalizations"
]);
const PROTOCOL_FIELDS = new Set([
  "submitCount", "duplicateSubmits", "pollCount", "resumeCount",
  "cancelRequests", "reconciliations"
]);

function fail(message) {
  throw runtimeError("conformance_invalid", message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertJsonValue(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} must contain only finite JSON numbers`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "undefined") fail(`${label}.${key} must not be undefined`);
      assertJsonValue(item, `${label}.${key}`);
    }
    return;
  }
  fail(`${label} must be JSON-compatible`);
}

function cloneWire(value, label) {
  assertJsonValue(value, label);
  return JSON.parse(JSON.stringify(value));
}

function parseObject(input, label) {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      fail(`${label} is not valid JSON: ${error.message}`);
    }
  }
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  return cloneWire(value, label);
}

function assertExactKeys(object, required, optional, label) {
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(object);
  const missing = [...requiredSet].filter((key) => !Object.hasOwn(object, key));
  const extra = keys.filter((key) => !allowed.has(key));
  if (missing.length) fail(`${label} missing fields: ${missing.sort().join(", ")}`);
  if (extra.length) fail(`${label} unknown fields: ${extra.sort().join(", ")}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hex string`);
  }
}

function assertCounter(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
}

function validateRenderRequest(request) {
  if (!isPlainObject(request)) fail("submit.request must be an object");
  assertExactKeys(request, [...RENDER_REQUEST_FIELDS], [], "submit.request");
  if (request.contractVersion !== "media.render.v1") fail("submit.request.contractVersion must be media.render.v1");
  assertNonEmptyString(request.jobId, "submit.request.jobId");
  if (!isPlainObject(request.timeline)) fail("submit.request.timeline must be an object");
  if (!isPlainObject(request.exportSpec)) fail("submit.request.exportSpec must be an object");
  assertNonEmptyString(request.outputPath, "submit.request.outputPath");
  if (typeof request.dryRun !== "boolean") fail("submit.request.dryRun must be boolean");
}

export function parseMediaJobEnvelope(input) {
  const message = parseObject(input, "media.job.v1 envelope");
  if (message.contractVersion !== MEDIA_JOB_CONTRACT_VERSION) {
    fail(`contractVersion must be ${MEDIA_JOB_CONTRACT_VERSION}`);
  }
  if (!ACTIONS.has(message.action)) fail(`unsupported media.job.v1 action: ${message.action}`);

  if (message.action === "submit") {
    assertExactKeys(message, ["contractVersion", "action", "idempotencyKey", "request"], [], "submit envelope");
    assertNonEmptyString(message.idempotencyKey, "submit.idempotencyKey");
    validateRenderRequest(message.request);
    return message;
  }

  if (message.action === "cancel") {
    assertExactKeys(message, ["contractVersion", "action", "jobId"], ["reason"], "cancel envelope");
    assertNonEmptyString(message.jobId, "cancel.jobId");
    if (Object.hasOwn(message, "reason")) assertNonEmptyString(message.reason, "cancel.reason");
    return message;
  }

  assertExactKeys(message, ["contractVersion", "action", "jobId"], [], `${message.action} envelope`);
  assertNonEmptyString(message.jobId, `${message.action}.jobId`);
  return message;
}

function validateFailure(value, status) {
  if (value === null) {
    if (status === "failed") fail("failed status requires failure details");
    return null;
  }
  if (!isPlainObject(value)) fail("failure must be null or an object");
  assertExactKeys(value, ["code", "category", "message", "retryable", "details"], [], "failure");
  assertNonEmptyString(value.code, "failure.code");
  assertNonEmptyString(value.category, "failure.category");
  assertNonEmptyString(value.message, "failure.message");
  if (typeof value.retryable !== "boolean") fail("failure.retryable must be boolean");
  assertJsonValue(value.details, "failure.details");
  if (status === "succeeded") fail("succeeded status cannot carry failure details");
  return value;
}

function validateReconciliation(value, status) {
  if (!isPlainObject(value)) fail("reconciliation must be an object");
  if (value.required === false) {
    assertExactKeys(value, ["required"], [], "reconciliation");
    return value;
  }
  if (value.required === true) {
    assertExactKeys(value, ["required", "reason"], [], "reconciliation");
    assertNonEmptyString(value.reason, "reconciliation.reason");
    if (!["rendering", "retry_wait"].includes(status)) {
      fail("reconciliation.required=true is only valid for rendering or retry_wait");
    }
    return value;
  }
  fail("reconciliation.required must be boolean");
}

function validateTelemetry(value, response) {
  if (!isPlainObject(value)) fail("telemetry must be an object");
  assertExactKeys(value, [...TELEMETRY_FIELDS], [], "telemetry");
  for (const key of ["planningMs", "queueWaitMs", "renderMs", "probeMs", "qaMs"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) {
      fail(`telemetry.${key} must be a non-negative finite number`);
    }
  }
  assertCounter(value.retries, "telemetry.retries");
  if (value.outputSize !== null) assertCounter(value.outputSize, "telemetry.outputSize");
  if (value.outputSha256 !== null) assertSha256(value.outputSha256, "telemetry.outputSha256");

  if (!isPlainObject(value.sideEffects)) fail("telemetry.sideEffects must be an object");
  assertExactKeys(value.sideEffects, [...SIDE_EFFECT_FIELDS], [], "telemetry.sideEffects");
  for (const key of SIDE_EFFECT_FIELDS) assertCounter(value.sideEffects[key], `telemetry.sideEffects.${key}`);

  if (!isPlainObject(value.protocol)) fail("telemetry.protocol must be an object");
  assertExactKeys(value.protocol, [...PROTOCOL_FIELDS], [], "telemetry.protocol");
  for (const key of PROTOCOL_FIELDS) assertCounter(value.protocol[key], `telemetry.protocol.${key}`);

  if (value.sideEffects.successfulFinalizations > value.sideEffects.finalizeInvocations) {
    fail("successfulFinalizations cannot exceed finalizeInvocations");
  }
  if (response.dryRun) {
    for (const key of SIDE_EFFECT_FIELDS) {
      if (value.sideEffects[key] !== 0) fail(`dry-run response cannot report ${key}`);
    }
    if (value.outputSize !== null || value.outputSha256 !== null) {
      fail("dry-run response cannot report output size/hash");
    }
  }
}

function validateFinalArtifact(value, response) {
  const requiresArtifact = response.status === "succeeded" && response.dryRun === false;
  if (value === null) {
    if (requiresArtifact) fail("succeeded live response requires finalArtifact");
    return null;
  }
  if (!requiresArtifact) fail("finalArtifact is only valid for succeeded live jobs");
  if (!isPlainObject(value)) fail("finalArtifact must be an object");
  assertExactKeys(value, ["outputPath", "size", "sha256"], [], "finalArtifact");
  assertNonEmptyString(value.outputPath, "finalArtifact.outputPath");
  if (value.outputPath.endsWith(".partial") || /(^|[\\/])\.[^\\/]*\.partial$/.test(value.outputPath)) {
    fail("finalArtifact must not expose a partial/temp output path");
  }
  if (isProtectedPath(value.outputPath)) fail("finalArtifact references a protected path");
  assertCounter(value.size, "finalArtifact.size");
  assertSha256(value.sha256, "finalArtifact.sha256");
  return value;
}

export function validateMediaJobPublicResponse(input, { action = null } = {}) {
  const response = parseObject(input, "media.job.v1 public response");
  const fields = new Set(BASE_RESPONSE_FIELDS);
  if (action === "submit") fields.add("duplicate");
  assertExactKeys(response, [...fields], [], "media.job.v1 public response");

  if (response.contractVersion !== MEDIA_JOB_CONTRACT_VERSION) fail("response contractVersion mismatch");
  if (response.accepted !== true) fail("public success response accepted must be true");
  assertNonEmptyString(response.jobId, "response.jobId");
  if (response.idempotencyKey !== null) assertNonEmptyString(response.idempotencyKey, "response.idempotencyKey");
  if (!STATUSES.has(response.status)) fail(`unknown response status: ${response.status}`);
  if (response.terminal !== isTerminalRenderStatus(response.status)) {
    fail("response.terminal does not match status");
  }
  if (typeof response.dryRun !== "boolean") fail("response.dryRun must be boolean");
  assertSha256(response.renderFingerprint, "response.renderFingerprint");
  if (response.retryOwner !== "media") fail("response.retryOwner must be media");
  if (action === "submit" && typeof response.duplicate !== "boolean") fail("submit response duplicate must be boolean");

  validateReconciliation(response.reconciliation, response.status);
  validateFailure(response.failure, response.status);
  validateTelemetry(response.telemetry, response);
  validateFinalArtifact(response.finalArtifact, response);

  if (response.finalArtifact !== null) {
    if (response.telemetry.outputSize !== response.finalArtifact.size) fail("finalArtifact.size must match telemetry.outputSize");
    if (response.telemetry.outputSha256 !== response.finalArtifact.sha256) fail("finalArtifact.sha256 must match telemetry.outputSha256");
    if (response.telemetry.sideEffects.successfulFinalizations !== 1) {
      fail("succeeded live artifact requires exactly one successful finalization");
    }
    if (response.telemetry.sideEffects.qaEvaluations < 1) {
      fail("succeeded live artifact requires at least one QA evaluation");
    }
  } else if (response.status !== "succeeded" || response.dryRun) {
    if (response.telemetry.outputSize !== null || response.telemetry.outputSha256 !== null) {
      fail("non-final response cannot expose output size/hash");
    }
  }

  if (response.status === "succeeded" && response.failure !== null) fail("succeeded response cannot have failure");
  return response;
}

export function validateMediaJobErrorResponse(input) {
  const response = parseObject(input, "media.job.v1 error response");
  assertExactKeys(response, ["contractVersion", "accepted", "error"], [], "media.job.v1 error response");
  if (response.contractVersion !== MEDIA_JOB_CONTRACT_VERSION) fail("error contractVersion mismatch");
  if (response.accepted !== false) fail("error response accepted must be false");
  if (!isPlainObject(response.error)) fail("error must be an object");
  assertExactKeys(response.error, ["code", "message"], [], "error");
  assertNonEmptyString(response.error.code, "error.code");
  assertNonEmptyString(response.error.message, "error.message");
  return response;
}

export function validateMediaJobWireResponse(input, { action = null } = {}) {
  const object = parseObject(input, "media.job.v1 wire response");
  return object.accepted === false
    ? validateMediaJobErrorResponse(object)
    : validateMediaJobPublicResponse(object, { action });
}

export function serializeMediaJobEnvelope(input) {
  return stableStringify(parseMediaJobEnvelope(input));
}

export function serializeMediaJobWireResponse(input, { action = null } = {}) {
  return stableStringify(validateMediaJobWireResponse(input, { action }));
}

export function parseMediaJobConformanceFixture(input) {
  const item = parseObject(input, "media.job.v1 fixture");
  assertExactKeys(item, ["fixtureVersion", "name", "request", "response"], [], "media.job.v1 fixture");
  if (item.fixtureVersion !== MEDIA_JOB_FIXTURE_VERSION) fail("fixtureVersion mismatch");
  assertNonEmptyString(item.name, "fixture.name");
  const request = parseMediaJobEnvelope(item.request);
  const response = validateMediaJobWireResponse(item.response, { action: request.action });
  return { ...item, request, response };
}

export class MediaJobProtocolHarness {
  constructor(protocol) {
    if (!protocol || typeof protocol.handle !== "function") throw new TypeError("protocol.handle is required");
    this.protocol = protocol;
  }

  async exchange(input) {
    let action = null;
    try {
      const request = parseMediaJobEnvelope(input);
      action = request.action;
      const response = await this.protocol.handle(request);
      return validateMediaJobPublicResponse(response, { action });
    } catch (error) {
      return validateMediaJobErrorResponse({
        contractVersion: MEDIA_JOB_CONTRACT_VERSION,
        accepted: false,
        error: {
          code: typeof error?.code === "string" ? error.code : "internal_error",
          message: typeof error?.message === "string" && error.message ? error.message : "media job protocol failure"
        }
      });
    }
  }

  async exchangeJsonLine(line) {
    let action = null;
    try {
      action = parseMediaJobEnvelope(line).action;
    } catch {
      // exchange() returns the strict invalid-request/conformance error form.
    }
    const response = await this.exchange(line);
    return serializeMediaJobWireResponse(response, { action });
  }

  async exchangeRpc(params) {
    return this.exchange(params);
  }
}
