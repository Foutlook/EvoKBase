import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createIma,requestIma} from '../ima.mjs';
import {createImports,digest} from '../imports.mjs';
import {startPortal} from '../server.mjs';
import {downloadIma} from '../ima-download.mjs';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';

const auth={clientId:'test-client',apiKey:'test-secret'};
async function fixture(t) {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'evokbase-ima-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root,'首页.md'),'# 测试');
  const config={root,include:['首页.md','00_资源库'],imports:{directory:path.join(base,'drafts'),resourceRoot:'00_资源库/外部资料'}};
  return {root,config,store:await createImports(config)};
}
test('IMA 只读协议：固定域名、凭据隔离、响应限制及失败不透出上游内容',async t=>{
  const result=await requestIma(auth,'search_note',{start:0,end:20},undefined,async(url,options)=>{
    assert.equal(url,'https://ima.qq.com/openapi/note/v1/search_note');
    assert.equal(options.redirect,'error'); assert.equal(options.headers['ima-openapi-apikey'],auth.apiKey);
    assert.ok(!options.body.includes(auth.apiKey));
    return Response.json({code:0,data:{search_note_infos:[],is_end:true}});
  });
  assert.equal(result.is_end,true);
  for(const response of [Response.json({code:20004,msg:auth.apiKey}),Response.json({code:210006,msg:auth.apiKey}),new Response(auth.apiKey,{status:401}),new Response(auth.apiKey),Response.json({code:0}),new Response('x'.repeat(8*1024*1024+1))]) {
    await assert.rejects(requestIma(auth,'get_doc_content',{},undefined,async()=>response),error=>error.status===502 && !error.message.includes(auth.apiKey));
  }
  await assert.rejects(requestIma(auth,'import_doc',{},undefined,()=>assert.fail('不能写入 IMA')),{status:400});
  await assert.rejects(requestIma(auth,'search_note',{},undefined,async()=>{throw Error('network '+auth.apiKey);}),/不可用/);
  const controller=new AbortController(); controller.abort();
  await assert.rejects(requestIma(auth,'search_note',{},controller.signal,async(url,options)=>{options.signal.throwIfAborted();}),/取消/);
  t.mock.method(AbortSignal,'timeout',milliseconds=>{assert.equal(milliseconds,30000); return AbortSignal.abort(new DOMException('Timeout','TimeoutError'));});
  await assert.rejects(requestIma(auth,'search_note',{},undefined,async(url,options)=>{options.signal.throwIfAborted();}),/超时/);
});

test('选择单篇后保留纯文本、来源与哈希，现有审核路径适用且旧记录不变',async t=>{
  const {store,root}=await fixture(t); const calls=[];
  const content='---\nslug: 原样保留\n---\n# 文本标题\n```\n<script>bad()</script>\n![图](https://example.invalid/p.png)\n[[不存在]]\n中文 🌸';
  let activeAuth=auth;
  const ima=createIma(store,{loadCredentials:async()=>activeAuth,request:async(a,method,body)=>{
    calls.push({method,body});
    if(method==='search_note') return {search_note_infos:[{note_book_info:{note_id:'note-one',title:'标题 `\n中文',modify_time:'1780000000000'}},{note_book_info:{note_id:'unmatched',title:'不相关'}}],is_end:body.start>=20};
    assert.deepEqual(body,{note_id:'note-one',target_content_format:0}); return {content};
  }});
  assert.deepEqual(await ima.state(),{enabled:true,configured:true}); assert.equal(calls.length,0);
  await assert.rejects(ima.run({action:'search',query:'',start:0}),{status:400});
  await assert.rejects(ima.run({action:'import',token:'arbitrary'}),{status:409}); assert.equal(calls.length,0);
  const page=await ima.run({action:'search',query:'标题',start:20});
  assert.equal(page.items.length,1); assert.match(page.notice,/过滤/);
  assert.equal(page.isEnd,true); assert.deepEqual(calls[0].body,{search_type:0,query_info:{title:'标题'},start:20,end:40});
  assert.ok(!JSON.stringify(page).includes('note-one')); assert.equal(calls.length,1);
  activeAuth={...auth,clientId:'other'};
  await assert.rejects(ima.run({action:'import',token:page.items[0].token}),{status:409});
  activeAuth=auth;
  const job=await ima.run({action:'import',token:page.items[0].token,category:'测试/IMA'});
  assert.equal(job.stage,'draft'); assert.equal(job.format,'txt'); assert.equal(job.originalHash,digest(Buffer.from(content)));
  assert.equal((await store.readFile(job.id,'原文.txt')).toString(),content);
  assert.equal(job.remoteSource.noteId,'note-one'); assert.equal(job.remoteSource.clientIdHash,digest(auth.clientId));
  assert.ok(job.card.includes('plaintext')); assert.ok(!job.card.includes(auth.apiKey));
  assert.ok(job.html.includes('&lt;script&gt;')); assert.ok(!job.html.includes('<img')); assert.ok(!job.html.includes('<script>'));
  assert.ok(job.warnings.some(value=>value.includes('附件')));
  assert.match(await store.handoff(job.id),/original.txt/);
  assert.deepEqual(await fs.readdir(root),['首页.md']);
  await assert.rejects(ima.run({action:'import',token:page.items[0].token,category:'测试'}),{status:409});
  const edited=await store.update(job.id,{version:job.version,target:job.target,card:job.card+'\n核对中',category:job.category});
  assert.notEqual(edited.version,job.version);
  const record=path.join(store.directory,job.id,'job.json'), saved=JSON.parse(await fs.readFile(record,'utf8'));
  saved.remoteSource.noteId='changed'; await fs.writeFile(record,JSON.stringify(saved));
  await assert.rejects(store.load(job.id),{status:409});
  await assert.rejects(store.create({name:'fake.txt',base64:Buffer.from('fake').toString('base64'),remoteSource:job.remoteSource}),{status:400});
  activeAuth=null; assert.equal((await ima.state()).configured,false);
  await assert.rejects(ima.run({action:'search',query:'标题',start:0}),{status:503});
});

test('IMA 入口要求同源显式操作，响应不暴露凭据，配置缺失不阻断浏览',async t=>{
  const {config}=await fixture(t); const server=await startPortal(config,0); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(url+'/api/tree')).status,200);
  const state=await (await fetch(url+'/api/ima')).json(); assert.deepEqual(Object.keys(state).sort(),['configured','enabled']);
  assert.equal((await fetch(url+'/api/ima',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/ima',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.invalid','X-EvoKBase-Request':'1'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/ima',{method:'POST',headers:{'Content-Type':'application/json',Origin:url,'X-EvoKBase-Request':'1'},body:JSON.stringify({x:'x'.repeat(17000)})})).status,413);
});

test('IMA 页面仅显式搜索和选择后导入，翻页不会预读正文且未保存草稿受保护',async()=>{
  const nodes=new Map(), requests=[];
  let updateJob;
  const node=id=>{
    if(!nodes.has(id)) nodes.set(id,{value:'',events:{},children:[],addEventListener(name,fn){this.events[name]=fn;},replaceChildren(...children){this.children=children; this.value=children[0]?.value??'';},append(...children){this.children.push(...children);},focus(){}});
    return nodes.get(id);
  };
  const job={id:'draft',title:'笔记',stage:'draft',version:'v1',target:'00_资源库/外部资料/测试/笔记',category:'测试',card:'资料卡',warnings:[],outputs:[],remoteSource:{platform:'ima',kind:'note'}};
  const context=vm.createContext({document:{getElementById:node,createElement:()=>node(Symbol())},window:{addEventListener(){}},Option:function(text,value){this.text=text;this.value=value;},fetch:async(url,options)=>{
    const body=options?.body?JSON.parse(options.body):null; requests.push({url,body});
    let data=url==='/api/imports'?{enabled:true,jobs:[job,...(updateJob?[updateJob]:[])]}:url==='/api/imports/update'?updateJob:job;
    if(url==='/api/ima') {
      data={enabled:true,configured:true};
      if(body?.action==='search') data={items:[{title:'笔记',token:'selection'}],isEnd:body.start===20,start:body.start};
      if(body?.action==='import') data=job;
      if(body?.action==='check-update') data=updateJob?{changed:true,reused:false,job:updateJob,comparison:{localChanges:[{path:'旧目录/原文.md',status:'modified'}],...(body.token?{metadataFields:['title'],changes:{content:false,metadata:[{field:'title',before:'旧标题',after:'新标题'}]}}:{})}}:{changed:false,comparison:{localChanges:[]}};
      if(body?.action==='libraries') data={items:[{title:'个人收藏',baseType:'个人知识库',token:'personal'}],nextToken:null};
      if(body?.action==='knowledge') data={items:[{title:'个人文件',kind:'media',token:'file'},{title:'目录',kind:'folder',token:'folder'}],nextToken:'next',scope:'个人收藏'};
      if(body?.action==='page') data={items:[{title:'第二页',kind:'media',token:'file2'}],nextToken:null,scope:'个人收藏'};
    }
    return {ok:true,json:async()=>data};
  }});
  const code=(await fs.readFile(new URL('../web/imports.js',import.meta.url),'utf8')).replace('export function','function');
  vm.runInContext(code+'\nvar page=initImports("ima");',context);
  await context.page.refresh(); assert.ok(requests.every(item=>!item.body));
  assert.equal(node('import-form').hidden,true);
  node('ima-query').value='笔记'; await node('ima-form').events.submit({preventDefault(){}});
  await node('ima-next').events.click(); assert.equal(requests.at(-1).body.start,20); assert.equal(node('ima-next').disabled,true);
  assert.equal(node('ima-results').children[0].children[0].type,'radio');
  assert.equal(node('ima-results').children[0].children[1].children[0].textContent,'笔记');
  node('ima-results').events.change({target:{value:'selection'}}); node('ima-category').value='测试';
  await node('ima-import').events.click(); assert.equal(requests.filter(item=>item.body?.action==='import').length,1);
  assert.equal(node('import-download').textContent,'下载接口纯文本快照（不含附件）');
  await node('import-check-update').events.click();
  assert.deepEqual(requests.at(-1).body,{action:'check-update',id:'draft',version:'v1'});
  assert.match(node('import-update-status').textContent,/内容未变化/);
  updateJob={...job,id:'update',version:'v2',original:'更新后',previousSnapshot:{id:'draft',version:'v1',currentVersion:'v1',original:'更新前 <script>bad()</script>'},remoteSource:{...job.remoteSource,updateOf:{localChanges:[]}}};
  await node('import-check-update').events.click();
  assert.equal(node('import-jobs').value,'update'); assert.equal(node('import-previous').hidden,false);
  assert.equal(node('import-previous-text').textContent,'更新前 <script>bad()</script>');
  assert.match(node('import-update-status').textContent,/被编辑或缺失/);
  node('import-card').value='未保存'; const count=requests.length;
  await node('import-check-update').events.click(); assert.equal(requests.length,count);
  await node('ima-form').events.submit({preventDefault(){}}); assert.equal(requests.length,count);
  node('ima-query').events.input(); assert.equal(node('ima-next').disabled,true); assert.equal(node('ima-import').disabled,true);
  node('import-card').value=job.card;
  node('ima-source').value='knowledge'; node('ima-source').events.change(); assert.equal(node('ima-knowledge').hidden,false);
  await node('ima-libraries-load').events.click(); assert.equal(node('ima-library').children[1].text,'个人收藏 · 个人知识库');
  node('ima-library').value='personal'; node('ima-library').events.change(); node('ima-query').value='';
  await node('ima-form').events.submit({preventDefault(){}}); assert.equal(requests.at(-1).body.token,'personal');
  await node('ima-next').events.click(); assert.equal(requests.at(-1).body.token,'next'); assert.equal(node('ima-next').disabled,true);
  await node('ima-prev').events.click(); assert.equal(requests.at(-1).body.action,'knowledge');
  node('ima-results').events.change({target:{value:'folder'}}); assert.equal(node('ima-import').textContent,'打开文件夹 →');
  await node('ima-import').events.click(); assert.equal(requests.at(-1).body.token,'folder');
  await node('ima-root').events.click(); assert.equal(requests.at(-1).body.token,'personal');
  node('ima-results').events.change({target:{value:'file'}}); assert.equal(node('ima-import').disabled,false);
  await node('import-check-update').events.click();
  assert.equal(requests.findLast(item=>item.body?.action==='check-update').body.token,'file');
  assert.match(node('import-update-status').textContent,/标题：旧标题 → 新标题/);
  assert.match(node('import-update-status').textContent,/原件字节未变化/);
  node('ima-query').events.input(); assert.equal(node('ima-import').disabled,true); assert.equal(node('ima-results').children.length,0);
  requests.length=0;
  vm.runInContext('var localPage=initImports("local");',context);
  await context.localPage.refresh(); assert.equal(node('import-form').hidden,false);
  assert.ok(requests.every(item=>item.url!=='/api/ima'),'本地导入页不请求 IMA');
});

test('个人知识库字段兼容、服务端游标绑定、文件夹、原文件和网页安全暂存',async t=>{
  const {store,root,config}=await fixture(t), calls=[], downloads=[];
  let mediaType=7, denied=false, activeAuth=auth;
  const markdown=Buffer.from('# 个人收藏\n\n正文，不是搜索片段。');
  const html=Buffer.from('<!doctype html><html><head><script>steal()</script></head><body><h1>个人网页</h1><p>正文 &amp; 中文</p><style>bad()</style><img src="https://example.invalid/x"><p>```\n[[伪链接]]</p></body></html>');
  const ima=createIma(store,{loadCredentials:async()=>activeAuth,request:async(a,method,body)=>{
    calls.push({method,body});
    if(method==='search_knowledge_base') return {info_list:body.cursor?[{id:'shared',name:'订阅资料'}]:[{kb_id:'personal',kb_name:'我的收藏',base_type:'个人知识库'}],is_end:!!body.cursor,next_cursor:body.cursor?'':'library-next'};
    if(method==='get_knowledge_list') return {knowledge_list:body.cursor?[{folder_id:'folder-a',name:'子文件夹'}]:[{media_id:'media-one',title:'个人收藏',parent_folder_id:body.folder_id||''}],is_end:!!body.cursor || !!body.folder_id,next_cursor:'page-next'};
    if(method==='search_knowledge') return {info_list:body.query==='不存在'?[]:[{media_id:'media-one',title:'个人收藏'}]};
    if(method==='get_media_info') {
      if(denied) throw Object.assign(Error('无导出权限'),{status:502});
      return {media_type:mediaType,url_info:{url:'https://res-pkb.ima.qq.com/file?secret=signed-download',headers:{'X-IMA-Sign':'signature'}},notebook_ext_info:{notebook_id:'linked-note'}};
    }
    if(method==='get_doc_content') {assert.equal(body.note_id,'linked-note'); return {content:'知识库关联笔记'};}
    assert.fail(method);
  },download:async(info,maximum)=>{
    downloads.push(info);
    assert.equal(maximum,4*1024*1024);
    return {bytes:mediaType===7?markdown:html,contentType:mediaType===7?'text/markdown':'text/html',host:'res-pkb.ima.qq.com'};
  }});
  const libs=await ima.run({action:'libraries'}); assert.equal(libs.items[0].baseType,'个人知识库');
  assert.ok(!JSON.stringify(libs).includes('personal')); assert.ok(libs.nextToken);
  const more=await ima.run({action:'page',token:libs.nextToken}); assert.equal(more.items[0].title,'订阅资料'); assert.equal(more.nextToken,null);
  const first=await ima.run({action:'knowledge',token:libs.items[0].token,query:''});
  assert.equal(calls.at(-1).body.knowledge_base_id,'personal'); assert.equal(downloads.length,0);
  const second=await ima.run({action:'page',token:first.nextToken}); assert.equal(calls.at(-1).body.cursor,'page-next'); assert.equal(second.items[0].kind,'folder');
  const subfolder=await ima.run({action:'knowledge',token:second.items[0].token,query:''}); assert.equal(calls.at(-1).body.folder_id,'folder-a');
  assert.equal((await ima.run({action:'knowledge',token:libs.items[0].token,query:'不存在'})).items.length,0);
  const searched=await ima.run({action:'knowledge',token:libs.items[0].token,query:'个人'});
  assert.equal(searched.items.length,1); assert.equal(searched.nextToken,null); assert.match(searched.notice,/不保证/);
  const job=await ima.run({action:'import',token:first.items[0].token,category:'个人资料'});
  assert.equal((await store.readFile(job.id,'原文.md')).toString(),markdown.toString());
  assert.equal(job.remoteSource.libraryId,'personal'); assert.equal(job.remoteSource.mediaId,'media-one');
  assert.ok(!JSON.stringify(job).includes('signed-download')); assert.ok(!JSON.stringify(job).includes('signature'));
  assert.equal(job.remoteSource.contentFormat,'md'); assert.match(job.card,/IMA 下载的 Markdown 原件/);
  const before=(await store.list()).length;
  denied=true; await assert.rejects(ima.run({action:'import',token:subfolder.items[0].token,category:'个人资料'}),/无导出权限/);
  assert.equal((await store.list()).length,before); denied=false;
  mediaType=6;
  const web=await ima.run({action:'import',token:subfolder.items[0].token,category:'个人资料'});
  assert.equal(web.format,'bin'); assert.equal((await store.readFile(web.id,'原文.bin')).toString(),html.toString());
  assert.match(web.original,/正文 & 中文/); assert.ok(!web.original.includes('steal()')); assert.ok(!web.original.includes('bad()'));
  assert.ok(!web.html.includes('<script')); assert.ok(!web.html.includes('<img')); assert.equal(web.remoteSource.contentFormat,'html');
  assert.match(await store.handoff(web.id),/original.bin/);
  const loaded=await store.load(web.id); assert.equal(loaded.job.version,web.version);
  const server=await startPortal(config,0); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch('http://127.0.0.1:'+server.address().port+web.originalUrl);
  assert.match(response.headers.get('content-type'),/octet-stream/); assert.match(response.headers.get('content-disposition'),/^attachment/);
  assert.equal(await response.text(),html.toString());
  activeAuth={...auth,apiKey:'rotated'};
  await assert.rejects(ima.run({action:'page',token:first.nextToken}),{status:409}); activeAuth=auth;
  mediaType=11; const link=await ima.run({action:'knowledge',token:libs.items[0].token,query:''});
  const linked=await ima.run({action:'import',token:link.items[0].token,category:'个人资料'}); assert.equal(linked.remoteSource.noteId,'linked-note');
  assert.equal(linked.remoteSource.libraryId,'personal'); assert.deepEqual(await fs.readdir(root),['首页.md']);
});

test('手动更新：相同字节不暂存，变化另建可对照草稿，重试复用且本地编辑保留',async t=>{
  const {store,root}=await fixture(t);
  let content='# 原文\n第一版', activeAuth=auth, beforeReturn=async()=>{}, requests=0;
  const source={platform:'ima',kind:'media',clientIdHash:digest(auth.clientId),libraryId:'personal',mediaId:'stable-id',title:'同名资料',contentFormat:'md'};
  const old=await store.create({name:'old.md',title:'同名资料',category:'测试',base64:Buffer.from(content).toString('base64')},source);
  const edited=await store.update(old.id,{version:old.version,target:old.target,card:old.card+'\n我的审核笔记',category:'测试'});
  const ima=createIma(store,{loadCredentials:async()=>activeAuth,request:async(a,method,body)=>{
    requests++; assert.equal(method,'get_media_info'); assert.deepEqual(body,{media_id:'stable-id'});
    return {media_type:7,url_info:{url:'unused'}};
  },download:async()=>{await beforeReturn(); return {bytes:Buffer.from(content),contentType:'text/markdown',host:'res-pkb.ima.qq.com'};}});
  const check=()=>ima.run({action:'check-update',id:edited.id,version:edited.version});
  await assert.rejects(ima.run({action:'check-update',id:old.id,version:old.version}),{status:409}); assert.equal(requests,0);
  activeAuth={...auth,clientId:'different'}; await assert.rejects(check(),{status:409}); assert.equal(requests,0); activeAuth=auth;
  assert.equal((await check()).changed,false); assert.equal((await store.list()).length,1);
  content='# 原文\n第二版 <script>bad()</script>';
  const updated=await check(); assert.equal(updated.changed,true); assert.equal(updated.reused,false);
  assert.notEqual(updated.job.id,edited.id); assert.notEqual(updated.job.target,edited.target); assert.equal(updated.job.stage,'draft');
  assert.equal(updated.job.previousSnapshot.original,'# 原文\n第一版'); assert.equal(updated.job.previousSnapshot.version,edited.version);
  assert.match(updated.job.card,/updateOf/); assert.match(updated.job.html,/&lt;script&gt;/);
  assert.equal((await store.preview(edited.id)).card,edited.card); assert.equal((await store.load(edited.id)).job.version,edited.version);
  const repeat=await check(); assert.equal(repeat.reused,true); assert.equal(repeat.job.id,updated.job.id); assert.equal((await store.list()).length,2);
  assert.equal((await ima.run({action:'check-update',id:updated.job.id,version:updated.job.version})).changed,false);
  assert.deepEqual(await fs.readdir(root),['首页.md']);
  // Simulate a completed publication only inside this isolated fixture, then edit/delete its files.
  const previous=await store.load(edited.id);
  for(const file of previous.artifacts) {await fs.mkdir(path.dirname(path.join(root,file.path)),{recursive:true}); await fs.writeFile(path.join(root,file.path),file.bytes);}
  previous.job.stage='complete'; await store.save(previous.job);
  await fs.writeFile(path.join(root,previous.artifacts[0].path),'本地独立修改'); await fs.unlink(path.join(root,previous.artifacts[1].path));
  content='# 原文\n第三版'; const conflict=await check();
  assert.deepEqual(conflict.comparison.localChanges.map(item=>item.status),['modified','missing']);
  assert.equal(await fs.readFile(path.join(root,previous.artifacts[0].path),'utf8'),'本地独立修改');
  assert.notEqual(conflict.job.target,edited.target);
  const count=(await store.list()).length;
  beforeReturn=async()=>{activeAuth={...auth,apiKey:'rotated'};};
  await assert.rejects(check(),/凭据已变化/); assert.equal((await store.list()).length,count); activeAuth=auth;
  beforeReturn=async()=>{previous.job.stage='pushed'; await store.save(previous.job);};
  await assert.rejects(check(),/检查期间原任务已变化/); assert.equal((await store.list()).length,count);
});

test('笔记更新绑定旧来源，取消、权限失败与原任务并发编辑不生成候选',async t=>{
  const {store}=await fixture(t); let content='初稿', hook=async()=>{}, denied=false;
  const source={platform:'ima',kind:'note',clientIdHash:digest(auth.clientId),noteId:'note-id',title:'笔记',contentFormat:'plaintext'};
  let job=await store.create({name:'note.txt',title:'笔记',category:'测试',base64:Buffer.from(content).toString('base64')},source);
  const ima=createIma(store,{loadCredentials:async()=>auth,request:async(a,method,body)=>{
    assert.equal(method,'get_doc_content'); assert.deepEqual(body,{note_id:'note-id',target_content_format:0});
    if(denied) throw Object.assign(Error('没有读取权限'),{status:502});
    await hook(); return {content};
  }});
  const check=signal=>ima.run({action:'check-update',id:job.id,version:job.version},signal);
  assert.equal((await check()).changed,false);
  denied=true; await assert.rejects(check(),/没有读取权限/); denied=false;
  const controller=new AbortController(); hook=async()=>controller.abort(); content='变化';
  await assert.rejects(check(controller.signal),/取消/);
  hook=async()=>{await store.update(job.id,{version:job.version,target:job.target,category:'测试',card:job.card+'\n并发编辑'});};
  await assert.rejects(check(),/检查期间原任务已变化/); assert.equal((await store.list()).length,1);
  job=await store.preview(job.id); hook=async()=>{};
  const updated=await check(); assert.equal(updated.job.remoteSource.noteId,'note-id'); assert.match(updated.job.previousSnapshot.original,/初稿/);
  const {job:record}=await store.load(updated.job.id); record.remoteSource.updateOf.id='tampered'; await store.save(record);
  await assert.rejects(store.load(updated.job.id),{status:409});
});

test('重新选择同源条目识别纯改名及来源信息变化，标题不同但字节相同的候选不混用',async t=>{
  for(const kind of ['media','note']) {
    const {store,root}=await fixture(t);
    let title='原标题', remoteId='stable-id', libraryId='library-one', modifiedAt='1000', reads=0;
    const source={platform:'ima',kind,clientIdHash:digest(auth.clientId),title,...(kind==='media'?{mediaId:remoteId,libraryId,libraryTitle:'知识库',parentFolderId:'folder-a',contentFormat:'md'}:{noteId:remoteId,modifiedAt,contentFormat:'plaintext'})};
    const old=await store.create({name:kind==='media'?'old.md':'old.txt',title,category:'测试',base64:Buffer.from('同一份正文').toString('base64')},source);
    const ima=createIma(store,{loadCredentials:async()=>auth,request:async(a,method)=>{
      if(method==='search_knowledge_base') return {info_list:[{id:libraryId,name:'知识库'}],is_end:true};
      if(method==='get_knowledge_list') return {knowledge_list:[{media_id:remoteId,title,parent_folder_id:'folder-a'}],is_end:true};
      if(method==='search_note') return {search_note_infos:[{note_book_info:{note_id:remoteId,title,modify_time:modifiedAt}}],is_end:true};
      reads++;
      if(method==='get_media_info') return {media_type:7,url_info:{url:'unused'}};
      assert.equal(method,'get_doc_content'); return {content:'同一份正文'};
    },download:async()=>({bytes:Buffer.from('同一份正文'),contentType:'text/markdown',host:'res-pkb.ima.qq.com'})});
    async function select() {
      if(kind==='note') return (await ima.run({action:'search',query:'标题',start:0})).items[0].token;
      const library=(await ima.run({action:'libraries'})).items[0].token;
      return (await ima.run({action:'knowledge',token:library,query:''})).items[0].token;
    }
    const check=token=>ima.run({action:'check-update',id:old.id,version:old.version,...(token?{token}:{})});
    const unchanged=await check(await select()); assert.equal(unchanged.changed,false); assert.ok(unchanged.comparison.metadataFields.includes('title'));
    title='新标题'; modifiedAt='2000';
    assert.equal((await check()).changed,false,'未重新选择时只检查字节，不猜测新标题');
    const token=await select(), renamed=await check(token);
    assert.equal(renamed.changed,true); assert.equal(renamed.comparison.changes.content,false);
    assert.equal(renamed.job.title,'新标题'); assert.equal(renamed.job.originalHash,old.originalHash);
    assert.deepEqual(renamed.comparison.changes.metadata[0],{field:'title',before:'原标题',after:'新标题'});
    assert.equal(renamed.job.remoteSource.checkScope,'original_bytes_and_selected_metadata');
    assert.equal(renamed.job.previousSnapshot.original,old.original);
    assert.match(await store.handoff(renamed.job.id),/重新选中的同源条目/);
    assert.match(await store.handoff(renamed.job.id),/原标题/);
    assert.equal((await check(token)).job.id,renamed.job.id,'检查不消耗选择令牌，重试复用相同候选');
    title='第三个标题';
    const third=await check(await select()); assert.notEqual(third.job.id,renamed.job.id,'不能只按原件字节复用改名不同的候选');
    assert.equal((await store.preview(old.id)).version,old.version);
    const readCount=reads;
    remoteId='other-id'; await assert.rejects(check(await select()),/不是原任务的同一来源/); assert.equal(reads,readCount);
    if(kind==='media') {remoteId='stable-id'; libraryId='other-library'; await assert.rejects(check(await select()),/不是原任务的同一来源/); assert.equal(reads,readCount);}
    assert.equal((await store.list()).length,3); assert.deepEqual(await fs.readdir(root),['首页.md']);
  }
});

test('下载地址与签名隔离、有限同源跳转、限长及HTML验证页拒绝',async t=>{
  let requests=0, resolved=0, status=200, body=Buffer.from('正文'), contentLength;
  const options={resolve:async()=>{resolved++; return [{address:'1.1.1.1',family:4}];},request:(url,options,callback)=>{
    requests++; assert.equal(options.agent,false); assert.ok(!Object.keys(options.headers).some(key=>/openapi/i.test(key)));
    assert.notEqual(options.rejectUnauthorized,false);
    if(url.hostname==='res-pkb.ima.qq.com') assert.equal(options.lookup,undefined);
    else options.lookup(url.hostname,{},(error,address,family)=>{assert.equal(address,'1.1.1.1'); assert.equal(family,4);});
    const req=new EventEmitter(); req.end=()=>queueMicrotask(()=>{
      const response=Readable.from([body]); response.statusCode=status; response.headers={'content-type':'text/plain',...(contentLength?{'content-length':String(contentLength)}:{})}; callback(response);
    }); return req;
  }};
  assert.equal((await downloadIma({url:'https://example.com/file'},100,null,options)).bytes.toString(),'正文');
  await downloadIma({url:'https://res-pkb.ima.qq.com/file',headers:{'X-IMA-Sign':'resource-sign','X-IMA-Resource-Category':''}},100,null,options);
  for(const url of ['http://example.com/x','https://127.0.0.1/x','https://user:pass@example.com/x','https://example.com:444/x']) await assert.rejects(downloadIma({url},100,null,options),{status:422});
  await assert.rejects(downloadIma({url:'https://example.com/x',headers:{'X-IMA-Sign':'secret'}},100,null,options),{status:422});
  await assert.rejects(downloadIma({url:'https://res-pkb.ima.qq.com/x',headers:{'ima-openapi-apikey':'secret'}},100,null,options),{status:422});
  const count=requests;
  for(const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','224.0.0.1']) await assert.rejects(downloadIma({url:'https://example.com/x'},100,null,{...options,resolve:async()=>[{address}]}),{status:422});
  assert.equal(requests,count);
  status=302; await assert.rejects(downloadIma({url:'https://example.com/x'},100,null,options),/跳转/); status=200;
  let hops=0, redirectTarget='https://example.com/next', keepRedirecting=false;
  const redirectOptions={...options,request:(url,options,callback)=>{
    const req=new EventEmitter(); req.end=()=>queueMicrotask(()=>{
      const response=Readable.from([Buffer.from('正文')]); response.statusCode=hops++===0 || keepRedirecting?302:200;
      response.headers={'content-type':'text/plain',location:redirectTarget}; callback(response);
    }); return req;
  }};
  assert.equal((await downloadIma({url:'https://example.com/start'},100,null,redirectOptions)).bytes.toString(),'正文'); assert.equal(hops,2);
  hops=0; redirectTarget='https://other.example.com/';
  await assert.rejects(downloadIma({url:'https://example.com/start'},100,null,redirectOptions),/跳转/); assert.equal(hops,1);
  hops=0; redirectTarget='https://res-pkb.ima.qq.com/next';
  await assert.rejects(downloadIma({url:'https://res-pkb.ima.qq.com/start',headers:{'X-IMA-Sign':'signature'}},100,null,redirectOptions),/跳转/); assert.equal(hops,1);
  hops=0; redirectTarget='https://example.com/next'; keepRedirecting=true;
  await assert.rejects(downloadIma({url:'https://example.com/start'},100,null,redirectOptions),/跳转/); assert.equal(hops,3);
  contentLength=200; await assert.rejects(downloadIma({url:'https://example.com/x'},100,null,options),{status:413}); contentLength=undefined;
  body=Buffer.alloc(101); await assert.rejects(downloadIma({url:'https://example.com/x'},100,null,options),{status:413});
  const {store}=await fixture(t);
  await assert.rejects(store.create({name:'web.bin',base64:Buffer.from('<html><body>环境异常 完成验证后即可继续访问</body></html>').toString('base64')},{contentFormat:'html',platform:'ima',kind:'media'}),/验证/);
  assert.equal((await store.list()).length,0);
});
