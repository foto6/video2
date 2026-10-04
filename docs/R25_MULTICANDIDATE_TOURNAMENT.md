# Media R25 multi-candidate round engine

R25 turns the accepted R24 two-file review authority into a deterministic 2–4 candidate tournament layer while reusing the existing R16 render runtime, R19 re-edit runtime, R21 blinded pair packaging, and R15/R11 QA contracts.

## Accepted authority

R24 is pinned at:

- producer SHA: `244acdf154741e669991b17df3ef2a47e2dfdfa9`
- exact-head CI: `37195239582` SUCCESS
- canonical artifact ID: `11301055747`
- artifact name: `media-r24-canonical-live-review-export`
- artifact digest: `sha256:fc5c9b9635d49b643e66efafe602d21ce1ef695a553f81a797bdf16d7b8cf228`

## Initial candidate generation

`media.edit_tournament_request.r25.v1` accepts one exact source, one content-addressed edit brief, an R11 vertical base timeline and an exact candidate count from 2 through 4.

Round 0 uses four bounded strategies in deterministic order when all four are requested:

1. clean podcast;
2. aggressive short-form;
3. cinematic minimal;
4. kinetic punch.

All are compiled into the existing timeline/render primitives. The fourth strategy adds a bounded slow push/fade and caption motion on top of the clean profile. Candidate acceptance checks structural operation lists, not merely IDs or filenames; duplicate operation graphs or duplicate rendered bytes fail the tournament.

Actual rendering is delegated to `media.candidate_batch.v1`, preserving its bounded parallelism, exact source/plan/renderer/producer cache identity, persistent restart state and no-blind-replay behavior.

## Candidate manifest

Every reviewable candidate emits `media.tournament_candidate_manifest.r25.v1` with:

- source SHA/size/path and brief digest;
- exact candidate strategy and round;
- canonical operation graph and digest;
- declared operation types;
- final MP4 SHA/size;
- R15 render-export file SHA and semantic digest;
- independent ffprobe dimensions/FPS/duration/video+audio facts;
- measured AV duration delta;
- hard technical gate evidence;
- deterministic caption SRT sidecar SHA/size;
- blind seed;
- `humanQuality=false`.

Primary-source gaps are accepted only when covered by declared creative dead-air omissions or a declared B-roll insertion. Silent source loss is rejected.

## Technical gate

Before bracket admission, candidates must preserve successful R15 technical and creative QA and must satisfy:

- decodable nonzero video;
- 1080x1920 at 30 fps;
- 5–90 second output duration;
- audio presence/nonzero duration when the source expects audio;
- AV duration delta <=120 ms;
- preserved probe readability, black-frame, frozen-frame, source-provenance and subtitle-safe-area checks;
- no benchmark technical DQ.

R14/R15 thresholds are not changed.

## Deterministic bracket

The candidate manifest digest is combined with tournament identity and round to derive deterministic seed digests.

- 2 candidates: one final A/B package.
- 3 candidates: one semifinal, deterministic bye, then a final winner slot.
- 4 candidates: two deterministic semifinals, then a final winner-of-semifinal-1 vs winner-of-semifinal-2 slot.

Reviewable matches are materialized through the existing R21 blinded pair builder. Candidate roles and IDs remain in machine-side sealed mappings; model-facing files are generic A/B attachments and prompt text. The final slot is not fabricated before semifinal review results exist.

## Targeted re-edit

A targeted challenger must be exact round N+1, at most round 2, and bind:

- prior baseline render SHA;
- exact Growth handoff digest;
- exact directive digest;
- exact R19 application sidecar;
- challenger output SHA/size.

Stale prior-review/directive evidence fails closed.

R25 also produces normalized source-window lineage evidence outside declared edit intervals. When comparable, this proves unaffected source mapping survives item splitting. It explicitly does not claim pixel identity after a full re-encode.

## Restart and replay

Tournament identity binds source SHA/size, brief digest, round and candidate count. Changed source or brief under the same tournament identity is a conflict.

R16 persistent state provides crash recovery. A candidate left `running` by interruption returns to `pending`; already completed candidates whose exact graph/cache identity still matches remain reusable.

The real rehearsal runs the same tournament twice and requires:

- first run renders four candidates;
- exact replay performs zero render calls and four cache hits;
- candidate manifests and bracket packages remain byte stable;
- deterministic TAR SHA/size remain unchanged.

## Real rehearsal

`npm run verify:r25` creates a 6-second encoded video+audio source and performs:

- one real four-candidate round;
- two deterministic semifinal blinded review packages;
- deterministic final bracket slots;
- one real R19 targeted round-1 re-edit whose parent is a candidate from that tournament;
- one R21 baseline-vs-re-edit review package;
- deterministic inner/outer TAR verification.

Outputs live under `.artifacts/r25-demo`.

No model/browser/provider call, social publish, human-quality assertion, or merge occurs.


## R25 external umbrella authority

External consumers MUST use `media.multicandidate_round.r25.v1` as the R25 authority. The older `media.edit_tournament.r25.v1`, `media.edit_tournament_request.r25.v1`, candidate-manifest, bracket, targeted-reedit and evidence contracts remain internal nested contracts and are exact-mapped by the umbrella. They are not valid substitutes for the external authority.

The umbrella pins the accepted R24 authority (producer `244acdf154741e669991b17df3ef2a47e2dfdfa9`, CI `37195239582`, artifact `11301055747`, digest `sha256:fc5c9b9635d49b643e66efafe602d21ce1ef695a553f81a797bdf16d7b8cf228`) and exact Git blob identities for the tournament implementation, runner, rehearsal, read-only verifier, external contract/schema and internal mapping files.

## CI reliability and restart closure

R25 no longer proves replay by immediately running the complete four-candidate tournament a second time. The real rehearsal materializes once, records persistent R16 candidate state/cache checkpoints, and then `npm run verify:r25:dir` independently verifies the encoded candidate files, manifests, bracket packages, targeted re-edit lineage and deterministic archives without invoking a render path.

The main regression job runs only the fast focused R25 contract suite. Real evidence is checkpointed across `r25-pair-1` (candidates 1-2), `r25-candidate-3`, `r25-candidate-4`, `r25-initial-finalize` (no render), `r25-targeted-evidence` (one real R19 challenger), and `r25-postdownload-verify` (no render). Each continuation remains a valid R16 two-candidate batch: candidate 3 is submitted with completed candidate 2 as an exact-cache anchor, and candidate 4 is submitted with completed candidate 3 as an exact-cache anchor. The phase asserts one cache hit, one render call, and no completed-candidate rerender. Each phase is handed to the next as an Actions artifact, so completed encoded candidates survive job boundaries and final verification consumes a freshly downloaded artifact.

The focused restart test simulates an interruption after candidates 1 and 2 have succeeded and candidate 3 is marked running. On reconstruction the running entry becomes pending, candidates 1-2 are validated/reused with their exact completed hashes, and only candidates 3-4 execute. A separate phase-selection regression proves R16 still rejects one-candidate requests and that every CI continuation contains exactly two candidates.

Commands:

- `npm run test:r25` — focused contracts/adversarial/restart tests.
- `npm run materialize:r25` — one real encoded four-candidate + targeted-reedit rehearsal.
- `npm run verify:r25:dir` — read-only verification; no rerender.
- `npm run verify:r25` — local convenience composition of the three steps.


### CI phase commands

- `npm run r25:phase1` — encode/QA candidates 1-2 and emit checkpoint.
- `npm run r25:candidate3` — consume the 2/4 checkpoint, exact-cache reuse candidate 2, and encode/QA only candidate 3.
- `npm run r25:candidate4` — consume the 3/4 checkpoint, exact-cache reuse candidate 3, and encode/QA only candidate 4.
- `npm run r25:finalize` — create candidate manifests, bracket packages and deterministic initial archive without rendering.
- `R25_INITIAL_PREMATERIALIZED=1 npm run r25:targeted` — consume the finalized initial round and render exactly one targeted re-edit challenger.
- `npm run verify:r25:dir` — independently verify the downloaded final directory and archives without FFmpeg rendering.


### Hosted-runner reliability fixture

The CI rehearsal source is still a real encoded six-second H.264/AAC MP4, but uses FFmpeg's moving `testsrc` generator rather than the higher-entropy `testsrc2`. This bounds hosted-runner CPU pressure for the kinetic candidate without changing candidate plans, operation graphs, source duration, 1080x1920/30fps output profile, R16/R15 execution paths, or any technical/creative gate. Production edit semantics are unchanged.


### Continuation FFmpeg runtime checkpoint

The pair-1 job is the only R25 phase job that installs FFmpeg from apt. After candidates 1-2 finish, it snapshots the exact `ffmpeg`/`ffprobe` binaries and their resolved shared libraries into the checkpoint artifact with a SHA-256 manifest. Candidate-3, candidate-4 and targeted-reedit jobs independently verify that manifest and activate the checkpointed runtime through `PATH`/`LD_LIBRARY_PATH`. This removes repeated package-install wall time from the runner-shutdown window without changing any rendered timeline, FFmpeg argument graph, codec/profile setting or QA threshold. The CI-only runtime is deleted before the final `media-r25-multicandidate-tournament` artifact is uploaded.


## Candidate-4 hostile-preemption checkpointing

Hosted-runner evidence on run `37212319175` showed candidate-4 repeatedly receiving SIGTERM/exit 143 about 32 seconds after materialization began, after the checkpointed FFmpeg runtime had already passed `runtime.manifest.sha256` verification and execute-bit restoration.

R25 decomposes candidate-4 rendering only; the frozen edit timeline and operation graph are unchanged. Exact checkpoint evidence showed the original 0-1600 ms slow-push segment itself consumed about 28.7 seconds before hosted-runner shutdown. The frozen rehearsal graph is therefore chunked at 0-800, 800-1600, 1600-3400 and 3400-5000 ms. The two kinetic chunks carry global slow-push frame progress (0-23 and 24-47 of the original 48-frame motion) so the motion does not restart at the checkpoint. Four independently durable render checkpoints are created:

1. `r25-candidate-4-segment-1` (0-800 ms kinetic)
2. `r25-candidate-4-segment-2` (800-1600 ms kinetic continuation)
3. `r25-candidate-4-segment-3` (1600-3400 ms existing video item)
4. `r25-candidate-4-segment-4` (3400-5000 ms existing video item)
5. `r25-candidate-4` performs stream-copy assembly, full final probe/technical+creative QA, R15 render export, candidate manifest emission, and exact R16 cache seeding.

Every segment checkpoint uses `media.r25.candidate4_checkpoint.v1` and binds the tournament/candidate identity, exact producer SHA, source SHA/size, candidate operation-graph digest, full timeline digest, exact FFmpeg runtime-manifest SHA, stable phase operation ID, segment timeline digest, input checkpoint identities, and exact intermediate output SHA/size.

Each continuation job preserves the existing security order:

`runtime.manifest.sha256 verification -> chmod exact ffmpeg/ffprobe -> executable check -> runtime execution`.

No continuation job installs or substitutes FFmpeg.

Exact replay of an existing segment validates its authority and output bytes and reuses it. A changed source, graph, producer/runtime authority, phase identity, missing artifact, or corrupt output fails closed. The final assembled candidate explicitly does **not** claim byte identity with the legacy monolithic candidate-4 encoder; its frozen output authority is the same candidate-4 edit timeline/operation graph rendered by the new deterministic segmented method. Final QA and the R15/R25 evidence gates remain unchanged.

The final candidate-4 phase seeds the same R16 candidate cache identity derived from source + candidate plan digest + renderer config + producer SHA. Earlier completed candidates are not re-rendered.
