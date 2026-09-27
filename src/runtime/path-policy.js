import path, { win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeError } from "./errors.js";

const PROTECTED_WINDOWS_ROOT = win32.normalize("E:\\manhwa").toLowerCase();

function decodeLenient(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeWindowsPathCandidate(value) {
  if (typeof value !== "string") return null;
  let candidate = decodeLenient(value.trim());
  if (/^file:/i.test(candidate)) {
    candidate = candidate.replace(/^file:(?:\/{1,3})?/i, "");
  }
  candidate = candidate.replaceAll("/", "\\");
  candidate = candidate.replace(/^\\+([a-z]:\\)/i, "$1");
  if (candidate.toLowerCase().startsWith("\\\\?\\")) candidate = candidate.slice(4);
  if (!/^[a-z]:\\/i.test(candidate)) return null;
  return win32.normalize(candidate).toLowerCase();
}

export function isProtectedPath(value) {
  const normalized = normalizeWindowsPathCandidate(value);
  return normalized !== null &&
    (normalized === PROTECTED_WINDOWS_ROOT || normalized.startsWith(`${PROTECTED_WINDOWS_ROOT}\\`));
}

function asLocalPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw runtimeError("path_invalid", "path must be a non-empty string");
  }
  if (isProtectedPath(value)) {
    throw runtimeError("path_protected", "path references a protected location");
  }

  if (/^file:/i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      throw runtimeError("path_invalid", "invalid file URI");
    }
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return null;
  }
  return value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveSandboxedPath(value, { sandboxRoot = process.cwd(), allowRemoteUri = false } = {}) {
  const local = asLocalPath(value);
  if (local === null) {
    if (allowRemoteUri) return { kind: "uri", value };
    throw runtimeError("path_remote_not_allowed", "remote URI is not valid for this path");
  }

  if (win32.isAbsolute(local) && process.platform !== "win32") {
    throw runtimeError("path_outside_sandbox", "Windows absolute paths are outside this runtime sandbox");
  }

  const root = path.resolve(sandboxRoot);
  const resolved = path.resolve(root, local);
  if (!isInside(root, resolved)) {
    throw runtimeError("path_outside_sandbox", "path escapes the runtime sandbox");
  }
  return { kind: "path", value: resolved };
}

export function validateRuntimePaths(timeline, outputPath, options = {}) {
  const output = resolveSandboxedPath(outputPath, { ...options, allowRemoteUri: false });
  const sources = [];

  for (const track of timeline.tracks ?? []) {
    for (const item of track.items ?? []) {
      if (!item.source?.uri) continue;
      if (isProtectedPath(item.source.uri)) {
        throw runtimeError("path_protected", `source ${item.id} references a protected location`);
      }
      const resolved = resolveSandboxedPath(item.source.uri, { ...options, allowRemoteUri: true });
      sources.push({ itemId: item.id, ...resolved });
    }
  }

  return { outputPath: output.value, sources };
}
