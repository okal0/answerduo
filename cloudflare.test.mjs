import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile,mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { scryptSync } from 'node:crypto';

const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve('wrangler'))('miniflare');
const providerFixture=`
let disconnectedOnce=false;
export default {async fetch(request){
  const url=new URL(request.url);
  if(request.headers.get('Upgrade')==='websocket'){
    const pair=new WebSocketPair(),client=pair[0],ws=pair[1];ws.accept();
    ws.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.setup)ws.send(JSON.stringify({setupComplete:{}}));
      if(message.type==='session.update')ws.send(JSON.stringify({type:'session.updated'}));
      if(message.realtimeInput?.audio)ws.send(JSON.stringify({serverContent:{inputTranscription:{text:'Design a cache. Assume 100 MB. Take your time.'}}}));
      if(message.realtimeInput?.audio&&!disconnectedOnce){disconnectedOnce=true;ws.close(1011,'Temporary fixture outage');}
      if(message.type==='input_audio_buffer.append')ws.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'one',transcript:'Design a cache. Assume 100 MB. Take your time.'}));
    });
    return new Response(null,{status:101,webSocket:client});
  }
  const key=request.headers.get('x-goog-api-key')||request.headers.get('Authorization');
  if(key?.includes('invalid'))return new Response('{}',{status:401});
  if(request.method==='GET')return new Response('{}');
  const body=await request.json(),gemini=url.host.includes('googleapis');
  const image=gemini?body.contents[0].parts[1]?.inlineData.data:body.input[0].content[1]?.image_url;
  const parts=image?['\u0060\u0060\u0060python\\nprint(42)\\n\u0060\u0060\u0060\\n','Explanation\\nPrint the value.\\nWalkthrough\\nThe output is 42. '+image]:['Cache ','repeated reads.'];
  const stream=parts.map(delta=>'data: '+JSON.stringify(gemini?{candidates:[{content:{parts:[{text:delta}]}}]}:{type:'response.output_text.delta',delta})+'\\n\\n').join('');
  const ending=gemini?{candidates:[{finishReason:'STOP'}]}:{type:'response.completed'};
  return new Response(stream+'data: '+JSON.stringify(ending)+'\\n\\n',{headers:{'Content-Type':'text/event-stream'}});
}};`;

test('Cloudflare runtime preserves capture protocol, pairing, accounts and trial expiry',{timeout:60000},async()=>{
  await mkdir('dist',{recursive:true});
  await build({entryPoints:['cloudflare/worker.ts'],outfile:'dist/test-worker.mjs',bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:*','node:*'],logLevel:'silent'});
  const salt='a'.repeat(32),legacyHash=salt+':'+scryptSync('adm123',salt,64).toString('hex');
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'app',modules:true,scriptPath:'dist/test-worker.mjs',compatibilityDate:'2026-11-09',compatibilityFlags:['nodejs_compat'],
    bindings:{ADMIN_EMAIL:'admin@example.com',ADMIN_PASSWORD_HASH:legacyHash},
    durableObjects:{ACCOUNTS:{className:'AccountStore',useSQLite:true},ROOMS:{className:'InterviewRoom',useSQLite:true}},
    outboundService:'provider',serviceBindings:{ASSETS:async request=>{
      const path=new URL(request.url).pathname;
      try{return new Response(await readFile('dist/public'+path),{headers:{'Content-Type':path.endsWith('.html')?'text/html':'text/javascript'}});}
      catch{return new Response('Not found',{status:404});}
    }}
  },{name:'provider',modules:true,script:providerFixture,compatibilityDate:'2026-11-09'}]}));
  try{
    await mf.ready;const app=await mf.getWorker('app');
    const origin='https://localhost';let cookie='';
    const request=async(path,body,customCookie=cookie)=>{
      const response=await app.fetch(origin+path,{method:body?'POST':'GET',headers:{origin,Cookie:customCookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
      const jar=new Map(customCookie.split(';').filter(Boolean).map(value=>value.trim().split('=')));
      for(const value of response.headers.getSetCookie()){const [name,content]=value.split(';')[0].split('=');if(content)jar.set(name,content);else jar.delete(name);}
      cookie=[...jar].map(([name,value])=>name+'='+value).join('; ');
      return response;
    };
    for(const route of ['/','/pricing','/app','/phone']){const response=await request(route);assert.equal(response.status,200,route+' '+await response.text());}
    assert.equal((await request('/api/admin')).status,403);
    assert.equal((await request('/api/checkout',{})).status,503);
    assert.equal((await request('/internal/reserve',{})).status,404);
    assert.equal((await app.fetch(origin+'/api/auth/signup',{method:'POST',headers:{origin:'https://localhost:9999'},body:'{}'})).status,403);
    const preview=await(await request('/api/account')).json();
    assert.equal(preview.remainingMs,20*60000);assert.equal(preview.trialKind,'guest-preview');assert.equal(preview.launchExpiresAt,null);
    assert.equal((await request('/api/auth/signup',{email:'candidate@example.com',password:'1234567'})).status,400);
    assert.equal((await request('/api/auth/signup',{email:'candidate@example.com',password:'12345678'})).status,200);
    const candidateCookie=cookie;
    for(let i=0;i<4;i++)await request('/pricing');
    const wait=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for a runtime event');};
    for(const provider of ['gemini','openai']){
      cookie=candidateCookie;
      const route='/api/'+(provider==='gemini'?'gemini/':'');
      assert.equal((await request(route+'validate',{provider,key:'invalid-key'})).status,401);
      const sessionResponse=await request(route+'session',{provider,key:'provider-key-fixture'});
      assert.equal(sessionResponse.status,200);
      const session=await sessionResponse.json();assert.match(session.qr,/^data:image\/svg\+xml/);
      assert.equal((await request(route+'session',{provider,key:'provider-key-fixture'})).status,409);
      const svg=Buffer.from(session.qr.split(',')[1],'base64').toString();assert.ok(svg.includes('<svg'));
      const {ROOMS}=await mf.getBindings('app');
      const room=ROOMS.get(ROOMS.idFromName(session.id));
      // Obtain a new pairing link via a host command, then inspect the fixture QR
      // through an authorized host connection by intercepting the generated data.
      const hostResponse=await app.fetch(origin+'/socket?id='+session.id,{headers:{Upgrade:'websocket',Origin:origin}});
      assert.equal(hostResponse.status,101);
      const host=hostResponse.webSocket;host.accept();const hostMessages=[];
      host.addEventListener('message',event=>hostMessages.push(JSON.parse(event.data)));
      host.send(JSON.stringify({id:session.id,credential:session.credential}));
      await wait(()=>hostMessages.some(message=>message.type==='ready'));
      // QR decoding is verified in a separate test. Pairing tokens are held only
      // as hashes, so the runtime test creates a known one through QR decoding.
      const {default:jsQR}=await import('jsqr');
      const size=Number(svg.match(/viewBox="0 0 (\d+)/)[1]),scale=5,width=size*scale;
      const pixels=new Uint8ClampedArray(width*width*4).fill(255);
      for(const match of svg.matchAll(/M(\d+),(\d+)h1v1h-1z/g)){
        const x=Number(match[1])*scale,y=Number(match[2])*scale;
        for(let row=y;row<y+scale;row++)for(let col=x;col<x+scale;col++){
          const i=(row*width+col)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;
        }
      }
      const decoded=jsQR(pixels,width,width);
      assert.ok(decoded);
      const ticket=new URL(decoded.data).hash.slice(1).split('.')[1];
      const pairing=await request('/api/pair',{id:session.id,ticket});assert.equal(pairing.status,200);
      const phoneKey=(await pairing.json()).credential;assert.notEqual(phoneKey,session.credential);
      assert.equal((await request('/api/pair',{id:session.id,ticket})).status,403);
      async function connectPhone(){
        const response=await app.fetch(origin+'/socket?id='+session.id,{headers:{Upgrade:'websocket',Origin:origin}});
        const ws=response.webSocket;ws.accept();const messages=[];ws.addEventListener('message',event=>messages.push(JSON.parse(event.data)));
        ws.send(JSON.stringify({id:session.id,credential:phoneKey}));await wait(()=>messages.some(message=>message.type==='state'));return {ws,messages};
      }
      let phone=await connectPhone();
      host.send(new ArrayBuffer(4800));await wait(()=>phone.messages.some(message=>message.transcript?.includes('cache'))).catch(error=>{console.log('fixture diagnostics',provider,hostMessages,phone.messages);throw error;});
      if(provider==='gemini'){
        await wait(()=>hostMessages.filter(message=>message.type==='ready').length===2);
        assert.ok(phone.messages.some(message=>message.transcript?.includes('Design a cache')));
        // An established stream must survive the 15-second handshake timeout.
        await new Promise(resolve=>setTimeout(resolve,16000));
        assert.equal(hostMessages.filter(message=>message.type==='ready').length,2);
        const before=phone.messages.length;
        host.send(new ArrayBuffer(4800));
        await wait(()=>phone.messages.slice(before).some(message=>message.transcript?.includes('Design a cache')));
      }
      host.send(JSON.stringify({type:'answer-inputs',background:'Fixture background notes'}));
      // Confirm the host input update was processed before tapping on the other socket.
      host.send(JSON.stringify({type:'status',notice:'Inputs synchronized'}));
      await wait(()=>phone.messages.some(message=>message.notice==='Inputs synchronized'));
      phone.ws.send(JSON.stringify({type:'command',action:'Answer question'}));
      await wait(()=>phone.messages.some(message=>!message.action&&message.answer==='Cache repeated reads.'));
      assert.ok(!hostMessages.some(message=>message.type==='command'));
      assert.ok(!JSON.stringify(phone.messages).includes('provider-key-fixture'));
      assert.ok(!JSON.stringify(phone.messages).includes('Fixture background notes'));
      phone.ws.close();phone=await connectPhone();
      assert.equal(phone.messages.at(-1).answer,'Cache repeated reads.');
      for(const frame of ['AA','BB']){
        const offset=hostMessages.length;
        phone.ws.send(JSON.stringify({type:'command',action:'Analyze screen'}));
        await wait(()=>hostMessages.slice(offset).some(message=>message.type==='command'));
        const next=hostMessages.slice(offset).find(message=>message.type==='command');
        host.send(JSON.stringify({type:'generate',request:next.request,image:'data:image/jpeg;base64,'+frame}));
        await wait(()=>phone.messages.some(message=>!message.action&&message.answer?.includes(frame)));
      }
      host.send(JSON.stringify({type:'end'}));await wait(()=>phone.messages.some(message=>message.type==='ended'));
      assert.equal((await request('/api/pair',{id:session.id,ticket})).status,410);
      const account=await (await request('/api/account')).json();assert.ok(account.remainingMs>6*86400000&&account.remainingMs<=7*86400000);assert.ok(account.launchExpiresAt>Date.now());assert.equal(account.trialKind,'registered-trial');
    }
    assert.equal((await request('/api/auth/login',{email:'admin@example.com',password:'adm123'})).status,200);
    const dashboard=await (await request('/api/admin')).json();assert.equal(dashboard.sessions,2);assert.equal(dashboard.paired,2);assert.equal(dashboard.answered,2);
    assert.equal(dashboard.uniqueVisitors,1,'refreshes and navigation count one browser');
    assert.equal(dashboard.traffic[0].visitors,1);
    for(let i=0;i<3;i++)await request('/admin');
    assert.equal((await (await request('/api/admin')).json()).uniqueVisitors,1,'admin reloads are excluded');
    await request('/api/auth/logout',{});
    await request('/');await request('/');
    const loggedOutCookie=cookie;
    await request('/',undefined,'');
    const secondBrowserCookie=cookie;
    await request('/pricing');
    await request('/api/auth/login',{email:'admin@example.com',password:'adm123'},loggedOutCookie);
    const updated=await (await request('/api/admin')).json();
    assert.equal(updated.uniqueVisitors,2,'signing out keeps browser identity; a new browser adds one');
    assert.equal(updated.traffic[0].visitors,2);
    assert.equal(updated.guests,2,'guest accounts remain tracked independently of visitors');
    assert.notEqual(secondBrowserCookie,loggedOutCookie);
    const {ACCOUNTS,ROOMS}=await mf.getBindings('app');
    const store=ACCOUNTS.get(ACCOUNTS.idFromName('accounts-v1'));
    const id='f'.repeat(64),hostKey='e'.repeat(64);
    const reserved=await store.fetch(origin+'/internal/reserve',{method:'POST',headers:{Cookie:candidateCookie},body:JSON.stringify({room:id})});
    const account=await reserved.json();
    await ROOMS.get(ROOMS.idFromName(id)).fetch('https://internal/internal/init',{method:'POST',body:JSON.stringify({id,credential:hostKey,accountId:account.id,deadline:Date.now()+800,key:'fixture',provider:'gemini',origin})});
    const response=await app.fetch(origin+'/socket?id='+id,{headers:{Upgrade:'websocket',Origin:origin}});
    const ws=response.webSocket;ws.accept();const messages=[];ws.addEventListener('message',event=>messages.push(JSON.parse(event.data)));ws.send(JSON.stringify({id,credential:hostKey}));
    await wait(()=>messages.some(message=>message.type==='trial-ended'));
    // Registering during a guest session must replace its original deadline.
    await request('/api/account',undefined,'');
    const upgradeCookie=cookie,upgradeId='d'.repeat(64),upgradeKey='c'.repeat(64);
    const upgradeReservation=await store.fetch(origin+'/internal/reserve',{method:'POST',headers:{Cookie:upgradeCookie},body:JSON.stringify({room:upgradeId})});
    const upgradeAccount=await upgradeReservation.json();
    const upgradeRoom=ROOMS.get(ROOMS.idFromName(upgradeId));
    await upgradeRoom.fetch('https://internal/internal/init',{method:'POST',body:JSON.stringify({id:upgradeId,credential:upgradeKey,accountId:upgradeAccount.id,deadline:Date.now()+1000,key:'fixture',provider:'gemini',origin})});
    const upgradeResponse=await app.fetch(origin+'/socket?id='+upgradeId,{headers:{Upgrade:'websocket',Origin:origin}});
    const upgradeSocket=upgradeResponse.webSocket;upgradeSocket.accept();const upgradeMessages=[];
    upgradeSocket.addEventListener('message',event=>upgradeMessages.push(JSON.parse(event.data)));
    upgradeSocket.send(JSON.stringify({id:upgradeId,credential:upgradeKey}));
    await wait(()=>upgradeMessages.some(message=>message.type==='ready'));
    assert.equal((await request('/api/auth/signup',{email:'upgrade@example.com',password:'12345678'})).status,200);
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.ok(!upgradeMessages.some(message=>message.type==='trial-ended'),'signup extends the running guest session');
    const registered=await(await request('/api/account')).json();assert.ok(registered.remainingMs>6*86400000);
    const registeredDeadline=registered.launchExpiresAt;
    await request('/api/auth/logout',{});
    await request('/api/auth/login',{email:'upgrade@example.com',password:'12345678'});
    assert.equal((await(await request('/api/account')).json()).launchExpiresAt,registeredDeadline,'signing in does not renew the registered trial');
    upgradeSocket.send(JSON.stringify({type:'end'}));
    await wait(()=>upgradeMessages.some(message=>message.type==='ended'));

  }finally{await mf.dispose();}
});
