import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createModels} from '../models.mjs';
import {runProcess} from '../harness.mjs';
import {startPortal} from '../server.mjs';
import {fakeHarness} from './harness-fixture.mjs';
import {apply as guard} from '../harness-guard.mjs';

async function fixture(t) {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'evokbase-harness-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const root=path.join(folder,'vault');await fs.mkdir(root);await fs.writeFile(path.join(root,'首页.md'),'# 隔离测试');
  const fake=await fakeHarness(folder);
  const config={root,include:['首页.md'],harnesses:{file:path.join(folder,'settings','harness.json'),commands:{codex:fake.command,'deepseek-harness':path.join(folder,'missing.exe')}}};
  return {folder,config,...fake,models:createModels(config)};
}
const select=state=>({action:'save',provider:'codex',version:state.version});

test('只选择本地Harness；缺失明确提示；拒绝旧API配置；不读取或迁移旧密钥；路径和版本保护',async t=>{
  const {models,config,folder}=await fixture(t);
  config.models={file:path.join(folder,'old-api.json')};await fs.writeFile(config.models.file,'synthetic-secret-not-json');
  let state=await models.state();assert.equal(state.providers[0].available,true);assert.equal(state.providers[1].available,false);
  assert.match(state.providers[1].message,/未检测到/);assert.ok(!JSON.stringify(state).includes('launch'));
  await assert.rejects(models.save({...select(state),provider:'deepseek-harness'}),{status:409});
  await assert.rejects(models.save({...select(state),apiKey:'old-api'}),{status:400});
  state=await models.save(select(state));assert.equal(state.selected,'codex');
  await assert.rejects(models.save({...select(state),version:'stale'}),{status:409});
  assert.deepEqual(await createModels(config).state(),state);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(config.harnesses.file,'utf8'))).sort(),['schemaVersion','selected','version']);
  assert.equal(await fs.readFile(config.models.file,'utf8'),'synthetic-secret-not-json');
  await assert.rejects(createModels({...config,harnesses:{file:path.join(config.root,'settings.json')}}).state(),{status:503});
  const junction=path.join(folder,'junction');await fs.symlink(path.dirname(config.harnesses.file),junction,process.platform==='win32'?'junction':'dir');
  await assert.rejects(createModels({...config,harnesses:{file:path.join(junction,'settings.json')}}).state(),{status:409});
});

test('原生进程参数与长中文输入不经shell；只取最终答案；DeepSeek覆盖层先阻止工具；失败诊断脱敏',async t=>{
  const {models,config,control,capture,command,folder}=await fixture(t);
  let state=await models.save(select(await models.state()));
  assert.equal((await models.test({provider:'codex',version:state.version})).status,'connected');
  const payload='中文资料 & $(not-a-command)\n'.repeat(5000);
  await fs.writeFile(control,JSON.stringify({output:'最终正文'}));
  assert.equal(await models.generate({provider:'codex',version:state.version},[{role:'user',content:payload}]),'最终正文');
  let sent=JSON.parse(await fs.readFile(capture,'utf8'));
  assert.ok(sent.input.includes(payload));assert.ok(sent.args.includes('--ignore-user-config'));assert.ok(sent.args.includes('read-only'));assert.ok(sent.args.includes('shell_tool'));
  assert.notEqual(sent.cwd,config.root);assert.notEqual(sent.cwd,folder);await assert.rejects(fs.stat(sent.cwd),{code:'ENOENT'});
  config.harnesses.commands['deepseek-harness']=command;
  state=await models.save({...select(await models.state()),provider:'deepseek-harness'});
  assert.equal(await models.generate({provider:'deepseek-harness',version:state.version},[{role:'user',content:payload}]),'最终正文');
  sent=JSON.parse(await fs.readFile(capture,'utf8'));assert.ok(!sent.args.includes(payload));
  const runner=sent.patch.find(p=>p.id==='headless-runner');assert.ok(runner.inject.includes('evokbaseGuard'));assert.ok(runner.config.task.includes(payload));
  assert.equal(path.dirname(sent.patch[0].insert[0].name),sent.cwd);
  let restriction,deny,created,ready;
  guard({tools:{guard:f=>{deny=f;}},on:(_name,f)=>{created=f;},provide:(_name,value)=>{ready=value;}});
  created({agent:{ctx:{tools:{restrict:value=>{restriction=value;}}}}});
  assert.deepEqual(restriction,{allow:[]});assert.match(deny(),/禁止调用工具/);assert.equal(ready,true);
  await fs.writeFile(control,JSON.stringify({fail:true}));
  await assert.rejects(models.test({provider:'deepseek-harness',version:state.version}),e=>e.status===502 && !e.message.includes('synthetic-private'));
});

test('取消和超时终止进程；配置轮换丢弃结果；运行期间不能切换渠道',async t=>{
  const {models,config,control,capture}=await fixture(t),state=await models.save(select(await models.state()));
  await fs.writeFile(control,JSON.stringify({wait:800,output:'OK'}));
  const request={provider:'codex',version:state.version};
  const running=models.test(request);await assert.rejects(models.save(select(state)),{status:409});
  while(true){try{await fs.stat(capture);break;}catch{await new Promise(r=>setTimeout(r,15));}}
  const data=JSON.parse(await fs.readFile(config.harnesses.file,'utf8'));data.version='rotated';await fs.writeFile(config.harnesses.file,JSON.stringify(data));
  await assert.rejects(running,{status:409});
  await assert.rejects(models.generate({provider:'codex',version:(await models.state()).version},[{role:'user',content:'有界处理'}],undefined,50),{status:504});
  const command={program:process.execPath,prefix:[]};
  await assert.rejects(runProcess(command,['-e','setInterval(()=>{},1000)'],{timeoutMs:50}),{status:504});
  const controller=new AbortController(), pending=runProcess(command,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});controller.abort();await assert.rejects(pending,{status:499});
  await assert.rejects(runProcess(command,['-e','process.stdout.write("x".repeat(4096))'],{maxBytes:100}),{status:502});
});

test('仅原生上下文失败可触发分段，JSON错误跨输出块可识别，正文和其他失败不误判',async()=>{
  const command={program:process.execPath,prefix:[]};
  const failed={type:'turn.failed',error:{message:'Your input exceeds the context window of this model. synthetic-private'}};
  for(const exitCode of [0,1]) await assert.rejects(runProcess(command,['-e',`process.stdout.write(${JSON.stringify(JSON.stringify(failed))});process.exitCode=${exitCode}`],{jsonEvents:true}),error=>error.code==='CONTEXT_WINDOW_EXCEEDED' && !error.message.includes('synthetic-private'));
  await assert.rejects(runProcess(command,['-e',`process.stderr.write('dsh: CONTEXT_WINDOW_');setTimeout(()=>{process.stderr.write('EXCEEDED synthetic-private');process.exitCode=1},20)`]),{code:'CONTEXT_WINDOW_EXCEEDED'});
  await assert.rejects(runProcess(command,['-e',`console.error('模型思考 context_length_exceeded');console.error('dsh: NETWORK: unavailable');process.exitCode=1`]),{status:502});
  for(const message of ['401 unauthorized','request too large','input exceeds maximum allowed value']) {
    await assert.rejects(runProcess(command,['-e',`console.log(${JSON.stringify(JSON.stringify({type:'turn.failed',error:{message}}))});process.exitCode=1`],{jsonEvents:true}),error=>error.status===502 && !error.code);
  }
  const prose=JSON.stringify({type:'item.completed',item:{text:'context_length_exceeded'}});
  await assert.rejects(runProcess(command,['-e',`console.log(${JSON.stringify(prose)});process.exitCode=1`],{jsonEvents:true}),{status:502});
  const recovered=JSON.stringify(failed)+'\n'+JSON.stringify({type:'turn.completed'});
  assert.equal(await runProcess(command,['-e',`process.stdout.write(${JSON.stringify(recovered)})`],{jsonEvents:true}),recovered);
});

test('HTTP只接收同源选择；旧供应商写入失败；固定测试运行本地进程',async t=>{
  const {config}=await fixture(t),server=await startPortal(config,0);t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port, headers={Origin:base,'Content-Type':'application/json','X-EvoKBase-Request':'1'};
  const post=(body,route='/api/models',origin=base)=>fetch(base+route,{method:'POST',headers:{...headers,Origin:origin},body:JSON.stringify(body)});
  let state=await(await fetch(base+'/api/models')).json();
  assert.equal((await post(select(state),'/api/models','https://evil.invalid')).status,403);
  assert.equal((await post({...select(state),provider:'deepseek',apiKey:'synthetic'})).status,400);
  state=await(await post(select(state))).json();assert.equal(state.selected,'codex');
  assert.equal((await post({provider:'codex',version:state.version},'/api/models/test')).status,200);
  assert.equal((await fetch(base+'/api/tree')).status,200);
});

test('页面缺失工具禁用使用与测试；重新检测后可选择；不再显示API字段',async()=>{
  const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',events:{},addEventListener(n,f){this.events[n]=f;},replaceChildren(){}});return nodes.get(id);};
  const state={enabled:true,version:'v1',selected:null,providers:[{id:'codex',name:'Codex',available:true,runtimeVersion:'1.0',hint:'登录配置'},{id:'deepseek-harness',name:'DeepSeek Harness',available:false,message:'未检测到 dsh'}]};
  let sent;
  const context=vm.createContext({document:{getElementById:node},window:{addEventListener(){}},Option:function(){},AbortController,fetch:async(_url,options)=>({ok:true,json:async()=>{if(options?.body){sent=JSON.parse(options.body);return {...state,selected:sent.provider};}return state;}})});
  vm.runInContext((await fs.readFile(new URL('../web/models.js',import.meta.url),'utf8')).replace('export function','function')+'\nvar view=initModels();',context);
  await context.view.refresh();node('model-provider').value='deepseek-harness';node('model-provider').events.change();
  assert.equal(node('model-save').disabled,true);assert.equal(node('model-test').disabled,true);assert.match(node('model-hint').textContent,/未检测/);
  node('model-provider').value='codex';node('model-provider').events.change();await node('model-form').events.submit({preventDefault(){}});
  assert.deepEqual(sent,{action:'save',version:'v1',provider:'codex'});assert.equal(node('model-test').disabled,false);
  const html=await fs.readFile(new URL('../web/index.html',import.meta.url),'utf8');assert.ok(!html.includes('id="model-key"'));assert.ok(!html.includes('id="model-base-url"'));
});
