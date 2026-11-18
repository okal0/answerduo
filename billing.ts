import { createHmac,timingSafeEqual } from 'node:crypto';

export const configured=()=>!!(process.env.PADDLE_API_KEY&&process.env.PADDLE_PRICE_ID&&process.env.PADDLE_WEBHOOK_SECRET);
export async function checkout(identityId:string){
  const endpoint=process.env.PADDLE_ENV==='production'?'https://api.paddle.com':'https://sandbox-api.paddle.com';
  const response=await fetch(endpoint+'/transactions',{method:'POST',signal:AbortSignal.timeout(15000),
    headers:{Authorization:'Bearer '+process.env.PADDLE_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({items:[{price_id:process.env.PADDLE_PRICE_ID,quantity:1}],collection_mode:'automatic',custom_data:{identity_id:identityId}})});
  const transaction=await response.json();
  if(!response.ok||!transaction.data?.checkout?.url)throw Error('Checkout could not start. Please try again later.');
  return transaction.data.checkout.url;
}
export function verify(raw:string,signature:string){
  const fields=signature.split(';').map(part=>part.trim().split('='));
  const timestamp=fields.find(([name])=>name==='ts')?.[1];
  const expected=createHmac('sha256',process.env.PADDLE_WEBHOOK_SECRET||'').update(timestamp+':'+raw).digest();
  if(!configured()||!timestamp||!Number.isFinite(Number(timestamp))||Math.abs(Date.now()/1000-Number(timestamp))>300 ||
    !fields.some(([name,value])=>name==='h1'&&/^[a-f0-9]{64}$/i.test(value)&&timingSafeEqual(expected,Buffer.from(value,'hex'))))throw Error('Invalid webhook signature');
  return JSON.parse(raw);
}
