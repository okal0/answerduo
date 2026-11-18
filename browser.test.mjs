import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';

test('pair a phone, answer a question, recover the host and end intentionally', {timeout:60000}, async t=>{
  const listener=http.createServer();
  listener.listen(0,'127.0.0.1');
  await once(listener,'listening');
  t.after(()=>listener.close());
  const origin='http://localhost:'+listener.address().port;
  const provider=new WebSocketServer({port:0,host:'127.0.0.1'});
  await once(provider,'listening');
  t.after(()=>{for(const peer of provider.clients)peer.terminate();provider.close();});
  Object.assign(process.env,{NODE_ENV:'test',PUBLIC_ORIGIN:origin,ACCOUNTS_DB:':memory:',TEST_REALTIME_URL:'ws://127.0.0.1:'+provider.address().port});
  const question='How would you test this?',answer='Exercise the complete user flow.';
  provider.on('connection',peer=>{
    let transcribed=false;
    peer.on('message',raw=>{
      const event=JSON.parse(raw);
      if(event.type==='session.update')peer.send(JSON.stringify({type:'session.updated'}));
      if(event.type==='input_audio_buffer.append'&&!transcribed){
        transcribed=true;
        peer.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'q',transcript:question}));
      }
    });
  });
  let finishAnswer,requests=0;
  const originalFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',(url,options)=>{
    if(!String(url).startsWith('https://api.openai.com/'))return originalFetch(url,options);
    if(!String(url).endsWith('/responses'))return new Response('{}');
    const payload=JSON.parse(options.body);
    const instructions=payload.instructions;
    assert.ok(instructions.includes('"codingLanguage":"Dart"'));
    if(requests===1){
      assert.ok(payload.input[0].content[0].text.includes('Previous spoken turns'));
      assert.ok(payload.input[0].content[0].text.includes(answer));
      assert.ok(payload.input[0].content[0].text.includes('New speech since the previous answer: "Which failure would you simulate?"'));
    }
    assert.ok(instructions.includes('without a heading') && instructions.includes('## Full Details'));
    const details='\n## Full Details\n'+('Verify the result on both devices. '.repeat(30));
    const encoder=new TextEncoder();
    return new Response(new ReadableStream({start(stream){
      const send=event=>stream.enqueue(encoder.encode('data: '+JSON.stringify(event)+'\n\n'));
      send({type:'response.output_text.delta',delta:answer});
      requests++;
      finishAnswer=()=>{
        send({type:'response.output_text.delta',delta:details+' End of answer.'});
        send({type:'response.completed'});stream.close();
      };
    }}));
  });
  const {server}=await import('./server.ts');
  for(const event of ['request','upgrade'])listener.on(event,server.listeners(event)[0]);
  const hostSockets=[];
  listener.on('upgrade',(_req,socket)=>hostSockets.push(socket));
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome'});
  try{
    const host=await browser.newPage();
    const phone=await browser.newPage({viewport:{width:390,height:844}});
    await host.addInitScript(()=>{
      navigator.mediaDevices.getDisplayMedia=async()=>{
        const audio=new AudioContext();
        const dest=audio.createMediaStreamDestination();
        const tone=audio.createOscillator();
        tone.connect(dest);tone.start();window.testTone=tone;await audio.resume();
        window.testStream=dest.stream;
        return dest.stream;
      };
    });
    await host.goto(origin+'/app');
    const key=host.locator('#key');
    assert.equal(await key.getAttribute('type'),'text');
    assert.equal(await key.evaluate(input=>getComputedStyle(input).getPropertyValue('-webkit-text-security')),'disc');
    assert.equal(await host.getByRole('button',{name:'Show key'}).count(),0);
    assert.equal(await host.locator('#fast-answers').count(),0);
    const start=async()=>{
      await key.fill('test-key');
      await host.locator('#audio').click();
      await host.locator('#start').click();
      await host.locator('#qr').waitFor();
    };
    await host.evaluate(()=>{
      const capture=navigator.mediaDevices.getDisplayMedia;
      navigator.mediaDevices.getDisplayMedia=async()=>{
        navigator.mediaDevices.getDisplayMedia=capture;
        return new MediaStream();
      };
    });
    await key.fill('test-key');
    await host.locator('#audio').click();
    const warning=host.getByRole('alert').filter({hasText:'Also share tab audio'});
    await warning.waitFor();
    assert.equal(await warning.evaluate(box=>getComputedStyle(box).borderLeftWidth),'4px');
    assert.equal(await host.locator('#start').isDisabled(),true);
    await host.locator('#coding-language').selectOption('Dart');
    await host.locator('#background').fill('My preparation');
    await start();
    assert.equal(await warning.count(),0);
    await host.addScriptTag({path:createRequire(import.meta.url).resolve('jsqr')});
    const link=await host.locator('#qr').evaluate(async img=>{
      await img.decode();
      const canvas=document.createElement('canvas');
      canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
      const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
      return window.jsQR(ctx.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height).data;
    });
    await phone.goto(link);
    await phone.waitForFunction(q=>document.querySelector('#transcript')?.textContent.includes(q),question);
    assert.equal(requests,0);
    await host.evaluate(()=>window.testTone.stop());

    assert.equal(await phone.locator('.reply').count(),0);
    for(const peer of provider.clients)peer.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'filler',transcript:'Take your time.'}));
    await phone.locator('.voice').getByText('Take your time.').waitFor();
    assert.equal(requests,0);
    const tappedAt=performance.now();
    await phone.locator('#ask').click();
    await phone.locator('.reply').getByText(answer,{exact:true}).waitFor();
    assert.equal(await phone.getByRole('heading',{name:'Full Details'}).count(),0);
    assert.ok((await phone.locator('.reply').innerText()).includes(answer));
    assert.equal(requests,1);
    t.diagnostic('Tap to rendered answer with simulated provider: '+Math.round(performance.now()-tappedAt)+' ms');
    assert.ok(performance.now()-tappedAt<2000);
    const followUp='Which failure would you simulate?';
    for(const peer of provider.clients)peer.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'followup',transcript:followUp}));
    await phone.locator('#last-question').getByText(followUp,{exact:true}).waitFor();
    await phone.locator('.voice').getByText(followUp,{exact:true}).waitFor();
    assert.equal(await phone.locator('#ask').isDisabled(),true);
    finishAnswer();
    const details=phone.locator('.reply details').first();
    await details.locator('summary').waitFor();
    assert.equal(await details.evaluate(box=>box.open),false);
    assert.equal(await phone.locator('#prompt-toggle').getAttribute('aria-pressed'),'false');
    await details.locator('summary').click();
    await phone.locator('.reply').getByText(/End of answer/).waitFor();
    await phone.locator('#prompt-toggle').click();
    await phone.waitForFunction(()=>document.querySelector('#transcript').scrollTop>0);
    await phone.locator('#prompt-toggle').click();
    assert.equal(await phone.locator('#prompt-toggle').getAttribute('aria-pressed'),'false');
    await phone.locator('#ask').click();
    await phone.locator('.reply').nth(1).getByRole('heading',{name:'Quick Answer'}).waitFor();
    assert.deepEqual(await phone.locator('.bubble > strong').allTextContents(),['Voice transcript','Voice transcript','Answer','Voice transcript','Answer']);
    await phone.locator('.reply').nth(1).getByText(answer,{exact:true}).waitFor();
    finishAnswer();
    hostSockets[0].destroy();
    await host.getByText('Disconnected',{exact:true}).waitFor();
    assert.equal(await host.locator('#background').inputValue(),'My preparation');
    assert.equal(await host.evaluate(()=>window.testStream.active),false);
    await start();
    await host.locator('#end').click();
    await host.waitForFunction(()=>document.querySelector('#background')?.value==='' && document.querySelector('#phase')?.textContent.includes('Standby'));
  }finally{await browser.close();}
});


