import { LAUNCH_ACCESS,accessExpiry,accessRemaining,accessEndedMessage } from '../access-policy';
import { DurableObject } from 'cloudflare:workers';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { digest,json,passwordHash,readJSON,token,type Env } from './common';

const cookie=(request:Request)=>request.headers.get('Cookie')?.split(';').map(value=>value.trim()).find(value=>value.startsWith('answerduo_session='))?.slice(18);
export class AccountStore extends DurableObject<Env>{
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS identities(id TEXT PRIMARY KEY,email TEXT UNIQUE,password TEXT,role TEXT DEFAULT 'guest',paid_until INTEGER DEFAULT 0,used_ms INTEGER DEFAULT 0,active_room TEXT,active_until INTEGER DEFAULT 0,last_tick INTEGER DEFAULT 0,lease_until INTEGER DEFAULT 0,created INTEGER);
      CREATE TABLE IF NOT EXISTS logins(token TEXT PRIMARY KEY,identity_id TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS rates(address TEXT PRIMARY KEY,count INTEGER,until INTEGER);
      CREATE TABLE IF NOT EXISTS traffic(day TEXT,path TEXT,views INTEGER DEFAULT 0,PRIMARY KEY(day,path));
      CREATE TABLE IF NOT EXISTS visitors(day TEXT,identity_id TEXT,PRIMARY KEY(day,identity_id));
      CREATE TABLE IF NOT EXISTS session_stages(room TEXT,stage TEXT,PRIMARY KEY(room,stage));
      CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER DEFAULT 0);
    `);
    // Existing identities receive the full launch period once; restarts do not renew it.
    ctx.storage.transactionSync(()=>{
      if(!this.rows('PRAGMA table_info(identities)').some(column=>column.name==='launch_expires')){
        this.row('ALTER TABLE identities ADD COLUMN launch_expires INTEGER NOT NULL DEFAULT 0');
        this.row('UPDATE identities SET launch_expires=?',Date.now()+LAUNCH_ACCESS);
      }
    });
    ctx.storage.transactionSync(()=>{
      const migration='launch-seven-days-v1';
      if(this.row('SELECT value FROM counters WHERE name=?',migration))return;
      this.row("UPDATE identities SET launch_expires=? WHERE role!='admin'",Date.now()+LAUNCH_ACCESS);
      this.row('INSERT INTO counters(name,value) VALUES(?,1)',migration);
    });
    ctx.storage.transactionSync(()=>{
      const migration='guest-preview-v1';
      if(this.row('SELECT value FROM counters WHERE name=?',migration))return;
      this.row("UPDATE identities SET used_ms=0 WHERE role='guest'");
      this.row('INSERT INTO counters(name,value) VALUES(?,1)',migration);
    });
    // Owner-requested analytics reset. The marker prevents future deployments
    // or object restarts from clearing newly collected visitor statistics.
    const reset='visitor-reset-2026-11-10-1';
    ctx.storage.transactionSync(()=>{
      if(this.row('SELECT value FROM counters WHERE name=?',reset))return;
      this.row('DELETE FROM visitors');
      this.row('DELETE FROM traffic');
      this.row('INSERT INTO counters(name,value) VALUES(?,1)',reset);
    });
  }
  row(query:string,...values:any[]):any{return this.ctx.storage.sql.exec(query,...values).toArray()[0];}
  rows(query:string,...values:any[]):any[]{return this.ctx.storage.sql.exec(query,...values).toArray();}
  member(user:any){return user.role==='admin'||user.paid_until>Date.now();}
  remaining(user:any){
    return accessRemaining(user);
  }
  async user(request:Request){
    const value=cookie(request);
    return value?this.row('SELECT i.* FROM identities i JOIN logins l ON l.identity_id=i.id WHERE l.token=? AND l.expires>?',await digest(value),Date.now()):null;
  }
  async login(id:string,request:Request){
    const value=token();
    this.row('DELETE FROM logins WHERE expires<?',Date.now());
    this.row('INSERT INTO logins VALUES(?,?,?)',await digest(value),id,Date.now()+30*86400000);
    return 'answerduo_session='+value+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'+(new URL(request.url).protocol==='https:'?'; Secure':'');
  }
  async visitor(request:Request){
    let user=await this.user(request),header='';
    if(!user){
      const id=token();this.row('INSERT INTO identities(id,created,launch_expires) VALUES(?,?,?)',id,Date.now(),0);
      user=this.row('SELECT * FROM identities WHERE id=?',id);header=await this.login(id,request);
    }
    return {user,headers:header?{'Set-Cookie':header}:{}};
  }
  settle(user:any,release=false){
    if(!user?.active_room)return;
    const elapsed=Math.max(0,Math.min(Date.now(),user.lease_until,user.active_until)-user.last_tick);
    this.row('UPDATE identities SET used_ms=used_ms+?,last_tick=?,lease_until=?,active_room=? WHERE id=?',this.member(user)?0:elapsed,Date.now(),Date.now()+70000,release?null:user.active_room,user.id);
  }
  async fetch(request:Request){
    return this.ctx.blockConcurrencyWhile(async()=>{
      try{return await this.route(request);}catch{return json({message:'Account request could not be completed. Please retry.'},400);}
    });
  }
  async route(request:Request){
    const path=new URL(request.url).pathname;
    // This object is reached through the Worker only. Internal routes are never
    // forwarded from public URLs by worker.ts.
    if(path==='/internal/stage'){
      const {room,stage}=await readJSON(request);
      if(!['paired','answered'].includes(stage))return json({},400);
      this.row('INSERT OR IGNORE INTO session_stages VALUES(?,?)',room,stage);
      return json({ok:true});
    }
    if(path==='/internal/tick'||path==='/internal/release'){
      const {id,room}=await readJSON(request);
      const user=this.row('SELECT * FROM identities WHERE id=?',id);
      if(user?.active_room===room)this.settle(user,path.endsWith('release'));
      return json({ok:true});
    }
    const adminEmail=(this.env.ADMIN_EMAIL||'answerhelperduo@gmail.com').trim().toLowerCase();
    const adminHash=this.env.ADMIN_PASSWORD_HASH;
    if(adminHash&&(/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(adminHash)||/^pbkdf2:100000:[a-f0-9]{64}:[a-f0-9]{64}$/.test(adminHash))){
      const admin=this.row('SELECT * FROM identities WHERE email=?',adminEmail);
      if(!admin)this.row("INSERT INTO identities(id,email,password,role,created) VALUES(?,?,?,'admin',?)",token(),adminEmail,adminHash,Date.now());
      else if(admin.password!==adminHash||admin.role!=='admin'){
        this.ctx.storage.transactionSync(()=>{
          this.row("UPDATE identities SET password=?,role='admin' WHERE id=?",adminHash,admin.id);
          this.row('DELETE FROM logins WHERE identity_id=?',admin.id);
        });
      }
    }
    if(path==='/api/account'){
      const {user,headers}=await this.visitor(request);
      return json({email:user.email,role:user.role,member:this.member(user),remainingMs:this.remaining(user),launchExpiresAt:accessExpiry(user),trialKind:user.role==='guest'?'guest-preview':'registered-trial',paidUntil:user.paid_until},200,headers);
    }
    if(path==='/internal/visit'){
      const {user,headers}=await this.visitor(request);
      if(user.role==='admin')return json({},200,headers);
      // Analytics identity survives sign-in, sign-out and session expiry.
      const saved=request.headers.get('Cookie')?.split(';').map(value=>value.trim()).find(value=>value.startsWith('answerduo_visitor='))?.slice(18);
      const visitorId=saved&&/^[a-f0-9]{64}$/.test(saved)?saved:user.id;
      const responseHeaders=new Headers(headers);
      if(!saved||saved!==visitorId)responseHeaders.append('Set-Cookie','answerduo_visitor='+visitorId+'; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000'+(new URL(request.url).protocol==='https:'?'; Secure':''));
      const target=request.headers.get('X-Page')||'/';
      const day=new Date().toISOString().slice(0,10);
      this.row('INSERT INTO traffic(day,path,views) VALUES(?,?,1) ON CONFLICT(day,path) DO UPDATE SET views=views+1',day,target);
      this.row('INSERT OR IGNORE INTO visitors VALUES(?,?)',day,visitorId);
      // Aggregate records have a bounded retention period.
      const cutoff=new Date(Date.now()-90*86400000).toISOString().slice(0,10);
      this.row('DELETE FROM traffic WHERE day<?',cutoff);this.row('DELETE FROM visitors WHERE day<?',cutoff);
      return json({},200,responseHeaders);
    }
    if(path==='/internal/reserve'){
      const {room}=await readJSON(request);
      const {user,headers}=await this.visitor(request);
      if(user.active_room&&user.lease_until>Date.now())return json({message:'A session is already running. End it on your computer before starting another.'},409,headers);
      if(user.active_room){this.settle(user,true);Object.assign(user,this.row('SELECT * FROM identities WHERE id=?',user.id));}
      const member=this.member(user),budget=member?8*3600000:this.remaining(user);
      if(budget<=0)return json({message:accessEndedMessage(user)},402,headers);
      const deadline=Date.now()+budget;
      this.row('UPDATE identities SET active_room=?,active_until=?,last_tick=?,lease_until=? WHERE id=?',room,deadline,Date.now(),Date.now()+70000,user.id);
      this.row("INSERT INTO counters VALUES('sessions',1) ON CONFLICT(name) DO UPDATE SET value=value+1");
      return json({id:user.id,deadline,guest:user.role==='guest'},200,headers);
    }
    if(path==='/api/auth/logout'){
      const value=cookie(request);if(value)this.row('DELETE FROM logins WHERE token=?',await digest(value));
      return json({},200,{'Set-Cookie':'answerduo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(new URL(request.url).protocol==='https:'?'; Secure':'')});
    }
    if(path==='/api/auth/login'||path==='/api/auth/signup'){
      const address=await digest(request.headers.get('CF-Connecting-IP')||'local');
      this.row('DELETE FROM rates WHERE until<?',Date.now());
      const limit=this.row('SELECT * FROM rates WHERE address=?',address);
      if(limit?.count>=12)return json({message:'Too many attempts. Try again in ten minutes.'},429);
      this.row('INSERT INTO rates VALUES(?,1,?) ON CONFLICT(address) DO UPDATE SET count=count+1',address,Date.now()+600000);
      const body=await readJSON(request),email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<(path.endsWith('signup')?8:1)||password.length>200)return json({message:'Use a valid email and a password of 8–200 characters.'},400);
      let user=this.row('SELECT * FROM identities WHERE email=?',email);
      if(path.endsWith('signup')){
        if(email===adminEmail||user)return json({message:'Use sign in if you already have an account.'},409);
        const result=await this.visitor(request);user=result.user;
        if(user.email)return json({message:'Sign out before creating another account.'},409);
        const deadline=Date.now()+LAUNCH_ACCESS;
        this.row("UPDATE identities SET email=?,password=?,role='member',launch_expires=? WHERE id=?",email,await passwordHash(password),deadline,user.id);
        if(user.active_room&&user.lease_until>Date.now()){
          this.row('UPDATE identities SET active_until=? WHERE id=?',deadline,user.id);
          await this.env.ROOMS.get(this.env.ROOMS.idFromName(user.active_room)).fetch('https://internal/internal/extend',{method:'POST',body:JSON.stringify({accountId:user.id,deadline})});
        }
      }else{
        const expected=user?.password||await passwordHash('dummy-password');
        let actual:string;
        if(expected.startsWith('pbkdf2:'))actual=await passwordHash(password,expected.split(':')[2]);
        else{
          const salt=expected.split(':')[0];
          const bytes=await scryptAsync(password,salt,{N:16384,r:8,p:1,dkLen:64,maxmem:64*1024*1024});
          actual=salt+':'+Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
        }
        let mismatch=actual.length^expected.length;
        for(let i=0;i<actual.length;i++)mismatch|=actual.charCodeAt(i)^(expected.charCodeAt(i)||0);
        if(!user||mismatch)return json({message:'Email or password was not recognized.'},401);
      }
      return json({},200,{'Set-Cookie':await this.login(user.id,request)});
    }
    if(path==='/api/admin'){
      if((await this.user(request))?.role!=='admin')return json({message:'Administrator sign-in required.'},403);
      const counts=this.row("SELECT COUNT(*) total,COALESCE(SUM(role='guest'),0) guests,COALESCE(SUM(email IS NOT NULL),0) accounts,COALESCE(SUM(paid_until>?),0) paid FROM identities",Date.now());
      const cutoff=new Date(Date.now()-90*86400000).toISOString().slice(0,10);
      const traffic=this.rows("SELECT day,COUNT(DISTINCT identity_id) visitors FROM visitors WHERE day>=? AND identity_id NOT IN (SELECT id FROM identities WHERE role='admin') GROUP BY day ORDER BY day DESC LIMIT 30",cutoff);
      const uniqueVisitors=this.row("SELECT COUNT(DISTINCT identity_id) count FROM visitors WHERE day>=? AND identity_id NOT IN (SELECT id FROM identities WHERE role='admin')",cutoff).count;
      return json({...counts,uniqueVisitors,traffic,paired:this.row("SELECT COUNT(*) n FROM session_stages WHERE stage='paired'").n,answered:this.row("SELECT COUNT(*) n FROM session_stages WHERE stage='answered'").n,sessions:this.row("SELECT value FROM counters WHERE name='sessions'")?.value||0,downloads:null});
    }
    return json({message:'Not found.'},404);
  }
}
