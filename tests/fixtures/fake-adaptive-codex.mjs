import fs from 'node:fs';
import crypto from 'node:crypto';
const mode=process.argv[2],args=process.argv.slice(3),model=args[args.indexOf('--model')+1];
const high=args.some(arg=>arg.includes('model_reasoning_effort') && arg.includes('high'));
if (mode==='pre-session-timeout' && model==='work-low') {
  fs.writeFileSync('feature.txt','partial-low');await new Promise(resolve=>setTimeout(resolve,60000));
}
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:crypto.randomUUID()})+'\n');
if (mode==='auth') {process.stderr.write('authentication required');process.exit(1);}
if (mode==='forbidden') fs.writeFileSync('.env','fixture');
if (model==='work-low') {
  fs.writeFileSync('feature.txt',mode==='pass-low'?'good':'partial-low');
  if (mode==='timeout') await new Promise(resolve=>setTimeout(resolve,60000));
} else {
  if (high && args.includes('resume')) throw new Error('An upgraded model must start a fresh session');
  const previous=fs.existsSync('feature.txt')?fs.readFileSync('feature.txt','utf8'):mode==='pass-mid'?'fresh':'';
  if (!previous.startsWith('partial') && previous!=='good' && previous!=='fresh') throw new Error('Prior work was lost during escalation');
  fs.writeFileSync('feature.txt',mode==='pass-mid' || high && mode!=='exhaust'?'good':'partial-mid');
}
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture attempt '+model}})+'\n');
