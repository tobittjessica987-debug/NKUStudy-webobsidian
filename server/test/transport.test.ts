import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { WebSocket } from 'ws';
import { once, on } from 'node:events';
const root = await fs.mkdtemp(path.join(os.tmpdir(),'nkustudy-transport-'));
process.env.DATA_DIR=path.join(root,'data'); process.env.VAULT_PATH=path.join(root,'vault');
process.env.NODE_ENV='production'; delete process.env.TRUST_PROXY; delete process.env.WEBOBSIDIAN_PASSWORD;
const { sameOriginWrites }=await import('../src/middleware/requestOrigin.js');
const { config }=await import('../src/config.js');
const { updateSettings }=await import('../src/services/settings.js');
const { hashPassword, issueToken, issueGuestToken, revokeSessions }=await import('../src/services/auth.js');
const { setupWebsocket }=await import('../src/services/websocket.js');
const { broadcast }=await import('../src/services/realtime.js');
const { redactUrlCreds }=await import('../src/lib/redact.js');
const passwordHash=await hashPassword('fixture-transport-password');
await updateSettings(s=>{s.auth.userPasswordHash=passwordHash;s.publicEditor.enabled=true;});
const app=express();app.set('trust proxy',config.trustProxy);app.use(sameOriginWrites);let writes=0;
app.post('/mutation',(_req,res)=>{writes++;res.json({ok:true});});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const wss=setupWebsocket(server);
const port=(server.address() as {port:number}).port;const base=`http://127.0.0.1:${port}`;
after(async()=>{for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});});

test('WEB-01/02 cross-origin JSON and multipart rejected before mutation; same-origin/native allowed',async()=>{
 assert.equal(config.trustProxy,false);
 for(const method of ['application/json','multipart/form-data; boundary=fixture','application/x-www-form-urlencoded']){
  const res=await fetch(base+'/mutation',{method:'POST',headers:{origin:'https://attacker.invalid','Content-Type':method},body:'fixture'});assert.equal(res.status,403);
 }
 assert.equal(writes,0);
 assert.equal((await fetch(base+'/mutation',{method:'POST',headers:{origin:'null'}})).status,403);
 assert.equal((await fetch(base+'/mutation',{method:'POST',headers:{origin:base}})).status,200);
 assert.equal((await fetch(base+'/mutation',{method:'POST'})).status,200);
 assert.equal(writes,2);
 // Untrusted forwarding headers do not turn this HTTP origin into HTTPS.
 assert.equal((await fetch(base+'/mutation',{method:'POST',headers:{origin:base.replace('http:','https:'),'x-forwarded-proto':'https'}})).status,403);
 assert.equal(writes,2);
});

async function rejected(headers:Record<string,string>,status:number){
 const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers});
 await new Promise<void>((resolve,reject)=>{ws.on('open',()=>{ws.terminate();reject(new Error('unexpected upgrade'));});ws.on('error',()=>{});ws.on('unexpected-response',(_req,res)=>{assert.equal(res.statusCode,status);res.resume();ws.terminate();resolve();});});
}
test('WS-01 absent/guest/malformed-cookie/cross-origin upgrades rejected',async()=>{
 await rejected({},401);
 await rejected({authorization:'Bearer '+await issueGuestToken()},401);
 await rejected({cookie:'webobsidian_token=%E0%A4%A'},401);
 await rejected({authorization:'Bearer '+await issueToken(),origin:'https://attacker.invalid'},403);
});

test('WS-01 owner receives events; revoked session receives no subsequent event',async()=>{
 const token=await issueToken();
 const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers:{authorization:'Bearer '+token,origin:base}});
 const messages:string[]=[];ws.on('message',x=>messages.push(x.toString()));await once(ws,'open');
 // The initial hello frame can arrive after open; wait for the actual broadcast,
 // not merely the next frame, so this assertion is independent of socket timing.
 const event=(async()=>{
  for await(const [message] of on(ws,'message',{signal:AbortSignal.timeout(5000)})){
   if(JSON.parse(message.toString()).type==='fixture-event')return;
  }
 })();
 broadcast({type:'fixture-event'});await event;
 assert.ok(messages.some(x=>x.includes('fixture-event')));
 await revokeSessions();const closing=once(ws,'close');broadcast({type:'private-after-revoke'});await closing;
 assert.ok(messages.every(x=>!x.includes('private-after-revoke')));
 await rejected({authorization:'Bearer '+token},401);
});

test('LOG-01 URL credentials and query secrets are redacted',()=>{
 const result=redactUrlCreds('https://fixture-user:fixture-secret@example.invalid/path?key=fixture-key&token=fixture-token&ok=visible');
 for(const secret of ['fixture-user','fixture-secret','fixture-key','fixture-token'])assert.ok(!result.includes(secret));
 assert.ok(result.includes('ok=visible'));
});
