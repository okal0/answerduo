import { LAUNCH_ACCESS,accessExpiry,accessRemaining,accessEndedMessage } from './access-policy.ts';
import * as billing from './billing.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path=process.env.ACCOUNTS_DB||'data/accounts.sqlite';
if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
const db=new DatabaseSync(path);
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS identities (
    id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, role TEXT NOT NULL DEFAULT 'guest',
    paid_until INTEGER NOT NULL DEFAULT 0, used_ms INTEGER NOT NULL DEFAULT 0,
    active_since INTEGER, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logins (token TEXT PRIMARY KEY, identity_id TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, paid_until INTEGER NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (kind TEXT NOT NULL, path TEXT NOT NULL, visitor TEXT, created INTEGER NOT NULL);
`);
if(!db.prepare('PRAGMA table_info(identities)').all().some(column=>column.name==='launch_expires')){
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec('ALTER TABLE identities ADD COLUMN launch_expires INTEGER NOT NULL DEFAULT 0');
    db.prepare('UPDATE identities SET launch_expires=?').run(Date.now()+LAUNCH_ACCESS);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
db.exec('CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY)');
if(!db.prepare('SELECT name FROM migrations WHERE name=?').get('launch-seven-days-v1')){
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare("UPDATE identities SET launch_expires=? WHERE role!='admin'").run(Date.now()+LAUNCH_ACCESS);
    db.prepare('INSERT INTO migrations(name) VALUES(?)').run('launch-seven-days-v1');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
if(!db.prepare('SELECT name FROM migrations WHERE name=?').get('guest-preview-v1')){
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare("UPDATE identities SET used_ms=0 WHERE role='guest'").run();
    db.prepare('INSERT INTO migrations(name) VALUES(?)').run('guest-preview-v1');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
// A single server owns running trials. Checkpoints preserve elapsed usage
// without charging time while the process was stopped.
export function recoverTrials(){db.exec('UPDATE identities SET active_since=NULL WHERE active_since IS NOT NULL');}
const token=()=>randomBytes(32).toString('base64url');
const hash=value=>createHash('sha256').update(value).digest('hex');
const passwordHash=password=>{
  const salt=randomBytes(16).toString('hex');
  return salt+':'+scryptSync(password,salt,64).toString('hex');
};
export function createAdmin(email:string,password:string){
  if(!email.includes('@')||password.length<8)throw Error('Use a valid email and at least 8 password characters.');
  if(db.prepare('SELECT id FROM identities WHERE email=?').get(email.toLowerCase()))throw Error('Account already exists.');
  db.prepare("INSERT INTO identities(id,email,password,role,created) VALUES(?,?,?,'admin',?)").run(token(),email.toLowerCase(),passwordHash(password),Date.now());
}
export function resetAdmin(email:string,password:string){
  if(password.length<8||password.length>200)throw Error('Use a password of 8–200 characters.');
  const admin=db.prepare("SELECT id FROM identities WHERE email=? AND role='admin'").get(email.toLowerCase());
  if(!admin)throw Error('Administrator not found in the local database.');
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('UPDATE identities SET password=? WHERE id=?').run(passwordHash(password),admin.id);
    db.prepare('DELETE FROM logins WHERE identity_id=?').run(admin.id);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
function cookie(req,name){
  return req.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith(name+'='))?.slice(name.length+1);
}
function setCookie(req,res,value){
  res.setHeader('Set-Cookie','answerduo_session='+value+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'+(req.socket.encrypted||process.env.PUBLIC_ORIGIN?.startsWith('https:')?'; Secure':''));
}
export function identity(req){
  const value=cookie(req,'answerduo_session')||cookie(req,'interviewduo_session');
  return value?db.prepare('SELECT i.* FROM identities i JOIN logins l ON l.identity_id=i.id WHERE l.token=? AND l.expires>?').get(hash(value),Date.now()):null;
}
function login(req,res,id){
  const value=token();
  db.prepare('INSERT INTO logins VALUES(?,?,?)').run(hash(value),id,Date.now()+30*86400000);
  setCookie(req,res,value);
}
export function visitor(req,res){
  let user=identity(req);
  if(!user){
    const id=token();
    db.prepare('INSERT INTO identities(id,created,launch_expires) VALUES(?,?,?)').run(id,Date.now(),0);
    login(req,res,id);
    user=db.prepare('SELECT * FROM identities WHERE id=?').get(id);
  }
  return user;
}
export function remaining(user,now=Date.now()){
  return accessRemaining(user,now);
}
export function entitled(user){
  return user.role==='admin'||user.paid_until>Date.now();
}
export function startTrial(user){
  if(entitled(user))return;
  if(user.active_since)throw Error('A trial session is already running. End it before starting another.');
  if(remaining(user)<=0)throw Error(accessEndedMessage(user));
  db.prepare('UPDATE identities SET active_since=? WHERE id=?').run(Date.now(),user.id);
}
export function checkpoint(){
  const now=Date.now();
  db.prepare('UPDATE identities SET used_ms=used_ms+MAX(0,?-active_since),active_since=? WHERE active_since IS NOT NULL').run(now,now);
}
export function stopTrial(id){
  db.prepare('UPDATE identities SET used_ms=used_ms+MAX(0,?-active_since),active_since=NULL WHERE id=? AND active_since IS NOT NULL').run(Date.now(),id);
}
export function account(id){return db.prepare('SELECT * FROM identities WHERE id=?').get(id);}
export function trackPage(req,res,path,user){
  if(user?.role==='admin')return;
  const saved=cookie(req,'answerduo_visitor');
  const visitorId=saved&&/^[a-zA-Z0-9_-]{43}$/.test(saved)?saved:user.id;
  if(saved!==visitorId){
    const existing=res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie',[...(existing?(Array.isArray(existing)?existing:[existing]):[]),'answerduo_visitor='+visitorId+'; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000'+(req.socket.encrypted||process.env.PUBLIC_ORIGIN?.startsWith('https:')?'; Secure':'')]);
  }
  db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('page',path,visitorId,Date.now());
}
export function track(kind,path,user){
  db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(kind,path,user?.id||null,Date.now());
}
const attempts=new Map();
export function webhook(raw,signature){
  const event=billing.verify(raw,signature);
  if(!event.event_type?.startsWith('subscription.'))return;
  const subscription=event.data,id=subscription.id;
  const existing=db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
  const owner=existing?.identity_id||subscription.custom_data?.identity_id;
  const updated=Date.parse(event.occurred_at);
  if(typeof id!=='string'||!owner||!Number.isFinite(updated)||!account(owner))throw Error('Invalid subscription event');
  if(existing&&existing.updated>=updated)return;
  const correctPlan=subscription.items?.some(item=>item.price?.id===process.env.PADDLE_PRICE_ID);
  const until=correctPlan&&subscription.status==='active'?Date.parse(subscription.current_billing_period?.ends_at):0;
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET paid_until=excluded.paid_until,updated=excluded.updated').run(id,owner,Number.isFinite(until)?until:0,updated);
    db.prepare('UPDATE identities SET paid_until=(SELECT COALESCE(MAX(paid_until),0) FROM subscriptions WHERE identity_id=?) WHERE id=?').run(owner,owner);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export async function route(req,res,url,body){
  function json(status,data){res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(data));return true;}
  if(url==='/api/plans'&&req.method==='GET')return json(200,{checkout:false,price:'Coming soon'});
  if(url==='/api/account'&&req.method==='GET'){
    const user=visitor(req,res);
    return json(200,{email:user.email,role:user.role,member:entitled(user),remainingMs:remaining(user),launchExpiresAt:accessExpiry(user),trialKind:user.role==='guest'?'guest-preview':'registered-trial',paidUntil:user.paid_until});
  }
  if(url==='/api/auth/logout'&&req.method==='POST'){
    const value=cookie(req,'answerduo_session')||cookie(req,'interviewduo_session');
    if(value)db.prepare('DELETE FROM logins WHERE token=?').run(hash(value));
    setCookie(req,res,'');return json(200,{});
  }
  if((url==='/api/auth/signup'||url==='/api/auth/login')&&req.method==='POST'){
    const address=req.socket.remoteAddress;
    const limit=attempts.get(address)||{count:0,until:Date.now()+600000};
    if(limit.until<Date.now()){limit.count=0;limit.until=Date.now()+600000;}
    attempts.set(address,limit);
    if(++limit.count>12)return json(429,{message:'Too many attempts. Try again in ten minutes.'});
    const email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<(url.endsWith('signup')?8:1)||password.length>200)return json(400,{message:'Use a valid email and a password of 8–200 characters.'});
    let user=db.prepare('SELECT * FROM identities WHERE email=?').get(email);
    if(url.endsWith('signup')){
      if(user)return json(409,{message:'Use sign in if you already have an account.'});
      user=visitor(req,res);
      if(user.email)return json(409,{message:'Sign out before creating another account.'});
      db.prepare("UPDATE identities SET email=?,password=?,role='member',launch_expires=? WHERE id=?").run(email,passwordHash(password),Date.now()+LAUNCH_ACCESS,user.id);
    }else{
      const [salt,digest]=(user?.password||'placeholder:').split(':');
      const actual=scryptSync(password,salt,64);
      if(!digest||!timingSafeEqual(actual,Buffer.from(digest,'hex')))return json(401,{message:'Email or password was not recognized.'});
    }
    login(req,res,user.id);return json(200,{});
  }
  if(url==='/api/admin'&&req.method==='GET'){
    if(identity(req)?.role!=='admin')return json(403,{message:'Administrator sign-in required.'});
    const counts=db.prepare("SELECT COUNT(*) total,SUM(role='guest') guests,SUM(email IS NOT NULL) accounts,SUM(paid_until>?) paid FROM identities").get(Date.now());
    const traffic=db.prepare("SELECT date(created/1000,'unixepoch') day,COUNT(*) views,COUNT(DISTINCT visitor) visitors FROM events WHERE kind='page' AND created>=? AND visitor NOT IN (SELECT id FROM identities WHERE role='admin') GROUP BY day ORDER BY day DESC LIMIT 30").all(Date.now()-90*86400000);
    const sessions=db.prepare("SELECT COUNT(*) count FROM events WHERE kind='session'").get().count;
    const uniqueVisitors=db.prepare("SELECT COUNT(DISTINCT visitor) count FROM events WHERE kind='page' AND created>=? AND visitor NOT IN (SELECT id FROM identities WHERE role='admin')").get(Date.now()-90*86400000).count;
    return json(200,{...counts,uniqueVisitors,sessions,traffic,paired:db.prepare("SELECT COUNT(DISTINCT path) n FROM events WHERE kind='paired'").get().n,answered:db.prepare("SELECT COUNT(DISTINCT path) n FROM events WHERE kind='answered'").get().n,downloads:null});
  }
  if(url==='/api/checkout'&&req.method==='POST'){
    return json(503,{message:'Membership purchasing is currently paused.'});
  }
  return false;
}
