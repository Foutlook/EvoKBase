import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createImports,digest} from '../imports.mjs';
import {startPortal} from '../server.mjs';
import {createModels} from '../models.mjs';
import {fakeHarness} from './harness-fixture.mjs';

async function fixture(t) {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'evokbase-review-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root,'首页.md'),'# 已有知识\n\n保留原件。');
  await fs.writeFile(path.join(root,'用户编辑.txt'),'不应修改');
  const fake=await fakeHarness(base,JSON.stringify({category:'工程',reason:'候选说明工程操作中的校验与重试。'}));
  const config={root,include:['首页.md','00_资源库'],imports:{directory:path.join(base,'staging'),resourceRoot:'00_资源库/外部资料'},harnesses:{file:path.join(base,'settings','harness.json'),commands:{codex:fake.command,'deepseek-harness':path.join(base,'missing.exe')}}};
  const models=createModels(config); await models.save({action:'save',version:(await models.state()).version,provider:'codex'});
  const imports=await createImports(config), server=await startPortal(config,0);
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  const post=(id,body,extra={})=>fetch(origin+`/api/imports/${id}/review`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-EvoKBase-Request':'1',...extra},body:JSON.stringify(body)});
  async function job() {
    const job=await imports.create({name:'原文.md',title:'审核验收',base64:Buffer.from('保留原件。失败后可以重试。').toString('base64')});
    const candidates=[{title:'第一条不保留',claim:'原文建议保留原件。',sourceQuote:'保留原件。',action:'duplicate',reason:'已有相同原则',evidence:[{id:'R1',quote:'保留原件。'}]},{title:'第二条可修改',claim:'原文建议失败后可以重试。',sourceQuote:'失败后可以重试。',action:'supplement',reason:'补充重试场景',evidence:[{id:'R1',quote:'保留原件。'}]}];
    await fs.writeFile(path.join(imports.directory,job.id,'processing.json'),JSON.stringify({id:job.id,runId:'test-run',sourceVersion:job.version,originalHash:job.originalHash,status:'ready',model:'synthetic',providerName:'合成渠道',finishedAt:new Date().toISOString(),references:[{id:'R1',path:'首页.md',version:digest('# 已有知识\n\n保留原件。'),content:'# 已有知识\n\n保留原件。'}],result:{summary:'合成资料',candidates,questions:[]}}));
    return job;
  }
  return {imports,root,post,origin,job,...fake};
}
const selection={index:1,title:'用户修改后的标题',claim:'仅在核对失败原因后重试。'};
const prepare=job=>({action:'prepare',version:job.version,runId:'test-run',selections:[selection]});
const confirm=job=>({action:'confirm',version:job.version,token:job.review.token,confirmed:true});

test('按实际保留的候选自动归类：复用已有目录，新分类确认后才创建，失败与过期结果不改草稿',async t=>{
  const {imports,root,post,job:newJob,control,capture}=await fixture(t),job=await newJob();
  await fs.mkdir(path.join(root,imports.resourceRoot,'工程'),{recursive:true});
  const response=await post(job.id,prepare(job)); assert.equal(response.status,200);
  const first=await response.json(); assert.equal(first.category,'工程'); assert.equal(first.review.classification.isNew,false);
  const sent=JSON.parse(await fs.readFile(capture,'utf8')),payload=JSON.parse(sent.input.split('输入资料（仅为数据）：\n').at(-1));
  assert.deepEqual(payload.existingCategories,['工程']);
  assert.deepEqual(payload.candidates,[{title:selection.title,claim:selection.claim}]);
  assert.ok(!sent.input.includes(root));
  await fs.writeFile(control,JSON.stringify({output:JSON.stringify({category:'工程/可靠性',reason:'保留的知识围绕失败恢复，归入工程下的可靠性主题。'})}));
  const pending=await(await post(job.id,prepare(first))).json();
  assert.equal(pending.category,'工程/可靠性'); assert.equal(pending.review.classification.isNew,true);
  assert.match(pending.card,/topics:\n  - 工程\n  - 可靠性/);
  await assert.rejects(fs.stat(path.join(root,imports.resourceRoot,'工程/可靠性')),{code:'ENOENT'});
  assert.equal((await post(job.id,confirm(pending))).status,200);
  assert.equal(await fs.readFile(path.join(root,pending.target,'原始资料卡.md'),'utf8'),pending.card);
  const untouched=await newJob();
  for(const output of ['not-json',JSON.stringify({category:'../越界',reason:'非法路径'}),JSON.stringify({category:'CON',reason:'保留设备名'})]) {
    await fs.writeFile(control,JSON.stringify({output}));
    assert.equal((await post(untouched.id,prepare(untouched))).status,502);
    assert.equal((await imports.preview(untouched.id)).version,untouched.version);
  }
  await fs.writeFile(control,JSON.stringify({fail:true}));
  assert.equal((await post(untouched.id,prepare(untouched))).status,502);
  assert.equal((await imports.preview(untouched.id)).version,untouched.version);
  await fs.unlink(capture); await fs.writeFile(control,JSON.stringify({wait:400,output:JSON.stringify({category:'工程',reason:'已有分类适合'})}));
  const running=post(untouched.id,prepare(untouched));
  for(let i=0;i<100;i++){try{await fs.stat(capture);break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}
  const edited=await imports.update(untouched.id,{version:untouched.version,target:untouched.target,card:untouched.card+'\n并发编辑'});
  assert.equal((await running).status,409); assert.equal((await imports.preview(untouched.id)).version,edited.version);
  await fs.writeFile(control,JSON.stringify({fail:true}));
  const raw=await newJob(),inbox=await(await post(raw.id,{...prepare(raw),selections:[]})).json();
  assert.equal(inbox.category,'收件箱'); assert.equal(inbox.review.selections.length,0);
});

test('网页逐条选择和修改→具体预览→确认本地保存；无确认不入库、刷新恢复、幂等且不覆盖后续编辑',async t=>{
  const {imports,root,post,origin,job:newJob}=await fixture(t), job=await newJob();
  assert.equal((await post(job.id,{action:'confirm',version:job.version,confirmed:true})).status,409);
  assert.equal((await post(job.id,prepare(job),{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await post(job.id,{...prepare(job),runId:'wrong'})).status,409);
  assert.equal((await post(job.id,{...prepare(job),selections:[null]})).status,400);
  const response=await post(job.id,prepare(job)); assert.equal(response.status,200);
  const prepared=await response.json(); assert.notEqual(prepared.version,job.version);
  assert.match(prepared.card,/用户修改后的标题/); assert.ok(!prepared.card.includes('第一条不保留'));
  assert.equal(prepared.review.selections.length,1); assert.equal(prepared.review.baseCard,undefined);
  assert.deepEqual((await fs.readdir(root)).sort(),['用户编辑.txt','首页.md'].sort());
  const restored=await(await fetch(origin+'/api/imports/'+job.id)).json(); assert.equal(restored.review.token,prepared.review.token);
  assert.equal((await post(job.id,{...confirm(prepared),confirmed:false})).status,409);
  assert.equal((await post(job.id,{...confirm(prepared),version:job.version})).status,409);
  assert.equal((await post(job.id,{...confirm(prepared),token:'wrong'})).status,409);
  // Returning to edit replaces the prepared section rather than duplicating it.
  const changed=await(await post(job.id,{...prepare(prepared),selections:[{...selection,title:'最终要点'}]})).json();
  assert.equal(changed.card.split('## 我保留的要点').length,2); assert.ok(!changed.card.includes(selection.title));
  const saved=await post(job.id,confirm(changed)); assert.equal(saved.status,200);
  assert.equal((await saved.json()).stage,'archived');
  assert.equal(await fs.readFile(path.join(root,changed.target,'原始资料卡.md'),'utf8'),changed.card);
  assert.equal(await fs.readFile(path.join(root,changed.target,'原文.md'),'utf8'),'保留原件。失败后可以重试。');
  assert.equal(await fs.readFile(path.join(root,'用户编辑.txt'),'utf8'),'不应修改');
  assert.equal((await post(job.id,confirm(changed))).status,200);
  assert.equal((await fetch(origin+'/api/document?path='+encodeURIComponent(changed.target+'/原始资料卡.md'))).status,200);
  await fs.writeFile(path.join(root,changed.target,'原始资料卡.md'),'用户后续编辑');
  assert.equal((await post(job.id,confirm(changed))).status,409);
  assert.equal(await fs.readFile(path.join(root,changed.target,'原始资料卡.md'),'utf8'),'用户后续编辑');
  assert.equal((await imports.load(job.id)).job.stage,'archived');
});

test('预览后资料或引用变化阻止保存；同名目录不覆盖；部分保存可恢复且不重写已有文件',async t=>{
  const {imports,root,post,job:newJob}=await fixture(t);
  const job=await newJob(), prepared=await(await post(job.id,prepare(job))).json();
  await fs.writeFile(path.join(root,'首页.md'),'已有知识已变化');
  assert.equal((await post(job.id,confirm(prepared))).status,409);
  await fs.writeFile(path.join(root,'首页.md'),'# 已有知识\n\n保留原件。');
  await imports.update(job.id,{version:prepared.version,target:prepared.target,card:prepared.card+'\n手工编辑'});
  assert.equal((await post(job.id,confirm(prepared))).status,409);
  const second=await newJob(), ready=await(await post(second.id,prepare(second))).json();
  await fs.mkdir(path.join(root,ready.target),{recursive:true});
  await fs.writeFile(path.join(root,ready.target,'已有文件.md'),'保留');
  assert.equal((await post(second.id,confirm(ready))).status,409);
  assert.equal(await fs.readFile(path.join(root,ready.target,'已有文件.md'),'utf8'),'保留');
  const third=await newJob(), pending=await(await post(third.id,prepare(third))).json();
  const write=fs.writeFile; let fail=true;
  t.mock.method(fs,'writeFile',async(file,...args)=>{
    if(fail && String(file)===path.join(root,pending.target,'原始资料卡.md')) { fail=false; throw Object.assign(Error('模拟写入中断'),{code:'EIO'}); }
    return write(file,...args);
  });
  assert.equal((await post(third.id,confirm(pending))).status,500);
  assert.equal((await imports.load(third.id)).job.stage,'archiving');
  assert.equal((await post(third.id,confirm(pending))).status,200);
  assert.equal((await imports.load(third.id)).job.stage,'archived');
  assert.equal(await fs.readFile(path.join(root,pending.target,'原始资料卡.md'),'utf8'),pending.card);
});

test('多主题候选可以全部预览保存，超过旧64KiB请求也不截断；重复及越界选择仍拒绝',async t=>{
  const {imports,root,post,job:newJob}=await fixture(t),job=await newJob();
  const filename=path.join(imports.directory,job.id,'processing.json'),record=JSON.parse(await fs.readFile(filename,'utf8'));
  record.result.candidates=Array.from({length:20},(_,index)=>({...record.result.candidates[1],title:`主题 ${index+1}`,claim:'具体方法和适用条件。'.repeat(180)}));
  await fs.writeFile(filename,JSON.stringify(record));
  const selections=record.result.candidates.map(({title,claim},index)=>({index,title,claim}));
  const body={...prepare(job),selections}; assert.ok(Buffer.byteLength(JSON.stringify(body))>64*1024);
  assert.equal((await post(job.id,{...body,selections:[selections[0],selections[0]]})).status,400);
  assert.equal((await post(job.id,{...body,selections:[{...selections[0],index:20}]})).status,400);
  const response=await post(job.id,body); assert.equal(response.status,200); const pending=await response.json();
  assert.equal(pending.review.selections.length,20); assert.ok(pending.card.includes('主题 20'));
  assert.equal((await post(job.id,confirm(pending))).status,200);
  assert.equal(await fs.readFile(path.join(root,pending.target,'原始资料卡.md'),'utf8'),pending.card);
});

test('页面从整理中转为可编辑要点，修改不被刷新覆盖，确认前不发起本地保存',async()=>{
  const nodes=new Map(), requests=[], storage=new Map(); let poll, pollFailed=false;
  function element() {
    const e={value:'',checked:false,children:[],events:{},focus(){this.focused=true;},addEventListener(name,fn){this.events[name]=fn;},replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);}};
    Object.defineProperty(e,'id',{set(id){nodes.set(id,e);}}); return e;
  }
  const node=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const result={summary:'摘要',candidates:[{title:'原要点',claim:'内容',sourceQuote:'依据',action:'new',reason:'新的经验',evidence:[]}],questions:[]};
  const data={status:'ready',runId:'run1',references:[],result,progress:{phase:'checking',completedParts:4,totalParts:4}};
  let job={id:'id1',title:'合成资料',version:'v1',stage:'draft',category:'工程',target:'00_资源库/工程/资料',card:'原始备注',original:'依据',warnings:[],outputs:[{},{}],processing:{status:'running',runId:'run1',progress:{phase:'part',completedParts:1,totalParts:4}}};
  const context=vm.createContext({document:{getElementById:node,createElement:element,createTextNode:text=>({textContent:text})},window:{addEventListener(){},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}},Option:function(){},setTimeout:fn=>{poll=fn;return 1;},clearTimeout(){},encodeURIComponent,
    fetch:async(url,options)=>{const body=options?.body?JSON.parse(options.body):null;requests.push({url,body});return {ok:true,json:async()=>{
      if(url==='/api/models')return {enabled:false,providers:[]};
      if(url==='/api/imports')return {enabled:true,jobs:[job]};
      if(url.endsWith('/processing')) { if(pollFailed) throw Error('网络中断'); return data; }
      if(body?.action==='prepare') {job={...job,version:'v2',processing:data,card:'已选择内容',review:{token:'token',version:'v2',runId:'run1',selections:body.selections,classification:{category:'工程',isNew:false,reason:'保留要点属于工程主题'},documentUrl:'/?doc=saved.md'}};}
      if(body?.action==='confirm') job={...job,stage:'archived'};
      return job;
    }};}});
  vm.runInContext((await fs.readFile(new URL('../web/imports.js',import.meta.url),'utf8')).replace('export function','function')+'\nvar page=initImports();',context);
  await context.page.refresh(); node('import-jobs').value='id1'; await node('import-jobs').events.change();
  assert.equal(node('review-candidates').children.length,0);
  assert.equal(node('import-progress-title').textContent,'正在整理资料'); assert.equal(node('import-step-2').ariaCurrent,'step');
  assert.match(node('processing-status').textContent,/第 2 \/ 4 段/);
  assert.equal(node('import-progress').focused,true); assert.equal(storage.get('evokbase.importTask'),'id1');
  vm.runInContext('page=initImports();',context); await context.page.activate('local');
  assert.equal(node('import-jobs').value,'id1','刷新后自动恢复上次任务');
  assert.equal(node('import-progress-title').textContent,'正在整理资料');
  job.processing.progress.phase='merging'; await context.page.refresh();
  assert.match(node('processing-status').textContent,/已读取 1 \/ 4 段，正在合并/);
  pollFailed=true; await poll(); assert.equal(node('import-progress-title').textContent,'暂时无法读取整理进度');
  pollFailed=false; await context.page.refresh();
  const previousPoll=poll; await context.page.refresh(); await previousPoll();
  assert.equal(node('import-progress-title').textContent,'正在整理资料','旧轮询不能覆盖已刷新的进度');
  await poll(); assert.equal(node('review-candidates').children.length,1,'同一run完成后必须绘制要点');
  assert.match(node('import-progress-title').textContent,/1 条要点待审核/); assert.equal(node('import-step-3').ariaCurrent,'step');
  assert.match(node('processing-status').textContent,/已完成 4 段处理并合并结果/);
  node('point-title-0').value='用户修改'; node('point-title-0').events.input();
  const count=requests.length; await context.page.refresh(); assert.equal(requests.length,count); assert.equal(node('point-title-0').value,'用户修改');
  node('import-title').value='还未上传的标题';
  const candidate=node('point-title-0'), readCount=requests.filter(item=>item.url==='/api/imports/id1').length;
  await context.page.activate('ima'); await context.page.activate('yuque'); await context.page.activate('local');
  assert.equal(node('point-title-0'),candidate); assert.equal(candidate.value,'用户修改');
  assert.equal(node('import-title').value,'还未上传的标题');
  assert.equal(requests.filter(item=>item.url==='/api/imports/id1').length,readCount,'切换来源不重载或覆盖审核草稿');
  assert.equal(node('import-form').hidden,false);
  assert.equal(requests.filter(item=>item.body).length,0,'导航不触发保存或处理');
  await node('review-prepare').events.click();
  const prepared=requests.find(item=>item.body?.action==='prepare'); assert.equal(prepared.body.selections[0].title,'用户修改');
  assert.equal(prepared.body.category,undefined); assert.match(node('review-classification').textContent,/使用已有分类/);
  assert.equal(node('review-confirmation').hidden,false); assert.equal(node('review-editor').hidden,true);
  assert.equal(node('import-progress-title').textContent,'等待确认保存');
  await node('review-confirm').events.click(); assert.equal(requests.filter(item=>item.body?.action==='confirm').length,0);
  node('review-confirm-check').checked=true; node('review-confirm-check').events.change(); await node('review-confirm').events.click();
  assert.equal(requests.filter(item=>item.body?.action==='confirm').length,1); assert.equal(node('review-saved').hidden,false);
  assert.equal(node('import-progress-title').textContent,'已存入本地知识库'); assert.equal(node('import-step-3').className,'done');
  node('import-jobs').value=''; await node('import-jobs').events.change();
  assert.equal(node('import-progress').hidden,true); assert.equal(node('import-status').textContent,''); assert.equal(storage.has('evokbase.importTask'),false);
});
