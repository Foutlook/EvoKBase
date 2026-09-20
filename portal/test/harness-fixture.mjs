import fs from 'node:fs/promises';
import path from 'node:path';

export async function fakeHarness(folder,output='OK') {
  const command=path.join(folder,'local harness & fixture.mjs'), control=path.join(folder,'control.json'), capture=path.join(folder,'capture.json');
  await fs.writeFile(control,JSON.stringify({output}));
  await fs.writeFile(command,`
import fs from 'node:fs/promises';
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('fixture 1.0.0');process.exit(0);}
const state=JSON.parse(await fs.readFile(${JSON.stringify(control)},'utf8'));
let input='';for await(const chunk of process.stdin)input+=chunk;
const patch=args.includes('--patch')?JSON.parse(await fs.readFile(args[args.indexOf('--patch')+1],'utf8')):null;
await fs.writeFile(${JSON.stringify(capture)},JSON.stringify({args,input,patch,cwd:process.cwd()}));
if(state.wait)await new Promise(resolve=>setTimeout(resolve,state.wait));
if(state.fail){console.error('401 synthetic-private-secret');process.exit(1);}
if(args.includes('--output-last-message'))await fs.writeFile(args[args.indexOf('--output-last-message')+1],state.output);
else process.stdout.write(state.output);
`);
  return {command,control,capture};
}
