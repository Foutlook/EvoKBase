import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createImports,digest} from '../imports.mjs';
import {createModels} from '../models.mjs';
import {createLibrary} from '../library.mjs';
import {createProcessing,parseCandidates} from '../processing.mjs';
import {startPortal} from '../server.mjs';

const content='部署前校验输入，失败保留原资料。';
const oldContent='# 已有知识\n\n失败保留原资料。';
const input={name:'验收.md',title:'部署校验',category:'工程',source:'本地合成资料',base64:Buffer.from(content).toString('base64')};
const result={summary:'本文提出部署前校验。',candidates:[{title:'校验与失败保留',claim:'原文建议部署前校验输入，仍需核对适用范围。',sourceQuote:content,action:'supplement',reason:'在失败保留基础上补充输入校验。',evidence:[{id:'R1',quote:'失败保留原资料。'}]}],questions:['是否覆盖所有输入格式？']};
async function fixture(t) {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'evokbase-processing-'));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const root=path.join(folder,'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root,'首页.md'),oldContent);
  const config={root,include:['首页.md','00_资源库'],imports:{directory:path.join(folder,'staging'),resourceRoot:'00_资源库/外部资料'},models:{file:path.join(folder,'settings','models.json')}};
  const imports=await createImports(config), library=await createLibrary(config), models=createModels(config);
  const state=await models.save({action:'save',version:'new',provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'synthetic-model',apiKey:'synthetic-test-key'});
  const consent={confirmed:true,provider:'deepseek',modelVersion:state.version};
  const search={search:async()=>({degraded:false,results:[{title:'已有知识',local:{status:'available',bodyMatches:true,path:'首页.md',version:digest(oldContent)}}]})};
  return {folder,config,imports,library,models,consent,search};
}
async function settled(processing,id) {
  for(let i=0;i<300;i++) { const state=await processing.state(id); if(!['queued','running'].includes(state.status)) return state; await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.fail('processing did not settle');
}

test('导入 HTTP 自动处理、同源限制、可核对旧知识、持久化、重复请求复用且不改资料卡',async t=>{
  const fixtureData=await fixture(t), {config,imports,consent}=fixtureData;
  config.gbrain={url:'http://synthetic-gbrain.invalid/mcp',sourceId:'fixture'};
  const originalFetch=globalThis.fetch; let calls=0, sent;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url)==='http://synthetic-gbrain.invalid/mcp') {
      const request=JSON.parse(options.body), name=request.params.name;
      const data=name==='recall'?{results:[{slug:'首页',title:'已有知识',chunk:'失败保留原资料。',source_id:'fixture'}]}:{slug:'首页',source_id:'fixture',content:oldContent,compiled_truth:oldContent};
      return new Response(JSON.stringify({id:1,result:{structuredContent:data}}));
    }
    if(String(url).startsWith('https://api.deepseek.com/')) {calls++; sent=JSON.parse(options.body); return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}]}));}
    return originalFetch(url,options);
  });
  const server=await startPortal(config,0); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port, headers={Origin:base,'Content-Type':'application/json','X-EvoKBase-Request':'1'};
  const post=(route,body,extra={})=>fetch(base+route,{method:'POST',headers,body:JSON.stringify(body),...extra});
  const response=await post('/api/imports',{...input,processing:consent}); assert.equal(response.status,200);
  const job=await response.json(); assert.ok(['queued','running'].includes(job.processing.status));
  const processing=createProcessing(imports,fixtureData.models,fixtureData.search,fixtureData.library);
  // Poll through the owning server, not a second worker that would classify active work as interrupted.
  let ready;
  for(let i=0;i<200;i++){ready=await(await fetch(base+`/api/imports/${job.id}/processing`)).json();if(ready.status==='ready')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(ready.status,'ready'); assert.equal(ready.references[0].path,'首页.md'); assert.match(ready.markdown,/待人工审核/);
  const payload=JSON.parse(sent.messages[1].content); assert.equal(payload.document,content); assert.equal(payload.references[0].content,oldContent);
  assert.ok(!JSON.stringify(sent).includes('synthetic-test-key')); assert.ok(!JSON.stringify(sent).includes(config.root)); assert.equal(sent.max_tokens,16384);
  const updated=await imports.preview(job.id); assert.equal(updated.version,job.version); assert.equal(updated.card,job.card); assert.equal(updated.stage,'draft');
  assert.equal(await fs.readFile(path.join(config.root,'首页.md'),'utf8'),oldContent);
  assert.equal((await post(`/api/imports/${job.id}/processing`,{action:'start',sourceVersion:job.version,...consent},{headers:{...headers,Origin:'https://evil.invalid'}})).status,403);
  assert.equal((await post(`/api/imports/${job.id}/processing`,{action:'start',sourceVersion:job.version,...consent,confirmed:false})).status,400);
  assert.equal((await post(`/api/imports/${job.id}/processing`,{action:'start',sourceVersion:job.version,...consent})).status,200);
  assert.equal(calls,1); assert.equal((await processing.state(job.id)).status,'ready');
  const failed=await(await post('/api/imports',{...input,processing:{...consent,modelVersion:'stale'}})).json();
  assert.equal(failed.stage,'draft'); assert.equal(failed.processing.status,'failed');
  assert.equal((await(await fetch(base+'/api/imports/'+failed.id)).json()).processing.status,'failed');
});

test('模型候选必须有原文与真实参考依据；未知决策、伪造摘录与超量拒绝',()=>{
  const refs=[{id:'R1',content:oldContent}];
  assert.deepEqual(parseCandidates(JSON.stringify(result),content,refs),result);
  for(const change of [r=>r.candidates[0].sourceQuote='并不存在的内容',r=>r.candidates[0].evidence[0].quote='伪造旧知识',r=>r.candidates[0].evidence=[],r=>r.candidates[0].action='publish',r=>r.candidates=Array(4).fill(r.candidates[0])]) {
    const copy=structuredClone(result); change(copy); assert.throws(()=>parseCandidates(JSON.stringify(copy),content,refs),{status:502});
  }
});

test('版本变更、取消、旧知识变更与进程中断不会改写原件或已有草稿',async t=>{
  const {config,imports,library,models,consent,search}=await fixture(t);
  for(const mode of ['draft','cancel','reference']) {
    let finish, began;
    const started=new Promise(resolve=>{began=resolve;});
    const generation=new Promise(resolve=>{finish=resolve;});
    const stub={state:()=>models.state(),generate:async()=>{began();return generation;}};
    const processing=createProcessing(imports,stub,search,library), job=await imports.create(input);
    await processing.enqueue(job.id,{...consent,sourceVersion:job.version}); await started;
    if(mode==='draft') await imports.update(job.id,{version:job.version,target:job.target,card:job.card+'\n手工编辑'});
    if(mode==='cancel') await processing.cancel(job.id);
    if(mode==='reference') await fs.writeFile(path.join(config.root,'首页.md'),oldContent+'\n变更');
    finish(JSON.stringify(result)); const final=await settled(processing,job.id);
    assert.equal(final.status,mode==='cancel'?'cancelled':'failed'); assert.ok(!final.result);
    const current=await imports.preview(job.id); assert.equal(current.originalHash,job.originalHash); assert.equal(current.card,mode==='draft'?job.card+'\n手工编辑':job.card);
    if(mode==='reference') await fs.writeFile(path.join(config.root,'首页.md'),oldContent);
  }
  const job=await imports.create(input);
  await fs.writeFile(path.join(config.imports.directory,job.id,'processing.json'),JSON.stringify({id:job.id,sourceVersion:job.version,status:'running'}));
  assert.equal((await createProcessing(imports,models,search,library).state(job.id)).status,'interrupted');
});

test('超长资料、搜索失败及旧模型配置不得发送正文；失败仍保留导入',async t=>{
  const {imports,library,models,consent,search}=await fixture(t); let calls=0;
  const stub={state:()=>models.state(),generate:async()=>{calls++;return JSON.stringify(result);}};
  const large=await imports.create({...input,base64:Buffer.from('中'.repeat(32001)).toString('base64')});
  const processing=createProcessing(imports,stub,search,library);
  await processing.enqueue(large.id,{...consent,sourceVersion:large.version}); assert.equal((await settled(processing,large.id)).status,'failed'); assert.equal(calls,0);
  const job=await imports.create(input), unavailable=createProcessing(imports,stub,{search:async()=>{throw Error('unavailable');}},library);
  await unavailable.enqueue(job.id,{...consent,sourceVersion:job.version}); assert.equal((await settled(unavailable,job.id)).status,'failed'); assert.equal(calls,0);
  await assert.rejects(processing.enqueue(job.id,{...consent,modelVersion:'stale',sourceVersion:job.version}),{status:409});
  assert.equal((await imports.preview(job.id)).version,job.version);
});

test('模型生成使用已确认渠道；取消与配置轮换丢弃结果，不返回密钥',async t=>{
  const {config,models,consent}=await fixture(t); let finish, began;
  const started=new Promise(resolve=>{began=resolve;});
  t.mock.method(globalThis,'fetch',async()=>{began();return new Promise(resolve=>{finish=resolve;});});
  const pending=models.generate({provider:consent.provider,version:consent.modelVersion},[{role:'user',content:'合成正文'}]); await started;
  await assert.rejects(models.save({}),{status:409});
  const data=JSON.parse(await fs.readFile(config.models.file,'utf8')); data.version='rotated'; await fs.writeFile(config.models.file,JSON.stringify(data));
  finish(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]})));
  await assert.rejects(pending,{status:409});
});

test('Flash候选显式使用低强度思考并保留完整输出预算，截断或无最终正文不会采用',async t=>{
  const {models,consent}=await fixture(t);
  const state=await models.save({action:'save',version:consent.modelVersion,provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:''});
  let sent, mode='normal';
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    sent=JSON.parse(options.body);
    const complete=sent.thinking?.type==='enabled' && sent.reasoning_effort==='low' && sent.max_tokens>=16384;
    const truncated=mode==='length' || !complete;
    return new Response(JSON.stringify({choices:[{finish_reason:truncated?'length':'stop',message:{content:mode==='empty' || truncated?'':JSON.stringify(result),reasoning_content:'合成思考占用预算'}}]}));
  });
  const request={provider:'deepseek',version:state.version}, messages=[{role:'user',content:'合成正文'}];
  assert.equal(await models.generate(request,messages),JSON.stringify(result));
  assert.deepEqual(sent.thinking,{type:'enabled'}); assert.equal(sent.reasoning_effort,'low');
  mode='length'; await assert.rejects(models.generate(request,messages),/输出达到长度上限/);
  mode='empty'; await assert.rejects(models.generate(request,messages),/未返回最终正文/);
  const qwen=await models.save({action:'save',version:state.version,provider:'qwen',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen-plus',apiKey:'synthetic-qwen-key'});
  mode='normal'; await assert.rejects(models.generate({provider:'qwen',version:qwen.version},messages),{status:502});
  assert.equal(sent.thinking,undefined,'供应商参数不泄漏到其他渠道');
});

test('页面确认后导入自动触发，取消确认不导入，候选不覆盖未保存编辑',async()=>{
  const nodes=new Map(), requests=[]; let confirm=true, processing;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,events:{},addEventListener(name,fn){this.events[name]=fn;},replaceChildren(){},append(){}});return nodes.get(id);};
  const job={id:'fixture',title:'合成资料',version:'v1',stage:'draft',card:'原资料卡',target:'00_资源库/合成/资料',category:'合成',warnings:[],outputs:[]};
  const state={enabled:true,version:'m1',selected:'deepseek',providers:[{id:'deepseek',name:'DeepSeek',model:'synthetic-model',baseUrl:'https://api.deepseek.com',hasKey:true}]};
  const context=vm.createContext({document:{getElementById:node},window:{addEventListener(){},confirm:()=>confirm},Option:function(){},Uint8Array,btoa,
    fetch:async(url,options)=>{const body=options?.body?JSON.parse(options.body):undefined;requests.push({url,body});return {ok:true,json:async()=>{
      if(url==='/api/models')return state;
      if(body && url==='/api/imports'){processing=body.processing;return job;}
      if(url==='/api/imports')return {enabled:true,jobs:[job]};
      return {...job,processing:{status:'ready',references:[],markdown:'\nAI待审候选'}};
    }};}});
  vm.runInContext((await fs.readFile(new URL('../web/imports.js',import.meta.url),'utf8')).replace('export function','function')+'\nvar page=initImports();',context);
  await context.page.refresh(); node('import-auto-process').checked=true; node('import-file').files=[{name:'测试.md',size:6,arrayBuffer:async()=>new TextEncoder().encode('测试').buffer}];
  confirm=false; await node('import-form').events.submit({preventDefault(){}}); assert.equal(requests.filter(item=>item.body).length,0);
  confirm=true; await node('import-form').events.submit({preventDefault(){}}); assert.equal(processing.confirmed,true); assert.equal(processing.provider,'deepseek');
  node('import-card').value='手工修改'; node('import-card').events.input(); node('processing-adopt').events.click(); assert.equal(node('import-card').value,'手工修改');
  node('import-card').value=job.card; node('processing-adopt').events.click(); assert.equal(node('import-card').value,'原资料卡\nAI待审候选'); assert.equal(node('import-handoff').hidden,true);
  assert.equal(requests.filter(item=>item.body).length,1,'填入候选不会自动保存或批准');
});
