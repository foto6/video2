# Media R25 candidate-4 render-path benchmark policy

This is a measurement-only Phase A commit. It does not change production render semantics.

Frozen authority:
- Media head: `00319d5795daa5a38260e309102866eec476cb0b`
- exact failed run: `37246071924`
- exact candidate-3 checkpoint artifact: `11319501040`
- artifact digest: `sha256:f58a92c2a88b4bf0436e66b3e3f1be9d70a6254e9a5842fe6571751892dc54e8`
- request SHA-256: `0b8f5b8d46b1854534163f8ff836c40bc73d919ee0242938302ba161ff0af076`
- source SHA-256 / size: `0828975570c9df9e3590f8f56e6776b968d0930bb0117b4bc8feb07259ef1657` / 117594
- runtime-manifest SHA-256: `9a49ca2fdc1e0b72186e981ecc617363cbd767ae24d28ee4c93478e59705009f`
- frozen implementation blobs: tournament `b6ba243e7954d35ecb2a6d81ee17893f9df781d1`, creative-plan `3784ddfd1f8c569a68f041a8fe937da30cc24d43`, checkpoint `9c1f848a34277b0968e8227b7e8a3d724d8ddd9e`, ffmpeg compiler `d4b29dc95f2cd1c88e26f0db7d794bd45edf19f0`.

Before any timed render invocation, the harness deterministically derives candidate-4 from that exact request and writes the exact operation-graph digest, full timeline digest, segment-1 timeline digest, stable operation ID and decomposition digest into `benchmark-policy.json`. Segment-1 must remain exactly 0-400 ms at 1080x1920@30.

Every strategy gets exactly two repetitions. Each FFmpeg invocation has a hard 20-second internal timeout. A timed-out baseline is valid evidence and does not fail the benchmark workflow.

Selection is frozen before results:
- PASS: both repetitions <=15,000 ms.
- WARN ceiling: 20,000 ms.
- reject authority/lineage drift, geometry failure, visual-equivalence failure, non-deterministic repeated output, or missing reusable audio evidence for video-only segmentation.
- visual equivalence uses a filter-only rawvideo reference, exact decoded frame count/geometry, sampled decoded YUV PSNR >=35 dB and mean absolute error <=4.0.
- winner = fastest eligible strategy with both repetitions <=15 seconds, ordered by worst repetition then mean.
- if none qualify, result is `BLOCKED_PERFORMANCE`; no implementation commit is authorized.

Predeclared strategies:
1. `BASELINE_FULL_SINGLE_THREAD`: current full graph, current single-thread encode.
2. `FULL_BOUNDED_THREADS`: same semantic graph with two encoder/filter threads.
3. `VIDEO_ONLY_SEGMENT`: exact video/caption/motion graph per segment; candidate audio is generated once as separately hashed source-bound loudness evidence for final mux.
4. `OPTIMIZED_MOTION_PATH`: preserve centered source crop/global slow-push progression, run zoompan at 540x960, perform one deterministic bicubic scale to 1080x1920, remove redundant post-zoompan fps resample, and use two encoder/filter threads.
5. `VIDEO_ONLY_BOUNDED_THREADS`: declared extra strategy combining video-only segmentation and bounded threads.

The benchmark uses the exact downloaded checkpoint runtime and verifies `runtime.manifest.sha256` before restoring execute permission. No apt replacement is permitted.
