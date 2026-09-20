import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { plainPath, writeJSON } from './imports.mjs';
import { failure } from './library.mjs';

export const providers = [
  {id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com',example:'deepseek-flash',docs:'https://api-docs.deepseek.com/api/create-chat-completion/'},
  {id:'qwen',name:'阿里云百炼 · 千问',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',example:'qwen-plus',docs:'https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen',hint:'按 API Key 所属地域填写地址。北京使用 https://工作空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1。'},
  {id:'zhipu',name:'智谱 · GLM',baseUrl:'https://open.bigmodel.cn/api/paas/v4',example:'glm-4.7-flash',docs:'https://docs.bigmodel.cn/api-reference/模型-api/对话补全'},
  {id:'siliconflow',name:'硅基流动',baseUrl:'https://api.siliconflow.cn/v1',example:'Qwen/Qwen2.5-7B-Instruct',docs:'https://docs.siliconflow.cn/docs/userguide/guides/fine-tune'},
];
const providerFor = id => providers.find(item => item.id === id);
const within = (child, parent) => { const rel=path.relative(parent,child); return !rel || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel)); };
const invalid = () => failure(400,'模型渠道配置无效，请核对供应商、官方地址、模型名和 API Key');

function validate(entry, id) {
  const provider=providerFor(id);
  if (!provider || !entry || typeof entry.baseUrl!=='string' || typeof entry.model!=='string' || !/^[\w./:-]{1,200}$/.test(entry.model) || typeof entry.apiKey!=='string' || !/^[\x21-\x7e]{1,4096}$/.test(entry.apiKey)) throw invalid();
  // Bind credentials to a known provider endpoint; never follow an arbitrary URL or redirect.
  const allowed=entry.baseUrl===provider.baseUrl || (id==='qwen' && /^https:\/\/[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode\/v1$/.test(entry.baseUrl));
  if (!allowed) throw invalid();
  return {baseUrl:entry.baseUrl,model:entry.model,apiKey:entry.apiKey};
}

export function createModels(config) {
  const filename=config.models?.file;
  let busy=false;
  async function checkPath(create=false) {
    const app=fileURLToPath(new URL('../',import.meta.url));
    const roots=await Promise.all([config.root,app,config.imports?.directory].filter(Boolean).map(async root=>{
      try { return await fs.realpath(root); } catch(error) { if(error.code==='ENOENT') return path.resolve(root); throw error; }
    }));
    if (!path.isAbsolute(filename??'') || path.extname(filename)!=='.json' || roots.some(root=>within(path.resolve(filename),root))) throw failure(503,'模型配置文件须位于知识库、暂存区和应用仓库之外');
    await plainPath(path.dirname(filename),create); await plainPath(filename);
    if(create) await plainPath(filename+'.lock');
  }
  async function load() {
    await checkPath();
    try {
      if ((await fs.stat(filename)).size>64*1024) throw Error();
      const data=JSON.parse(await fs.readFile(filename,'utf8'));
      if(data.schemaVersion!==1 || typeof data.version!=='string' || !data.providers || Array.isArray(data.providers) || typeof data.providers!=='object' || (data.selected!==null && !providerFor(data.selected))) throw Error();
      const entries=Object.fromEntries(Object.entries(data.providers).map(([id,entry])=>[id,validate(entry,id)]));
      return {schemaVersion:1,version:data.version,selected:data.selected,providers:entries};
    } catch(error) {
      if(error.code==='ENOENT') return {schemaVersion:1,version:'new',selected:null,providers:{}};
      throw failure(503,'模型配置文件不可读或格式无效；未覆盖现有配置');
    }
  }
  function publicState(data) {
    return {enabled:true,version:data.version,selected:data.selected,providers:providers.map(provider=>({...provider,model:data.providers[provider.id]?.model??'',baseUrl:data.providers[provider.id]?.baseUrl??provider.baseUrl,hasKey:Boolean(data.providers[provider.id])}))};
  }
  async function state() { return filename ? publicState(await load()) : {enabled:false,providers}; }
  async function save(input) {
    if (busy) throw failure(409,'模型连接测试正在进行，请先取消或等待完成');
    await checkPath(true);
    let lock;
    try { lock=await fs.open(filename+'.lock','wx',0o600); }
    catch(error) { if(error.code==='EEXIST') throw failure(409,'另一个模型配置保存正在进行，请稍后重试'); throw error; }
    try {
      const data=await load();
      if(input.version!==data.version) throw failure(409,'模型配置已变化，请刷新后重新编辑');
      if(!providerFor(input.provider)) throw invalid();
      if(input.action==='remove') {
        delete data.providers[input.provider];
        if(data.selected===input.provider) data.selected=null;
      } else if(input.action==='save') {
        const previous=data.providers[input.provider];
        const baseUrl=typeof input.baseUrl==='string'?input.baseUrl.trim().replace(/\/$/,''):'';
        if(typeof input.apiKey!=='string') throw invalid();
        // Empty means retain only this provider's key at the same destination, never another channel's key.
        const apiKey=input.apiKey.trim() || (previous?.baseUrl===baseUrl?previous.apiKey:'');
        data.providers[input.provider]=validate({baseUrl,model:typeof input.model==='string'?input.model.trim():'',apiKey},input.provider);
        data.selected=input.provider;
      } else throw invalid();
      data.version=randomUUID();
      await writeJSON(filename,data);
      return publicState(data);
    } finally { await lock.close(); await fs.unlink(filename+'.lock'); }
  }
  async function test(input, signal) {
    if (busy) throw failure(409,'已有连接测试正在进行');
    busy=true;
    try {
      const data=await load();
      if(input.version!==data.version) throw failure(409,'模型配置已变化，请刷新后重新测试');
      if(!providerFor(input.provider) || !data.providers[input.provider]) throw failure(400,'请先保存此供应商的模型和 API Key');
      return await probeModel(data.providers[input.provider],signal);
    }
    finally { busy=false; }
  }
  return {state,save,test};
}

export async function probeModel(entry, signal, timeoutMs=30000) {
  const deadline=AbortSignal.timeout(timeoutMs), combined=signal?AbortSignal.any([signal,deadline]):deadline;
  const start=Date.now();
  try {
    const response=await fetch(entry.baseUrl+'/chat/completions',{method:'POST',redirect:'error',signal:combined,
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+entry.apiKey},
      body:JSON.stringify({model:entry.model,messages:[{role:'user',content:'连接测试：请只回复 OK。'}],stream:false,max_tokens:64})});
    if(!response.ok) {
      await response.body?.cancel();
      const errors={401:'API Key 无效',403:'API Key 或模型访问权限不足',404:'接口或模型不存在',429:'请求限流或额度不足'};
      throw failure(502,errors[response.status]??'供应商返回错误，请核对模型和服务状态');
    }
    let size=0; const chunks=[];
    for await(const chunk of response.body) { size+=chunk.length; if(size>256*1024) throw failure(502,'模型响应超过测试限制'); chunks.push(chunk); }
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const message=result.choices?.[0]?.message;
    if(result.error || !message || ![message.content,message.reasoning_content].some(text=>typeof text==='string' && text.trim())) throw failure(502,'供应商未返回有效文本，请核对模型是否支持对话接口');
    // Never relay provider output: a response can echo credentials or unrelated diagnostic data.
    return {status:'connected',elapsedMs:Date.now()-start};
  } catch(error) {
    if(signal?.aborted) throw failure(499,'连接测试已取消');
    if(deadline.aborted) throw failure(504,'连接测试超时，请稍后重试');
    if(error.status) throw error;
    throw failure(502,'模型连接失败或响应无效，请核对网络和供应商状态');
  }
}
