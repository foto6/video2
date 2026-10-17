import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSource} from './validate.mjs';
const component=body=>`function Scene({frame, fps, width, height, durationInFrames, palette}) { ${body} }`;
test('accepts an authored vector character, deterministic motion and bounded particles',()=>{
  assert.ok(validateSource(component('const t=frame/fps; const x=540+Math.sin(t)*100; return <svg width={width} height={height}><g transform={`translate(${x},900)`}><rect x={-90} width={180} height={130} rx={30} fill={palette.accent}/>{range(12).map(i=><circle key={i} cx={i*20} cy={frame%200} r={4}/>)}</g></svg>;')).nodes>20);
});
for(const [name,body] of Object.entries({
  process:'return <div>{process.env.SECRET}{frame}</div>;',
  browser:'return <div>{window.location.href}{frame}</div>;',
  evaluation:'const f=Function("return 1"); return <div>{f()+frame}</div>;',
  prototype:'const f=({}).constructor; return <div>{frame}</div>;',
  computed:'const f=({})["con"+"structor"]; return <div>{frame}</div>;',
  network:'fetch("/api/connection"); return <div>{frame}</div>;',
  ref:'return <div ref={x=>x.remove()}>{frame}</div>;',
  event:'return <div onClick={()=>frame}>{frame}</div>;',
  script:'return <script>{frame}</script>;',
  styleUrl:'return <div style={{background:"url(https://example.com)"}}>{frame}</div>;',
  templateUrl:'return <div style={{background:`url(https://example.com)`}}>{frame}</div>;',
  nondeterminism:'const v=Math.random(); return <div>{v+frame}</div>;',
  loop:'while(true) {} return <div>{frame}</div>;',
  mutation:'palette.accent="red"; return <div>{frame}</div>;',
  static:'return <svg><circle cx={500} cy={500} r={100}/></svg>;'
}))test('rejects '+name,()=>assert.throws(()=>validateSource(component(body))));
test('cannot append executable module scope statements',()=>assert.throws(()=>validateSource(component('return <div>{frame}</div>;')+'; fetch("/");')));
test('supports local SVG gradient IDs without external resources',()=>assert.ok(validateSource(component('return <svg><defs><linearGradient id="sea"><stop stopColor={palette.accent}/></linearGradient></defs><rect x={frame} fill="url(#sea)" width={500} height={500}/></svg>;')).nodes>0));
test('supports local reusable vector components',()=>assert.ok(validateSource(component('const Robot=({x})=><g transform={`translate(${x},800)`}><rect width={100} height={150}/></g>; return <svg><Robot x={frame}/></svg>;')).nodes>0));
