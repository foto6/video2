# Media R27

Branch: agent/media-r27-real-input-local-rehearsal-20261006
Parent: dba0dce8d44c3b5786c37d2ce793172a058fb40f
Parent CI: 37405928263 SUCCESS

Goal: real-input Windows local rehearsal on top of the existing R25/R26 renderer.

Acceptance:
- explicit input video and output root;
- source hash/probe before rendering;
- reuse existing R25/R26 phase graph and checkpoints;
- four candidates, targeted re-edit and final artifact;
- sealed evidence bundle for Growth;
- producer authority remains pending independent QA;
- resume/conflict semantics;
- bounded hosted CI only;
- exact-head CI + artifact;
- no browser/model/provider/publish effects.
