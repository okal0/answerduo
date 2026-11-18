import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
const auth=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','auth','token','--json'],{encoding:'utf8',windowsHide:true});
if(auth.status!==0)throw Error('Cloudflare login is required.');
const credentials=JSON.parse(auth.stdout);
const token=credentials.token||credentials.api_token||credentials.oauth_token||credentials.access_token;
if(!token)throw Error('Wrangler credential format is unsupported.');
const endpoint='https://api.cloudflare.com/client/v4/accounts/'+config.account_id+'/workers/subdomain';
const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
const current=await (await fetch(endpoint,{headers})).json();
const requested='answerduo';
if(current.success&&current.result?.subdomain){
  console.log('Existing subdomain: '+current.result.subdomain);
  if(current.result.subdomain!==requested)throw Error('An existing account subdomain differs. Review it before changing it.');
}else{
  const response=await fetch(endpoint,{method:'PUT',headers,body:JSON.stringify({subdomain:requested})});
  const result=await response.json();
  if(!response.ok||!result.success)throw Error('Cloudflare could not register the requested subdomain: '+JSON.stringify(result.errors));
  console.log('Registered '+requested+'.workers.dev');
}
console.log('Target site: https://'+config.name+'.'+requested+'.workers.dev');
