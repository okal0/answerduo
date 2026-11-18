import test from 'node:test';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

test('20-minute guest preview upgrades to a seven-day registered trial, expires offline, rejects overlap and protects admin metrics',async t=>{
  process.env.ACCOUNTS_DB=':memory:';
  const accounts=await import('./accounts.ts');
  let now=Date.now();
  t.mock.method(Date,'now',()=>now);
  const req={headers:{},socket:{remoteAddress:'127.0.0.1',encrypted:false},method:'POST'};
  let session='',status,body;
  const res={
    setHeader(name,value){if(name==='Set-Cookie')session=value.split(';')[0];},
    writeHead(code){status=code;return this;},
    end(value){body=JSON.parse(value);return this;}
  };
  const guest=accounts.visitor(req,res);
  req.headers.cookie=session;
  const launch=7*86400000;
  assert.equal(accounts.remaining(guest),20*60000);
  accounts.startTrial(guest);
  assert.throws(()=>accounts.startTrial(accounts.account(guest.id)),/already running/);
  now+=10000;
  accounts.stopTrial(guest.id);
  assert.equal(accounts.remaining(accounts.account(guest.id)),20*60000-10000);
  now+=2*86400000;
  assert.equal(accounts.remaining(accounts.account(guest.id)),20*60000-10000,'preview does not run while offline');
  accounts.startTrial(accounts.account(guest.id));now+=20*60000;
  accounts.stopTrial(guest.id);
  assert.equal(accounts.remaining(accounts.account(guest.id)),0);
  assert.throws(()=>accounts.startTrial(accounts.account(guest.id)),/Register for 7 days free/);
  await accounts.route(req,res,'/api/auth/signup',{email:'candidate@example.com',password:'1234567'});
  assert.equal(status,400);
  await accounts.route(req,res,'/api/auth/signup',{email:'candidate@example.com',password:'12345678'});
  assert.equal(status,200);req.headers.cookie=session;
  const member=accounts.identity(req);
  assert.equal(member.id,guest.id);
  assert.equal(accounts.remaining(member),launch);
  assert.equal(accounts.entitled(member),false);
  accounts.startTrial(member);now+=20000;
  accounts.stopTrial(member.id);
  assert.equal(accounts.remaining(accounts.account(member.id)),launch-20000,'registered trial follows wall-clock expiry');
  now=member.launch_expires-1;
  assert.equal(accounts.remaining(accounts.account(member.id)),1);
  now+=1;
  assert.equal(accounts.remaining(accounts.account(member.id)),0);
  assert.throws(()=>accounts.startTrial(accounts.account(member.id)),/7-day free trial has ended/);
  req.method='GET';
  await accounts.route(req,res,'/api/admin',null);assert.equal(status,403);
  process.env.PADDLE_API_KEY='test-key';process.env.PADDLE_PRICE_ID='pri_fixture';process.env.PADDLE_WEBHOOK_SECRET='secret';
  const paidEvent={event_type:'subscription.activated',occurred_at:new Date(now).toISOString(),data:{
    id:'sub_fixture',custom_data:{identity_id:member.id},status:'active',items:[{price:{id:'pri_fixture'}}],
    current_billing_period:{ends_at:new Date(now+86400000).toISOString()}
  }};
  const sendEvent=event=>{
    const raw=JSON.stringify(event),timestamp=Math.floor(now/1000);
    const signature=createHmac('sha256','secret').update(timestamp+':'+raw).digest('hex');
    accounts.webhook(raw,'ts='+timestamp+';h1='+signature);
  };
  assert.throws(()=>accounts.webhook(JSON.stringify(paidEvent),'ts=1;h1=bad'),/signature/);
  sendEvent(paidEvent);sendEvent(paidEvent);
  assert.equal(accounts.entitled(accounts.account(member.id)),true);
  now+=1000;
  sendEvent({...paidEvent,event_type:'subscription.canceled',occurred_at:new Date(now).toISOString(),data:{...paidEvent.data,status:'canceled'}});
  sendEvent(paidEvent);
  assert.equal(accounts.entitled(accounts.account(member.id)),false);

  accounts.createAdmin('owner@example.com','admin-password-long');
  req.method='POST';
  await accounts.route(req,res,'/api/auth/login',{email:'owner@example.com',password:'wrong-password-long'});assert.equal(status,401);
  await accounts.route(req,res,'/api/auth/login',{email:'owner@example.com',password:'admin-password-long'});assert.equal(status,200);
  req.headers.cookie=session;req.method='GET';
  await accounts.route(req,res,'/api/admin',null);assert.equal(status,200);
  assert.equal(body.guests,0);assert.equal(body.accounts,2);assert.equal(body.paid,0);
  const browserHeaders=new Map();
  const browserRes={getHeader:name=>browserHeaders.get(name),setHeader:(name,value)=>browserHeaders.set(name,value)};
  const browserReq={headers:{},socket:{encrypted:false}};
  accounts.trackPage(browserReq,browserRes,'/',member);
  browserReq.headers.cookie=browserHeaders.get('Set-Cookie')[0].split(';')[0];
  accounts.trackPage(browserReq,browserRes,'/pricing',{...member,id:'different-session'});
  accounts.trackPage(req,browserRes,'/admin',accounts.identity(req));
  await accounts.route(req,res,'/api/admin',null);
  assert.equal(body.uniqueVisitors,1,'browser identity survives session changes and excludes admin views');
  assert.equal(body.traffic[0].visitors,1);
  assert.equal(accounts.entitled(accounts.identity(req)),true);
  const adminId=accounts.identity(req).id;
  assert.throws(()=>accounts.resetAdmin('owner@example.com','1234567'),/8/);
  accounts.resetAdmin('owner@example.com','new12345');
  assert.equal(accounts.identity(req),undefined);
  req.method='POST';
  await accounts.route(req,res,'/api/auth/login',{email:'owner@example.com',password:'admin-password-long'});
  assert.equal(status,401);
  await accounts.route(req,res,'/api/auth/login',{email:'owner@example.com',password:'new12345'});
  assert.equal(status,200);req.headers.cookie=session;
  assert.equal(accounts.identity(req).id,adminId);
});
