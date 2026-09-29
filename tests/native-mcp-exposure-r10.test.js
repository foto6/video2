import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNativePcMcpExposure } from "../src/index.js";

test("Native PC MCP availability is never synthesized from the 30 Desktop Commander names", () => {
  const tools = Array.from({ length: 30 }, (_, i) =>
    `mcp__Remote_Desktop_Commander__tool_${i}`
  );
  tools.push("mcp__GitHub__fetch", "mcp__GitHub__compare_commits");
  const result = evaluateNativePcMcpExposure({
    toolNames: tools,
    skillUris: ["skills://plugins/pc-control/pc-control"]
  });
  assert.equal(result.nativeExposed, false);
  assert.equal(result.desktopCommanderToolCount, 30);
  assert.equal(result.legacyGitHubRelaySkillVisible, true);
  assert.equal(result.blocker, "NATIVE_PC_MCP_NOT_EXPOSED");
});

test("actual R10 report explicitly marks every native probe untested, with no invented version or digest", () => {
  const data = JSON.parse(readFileSync(
    new URL("../reports/R10_NATIVE_MCP_EXPOSURE.json", import.meta.url), "utf8"
  ));
  assert.equal(data.nativeMcp.advertisedToolNames.length, 0);
  assert.equal(data.nativeMcp.namespace, null);
  assert.equal(data.nativeMcp.actualNativeCallsAttempted, 0);
  for (const key of ["capabilityDiscovery", "deviceList", "ping", "configurationMetadata", "isolatedKnownTempFixture"]) {
    assert.equal(data.nativeMcp[key].status, "not_tested_absent_tool");
  }
  assert.equal(data.exposureDecision, "BLOCKED_UNTIL_NATIVE_PC_MCP_TOOLS_APPEAR_IN_THIS_CHAT_SESSION");
});
