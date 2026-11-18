export const LAUNCH_ACCESS=7*24*60*60*1000;
export const GUEST_PREVIEW=20*60*1000;
export function accessExpiry(user:any){return user.role==='guest'?null:user.launch_expires;}
export function accessRemaining(user:any,now=Date.now()){
  if(user.role==='guest'){
    const pending=user.active_room?Math.max(0,Math.min(now,user.lease_until,user.active_until)-user.last_tick):user.active_since?Math.max(0,now-user.active_since):0;
    return Math.max(0,GUEST_PREVIEW-user.used_ms-pending);
  }
  return Math.max(0,user.launch_expires-now);
}
export function accessEndedMessage(user:any){
  return user.role==='guest'?'Your 20-minute guest preview has ended. Register for 7 days free. No credit card required.':'Your 7-day free trial has ended. A license is required to continue. License activation is coming soon.';
}
