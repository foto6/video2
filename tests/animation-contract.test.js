import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {validateShortsBundle} from '../src/dynamic-shorts-v1.js';
const source='function Scene({frame}) { return <svg><circle cx={frame} r={80}/></svg>; }';
const sha=crypto.createHash('sha256').update(source).digest('hex');
const scene={beat_id:'hook',mode:'code_animation',motion:'procedural_motion',requires_object_motion:true,screen_text:'Океан',narration:'Робот увидел океан.',voice:{voice_seconds:2},lead_seconds:.1,tail_seconds:.1,transition:'cut',asset:{kind:'code_animation',source,source_sha256:sha,fps:30}};
const bundle=s=>({version:1,id:'fixture',style:{background:'#101827',accent:'#6E8EFF',foreground:'#FFFFFF'},scenes:[s]});
test('accepts real coded object movement with a matching source receipt',()=>assert.equal(validateShortsBundle(bundle(scene)).scenes[0].mode,'code_animation'));
test('rejects a changed authored source or fake video motion',()=>{
  assert.throws(()=>validateShortsBundle(bundle({...scene,asset:{...scene.asset,source:source+' '}})));
  assert.throws(()=>validateShortsBundle(bundle({...scene,mode:'illustration',motion:'push_in'})));
});
