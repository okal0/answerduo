import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';

const db=new DatabaseSync(process.env.ACCOUNTS_DB||'data/accounts.sqlite',{readOnly:true});
const admin=db.prepare("SELECT email,password FROM identities WHERE email=? AND role='admin'").get('answerhelperduo@gmail.com');
db.close();
if(!admin)throw Error('Create the local administrator before migrating it.');
// Password hashes travel through stdin to Cloudflare's encrypted secrets store.
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','bulk'],{stdio:['pipe','inherit','inherit'],windowsHide:true});
child.stdin.end(JSON.stringify({ADMIN_EMAIL:admin.email,ADMIN_PASSWORD_HASH:admin.password}));
child.on('exit',code=>{process.exitCode=code??1;});
