import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {bundle} from '@remotion/bundler';
import {selectComposition,renderMedia,renderStill,openBrowser,makeCancelSignal} from '@remotion/renderer';
import {validateSource} from './validate.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const fileHash=p=>hash(fs.readFileSync(p));
const canonical=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]))):value;
const wrapper=`import React from 'react';
import {Composition,registerRoot,useCurrentFrame,useVideoConfig,interpolate,spring} from 'remotion';
import Scene from './scene.jsx';
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const range=(n)=>Array.from({length:Math.max(0,Math.min(64,Math.floor(n)))},(_,i)=>i);
const Frame=(props)=>{const frame=useCurrentFrame();const {fps,width,height,durationInFrames}=useVideoConfig();return <div style={{width,height,overflow:'hidden',background:props.palette.background,fontFamily:'Arial, sans-serif'}}><Scene frame={frame} fps={fps} width={width} height={height} durationInFrames={durationInFrames} palette={props.palette}/></div>};
registerRoot(()=> <Composition id="Scene" component={Frame} width={1080} height={1920} fps={30} durationInFrames={30} calculateMetadata={({props})=>({durationInFrames:props.frames})}/>);
`;
export async function renderAnimation(request,output){
  validateSource(request.source);
  if(!Number.isInteger(request.frames)||request.frames<3||request.frames>450)throw Error('Animation duration must be 3–450 frames');
  for(const k of ['background','accent','foreground'])if(!/^#[a-f0-9]{6}$/i.test(request.palette?.[k]))throw Error('Invalid animation palette');
  output=path.resolve(output);fs.mkdirSync(output,{recursive:true});
  const requestKey=hash(JSON.stringify(canonical(request)));
  const key=hash(JSON.stringify({runtime:'4.0.536',renderer:fileHash(fileURLToPath(import.meta.url)),policy:fileHash(path.join(root,'validate.mjs')),requestKey}));
  const receiptFile=path.join(output,'animation-receipt.json'),clip=path.join(output,'animation.mp4');
  if(fs.existsSync(receiptFile)){
    const old=JSON.parse(fs.readFileSync(receiptFile));
    if(old.key!==key||old.sha256!==fileHash(clip))throw Error('Cached animation changed');
    return {...old,reused:true};
  }
  const folder=path.join(root,'.cache',hash(request.source));fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'scene.jsx'),"import React from 'react';\nimport {interpolate,spring} from 'remotion';\nconst clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));\nconst range=(n)=>Array.from({length:Math.max(0,Math.min(64,Math.floor(n)))},(_,i)=>i);\n"+request.source+'\nexport default Scene;\n');
  fs.writeFileSync(path.join(folder,'entry.jsx'),wrapper);
  const serveUrl=await bundle({entryPoint:path.join(folder,'entry.jsx'),outDir:path.join(folder,'bundle'),publicDir:null,enableCaching:true});
  const html=path.join(serveUrl,'index.html');
  const policy="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";
  fs.writeFileSync(html,fs.readFileSync(html,'utf8').replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="${policy}">`));
  const executable=process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':undefined;
  if(executable&&!fs.existsSync(executable))throw Error('Dedicated render browser executable is unavailable');
  const browser=await openBrowser('chrome',{browserExecutable:executable,logLevel:'error',chromiumOptions:{gl:'angle',headless:true}});
  const {cancelSignal,cancel}=makeCancelSignal();
  const deadline=setTimeout(cancel,420000);
  try {
  const options={serveUrl,inputProps:{frames:request.frames,palette:request.palette},puppeteerInstance:browser,logLevel:'error',timeoutInMilliseconds:20000,chromiumOptions:{gl:'angle'},cancelSignal};
  const composition=await selectComposition({...options,id:'Scene'});
  const started=Date.now();
  // Inspect all temporal phases before expensive frame rendering. User/provider
  // browsers, profiles, environment secrets and remote assets are never attached.
  const sampleFrames=[0,Math.floor(request.frames/2),request.frames-1];
  for(const [i,frame] of sampleFrames.entries())await renderStill({...options,composition,frame,output:path.join(output,`animation-frame-${i}.png`)});
  await renderMedia({...options,composition,codec:'h264',outputLocation:clip,concurrency:2,crf:20,pixelFormat:'yuv420p',x264Preset:'veryfast',muted:true});
  const receipt={version:'remotion-animation.v1',runtime:'4.0.536',key,request_sha256:requestKey,path:clip,sha256:fileHash(clip),source_sha256:hash(request.source),frames:request.frames,fps:30,sample_frames:sampleFrames.map((frame,i)=>({frame,path:path.join(output,`animation-frame-${i}.png`),sha256:fileHash(path.join(output,`animation-frame-${i}.png`))})),render_seconds:(Date.now()-started)/1000,reused:false};
  fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2));return receipt;
  } finally {clearTimeout(deadline);await browser.close({silent:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await renderAnimation(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),process.argv[3]))+'\n');}catch(e){process.stderr.write('ANIMATION_RENDER: '+e.message+'\n');process.exitCode=1;}}
