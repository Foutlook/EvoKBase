import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './imports.mjs';
import { failure } from './library.mjs';
import { downloadIma } from './ima-download.mjs';

async function credentials() {
  async function read(name) {
    try { return (await fs.readFile(path.join(os.homedir(),'.config/ima',name),'utf8')).trim(); }
    catch(error) { if(error.code==='ENOENT') return ''; throw failure(503,'IMA 凭据文件不可读'); }
  }
  const clientId=process.env.IMA_CLIENT_ID || process.env.IMA_OPENAPI_CLIENTID || await read('client_id');
  const apiKey=process.env.IMA_API_KEY || process.env.IMA_OPENAPI_APIKEY || await read('api_key');
  if(!clientId || !apiKey) return null;
  if(![clientId,apiKey].every(value=>/^[\x21-\x7e]{1,4096}$/.test(value))) throw failure(503,'IMA 凭据格式无效');
  return {clientId,apiKey};
}

// Only these read APIs are exposed. Keys never follow a redirect or a document URL.
export async function requestIma(auth, method, body, signal, fetcher=fetch) {
  const group=['search_note','get_doc_content'].includes(method)?'note':['search_knowledge_base','search_knowledge','get_knowledge_list','get_media_info'].includes(method)?'wiki':null;
  if(!group) throw failure(400,'不支持的 IMA 操作');
  try {
    const response=await fetcher('https://ima.qq.com/openapi/'+group+'/v1/'+method,{
      method:'POST',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]),
      headers:{'Content-Type':'application/json','ima-openapi-clientid':auth.clientId,'ima-openapi-apikey':auth.apiKey},body:JSON.stringify(body)
    });
    if(!response.ok) { await response.body?.cancel(); throw failure(502,'IMA 请求失败（HTTP '+response.status+'），请核对凭据、权限或稍后重试'); }
    const chunks=[]; let size=0;
    for await(const chunk of response.body) {
      size+=chunk.length;
      if(size>8*1024*1024) throw failure(502,'IMA 返回内容超过 8 MiB，未暂存');
      chunks.push(chunk);
    }
    const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(data.code!==0) {
      const message={20004:'IMA 鉴权失败，请核对本机凭据',20002:'IMA 请求限流，请稍后重试',210005:'只能读取本人有权限的笔记',210006:'IMA 笔记已删除；本地资料保持不变',210011:'没有共享笔记访问权限',210034:'没有私有笔记访问权限',110030:'没有该知识库资料的读取权限',220030:'IMA 拒绝读取该资料；订阅可见不代表允许导出，请在 IMA 客户端核对权限'}[data.code];
      throw failure(502,message || 'IMA 未能完成读取，请核对权限或稍后重试');
    }
    if(!data.data || typeof data.data!=='object' || Array.isArray(data.data)) throw Error();
    return data.data;
  } catch(error) {
    if(error.status) throw error;
    throw failure(502,signal?.aborted?'已取消 IMA 读取':'IMA 连接超时、不可用或返回格式无效；未暂存');
  }
}

export function createIma(imports, {loadCredentials=credentials,request=requestIma,download=downloadIma}={}) {
  const selections=new Map(); let busy=false;
  const identity=auth=>digest(JSON.stringify([auth.clientId,auth.apiKey]));
  const validText=(text,max=500)=>typeof text==='string' && text.length>0 && text.length<=max && !/[\x00-\x1f]/.test(text);
  function select(item,auth) {
    const token=randomUUID(); selections.set(token,{...item,identity:identity(auth),clientIdHash:digest(auth.clientId),observedAt:new Date().toISOString(),expires:Date.now()+600000});
    // ponytail: keep at most 200 selected entries/pages; refresh after eviction or process restart.
    if(selections.size>200) selections.delete(selections.keys().next().value);
    return token;
  }
  function selected(token,auth,kinds) {
    const item=selections.get(token);
    if(!item || item.identity!==identity(auth) || !kinds.includes(item.kind)) throw failure(409,'资料选择已失效或凭据已变化，请重新加载');
    return item;
  }
  function nextPage(data,rows,auth,context) {
    // The live knowledge search can omit both paging fields even with hits; show that batch without inventing a cursor.
    if(context.operation==='knowledge' && context.query && data.is_end===undefined && data.next_cursor===undefined) return null;
    // Live IMA returns only info_list for an empty search; nonempty pages must declare completion.
    const end=data.is_end===true || (data.is_end===undefined && rows.length===0);
    if(!end && (data.is_end!==false || !validText(data.next_cursor,2000) || data.next_cursor===context.cursor)) throw failure(502,'IMA 翻页信息不完整，未猜测下一页');
    return end?null:select({...context,kind:'page',cursor:data.next_cursor},auth);
  }
  async function state() { return {enabled:Boolean(imports),configured:Boolean(await loadCredentials())}; }
  async function run(input,signal) {
    if(!imports) throw failure(503,'请先配置独立导入暂存目录');
    if(busy) throw failure(409,'IMA 操作正在进行，请稍后重试');
    busy=true;
    try {
      const auth=await loadCredentials(); if(!auth) throw failure(503,'未配置 IMA Client ID 和 API Key，请按页面说明配置后重启门户');
      for(const [key,value] of selections) if(value.expires<Date.now()) selections.delete(key);
      let page;
      if(input.action==='page') { page=selected(input.token,auth,['page']); input={...page,action:page.operation}; }
      if(input.action==='libraries') {
        const cursor=page?.cursor||'';
        const data=await request(auth,'search_knowledge_base',{query:'',cursor,limit:20},signal);
        if(!Array.isArray(data.info_list) || data.info_list.length>20) throw failure(502,'IMA 知识库列表格式无效');
        const items=data.info_list.map(row=>{
          if(!row || typeof row!=='object') throw failure(502,'IMA 知识库列表格式无效');
          // Official docs use id/name; the live 1.1.10 service returns kb_id/kb_name/base_type.
          const libraryId=row.kb_id??row.id,title=row.kb_name??row.name;
          if(!validText(libraryId) || !validText(title,10000)) throw failure(502,'IMA 知识库标识不完整');
          const baseType=typeof row.base_type==='string'?row.base_type.slice(0,100):'';
          return {title,baseType,token:select({kind:'library',libraryId,title,baseType},auth)};
        });
        return {items,nextToken:nextPage(data,data.info_list,auth,{operation:'libraries',cursor})};
      }
      if(input.action==='knowledge') {
        const scope=page||selected(input.token,auth,['library','folder']);
        const query=page?.query??input.query??'';
        if(typeof query!=='string' || query.length>200 || /[\x00-\x1f]/.test(query)) throw failure(400,'关键词无效');
        const libraryTitle=scope.libraryTitle??scope.title, cursor=page?.cursor||'';
        const context={operation:'knowledge',libraryId:scope.libraryId,libraryTitle,baseType:scope.baseType,folderId:scope.folderId,folderTitle:scope.folderTitle,query:query.trim(),cursor};
        const data=await request(auth,query.trim()?'search_knowledge':'get_knowledge_list',query.trim()?{knowledge_base_id:scope.libraryId,query:query.trim(),cursor}:{knowledge_base_id:scope.libraryId,cursor,limit:20,...(scope.folderId?{folder_id:scope.folderId}:{})},signal);
        const rows=query.trim()?data.info_list:data.knowledge_list;
        if(!Array.isArray(rows) || rows.length>100) throw failure(502,'IMA 资料列表格式无效');
        const items=rows.map(row=>{
          if(!row || typeof row!=='object') throw failure(502,'IMA 资料列表格式无效');
          const folderId=row.folder_id||(typeof row.media_id==='string' && row.media_id.startsWith('folder_')?row.media_id:null);
          const id=folderId||row.media_id,title=folderId?(row.name??row.title):row.title;
          if(!validText(id) || !validText(title,10000)) throw failure(502,'IMA 资料标识不完整');
          const item={kind:folderId?'folder':'media',libraryId:scope.libraryId,libraryTitle,baseType:scope.baseType,title,...(folderId?{folderId,folderTitle:title}:{mediaId:id,parentFolderId:row.parent_folder_id??null})};
          return {title,kind:item.kind,token:select(item,auth)};
        });
        return {items,nextToken:nextPage(data,rows,auth,context),scope:libraryTitle+(query.trim()?' · 全库搜索':scope.folderTitle?' / '+scope.folderTitle:' · 根目录'),notice:query.trim() && data.is_end===undefined && data.next_cursor===undefined?'IMA 未提供翻页信息，仅展示本次返回结果，不保证覆盖全部命中；可缩小关键词或留空浏览。':''};
      }
      if(input.action==='search') {
        if(typeof input.query!=='string' || !input.query.trim() || input.query.length>200 || /[\x00-\x1f]/.test(input.query) || !Number.isSafeInteger(input.start) || input.start<0 || input.start>100000) throw failure(400,'请输入标题关键词和有效页码');
        const data=await request(auth,'search_note',{search_type:0,query_info:{title:input.query.trim()},start:input.start,end:input.start+20},signal);
        if(!Array.isArray(data.search_note_infos) || data.search_note_infos.length>20 || typeof data.is_end!=='boolean') throw failure(502,'IMA 搜索结果格式无效');
        const observedAt=new Date().toISOString();
        const allNotes=data.search_note_infos.map(row=>row?.note_book_info);
        const notes=allNotes.filter(note=>typeof note?.title!=='string' || note.title.toLocaleLowerCase().includes(input.query.trim().toLocaleLowerCase()));
        if(notes.some(note=>!note || typeof note.note_id!=='string' || !note.note_id || note.note_id.length>500 || /[\x00-\x1f]/.test(note.note_id) || typeof note.title!=='string' || note.title.length>10000)) throw failure(502,'IMA 笔记信息不完整，请重新搜索');
        const items=notes.map(note=>{
          const item={title:note.title,modifiedAt:Number.isSafeInteger(Number(note.modify_time)) && Number(note.modify_time)>0?String(note.modify_time):null};
          const token=select({...item,kind:'note',noteId:note.note_id,observedAt},auth);
          return {...item,token};
        });
        return {items,isEnd:data.is_end,start:input.start,notice:allNotes.length!==notes.length?'IMA 返回了标题不匹配的条目，已按关键词过滤当前页；后续页仍可继续查看。':''};
      }
      let baseline, note;
      if(input.action==='check-update') {
        const {job}=await imports.load(input.id);
        if(job.version!==input.version || !['draft','complete'].includes(job.stage)) throw failure(409,'任务版本或发布状态已变化，请刷新后重试');
        const source=job.remoteSource;
        if(source?.platform!=='ima' || source.clientIdHash!==digest(auth.clientId)) throw failure(409,'来源与当前 IMA 凭据不匹配，请核对原账号配置');
        if(!['note','media'].includes(source.kind) || !validText(source.kind==='note'?source.noteId:source.mediaId) || (source.kind==='media' && !validText(source.libraryId))) throw failure(409,'旧任务缺少完整来源标识，不能检查更新');
        baseline={id:job.id,version:job.version};
        note=input.token?selected(input.token,auth,['note','media']):source;
        if(note.kind!==source.kind || (source.kind==='media'?(note.libraryId!==source.libraryId || note.mediaId!==source.mediaId):note.noteId!==source.noteId)) throw failure(409,'所选条目不是原任务的同一来源，请重新选择同一篇资料');
        if(input.token) baseline.metadataFields=['title',...(note.kind==='media'?['libraryTitle',...(validText(note.parentFolderId)?['parentFolderId']:[])]:note.modifiedAt?['modifiedAt']:[])];
        input={...input,category:job.target.slice(imports.resourceRoot.length+1).split('/').slice(0,-1).join('/')};
      } else {
        if(input.action!=='import') throw failure(400,'不支持的 IMA 操作');
        note=selected(input.token,auth,['note','media']);
      }
      async function stage(data,source) {
        if(signal?.aborted) throw failure(409,'已取消 IMA 读取');
        const currentAuth=await loadCredentials();
        if(!currentAuth || identity(currentAuth)!==identity(auth)) throw failure(409,'读取期间 IMA 凭据已变化，请重新加载');
        return imports.create(data,source,baseline);
      }
      let media, remoteSource={platform:'ima',kind:note.kind,clientIdHash:note.clientIdHash,title:note.title,observedAt:note.observedAt,fetchedAt:new Date().toISOString()};
      if(note.kind==='media') {
        media=await request(auth,'get_media_info',{media_id:note.mediaId},signal);
        Object.assign(remoteSource,{libraryId:note.libraryId,libraryTitle:note.libraryTitle,baseType:note.baseType,mediaId:note.mediaId,parentFolderId:note.parentFolderId,mediaType:media.media_type});
        if(media.media_type===11) {
          if(!validText(media.notebook_ext_info?.notebook_id)) throw failure(422,'IMA 未提供此笔记的读取标识');
        } else {
          const format={1:'pdf',3:'docx',7:'md',13:'txt',2:'bin',6:'bin',20:'bin'}[media.media_type];
          if(!format) throw failure(422,'此资料类型尚不能转换，请在 IMA 客户端导出为 Markdown、DOCX、PDF 或 TXT');
          const maximum=['pdf','docx'].includes(format)?16*1024*1024:4*1024*1024;
          const resource=await download(media.url_info,maximum,signal);
          if(!resource.bytes.length || resource.bytes.length>maximum) throw failure(422,'原文为空或超过导入大小限制');
          if(format==='bin' && !['text/html','application/xhtml+xml'].includes(resource.contentType)) throw failure(422,'原网页未返回 HTML 正文，请在 IMA 客户端导出');
          if(format!=='bin' && ['text/html','application/xhtml+xml'].includes(resource.contentType)) throw failure(422,'下载返回了网页而非原文件，请核对访问权限');
          Object.assign(remoteSource,{contentFormat:format==='bin'?'html':format==='txt'?'plaintext':format,resourceHost:resource.host,fetchedAt:new Date().toISOString()});
          if(signal?.aborted) throw failure(409,'已取消 IMA 读取');
          const job=await stage({name:'IMA资料.'+format,title:note.title.slice(0,150),base64:resource.bytes.toString('base64'),category:input.category},remoteSource);
          if(!baseline) selections.delete(input.token); return job;
        }
      }
      const noteId=media?.notebook_ext_info?.notebook_id??note.noteId;
      const data=await request(auth,'get_doc_content',{note_id:noteId,target_content_format:0},signal);
      if(typeof data.content!=='string' || !data.content.trim() || data.content.includes('\0') || Buffer.byteLength(data.content)>4*1024*1024) throw failure(422,'IMA 正文为空、格式无效或超过 4 MiB；未暂存');
      if(signal?.aborted) throw failure(409,'已取消 IMA 读取');
      Object.assign(remoteSource,{noteId,modifiedAt:note.modifiedAt??null,fetchedAt:new Date().toISOString(),contentFormat:'plaintext'});
      const job=await stage({name:'IMA笔记.txt',title:note.title.replace(/[\x00-\x1f]/g,' ').trim().slice(0,150)||'IMA笔记',base64:Buffer.from(data.content).toString('base64'),category:input.category},remoteSource);
      if(!baseline) selections.delete(input.token);
      return job;
    } finally { busy=false; }
  }
  return {state,run};
}
