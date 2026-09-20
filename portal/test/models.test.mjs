import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {createModels,providers,probeModel} from '../models.mjs';
import {startPortal} from '../server.mjs';

async function fixture(t) {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'evokbase-model-'));
  assert.equal(path.dirname(folder),path.resolve(os.tmpdir()));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const root=path.join(folder,'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root,'首页.md'),'# 隔离测试');
  const config={root,include:['首页.md'],models:{file:path.join(folder,'settings','models.json')}};
  return {folder,config,models:createModels(config)};
}
const entry=(version,provider='deepseek',apiKey='synthetic-key-A')=>({action:'save',version,provider,apiKey,model:'sample-model',baseUrl:providers.find(p=>p.id===provider).baseUrl});

test('密钥独立保存、不回传；版本、目标地址与文件边界保护',async t=>{
  const {config,models,folder}=await fixture(t);
  let state=await models.state(); assert.equal(state.version,'new');
  await assert.rejects(fs.stat(config.models.file),{code:'ENOENT'});
  state=await models.save(entry(state.version));
  assert.ok(!JSON.stringify(state).includes('synthetic-key'));
  assert.equal(state.providers[0].hasKey,true);
  const first=state.version;
  await assert.rejects(models.save(entry('new')), {status:409});
  await assert.rejects(models.save(entry(first,'qwen','')), {status:400});
  for(const baseUrl of ['http://127.0.0.1','https://api.deepseek.com.evil.test','https://user:pass@api.deepseek.com','https://api.deepseek.com?key=value']) {
    await assert.rejects(models.save({...entry(first),baseUrl}),{status:400});
  }
  state=await models.save({...entry(first),apiKey:'',model:'sample-model-2'});
  assert.equal(JSON.parse(await fs.readFile(config.models.file,'utf8')).providers.deepseek.apiKey,'synthetic-key-A');
  state=await models.save(entry(state.version,'qwen','synthetic-key-B'));
  assert.equal(state.providers.filter(p=>p.hasKey).length,2);
  await assert.rejects(models.save({...entry(state.version,'qwen',''),baseUrl:'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'}),{status:400});
  state=await models.save({action:'remove',version:state.version,provider:'deepseek'});
  assert.equal(state.providers[0].hasKey,false); assert.equal(state.providers[1].hasKey,true);
  assert.deepEqual(await createModels(config).state(),state);
  assert.equal((await fs.readFile(config.models.file)).subarray(0,3).equals(Buffer.from([239,187,191])),false);
  await fs.writeFile(config.models.file+'.lock','fixture');
  await assert.rejects(models.save(entry(state.version)),{status:409});
  await fs.unlink(config.models.file+'.lock');
  const malformed='{"apiKey":"synthetic-sensitive-data"'; await fs.writeFile(config.models.file,malformed);
  await assert.rejects(models.state(),error=>error.status===503 && !error.message.includes('synthetic'));
  await assert.rejects(models.save(entry(state.version)),{status:503});
  assert.equal(await fs.readFile(config.models.file,'utf8'),malformed);
  await assert.rejects(createModels({...config,models:{file:path.join(config.root,'secret.json')}}).state(),{status:503});
  const junction=path.join(folder,'junction'); await fs.symlink(path.dirname(config.models.file),junction,process.platform==='win32'?'junction':'dir');
  await assert.rejects(createModels({...config,models:{file:path.join(junction,'other.json')}}).save(entry('new')),{status:409});
});

test('固定测试请求、正常响应、鉴权错误脱敏、无效响应、超限、超时与取消',async t=>{
  let mode='ok', received;
  const server=http.createServer(async(req,res)=>{
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    received={path:req.url,headers:req.headers,body:JSON.parse(Buffer.concat(chunks))};
    if(mode==='wait') return;
    if(mode==='auth') { res.writeHead(401); return res.end('synthetic-key-secret'); }
    if(mode==='redirect') { res.writeHead(302,{Location:'http://127.0.0.1:1'}); return res.end(); }
    if(mode==='large') return res.end('x'.repeat(256*1024+1));
    if(mode==='bad') return res.end('not json synthetic-key-secret');
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:mode==='empty'?{}:mode==='reasoning'?{reasoning_content:'OK'}:{content:'OK synthetic-key-secret'}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections(); return new Promise(resolve=>server.close(resolve));});
  const input={baseUrl:`http://127.0.0.1:${server.address().port}`,model:'synthetic-model',apiKey:'synthetic-key-secret'};
  const result=await probeModel(input);
  assert.equal(result.status,'connected'); assert.ok(!JSON.stringify(result).includes('synthetic-key'));
  assert.equal(received.path,'/chat/completions'); assert.equal(received.headers.authorization,'Bearer synthetic-key-secret');
  assert.deepEqual(received.body,{model:'synthetic-model',messages:[{role:'user',content:'连接测试：请只回复 OK。'}],stream:false,max_tokens:64});
  mode='reasoning'; assert.equal((await probeModel(input)).status,'connected');
  for(mode of ['auth','redirect','bad','empty','large']) await assert.rejects(probeModel(input),error=>error.status===502 && !error.message.includes('synthetic-key'));
  mode='wait'; await assert.rejects(probeModel(input,undefined,50),{status:504});
  const controller=new AbortController(), pending=probeModel(input,controller.signal); controller.abort();
  await assert.rejects(pending,{status:499});
  await assert.rejects(probeModel({...input,baseUrl:'http://127.0.0.1:1'}),{status:502});
});

test('模型 HTTP 同源、密钥不可下载、取消向上游传播；未配置不影响旧入口',async t=>{
  const {config}=await fixture(t), originalFetch=globalThis.fetch;
  let started, cancelled, mode='wait', calls=0;
  const upstreamStarted=new Promise(resolve=>{started=resolve;}), upstreamCancelled=new Promise(resolve=>{cancelled=resolve;});
  t.mock.method(globalThis,'fetch',(url,options)=>{
    if(!String(url).startsWith('https://api.deepseek.com/')) return originalFetch(url,options);
    calls++;
    if(mode==='ok') return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:'OK'}}]})));
    started();
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{cancelled();reject(options.signal.reason);},{once:true}));
  });
  const server=await startPortal(config,0); t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Origin:base,'Content-Type':'application/json','X-EvoKBase-Request':'1'};
  const post=(route,body,extra={})=>fetch(base+route,{method:'POST',headers,body:JSON.stringify(body),...extra});
  let state=await (await fetch(base+'/api/models')).json();
  assert.equal((await post('/api/models',entry(state.version),{headers:{...headers,Origin:'https://evil.test'}})).status,403);
  assert.equal((await post('/api/models',entry(state.version),{headers:{'Content-Type':'application/json'}})).status,403);
  state=await (await post('/api/models',entry(state.version))).json();
  assert.equal(calls,0); assert.ok(!JSON.stringify(state).includes('synthetic-key'));
  assert.equal((await fetch(base+'/api/tree')).status,200);
  assert.equal((await fetch(base+'/file?path=../settings/models.json')).status,404);
  assert.equal((await fetch(base+'/models.js')).status,200);
  const controller=new AbortController();
  const request=post('/api/models/test',{provider:'deepseek',version:state.version},{signal:controller.signal});
  await upstreamStarted;
  assert.equal((await post('/api/models/test',{provider:'deepseek',version:state.version})).status,409);
  controller.abort(); await assert.rejects(request); await upstreamCancelled;
  await new Promise(resolve=>setImmediate(resolve));
  mode='ok'; assert.equal((await (await post('/api/models/test',{provider:'deepseek',version:state.version})).json()).status,'connected');
  assert.equal(calls,2);
  await fs.writeFile(config.models.file,'invalid JSON');
  assert.equal((await fetch(base+'/api/models')).status,503);
  assert.equal((await fetch(base+'/api/tree')).status,200);
  const disabled=await startPortal({...config,models:false},0); t.after(()=>{disabled.closeAllConnections();return new Promise(resolve=>disabled.close(resolve));});
  const disabledBase=`http://127.0.0.1:${disabled.address().port}`;
  assert.equal((await (await fetch(disabledBase+'/api/models')).json()).enabled,false);
  assert.equal((await fetch(disabledBase+'/api/tree')).status,200);
});

test('页面密钥不缓存、未保存不能测试、切换清空密钥、取消测试',async()=>{
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id)) nodes.set(id,{value:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},replaceChildren(...children){this.children=children;}});
    return nodes.get(id);
  };
  const state={enabled:true,version:'v1',selected:'deepseek',providers:providers.map(p=>({...p,model:'test',hasKey:true}))};
  let action, calls=0, refreshGate;
  const context=vm.createContext({document:{getElementById:node},window:{confirm:()=>true,addEventListener(){}},Option:function(name,value){this.name=name;this.value=value;},AbortController,
    fetch:async(_url,options)=>{
      if(!options.method) { if(refreshGate) await refreshGate; return {ok:true,json:async()=>state}; }
      calls++; action=JSON.parse(options.body);
      if(_url.endsWith('/test')) return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))));
      return {ok:true,json:async()=>({...state,version:'v2'})};
    }
  });
  const source=(await fs.readFile(new URL('../web/models.js',import.meta.url),'utf8')).replace('export function','function');
  vm.runInContext(source+'\nvar view=initModels();',context);
  await vm.runInContext('view.refresh()',context);
  let finishRefresh;
  refreshGate=new Promise(resolve=>{finishRefresh=resolve;});
  const refreshing=vm.runInContext('view.refresh()',context);
  assert.equal(node('model-name').disabled,true,'刷新返回前禁用编辑，防止迟到响应清空刚输入的配置');
  assert.equal(node('model-save').disabled,true);
  node('model-form').listeners.submit({preventDefault(){}});
  assert.equal(calls,0,'刷新期间不能保存旧版本配置');
  finishRefresh(); await refreshing; refreshGate=null;
  assert.equal(node('model-name').disabled,false);
  node('model-key').value='synthetic-browser-key'; node('model-key').listeners.input();
  assert.equal(node('model-test').disabled,true);
  node('model-provider').value='qwen'; node('model-provider').listeners.change(); assert.equal(node('model-key').value,'');
  node('model-key').value='synthetic-browser-key'; node('model-key').listeners.input();
  node('model-form').listeners.submit({preventDefault(){}}); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(action.provider,'qwen'); assert.equal(action.apiKey,'synthetic-browser-key'); assert.equal(node('model-key').value,'');
  const pending=node('model-test').listeners.click();
  node('model-cancel').listeners.click(); await pending;
  assert.match(node('model-status').textContent,/已取消/); assert.equal(node('model-cancel').hidden,true); assert.equal(calls,2);
});
