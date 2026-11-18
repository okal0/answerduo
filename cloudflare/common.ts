export type Env={ASSETS:Fetcher;ACCOUNTS:DurableObjectNamespace;ROOMS:DurableObjectNamespace;ADMIN_EMAIL?:string;ADMIN_PASSWORD_HASH?:string;};
export const token=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
export async function digest(value:string){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
}
export function json(data:unknown,status=200,headers:HeadersInit={}){
  const output=new Headers(headers);
  output.set('Cache-Control','no-store');output.set('Referrer-Policy','no-referrer');output.set('X-Content-Type-Options','nosniff');
  return Response.json(data,{status,headers:output});
}
export async function readJSON(request:Request,limit=8192){
  if(!request.body)throw Error('Missing request body.');
  const reader=request.body.getReader();let size=0,text='';const decoder=new TextDecoder();
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('Request is too large.');}text+=decoder.decode(value,{stream:true});}
  return JSON.parse(text+decoder.decode());
}
export function accountStore(env:Env){return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts-v1'));}
export async function internal(env:Env,path:string,body:object){
  const response=await accountStore(env).fetch('https://internal'+path,{method:'POST',body:JSON.stringify(body)});
  return response.json() as Promise<any>;
}
export async function passwordHash(password:string,salt=token()){
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new TextEncoder().encode(salt),iterations:100000},material,256);
  const value=Array.from(new Uint8Array(bits),byte=>byte.toString(16).padStart(2,'0')).join('');
  return 'pbkdf2:100000:'+salt+':'+value;
}
