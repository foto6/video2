import fs from 'node:fs';
import {renderShorts} from '../src/dynamic-shorts-v1.js';
try {
  if(process.argv.length!==4)throw Error('Usage: node render-dynamic-shorts-v1.mjs bundle.json output-folder');
  const result=renderShorts(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),process.argv[3]);
  process.stdout.write(JSON.stringify(result)+'\n');
} catch(error) {process.stderr.write(error.message+'\n');process.exitCode=1;}
