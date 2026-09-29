# R10 — Independent Native PC MCP exposure audit

**Observed in this exact existing Media Engine Pipeline ChatGPT conversation:** 2026-09-29. The R10 instruction appeared as an actual posted user turn; this observation does not independently prove any hidden WebAIBridge routing mechanism.

The agent enumerated `ALL_TOOLS` from its own callable ChatGPT session (255 names) and separately read the available installed skill catalog. No Native PC MCP namespace, callable Native capability discovery, Native device list, Native ping, or Native configuration tool was exposed. Therefore **NATIVE_PC_MCP_NOT_EXPOSED** is an explicit external blocker. The audit did not invent a native tool result or call a substitute.

Three distinct surfaces were identified:

1. **New Native PC MCP:** absent as a callable namespace. Version, capability registry digest, live device identity, ping, config metadata and isolated TEMP fixture status are **unverified** (not negative device outcomes). There is no advertised input schema with which to call them.
2. **Desktop Commander 0.2.51-style surface:** 30 tools with prefix `mcp__Remote_Desktop_Commander__`; separate vendor transport, not the new Native PC MCP. No calls made.
3. **Older `pc-control` skill:** `skills://plugins/pc-control/pc-control`, using a private `foto6/help-pc-1` GitHub queue/result relay (`pc_relay.request.v1` and `pc_relay.result.v1`), not a direct Native MCP. Its skill instructions were inspected solely to distinguish transports; no relay request was submitted.

Machine-readable evidence: `reports/R10_NATIVE_MCP_EXPOSURE.json`. Reusable classifier: `src/runtime/native-mcp-exposure-gate.js`. The classifier is strictly a tool-name exposure check; synthetic names in its unit tests are NOT observed live native invocations.

**Unblocking criteria:** the genuine new Native PC MCP must be exposed as callable tools with their schemas in this chat session. Only then, with authorized read-only schemas, test native capability discovery, device list, ping, nonsensitive configuration metadata, and a known isolated TEMP fixture; capture version, frozen registry digest, request/result IDs, explicit outcomes and failure modes. Do not query secrets, user-video files, the protected E-drive root or Windows services. No native device-side operation occurred in R10.
