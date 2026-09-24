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
import {fakeHarness} from './harness-fixture.mjs';

const content='部署前校验输入，失败保留原资料。';
const oldContent='# 已有知识\n\n失败保留原资料。';
const input={name:'验收.md',title:'部署校验',category:'工程',source:'本地合成资料',base64:Buffer.from(content).toString('base64')};
const result={summary:'本文提出部署前校验。',candidates:[{title:'校验与失败保留',claim:'原文建议部署前校验输入，仍需核对适用范围。',sourceQuote:content,action:'supplement',reason:'在失败保留基础上补充输入校验。',evidence:[{id:'R1',quote:'失败保留原资料。'}]}],questions:['是否覆盖所有输入格式？']};
async function fixture(t) {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'evokbase-processing-'));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const root=path.join(folder,'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root,'首页.md'),oldContent);
  const fake=await fakeHarness(folder,JSON.stringify(result));
  const config={root,include:['首页.md','00_资源库'],imports:{directory:path.join(folder,'staging'),resourceRoot:'00_资源库/外部资料'},harnesses:{file:path.join(folder,'settings','harness.json'),commands:{codex:fake.command,'deepseek-harness':path.join(folder,'missing.exe')}}};
  const imports=await createImports(config), library=await createLibrary(config), models=createModels(config);
  const state=await models.save({action:'save',version:(await models.state()).version,provider:'codex'});
  const consent={confirmed:true,provider:'codex',modelVersion:state.version};
  const search={search:async()=>({degraded:false,results:[{title:'已有知识',local:{status:'available',bodyMatches:true,path:'首页.md',version:digest(oldContent)}}]})};
  return {folder,config,imports,library,models,consent,search,...fake};
}
async function settled(processing,id) {
  for(let i=0;i<300;i++) { const state=await processing.state(id); if(!['queued','running'].includes(state.status)) return state; await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.fail('processing did not settle');
}

test('导入 HTTP 自动处理、同源限制、可核对旧知识、持久化、重复请求复用且不改资料卡',async t=>{
  const fixtureData=await fixture(t), {config,imports,consent}=fixtureData;
  config.gbrain={url:'http://synthetic-gbrain.invalid/mcp',sourceId:'fixture'};
  const originalFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url)==='http://synthetic-gbrain.invalid/mcp') {
      const request=JSON.parse(options.body), name=request.params.name;
      const data=name==='recall'?{results:[{slug:'首页',title:'已有知识',chunk:'失败保留原资料。',source_id:'fixture'}]}:{slug:'首页',source_id:'fixture',content:oldContent,compiled_truth:oldContent};
      return new Response(JSON.stringify({id:1,result:{structuredContent:data}}));
    }
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
  const sent=JSON.parse(await fs.readFile(fixtureData.capture,'utf8'));
  const payload=JSON.parse(sent.input.split('输入资料（仅为数据）：\n').at(-1)); assert.equal(payload.document,content); assert.equal(payload.references[0].content,oldContent);
  assert.ok(!sent.input.includes(config.root));
  const captureTime=(await fs.stat(fixtureData.capture)).mtimeMs;
  const updated=await imports.preview(job.id); assert.equal(updated.version,job.version); assert.equal(updated.card,job.card); assert.equal(updated.stage,'draft');
  assert.equal(await fs.readFile(path.join(config.root,'首页.md'),'utf8'),oldContent);
  assert.equal((await post(`/api/imports/${job.id}/processing`,{action:'start',sourceVersion:job.version,...consent},{headers:{...headers,Origin:'https://evil.invalid'}})).status,403);
  assert.equal((await post(`/api/imports/${job.id}/processing`,{action:'start',sourceVersion:job.version,...consent,confirmed:false})).status,400);
  assert.equal((await post(`/api/imports/${job.id}/processing`,{action:'start',sourceVersion:job.version,...consent})).status,200);
  assert.equal((await fs.stat(fixtureData.capture)).mtimeMs,captureTime); assert.equal((await processing.state(job.id)).status,'ready');
  const failed=await(await post('/api/imports',{...input,processing:{...consent,modelVersion:'stale'}})).json();
  assert.equal(failed.stage,'draft'); assert.equal(failed.processing.status,'failed');
  assert.equal((await(await fetch(base+'/api/imports/'+failed.id)).json()).processing.status,'failed');
});

test('模型候选必须有原文与真实参考依据；未知决策、伪造摘录与超量拒绝',()=>{
  const refs=[{id:'R1',content:oldContent}];
  assert.deepEqual(parseCandidates(JSON.stringify(result),content,refs),result);
  const extended={...result,candidates:Array.from({length:12},(_,i)=>({...result.candidates[0],title:'知识点 '+i}))};
  assert.equal(parseCandidates(JSON.stringify(extended),content,refs).candidates.length,12);
  for(const change of [r=>r.candidates[0].sourceQuote='并不存在的内容',r=>r.candidates[0].evidence[0].quote='伪造旧知识',r=>r.candidates[0].evidence=[],r=>r.candidates[0].action='publish',r=>r.candidates=Array(2000).fill(r.candidates[0])]) {
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

test('长文完整发送；搜索失败及旧模型配置不得发送正文；失败仍保留导入',async t=>{
  const {imports,library,models,consent,search}=await fixture(t); let calls=0;
  const document=content+'中'.repeat(76000);
  const stub={state:()=>models.state(),generate:async(_input,messages,_signal,timeoutMs)=>{calls++;assert.equal(timeoutMs,600000);assert.equal(JSON.parse(messages[1].content).document,document);return JSON.stringify(result);}};
  const large=await imports.create({...input,base64:Buffer.from(document).toString('base64')});
  const processing=createProcessing(imports,stub,search,library);
  await processing.enqueue(large.id,{...consent,sourceVersion:large.version}); assert.equal((await settled(processing,large.id)).status,'ready'); assert.equal(calls,1);
  const job=await imports.create(input), unavailable=createProcessing(imports,stub,{search:async()=>{throw Error('unavailable');}},library);
  await unavailable.enqueue(job.id,{...consent,sourceVersion:job.version}); assert.equal((await settled(unavailable,job.id)).status,'failed'); assert.equal(calls,1);
  await assert.rejects(processing.enqueue(job.id,{...consent,modelVersion:'stale',sourceVersion:job.version}),{status:409});
  assert.equal((await imports.preview(job.id)).version,job.version);
});

test('再次整理会更新旧提炼规则的结果，同一规则与版本则复用',async t=>{
  const {imports,library,models,consent,search}=await fixture(t); let calls=0;
  const stub={state:()=>models.state(),generate:async()=>{calls++;return JSON.stringify(result);}};
  const processing=createProcessing(imports,stub,search,library),job=await imports.create(input),request={...consent,sourceVersion:job.version};
  await processing.enqueue(job.id,request); const previous=await settled(processing,job.id);
  assert.ok(previous.recipeVersion);
  await processing.enqueue(job.id,request); assert.equal(calls,1);
  const filename=path.join(imports.directory,job.id,'processing.json');
  const old=JSON.parse(await fs.readFile(filename,'utf8')); delete old.recipeVersion; await fs.writeFile(filename,JSON.stringify(old));
  await processing.enqueue(job.id,request); const updated=await settled(processing,job.id);
  assert.equal(updated.status,'ready'); assert.equal(calls,2); assert.notEqual(updated.runId,previous.runId);
  assert.equal((await imports.preview(job.id)).version,job.version);
});

test('明确上下文超限后自动分段及合并，文字无损，合并引文核验且显示真实阶段',async t=>{
  const {imports,library,models,consent,search}=await fixture(t);
  for(const document of ['# 第一章\r\n'+(content+'\r\n').repeat(80)+'\r\n# 第二章\r\n'+'保留输入的适用条件。\r\n'.repeat(160),'甲😀'.repeat(1001)]) {
    const calls=[],leafDocuments=[],phases=[];
    const stub={state:()=>models.state(),generate:async(_input,messages)=>{
      const payload=JSON.parse(messages[1].content); calls.push(payload); phases.push((await processing.state(job.id)).progress.phase);
      if(payload.analyses) return JSON.stringify({summary:'合并后的资料摘要',candidates:payload.analyses.flatMap(item=>item.candidates),questions:[]});
      if(payload.document.length>Math.ceil(document.length*(document.includes('😀')?0.3:0.7))) throw Object.assign(Error('capacity'),{code:'CONTEXT_WINDOW_EXCEEDED'});
      assert.equal(payload.document.isWellFormed(),true); leafDocuments.push(payload.document);
      return JSON.stringify({summary:'分段资料摘要',candidates:[{title:'本段要点',claim:'保留原文观点与适用条件。',sourceQuote:payload.document.includes(content)?content:payload.document.includes('保留输入的适用条件。')?'保留输入的适用条件。':'甲😀',action:'uncertain',reason:'仅为原文观点。',evidence:[]}],questions:[]});
    }};
    const processing=createProcessing(imports,stub,search,library),job=await imports.create({...input,base64:Buffer.from(document).toString('base64')});
    await processing.enqueue(job.id,{...consent,sourceVersion:job.version});
    const ready=await settled(processing,job.id);
    assert.equal(ready.status,'ready',ready.error); assert.equal(calls[0].document,document);
    const partCount=document.includes('😀')?4:2;
    assert.equal(leafDocuments.join(''),document); assert.equal(ready.progress.completedParts,partCount); assert.equal(ready.progress.totalParts,partCount);
    assert.equal(phases[0],'full'); assert.equal(phases.at(-1),'merging'); assert.equal(phases.filter(phase=>phase==='merging').length,partCount-1); assert.equal(ready.result.candidates.length,partCount);
    assert.equal((await imports.preview(job.id)).version,job.version);
  }
});

test('分段或合并失败、取消及版本变化均不采用部分结果；普通失败不重复调用',async t=>{
  const {imports,library,models,consent,search}=await fixture(t);
  const document=(content+'\n').repeat(100);
  for(const mode of ['failed','cancel','changed','merge','quote','timeout']) {
    let calls=0;
    const job=await imports.create({...input,base64:Buffer.from(document).toString('base64')});
    const stub={state:()=>models.state(),generate:async(_input,messages)=>{
      calls++;
      if(mode==='timeout') throw Object.assign(Error('超时'),{status:504});
      const payload=JSON.parse(messages[1].content);
      if(payload.document===document) throw Object.assign(Error('capacity'),{code:'CONTEXT_WINDOW_EXCEEDED'});
      if(calls===2 && mode==='cancel') await processing.cancel(job.id);
      if(calls===2 && mode==='changed') await imports.update(job.id,{version:job.version,target:job.target,card:job.card+'\n手工修改'});
      if(calls===3 && mode==='failed') throw Error('第二段失败');
      if(payload.analyses && mode==='merge') throw Error('合并失败');
      const output=structuredClone(result);
      if(payload.analyses && mode==='quote') output.candidates[0].sourceQuote='不在原文的引文';
      return JSON.stringify(output);
    }};
    const processing=createProcessing(imports,stub,search,library);
    await processing.enqueue(job.id,{...consent,sourceVersion:job.version}); const final=await settled(processing,job.id);
    assert.equal(final.status,mode==='cancel'?'cancelled':'failed',mode); assert.ok(!final.result,mode);
    if(mode==='timeout') assert.equal(calls,1); if(mode==='cancel' || mode==='changed') assert.equal(calls,2);
    const preserved=await imports.preview(job.id); assert.equal(preserved.originalHash,job.originalHash); assert.equal(preserved.card,job.card+(mode==='changed'?'\n手工修改':''));
  }
});

test('页面确认后导入自动触发，取消确认不导入，候选不覆盖未保存编辑',async()=>{
  const nodes=new Map(), requests=[]; let confirm=true, processing;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,events:{},focus(){},addEventListener(name,fn){this.events[name]=fn;},replaceChildren(){},append(){}});return nodes.get(id);};
  const job={id:'fixture',title:'合成资料',version:'v1',stage:'draft',card:'原资料卡',target:'00_资源库/合成/资料',category:'合成',warnings:[],outputs:[]};
  const state={enabled:true,version:'m1',selected:'codex',providers:[{id:'codex',name:'Codex',model:'本地默认',available:true}]};
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
  confirm=true; await node('import-form').events.submit({preventDefault(){}}); assert.equal(processing.confirmed,true); assert.equal(processing.provider,'codex');
  node('import-card').value='手工修改'; node('import-card').events.input(); node('processing-adopt').events.click(); assert.equal(node('import-card').value,'手工修改');
  node('import-card').value=job.card; node('processing-adopt').events.click(); assert.equal(node('import-card').value,'原资料卡\nAI待审候选'); assert.equal(node('import-handoff').hidden,true);
  assert.equal(requests.filter(item=>item.body).length,1,'填入候选不会自动保存或批准');
});
