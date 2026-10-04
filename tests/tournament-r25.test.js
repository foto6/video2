import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  CandidateBatchRuntime,
  MEDIA_CANDIDATE_BATCH_VERSION,
  MEDIA_MULTICANDIDATE_ROUND_VERSION,
  MEDIA_SHORTFORM_PROFILE_VERSION,
  MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
  MEDIA_TOURNAMENT_REQUEST_VERSION,
  PersistentCandidateBatchStore,
  PersistentCandidateCache,
  R15_BOSS_BENCHMARK_BINDING,
  R19_GROWTH_R23_AUTHORITY,
  buildMulticandidateRoundAuthority,
  buildTournamentBracket,
  buildTournamentCandidatePlans,
  buildUnaffectedRegionEvidence,
  candidateCacheIdentity,
  candidatePlanDigest,
  candidateRendererConfigDigest,
  evaluateTournamentTechnicalGate,
  fingerprint,
  tournamentRequestIdentityDigest,
  validateMulticandidateRoundAuthority,
  validateTargetedTournamentReedit,
  validateTournamentBracket,
  validateTournamentCandidateManifest,
  validateTournamentReplayBinding,
  validateTournamentRequest
} from "../src/index.js";

const SHA = (c) => c.repeat(64);
const GIT = (c) => c.repeat(40);

function baseRequest(overrides = {}) {
  const source = {
    sourceId: "source-1",
    path: "source.mp4",
    sha256: SHA("a"),
    size: 12345,
    durationMs: 6000,
    expectAudio: true
  };
  const req = {
    contractVersion: MEDIA_TOURNAMENT_REQUEST_VERSION,
    tournamentId: "r25-test",
    source,
    brief: {
      briefId: "brief-1",
      digest: SHA("b"),
      sentenceBoundariesMs: [0, 900, 1800, 3000, 4500, 6000],
      beatMarkersMs: [750, 1500, 2250, 3000, 3750, 4500, 5250],
      silenceRanges: [{ startMs: 1100, endMs: 1550 }],
      loopFriendly: false
    },
    roundNumber: 0,
    candidateCount: 4,
    baseTimeline: {
      id: "base",
      version: 1,
      profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
      canvas: { width: 1080, height: 1920, fps: 30, durationMs: 6000 },
      tracks: [
        {
          id: "video",
          kind: "video",
          items: [{
            id: "main",
            startMs: 0,
            endMs: 6000,
            role: "body",
            source: {
              id: source.sourceId,
              uri: source.path,
              inMs: 0,
              outMs: 6000,
              sha256: source.sha256,
              size: source.size
            }
          }]
        },
        {
          id: "caption",
          kind: "caption",
          items: [{
            id: "cap",
            startMs: 500,
            endMs: 1500,
            text: "EDIT THIS",
            style: { fontSize: 58, box: true }
          }]
        },
        {
          id: "audio",
          kind: "audio",
          items: [
            {
              id: "voice",
              startMs: 0,
              endMs: 6000,
              role: "voiceover",
              source: {
                id: source.sourceId,
                uri: source.path,
                inMs: 0,
                outMs: 6000,
                sha256: source.sha256,
                size: source.size
              },
              gainDb: -3
            }
          ]
        }
      ]
    },
    exportSpec: {
      format: "mp4",
      videoCodec: "libx264",
      audioCodec: "aac",
      videoBitrate: "900k",
      audioBitrate: "128k",
      pixelFormat: "yuv420p",
      preset: "ultrafast",
      loudness: false
    }
  };
  return { ...req, ...overrides };
}

function validRenderExport({ sha = SHA("c"), size = 1000, hasAudio = true } = {}) {
  return {
    contractVersion: "media.render_export.v1",
    status: "succeeded",
    producer: { repository: "foto6/video2", sha: GIT("1") },
    job: {
      logicalJobId: "job-1",
      idempotencyKey: "idem-1",
      renderFingerprint: SHA("d"),
      status: "succeeded"
    },
    artifact: {
      fileName: "final.mp4",
      algorithm: "sha256",
      sha256: sha,
      size,
      contentId: `sha256:${sha}`,
      artifactManifestDigest: SHA("e")
    },
    probe: {
      hasVideo: true,
      hasAudio,
      width: 1080,
      height: 1920,
      fps: 30,
      durationMs: 6000,
      videoCodec: "h264",
      audioCodec: hasAudio ? "aac" : null
    },
    qa: {
      technical: {
        sha256: SHA("f"),
        passed: true,
        value: {
          passed: true,
          checks: [
            { name: "probe-readable", pass: true, actual: false, expected: false },
            { name: "analysis-complete", pass: true, actual: true, expected: true },
            { name: "black-frame-ratio", pass: true, actual: 0, expected: "<=0.4" },
            { name: "frozen-frame-duration", pass: true, actual: 0, expected: "<=1500" },
            { name: "source-assets-provenance", pass: true, actual: 0, expected: 0 },
            { name: "subtitle-safe-area", pass: true, actual: 0, expected: 0 }
          ]
        }
      },
      creative: {
        sha256: SHA("1"),
        passed: true,
        value: { passed: true }
      }
    },
    evidence: {
      sources: {
        count: 1,
        sha256: SHA("2"),
        items: [{ sourceId: "source-1", expectedKind: "video", sha256: SHA("a"), size: 12345, probeOk: true }]
      },
      captions: { count: 1, sha256: SHA("3"), safeAreaPassed: true, textCharsPerSecond: 1 },
      crop: { explicitCropItems: 0, reframeItems: 0, motionItems: 0, unsafeCropPassed: true },
      audio: { itemCount: hasAudio ? 1 : 0, roles: hasAudio ? ["voiceover"] : [], maxMusicGainDb: null, hasAudio, meanDb: -20, peakDb: -2, silenceRatio: 0 }
    },
    provenance: {
      validatedRequestDigest: SHA("4"),
      profileDigest: SHA("5"),
      timelineDigest: SHA("6"),
      creativePlanDigest: null,
      sourceEvidenceDigest: SHA("2"),
      artifactManifestDigest: SHA("e")
    },
    failure: null,
    benchmark: {
      binding: R15_BOSS_BENCHMARK_BINDING,
      technicalDq: false,
      technicalDqReasons: []
    }
  };
}

function candidateManifest({
  id = "candidate-1",
  round = 0,
  renderSha = SHA("c"),
  renderSize = 1000,
  opType = "caption_layout"
} = {}) {
  const graph = {
    timelineDigest: SHA("7"),
    durationMs: 6000,
    operations: [{
      type: opType,
      trackId: "caption",
      trackKind: "caption",
      itemId: "cap",
      role: null,
      range: { startMs: 500, endMs: 1500 },
      source: null,
      textSha256: SHA("8"),
      style: {}
    }],
    sourceCoverage: {
      primarySourceId: "source-1",
      windows: [{ inMs: 0, outMs: 6000 }],
      gaps: [],
      declaredOmissions: []
    }
  };
  return {
    contractVersion: MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION,
    tournamentId: "r25-test",
    candidateId: id,
    roundNumber: round,
    strategy: "fixture",
    source: { sourceId: "source-1", path: "source.mp4", sha256: SHA("a"), size: 12345 },
    briefDigest: SHA("b"),
    producerSha: GIT("1"),
    operationGraph: graph,
    operationGraphDigest: fingerprint(graph),
    declaredOperationTypes: [opType],
    render: { path: `out/${id}/final.mp4`, sha256: renderSha, size: renderSize },
    renderExport: { path: `out/${id}/media.render_export.v1.json`, fileSha256: SHA("9"), digest: SHA("0") },
    ffprobe: {
      hasVideo: true, hasAudio: true, width: 1080, height: 1920, fps: 30,
      durationMs: 6000, videoDurationMs: 6000, audioDurationMs: 6000, avSyncDeltaMs: 0
    },
    technicalGate: { passed: true, checks: [] },
    captionSidecar: { path: `out/${id}/captions.srt`, sha256: SHA("a"), size: 10, mime: "application/x-subrip" },
    blindSeed: SHA("b"),
    humanQuality: false
  };
}

function application({ baselineSha, challengerSha, challengerSize = 1100, round = 0 } = {}) {
  return {
    contractVersion: "media.editorial_reedit_application.v1",
    producer: { repository: "foto6/video2", sha: GIT("1") },
    growthAuthority: R19_GROWTH_R23_AUTHORITY,
    handoff: { id: `gcrh1:${SHA("1")}`, digest: SHA("2"), reeditRound: round },
    input: { candidateId: "candidate-1", renderSha256: baselineSha },
    directiveDigest: SHA("3"),
    applications: [{
      directiveId: `gcrd1:${SHA("4")}`,
      operation: "cut",
      originalInterval: { startMs: 1000, endMs: 1200 },
      appliedInterval: null,
      status: "applied",
      reason: null,
      exactOperations: [{ type: "remove_interval", durationMs: 200 }]
    }],
    ffmpegPlanDigest: SHA("5"),
    outputTimelineDigest: SHA("6"),
    planDigest: SHA("7"),
    output: { status: "succeeded", sha256: challengerSha, size: challengerSize, renderExportSha256: SHA("9") },
    qa: { technicalPassed: true, technicalEvidenceSha256: SHA("8"), measurable: {} },
    humanQuality: false
  };
}

test("R25 builds four structurally distinct candidate plans from one source and brief", () => {
  const request = baseRequest();
  const plans = buildTournamentCandidatePlans(request);
  assert.equal(plans.length, 4);
  assert.equal(new Set(plans.map((x) => fingerprint(x.operationGraph.operations))).size, 4);
  assert.equal(new Set(plans.map((x) => x.operationGraphDigest)).size, 4);
  assert.ok(plans.every((x) => x.plan.timeline.profileVersion === MEDIA_SHORTFORM_PROFILE_VERSION));
});

test("R25 request rejects path traversal and round above two", () => {
  assert.throws(
    () => validateTournamentRequest(baseRequest({ source: { ...baseRequest().source, path: "../source.mp4" } })),
    /confined relative path/
  );
  assert.throws(() => validateTournamentRequest(baseRequest({ roundNumber: 3 })), /roundNumber/);
});

test("R25 replay identity rejects changed brief under same tournament identity", () => {
  const request = baseRequest();
  const state = { requestIdentityDigest: tournamentRequestIdentityDigest(request) };
  assert.equal(validateTournamentReplayBinding(state, request).replayCompatible, true);
  const changed = baseRequest({ brief: { ...request.brief, digest: SHA("c") } });
  assert.throws(() => validateTournamentReplayBinding(state, changed), /changed source\/brief/);
});

test("R25 technical gate rejects missing expected audio and excessive AV skew", () => {
  const exportRecord = validRenderExport({ hasAudio: false });
  const missing = evaluateTournamentTechnicalGate({
    renderExport: exportRecord,
    expectAudio: true,
    ffprobeFacts: {
      hasVideo: true, hasAudio: false, width: 1080, height: 1920, fps: 30,
      durationMs: 6000, videoDurationMs: 6000, audioDurationMs: null, avSyncDeltaMs: null
    }
  });
  assert.equal(missing.passed, false);
  assert.equal(missing.checks.find((x) => x.name === "audio-present").pass, false);

  const skew = evaluateTournamentTechnicalGate({
    renderExport: validRenderExport(),
    expectAudio: true,
    ffprobeFacts: {
      hasVideo: true, hasAudio: true, width: 1080, height: 1920, fps: 30,
      durationMs: 6000, videoDurationMs: 6000, audioDurationMs: 5700, avSyncDeltaMs: 300
    }
  });
  assert.equal(skew.passed, false);
  assert.equal(skew.checks.find((x) => x.name === "av-sync").pass, false);
});

test("R25 rejects corrupt technical gate and undeclared operations", () => {
  const corrupt = candidateManifest();
  corrupt.technicalGate = { passed: false, checks: [{ name: "probe-readable", pass: false }] };
  assert.throws(() => validateTournamentCandidateManifest(corrupt), /technical gate must pass/);

  const undeclared = candidateManifest();
  undeclared.declaredOperationTypes = [];
  assert.throws(() => validateTournamentCandidateManifest(undeclared), /undeclared or missing operation/);
});

test("R25 rejects undeclared missing source segment", () => {
  const value = candidateManifest();
  value.operationGraph.sourceCoverage.gaps = [{ startMs: 1000, endMs: 1200 }];
  value.operationGraphDigest = fingerprint(value.operationGraph);
  assert.throws(() => validateTournamentCandidateManifest(value), /omits a primary-source segment/);
});

test("R25 bracket rejects duplicate candidate bytes", () => {
  const a = candidateManifest({ id: "a", renderSha: SHA("c") });
  const b = candidateManifest({ id: "b", renderSha: SHA("c") });
  assert.throws(() => buildTournamentBracket([a, b], { tournamentId: "r25-test", roundNumber: 0 }), /byte-identical/);
});

test("R25 bracket sealed mapping fails closed if swapped without digest refresh", () => {
  const manifests = [
    candidateManifest({ id: "a", renderSha: SHA("1") }),
    candidateManifest({ id: "b", renderSha: SHA("2") }),
    candidateManifest({ id: "c", renderSha: SHA("3") }),
    candidateManifest({ id: "d", renderSha: SHA("4") })
  ];
  const bracket = buildTournamentBracket(manifests, { tournamentId: "r25-test", roundNumber: 0 });
  assert.equal(bracket.matches.filter((x) => x.stage === "semifinal").length, 2);
  assert.equal(bracket.matches.filter((x) => x.stage === "final").length, 1);
  const tampered = structuredClone(bracket);
  tampered.sealedMapping.entries.reverse();
  assert.throws(() => validateTournamentBracket(tampered), /sealed mapping digest mismatch/);
});

test("R25 crash restart resets running candidate 3 only and preserves completed siblings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "r25-restart-"));
  const request = {
    contractVersion: MEDIA_CANDIDATE_BATCH_VERSION,
    batchId: "r25-four",
    source: { sourceId: "source-1", sha256: SHA("a"), size: 100 },
    renderer: { configDigest: candidateRendererConfigDigest({ maxParallel: 2 }) },
    candidates: [1,2,3,4].map((i) => ({
      candidateId: `candidate-${i}`,
      plan: {
        timeline: {
          id: `p-${i}`,
          version: 1,
          profileVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
          canvas: { width: 1080, height: 1920, fps: 30, durationMs: 5000 },
          tracks: [{
            id: "video", kind: "video", items: [{
              id: "v", startMs: 0, endMs: 5000, role: "body",
              source: { id: "source-1", uri: "source.mp4", inMs: 0, outMs: 5000, sha256: SHA("a"), size: 100 },
              ...(i === 2 ? { motion: { type: "punch_in", zoom: 1.04 } } : {}),
              ...(i === 3 ? { fadeInMs: 80 } : {}),
              ...(i === 4 ? { reframe: { x: "0", y: "0" } } : {})
            }]
          }]
        },
        exportSpec: {}
      }
    }))
  };
  const filePath = path.join(root, "state.json");
  const store = new PersistentCandidateBatchStore({ filePath });
  store.initialize(request, GIT("1"));
  store.putCandidate("candidate-1", { status: "succeeded", result: { status: "succeeded" } });
  store.putCandidate("candidate-2", { status: "succeeded", result: { status: "succeeded" } });
  store.putCandidate("candidate-3", { status: "running" });
  const recovered = new PersistentCandidateBatchStore({ filePath }).get();
  assert.equal(recovered.candidates["candidate-1"].status, "succeeded");
  assert.equal(recovered.candidates["candidate-2"].status, "succeeded");
  assert.equal(recovered.candidates["candidate-3"].status, "pending");
  assert.equal(recovered.candidates["candidate-4"].status, "pending");
});

test("R25 targeted re-edit rejects stale Growth directive evidence", () => {
  const baseline = candidateManifest({ id: "baseline", round: 0, renderSha: SHA("c"), renderSize: 1000 });
  const challenger = candidateManifest({ id: "challenger", round: 1, renderSha: SHA("d"), renderSize: 1100 });
  const app = application({ baselineSha: baseline.render.sha256, challengerSha: challenger.render.sha256 });
  assert.throws(() => validateTargetedTournamentReedit({
    baselineManifest: baseline,
    challengerManifest: challenger,
    application: app,
    priorReview: {
      selectedCandidateId: "baseline",
      reviewPackageDigest: SHA("e"),
      growthHandoffDigest: SHA("f"),
      directiveDigest: app.directiveDigest
    },
    baselineTimeline: baseRequest().baseTimeline,
    challengerTimeline: baseRequest().baseTimeline
  }), /stale/);
});

test("R25 targeted re-edit binds exact R19 application and emits unaffected-region evidence", () => {
  const baseline = candidateManifest({ id: "baseline", round: 0, renderSha: SHA("c"), renderSize: 1000 });
  const challenger = candidateManifest({ id: "challenger", round: 1, renderSha: SHA("d"), renderSize: 1100 });
  const app = application({ baselineSha: baseline.render.sha256, challengerSha: challenger.render.sha256 });
  const result = validateTargetedTournamentReedit({
    baselineManifest: baseline,
    challengerManifest: challenger,
    application: app,
    priorReview: {
      selectedCandidateId: "baseline",
      reviewPackageDigest: SHA("e"),
      growthHandoffDigest: app.handoff.digest,
      directiveDigest: app.directiveDigest
    },
    baselineTimeline: baseRequest().baseTimeline,
    challengerTimeline: baseRequest().baseTimeline
  });
  assert.equal(result.parentRound, 0);
  assert.equal(result.childRound, 1);
  assert.equal(result.humanQuality, false);
  assert.equal(result.unaffectedRegionEvidence.method, "normalized-source-window-lineage-outside-declared-edit-intervals");
});

test("R25 rejects candidate round above two", () => {
  const value = candidateManifest({ round: 3 });
  assert.throws(() => validateTournamentCandidateManifest(value), /roundNumber must be 0, 1 or 2/);
});

test("R25 unaffected-region evidence explicitly avoids pixel-identity claims", () => {
  const evidence = buildUnaffectedRegionEvidence({
    baselineTimeline: baseRequest().baseTimeline,
    challengerTimeline: baseRequest().baseTimeline,
    applications: [{
      operation: "cut",
      originalInterval: { startMs: 1000, endMs: 1200 }
    }]
  });
  assert.match(evidence.limitation, /does not claim pixel identity/);
});


test("R25 conformance manifest pins exact implementation and accepted R24 authority", () => {
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(
    new URL("../conformance/media.edit_tournament.r25.v1/manifest.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion, "media.edit_tournament.r25.v1");
  assert.equal(manifest.acceptedR24Authority.producerSha, "244acdf154741e669991b17df3ef2a47e2dfdfa9");
  assert.equal(manifest.acceptedR24Authority.ciRunId, 37195239582);
  assert.equal(manifest.acceptedR24Authority.artifactId, 11301055747);
  assert.equal(manifest.acceptedR24Authority.artifactDigest, "sha256:fc5c9b9635d49b643e66efafe602d21ce1ef695a553f81a797bdf16d7b8cf228");
  for (const [name, pin] of Object.entries(manifest.pins)) {
    if (name === "tests") continue;
    const actual = execFileSync("git", ["hash-object", pin.path], { cwd: repoRoot, encoding: "utf8" }).trim();
    assert.equal(actual, pin.gitBlobSha, name);
  }
  assert.match(manifest.pins.tests.gitBlobSha, /^[a-f0-9]{40}$/);
  assert.equal(manifest.modelReviewPerformed, false);
  assert.equal(manifest.providerPublish, false);
  assert.equal(manifest.humanQuality, false);
});


test("R25 external umbrella is the only Hard Wave authority and exact-maps internal contracts", () => {
  const authority = buildMulticandidateRoundAuthority({
    producerSha: GIT("1"),
    implementationBlobs: {
      tournamentImplementation: GIT("2"),
      umbrellaImplementation: GIT("3"),
      runner: GIT("4"),
      phaseMaterializer: GIT("5"),
      rehearsal: GIT("6"),
      verifier: GIT("7"),
      externalContract: GIT("8"),
      externalSchema: GIT("9")
    }
  });
  assert.equal(authority.contractVersion, MEDIA_MULTICANDIDATE_ROUND_VERSION);
  assert.equal(authority.internalContracts.request, MEDIA_TOURNAMENT_REQUEST_VERSION);
  assert.equal(authority.internalContracts.candidateManifest, MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION);
  assert.equal(authority.externalAuthorityOnly, true);
  assert.equal(authority.internalContractMayMasqueradeAsUmbrella, false);

  const tamperedMap = structuredClone(authority);
  tamperedMap.internalContracts.request = "media.candidate_batch.v1";
  assert.throws(() => validateMulticandidateRoundAuthority(tamperedMap), /map exactly/);

  const tamperedR24 = structuredClone(authority);
  tamperedR24.acceptedR24Authority.artifactDigest = "sha256:" + SHA("9");
  assert.throws(() => validateMulticandidateRoundAuthority(tamperedR24), /R24 authority mismatch/);

  assert.throws(
    () => validateMulticandidateRoundAuthority({ contractVersion: MEDIA_TOURNAMENT_REQUEST_VERSION }),
    /cannot masquerade as external umbrella authority/
  );
});

test("R25 restart after candidate 2 of 4 reuses completed hashes and resumes only unfinished candidates", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "r25-resume-"));
  const tournament = baseRequest();
  const plans = buildTournamentCandidatePlans(tournament);
  const request = {
    contractVersion: MEDIA_CANDIDATE_BATCH_VERSION,
    batchId: "r25-resume-four",
    source: {
      sourceId: tournament.source.sourceId,
      sha256: tournament.source.sha256,
      size: tournament.source.size
    },
    renderer: { configDigest: candidateRendererConfigDigest({ maxParallel: 2 }) },
    candidates: plans.map((entry) => ({
      candidateId: entry.candidateId,
      plan: entry.plan
    }))
  };
  const storePath = path.join(root, "candidate-batch-state.json");
  const cachePath = path.join(root, "candidate-cache.json");
  const producerSha = GIT("1");
  const seedStore = new PersistentCandidateBatchStore({ filePath: storePath });
  const seeded = seedStore.initialize(request, producerSha);

  const seededHashes = new Map();
  for (let i = 0; i < 2; i += 1) {
    const candidate = request.candidates[i];
    const renderSha256 = String(i + 1).repeat(64);
    seededHashes.set(candidate.candidateId, renderSha256);
    seedStore.putCandidate(candidate.candidateId, {
      status: "succeeded",
      reused: false,
      failure: null,
      result: {
        status: "succeeded",
        final: {
          sha256: renderSha256,
          size: 1000 + i,
          renderExportSha256: String(i + 5).repeat(64)
        }
      }
    });
  }
  seedStore.putCandidate(request.candidates[2].candidateId, { status: "running", attempts: 1 });
  seedStore.putCandidate(request.candidates[3].candidateId, { status: "pending" });

  const recovered = new PersistentCandidateBatchStore({ filePath: storePath });
  assert.equal(recovered.get().candidates[request.candidates[2].candidateId].status, "pending");

  const executed = [];
  const runtime = new CandidateBatchRuntime({
    store: recovered,
    cache: new PersistentCandidateCache({ filePath: cachePath }),
    producerSha,
    maxParallel: 2,
    detectSource: async () => ({
      sha256: tournament.source.sha256,
      size: tournament.source.size
    }),
    validateCachedCandidate: async (result) => result,
    executeCandidate: async ({ candidate }) => {
      executed.push(candidate.candidateId);
      const index = request.candidates.findIndex((entry) => entry.candidateId === candidate.candidateId);
      return {
        status: "succeeded",
        final: {
          sha256: String(index + 1).repeat(64),
          size: 1000 + index,
          renderExportSha256: String(index + 5).repeat(64)
        }
      };
    }
  });
  const result = await runtime.run(request);
  assert.equal(result.metrics.cacheHits, 2);
  assert.equal(result.metrics.renderCalls, 2);
  assert.deepEqual(executed.sort(), request.candidates.slice(2).map((x) => x.candidateId).sort());
  for (const [candidateId, renderSha256] of seededHashes) {
    const terminal = result.manifest.candidates.find((entry) => entry.candidateId === candidateId);
    assert.equal(terminal.final.sha256, renderSha256);
  }
  assert.equal(result.manifest.status, "succeeded");
  assert.equal(seeded.requestDigest, result.state.requestDigest);
});


test("R25 external umbrella conformance manifest pins exact mappings and implementation blobs", () => {
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(
    new URL("../conformance/media.multicandidate_round.r25.v1/manifest.json", import.meta.url),
    "utf8"
  ));
  assert.equal(manifest.contractVersion, MEDIA_MULTICANDIDATE_ROUND_VERSION);
  assert.equal(manifest.internalContractMap.request, MEDIA_TOURNAMENT_REQUEST_VERSION);
  assert.equal(manifest.internalContractMap.candidateManifest, MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION);
  assert.equal(manifest.acceptedR24Authority.artifactId, 11301055747);
  assert.equal(
    manifest.acceptedR24Authority.artifactDigest,
    "sha256:fc5c9b9635d49b643e66efafe602d21ce1ef695a553f81a797bdf16d7b8cf228"
  );
  assert.equal(manifest.externalAuthorityOnly, true);
  assert.equal(manifest.internalContractMayMasqueradeAsUmbrella, false);
  assert.equal(manifest.ciReliability.expensiveMaterializationsPerEvidenceJob, 1);
  assert.equal(manifest.ciReliability.postMaterializationVerificationRerenders, 0);
  for (const [name, pin] of Object.entries(manifest.pins)) {
    if (name === "tests") continue;
    const actual = execFileSync("git", ["hash-object", pin.path], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    assert.equal(actual, pin.gitBlobSha, name);
  }
  assert.throws(
    () => validateMulticandidateRoundAuthority({ contractVersion: MEDIA_TOURNAMENT_CANDIDATE_MANIFEST_VERSION }),
    /cannot masquerade as external umbrella authority/
  );
});
