import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildR25Candidate4Decomposition,
  buildTournamentCandidatePlans,
  compileFfmpegCommand,
  fingerprint,
  sliceTimelineForR25Checkpoint,
  stableStringify
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputRoot = path.resolve(process.env.R25_BENCHMARK_INPUT_ROOT ?? path.join(repoRoot, ".artifacts", "r25-benchmark-input"));
const outputRoot = path.resolve(process.env.R25_BENCHMARK_OUTPUT_ROOT ?? path.join(repoRoot, ".artifacts", "r25-render-benchmark"));

const FROZEN = Object.freeze({
  headSha: "00319d5795daa5a38260e309102866eec476cb0b",
  runId: 37246071924,
  candidate3ArtifactId: 11319501040,
  candidate3ArtifactDigest: "sha256:f58a92c2a88b4bf0436e66b3e3f1be9d70a6254e9a5842fe6571751892dc54e8",
  requestSha256: "0b8f5b8d46b1854534163f8ff836c40bc73d919ee0242938302ba161ff0af076",
  sourceSha256: "0828975570c9df9e3590f8f56e6776b968d0930bb0117b4bc8feb07259ef1657",
  sourceSize: 117594,
  runtimeManifestSha256: "9a49ca2fdc1e0b72186e981ecc617363cbd767ae24d28ee4c93478e59705009f",
  sourceCodeBlobs: {
    tournament: "b6ba243e7954d35ecb2a6d81ee17893f9df781d1",
    creativePlan: "3784ddfd1f8c569a68f041a8fe937da30cc24d43",
    checkpoint: "9c1f848a34277b0968e8227b7e8a3d724d8ddd9e",
    ffmpeg: "d4b29dc95f2cd1c88e26f0db7d794bd45edf19f0"
  }
});

const POLICY = Object.freeze({
  contractVersion: "media.r25.render_path_benchmark.v1",
  repetitionsPerStrategy: 2,
  invocationTimeoutMs: 20000,
  passTargetMs: 15000,
  warnCeilingMs: 20000,
  frameEquivalence: {
    reference: "filter-only rawvideo NUT from exact frozen segment-1 video graph",
    decodedPixelSampleStride: 32,
    minPsnrDb: 35,
    maxMeanAbsoluteError: 4.0,
    exactFrameCountRequired: true,
    exactGeometryRequired: true
  },
  selectionRule: {
    rejectOn: [
      "authority_or_lineage_mismatch",
      "technical_geometry_failure",
      "visual_semantic_equivalence_failure",
      "non_deterministic_repetition",
      "missing_reusable_audio_evidence_for_video_only_strategy"
    ],
    winner: "fastest eligible strategy whose two repetitions are both <=15000ms; rank by worst repetition then mean",
    none: "BLOCKED_PERFORMANCE"
  },
  strategies: [
    { id: "BASELINE_FULL_SINGLE_THREAD", audioHandlingClass: "full_per_segment", threads: { encoder: 1, filter: "current-default" } },
    { id: "FULL_BOUNDED_THREADS", audioHandlingClass: "full_per_segment", threads: { encoder: 2, filter: 2 } },
    { id: "VIDEO_ONLY_SEGMENT", audioHandlingClass: "video_only_segment_audio_once_at_final_assembly", threads: { encoder: 1, filter: "current-default" } },
    { id: "OPTIMIZED_MOTION_PATH", audioHandlingClass: "full_per_segment", threads: { encoder: 2, filter: 2 } },
    { id: "VIDEO_ONLY_BOUNDED_THREADS", audioHandlingClass: "video_only_segment_audio_once_at_final_assembly", threads: { encoder: 2, filter: 2 } }
  ]
});

const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
function hashFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const bytes = readFileSync(filePath);
  return { sha256: hashBytes(bytes), size: bytes.length };
}
function writeStable(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.from(stableStringify(value) + "\n");
  writeFileSync(filePath, bytes);
  return { sha256: hashBytes(bytes), size: bytes.length };
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const seconds = (ms) => (ms / 1000).toFixed(3);
function parseRate(value) {
  const [n, d] = String(value ?? "").split("/").map(Number);
  return Number.isFinite(n) && Number.isFinite(d) && d ? Number((n / d).toFixed(6)) : null;
}
function ffprobeFacts(filePath) {
  const r = spawnSync("ffprobe", ["-v","error","-show_entries","stream=codec_type,width,height,r_frame_rate,duration:format=duration","-of","json",filePath], {
    cwd: inputRoot, env: process.env, encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 8*1024*1024
  });
  if (r.status !== 0) return { probePassed: false, stderr: String(r.stderr ?? "").slice(-4000) };
  const p = JSON.parse(r.stdout);
  const video = (p.streams ?? []).find(x => x.codec_type === "video");
  const audio = (p.streams ?? []).find(x => x.codec_type === "audio");
  const formatMs = Math.round(Number(p.format?.duration ?? 0) * 1000);
  return {
    probePassed: true,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseRate(video?.r_frame_rate),
    durationMs: formatMs,
    videoDurationMs: video?.duration ? Math.round(Number(video.duration)*1000) : formatMs,
    audioDurationMs: audio?.duration ? Math.round(Number(audio.duration)*1000) : (audio ? formatMs : null)
  };
}
function normalizedCommandDigest(command) {
  const args=[...command.args]; if(args.length) args[args.length-1]="<OUTPUT>";
  return fingerprint({binary:command.binary,args});
}
function runInvocation(command, outputPath, timeoutMs=POLICY.invocationTimeoutMs) {
  if(outputPath) rmSync(outputPath,{force:true});
  const start=process.hrtime.bigint();
  const r=spawnSync(command.binary,command.args,{
    cwd:inputRoot,env:process.env,encoding:"buffer",timeout:timeoutMs,killSignal:"SIGTERM",windowsHide:true,maxBuffer:16*1024*1024
  });
  const wallMs=Number(process.hrtime.bigint()-start)/1e6;
  const classification=r.error?.code==="ETIMEDOUT"?"TIMEOUT":r.status===0?"SUCCESS":"EXIT_NONZERO";
  const rec={
    classification,wallMs:Number(wallMs.toFixed(3)),status:r.status,signal:r.signal??null,errorCode:r.error?.code??null,
    stderrTail:Buffer.isBuffer(r.stderr)?r.stderr.toString("utf8").slice(-4000):String(r.stderr??"").slice(-4000),
    commandConfigDigest:normalizedCommandDigest(command),
    invocationDigest:fingerprint({binary:command.binary,args:command.args})
  };
  if(classification==="SUCCESS"&&outputPath&&existsSync(outputPath)){rec.output=hashFile(outputPath);rec.ffprobe=ffprobeFacts(outputPath);}
  else if(outputPath) rmSync(outputPath,{force:true});
  return rec;
}
function setBoundedThreads(command,count){
  const out={binary:command.binary,args:[...command.args]};
  const ti=out.args.lastIndexOf("-threads"); if(ti<0) throw new Error("missing -threads"); out.args[ti+1]=String(count);
  const fc=out.args.indexOf("-filter_complex"); if(fc<0) throw new Error("missing -filter_complex");
  out.args.splice(fc,0,"-filter_threads",String(count),"-filter_complex_threads",String(count));
  return out;
}
function videoOnlyTimeline(timeline){const out=clone(timeline);out.tracks=out.tracks.filter(t=>t.kind!=="audio");return out;}
function buildReferenceCommand(videoCommand,outputPath){
  const ti=videoCommand.args.indexOf("-t"); if(ti<0) throw new Error("missing -t");
  return {binary:videoCommand.binary,args:[...videoCommand.args.slice(0,ti),"-t",videoCommand.args[ti+1],"-r","30","-map_metadata","-1","-threads","1","-c:v","rawvideo","-pix_fmt","yuv420p","-an","-f","nut",outputPath]};
}
function optimizedMotionCommand(fullCommand){
  const out=setBoundedThreads(fullCommand,2);
  const fc=out.args.indexOf("-filter_complex");
  const before=out.args[fc+1];
  const after=before.replace(/s=1080x1920:fps=30,fps=30,setsar=1,settb=AVTB/g,"s=540x960:fps=30,scale=1080:1920:flags=bicubic,setsar=1,settb=AVTB");
  if(after===before) throw new Error("expected frozen zoompan+fps pattern");
  out.args[fc+1]=after; return out;
}
function buildReusableAudioCommand(timeline,exportSpec,outputPath){
  const items=timeline.tracks.filter(t=>t.kind==="audio").flatMap(t=>t.items).sort((a,b)=>a.startMs-b.startMs||a.id.localeCompare(b.id));
  if(items.length!==1) throw new Error(`benchmark frozen candidate-4 expected one audio item, got ${items.length}`);
  const item=items[0];
  if((item.speed??1)!==1||item.duckUnderVoice===true) throw new Error("benchmark frozen audio shape changed");
  const loud=exportSpec.loudness??{integratedLufs:-16,truePeakDb:-1.5,lra:11};
  const duration=item.endMs-item.startMs;
  const filter=`[0:a]atrim=start=${seconds(item.source.inMs??0)}:duration=${seconds(duration)},asetpts=PTS-STARTPTS,adelay=${item.startMs}|${item.startMs},volume=${item.gainDb??0}dB,loudnorm=I=${loud.integratedLufs??-16}:TP=${loud.truePeakDb??-1.5}:LRA=${loud.lra??11},aresample=48000[anorm]`;
  return {binary:"ffmpeg",args:["-hide_banner","-nostdin","-y","-i",item.source.uri,"-filter_complex",filter,"-map","[anorm]","-t",seconds(timeline.canvas.durationMs),"-map_metadata","-1","-metadata","creation_time=1970-01-01T00:00:00Z","-fflags","+bitexact","-threads","1","-vn","-c:a",exportSpec.audioCodec??"aac","-b:a",exportSpec.audioBitrate??"192k","-f","mp4",outputPath]};
}
function decodeRawVideo(filePath){
  const r=spawnSync("ffmpeg",["-v","error","-i",filePath,"-map","0:v:0","-an","-pix_fmt","yuv420p","-f","rawvideo","-"],{
    cwd:inputRoot,env:process.env,encoding:"buffer",timeout:10000,killSignal:"SIGTERM",windowsHide:true,maxBuffer:96*1024*1024
  });
  if(r.status!==0) return {ok:false,error:Buffer.from(r.stderr??"").toString("utf8").slice(-4000)};
  return {ok:true,bytes:Buffer.from(r.stdout)};
}
function semanticComparison(referenceBytes,outputPath){
  const d=decodeRawVideo(outputPath); if(!d.ok) return {passed:false,reason:"decode_failed",error:d.error};
  if(d.bytes.length!==referenceBytes.length) return {passed:false,reason:"decoded_length_mismatch",referenceBytes:referenceBytes.length,actualBytes:d.bytes.length};
  const stride=POLICY.frameEquivalence.decodedPixelSampleStride; let samples=0,abs=0,sq=0;
  for(let i=0;i<referenceBytes.length;i+=stride){const delta=referenceBytes[i]-d.bytes[i];abs+=Math.abs(delta);sq+=delta*delta;samples++;}
  const mae=abs/samples,mse=sq/samples,psnr=mse===0?Infinity:10*Math.log10(65025/mse);
  return {passed:psnr>=POLICY.frameEquivalence.minPsnrDb&&mae<=POLICY.frameEquivalence.maxMeanAbsoluteError,sampledBytes:samples,stride,meanAbsoluteError:Number(mae.toFixed(6)),psnrDb:Number.isFinite(psnr)?Number(psnr.toFixed(6)):"Infinity"};
}

rmSync(outputRoot,{recursive:true,force:true}); mkdirSync(outputRoot,{recursive:true});
const requestPath=path.join(inputRoot,"request.json"),sourcePath=path.join(inputRoot,"source.mp4"),manifestPath=path.join(inputRoot,"ci-ffmpeg-runtime","runtime.manifest.sha256");
const requestIdentity=hashFile(requestPath),sourceIdentity=hashFile(sourcePath),runtimeManifestIdentity=hashFile(manifestPath);
if(requestIdentity.sha256!==FROZEN.requestSha256) throw new Error("frozen request SHA mismatch");
if(sourceIdentity.sha256!==FROZEN.sourceSha256||sourceIdentity.size!==FROZEN.sourceSize) throw new Error("frozen source mismatch");
if(runtimeManifestIdentity.sha256!==FROZEN.runtimeManifestSha256) throw new Error("frozen runtime manifest mismatch");
const request=JSON.parse(readFileSync(requestPath,"utf8"));
const planEntry=buildTournamentCandidatePlans(request).find(x=>x.candidateId==="candidate-4");
if(!planEntry) throw new Error("candidate-4 plan missing");
const decomposition=buildR25Candidate4Decomposition({
  tournamentId:request.tournamentId,candidateId:"candidate-4",producerSha:FROZEN.headSha,
  source:{sourceId:request.source.sourceId,sha256:request.source.sha256,size:request.source.size},
  operationGraphDigest:planEntry.operationGraphDigest,runtimeManifestSha256:runtimeManifestIdentity.sha256,timeline:planEntry.plan.timeline
});
const segment=decomposition.segments[0];
if(segment.phase!=="segment-1"||segment.startMs!==0||segment.endMs!==400) throw new Error("frozen segment-1 changed");
const segmentTimeline=sliceTimelineForR25Checkpoint(planEntry.plan.timeline,0,400);
const segmentVideoOnly=videoOnlyTimeline(segmentTimeline);
const policy={...clone(POLICY),frozenAuthority:clone(FROZEN),exactInput:{
  request:requestIdentity,source:sourceIdentity,runtimeManifest:runtimeManifestIdentity,tournamentId:request.tournamentId,candidateId:"candidate-4",
  operationGraphDigest:planEntry.operationGraphDigest,fullTimelineDigest:decomposition.timelineDigest,segmentTimelineDigest:segment.segmentTimelineDigest,
  segmentOperationId:segment.operationId,decompositionDigest:decomposition.decompositionDigest,segment:{startMs:0,endMs:400},geometry:{width:1080,height:1920,fps:30}
},policyWrittenBeforeMeasurements:true};
const policyWrite=writeStable(path.join(outputRoot,"benchmark-policy.json"),policy);

const referencePath=path.join(outputRoot,"reference-video.nut");
const referenceCommand=buildReferenceCommand(compileFfmpegCommand(segmentVideoOnly,planEntry.plan.exportSpec,path.join(outputRoot,"unused.mp4")),referencePath);
const reference=runInvocation(referenceCommand,referencePath);
let referenceBytes=null;
if(reference.classification==="SUCCESS"){const d=decodeRawVideo(referencePath);if(d.ok){referenceBytes=d.bytes;reference.decodedRawSha256=hashBytes(referenceBytes);reference.decodedRawSize=referenceBytes.length;}else reference.decodeError=d.error;}

const audioPath=path.join(outputRoot,"candidate-4-reusable-audio.m4a");
const audioEvidence=runInvocation(buildReusableAudioCommand(planEntry.plan.timeline,planEntry.plan.exportSpec,audioPath),audioPath);
if(audioEvidence.classification==="SUCCESS"){audioEvidence.audioHandlingClass="generated_once_source_bound_reusable_final_mux_evidence";audioEvidence.source=sourceIdentity;audioEvidence.fullTimelineDigest=decomposition.timelineDigest;}

const builders={
  BASELINE_FULL_SINGLE_THREAD:(out)=>compileFfmpegCommand(segmentTimeline,planEntry.plan.exportSpec,out),
  FULL_BOUNDED_THREADS:(out)=>setBoundedThreads(compileFfmpegCommand(segmentTimeline,planEntry.plan.exportSpec,out),2),
  VIDEO_ONLY_SEGMENT:(out)=>compileFfmpegCommand(segmentVideoOnly,planEntry.plan.exportSpec,out),
  OPTIMIZED_MOTION_PATH:(out)=>optimizedMotionCommand(compileFfmpegCommand(segmentTimeline,planEntry.plan.exportSpec,out)),
  VIDEO_ONLY_BOUNDED_THREADS:(out)=>setBoundedThreads(compileFfmpegCommand(segmentVideoOnly,planEntry.plan.exportSpec,out),2)
};
const strategyResults=[];
for(const declared of POLICY.strategies){
  const reps=[];
  for(let rep=1;rep<=2;rep++){
    const out=path.join(outputRoot,"outputs",declared.id,`rep-${rep}.mp4`);mkdirSync(path.dirname(out),{recursive:true});
    let cmd;try{cmd=builders[declared.id](out);}catch(e){reps.push({repetition:rep,classification:"CONFIGURATION_ERROR",wallMs:0,error:String(e?.stack??e)});continue;}
    const rec=runInvocation(cmd,out);rec.repetition=rep;rec.audioHandlingClass=declared.audioHandlingClass;rec.cpuThreadSettings=clone(declared.threads);
    if(rec.classification==="SUCCESS"&&rec.output){
      const f=rec.ffprobe;
      rec.geometryPassed=Boolean(f?.probePassed&&f.hasVideo===true&&f.width===1080&&f.height===1920&&Math.abs((f.fps??0)-30)<0.01&&(f.videoDurationMs??0)>=350&&(f.videoDurationMs??Infinity)<=500);
      const videoOnly=declared.audioHandlingClass.startsWith("video_only");
      rec.audioClassPassed=videoOnly?f.hasAudio===false:f.hasAudio===true;
      rec.semanticComparison=referenceBytes?semanticComparison(referenceBytes,out):{passed:false,reason:"reference_unavailable"};
    }
    reps.push(rec);
  }
  const success=reps.filter(x=>x.classification==="SUCCESS");
  const byteStable=success.length===2&&success[0].output?.sha256===success[1].output?.sha256&&success[0].output?.size===success[1].output?.size;
  const sameConfig=reps[0]?.commandConfigDigest&&reps[0].commandConfigDigest===reps[1]?.commandConfigDigest;
  const geometryPassed=success.length===2&&success.every(x=>x.geometryPassed===true);
  const audioClassPassed=success.length===2&&success.every(x=>x.audioClassPassed===true);
  const semanticsPassed=referenceBytes!==null&&success.length===2&&success.every(x=>x.semanticComparison?.passed===true);
  const reusableAudioPassed=!declared.audioHandlingClass.startsWith("video_only")||audioEvidence.classification==="SUCCESS";
  const eligible=success.length===2&&byteStable&&sameConfig&&geometryPassed&&audioClassPassed&&semanticsPassed&&reusableAudioPassed;
  const walls=reps.map(x=>x.wallMs);
  const pass=eligible&&walls.every(x=>x<=POLICY.passTargetMs),warn=eligible&&walls.every(x=>x<=POLICY.warnCeilingMs);
  strategyResults.push({id:declared.id,declared,repetitions:reps,determinism:{byteStable,sameConfig,repeatedOutputSha256:byteStable?success[0].output.sha256:null},equivalence:{geometryPassed,audioClassPassed,semanticsPassed,reusableAudioPassed},eligible,performanceClass:pass?"PASS":warn?"WARN":"FAIL",maxWallMs:Math.max(...walls),meanWallMs:Number((walls.reduce((a,b)=>a+b,0)/walls.length).toFixed(3))});
}
const qualifiers=strategyResults.filter(x=>x.eligible&&x.repetitions.every(r=>r.wallMs<=POLICY.passTargetMs)).sort((a,b)=>a.maxWallMs-b.maxWallMs||a.meanWallMs-b.meanWallMs||a.id.localeCompare(b.id));
const winner=qualifiers[0]??null;
const selection=winner?{status:"WINNER_SELECTED",strategyId:winner.id,maxWallMs:winner.maxWallMs,meanWallMs:winner.meanWallMs,reason:"fastest eligible strategy with both repetitions <=15s under frozen policy"}:{status:"BLOCKED_PERFORMANCE",strategyId:null,reason:"no eligible strategy produced two repetitions <=15s; no implementation commit is authorized"};
const result={contractVersion:"media.r25.render_path_benchmark_result.v1",benchmarkProducerSha:process.env.GITHUB_SHA??null,frozenHead:FROZEN.headSha,frozenRunId:FROZEN.runId,policySha256:policyWrite.sha256,policy,reference,reusableAudioEvidence:audioEvidence,strategies:strategyResults,selection,baselineTimeoutIsValidEvidence:true,modelReviewPerformed:false,providerPublish:false,humanQuality:false};
const resultWrite=writeStable(path.join(outputRoot,"benchmark-result.json"),result);writeStable(path.join(outputRoot,"selection.json"),selection);
console.log("R25_RENDER_BENCHMARK",stableStringify({benchmarkProducerSha:result.benchmarkProducerSha,policySha256:policyWrite.sha256,resultSha256:resultWrite.sha256,reference:{classification:reference.classification,wallMs:reference.wallMs},audio:{classification:audioEvidence.classification,wallMs:audioEvidence.wallMs},strategies:strategyResults.map(x=>({id:x.id,eligible:x.eligible,performanceClass:x.performanceClass,wallsMs:x.repetitions.map(r=>r.wallMs),classifications:x.repetitions.map(r=>r.classification),repeatedOutputSha256:x.determinism.repeatedOutputSha256})),selection}));
