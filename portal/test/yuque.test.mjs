import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createYuque,requestYuque,yuqueDocument} from '../yuque.mjs';
import {createImports,digest} from '../imports.mjs';
import {startPortal} from '../server.mjs';

const documentUrl='https://www.yuque.com/example/book/article';
const document={id:42,title:'合成语雀文档',format:'lake',body:'# 合成文档\n\n|列|值|\n|---|---|\n|中文|内容|\n\n<script>bad()</script>\n![图片](https://example.invalid/image.png)',updated_at:'2026-09-18T00:00:00Z'};
async function fixture(t) {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'evokbase-yuque-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'vault'); await fs.mkdir(root); await fs.writeFile(path.join(root,'首页.md'),'# 合成库');
  const config={root,include:['首页.md','00_资源库'],imports:{directory:path.join(base,'staging'),resourceRoot:'00_资源库/外部资料'}};
  return {base,root,config,filename:path.join(base,'credentials','yuque.json'),store:await createImports(config)};
}

test('语雀只读请求限定官方文档路径、Token 不随跳转且错误不透出上游内容',async()=>{
  const parsed=yuqueDocument(documentUrl+'?share_token=not-kept#heading');
  assert.equal(parsed.url,documentUrl); assert.equal(parsed.api,'repos/example/book/docs/article');
  for(const url of ['http://www.yuque.com/a/b/c','https://www.yuque.com.evil.invalid/a/b/c','https://team.yuque.com/a/b/c','https://token@www.yuque.com/a/b/c','https://www.yuque.com:444/a/b/c','https://www.yuque.com/a/b/c%2Fother','https://www.yuque.com/a/b','https://www.yuque.com/a/b/c/d']) assert.throws(()=>yuqueDocument(url),{status:400});
  const result=await requestYuque('synthetic-token',parsed,null,async(url,options)=>{
    assert.equal(url,'https://www.yuque.com/api/v2/repos/example/book/docs/article?raw=1');
    assert.equal(options.method,'GET'); assert.equal(options.redirect,'error'); assert.equal(options.headers['X-Auth-Token'],'synthetic-token');
    assert.ok(!url.includes('synthetic-token')); assert.notEqual(options.rejectUnauthorized,false);
    return Response.json({data:document});
  });
  assert.equal(result.body,document.body);
  for(const response of [new Response('synthetic-token',{status:401}),new Response('synthetic-token',{status:403}),new Response('synthetic-token',{status:404}),new Response('synthetic-token',{status:429}),Response.json({data:null}),new Response('synthetic-token'),new Response('x'.repeat(8*1024*1024+1))]) {
    await assert.rejects(requestYuque('synthetic-token',parsed,null,async()=>response),e=>e.status===502 && !e.message.includes('synthetic-token'));
  }
  const controller=new AbortController(); controller.abort();
  await assert.rejects(requestYuque('synthetic-token',parsed,controller.signal,async()=>{throw Error('upstream secret');}),{status:499});
});

test('语雀凭据独立存储、版本冲突和环境优先，页面状态不回传 Token',async t=>{
  const {filename,store,root}=await fixture(t);
  const yuque=createYuque(store,{filename,envToken:()=>undefined});
  assert.equal((await yuque.state()).configured,false);
  const saved=await yuque.run({action:'configure',version:'new',token:'synthetic-token'});
  assert.equal(saved.configured,true); assert.ok(!JSON.stringify(saved).includes('synthetic-token'));
  assert.equal(JSON.parse(await fs.readFile(filename,'utf8')).token,'synthetic-token');
  await assert.rejects(yuque.run({action:'configure',version:'new',token:'replacement'}),{status:409});
  await assert.rejects(yuque.run({action:'configure',version:saved.version,token:'token\nheader'}),{status:400});
  const environment=createYuque(store,{filename,envToken:()=>'environment-token'});
  assert.equal((await environment.state()).environment,true);
  await assert.rejects(environment.run({action:'clear',version:'environment'}),{status:409});
  assert.equal((await yuque.run({action:'clear',version:saved.version})).configured,false);
  await assert.rejects(createYuque(store,{filename:path.join(root,'yuque.json'),envToken:()=>undefined}).state(),{status:503});
  assert.deepEqual(await fs.readdir(root),['首页.md']);
});

test('语雀正文快照与来源进入原暂存流程，失败不建任务、换凭据中止、不覆盖正式库',async t=>{
  const {filename,store,root}=await fixture(t); let response=document, token='synthetic-token', rotate=false, calls=0;
  const yuque=createYuque(store,{filename,envToken:()=>token,request:async(auth,link)=>{calls++; assert.equal(auth,'synthetic-token'); assert.equal(link.url,documentUrl); if(rotate) token='rotated'; return response;}});
  const input={action:'import',version:'environment',url:documentUrl+'?secret=discarded#heading'};
  await assert.rejects(yuque.run({...input,url:'https://evil.invalid/a/b/c'}),{status:400}); assert.equal(calls,0);
  await assert.rejects(yuque.run({...input,category:'../bad'}),{status:400}); assert.equal(calls,0);
  const job=await yuque.run(input);
  assert.equal(job.stage,'draft'); assert.equal(job.remoteSource.platform,'yuque'); assert.equal(job.remoteSource.documentId,42); assert.equal(job.remoteSource.sourceUrl,documentUrl);
  assert.equal(job.original,document.body); assert.equal(job.originalHash,digest(Buffer.from(document.body)));
  assert.equal((await store.readFile(job.id,'原文.md')).toString(),document.body);
  assert.match(job.card,/语雀 API Markdown 正文快照/); assert.ok(!job.card.includes('IMA')); assert.ok(!JSON.stringify(job).includes('synthetic-token')); assert.ok(!JSON.stringify(job).includes('discarded'));
  assert.ok(!job.html.includes('<script>') && !job.html.includes('<img')); assert.ok(job.warnings.some(w=>w.includes('历史版本')));
  assert.equal(job.category,''); await assert.rejects(store.handoff(job.id),{status:409});
  const classified=await store.update(job.id,{version:job.version,target:store.resourceRoot+'/合成分类/'+job.target.split('/').at(-1),card:job.card});
  const handoff=await store.handoff(job.id); assert.ok(handoff.includes(classified.version)); assert.match(handoff,/"decision": "pending"/);
  const restored=await store.preview(job.id); assert.equal(restored.version,classified.version);
  for(response of [{...document,body:''},{...document,format:'sheet'},{...document,id:null},{...document,body:'---\nslug: fixed\n---\n# 内容'}]) await assert.rejects(yuque.run(input));
  response=document; rotate=true; await assert.rejects(yuque.run(input),{status:409});
  assert.equal((await store.list()).length,1); assert.deepEqual(await fs.readdir(root),['首页.md']);
});

test('语雀 HTTP 同源与请求限长，未配置不影响本地资料浏览',async t=>{
  const {config}=await fixture(t); const server=await startPortal(config,0); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(url+'/api/tree')).status,200);
  const state=await(await fetch(url+'/api/yuque')).json(); assert.ok(!('token' in state));
  assert.equal((await fetch(url+'/api/yuque',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/yuque',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid','X-EvoKBase-Request':'1'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/yuque',{method:'POST',headers:{'Content-Type':'application/json',Origin:url,'X-EvoKBase-Request':'1'},body:JSON.stringify({token:'x'.repeat(17000)})})).status,413);
});

test('语雀页面配置清空密钥、只请求语雀、导入前保护未保存草稿',async()=>{
  const nodes=new Map(), requests=[];
  const node=id=>{if(!nodes.has(id)) nodes.set(id,{value:'',events:{},children:[],addEventListener(name,fn){this.events[name]=fn;},replaceChildren(...children){this.children=children;},append(child){this.children.push(child);},focus(){}});return nodes.get(id);};
  let configured=false;
  const job={id:'draft',title:'语雀合成文档',stage:'draft',version:'v1',target:'00_资源库/合成/文档',category:'合成',card:'资料卡',warnings:[],outputs:[],remoteSource:{platform:'yuque'}};
  const context=vm.createContext({document:{getElementById:node},window:{addEventListener(){}},Option:function(text,value){this.text=text;this.value=value;},fetch:async(url,options)=>{
    const body=options?.body?JSON.parse(options.body):null;requests.push({url,body});
    let data=url==='/api/imports'?{enabled:true,jobs:[]}:job;
    if(url==='/api/yuque') {
      if(body?.action==='configure') { assert.equal(node('yuque-token').value,''); configured=true; }
      if(body?.action==='clear') configured=false;
      data=body?.action==='import'?job:{enabled:true,configured,version:'v1',environment:false};
    }
    return {ok:true,json:async()=>data};
  }});
  const code=(await fs.readFile(new URL('../web/imports.js',import.meta.url),'utf8')).replace('export function','function');
  vm.runInContext(code+'\nvar page=initImports("yuque");',context);
  await context.page.refresh(); assert.equal(node('import-form').hidden,true); assert.equal(node('yuque-fields').disabled,true);
  node('yuque-token').value='synthetic-token'; await node('yuque-config').events.submit({preventDefault(){}});
  assert.equal(node('yuque-token').value,''); assert.equal(node('yuque-fields').disabled,false);
  node('yuque-url').value=documentUrl; await node('yuque-form').events.submit({preventDefault(){}});
  assert.equal(requests.find(item=>item.body?.action==='import').body.category,undefined);
  assert.equal(node('import-download').textContent,'下载语雀 Markdown 正文快照');
  node('import-card').value='未保存修改'; const count=requests.length;
  await node('yuque-form').events.submit({preventDefault(){}}); assert.equal(requests.length,count);
  assert.ok(requests.every(r=>r.url!=='/api/ima'));
});
