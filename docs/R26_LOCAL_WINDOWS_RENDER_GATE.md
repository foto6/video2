# Media R26 local Windows real-render gate

Contract: `media.local_windows_render_gate.r26.v1`

R26 moves the long real encoding path off GitHub-hosted runners while preserving the R25 four-candidate tournament, bracket packaging, six durable candidate-4 subphases, and targeted R19/R21 re-edit evidence. Hosted CI validates only the control plane with tiny deterministic byte fixtures. It does not claim candidate-4 was rendered there.

## Coordinator command on Windows

Checkout the exact R26 branch in a normal non-protected workspace on E:, for example `E:\sv\video2`, and run:

```bat
cd /d E:\sv\video2
RUN_LOCAL_R26.cmd
```

Status and read-only verification:

```bat
STATUS_LOCAL_R26.cmd
VERIFY_LOCAL_R26.cmd
```

The launcher never requires administrator rights, credentials, browser/model/provider access, or social publishing. It writes only under `.artifacts\r25-demo` and `.artifacts\r26-local` inside the repository. Do not place the repository itself in a protected/system directory.

## Preflight and exact runtime

The real path requires Windows, Node.js 20+, at least 2 logical CPUs, 4 GiB RAM, 4 GiB free on the repository volume, and working `ffmpeg.exe` / `ffprobe.exe` on PATH for the first run.

On first run R26 copies the exact FFmpeg executables plus sibling DLLs into `.artifacts\r25-demo\ci-ffmpeg-runtime\bin`, hashes every copied runtime file into `runtime.manifest.sha256`, verifies the manifest, executes the checkpointed FFmpeg binary, and binds that manifest hash into the durable operation ledger. Subsequent runs use and re-verify the checkpointed runtime rather than silently adopting a changed system FFmpeg.

## Durable execution

The durable order is:

1. R25 pair-1 (candidates 1-2)
2. candidate 3
3. candidate-4 segments 1 through 6
4. candidate-4 assembly
5. initial bracket/finalize
6. targeted re-edit package
7. non-rendering R25 verification

After each phase R26 records exact artifact hashes and elapsed time. Restart after a completed phase verifies every recorded artifact before reuse. Hash drift, ledger corruption, runtime drift, or changed source/request/render graph under the same operation ID fails closed. Completed work is not silently rerendered.

Ctrl+C terminates the active child process and records a cancellation event without marking that phase complete. Restart with `RUN_LOCAL_R26.cmd`; already completed phases are verified and reused.

## Evidence

A successful local run creates:

`.artifacts\r26-local\media.local_windows_render_gate.r26.evidence.json`

It contains the producer SHA, deterministic source/request/plan/render-graph binding, FFmpeg runtime manifest/hash/version, four candidate MP4 hashes, bracket package evidence, targeted re-edit hash, final artifact hash, per-phase timings, invocation/restart/cancellation evidence, and explicit no-live-publish boundaries.

The R25 source used by this rehearsal is a deterministic FFmpeg-generated fixture, but every candidate and targeted re-edit is an actual encoded MP4. R26 never promotes fixture evidence to live model, human, provider, or platform evidence.

## Expected local envelope

The control plane needs little memory; encoding dominates. Minimum enforced resources are 2 logical CPUs, 4 GiB RAM, and 4 GiB free disk. A practical coordinator target is 4+ logical CPUs, 8 GiB RAM, and 8+ GiB free disk.

Runtime depends heavily on CPU and FFmpeg build. For the inherited R25 5-second 1080x1920 tournament graph, budget roughly 10-45 minutes for a cold full rehearsal on a typical Windows PC. Resumed runs should be substantially shorter because hash-verified completed phases are reused.

## Hosted CI boundary

The R26 workflow runs `npm run ci:r26` only. It uses tiny deterministic files to prove checkpoint ordering, replay reuse, hash verification, conflict detection, and restart semantics, then uploads the control-plane evidence artifact. It deliberately does not install FFmpeg or run long encoding.
