import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const webRequire=createRequire(path.resolve('web/package.json'));
const katex=webRequire('katex');

test('KaTeX updated API: normal formula output and untrusted URL control',()=>{
 const html=katex.renderToString('c^2 = a^2 + b^2',{throwOnError:false,trust:false});
 assert.match(html,/katex/);assert.match(html,/<math/);
 const hostile=katex.renderToString('\\href{javascript:alert(1)}{x}',{throwOnError:false,trust:false,strict:'ignore'});
 assert.ok(!hostile.includes('href="javascript:'));
});

test('Patched production dependency resolutions include nested Mermaid KaTeX',()=>{
 const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8')).packages;
 const required:Record<string,string>={'multer':'2.5.0','simple-git':'4.0.2','js-yaml':'4.3.2','proxy-addr':'2.0.8','qs':'6.16.1','dompurify':'3.4.17','katex':'0.19.0'};
 for(const [name,version]of Object.entries(required)){
  const entries=Object.entries(lock).filter(([key])=>key.endsWith('/node_modules/'+name)||key==='node_modules/'+name);
  assert.ok(entries.length>0,name+' installed');
  for(const[key,value]of entries){
   // Dev tooling may independently use js-yaml v4; all runtime copies must match this candidate.
   assert.equal((value as {version:string}).version,version,key);
  }
 }
 const mermaidRequire=createRequire(webRequire.resolve('mermaid'));
 assert.equal(mermaidRequire('katex').version,'0.19.0');
});
