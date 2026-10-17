// Declarative scene materialization; final assembly reuses Media's Timeline compiler.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {compileFfmpegCommand, captionsToSrt} from './ffmpeg.js';
import {canonicalizeTimeline} from './timeline.js';

const MODES = new Set(['illustration','motion_graphics','kinetic_text','library_video','code_animation']);
const MOTIONS = new Set(['push_in','pull_out','pan_left','pan_right','graphic_build','text_reveal','source_motion','procedural_motion']);
const PRESETS = new Set(['cards','comparison','steps','stat','signal']);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const fileHash = name => hash(fs.readFileSync(name));
const assert = (ok, reason) => {if (!ok) throw Error(reason);};
const finite = (v,a,b) => typeof v === 'number' && Number.isFinite(v) && v>=a && v<=b;
const wrap = (text,n=28) => String(text).split('\n').map(p=>p.split(/\s+/).reduce((a,w)=>{if(!a.length||a.at(-1).length+w.length+1>n)a.push(w);else a[a.length-1]+=' '+w;return a;},[]).join('\n')).join('\n');

function run(binary,args,cwd,log,stderr=false) {
  const result=spawnSync(binary,args,{cwd,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:8*1024*1024});
  fs.appendFileSync(log,JSON.stringify({binary,args})+'\n'+(result.stderr??'')+'\n');
  if(result.error||result.status!==0)throw Error(`${binary} failed: ${String(result.error?.message??result.stderr).slice(-1200)}`);
  return stderr?result.stderr:result.stdout;
}
function audioQa(output,log) {
  const measured=run('ffmpeg',['-hide_banner','-nostdin','-i','final.mp4','-vn','-af','loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json','-f','null','-'],output,log,true);
  const match=measured.match(/\{\s*"input_i"[\s\S]*?\}/);
  assert(match,'Audio analysis did not return loudness');
  const raw=JSON.parse(match[0]), integrated_lufs=Number(raw.input_i), true_peak_dbfs=Number(raw.input_tp);
  assert(finite(integrated_lufs,-19,-13)&&finite(true_peak_dbfs,-80,-.5),'Audio is silent, too loud, or outside export limits');
  return {passed:true,integrated_lufs,true_peak_dbfs,loudness_range:Number(raw.input_lra)};
}
function probe(file,cwd,log){return JSON.parse(run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],cwd,log));}
function source(asset) {
  assert(asset && path.isAbsolute(asset.path) && /^[a-f0-9]{64}$/.test(asset.sha256),'Asset needs absolute path and SHA256');
  assert(fs.existsSync(asset.path)&&fileHash(asset.path)===asset.sha256,'Asset is missing or changed');
  return asset.path;
}
function fontfile() {
  const font=process.platform==='win32'?path.join(process.env.WINDIR??'C:\\Windows','Fonts','arialbd.ttf'):'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  assert(fs.existsSync(font),'Explicit font file is required');
  return font.replaceAll('\\','/').replaceAll(':','\\:');
}
function drawText(folder,name,value,size,x,y,color,options='') {
  assert(typeof value==='string'&&value.length<=300&&!/[\u0000-\u0008\u000b-\u001f]/.test(value),'Invalid text');
  fs.writeFileSync(path.join(folder,name+'.txt'),value.replaceAll('\r',''),'utf8');
  return `drawtext=fontfile='${fontfile()}':textfile=${name}.txt:expansion=none:fontsize=${size}:line_spacing=12:fontcolor=${color}:x='${x}':y='${y}'${options}`;
}

export function validateShortsBundle(bundle) {
  assert(bundle.version===1 && typeof bundle.id==='string','Invalid Shorts bundle');
  assert(Array.isArray(bundle.scenes)&&bundle.scenes.length>=1&&bundle.scenes.length<=10,'Need 1-10 scenes');
  for(const c of ['background','foreground','accent'])assert(/^#[a-f0-9]{6}$/i.test(bundle.style?.[c]),'Invalid palette');
  const seen=new Set();
  for(const s of bundle.scenes) {
    assert(/^[a-z0-9-]{1,30}$/.test(s.beat_id)&&!seen.has(s.beat_id),'Invalid or duplicate scene ID');seen.add(s.beat_id);
    assert(MODES.has(s.mode)&&MOTIONS.has(s.motion),'Unsupported scene capability');
    assert(typeof s.screen_text==='string'&&s.screen_text.length>=1&&s.screen_text.length<=90,'Screen text limit');
    assert(typeof s.narration==='string'&&s.narration.length<=260,'Narration limit');
    assert(finite(s.voice.voice_seconds,.1,20)&&finite(s.lead_seconds,.05,.5)&&finite(s.tail_seconds,.05,.7),'Invalid measured voice timing');
    assert(['cut','fade'].includes(s.transition),'Invalid transition');
    assert(!s.requires_object_motion||['library_video','code_animation'].includes(s.mode),'Object action cannot be supplied by camera motion');
    if(s.mode==='code_animation')assert(s.motion==='procedural_motion'&&s.asset?.kind==='code_animation'&&typeof s.asset.source==='string'&&s.asset.source_sha256===hash(s.asset.source)&&s.asset.fps===30,'Animation needs authored source and verified render receipt');
    if(s.mode==='illustration')assert(['push_in','pull_out','pan_left','pan_right'].includes(s.motion),'Invalid illustration motion');
    if(s.mode==='library_video')assert(s.motion==='source_motion','Video needs real source motion');
    if(s.mode==='kinetic_text')assert(s.motion==='text_reveal','Invalid text motion');
    if(s.mode==='motion_graphics') {
      assert(s.motion==='graphic_build'&&PRESETS.has(s.preset),'Unsupported graphic preset');
      assert(Array.isArray(s.labels)&&s.labels.length>=1&&s.labels.length<=4&&s.labels.every(x=>typeof x==='string'&&x.length<=60),'Graphic labels limit');
    }
  }
  return bundle;
}

export function renderShorts(bundle,output) {
  validateShortsBundle(bundle);
  output=path.resolve(output);fs.mkdirSync(output,{recursive:true});
  const log=path.join(output,'render.log'), digest=hash(JSON.stringify(bundle));
  const receiptPath=path.join(output,'receipt.json');
  if(fs.existsSync(receiptPath)) {
    const old=JSON.parse(fs.readFileSync(receiptPath));
    assert(old.bundle_sha256===digest&&fileHash(path.join(output,'final.mp4'))===old.final.sha256,'Existing render differs');
    run('ffmpeg',['-v','error','-xerror','-i','final.mp4','-f','null','-'],output,log);
    return {...old,technical_qa:{...old.technical_qa,audio:audioQa(output,log)}};
  }
  const cache=path.resolve(output,'..','scene-cache');fs.mkdirSync(cache,{recursive:true});
  const bg=bundle.style.background.replace('#','0x'), fg=bundle.style.foreground.replace('#','0x'), accent=bundle.style.accent.replace('#','0x');
  const videoItems=[],audioItems=[],captions=[],scenes=[];
  let cursor=0;
  for(const scene of bundle.scenes) {
    source(scene.voice);
    const actualVoice=Number(probe(scene.voice.path,output,log).format.duration);
    assert(Math.abs(actualVoice-scene.voice.voice_seconds)<=.04,'Measured voice duration differs from file');
    if(['illustration','library_video','code_animation'].includes(scene.mode))source(scene.asset);
    const frames=Math.ceil((scene.lead_seconds+actualVoice+scene.tail_seconds)*30), duration=frames/30;
    if(scene.mode==='code_animation')assert(scene.asset.frames===frames,'Animation frames do not match measured voice');
    const sceneKey=hash(JSON.stringify({version:scene.mode==='code_animation'?2:1,scene,style:bundle.style,font_sha256:fileHash(process.platform==='win32'?path.join(process.env.WINDIR??'C:\\Windows','Fonts','arialbd.ttf'):'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')}));
    const folder=path.join(cache,sceneKey);fs.mkdirSync(folder,{recursive:true});
    const clip=path.join(folder,'clip.mp4'),marker=path.join(folder,'receipt.json');
    let reused=false;
    if(fs.existsSync(marker)) {
      const prior=JSON.parse(fs.readFileSync(marker));
      assert(prior.scene_sha256===sceneKey&&fileHash(clip)===prior.sha256,'Cached scene was modified');
      reused=true;
    } else {
      const args=['-v','warning','-nostdin','-y'];
      const filters=[];
      if(scene.mode==='code_animation') {
        args.push('-i',scene.asset.path);
        // Browser JPEG capture carries full-range/ICC metadata. Normalize the
        // actual pixels and discard the ICC side data before phone-compatible
        // limited-range H.264 assembly; format=yuv420p alone retains yuvj420p.
        filters.push('fps=30','scale=in_range=full:out_range=limited:out_color_matrix=bt709','sidedata=mode=delete:type=ICC_PROFILE','setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709');
      } else if(scene.mode==='illustration') {
        args.push('-i',scene.asset.path);
        const z=scene.motion==='pull_out'?`1.12-0.1*on/${frames}`:scene.motion==='push_in'?`1.02+0.1*on/${frames}`:'1.12';
        const x=scene.motion==='pan_left'?`(iw-iw/zoom)*(1-on/${frames})`:scene.motion==='pan_right'?`(iw-iw/zoom)*on/${frames}`:'iw/2-iw/zoom/2';
        filters.push('scale=1620:2880:force_original_aspect_ratio=increase','crop=1620:2880',`zoompan=z='${z}':x='${x}':y='ih/2-ih/zoom/2':d=${frames}:s=1080x1920:fps=30`);
      } else if(scene.mode==='library_video') {
        const info=probe(scene.asset.path,output,log);
        assert(Number(info.format.duration)>=duration,'Source video too short; no silent looping or still substitution');
        args.push('-i',scene.asset.path);
        filters.push('scale=1080:1920:force_original_aspect_ratio=increase','crop=1080:1920','fps=30');
      } else if(scene.mode!=='code_animation') {
        args.push('-f','lavfi','-i',`color=c=${bg}:s=1080x1920:r=30:d=${duration}`);
        filters.push(`drawbox=x=65:y=270:w=8:h=110:color=${accent}:t=fill`);
      }
      filters.push('setsar=1');
      if(scene.mode==='kinetic_text') {
        const lines=wrap(scene.screen_text,21).split('\n');
        assert(lines.length<=5,'Kinetic text does not fit safe area');
        lines.forEach((line,i)=>filters.push(drawText(folder,'word'+i,line,86,'(w-text_w)/2',`${650+i*135}+35*exp(-5*max(0,t-${i*.2}))`,i%2?accent:fg,`:alpha='min(1,max(0,(t-${i*.2})/.16))'`)));
      } else if(scene.mode!=='code_animation') {
        filters.push('drawbox=x=0:y=0:w=1080:h=500:color=black@0.4:t=fill');
        filters.push(drawText(folder,'title',wrap(scene.screen_text,25),68,85,285,fg,":shadowcolor=black@0.5:shadowy=3"));
      }
      if(scene.mode==='motion_graphics') {
        scene.labels.forEach((label,i)=>{
          const comparison=scene.preset==='comparison', x=comparison?85+(i%2)*465:85, y=comparison?650+Math.floor(i/2)*330:610+i*210;
          const width=comparison?435:910, start=.2+i*.3;
          filters.push(`drawbox=x=${x}:y=${y}:w=${width}:h=175:color=${accent}@0.18:t=fill:enable='gte(t,${start})'`);
          filters.push(`drawbox=x=${x}:y=${y}:w=6:h=175:color=${accent}:t=fill:enable='gte(t,${start})'`);
          const stat=scene.preset==='stat'&&i===0;
          filters.push(drawText(folder,'label'+i,wrap(label,comparison?14:30),stat?72:46,`${x+30}+25*exp(-6*max(0,t-${start}))`,y+45,fg,`:alpha='min(1,max(0,(t-${start})/.18))'`));
        });
      }
      // Finite progress segments provide visible movement without generated expressions.
      if(scene.mode!=='code_animation')for(let i=0;i<14;i++)filters.push(`drawbox=x=${85+i*65}:y=1680:w=55:h=6:color=${accent}:t=fill:enable='gte(t,${i*duration/14})'`);
      // Phrase timings are proportional estimates inside measured speech, not word alignment.
      const phrases=wrap(scene.narration,64).split('\n'), weight=phrases.reduce((n,p)=>n+p.length,0);
      let phraseStart=scene.lead_seconds;
      phrases.forEach((phrase,i)=>{
        const phraseEnd=phraseStart+actualVoice*phrase.length/weight;
        filters.push(drawText(folder,'subtitle'+i,wrap(phrase,36),42,'(w-text_w)/2',1480,fg,`:box=1:boxcolor=black@0.6:boxborderw=14:enable='between(t,${phraseStart},${phraseEnd})'`));
        phraseStart=phraseEnd;
      });
      if(scene.transition==='fade')filters.push('fade=t=in:st=0:d=0.08',`fade=t=out:st=${duration-.08}:d=.08`);
      filters.push('format=yuv420p');
      args.push('-vf',filters.join(','),'-t',String(duration),'-an','-c:v','libx264','-preset','veryfast','-crf','20','-threads','2','-movflags','+faststart','clip.mp4');
      run('ffmpeg',args,folder,log);
      run('ffmpeg',['-v','error','-xerror','-i','clip.mp4','-f','null','-'],folder,log);
      fs.writeFileSync(marker,JSON.stringify({scene_sha256:sceneKey,sha256:fileHash(clip)}));
    }
    const end=cursor+Math.round(duration*1000),startVoice=cursor+Math.round(scene.lead_seconds*1000),endVoice=startVoice+Math.round(actualVoice*1000);
    videoItems.push({id:scene.beat_id,startMs:cursor,endMs:end,source:{uri:clip,sha256:fileHash(clip)},role:scenes.length?'body':'intro'});
    audioItems.push({id:'voice-'+scene.beat_id,startMs:startVoice,endMs:endVoice,source:{uri:scene.voice.path,sha256:scene.voice.sha256},role:'voiceover',gainDb:0});
    captions.push({id:'caption-'+scene.beat_id,startMs:startVoice,endMs:endVoice,text:scene.narration});
    scenes.push({beat_id:scene.beat_id,start_seconds:cursor/1000,end_seconds:end/1000,mode:scene.mode,motion:scene.motion,cache_key:sceneKey,reused,clip_sha256:fileHash(clip),...(scene.mode==='code_animation'?{animation_source_sha256:scene.asset.source_sha256,animation_runtime:scene.asset.runtime}: {})});
    cursor=end;
  }
  assert(cursor<=90000,'Short exceeds 90 seconds');
  if(bundle.music)audioItems.push({id:'music',role:'music',startMs:0,endMs:cursor,source:{uri:source(bundle.music),sha256:bundle.music.sha256},gainDb:-14,duckUnderVoice:true});
  const timeline=canonicalizeTimeline({version:1,id:bundle.id,canvas:{width:1080,height:1920,fps:30,durationMs:cursor},tracks:[{id:'visuals',kind:'video',items:videoItems},{id:'sound',kind:'audio',items:audioItems}]});
  fs.writeFileSync(path.join(output,'timeline.json'),JSON.stringify(timeline,null,2));
  const command=compileFfmpegCommand(timeline,{preset:'veryfast',videoBitrate:'6M',loudness:{integratedLufs:-16,truePeakDb:-1.5,lra:9}},'final.mp4');
  run(command.binary,command.args,output,log);
  run('ffmpeg',['-v','error','-xerror','-i','final.mp4','-f','null','-'],output,log);
  const info=probe(path.join(output,'final.mp4'),output,log), v=info.streams.find(s=>s.codec_type==='video'),a=info.streams.find(s=>s.codec_type==='audio');
  const checks={h264:v?.codec_name==='h264',vertical_1080p:v?.width===1080&&v?.height===1920,pixel_format:v?.pix_fmt==='yuv420p',fps:v?.avg_frame_rate==='30/1',aac:a?.codec_name==='aac',duration:Math.abs(Number(info.format.duration)-cursor/1000)<.15,full_decode:true};
  assert(Object.values(checks).every(Boolean),'Technical QA failed: '+JSON.stringify(checks));
  const audio=audioQa(output,log);
  run('ffmpeg',['-v','error','-y','-i','final.mp4','-vf','scale=360:640','-c:v','libx264','-preset','veryfast','-crf','27','-c:a','aac','-movflags','+faststart','preview.mp4'],output,log);
  for(const [i,s] of scenes.entries())run('ffmpeg',['-v','error','-y','-ss',String((s.start_seconds+s.end_seconds)/2),'-i','final.mp4','-frames:v','1','-vf','scale=270:480',`frame-${i}.jpg`],output,log);
  run('ffmpeg',['-v','error','-y','-i','final.mp4','-vn','-ac','1','-ar','24000','review-audio.wav'],output,log);
  fs.writeFileSync(path.join(output,'subtitles.srt'),captionsToSrt({...timeline,tracks:[...timeline.tracks,{id:'captions',kind:'caption',items:captions}]}));
  const receipt={version:'media.dynamic-shorts.v1',bundle_sha256:digest,final:{path:path.join(output,'final.mp4'),sha256:fileHash(path.join(output,'final.mp4'))},preview:path.join(output,'preview.mp4'),audio:path.join(output,'review-audio.wav'),frames:scenes.map((_,i)=>path.join(output,`frame-${i}.jpg`)),duration:cursor/1000,scenes,caption_timing:'phrase estimates proportional to measured beat speech; no word alignment',technical_qa:{passed:true,checks,audio},creative_review:'not_performed_by_media'};
  fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2));
  return receipt;
}
