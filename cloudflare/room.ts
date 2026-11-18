import { DurableObject } from 'cloudflare:workers';
import QRCode from 'qrcode/lib/core/qrcode.js';
import { Buffer } from 'node:buffer';
import { readAnswerInputs,answer,recentRequest } from '../session-logic';
import { audioMessage } from '../gemini-core';
import { digest,internal,json,readJSON,token,type Env } from './common';

function qrImage(link:string){
  const {modules}=QRCode.create(link,{errorCorrectionLevel:'M'});
  const squares=[];
  for(let y=0;y<modules.size;y++)for(let x=0;x<modules.size;x++)if(modules.get(y,x))squares.push(`M${x+4},${y+4}h1v1h-1z`);
  const size=modules.size+8;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${size}v${size}H0z"/><path fill="black" d="${squares.join('')}"/></svg>`;
  return 'data:image/svg+xml;base64,'+btoa(svg);
}
function send(socket:WebSocket|undefined,data:object){
  if(socket?.readyState===1)try{socket.send(JSON.stringify(data));}catch{}
}
export class InterviewRoom extends DurableObject<Env>{
  room:any=null;
  metadata:any=null;
  ended=false;
  timedOut=false;
  unauthenticated=new Set<WebSocket>();
  deadlineTimer?:ReturnType<typeof setTimeout>;
  commandTimer?:ReturnType<typeof setTimeout>;
  reconnectTimer?:ReturnType<typeof setTimeout>;
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);
    ctx.blockConcurrencyWhile(async()=>{this.metadata=await ctx.storage.get('metadata');});
  }
  async pairing(){
    const ticket=token();
    this.metadata.ticketHash=await digest(ticket);
    this.metadata.expires=Date.now()+120000;
    await this.ctx.storage.put('metadata',this.metadata);
    const link=this.metadata.origin+'/phone#'+this.metadata.id+'.'+ticket;
    return {qr:qrImage(link),expires:this.metadata.expires};
  }
  snapshot=()=>{
    const room=this.room;if(!room||this.ended)return;
    if(room.previewTranscript!==room.state.transcript){room.previewTranscript=room.state.transcript;room.previewQuestion=recentRequest(room.state.transcript);}
    const data={type:'state',turnId:room.request,turnAction:room.turnAction,...room.state,previewQuestion:room.previewQuestion,hasNewRequest:!!room.previewQuestion&&room.previewQuestion!==room.requestAtTap,paired:room.phone?.readyState===1};
    send(room.host,data);send(room.phone,data);
    if(data.paired){
      const recorded=room.stages??=new Set();
      for(const stage of ['paired',...(data.answer&&!data.action?['answered']:[])]){
        if(recorded.has(stage))continue;
        recorded.add(stage);
        this.ctx.waitUntil(internal(this.env,'/internal/stage',{stage,room:this.metadata.id}).catch(()=>recorded.delete(stage)));
      }
    }
  };
  async end(expired=false,timeout=false){
    if(this.ended)return;this.ended=true;this.timedOut=timeout;
    const room=this.room;
    clearTimeout(this.deadlineTimer);clearTimeout(this.commandTimer);clearTimeout(this.reconnectTimer);
    if(room){
      room.controller?.abort();room.rt?.close();room.key='';
      for(const socket of [room.host,room.phone]){send(socket,{type:expired?'trial-ended':timeout?'connection-timeout':'ended'});socket?.close(4001,'Session ended');}
    }
    for(const socket of this.unauthenticated)socket.close(4001,'Session ended');
    this.unauthenticated.clear();
    if(this.metadata)await internal(this.env,'/internal/release',{id:this.metadata.accountId,room:this.metadata.id});
    this.room=null;this.metadata=null;
    await this.ctx.storage.deleteAll();await this.ctx.storage.deleteAlarm();
  }
  async alarm(){
    if(!this.room||Date.now()>=this.metadata.deadline||(!this.room.host&&Date.now()-this.metadata.created>120000))return this.end(!!this.room&&Date.now()>=this.metadata.deadline,!!this.room&&!this.room.host);
    await internal(this.env,'/internal/tick',{id:this.metadata.accountId,room:this.metadata.id});
    await this.ctx.storage.setAlarm(Math.min(Date.now()+30000,this.metadata.deadline));
  }
  async fetch(request:Request){
    const path=new URL(request.url).pathname;
    if(path==='/internal/init'){
      if(this.metadata||this.room||this.ended)return json({message:'Session already initialized.'},409);
      const data=await readJSON(request);
      this.metadata={id:data.id,accountId:data.accountId,deadline:data.deadline,origin:data.origin,hostHash:await digest(data.credential),phoneHash:'',created:Date.now()};
      this.room={key:data.key,provider:data.provider,ready:false,state:{transcript:'',question:'',answer:'',action:'',paused:false,visual:false,notice:''}};
      const pairing=await this.pairing();
      await this.ctx.storage.setAlarm(Math.min(Date.now()+30000,data.deadline));
      this.deadlineTimer=setTimeout(()=>this.end(true),Math.max(0,data.deadline-Date.now()));
      return json(pairing);
    }
    if(path==='/internal/extend'){
      const {accountId,deadline}=await readJSON(request);
      if(!this.room||this.ended||accountId!==this.metadata?.accountId||!Number.isFinite(deadline)||deadline<=this.metadata.deadline)return json({message:'Session could not be extended.'},409);
      this.metadata.deadline=deadline;
      await this.ctx.storage.put('metadata',this.metadata);
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer=setTimeout(()=>this.end(true),Math.max(0,deadline-Date.now()));
      await this.ctx.storage.setAlarm(Math.min(Date.now()+30000,deadline));
      return json({ok:true});
    }
    // A runtime restart loses provider keys and transcript by design. Revoke
    // that session and release its lease instead of retaining secrets on disk.
    if(!this.room||this.ended||Date.now()>=this.metadata.deadline){
      await this.end();
      if(path==='/socket'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
        const sockets=new WebSocketPair();sockets[1].accept();
        send(sockets[1],{type:this.timedOut?'connection-timeout':'ended'});sockets[1].close(4001,'Session ended');
        return new Response(null,{status:101,webSocket:sockets[0]});
      }
      return json({message:'Session ended. Start a new session on the computer.'},410);
    }
    if(path==='/internal/pair'){
      const {ticket}=await readJSON(request);
      return this.ctx.blockConcurrencyWhile(async()=>{
        if(!this.metadata.ticketHash||Date.now()>=this.metadata.expires||await digest(String(ticket))!==this.metadata.ticketHash)return json({message:'Pairing code expired or already used.'},403);
        const credential=token();this.metadata.ticketHash='';this.metadata.phoneHash=await digest(credential);
        await this.ctx.storage.put('metadata',this.metadata);
        return json({credential});
      });
    }
    if(path!=='/socket'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({message:'Not found.'},404);
    if(this.unauthenticated.size>=4)return json({message:'Too many connection attempts.'},429);
    const pair=new WebSocketPair(),client=pair[0],socket=pair[1];socket.accept();
    this.unauthenticated.add(socket);
    const authTimer=setTimeout(()=>socket.close(4003,'Authentication required'),5000);
    let role='',authenticating=false;
    socket.addEventListener('message',async event=>{
      try{
        const room=this.room;if(!room||this.ended)return;
        if(Date.now()>=this.metadata.deadline){await this.end(true);return;}
        if(typeof event.data!=='string'){
          const binary=event.data instanceof ArrayBuffer?event.data:await event.data.arrayBuffer();
          if(role==='host'&&room.host===socket&&room.ready&&!room.state.paused&&binary.byteLength<=48000){
            const frame=Buffer.from(binary);
            send(room.rt,room.provider==='gemini'?audioMessage(frame):{type:'input_audio_buffer.append',audio:frame.toString('base64')});
          }return;
        }
        if(event.data.length>4*1024*1024){socket.close(4002,'Message too large');return;}
        const message=JSON.parse(event.data);
        if(!role){
          if(authenticating)return;authenticating=true;
          const hash=await digest(String(message.credential||''));
          role=hash===this.metadata.hostHash?'host':hash===this.metadata.phoneHash?'phone':'';
          if(message.id!==this.metadata.id||!role||socket.readyState!==1){socket.close(4003,'Invalid session credential');return;}
          clearTimeout(authTimer);this.unauthenticated.delete(socket);
          room[role]?.close(4003,'Connection replaced');room[role]=socket;
          this.snapshot();if(role==='host')await this.realtime();return;
        }
        if(room[role]!==socket)return;
        if(role==='phone'){
          if(message.type==='command'&&!room.state.action&&['Answer question','Analyze screen'].includes(message.action)&&room.host?.readyState===1){
            room.turnAction=message.action;room.request=token();room.requestAtTap=recentRequest(room.state.transcript);room.state.action=message.action;room.context=room.state.transcript;room.state.question='';room.state.answer='';room.state.notice='';this.snapshot();
            if(message.action==='Answer question' && room.answerInputs){
              await answer(room,{...room.answerInputs,request:room.request},this.snapshot);return;
            }
            send(room.host,{type:'command',action:message.action,request:room.request});
            this.commandTimer=setTimeout(()=>{if(room.state.action&&!room.controller){room.state.action='';room.state.notice='The computer did not respond. Keep its host tab open and retry.';this.snapshot();}},15000);
          }return;
        }
        if(message.type==='answer-inputs'){room.answerInputs=readAnswerInputs(message);return;}
        if(message.type==='end'){await this.end();return;}
        if(message.type==='ticket'&&!this.metadata.phoneHash)send(socket,{type:'ticket',...await this.pairing()});
        if(message.type==='status'){room.state.paused=!!message.paused;room.state.visual=!!message.visual;if(typeof message.notice==='string')room.state.notice=message.notice.slice(0,200);this.snapshot();}
        if(message.type==='commit'&&room.ready)send(room.rt,room.provider==='gemini'?{realtimeInput:{audioStreamEnd:true}}:{type:'input_audio_buffer.commit'});
        if(message.type==='generate'){
          if(message.request!==room.request)return;
          clearTimeout(this.commandTimer);await answer(room,message,this.snapshot);
        }
      }catch{socket.close(4002,'Invalid session message');}
    });
    socket.addEventListener('close',()=>{
      clearTimeout(authTimer);this.unauthenticated.delete(socket);
      if(this.room?.[role]!==socket)return;
      this.room[role]=null;
      if(role==='host')this.ctx.waitUntil(this.end());else this.snapshot();
    });
    socket.addEventListener('error',()=>socket.close(4002,'Connection error'));
    return new Response(null,{status:101,webSocket:client});
  }
  retryTranscription(reason?:string){
    const room=this.room;
    if(!room||this.ended||room.providerRejected)return;
    if(reason)room.lastDisconnect=reason.replaceAll(room.key,'[redacted]').replace(/([?&]key=)[^&\s]+/gi,'$1[redacted]').slice(0,400);
    const detail=room.lastDisconnect?' Details: '+room.lastDisconnect:'';
    const attempt=(room.reconnectAttempts||0)+1;
    room.reconnectAttempts=attempt;
    if(attempt>3){
      room.state.notice='Transcription failed after 3 reconnection attempts.'+detail;
      this.snapshot();return;
    }
    room.state.notice='Reconnecting transcription ('+attempt+'/3).'+detail;
    this.snapshot();
    this.reconnectTimer=setTimeout(()=>{if(!this.ended)this.ctx.waitUntil(this.realtime());},1000*attempt);
  }
  async realtime(){
    const room=this.room;
    if(room.rt)return;
    try{
      const gemini=room.provider==='gemini';
      const url=gemini?'https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key='+encodeURIComponent(room.key):'https://api.openai.com/v1/realtime?intent=transcription';
      const headers:Record<string,string>={Upgrade:'websocket'};
      if(!gemini)headers.Authorization='Bearer '+room.key;
      const handshake=new AbortController();
      const handshakeTimer=setTimeout(()=>handshake.abort(),15000);
      let response:Response;
      try{
        response=await fetch(url,{headers,signal:handshake.signal});
      }finally{
        // The timeout protects connection establishment, not the live stream.
        clearTimeout(handshakeTimer);
      }
      const ws=response.webSocket;if(!ws){
        if([400,401,403,429].includes(response.status)){room.providerRejected=true;room.state.notice='Transcription provider rejected the connection (HTTP '+response.status+'). Check your API key, live model access and quota.';this.snapshot();return;}
        throw Error('Provider WebSocket upgrade failed (HTTP '+response.status+').');
      }
      if(this.ended){ws.accept();ws.close();return;}
      ws.accept();room.rt=ws;
      const prefix=room.state.transcript.trim();
      const transcripts=new Map<string,string>();let finalized=prefix?prefix+'\n':'';
      ws.addEventListener('message',async event=>{
        if(this.ended)return;
        try{
          const text=typeof event.data==='string'?event.data:await event.data.text();
          const message=JSON.parse(text);
          if(message.setupComplete||message.type==='session.updated'){room.ready=true;room.state.notice='';send(room.host,{type:'ready'});this.snapshot();}
          if(message.error||message.type==='error'){
            room.providerRejected=true;room.ready=false;
            const error=message.error||message;
            const detail=String(error.message||error.code||'Request rejected').replaceAll(room.key,'[redacted]').slice(0,250);
            room.state.notice='Transcription provider error: '+detail;
            this.snapshot();
          }
          if(gemini){
            const content=message.serverContent;
            if(content?.inputTranscription?.text){finalized=(finalized+content.inputTranscription.text+'\n').slice(-16000);room.state.transcript=finalized.trimEnd();this.snapshot();}
            else if(content?.interimInputTranscription){room.state.transcript=(finalized+content.interimInputTranscription.text).slice(-16000);this.snapshot();}
          }else if(message.type?.endsWith('input_audio_transcription.delta')||message.type?.endsWith('input_audio_transcription.completed')){
            transcripts.set(message.item_id,message.transcript??((transcripts.get(message.item_id)||'')+message.delta));
            if(transcripts.size>100)transcripts.delete(transcripts.keys().next().value!);
            room.state.transcript=[prefix,...transcripts.values()].filter(Boolean).join('\n').slice(-16000);this.snapshot();
          }
        }catch{room.state.notice='Transcription interrupted. Restart the session.';this.snapshot();}
      });
      ws.addEventListener('close',event=>{
        if(room.rt!==ws)return;
        const wasReady=room.ready;room.rt=null;room.ready=false;
        if(this.ended)return;
        if(room.providerRejected)return;
        if([1007,1008].includes(event.code)){
          room.providerRejected=true;
          const reason=String(event.reason||'Check live model access, request format and quota.').replaceAll(room.key,'[redacted]').slice(0,250);
          room.state.notice='Transcription provider closed the connection ('+event.code+'): '+reason;
          this.snapshot();return;
        }
        this.retryTranscription('WebSocket closed with code '+event.code+(event.reason?' — '+event.reason:' (provider supplied no reason)')+'. '+(wasReady?'After transcription started.':'During connection or setup.'));
      });
      ws.addEventListener('error',()=>ws.close());
      send(ws,gemini?{setup:{model:'models/gemini-3.5-transcribe-live',generationConfig:{responseModalities:['TEXT']},inputAudioTranscription:{languageCodes:[]}}}:{type:'session.update',session:{type:'transcription',audio:{input:{format:{type:'audio/pcm',rate:24000},transcription:{model:'gpt-live-transcribe'},turn_detection:null}}}});
    }catch(error){room.ready=false;room.rt=null;if(!this.ended)this.retryTranscription('Connection failed: '+(error instanceof Error?error.message:'Unknown connection error'));}
  }
}
