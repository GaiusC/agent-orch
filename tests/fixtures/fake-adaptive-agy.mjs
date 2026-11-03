import fs from 'node:fs';
import crypto from 'node:crypto';
const mode=process.argv[2],args=process.argv.slice(3),model=args[args.indexOf('--model')+1];
if (mode==='auth') {process.stderr.write('authentication required; quota exceeded');process.exit(1);}
if (mode==='mutate') {fs.writeFileSync('feature.txt','mutated');process.stderr.write('RESOURCE_EXHAUSTED quota exceeded');process.exit(1);}
if (mode==='quota' && model!=='review-low') {process.stderr.write('RESOURCE_EXHAUSTED quota exceeded');process.exit(1);}
if (mode==='quota-zero' && model!=='review-low') {process.stdout.write('RESOURCE_EXHAUSTED quota exceeded');process.exit(0);}
process.stdout.write('conversation='+crypto.randomUUID()+'\nVERDICT: '+(mode==='reject'?'FAIL':'PASS')+'\nCurrent patch inspected.\n');
