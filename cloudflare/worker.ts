import { accountStore,internal,json,readJSON,token,type Env } from './common';
import { validate as validateGemini } from '../gemini-core';
export { AccountStore } from './accounts';
export { InterviewRoom } from './room';

const pages:Record<string,string>={'/':'/index.html','/how-it-works':'/index.html','/pricing':'/index.html','/account':'/index.html','/admin':'/index.html','/app':'/workspace.html','/phone':'/phone.html'};
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url),path=url.pathname;
    if(path==='/api/billing/webhook'||path==='/api/checkout')return json({message:'Membership purchasing is currently paused.'},503);
    if(request.method==='POST'&&request.headers.get('Origin')!==url.origin)return json({message:'Origin rejected.'},403);
    try{
      if(path==='/api/plans'&&request.method==='GET')return json({checkout:false,price:'Coming soon'});
      const accountRoutes:Record<string,string>={'/api/account':'GET','/api/admin':'GET','/api/auth/signup':'POST','/api/auth/login':'POST','/api/auth/logout':'POST'};
      if(accountRoutes[path]){
        if(request.method!==accountRoutes[path])return json({message:'Method not allowed.'},405);
        return accountStore(env).fetch(request);
      }
      if(path==='/socket'){
        if(request.headers.get('Origin')!==url.origin||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({message:'WebSocket origin rejected.'},403);
        const id=url.searchParams.get('id');
        if(!id||!/^[a-f0-9]{64}$/.test(id))return json({message:'Invalid session.'},400);
        return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(request);
      }
      if(path==='/api/pair'&&request.method==='POST'){
        const body=await readJSON(request);
        if(typeof body.id!=='string'||!/^[a-f0-9]{64}$/.test(body.id)||typeof body.ticket!=='string')return json({message:'Invalid pairing link.'},400);
        return env.ROOMS.get(env.ROOMS.idFromName(body.id)).fetch('https://internal/internal/pair',{method:'POST',body:JSON.stringify({ticket:body.ticket})});
      }
      if(/^\/api\/(?:gemini\/)?(?:validate|session)$/.test(path)&&request.method==='POST'){
        const body=await readJSON(request);
        const provider=path.includes('/gemini/')?'gemini':'openai';
        if((body.provider??'openai')!==provider||typeof body.key!=='string'||!body.key.trim())return json({message:'Enter the API key for the selected provider.'},400);
        let check:Response;
        try{
          check=provider==='gemini'?await validateGemini(body.key):await fetch('https://api.openai.com/v1/models/gpt-4.1-mini',{headers:{Authorization:'Bearer '+body.key},signal:AbortSignal.timeout(15000)});
        }catch{return json({message:'The provider could not be reached. Check your connection and try again.'},502);}
        if(!check.ok)return json({message:'Provider key validation failed ('+check.status+'). Check the key and model access.'},check.status);
        await check.body?.cancel();
        if(path.endsWith('validate'))return json({});
        const id=token(),credential=token();
        const reservation=await accountStore(env).fetch(new Request(new URL('/internal/reserve',request.url),{method:'POST',headers:request.headers,body:JSON.stringify({room:id})}));
        const cookie=reservation.headers.get('Set-Cookie');
        const headers=cookie?{'Set-Cookie':cookie}:{};
        const account=await reservation.json() as any;
        if(!reservation.ok)return json(account,reservation.status,headers);
        try{
          const response=await env.ROOMS.get(env.ROOMS.idFromName(id)).fetch('https://internal/internal/init',{method:'POST',body:JSON.stringify({id,credential,accountId:account.id,deadline:account.deadline,provider,key:body.key,origin:url.origin})});
          const result=await response.json() as object;
          if(!response.ok)throw Error('Session initialization failed');
          return json({id,credential,previewDeadline:account.guest?account.deadline:null,...result},200,headers);
        }catch{
          await internal(env,'/internal/release',{id:account.id,room:id});
          return json({message:'Session could not start. Retry on the computer.'},502,headers);
        }
      }
      if(request.method==='GET'&&pages[path]){
        const response=await env.ASSETS.fetch(new URL(pages[path],url));
        const headers=new Headers(response.headers);
        headers.set('Cache-Control','no-store');headers.set('Referrer-Policy','no-referrer');headers.set('X-Content-Type-Options','nosniff');
        // Phone visits must not create a guest identity: they inherit the host's session.
        if(path!=='/phone'){
          const input=new Headers(request.headers);input.set('X-Page',path);
          const visit=await accountStore(env).fetch(new Request(new URL('/internal/visit',request.url),{headers:input}));
          for(const value of visit.headers.getSetCookie())headers.append('Set-Cookie',value);
        }
        return new Response(response.body,{status:response.status,headers});
      }
      if(path.startsWith('/api/')||path.startsWith('/internal/'))return json({message:'Not found.'},404);
      return env.ASSETS.fetch(request);
    }catch{return json({message:'The request could not be completed. Please retry.'},400);}
  }
};
