import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createImports,digest} from '../imports.mjs';
import {archiveImport,commitImport,pushImport,parseReceipt,recoverLock} from '../publish.mjs';
import {startPortal} from '../server.mjs';
import {createLibrary} from '../library.mjs';

const exec = promisify(execFile);
test('模板按字面保留输入，多份同名原文通过相对链接准确定位',async t=>{
  const {store,root,config} = await fixture(t);
  const title = "报告 $& $` $' $$ [初稿]", source = "本地 $& $` $' $$ - 获取日期：";
  const job = await store.create({...input,title,source,target:store.resourceRoot+'/测试主题/literal'});
  assert.ok(job.card.includes('title: '+JSON.stringify(title)));
  assert.ok(job.card.includes('# '+title));
  assert.ok(job.card.includes('- 原始路径或 URL：'+source));
  assert.equal(job.card.split('## 原始信息').length,2);
  const second = await store.create({...input,title:'报告[初稿]'});
  assert.equal(second.stage,'draft');
  for(const item of [job,second]) {
    await fs.mkdir(path.join(root,item.target),{recursive:true});
    await fs.writeFile(path.join(root,item.target,'原文.md'),'# 原件');
    await fs.writeFile(path.join(root,item.target,'原始资料卡.md'),item.card);
  }
  const page = await (await createLibrary(config)).document(job.target+'/原始资料卡.md');
  const references = page.links.filter(link=>link.raw.startsWith('./原文'));
  assert.equal(references.length,2);
  assert.ok(references.every(link=>link.status==='resolved' && link.path===job.target+'/原文.md'));
});
test('未保存导入草稿保留在页面，刷新和切换不能覆盖', async () => {
  const nodes = new Map(), listeners = {}, requests = [];
  let finishSave, finishLoad, delayLoad = false;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id,{value:'',events:{},addEventListener(name,fn){this.events[name]=fn;},replaceChildren(){},append(){}});
    return nodes.get(id);
  };
  const job = {id:'sample',title:'样本',stage:'draft',version:'v1',target:'00_资源库/外部资料/样本',card:'原草稿',warnings:[],outputs:[]};
  const context = vm.createContext({document:{getElementById:node},window:{addEventListener(name,fn){listeners[name]=fn;}},Option:function(){},fetch:async (url,options)=>{
    requests.push(url);
    if(options?.method==='POST') return new Promise(resolve=>{finishSave=resolve;});
    if(delayLoad) return new Promise(resolve=>{finishLoad=resolve;});
    return {ok:true,json:async()=>url==='/api/imports'?{enabled:true,jobs:[job]}:job};
  }});
  const source = (await fs.readFile(new URL('../web/imports.js',import.meta.url),'utf8')).replace('export function','function');
  vm.runInContext(source+'\nvar page = initImports();',context);
  node('import-jobs').value = job.id; await node('import-jobs').events.change();
  node('import-card').value = '未保存的修改'; node('import-card').events.input();
  const count = requests.length;
  await context.page.refresh();
  node('import-jobs').value = ''; await node('import-jobs').events.change();
  assert.equal(requests.length,count); assert.equal(node('import-card').value,'未保存的修改');
  assert.equal(node('import-jobs').value,job.id); assert.equal(node('import-handoff').hidden,true);
  let warned = false; listeners.beforeunload({preventDefault(){warned=true;}}); assert.equal(warned,true);
  const saving = node('import-save').events.click();
  assert.equal(node('import-card').disabled,true); assert.equal(node('import-jobs').disabled,true);
  finishSave({ok:true,json:async()=>({...job,card:'未保存的修改',version:'v2'})}); await saving;
  assert.equal(node('import-card').disabled,false);
  delayLoad = true; node('import-jobs').value = 'other'; const loading = node('import-jobs').events.change();
  node('import-card').value = '切换中输入'; node('import-card').events.input();
  finishLoad({ok:true,json:async()=>({...job,id:'other'})}); await loading;
  assert.equal(node('import-card').value,'切换中输入'); assert.equal(node('import-jobs').value,job.id);
});
async function fixture(t,gitRepository=false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(),'evokbase-import-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root = path.join(base,'vault'), directory = path.join(base,'tasks');
  await fs.mkdir(root); await fs.writeFile(path.join(root,'首页.md'),'# 测试知识库');
  const config = {root,include:['首页.md','00_资源库'],imports:{directory,resourceRoot:'00_资源库/外部资料'}};
  const git = async(...args)=>(await exec('git',args,{cwd:root,windowsHide:true,encoding:'utf8'})).stdout.trimEnd();
  if (gitRepository) {
    const remote = path.join(base,'remote.git');
    await exec('git',['init','--bare','--initial-branch=main',remote],{windowsHide:true});
    await git('init','--initial-branch=main'); await git('config','user.name','隔离验收'); await git('config','user.email','test@example.invalid');
    await git('config','core.autocrlf','false'); await git('add','--','首页.md'); await git('commit','-m','创建隔离验收库');
    await git('remote','add','fixture',remote); await git('push','fixture','main:main');
    config.imports.publish={remote:'fixture',remoteUrl:remote};
  }
  return {base,root,config,git,store:await createImports(config)};
}
const input = {name:'中文 样本.md',title:'导入样本',category:'测试主题',source:'https://example.invalid/source',base64:Buffer.from('# 隔离样本\r\n\r\n|列|值|\r\n|---|---|\r\n|内容|测试|\r\n\r\n<script>bad()</script>\r\n\r\n![附件](missing.png)').toString('base64')};
const approve = job=>({taskId:job.id,version:job.version,decision:'approved',scope:'archive',reviewedBy:'测试审核人',reviewRef:'隔离测试的显式审核记录'});

test('分类沿用真实目录，切换同步路径与主题，未分类及越界不能交接发布',async t=>{
  const {store,root,config} = await fixture(t,true);
  await fs.mkdir(path.join(root,store.resourceRoot,'已有分类','资料','images'),{recursive:true});
  await fs.writeFile(path.join(root,store.resourceRoot,'已有分类','资料','原始资料卡.md'),'# 已有资料');
  assert.deepEqual(await store.categories(),['已有分类']);
  const empty = await store.create({...input,category:''});
  await assert.rejects(store.handoff(empty.id),{status:409});
  await assert.rejects(commitImport(store,config,empty.id,approve(empty)),{status:409});
  const job = await store.create({...input,category:'工程/运行时'});
  assert.equal(job.category,'工程/运行时');
  assert.ok(job.target.startsWith(store.resourceRoot+'/工程/运行时/'));
  assert.match(job.card,/topics:\n  - 工程\n  - 运行时/);
  const changed = await store.update(job.id,{version:job.version,category:'基础/二进制',target:store.resourceRoot+'/基础/二进制/'+job.target.split('/').at(-1),card:job.card.replace('  - 运行时','  - 运行时\n  - 自选标签')});
  assert.match(changed.card,/topics:\n  - 基础\n  - 二进制\n  - 自选标签/);
  assert.ok(!changed.card.includes('  - 运行时')); assert.notEqual(job.version,changed.version);
  assert.match(await store.handoff(job.id),/基础\/二进制/);
  await assert.rejects(commitImport(store,config,job.id,approve(job)),{status:409});
  for(const category of ['../越界','分类/.hidden','分类/CON','分类//空']) await assert.rejects(store.create({...input,category}),{status:400});
  await assert.rejects(store.update(job.id,{version:changed.version,target:changed.target,category:'不一致',card:changed.card}),{status:400});
  await assert.rejects(store.update(job.id,{version:changed.version,target:changed.target,card:changed.card.replace(/topics:[\s\S]*?projects:/,'topics: 非列表\nprojects:')}),{status:400});
  await assert.rejects(store.update(job.id,{version:changed.version,target:changed.target,card:'---\n- item\n---\n# 错误文件头'}),{status:400});
  assert.equal((await store.preview(job.id)).version,changed.version);
});

test('导入只写独立暂存，原件字节不变、草稿版本绑定路径、失败与篡改可见',async t=>{
  const {config,store,root,base} = await fixture(t);
  const job = await store.create(input);
  assert.equal(job.stage,'draft'); assert.equal(job.originalHash,digest(Buffer.from(input.base64,'base64')));
  assert.match(job.card,/type: source/); assert.match(job.card,/status: unread/); assert.match(job.card,/未开展知识提炼/);
  assert.ok(!job.html.includes('<script>')); assert.ok(job.warnings.some(x=>x.includes('missing.png')));
  assert.deepEqual(await fs.readdir(root),['首页.md']);
  assert.equal((await store.list()).length,1); assert.match(await store.handoff(job.id),new RegExp(job.version));
  const changed = await store.update(job.id,{version:job.version,target:config.imports.resourceRoot+'/调整路径',card:job.card+'\n待核对备注'});
  assert.notEqual(changed.version,job.version);
  await assert.rejects(store.update(job.id,{version:job.version,target:job.target,card:job.card}),{status:409});
  for(const target of ['../outside','00_资源库/外部资料/../逃逸','00_资源库/外部资料/.hidden','00_资源库/外部资料/name:stream','00_资源库/外部资料/CON','00_资源库/外部资料/[broken]']) await assert.rejects(store.update(job.id,{version:changed.version,target,card:job.card}),{status:400});
  await assert.rejects(store.create({...input,name:'other.doc'}),{status:400});
  await assert.rejects(store.create({...input,base64:'/w=='}),{status:422});
  await assert.rejects(store.create({...input,base64:'not base64'}),{status:400});
  await assert.rejects(store.create({...input,base64:Buffer.from('---\nslug: old/location\n---\n# 文档').toString('base64')}),{status:422});
  await assert.rejects(createImports({...config,imports:{...config.imports,directory:path.join(root,'drafts')}}));
  await fs.writeFile(path.join(store.directory,job.id,'original.md'),'changed');
  await assert.rejects(store.preview(job.id),{status:409});
  const outside = path.join(base,'outside'); await fs.mkdir(outside);
  await fs.symlink(outside,path.join(base,'link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(createImports({...config,imports:{...config.imports,directory:path.join(base,'link')}}),{status:409});
});

async function formatSamples(base) {
  const directory = path.join(base,'samples');
  await exec('python',['-I',fileURLToPath(new URL('./format_samples.py',import.meta.url)),directory],{windowsHide:true});
  return async name=>({name,category:'测试主题',base64:(await fs.readFile(path.join(directory,name))).toString('base64')});
}
test('DOCX/PDF 保留原件、表格和位置，扫描/空白页可见，全部产物绑定版本',async t=>{
  const {store,root,base,config} = await fixture(t), sample = await formatSamples(base);
  const word = await store.create(await sample('sample.docx'));
  assert.equal(word.format,'docx'); assert.equal(word.outputs.length,4);
  assert.match(word.original,/# 中文格式验收/); assert.match(word.html,/<table(?:\s|>)/);
  assert.match(word.original,/来源：正文块 3/); assert.match(word.original,/页码不可用/);
  assert.ok(word.original.indexOf('第一段')<word.original.indexOf('样本')); assert.ok(word.original.indexOf('样本')<word.original.indexOf('末段'));
  assert.ok(!word.html.includes('<script>'));
  assert.match(word.original,/正文块 6.*文本框 1/);
  assert.ok(word.original.includes('        if (value < 9) {\n            System.gc();\n        }'));
  assert.match(word.html,/<pre><code>[\s\S]*System.gc\(\);/);
  assert.match(word.html,/\/api\/imports\/.+\/file\?path=images/);
  assert.equal(digest(await store.readFile(word.id,'原文.docx')),word.originalHash);
  assert.deepEqual(await store.readFile(word.id,'images/0001.png'),await fs.readFile(path.join(base,'samples','expected.png')));
  const pdf = await store.create(await sample('sample.pdf'));
  assert.match(pdf.original,/## 第 4 页/); assert.match(pdf.original,/TEXT PAGE TITLE[\s\S]*First paragraph[\s\S]*Name\s+Value[\s\S]*Sample\s+2/);
  assert.ok(pdf.warnings.some(w=>w.includes('第 2 页')&&w.includes('OCR')));
  assert.ok(pdf.warnings.some(w=>w.includes('第 3 页')&&w.includes('OCR')));
  assert.ok(pdf.warnings.some(w=>w.includes('图片未识别')));
  assert.equal(digest(await store.readFile(pdf.id,'原文.pdf')),pdf.originalHash);
  const partial = await store.create(await sample('partial.pdf'));
  assert.ok(partial.warnings.some(w=>w.includes('第 5 页')&&w.includes('文字提取失败')));
  assert.match(partial.original,/TEXT PAGE TITLE[\s\S]*## 第 5 页[\s\S]*本页文字提取失败/);
  assert.deepEqual(await fs.readdir(root),['首页.md']);
  const changed = await store.update(word.id,{version:word.version,target:word.target+'-new',card:word.card+'\n核对中'});
  assert.notEqual(changed.version,word.version); assert.match(await store.handoff(word.id),/content.md/);
  for (const file of (await store.load(word.id)).artifacts) {
    await fs.mkdir(path.dirname(path.join(root,file.path)),{recursive:true}); await fs.writeFile(path.join(root,file.path),file.bytes);
  }
  const page = await (await createLibrary(config)).document(changed.target+'/解析正文.md');
  assert.ok(page.links.every(link=>link.status==='resolved'));
  await fs.appendFile(path.join(store.directory,word.id,'images','0001.png'),'tamper');
  await assert.rejects(store.preview(word.id),{status:409});
  await assert.rejects(store.create(await sample('encrypted.pdf')),{status:422});
  for (const name of ['broken.docx','broken.pdf']) await assert.rejects(store.create({name,base64:Buffer.from('broken').toString('base64')}),{status:422});
  await assert.rejects(store.readFile(pdf.id,'../job.json'),{status:404});
  const unavailable = await createImports({...config,imports:{...config.imports,python:'evokbase-no-such-python'}});
  await assert.rejects(unavailable.create(await sample('sample.pdf')),{status:422});
  assert.equal((await unavailable.create(input)).stage,'draft');
});

test('多产物隔离发布恢复逐份核对原件、正文、图片，拒绝旧审核版本',async t=>{
  const {store,config,root,base,git} = await fixture(t,true), sample = await formatSamples(base);
  const first = await store.create(await sample('sample.docx'));
  const job = await store.update(first.id,{version:first.version,target:first.target,card:first.card+'\n已核对合成样本'});
  await assert.rejects(commitImport(store,config,job.id,approve(first)),{status:409});
  const loaded = (await store.load(job.id)).job; loaded.base=await git('rev-parse','HEAD'); loaded.stage='writing'; await store.save(loaded);
  await fs.mkdir(path.join(root,job.target),{recursive:true});
  await fs.writeFile(path.join(root,job.target,'原文.docx'),await store.readFile(job.id,'原文.docx'));
  const committed = await commitImport(store,config,job.id,approve(job));
  const {artifacts} = await store.load(job.id);
  for(const file of artifacts) assert.equal(digest(await fs.readFile(path.join(root,file.path))),file.sha256);
  const commit = committed.commit; delete committed.commit; committed.stage='files_written'; await store.save(committed);
  assert.equal((await commitImport(store,config,job.id,approve(job))).commit,commit);
  assert.equal((await pushImport(store,config,job.id,approve(job))).stage,'pushed');
  assert.equal(await git('status','--porcelain'),'');
  const names = (await git('diff-tree','--no-commit-id','--name-only','-r','-z',commit)).split('\0').filter(Boolean);
  assert.equal(names.length,job.outputs.length);
});

test('暂存附件仅能读取本任务清单，HTTP 原件字节一致，禁用格式不能执行',async t=>{
  const {config,base} = await fixture(t), sample = await formatSamples(base), server = await startPortal(config,0);
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin = 'http://127.0.0.1:'+server.address().port, upload = await sample('sample.docx');
  const response = await fetch(origin+'/api/imports',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-EvoKBase-Request':'1'},body:JSON.stringify(upload)});
  assert.equal(response.status,200); const job = await response.json();
  const file = await fetch(origin+job.originalUrl);
  assert.match(file.headers.get('content-disposition'),/attachment/); assert.equal(digest(Buffer.from(await file.arrayBuffer())),job.originalHash);
  const image = await fetch(origin+`/api/imports/${job.id}/file?path=images%2F0001.png`);
  assert.equal(image.headers.get('content-type'),'image/png'); assert.equal(image.status,200);
  for (const name of ['job.json','draft.md','../sample.docx','images/../../outside','unknown.svg']) assert.equal((await fetch(origin+`/api/imports/${job.id}/file?path=`+encodeURIComponent(name))).status,404);
});

test('网页暂存专用同源入口，不能调用批准、Git或任意路径写入',async t=>{
  const {config,root} = await fixture(t), server = await startPortal(config,0);
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = 'http://127.0.0.1:'+server.address().port;
  const options = {method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-EvoKBase-Request':'1'},body:JSON.stringify(input)};
  assert.equal((await fetch(base+'/api/imports',{...options,headers:{...options.headers,Origin:'https://example.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/imports',{...options,headers:{'Content-Type':'application/json'}})).status,403);
  const created = await fetch(base+'/api/imports',options); assert.equal(created.status,200);
  const job = await created.json(); assert.equal((await (await fetch(base+'/api/imports')).json()).jobs.length,1);
  const handoff = await fetch(base+'/api/imports/'+job.id+'/handoff'); assert.match(handoff.headers.get('content-disposition'),/attachment/);
  assert.match(await handoff.text(),/"decision": "pending"/);
  assert.equal((await fetch(base+'/api/imports/'+job.id+'/publish',options)).status,405);
  assert.equal((await fetch(base+'/api/imports/../outside',options)).status,405);
  assert.deepEqual(await fs.readdir(root),['首页.md']);
  assert.equal((await fetch(base+'/api/tree')).status,200);
});

test('确认前不写正式库，拒绝无关修改和待推送提交，精确发布到隔离远端且幂等恢复',async t=>{
  const {config,store,root,git} = await fixture(t,true);
  const job = await store.create(input), approval = approve(job), base = await git('rev-parse','HEAD');
  await assert.rejects(commitImport(store,config,job.id,{...approval,decision:'pending'}),{status:409});
  await fs.writeFile(path.join(root,'无关.md'),'其他修改'); await git('add','--','无关.md');
  await assert.rejects(commitImport(store,config,job.id,approval),{status:409});
  assert.match(await git('diff','--cached','--name-only','-z'),/无关/);
  assert.equal(await git('rev-parse','HEAD'),base);
  await git('commit','-m','隔离的其他工作');
  await assert.rejects(commitImport(store,config,job.id,approval),{status:409});
  await git('push','fixture','main:main');
  assert.equal((await archiveImport(store,job.id,approval)).stage,'archived');
  const committed = await commitImport(store,config,job.id,approval);
  assert.equal(committed.stage,'committed');
  assert.equal(await git('status','--porcelain'),'');
  for (const [index,file] of store.outputPaths(committed).entries()) assert.equal(digest(await fs.readFile(path.join(root,file))),index?job.cardHash:job.originalHash);
  assert.equal((await commitImport(store,config,job.id,approval)).commit,committed.commit);
  // Simulate interruption after git commit but before the task receipt persisted.
  delete committed.commit; committed.stage='files_written'; await store.save(committed);
  const recovered = await commitImport(store,config,job.id,approval);
  assert.equal(recovered.commit,await git('rev-parse','HEAD'));
  await git('config','--add','remote.fixture.pushurl',config.imports.publish.remoteUrl);
  await git('config','--add','remote.fixture.pushurl',path.join(store.directory,'unexpected.git'));
  await assert.rejects(pushImport(store,config,job.id,approval),{status:409});
  await git('config','--unset-all','remote.fixture.pushurl');
  assert.equal((await pushImport(store,config,job.id,approval)).stage,'pushed');
  const count = await git('rev-list','--count','HEAD');
  assert.equal((await pushImport(store,config,job.id,approval)).stage,'pushed');
  assert.equal(await git('rev-list','--count','HEAD'),count);
  assert.match(await git('ls-remote','fixture','refs/heads/main'),new RegExp(recovered.commit));
});

test('同名目录不覆盖，写入中断可恢复，用户后续改动和活进程锁受保护',async t=>{
  const {config,store,root,git} = await fixture(t,true);
  const job = await store.create(input), approval = approve(job);
  await fs.mkdir(path.join(root,job.target),{recursive:true});
  await assert.rejects(commitImport(store,config,job.id,approval),{status:409});
  await fs.rmdir(path.join(root,job.target));
  const loaded = (await store.load(job.id)).job; loaded.base=await git('rev-parse','HEAD'); loaded.stage='writing'; await store.save(loaded);
  await fs.mkdir(path.join(root,job.target),{recursive:true});
  await fs.writeFile(path.join(root,store.outputPaths(job)[0]),Buffer.from(input.base64,'base64'));
  const committed = await commitImport(store,config,job.id,approval); assert.equal(committed.stage,'committed');
  await fs.appendFile(path.join(root,store.outputPaths(job)[0]),'\n用户后续编辑');
  await assert.rejects(pushImport(store,config,job.id,approval),{status:409});
  assert.match(await fs.readFile(path.join(root,store.outputPaths(job)[0]),'utf8'),/用户后续编辑/);
  const lock = path.join(store.directory,'.import.lock'), bytes = JSON.stringify({pid:process.pid}); await fs.writeFile(lock,bytes);
  await assert.rejects(store.create(input),{status:409});
  await assert.rejects(recoverLock(store,digest(bytes)),{status:409});
  assert.equal(await fs.readFile(lock,'utf8'),bytes);
  const sha = 'a'.repeat(40), receipt = {requested_sha:sha,actual_sha:sha,last_success_sha:sha,stage:'complete',status:'success',index_may_be_partial:false,counts:{coverage:100}};
  assert.deepEqual(parseReceipt('noise\n2026-01-01 '+JSON.stringify(receipt)+'\n',sha),receipt);
  for (const change of [{requested_sha:'b'.repeat(40)},{index_may_be_partial:true},{counts:{coverage:99}},{status:'failed'},{last_success_sha:'b'.repeat(40)}]) assert.throws(()=>parseReceipt(JSON.stringify({...receipt,...change}),sha),{status:409});
  assert.throws(()=>parseReceipt('no receipt'),{status:409});
});
