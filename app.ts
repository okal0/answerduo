const el=(id:string)=>document.getElementById(id);
const set=(id:string,value:string)=>{el(id).textContent=value};
const show=(id:string,visible:boolean)=>{el(id).hidden=!visible};
const stop=(stream?:MediaStream)=>stream?.getTracks().forEach(t=>t.stop());
const socket=(id:string)=>new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/socket?id='+encodeURIComponent(id));
async function accessEnded(){
  try{
    const account=await(await fetch('/api/account')).json();
    location.href=account.role==='guest'?'/account?trial=ended':'/pricing?trial=ended';
  }catch{location.href='/account?trial=ended';}
}
async function post(path:string,data:{provider?:string;[field:string]:unknown}){
  const response=await fetch('/api/'+(data.provider==='gemini'?'gemini/':'')+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  if(!response.ok){
    if(response.status===402){await accessEnded();throw Error('Free access ended.');}
    const problem=await response.json().catch(()=>null);
    throw Error(problem?.message || (response.status===401?'Invalid API key. Check the key and try again.':'Request failed ('+response.status+'). Check access and try again.'));
  }
  return response.json();
}
function appendInline(target:DocumentFragment,text:string){
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
function appendProse(target:DocumentFragment,text:string){
  const headings=/^#{2,3} ([^\n]+)\r?$/gm;
  let cursor=0;
  for(const match of text.matchAll(headings)){
    appendInline(target,text.slice(cursor,match.index));
    const heading=document.createElement(match[0].startsWith('### ')?'h4':'h3');
    heading.textContent=match[1];
    target.append(heading);
    cursor=match.index+match[0].length;
  }
  appendInline(target,text.slice(cursor));
}
function renderAnswer(root:HTMLElement,text:string){
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
  const feed=el('transcript'),toggle=el('prompt-toggle');
  let follow=true,frame=0,lastTime=0,pixels=0;
  function advance(now:number){
    frame=0;
    if(!follow || feed.clientHeight===0 || feed.scrollHeight-feed.clientHeight-feed.scrollTop<1)return;
    pixels+=Math.min(now-lastTime,100)*0.045;lastTime=now;
    if(pixels>=1){feed.scrollTop+=Math.floor(pixels);pixels%=1;}
    frame=requestAnimationFrame(advance);
  }
  function scrollFeed(){
    if(follow&&!frame){lastTime=performance.now();frame=requestAnimationFrame(advance);}
  }
  function autoScroll(on:boolean){
    follow=on;toggle.setAttribute('aria-pressed',String(on));
    toggle.textContent=on?'Ⅱ':'▶';toggle.title=on?'Pause auto-scroll':'Resume auto-scroll';scrollFeed();
  }
  toggle.onclick=()=>autoScroll(!follow);
  feed.addEventListener('touchstart',()=>autoScroll(false),{passive:true});
  feed.addEventListener('wheel',()=>autoScroll(false),{passive:true});
  let answerBody,turnId,lastTranscript='';
  let utterances:{text:string,body:HTMLElement}[]=[];
  function bubble(label:string,kind:string){
    const article=document.createElement('article'),heading=document.createElement('strong'),body=document.createElement('div');
    article.className='bubble '+kind;heading.textContent=label;
    article.append(heading,body);feed.append(article);return body;
  }
  function updateVoice(text:string){
    if(text===lastTranscript)return;
    lastTranscript=text;
    const lines=text.split('\n').filter(line=>line.trim());
    // At the relay's transcript limit the oldest lines drop out of its snapshot.
    if(text.length>=15999 && utterances.length && lines[0]!==utterances[0].text){
      const first=utterances.findIndex(item=>item.text.endsWith(lines[0]));
      if(first>0)utterances=utterances.slice(first);
    }
    lines.forEach((line,index)=>{
      const item=utterances[index]??{text:'',body:bubble('Voice transcript','voice')};
      if(item.text!==line){item.text=line;item.body.textContent=line;}
      utterances[index]=item;
    });
    for(const stale of utterances.splice(lines.length))stale.body.parentElement.remove();
  }
  let provisionalBody,tappedAt:number|undefined;
  function makeAnswerCard(action,question){
    const body=bubble(action==='Analyze screen'?'Screen analysis':'Answer','reply');
    if(action==='Answer question'){
      if(question){
        const title=document.createElement('h2');
        title.className='reply-question';title.textContent=question;body.before(title);
      }
      const heading=document.createElement('h3');
      heading.textContent='Quick Answer';body.before(heading);
      const details=document.createElement('details'),summary=document.createElement('summary');
      summary.textContent='Full Details';details.className='answer-details';details.hidden=true;
      details.append(summary,document.createElement('div'));body.after(details);
    }
    return body;
  }
  function updateConversation(msg){
    updateVoice(msg.transcript);
    const question=msg.previewQuestion||msg.question;
    if(question)set('last-question',question);
    if(msg.turnId&&msg.turnId!==turnId){
      turnId=msg.turnId;
      answerBody=provisionalBody??makeAnswerCard(msg.turnAction,question);
      provisionalBody=null;
      if(follow)feed.scrollTop=feed.scrollHeight-feed.clientHeight;
    }
    if(answerBody){
      const text=msg.answer||(msg.action?'Preparing…':msg.notice||'No answer received.');
      const details=answerBody.nextElementSibling;
      if(details?.classList.contains('answer-details')){
        const marker=/^#{1,3} Full Details[ \t]*\r?$/im.exec(text);
        let quick=marker?text.slice(0,marker.index):text;
        if(msg.action && !marker)quick=quick.replace(/\n#+[^\n]*$/,'');
        renderAnswer(answerBody,quick.trimEnd());
        if(msg.answer && !answerBody.dataset.started){
          answerBody.dataset.started='true';
          const top=answerBody.parentElement.getBoundingClientRect().top-feed.getBoundingClientRect().top;
          if(top>0)feed.scrollTop+=top;
        }
        details.hidden=!marker;
        if(marker)renderAnswer(details.lastElementChild,text.slice(marker.index+marker[0].length).trimStart());
        const title=answerBody.parentElement.querySelector('.reply-question');
        if(title && msg.question)title.textContent=msg.question;
      }else renderAnswer(answerBody,text);
    }
    if(!pending && tappedAt!==undefined && msg.turnAction==='Answer question' && msg.answer?.trim() &&
       (/[.!?。！？](?:\s|$)/u.test(msg.answer)||!msg.action)){
      performance.measure('AnswerDuo: tap to first sentence',{start:tappedAt,end:performance.now()});
      tappedAt=undefined;
    }
    scrollFeed();
  }
  function controls(){const disabled=ws?.readyState!==1||!state||!!state.action||pending;el('ask').disabled=disabled;el('analyze').disabled=disabled;}
  async function init(){
    let auth=JSON.parse(sessionStorage.getItem('relay-phone')||'null');
    if(location.hash){const [id,ticket]=location.hash.slice(1).split('.');history.replaceState(null,'','/phone');auth={id,...await post('pair',{id,ticket})};sessionStorage.setItem('relay-phone',JSON.stringify(auth));}
    if(!auth)throw Error('Scan a new pairing code on your computer.');
    function connect(){
      ws=socket(auth.id);ws.onopen=()=>ws.send(JSON.stringify(auth));
      ws.onmessage=({data})=>{const msg=JSON.parse(data);
        if(msg.type==='connection-timeout'){done=true;sessionStorage.removeItem('relay-phone');ws.onclose=null;state=null;controls();set('connection','Computer connection timed out');el('notice').innerHTML='On your computer, open the workspace and choose <strong>Start session</strong> again.';return;}
        if(msg.type==='trial-ended'){set('notice','Free access ended. Open your computer to register or check your trial.');return;}
        if(msg.type==='ended'){done=true;return;}
        if(msg.type!=='state')return;delay=400;state=msg;if(!provisionalBody||msg.turnId!==turnId)pending=false;
        set('connection',msg.paused?'Connected · Audio paused':'Connected');
        updateConversation(msg);
        set('notice',msg.action?msg.action+' · Running':msg.notice);controls();
      };
      ws.onclose=e=>{provisionalBody?.parentElement.remove();provisionalBody=null;pending=false;state=null;controls();if(done||e.code===4001||e.code===4003){sessionStorage.removeItem('relay-phone');set('connection','Session ended');set('notice','Scan a new code to reconnect.');return;}
        set('connection','Reconnecting…');setTimeout(connect,delay);delay=Math.min(delay*2,5000);
      };
    }connect();
    for(const [id,action] of [['ask','Answer question'],['analyze','Analyze screen']]){
      el(id).onclick=()=>{
        if(pending||state?.action||ws.readyState!==1)return;
        pending=true;
        tappedAt=action==='Answer question'?performance.now():undefined;
        provisionalBody=makeAnswerCard(action,state.previewQuestion||state.question);
        controls();
        feed.scrollTop=feed.scrollHeight-feed.clientHeight;autoScroll(action!=='Answer question');
        ws.send(JSON.stringify({type:'command',action}));
      };
    }
  }init().catch(()=>{set('connection','Unable to pair');set('notice','Scan a fresh pairing code on your computer.');});
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
        script.onerror=()=>reject(Error('Word reader unavailable. Restart AnswerDuo and refresh.'));
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
  function feedback(id:string,message:string,error=false){
    const box=el(id);
    box.classList.toggle('setup-error',error);
    box.setAttribute('role',error?'alert':'status');
    box.textContent=message;
  }
  let trialEnded=false;
  const accountBar=document.createElement('div');
  accountBar.className='account-bar';
  const accountLink=document.createElement('a');
  accountLink.href='/account';accountLink.textContent='Account';
  const plan=document.createElement('span');
  accountBar.append(plan,accountLink);
  document.querySelector('main').prepend(accountBar);
  fetch('/api/account').then(response=>response.json()).then(account=>{
    plan.textContent=account.member?'Membership active':account.role==='guest'?'Guest preview · '+Math.ceil(account.remainingMs/60000)+' minutes remaining · Register for 7 days free':account.remainingMs>0?'Free trial · '+Math.ceil(account.remainingMs/86400000)+' days remaining':'Free trial ended · License required (coming soon)';
  }).catch(()=>{plan.textContent='Account status unavailable';});

  const filePicker=el('cv-file'),notes=el('background');
  filePicker.onchange=async()=>{
    const file=filePicker.files[0];
    if(!file)return;
    filePicker.disabled=true;
    feedback('cv-status','Reading file on this computer…');
    try{
      const imported=(await readCV(file)).trim();
      if(!imported)throw Error('No readable text found. For a scanned CV, paste text or choose a text-based PDF.');
      const combined=[notes.value.trimEnd(),imported].filter(Boolean).join('\n\n');
      if(combined.length>notes.maxLength)throw Error('These notes would exceed 20,000 characters. Paste a shorter excerpt instead.');
      notes.value=combined;syncAnswerInputs();
      feedback('cv-status','Imported '+file.name+'. Review the text below.');
    }catch(error){
      feedback('cv-status',error.name==='PasswordException'?'Unlock the PDF and try again.':error.message||'Could not read this file. Paste its text instead.',true);
    }finally{filePicker.value='';filePicker.disabled=false;}
  };

  let meeting,visual,video,ctx,ws,valid=false,paused=false,ready=false,started=false,frames=0,quiet=0,elapsed=0,expiry=0;
  const provider=el('provider');
  const input=el('key');const send=o=>{if(ws?.readyState===1)ws.send(JSON.stringify(o));};
  const answerInputs=()=>({
    background:el('background').value.trim(),
    preparation:{role:el('target-role').value.trim(),codingLanguage:el('coding-language').value,answerLanguage:el('answer-language').value.trim()}
  });
  function syncAnswerInputs(){if(ws?.readyState===1)send({type:'answer-inputs',...answerInputs()});}
  for(const id of ['background','target-role','coding-language','answer-language'])el(id).addEventListener('input',syncAnswerInputs);
  let ending=false,captureGeneration=0,previewClock,previewListener;
  const available=()=>{
    const hasKey=!!input.value.trim();
    const hasAudio=!!meeting?.getAudioTracks().some(track=>track.readyState==='live');
    el('start').disabled=started||!hasKey||!hasAudio;
    set('start-help',started?'Starting your session…':!hasKey?'Enter your provider API key to continue.':!hasAudio?'Share meeting or computer audio to continue.':'Ready to start. Your API key will be checked when you start the session.');
  };
  const status=(notice?:string)=>send({type:'status',paused,visual:!!visual,notice});
  const wave=document.querySelector('.wave');
  for(let i=0;i<60;i++){const b=document.createElement('b');b.style.height=(4+Math.abs(Math.sin(i*.9)*Math.cos(i*.21))*27)+'px';wave.append(b);}
  provider.onchange=()=>{
    input.value='';valid=false; feedback('keymsg',''); available();
    input.placeholder=provider.value==='gemini'?'Gemini API key':'sk-…';
    input.setAttribute('aria-label',provider.selectedOptions[0].text+' API key');
  };
  input.oninput=()=>{valid=false;feedback('keymsg','');available();};
  el('validate').onclick=async()=>{const key=input.value.trim();const selected=provider.value;el('validate').disabled=true;try{await post('validate',{key,provider:selected});valid=selected===provider.value&&key===input.value.trim();feedback('keymsg',valid?'Key validated':'Key changed. Validate again.');}catch(e){valid=false;feedback('keymsg',e.message,true);}finally{el('validate').disabled=false;available();}};
  async function selectAudio(){
    const generation=captureGeneration;
    let next,context;
    try{
      feedback('audiomsg','Waiting for your sharing selection…');
      next=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include',selfBrowserSurface:'exclude'});
      const screen=next.getVideoTracks()[0];
      const surface=screen?.getSettings().displaySurface;
      const audio=next.getAudioTracks().find(track=>track.readyState==='live');
      if(!audio){
        const fix=surface==='monitor'?'Select your screen again and turn on “Also share system audio”. If that option is missing, share your meeting tab with tab audio enabled.':'Select your meeting tab again and turn on “Also share tab audio”. For an entire screen, turn on “Also share system audio”.';
        throw Error('Audio wasn’t shared. '+fix);

      }
      context=new AudioContext({sampleRate:24000});await context.audioWorklet.addModule('/pcm.js');await context.resume();
      if(generation!==captureGeneration){stop(next);await context.close();return;}
      const src=context.createMediaStreamSource(next),node=new AudioWorkletNode(context,'meeting-pcm');src.connect(node);node.connect(context.destination);
      stop(meeting);ctx?.close();meeting=next;ctx=context;feedback('audiomsg',(surface==='monitor'?'Computer audio shared. ':surface==='window'?'Window audio shared. ':'Meeting audio shared. ')+'Waiting for sound.');set('signal','Monitoring shared audio');set('audio','Change audio source');available();
      for(const t of next.getTracks())t.onended=()=>{if(meeting!==next)return;stop(meeting);meeting=null;context.close();el('level').value=0;available();feedback('audiomsg','Shared audio ended. Select an audio source again.',true);set('signal','Waiting for meeting audio');status('Shared audio ended. Select a source on your computer.');};
      let detected=false;
      node.port.onmessage=({data})=>{
        if(meeting!==next)return;let energy=0;for(const sample of data)energy+=sample*sample;
        const rms=Math.sqrt(energy/data.length)/32768;el('level').value=Math.min(1,rms*5);
        if(!detected&&rms>.005){detected=true;feedback('audiomsg','Audio detected from your shared source.');}
        if(!ready||paused||ws?.readyState!==1)return;
        if(ws.bufferedAmount>192000)return;
        ws.send(data);frames++;
        if(rms>.005){quiet=0;elapsed++;}
        else quiet++;
        if((quiet>=4&&elapsed>0&&frames>=4)||frames>=200){send({type:'commit'});frames=quiet=elapsed=0;}
      };
    }catch(e){if(next!==meeting)stop(next);if(context&&context!==ctx)context.close();feedback('audiomsg',e.name==='NotAllowedError'?'Audio sharing was canceled or blocked. Select an audio source and allow sharing.':e.message||'Could not share meeting audio.',true);}
    finally{available();}
  }el('audio').onclick=selectAudio;
  available();
  el('visual').onclick=async()=>{const generation=captureGeneration;let next;try{
    next=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});const preview=document.createElement('video');preview.muted=true;preview.playsInline=true;preview.srcObject=next;await preview.play();
    if(generation!==captureGeneration){stop(next);return;}
    stop(visual);visual=next;video=preview;const track=next.getVideoTracks()[0];feedback('visualmsg',track.label);set('visual','Change visual source');status('');
    track.onended=()=>{if(visual!==next)return;visual=null;video=null;feedback('visualmsg','Visual sharing ended. Select a window again to analyze it.',true);status('Select a window on your computer');};
  }catch(e){if(next!==visual)stop(next);feedback('visualmsg',e.message||'Select a window again to share it.',true);}};
  function code(m){expiry=m.expires;el('qr').src=m.qr;show('qr',true);document.querySelector('.device').hidden=true;set('pairhint','Scan with your phone camera within two minutes.');show('renew',true);}
  setInterval(()=>{if(expiry&&Date.now()>=expiry){expiry=0;show('qr',false);set('pairhint','Code expired. Refresh to pair your phone.');}},1000);
  el('renew').onclick=()=>send({type:'ticket'});
  el('start').onclick=async()=>{started=true;available();input.disabled=true;provider.disabled=true;el('validate').disabled=true;
    try{
      const auth=await post('session',{key:input.value.trim(),provider:provider.value});input.value='';feedback('notice','');
      if(auth.previewDeadline){
        const updateClock=()=>{
          const seconds=Math.max(0,Math.ceil((auth.previewDeadline-Date.now())/1000));
          plan.textContent='Guest preview · '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+' remaining';
          if(seconds<=120){accountLink.textContent='Register for 7 days free';accountLink.target='_blank';accountLink.rel='noopener';}
        };
        updateClock();previewClock=setInterval(updateClock,1000);
        previewListener=async()=>{
          if(document.hidden)return;
          const current=await fetch('/api/account').then(r=>r.json()).catch(()=>null);
          if(current&&current.role!=='guest'){clearInterval(previewClock);plan.textContent='Registered account';accountLink.textContent='Account';}
        };
        document.addEventListener('visibilitychange',previewListener);
      }
      ws=socket(auth.id);
      ws.onopen=()=>{send({id:auth.id,credential:auth.credential});syncAnswerInputs();status();code(auth);show('start',false);show('pause',true);show('end',true);set('phase','● Connecting');};
      ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.type==='connection-timeout'){ws.close();return;}if(m.type==='trial-ended'){trialEnded=true;void accessEnded();return;}if(m.type==='ready'){ready=true;set('phase','● Live');}
        if(m.type==='ticket')code(m);
        if(m.type==='state'){
          set('paired',m.paired?'Connected':'Offline');feedback('notice',m.notice);
          if(m.paired){expiry=0;show('qr',false);show('renew',false);set('pairtitle','Phone connected');set('pairhint','Your companion is ready.');}
        }
        if(m.type==='command'){let image;if(m.action==='Analyze screen'&&visual?.getVideoTracks()[0]?.readyState==='live'&&video?.readyState>=2){
          try{const canvas=document.createElement('canvas');const scale=Math.min(1,1600/video.videoWidth);canvas.width=video.videoWidth*scale;canvas.height=video.videoHeight*scale;canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);image=canvas.toDataURL('image/jpeg',.82);}catch{}
        }
          const inputs=answerInputs();
          send({type:'generate',request:m.request,image,...inputs,background:m.action==='Answer question'?inputs.background:undefined});

        }
      };
      ws.onclose=()=>{
        captureGeneration++;ready=false;
        stop(meeting);stop(visual);
        if(ctx && ctx.state!=='closed')void ctx.close();
        clearInterval(previewClock);
        if(previewListener)document.removeEventListener('visibilitychange',previewListener);
        if(trialEnded)return;
        if(ending){notes.value='';location.reload();return;}
        meeting=visual=video=ctx=ws=null;
        started=paused=valid=false;
        frames=quiet=elapsed=expiry=0;
        input.disabled=provider.disabled=el('validate').disabled=false;
        feedback('keymsg','');el('level').value=0;
        set('audio','Select audio source');set('visual','Select visual source');
        feedback('audiomsg','');feedback('visualmsg','');set('signal','Waiting for meeting audio');
        set('phase','Disconnected');set('paired','Offline');set('pause','Pause');
        show('qr',false);el('qr').removeAttribute('src');show('renew',false);
        document.querySelector('.device').hidden=false;
        set('pairtitle','Pair your phone');set('pairhint','Start a session to reveal your pairing code.');
        show('end',false);show('pause',false);show('start',true);set('start','Start a new session');
        feedback('notice','The computer lost its session connection. Sharing has stopped. Your preparation is still here. Enter your key and select audio to start a new session.');
        available();
      };
    }catch(e){feedback('notice',e.message,true);el('notice').scrollIntoView({block:'nearest'});started=false;input.disabled=false;provider.disabled=false;el('validate').disabled=false;available();}
  };
  el('pause').onclick=()=>{paused=!paused;if(paused&&frames>=2){send({type:'commit'});frames=quiet=elapsed=0;}set('pause',paused?'Resume':'Pause');set('phase',paused?'● Paused':'● Live');status();};
  el('end').onclick=()=>{ending=true;ready=false;stop(meeting);stop(visual);send({type:'end'});};
  window.addEventListener('pagehide',()=>{el('background').value='';ready=false;stop(meeting);stop(visual);ws?.close();});
}
if(location.pathname==='/phone')phone();else host();
