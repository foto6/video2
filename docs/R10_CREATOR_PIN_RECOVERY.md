# Media R10 — Native MCP consumer audit and Creator pin recovery gate

Producer: `foto6/video2`, isolated branch `agent/media-r10-native-mcp-consumer-20260929` based on exact green R9 `750d4ef36be76adbacc72210116ece8bda50c60d`.

## Independent Native PC MCP tool-exposure finding

`reports/R10_NATIVE_MCP_EXPOSURE.json` records the actual tools enumerated from the **current ChatGPT session**. There were 255 callable tools. No new Native PC MCP callable namespace appeared. Desktop Commander exposed 30 `mcp__Remote_Desktop_Commander__*` tools, which are unrelated to Native MCP. The installed `skills://plugins/pc-control/pc-control` skill is the **older GitHub request/result relay** (versions `pc_relay.request.v1` and `pc_relay.result.v1`), not the new Native MCP. Neither fallback was used to synthesize a Native MCP result.

Decision: `NATIVE_PC_MCP_NOT_EXPOSED`. Genuine Native MCP capability discovery, native device list/ping, configuration metadata, isolated TEMP fixture, version and registry digest are **not tested/unverified**. No Native MCP calls were possible; no secrets or running Windows services were accessed. Only an actual advertised Native MCP tool schema in this conversation would unblock those tests.

A reusable pure classifier `evaluateNativePcMcpExposure()` and a focused regression demonstrate the separation. The classifier's synthetic Native namespace is a **test fixture only**, not a claim of installation. The posted R10 user turn itself is visible in this existing conversation; this observation does not independently establish the hidden WebAIBridge direct-send transport path.

## Companion Creator recovery protocol

`media.creator_pin_recovery.v1` is an internal read-only, path-free diagnostic *companion* to `media.artifact_pin_request.v1` and the unchanged `media.artifact_pin_lease.v1`; no frozen lease field or digest is modified.

Use `inspectCreatorPinRecovery({pinLeaseStore,requestId,expectedRequestDigest})`. It reads a coherent durable snapshot under the existing cross-instance pin/GC coordination barrier. It returns a canonical evidence digest, event count, Creator binding digest, owner generation, mutation epoch, lease canonical digest, and one of:

| Decision | Meaning | Creator action |
|---|---|---|
| `REQUEST_NOT_FOUND` | No durable request exists; transport outcome unproven. | Do not assume a lease; inspect authoritative backend before a new action. |
| `PREPARED_UNPROVEN` | Prepared intent, no matching durable event. | Keep GC blocked; explicit `reconcileNoEffect` only after epoch/event evidence. |
| `PREPARED_EFFECT_PROVEN` | Exact owner/action/generation event and current lease/absence prove effect. | `reconcileCreatorPinRecovery` commits outcome and repairs missing Creator binding without re-running lease. |
| `PROVENANCE_CONFLICT` | Duplicate, substituted, wrong-action or inconsistent event evidence. | Fail closed, no lease retry or GC; investigate journal. |
| `COMMITTED_ACTIVE_PIN` | Committed acquisition/renewal, current live lease and Creator binding match the acknowledged generation/digest. | Creator may treat that exact pin as held. |
| `COMMITTED_RELEASE` | Historical release is committed and owner still absent at that generation. | Creator may treat that owner's release as complete; GC still must check all other owners. |
| `SUPERSEDED_OR_EXPIRED_PIN` | The old committed acquire/renew is no longer the current verified live pin. | Do not reuse its historical acknowledgment; revalidate current owner state and CAS a new request. |
| `SUPERSEDED_OR_CONFLICTING_RELEASE` | Owner was replaced or release provenance no longer describes current state. | Do not infer unpinned artifact; inspect active leases. |
| `ABORTED_PROVEN_NO_EFFECT` / `REJECTED` | Durable closed no-effect/rejected request. | Never reuse that request ID for a side effect. |

`mayReplaySideEffect` is always `false`. An identical committed request can recover its historical response only while its current lease/generation is still the one acknowledged; otherwise `journaledLeaseOperation` returns `pin_request_superseded`. The recovery API distinguishes **historical committed effect** from **present authorization to claim a pin**.

R10 hardens persisted prepared-journal provenance with owner kind/ID, arguments digest and expected generation (old R9 rows remain readable). `reconcileJournaledRequest` now requires **exactly one** event with matching request ID, action, owner identity, artifact digest, manifest digest and expected generation; release must agree with the persisted generation watermark and absence. It cannot fabricate success from a wrong-owner/wrong-action event. For a legitimate crash after lease/event but before Creator binding commit, reconciliation restores binding and journal outcome in the same durable snapshot; no second lease mutation occurs.

### Exact downstream Creator adapter

1. Before submit, durably store stable `requestId`, Creator job/checkpoint/release ID, Media logical job ID, final artifact digest, manifest digest, expected owner epoch and canonical binding.
2. Obtain Media's authoritative QA-passed succeeded-live manifest and verify artifact bytes/provenance (not merely the JSON callback fields). Run `journaledLeaseOperation` with the same request ID, exact binding, owner CAS epoch and `verifyArtifact` callback.
3. On lost response after committed effect, **do not allocate a new ID**. Use `inspectCreatorPinRecovery` with the original persisted request digest. Only `COMMITTED_ACTIVE_PIN` proves a currently held pin; `COMMITTED_RELEASE` proves that owner's release. If prepared+event proven, use `reconcileCreatorPinRecovery` instead of re-invoking acquire/renew/release.
4. If prepared+event missing or contradictory, preserve unknown and block GC. Only explicit evidence-based `reconcileNoEffect` with unchanged scope epoch and no persisted event may abort a no-effect request.
5. Persist each new generation after renewal/reacquisition, and do not assume a historical committed acquire remains active after release, replacement or expiry.
6. GC must separately acquire release approval and query **all** current verified active leases/unknown outcomes using `planArtifactGcWithPinStore`. No single owner's release overrides another checkpoint or release-candidate pin.

### Test scope and invariants

`tests/creator-pin-recovery-r10.test.js` exercises duplicate exact request, restart, lost committed acknowledgment, crash before effect, crash between lease effect and binding commit, crash before journal commit, stale acquire/release replay, owner replacement/expiry, two simultaneous checkpoint owners, event substitution, journal owner-key corruption and the deterministic four-seed/four-fault matrix. It uses only canonical synthetic provenance fixtures and new isolated OS TEMP pin-journal JSON; **no real video files**.

Run `npm run test:r10` followed by the retained R9 pin/GC, Wave9 10,000-lease, Wave8 1,200-record, artifact integrity, Wave5/6 stress and full `npm test` exact-head CI. Report: `reports/R10_CREATOR_PIN_RECOVERY.json`.

No merge, release, paid provider, user-video inspection or Windows SCM modification is involved.
