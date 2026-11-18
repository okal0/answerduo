import { createAdmin,resetAdmin } from './accounts.ts';
import { createInterface } from 'node:readline';
const reset=process.argv.includes('--reset');
const save=reset?resetAdmin:createAdmin;
const success=reset?'Administrator password updated locally.':'Administrator created. Sign in at /account.';
if(process.stdin.isTTY){
  console.log(reset?'AnswerDuo administrator password reset':'AnswerDuo administrator setup');
  console.log('Email: answerhelperduo@gmail.com');
  const prompt=createInterface({input:process.stdin,output:process.stdout,terminal:true});
  const password=await new Promise<string>(resolve=>prompt.question('Choose a password (at least 8 characters): ',resolve));
  const confirmation=await new Promise<string>(resolve=>prompt.question('Confirm password: ',resolve));
  prompt.close();
  try{
    if(password!==confirmation)throw Error('Passwords did not match. Run setup again.');
    save('answerhelperduo@gmail.com',password);
    console.log(success);
  }catch(error){console.error(error.message);process.exitCode=1;}
}else{
// Read credentials from stdin to keep passwords out of process arguments.
let input='';
for await(const chunk of process.stdin)input+=chunk;
const {email,password}=JSON.parse(input);
save(String(email).trim(),String(password));
console.log(success);
}
