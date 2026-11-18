import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import WebSocket, { WebSocketServer } from 'ws';
import * as gemini from './gemini.ts';
import * as accounts from './accounts.ts';
import { readAnswerInputs,recentRequest,answer as generateAnswer } from './session-logic.ts';
export { recentRequest } from './session-logic.ts';
import QRCode from 'qrcode';

const token = () => randomBytes(32).toString('base64url');
const rooms = new Map();
const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:3000';
const localHostPort=Number(process.env.RELAY_LOCAL_HOST_PORT||0);
function allowedOrigin(req){
  const expected=localHostPort && req.socket.localPort===localHostPort ? 'http://localhost:'+localHostPort : origin;
  return req.headers.origin===expected;
}
if (!origin.startsWith('https://') && !/^http:\/\/localhost:\d+$/.test(origin)) throw Error('Use an HTTPS public origin');
const api = 'https://api.openai.com/v1';
const sockets = new WebSocketServer({noServer:true,maxPayload:4*1024*1024});
const send = (ws, data) => { if(ws?.readyState===1) ws.send(JSON.stringify(data)); };
// Preview and recovery use the interviewer's own words. The provider can still
// resolve indirect requests and references using the full transcript on tap.
function snapshot(r) {
  if(r.previewTranscript!==r.state.transcript){
    r.previewTranscript=r.state.transcript;
    r.previewQuestion=recentRequest(r.state.transcript);
  }
  const data={type:'state',turnId:r.request,turnAction:r.turnAction,...r.state,previewQuestion:r.previewQuestion,hasNewRequest:!!r.previewQuestion && r.previewQuestion!==r.requestAtTap,paired:r.phone?.readyState===1};
  send(r.host,data); send(r.phone,data);
  if(data.paired&&r.accountId){
    for(const stage of ['paired',...(data.answer&&!data.action?['answered']:[])]){
      const stages=r.stages??=new Set();
      if(!stages.has(stage)){accounts.track(stage,r.id,{id:r.accountId});stages.add(stage);}
    }
  }
}
function end(r,reason='ended') {
  if(r.accountId)accounts.stopTrial(r.accountId);
  clearTimeout(r.trialTimer);
  rooms.delete(r.id); r.controller?.abort(); r.rt?.close(); r.key='';
  for(const ws of [r.phone,r.host]) {send(ws,{type:reason}); ws?.close(4001,'Session ended');}
}
async function ticket(r) {
  r.ticket=token(); r.expires=Date.now()+120000;
  const link=origin+'/phone#'+r.id+'.'+r.ticket;
  return {qr:await QRCode.toDataURL(link),expires:r.expires};
}
const transport=process.env.RELAY_TLS_CERT ? https.createServer({
  cert:await readFile(process.env.RELAY_TLS_CERT), key:await readFile(process.env.RELAY_TLS_KEY)
}) : http.createServer();
export const server=transport.on('request',async(req,res)=>{
  res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  try {
    if(req.method==='POST') {
      if(req.url==='/api/billing/webhook'){
        res.writeHead(503).end(JSON.stringify({message:'Billing integration is paused.'}));return;
      }
      if(!allowedOrigin(req)) {res.writeHead(403).end();return;}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw Error();}
      const b=JSON.parse(body);
      if(await accounts.route(req,res,req.url,b))return;
      const geminiRoute=req.url==='/api/gemini/session'||req.url==='/api/gemini/validate';
      if(geminiRoute || req.url==='/api/session' || req.url==='/api/validate') {
        if(typeof b.key!=='string'||!b.key.trim()){res.writeHead(400).end(JSON.stringify({message:'Enter your provider API key first.'}));return;}
        const provider=b.provider??'openai';
        if(provider!==(geminiRoute?'gemini':'openai'))throw Error();
        let check;
        try {
          check=provider==='gemini'?await gemini.validate(b.key):await fetch(api+'/models/gpt-4.1-mini',{headers:{Authorization:'Bearer '+b.key},signal:AbortSignal.timeout(15000)});
        } catch {
          res.writeHead(502).end(JSON.stringify({message:'The relay could not reach the provider. Check the relay’s internet connection and retry.'}));
          return;
        }
        if(!check.ok){
          if(provider==='gemini'){
            const body=await check.json().catch(()=>null);
            const reason=body?.error?.details?.find(detail=>detail.reason)?.reason;
            const message=reason==='API_KEY_INVALID'?'Google rejected this Gemini API key. Copy the full key from Google AI Studio and try again.':
              'Google declined validation ('+check.status+'). '+String(body?.error?.message||'Check the project’s model access and key restrictions.').replaceAll(b.key,'[redacted]').slice(0,350);
            res.writeHead(check.status).end(JSON.stringify({message}));
          }else res.writeHead(check.status).end();
          return;
        }
        if(req.url.endsWith('/validate')){res.end('{}');return;}
        const user=process.env.NODE_ENV==='test'?null:accounts.visitor(req,res);
        if(user){
          try{accounts.startTrial(user);}catch(error){res.writeHead(402).end(JSON.stringify({message:error.message}));return;}
        }
        const r={accountId:user?.id,provider,id:token(),hostKey:token(),phoneKey:'',key:b.key,state:{transcript:'',question:'',answer:'',action:'',paused:false,visual:false,notice:''},created:Date.now()};
        if(user){
          accounts.track('session','/app',user);
          if(!accounts.entitled(user)){
            const checkAccess=()=>{
              const current=accounts.account(user.id),remaining=accounts.remaining(current);
              if(accounts.entitled(current))return;
              if(remaining>0){r.trialTimer=setTimeout(checkAccess,remaining);return;}
              send(r.host,{type:'trial-ended'});send(r.phone,{type:'trial-ended'});end(r);
            };
            r.trialTimer=setTimeout(checkAccess,accounts.remaining(user));
          }
        }
        rooms.set(r.id,r);res.end(JSON.stringify({id:r.id,credential:r.hostKey,previewDeadline:user?.role==='guest'?Date.now()+accounts.remaining(user):null,...await ticket(r)}));return;
      }
      const r=rooms.get(b.id);
      if(req.url==='/api/pair' && r && r.ticket && b.ticket===r.ticket && Date.now()<r.expires){
        r.ticket='';r.phoneKey=token();res.end(JSON.stringify({credential:r.phoneKey}));return;
      }
      res.writeHead(403).end();return;
    }
    if(await accounts.route(req,res,req.url,null))return;
    if(['/', '/how-it-works','/pricing','/account','/admin'].includes(req.url)){
      accounts.trackPage(req,res,req.url,accounts.visitor(req,res));
      const markup=await readFile(new URL('./website.html',import.meta.url),'utf8');
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(markup);return;
    }
    const files={'/website.js':['website.ts','text/javascript'],'/website.css':['website.css','text/css'],'/cv-pdf.mjs':['node_modules/pdfjs-dist/build/pdf.min.mjs','text/javascript'],
      '/cv-worker.mjs':['node_modules/pdfjs-dist/build/pdf.worker.min.mjs','text/javascript'],
      '/cv-docx.js':['node_modules/mammoth/mammoth.browser.min.js','text/javascript'],'/katex.js':['node_modules/katex/dist/katex.min.js','text/javascript'],'/app':['index.html','text/html'],'/phone':['phone.html','text/html'],'/style.css':['style.css','text/css'],'/app.js':['app.ts','text/javascript'],'/pcm.js':['pcm.js','text/javascript']};
    const f=files[req.url];if(!Array.isArray(f)){res.writeHead(404).end();return;}
    let code=await readFile(new URL('./'+f[0],import.meta.url),'utf8');
    if(f[0].endsWith('.ts'))code=stripTypeScriptTypes(code);
    res.setHeader('Content-Type',f[1]+'; charset=utf-8');res.end(code);
  } catch {res.writeHead(400).end();}
});
server.on('upgrade',(req,socket,head)=>{
  if(!allowedOrigin(req) || new URL(req.url,origin).pathname!=='/socket'){socket.destroy();return;}
  sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));
});
function realtime(r){
  if(r.provider==='gemini'){
    r.rt=gemini.transcribe(r.key,{
      ready(){r.ready=true;send(r.host,{type:'ready'});},
      transcript(text){r.state.transcript=text;snapshot(r);},
      closed(){r.ready=false;r.state.notice='Gemini Live disconnected. Check model access and restart the session.';snapshot(r);}
    });
    return;
  }
  const endpoint=process.env.NODE_ENV==='test' ? process.env.TEST_REALTIME_URL : 'wss://api.openai.com/v1/realtime?intent=transcription';
  const rt=new WebSocket(endpoint,{headers:{Authorization:'Bearer '+r.key}});
  r.rt=rt;r.ready=false;const items=new Map();
  const prefix=r.state.transcript;
  rt.on('open',()=>send(rt,{type:'session.update',session:{type:'transcription',audio:{input:{format:{type:'audio/pcm',rate:24000},transcription:{model:'gpt-live-transcribe'},turn_detection:null}}}}));
  rt.on('message',raw=>{
    const e=JSON.parse(raw);if(e.type==='session.updated'){r.ready=true;send(r.host,{type:'ready'});}
    if(e.type==='error'){r.state.notice='Transcription error. Check provider access and restart the session.';snapshot(r);}
    if(e.type.endsWith('input_audio_transcription.delta')||e.type.endsWith('input_audio_transcription.completed')){
      items.set(e.item_id,e.transcript??((items.get(e.item_id)||'')+e.delta));
      r.state.transcript=[prefix,...items.values()].filter(Boolean).join('\n').slice(-16000);snapshot(r);
    }
  });
  rt.on('error',()=>{});rt.on('close',()=>{r.ready=false;r.state.notice='Transcription disconnected. Restart the session to reconnect.';snapshot(r);});
}
const answer=(room,request)=>generateAnswer(room,request,snapshot);
sockets.on('connection',ws=>{
  let r,role;const timer=setTimeout(()=>ws.close(4003),5000);
  ws.on('error',()=>{});ws.on('message',async(raw,binary)=>{try{
    if(binary){if(role==='host' && r.ready && !r.state.paused && raw.length<=48000){
      if(r.provider==='gemini')send(r.rt,gemini.audioMessage(raw));
      else send(r.rt,{type:'input_audio_buffer.append',audio:raw.toString('base64')});
    }return;}
    const b=JSON.parse(raw);
    if(!role){r=rooms.get(b.id);if(!r||!b.credential)return ws.close(4003);
      role=b.credential===r.hostKey?'host':b.credential===r.phoneKey?'phone':null;if(!role)return ws.close(4003);
      clearTimeout(timer);r[role]?.close(4003);r[role]=ws;snapshot(r);if(role==='host')realtime(r);return;
    }
    if(r[role]!==ws || !rooms.has(r.id))return;
    if(role==='phone'){
      if(b.type==='command'&&!r.state.action&&['Answer question','Analyze screen'].includes(b.action)&&r.host?.readyState===1){
        r.turnAction=b.action;r.request=token();r.requestAtTap=recentRequest(r.state.transcript);r.state.action=b.action;r.context=r.state.transcript;r.state.question=b.action==='Analyze screen'?(r.context.trim().split('\n').at(-1)||''):'';r.state.answer='';r.state.notice='';snapshot(r);
        if(b.action==='Answer question' && r.answerInputs){
          await answer(r,{...r.answerInputs,request:r.request});return;
        }
        send(r.host,{type:'command',action:b.action,request:r.request});
      }return;
    }
    if(b.type==='answer-inputs'){r.answerInputs=readAnswerInputs(b);return;}
    if(b.type==='end')end(r);
    if(b.type==='ticket'&&!r.phoneKey)send(ws,{type:'ticket',...await ticket(r)});
    if(b.type==='status'){r.state.paused=!!b.paused;r.state.visual=!!b.visual;if(typeof b.notice==='string')r.state.notice=b.notice.slice(0,200);snapshot(r);}
    if(b.type==='commit'&&r.ready)send(r.rt,(r.provider==='gemini')?{realtimeInput:{audioStreamEnd:true}}:{type:'input_audio_buffer.commit'});
    if(b.type==='generate')await answer(r,b);
  }catch{ws.close(4002);}});
  ws.on('close',()=>{clearTimeout(timer);if(r?.[role]!==ws)return;r[role]=null;if(role==='host')end(r);else snapshot(r);});
});
setInterval(()=>{for(const r of rooms.values())if(Date.now()-r.created>(r.host?8*3600000:120000))end(r,r.host?'ended':'connection-timeout');},30000).unref();
if(process.env.NODE_ENV!=='test'){
  accounts.recoverTrials();
  setInterval(()=>accounts.checkpoint(),1000).unref();
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
    for(const room of [...rooms.values()])end(room);
    process.exit(0);
  });
}
if(process.env.NODE_ENV!=='test')server.listen(Number(process.env.PORT||3000),process.env.BIND_HOST||'127.0.0.1',()=>console.log('Listening on '+origin));
if(process.env.NODE_ENV!=='test' && localHostPort){
  const host=http.createServer(server.listeners('request')[0]);
  host.on('upgrade',server.listeners('upgrade')[0]);
  host.listen(localHostPort,'127.0.0.1');
}

