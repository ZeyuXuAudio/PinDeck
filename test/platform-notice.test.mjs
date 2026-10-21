import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Linux is supported since 2.9 (see server.test.mjs); other systems still get the notice and nothing else.
for (const platform of ['win32','freebsd']) test(`source startup on ${platform} shows notice without touching deck or state`, async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pindeck-platform-'));
 const state=path.join(dir,'state');
 const preload=path.join(dir,'platform.mjs');fs.writeFileSync(preload,`Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});`);
 const entry=fileURLToPath(new URL('../server.mjs',import.meta.url));
 const child=spawn(process.execPath,['--import',preload,entry,path.join(dir,'missing-deck'),'--port','0'],{env:{...process.env,PINDECK_HOME:state},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}fs.rmSync(dir,{recursive:true,force:true});});
 const url=await new Promise((resolve,reject)=>{
  let out='',err='';const timer=setTimeout(()=>reject(Error('No platform notice: '+err)),10000);
  child.stderr.on('data',d=>err+=d);
  child.once('exit',()=>{clearTimeout(timer);reject(Error('Exited before notice: '+err));});
  child.stdout.on('data',d=>{out+=d;const match=out.match(/http:\/\/127\.0\.0\.1:\d+\//);if(match){clearTimeout(timer);resolve(match[0]);}});
 });
 const response=await fetch(url);assert.equal(response.status,200);const html=await response.text();
 assert.match(html,platform==='win32'?/Windows support is on the roadmap/:/runs on macOS and Linux/);
 assert.doesNotMatch(html,/requires macOS/);
 assert.match(html,/deck has not been opened or changed/);
 assert.equal((await fetch(url+'api/message',{method:'POST',body:'{}'})).status,405);
 assert.equal(fs.existsSync(state),false);
 assert.equal(fs.existsSync(path.join(dir,'missing-deck')),false);
});
