import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {plainPath, writeJSON, safeRelative} from './imports.mjs';
import {failure} from './library.mjs';

const validToken = value => typeof value==='string' && /^[\x21-\x7e]{1,4096}$/.test(value);

export function yuqueDocument(value) {
  const invalid=()=>failure(400,'请输入语雀文档链接：https://www.yuque.com/用户或团队/知识库/文档；暂不支持企业独立域名和分享短链');
  if(typeof value!=='string' || value.length>2048 || /[\x00-\x20\\]/.test(value)) throw invalid();
  let url, parts;
  try { url=new URL(value); parts=url.pathname.replace(/\/$/,'').split('/').slice(1).map(decodeURIComponent); } catch { throw invalid(); }
  if(url.protocol!=='https:' || !['www.yuque.com','yuque.com'].includes(url.hostname) || url.port || url.username || url.password || parts.length!==3 || parts.some(part=>! /^[\p{L}\p{N}_-]{1,160}$/u.test(part))) throw invalid();
  // Only path components become API identifiers. Query credentials and heading fragments are discarded.
  const route=parts.map(encodeURIComponent).join('/');
  return {namespace:parts.slice(0,2).join('/'),slug:parts[2],url:'https://www.yuque.com/'+route,api:'repos/'+parts.slice(0,2).map(encodeURIComponent).join('/')+'/docs/'+encodeURIComponent(parts[2])};
}

export async function requestYuque(token, document, signal, fetcher=fetch) {
  if(!validToken(token)) throw failure(503,'语雀 Token 格式无效');
  const target=yuqueDocument(document.url);
  const deadline=AbortSignal.timeout(30000);
  try {
    // The official SDK documents raw=1 for Markdown. Do not install its proxy/TLS defaults.
    const response=await fetcher('https://www.yuque.com/api/v2/'+target.api+'?raw=1',{
      method:'GET',redirect:'error',signal:AbortSignal.any([deadline,...(signal?[signal]:[])]),
      headers:{'X-Auth-Token':token,'User-Agent':'EvoKBase','Accept':'application/json'}
    });
    if(!response.ok) {
      await response.body?.cancel();
      const reason={401:'Token 无效或已过期',403:'Token 或账号没有文档读取权限，请核对语雀开放 API 权限',404:'文档不存在或当前账号不可见',429:'请求限流，请稍后重试'}[response.status];
      throw failure(502,'语雀读取失败：'+(reason || '服务暂不可用，请稍后重试'));
    }
    let size=0; const chunks=[];
    for await(const chunk of response.body) { size+=chunk.length; if(size>8*1024*1024) throw failure(502,'语雀响应超过 8 MiB，未暂存'); chunks.push(chunk); }
    const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(!result.data || typeof result.data!=='object' || Array.isArray(result.data)) throw Error();
    return result.data;
  } catch(error) {
    if(signal?.aborted) throw failure(499,'语雀读取已取消');
    if(deadline.aborted) throw failure(504,'语雀读取超时，请稍后重试');
    if(error.status) throw error;
    throw failure(502,'语雀连接失败或返回格式无效；未暂存');
  }
}

export function createYuque(imports, {filename=path.join(os.homedir(),'.config/evokbase/yuque.json'),envToken=()=>process.env.YUQUE_TOKEN,request=requestYuque}={}) {
  let busy=false;
  async function checkPath(create=false) {
    const roots=[fileURLToPath(new URL('../',import.meta.url)),imports?.root,imports?.directory].filter(Boolean);
    if(!path.isAbsolute(filename) || roots.some(root=>{ const rel=path.relative(path.resolve(root),filename); return !rel || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel)); })) throw failure(503,'语雀凭据文件必须位于应用、知识库和暂存区之外');
    await plainPath(path.dirname(filename),create); await plainPath(filename);
  }
  async function load() {
    const environment=envToken();
    if(environment) { if(!validToken(environment)) throw failure(503,'YUQUE_TOKEN 环境变量格式无效'); return {version:'environment',token:environment,environment:true}; }
    await checkPath();
    try {
      if((await fs.stat(filename)).size>8192) throw Error();
      const data=JSON.parse(await fs.readFile(filename,'utf8'));
      if(typeof data.version!=='string' || !data.version || (data.token!=='' && !validToken(data.token))) throw Error();
      return data;
    } catch(error) {
      if(error.code==='ENOENT') return {version:'new',token:''};
      throw failure(503,'语雀凭据文件不可读或格式无效，未覆盖原文件');
    }
  }
  const publicState=data=>({enabled:Boolean(imports),configured:Boolean(data.token),version:data.version,environment:Boolean(data.environment)});
  async function state() { return publicState(await load()); }
  async function run(input,signal) {
    if(busy) throw failure(409,'语雀操作正在进行，请稍后重试');
    busy=true;
    try {
      const auth=await load();
      if(['configure','clear'].includes(input.action)) {
        if(auth.environment) throw failure(409,'当前使用 YUQUE_TOKEN 环境变量，请在本机调整后重启门户');
        if(input.action==='configure' && !validToken(input.token)) throw failure(400,'请输入有效的语雀 Token，不含空白字符');
        await checkPath(true);
        let lock;
        try { lock=await fs.open(filename+'.lock','wx',0o600); }
        catch(error) { if(error.code==='EEXIST') throw failure(409,'语雀配置正在保存，请稍后重试'); throw error; }
        try {
          const current=await load();
          if(input.version!==current.version) throw failure(409,'语雀配置已变化，请刷新后重试');
          const saved={version:randomUUID(),token:input.action==='clear'?'':input.token};
          await writeJSON(filename,saved); return publicState(saved);
        } finally { await lock.close(); await fs.unlink(filename+'.lock'); }
      }
      if(input.action!=='import') throw failure(400,'不支持的语雀操作');
      if(!imports) throw failure(503,'请先配置独立导入暂存目录');
      if(!auth.token) throw failure(503,'请先配置语雀 Token');
      if(input.version!==auth.version) throw failure(409,'语雀配置已变化，请刷新后重试');
      const document=yuqueDocument(input.url);
      if(input.category!==undefined && input.category!=='' && (!safeRelative(input.category) || input.category.length>160)) throw failure(400,'主题分类无效');
      const data=await request(auth.token,document,signal);
      if(!Number.isSafeInteger(data.id) || data.id<=0 || typeof data.title!=='string' || !data.title.trim() || data.title.length>10000) throw failure(502,'语雀未提供有效文档标识或标题');
      if(!['markdown','lake'].includes(data.format) || typeof data.body!=='string' || !data.body.trim() || data.body.includes('\0') || Buffer.byteLength(data.body)>4*1024*1024) throw failure(422,'仅支持可返回 Markdown 正文的文档（最多 4 MiB）；表格、画板和空正文请从语雀导出后本地导入');
      if(signal?.aborted) throw failure(499,'语雀读取已取消');
      // A token rotation while awaiting upstream must not import under the replacement identity.
      if((await load()).token!==auth.token) throw failure(409,'读取期间语雀凭据已变化，请重试');
      return await imports.create({name:'语雀正文.md',title:data.title.replace(/[\x00-\x1f]/g,' ').trim().slice(0,150),base64:Buffer.from(data.body).toString('base64'),category:input.category},{
        platform:'yuque',kind:'document',namespace:document.namespace,documentId:data.id,sourceUrl:document.url,title:data.title,
        updatedAt:typeof data.updated_at==='string'?data.updated_at:null,fetchedAt:new Date().toISOString(),upstreamFormat:data.format,contentFormat:'markdown_export'
      });
    } finally { busy=false; }
  }
  return {state,run};
}
