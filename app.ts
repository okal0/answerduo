const el=(id:string)=>document.getElementById(id);
const set=(id:string,value:string)=>{el(id).textContent=value};
const show=(id:string,visible:boolean)=>{el(id).hidden=!visible};
const stop=(stream?:MediaStream)=>stream?.getTracks().forEach(t=>t.stop());
const socket=()=>new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/socket');
async function post(path:string,data:{provider?:string;[field:string]:unknown}){
  const response=await fetch('/api/'+(data.provider==='gemini'?'gemini/':'')+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  if(!response.ok){
    const problem=await response.json().catch(()=>null);
    throw Error(problem?.message || (response.status===401?'Invalid API key. Check the key and try again.':'Request failed ('+response.status+'). Check access and try again.'));
  }
  return response.json();
}
function appendProse(target:DocumentFragment,text:string){
  if(!window.katex){target.append(text);return;}
  // Match complete formulas only. A partial streamed expression stays readable.
  const tokens=/\x60[^\x60\n]*\x60|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|(?<![\\\d])\$(?!\s)([^\n$]+?)(?<![\s\\])\$(?!\d)/g;
  let cursor=0;
  for(const match of text.matchAll(tokens)){
    target.append(text.slice(cursor,match.index));
    const formula=match.slice(1).find(value=>value!==undefined);
    if(formula===undefined)target.append(match[0]);
    else{
      const math=document.createElement('span');
      const displayMode=match[2]!==undefined||match[3]!==undefined;
      try{
        window.katex.render(formula,math,{output:'mathml',displayMode,trust:false,maxExpand:300,maxSize:10});
        if(displayMode)math.className='display-formula';
        target.append(math);
      }catch{target.append(match[0]);}
    }
    cursor=match.index+match[0].length;
  }
  target.append(text.slice(cursor));
}
function renderAnswer(text:string){
  const root=el('answer');
  if(root.dataset.rendered===text)return;
  root.dataset.rendered=text;
  const fragment=document.createDocumentFragment();
  const fence=/^[ \t]*`{3,}([^\n`]*)(?:\n|$)/gm;
  let cursor=0, opening, blockIndex=0;
  const offsets=Array.from(root.querySelectorAll('pre'),pre=>pre.scrollLeft);
  while((opening=fence.exec(text))){
    appendProse(fragment,text.slice(cursor,opening.index));
    const language=opening[1].trim()||'Code';
    const start=fence.lastIndex;
    const closing=fence.exec(text);
    const source=text.slice(start,closing?.index??text.length).replace(/\n$/,'');
    const panel=document.createElement('section');
    panel.className='code-panel';
    const bar=document.createElement('div');
    bar.className='code-toolbar';
    const copy=document.createElement('button');
    copy.textContent='Copy code';
    copy.onclick=async()=>{
      try{await navigator.clipboard.writeText(source);copy.textContent='Copied';}
      catch{copy.textContent='Select code to copy';}
    };
    bar.append(language,copy);
    const pre=document.createElement('pre'),code=document.createElement('code');
    code.textContent=source;
    pre.append(code);panel.append(bar,pre);fragment.append(panel);
    cursor=closing?fence.lastIndex:text.length;
    if(!closing)break;
  }
  appendProse(fragment,text.slice(cursor));root.replaceChildren(fragment);
  for(const pre of root.querySelectorAll('pre'))pre.scrollLeft=offsets[blockIndex++]||0;
}
function phone(){
  let ws,done=false,state,delay=400,pending=false;
  function controls(){const disabled=ws?.readyState!==1||!state||!!state.action||pending;el('ask').disabled=disabled;el('analyze').disabled=disabled;}
  async function init(){
    let auth=JSON.parse(sessionStorage.getItem('relay-phone')||'null');
    if(location.hash){const [id,ticket]=location.hash.slice(1).split('.');history.replaceState(null,'','/phone');auth={id,...await post('pair',{id,ticket})};sessionStorage.setItem('relay-phone',JSON.stringify(auth));}
    if(!auth)throw Error('Scan a new pairing code on your laptop.');
    function connect(){
      ws=socket();ws.onopen=()=>ws.send(JSON.stringify(auth));
      ws.onmessage=({data})=>{const msg=JSON.parse(data);
        if(msg.type==='ended'){done=true;return;}
        if(msg.type!=='state')return;delay=400;state=msg;pending=false;
        set('connection',msg.paused?'Connected · Audio paused':'Connected');const preview=msg.previewQuestion||msg.transcript.trim().split('\n').at(-1);
        const nextQuestion=!msg.action && msg.hasNewRequest && msg.question && msg.question!==msg.previewQuestion;
        if(el('answer-label'))set('answer-label',nextQuestion && msg.answer?'Answer to: '+msg.question:'Answer');
        set('question',(nextQuestion?msg.previewQuestion:msg.question)||preview||(msg.action==='Answer question'?'Identifying the question…':'Waiting for a question'));
        const waiting=msg.action==='Answer question'?'Preparing your answer…':'Analyzing the shared screen…';
        renderAnswer(msg.answer || (msg.action?waiting:msg.notice) || 'Tap an action below when you’re ready.');
        const scroll=window.scrollY;set('transcript',msg.transcript||'Waiting for meeting audio.');window.scrollTo(0,scroll);
        set('notice',msg.action?msg.action+' · Running':msg.notice);controls();
      };
      ws.onclose=e=>{state=null;controls();if(done||e.code===4001||e.code===4003){sessionStorage.removeItem('relay-phone');set('connection','Session ended');set('notice','Scan a new code to reconnect.');return;}
        set('connection','Reconnecting…');setTimeout(connect,delay);delay=Math.min(delay*2,5000);
      };
    }connect();
    for(const [id,action] of [['ask','Answer question'],['analyze','Analyze screen']]){
      el(id).onclick=()=>{
        if(pending||state?.action||ws.readyState!==1)return;
        pending=true;
        controls();
        renderAnswer('Sending your request to the laptop…');
        el('answer').scrollIntoView({block:'center'});
        ws.send(JSON.stringify({type:'command',action}));
      };
    }
  }init().catch(()=>{set('connection','Unable to pair');set('notice','Scan a fresh pairing code on your laptop.');});
}
async function readCV(file:File){
  if(file.size>5*1024*1024)throw Error('Choose a file under 5 MB.');
  const format=file.name.split('.').pop()?.toLowerCase();
  if(format==='txt')return file.text();
  if(format==='docx'){
    if(!window.mammoth){
      await new Promise<void>((resolve,reject)=>{
        const script=document.createElement('script');
        script.src='/cv-docx.js';script.onload=()=>resolve();
        script.onerror=()=>reject(Error('Word reader unavailable. Restart InterviewDuo and refresh.'));
        document.head.append(script);
      });
    }
    return (await window.mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()})).value;
  }
  if(format!=='pdf')throw Error('Choose a PDF, DOCX, or plain text file.');
  const pdf=await import('/cv-pdf.mjs');
  pdf.GlobalWorkerOptions.workerSrc='/cv-worker.mjs';
  const task=pdf.getDocument({data:await file.arrayBuffer(),isEvalSupported:false});
  try{
    const doc=await task.promise;
    const pages=[];
    let length=0;
    for(let i=1;i<=doc.numPages;i++){
      const page=await doc.getPage(i);
      const content=await page.getTextContent();
      const text=content.items.map(item=>item.str?item.str+(item.hasEOL?'\n':' '):'').join('');
      pages.push(text);length+=text.length;
      if(length>20000)break;
    }
    return pages.join('\n').trim();
  }finally{await task.destroy();}
}
function host(){
  const filePicker=el('cv-file'),notes=el('background');
  filePicker.onchange=async()=>{
    const file=filePicker.files[0];
    if(!file)return;
    filePicker.disabled=true;
    set('cv-status','Reading file on this laptop…');
    try{
      const imported=(await readCV(file)).trim();
      if(!imported)throw Error('No readable text found. For a scanned CV, paste text or choose a text-based PDF.');
      const combined=[notes.value.trimEnd(),imported].filter(Boolean).join('\n\n');
      if(combined.length>notes.maxLength)throw Error('These notes would exceed 20,000 characters. Paste a shorter excerpt instead.');
      notes.value=combined;
      set('cv-status','Imported '+file.name+'. Review the text below.');
    }catch(error){
      set('cv-status',error.name==='PasswordException'?'Unlock the PDF and try again.':error.message||'Could not read this file. Paste its text instead.');
    }finally{filePicker.value='';filePicker.disabled=false;}
  };

  let meeting,visual,video,ctx,ws,valid=false,paused=false,ready=false,started=false,frames=0,quiet=0,elapsed=0,expiry=0;
  const provider=el('provider');
  const input=el('key');const send=o=>{if(ws?.readyState===1)ws.send(JSON.stringify(o));};
  const available=()=>el('start').disabled=started||!valid||!meeting;
  const status=(notice?:string)=>send({type:'status',paused,visual:!!visual,notice});
  const wave=document.querySelector('.wave');
  for(let i=0;i<60;i++){const b=document.createElement('b');b.style.height=(4+Math.abs(Math.sin(i*.9)*Math.cos(i*.21))*27)+'px';wave.append(b);}
  provider.onchange=()=>{
    input.value='';valid=false; set('keymsg',''); available();
    input.placeholder=provider.value==='gemini'?'Gemini API key':'sk-…';
    input.setAttribute('aria-label',provider.selectedOptions[0].text+' API key');
  };
  input.oninput=()=>{valid=false;set('keymsg','');available();};
  el('validate').onclick=async()=>{const key=input.value.trim();const selected=provider.value;el('validate').disabled=true;try{await post('validate',{key,provider:selected});valid=selected===provider.value&&key===input.value.trim();set('keymsg',valid?'Key validated':'Key changed. Validate again.');}catch(e){valid=false;set('keymsg',e.message);}finally{el('validate').disabled=false;available();}};
  async function selectAudio(){
    let next,context;
    try{
      set('audiomsg','Waiting for your sharing selection…');
      next=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser'},audio:true,selfBrowserSurface:'exclude'});
      const screen=next.getVideoTracks()[0];
      const surface=screen?.getSettings().displaySurface;
      const audio=next.getAudioTracks().find(track=>track.readyState==='live');
      if(!audio){
        const source=surface==='monitor'?'a display':surface==='window'?'a window':surface==='browser'?'a browser tab':'a shared source';
        throw Error('The browser returned '+source+' with no live audio track. In desktop Chrome, choose “Chrome Tab”, select the meeting, turn on “Also share tab audio”, then click Share.');
      }
      context=new AudioContext({sampleRate:24000});await context.audioWorklet.addModule('/pcm.js');await context.resume();
      const src=context.createMediaStreamSource(next),node=new AudioWorkletNode(context,'meeting-pcm');src.connect(node);node.connect(context.destination);
      stop(meeting);ctx?.close();meeting=next;ctx=context;set('audiomsg','Audio connected · '+(screen?.label||audio.label||'Shared source'));set('signal','Monitoring shared audio');set('audio','Change meeting tab');available();
      for(const t of next.getTracks())t.onended=()=>{if(meeting!==next)return;stop(meeting);meeting=null;context.close();el('level').value=0;available();set('audiomsg','Meeting audio ended. Select the meeting tab again.');set('signal','Waiting for meeting audio');status('Meeting audio ended. Reselect the tab on your laptop.');};
      node.port.onmessage=({data})=>{
        if(meeting!==next)return;let energy=0;for(const sample of data)energy+=sample*sample;
        const rms=Math.sqrt(energy/data.length)/32768;el('level').value=Math.min(1,rms*5);
        if(!ready||paused||ws?.readyState!==1)return;
        if(ws.bufferedAmount>192000)return;
        ws.send(data);frames++;if(rms>.005){quiet=0;elapsed++;}else quiet++;
        if((quiet>=6&&elapsed>0&&frames>=8)||frames>=200){send({type:'commit'});frames=quiet=elapsed=0;}
      };
    }catch(e){if(next!==meeting)stop(next);if(context&&context!==ctx)context.close();set('audiomsg',e.message||'Could not share meeting audio.');}
  }el('audio').onclick=selectAudio;
  el('visual').onclick=async()=>{let next;try{
    next=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});const preview=document.createElement('video');preview.muted=true;preview.playsInline=true;preview.srcObject=next;await preview.play();
    stop(visual);visual=next;video=preview;const track=next.getVideoTracks()[0];set('visualmsg',track.label);set('visual','Change visual source');status('');
    track.onended=()=>{if(visual!==next)return;visual=null;video=null;set('visualmsg','Select a window on your laptop');status('Select a window on your laptop');};
  }catch(e){if(next!==visual)stop(next);set('visualmsg',e.message);}};
  function code(m){expiry=m.expires;el('qr').src=m.qr;show('qr',true);document.querySelector('.device').hidden=true;set('pairhint','Scan with your phone camera within two minutes.');show('renew',true);}
  setInterval(()=>{if(expiry&&Date.now()>=expiry){expiry=0;show('qr',false);set('pairhint','Code expired. Refresh to pair your phone.');}},1000);
  el('renew').onclick=()=>send({type:'ticket'});
  el('start').onclick=async()=>{started=true;available();input.disabled=true;provider.disabled=true;el('validate').disabled=true;
    try{
      const auth=await post('session',{key:input.value.trim(),provider:provider.value});input.value='';ws=socket();
      ws.onopen=()=>{send({id:auth.id,credential:auth.credential});status();code(auth);show('start',false);show('pause',true);show('end',true);set('phase','● Connecting');};
      ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.type==='ready'){ready=true;set('phase','● Live');}
        if(m.type==='ticket')code(m);
        if(m.type==='state'){set('paired',m.paired?'Connected':'Offline');set('notice',m.notice);
          if(m.paired){expiry=0;show('qr',false);show('renew',false);set('pairtitle','Phone connected');set('pairhint','Your companion is ready.');}
        }
        if(m.type==='command'){let image;if(m.action==='Analyze screen'&&visual?.getVideoTracks()[0]?.readyState==='live'&&video?.readyState>=2){
          try{const canvas=document.createElement('canvas');const scale=Math.min(1,1600/video.videoWidth);canvas.width=video.videoWidth*scale;canvas.height=video.videoHeight*scale;canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);image=canvas.toDataURL('image/jpeg',.82);}catch{}
        }
          const background=m.action==='Answer question'?el('background').value.trim():undefined;
          send({type:'generate',request:m.request,image,background});
        }
      };
      ws.onclose=()=>{el('background').value='';ready=false;stop(meeting);stop(visual);ctx?.close();location.reload();};
    }catch(e){set('notice',e.message);started=false;input.disabled=false;provider.disabled=false;el('validate').disabled=false;available();}
  };
  el('pause').onclick=()=>{paused=!paused;if(paused&&frames>=2){send({type:'commit'});frames=quiet=elapsed=0;}set('pause',paused?'Resume':'Pause');set('phase',paused?'● Paused':'● Live');status();};
  el('end').onclick=()=>{ready=false;stop(meeting);stop(visual);send({type:'end'});};
  window.addEventListener('pagehide',()=>{el('background').value='';ready=false;stop(meeting);stop(visual);ws?.close();});
}
if(location.pathname==='/phone')phone();else host();
