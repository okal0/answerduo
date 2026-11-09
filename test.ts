import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
for (const name of ['openai','gemini']) test(name+' private two-device session lifecycle',{timeout:15000},async(t)=>{
  process.env.NODE_ENV='test';process.env.PUBLIC_ORIGIN='http://localhost:3000';
  const provider=new WebSocketServer({port:0,host:'127.0.0.1'});await once(provider,'listening');
  process.env.TEST_REALTIME_URL='ws://localhost:'+provider.address().port;
  const audio=[];provider.on('connection',ws=>ws.on('message',raw=>{const m=JSON.parse(raw);
    if(m.setup){
      assert.equal(m.setup.model,'models/gemini-3.5-transcribe-live');
      ws.send(JSON.stringify({setupComplete:{}}));
    }
    if(m.realtimeInput?.audio){
      assert.equal(m.realtimeInput.audio.mimeType,'audio/pcm;rate=16000');
      assert.equal(Buffer.from(m.realtimeInput.audio.data,'base64').length,3200);
      audio.push(m.realtimeInput.audio);
      for(const [field,text] of [['interimInputTranscription','How does'],['inputTranscription','Design a caching layer.\nAssume 100 MB.\nTake your time.']]){
        ws.send(JSON.stringify({serverContent:{[field]:{text}}}));
      }
    }
    if(m.type==='session.update')ws.send(JSON.stringify({type:'session.updated'}));
    if(m.type==='input_audio_buffer.append'){audio.push(m.audio);ws.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'q',transcript:'Design a caching layer.\nAssume 100 MB.\nTake your time.'}));}
  }));
  const realFetch=globalThis.fetch;const requests=[];
  const selected='Design a caching layer. Assume 100 MB.';
  const output=()=>requests.length===1
    ? ['{"ques','tion":'+JSON.stringify(selected)+'}\nCache ','repeated reads.']
    : requests.length===5 ? ['{"question":','null}']
    : requests.length===3||requests.length===4
    ? ['```python\nprint(42)\n```\n','Explanation\nPrints the result.\nWalkthrough\nThe literal 42 is printed as 42.']
    : ['Cache ','repeated reads.'];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).startsWith('https://generativelanguage.googleapis.com')){
      assert.equal(name,'gemini');
      if(options.headers['x-goog-api-key']!=='valid')return new Response('{}',{status:403});
      if(String(url).includes('streamGenerateContent')){
        requests.push(JSON.parse(options.body));
        return new Response(output().map((text,index)=>'data: '+JSON.stringify({candidates:[{content:{parts:[{text}]},finishReason:index?'STOP':undefined}]})+'\n\n').join(''));
      }
      return new Response('{}');
    }
    if(!String(url).startsWith('https://api.openai.com'))return realFetch(url,options);
    assert.equal(name,'openai');
    if(String(url).endsWith('responses')){requests.push(JSON.parse(options.body));return new Response(output().map(delta=>'data: '+JSON.stringify({type:'response.output_text.delta',delta})+'\n\n').join('')+'data: {"type":"response.completed"}\n\n');}
    return new Response('{}',{status:options.headers.Authorization==='Bearer valid'?200:401});
  });
  const {server}=await import('./server.ts');server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://localhost:'+server.address().port,origin=process.env.PUBLIC_ORIGIN;
  t.after(()=>{for(const ws of provider.clients)ws.terminate();provider.close();server.close();});
  const post=(url,body)=>fetch(base+'/api/'+(body.provider==='gemini'?'gemini/':'')+url,{method:'POST',headers:{origin},body:JSON.stringify(body)});
  assert.equal((await post('validate',{key:'bad',provider:name})).status,name==='gemini'?403:401);
  assert.equal((await fetch(base+'/app.js')).status,200);
  const session=await (await post('session',{key:'valid',provider:name})).json();assert.match(session.qr,/^data:image\/png/);
  const open=async(credential)=>{const ws=new WebSocket(base.replace('http','ws')+'/socket',{origin});const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));await once(ws,'open');ws.send(JSON.stringify({id:session.id,credential}));return {ws,messages};};
  const wait=async(predicate)=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out awaiting session event');};
  const host=await open(session.credential);await wait(()=>host.messages.some(m=>m.type==='ready'));
  // Decode the actual QR payload through the encoder used by the app.
  const qr=(await import('qrcode')).default;let link;
  const encode=qr.toDataURL;t.mock.method(qr,'toDataURL',(...args)=>{link=args[0];return encode(...args);});
  const send=(peer,data)=>peer.ws.send(JSON.stringify(data));
  send(host,{type:'ticket'});await wait(()=>link);
  const [id,ticket]=new URL(link).hash.slice(1).split('.');const pair=await(await post('pair',{id,ticket})).json();
  assert.notEqual(pair.credential,session.credential);assert.equal((await post('pair',{id,ticket})).status,403);
  let phone=await open(pair.credential);await wait(()=>phone.messages.some(m=>m.paired));
  host.ws.send(Buffer.alloc(4800));await wait(()=>phone.messages.some(m=>m.transcript?.includes('caching')));
  send(host,{type:'status',paused:true,visual:false});host.ws.send(Buffer.alloc(4800));await wait(()=>phone.messages.some(m=>m.paused));assert.equal(audio.length,1);
  send(host,{type:'status',paused:false,visual:true});host.ws.send(Buffer.alloc(4800));await wait(()=>audio.length===2);
  send(host,{type:'status',paused:false,visual:false});host.ws.send(Buffer.alloc(4800));await wait(()=>audio.length===3);
  async function action(name,image){const start=host.messages.length;send(phone,{type:'command',action:name});send(phone,{type:'command',action:name});
    await wait(()=>host.messages.slice(start).some(m=>m.type==='command'));const cmd=host.messages.slice(start).find(m=>m.type==='command');
    const before=phone.messages.length;send(host,{type:'generate',request:cmd.request,image,background:'Fixture: maintained an inventory service.'});await wait(()=>phone.messages.slice(before).some(m=>m.type==='state'&&!m.action));
  }
  await action('Answer question');assert.equal(requests.length,1);assert.ok(phone.messages.some(m=>m.answer==='Cache '));
  assert.ok(JSON.stringify(requests[0]).includes('Fixture: maintained an inventory service.'));
  assert.ok(!JSON.stringify(phone.messages).includes('Fixture: maintained an inventory service.'));
  phone.ws.close();await once(phone.ws,'close');phone=await open(pair.credential);await wait(()=>phone.messages.some(m=>m.answer==='Cache repeated reads.'&&m.question===selected));
  await action('Analyze screen');assert.ok(phone.messages.some(m=>m.notice==='Select a window on your laptop'));
  for(const frame of ['AA','BB'])await action('Analyze screen','data:image/jpeg;base64,'+frame);
  assert.equal(requests.length,4);
  assert.ok(!JSON.stringify(requests.slice(1)).includes('Fixture: maintained an inventory service.'));
  assert.ok(phone.messages.some(m=>!m.action && m.answer?.includes('print(42)') && m.answer.includes('Explanation\nPrints the result.\nWalkthrough\nThe literal 42 is printed as 42.')));
  if(name==='gemini')assert.equal(requests[3].contents[0].parts[1].inlineData.data,'BB');
  await action('Answer question');
  assert.ok(phone.messages.some(m=>m.previewQuestion===selected));
  assert.equal(requests.length,6);
  assert.equal(phone.messages.at(-1).question,selected);
  assert.equal(phone.messages.at(-1).answer,'Cache repeated reads.');
  assert.ok(!phone.messages.some(m=>m.answer?.includes('{"ques')));
  const closed=once(phone.ws,'close');send(host,{type:'end'});assert.equal((await closed)[0],4001);
  const revoked=await open(pair.credential);assert.equal((await once(revoked.ws,'close'))[0],4003);
});
