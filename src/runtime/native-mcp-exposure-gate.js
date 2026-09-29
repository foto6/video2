/**
 * R10 tool EXPOSURE gate. Classifies only names actually advertised to a
 * ChatGPT session; never creates a tool, calls a fallback, or interprets a
 * GitHub relay/skill as a direct Native PC MCP connection.
 */
export const MEDIA_NATIVE_PC_EXPOSURE_AUDIT_VERSION = "media.native_pc_exposure_audit.v1";
const legacySkill = "skills://plugins/pc-control/pc-control";

function namespaceOf(name) {
  const match = /^mcp__(.+?)__/.exec(name);
  return match?.[1] ?? null;
}

function isNativePcNamespace(name) {
  const namespace = namespaceOf(name);
  if (!namespace) return false;
  const normalized = namespace.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.includes("nativepc") || normalized.includes("pcnative");
}

export function evaluateNativePcMcpExposure({ toolNames, skillUris = [] } = {}) {
  if (!Array.isArray(toolNames) || !Array.isArray(skillUris) ||
      toolNames.some((name) => typeof name !== "string" || !name.length) ||
      skillUris.some((uri) => typeof uri !== "string" || !uri.length)) {
    throw new TypeError("advertised toolNames and skillUris arrays are required");
  }
  const unique = [...new Set(toolNames)];
  const nativeToolNames = unique.filter(isNativePcNamespace).sort();
  const desktopCommanderToolNames = unique.filter((name) =>
    namespaceOf(name) === "Remote_Desktop_Commander"
  ).sort();
  return {
    contractVersion: MEDIA_NATIVE_PC_EXPOSURE_AUDIT_VERSION,
    advertisedToolCount: unique.length,
    nativeToolNames,
    nativeExposed: nativeToolNames.length > 0,
    desktopCommanderToolCount: desktopCommanderToolNames.length,
    desktopCommanderIsNative: false,
    legacyGitHubRelaySkillVisible: skillUris.includes(legacySkill),
    legacyGitHubRelayIsNative: false,
    capabilityProbePermitted: nativeToolNames.length > 0,
    blocker: nativeToolNames.length ? null : "NATIVE_PC_MCP_NOT_EXPOSED"
  };
}
