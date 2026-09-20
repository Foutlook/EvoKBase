import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument, isMap } from 'yaml';
import { createLibrary, failure } from './library.mjs';
import { parseDocument as parseFile } from './formats.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const limit = 4 * 1024 * 1024;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const template = new URL('../templates/knowledge-base/04_系统维护/模板/原始资料卡模板.md', import.meta.url);
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const within = (child, parent) => { const rel = path.relative(parent, child); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
export const safeRelative = value => typeof value === 'string' && value.length <= 220 && value.split('/').every(part => part && !/^[.]|[. ]$|[<>:"\\|?*\[\]\x00-\x1f]/.test(part) && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part));

// Check every existing component before any write, including Windows directory junctions.
export async function plainPath(filename, create = false) {
  let current = path.parse(path.resolve(filename)).root;
  for (const part of path.resolve(filename).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return;
      await fs.mkdir(current); stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink()) throw failure(409, '路径含符号链接或目录联接，已停止');
  }
}
export async function writeJSON(filename, data) {
  const temp = filename + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, filename);
}
export async function createImports(config) {
  if (!config.imports) return null;
  const root = await fs.realpath(config.root), directory = path.resolve(config.imports.directory ?? '');
  if (!path.isAbsolute(config.imports.directory ?? '') || within(directory, root) || within(root, directory) || within(directory, appRoot)) throw Error('导入暂存目录须为知识库和应用仓库之外的绝对路径');
  const resourceRoot = config.imports.resourceRoot;
  if (!safeRelative(resourceRoot) || !resourceRoot.startsWith('00_资源库/')) throw Error('导入目标须为 00_资源库 下的安全相对目录');
  await plainPath(directory, true);
  if (within(await fs.realpath(directory), root) || within(await fs.realpath(directory), appRoot)) throw Error('导入暂存目录越界');
  function jobDirectory(id) {
    if (typeof id !== 'string' || !uuid.test(id)) throw failure(400, '无效导入任务标识');
    return path.join(directory, id);
  }
  async function locked(action) {
    // ponytail: serialize draft changes and publication for this personal instance; no queue daemon.
    const lock = path.join(directory, '.import.lock');
    let handle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw failure(409, '另一个导入操作正在进行，或上次进程中断；请核对导入锁后再恢复'); throw error; }
    await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
    try { return await action(); }
    finally { await handle.close(); await fs.unlink(lock); }
  }
  function target(value) {
    if (!safeRelative(value) || !value.startsWith(resourceRoot + '/')) throw failure(400, '目标必须位于配置的资源目录内，且不能包含特殊路径');
    return value;
  }
  const categoryFor = value => value.slice(resourceRoot.length+1).split('/').slice(0,-1).join('/');
  function category(value) {
    if (typeof value !== 'string' || (value && !safeRelative(value))) throw failure(400,'主题分类须为安全的相对目录，可用 / 分隔层级');
    return value;
  }
  function classifyCard(card, next, previous = '') {
    const front = card.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!front) throw failure(400,'资料卡须保留 YAML 文件头');
    const metadata = parseDocument(front[1],{schema:'core',logLevel:'silent'});
    if (metadata.errors.length || metadata.warnings.length || !isMap(metadata.contents)) throw failure(400,'资料卡文件头须为无重复字段的 YAML 对象');
    const topics = metadata.toJS()?.topics ?? [];
    if (metadata.errors.length || metadata.warnings.length || !Array.isArray(topics) || topics.some(topic=>typeof topic!=='string')) throw failure(400,'资料卡主题须为文字列表，文件头不能有重复或无效字段');
    const parts = next ? next.split('/') : [], old = previous ? previous.split('/') : [];
    metadata.set('topics',[...new Set([...parts,...topics.filter(topic=>!old.includes(topic))])]);
    return '---\n'+metadata.toString()+'---\n'+card.slice(front[0].length);
  }
  function requireCategory(job, card) {
    const selected = categoryFor(job.target);
    if (!selected) throw failure(409,'请先选择主题分类并保存草稿，再进行审核交接或发布');
    const front = card.toString().match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const metadata = front && parseDocument(front[1],{schema:'core',logLevel:'silent'});
    if (!metadata || metadata.errors.length || metadata.warnings.length || !isMap(metadata.contents)) throw failure(409,'资料卡文件头无效，请保存草稿后重新审核');
    const topics = metadata?.toJS()?.topics;
    if (!metadata || metadata.errors.length || metadata.warnings.length || !Array.isArray(topics) || selected.split('/').some(part=>!topics.includes(part))) throw failure(409,'主题分类与资料卡主题不一致，请保存草稿后重新审核');
  }
  async function categories() {
    const found = [], base = path.join(root,resourceRoot); await plainPath(base);
    async function visit(folder, prefix = '') {
      const entries = await fs.readdir(folder,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT') return []; throw error;});
      // A source bundle is a document, not another category; never descend into its images.
      if (entries.some(entry=>entry.name==='原始资料卡.md')) return;
      if (prefix) found.push(prefix);
      for (const entry of entries) if(entry.isDirectory() && !entry.isSymbolicLink() && safeRelative(entry.name)) await visit(path.join(folder,entry.name),prefix?prefix+'/'+entry.name:entry.name);
    }
    await visit(base); return found.sort((a,b)=>a.localeCompare(b,'zh-CN'));
  }
  const outputEntries = job => job.files ? job.files.map(file=>({...file,path:job.target+'/'+(file.name.startsWith('original.')?'原文.'+job.format:file.name==='draft.md'?'原始资料卡.md':file.name==='content.md'?'解析正文.md':file.name)})) : [
    {name:'original.md',path:job.target+'/原文.md',sha256:job.originalHash}, {name:'draft.md',path:job.target+'/原始资料卡.md',sha256:job.cardHash}
  ];
  const outputPaths = job => outputEntries(job).map(file=>file.path);
  async function save(job) { await writeJSON(path.join(jobDirectory(job.id), 'job.json'), job); }
  async function load(id) {
    const folder = jobDirectory(id); await plainPath(folder);
    await plainPath(path.join(folder, 'job.json'));
    const job = JSON.parse(await fs.readFile(path.join(folder, 'job.json'), 'utf8'));
    if (job.id !== id || !job.version || !['draft','writing','files_written','committed','pushed','refresh_failed','complete'].includes(job.stage)) throw failure(409, '导入记录不完整，请人工核对');
    target(job.target);
    if (job.files && (!['pdf','docx','txt','bin'].includes(job.format) || !Array.isArray(job.files) || job.files.length<3 || job.files.length>303 || job.files[0]?.name!=='original.'+job.format || job.files[1]?.name!=='draft.md' || job.files[2]?.name!=='content.md' || job.files.slice(3).some(file=>!/^images\/\d{4}\.(?:png|jpg|jpeg|gif|webp|bin)$/.test(file.name)) || new Set(job.files.map(file=>file.name)).size!==job.files.length)) throw failure(409,'导入产物清单无效');
    const artifacts = [];
    for (const file of outputEntries(job)) {
      const filename = path.join(folder,file.name); await plainPath(filename);
      const maximum = file.name==='draft.md'||file.name==='content.md'||file.name==='original.md'?limit:32*1024*1024;
      if ((await fs.stat(filename)).size>maximum) throw failure(409,'暂存文件超过限制');
      const bytes = await fs.readFile(filename);
      if (digest(bytes)!==file.sha256) throw failure(409,'原件、草稿或附件已变化，旧审核版本失效');
      artifacts.push({...file,bytes});
    }
    const original = artifacts[0].bytes, card = artifacts[1].bytes;
    if (digest(original) !== job.originalHash || digest(card) !== job.cardHash || version(job) !== job.version) throw failure(409, '原件、草稿或路径已变化，旧审核版本失效，请重新建立待审任务');
    return { job, original, card, artifacts };
  }
  function version(job) { return digest(JSON.stringify([job.id,job.originalHash,job.cardHash,...outputPaths(job),...(job.files?[job.files,job.parser,job.warnings]:[]),...(job.remoteSource?[job.remoteSource]:[])])); }
  async function cardFor(job) {
    const date = job.createdAt.slice(0,10);
    const yuque=job.remoteSource?.platform==='yuque';
    const originalLabel=yuque?'语雀 API Markdown 正文快照':job.remoteSource?(job.remoteSource.contentFormat==='plaintext'?'IMA 接口纯文本快照':job.remoteSource.contentFormat==='html'?'网页 HTML 快照（仅下载）':'IMA 下载原件'):'上传的原件';
    const fields = {
      'title: ""':'title: '+JSON.stringify(job.title), 'created: ""':'created: '+JSON.stringify(date), 'updated: ""':'updated: '+JSON.stringify(date),
      'source: []':job.files?'source: ["[[./解析正文]]"]':'source: ["[[./原文]]"]', '# {{title}}':'# '+job.title,
      '- 原始路径或 URL：':'- 原始路径或 URL：'+job.source,
      '- 获取日期：':'- 获取日期：'+date, '- 版本或文件哈希：':'- 版本或文件哈希：SHA256 '+job.originalHash,
      '- 阅读状态：未读 / 部分阅读 / 全文阅读':'- 阅读状态：未读（仅完成自动解析，待人工审核）',
      '- 未读取范围：':'- 未读取范围：'+(job.files?job.warnings.join('；'):yuque?'仅保留语雀 API 返回的 Markdown 正文，非语雀原生文档完整备份；图片、附件、评论、历史版本和外部链接未读取；未开展知识提炼。':'文档中的附件与外部链接未读取；未开展知识提炼。'),
      '- 来源：':job.files?`- 来源：[${originalLabel}](./原文.${job.format})；[[./解析正文|自动解析正文]]`:'- 来源：[[./原文|'+(yuque?originalLabel:job.remoteSource?'IMA 下载的 Markdown 原件':'上传的 Markdown 原件')+']]'
    };
    // Replace original template lines once: user text must not become replacement syntax or another placeholder.
    const card=(await fs.readFile(template,'utf8')).replace(/[^\r\n]+/g,line=>Object.hasOwn(fields,line)?fields[line]:line);
    return job.remoteSource ? card+'\n## 平台读取记录\n\n'+originalLabel+'。转换范围见未读取范围；列表元数据与正文不保证原子一致，获取时间不代表上游修改时间。\n\n```json\n'+JSON.stringify(job.remoteSource,null,2).replace(/`/g,'\\u0060')+'\n```\n' : card;
  }
  function field(value, name, maximum = 500) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f]/.test(value)) throw failure(400, name + '为空、过长或包含控制字符');
    return value.trim();
  }
  async function create(input, remoteSource, baseline) {
    return locked(async () => {
      const name = field(input.name, '文件名', 150);
      if (!(remoteSource?/\.(?:txt|md|docx|pdf|bin)$/i:/\.(?:md|docx|pdf)$/i).test(name) || /[/\\]/.test(name)) throw failure(400, '只接受 Markdown、DOCX 或 PDF；旧 DOC 暂不支持');
      const format = path.extname(name).slice(1).toLowerCase(), maximum = ['md','txt','bin'].includes(format)?limit:16*1024*1024;
      if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(maximum/3)*4) throw failure(400, '上传内容无效或超过文件大小限制');
      const bytes = Buffer.from(input.base64, 'base64');
      if (!bytes.length || bytes.length>maximum || bytes.toString('base64') !== input.base64) throw failure(400, '上传内容编码或大小无效');
      let comparison;
      if (baseline) {
        const {job:previous}=await load(baseline.id);
        if(previous.version!==baseline.version || !['draft','complete'].includes(previous.stage)) throw failure(409,'检查期间原任务已变化，请刷新后重试');
        const sourceKey=source=>JSON.stringify([source?.platform,source?.clientIdHash,source?.kind,source?.libraryId,source?.kind==='media'?source?.mediaId:source?.noteId]);
        if(remoteSource?.platform!=='ima' || sourceKey(previous.remoteSource)!==sourceKey(remoteSource)) throw failure(409,'新旧资料来源不一致，未创建更新草稿');
        const localChanges=[];
        if(previous.stage==='complete') for(const file of outputEntries(previous)) {
          const filename=path.join(root,file.path);
          try {
            await plainPath(filename);
            const stat=await fs.stat(filename);
            if(!stat.isFile() || stat.size>32*1024*1024 || digest(await fs.readFile(filename))!==file.sha256) localChanges.push({path:file.path,status:'modified'});
          } catch(error) {
            if(['ENOENT','ENOTDIR'].includes(error.code)) localChanges.push({path:file.path,status:'missing'});
            else throw error;
          }
        }
        const metadataFields=baseline.metadataFields || [];
        const changes={content:previous.originalHash!==digest(bytes) || (previous.format||'md')!==format,metadata:metadataFields.filter(field=>previous.remoteSource[field]!==remoteSource[field]).map(field=>({field,before:previous.remoteSource[field]??null,after:remoteSource[field]}))};
        comparison={id:previous.id,version:previous.version,originalHash:previous.originalHash,target:previous.target,stage:previous.stage,localChanges,checkedAt:new Date().toISOString(),metadataFields,changes};
        if(!changes.content && !changes.metadata.length) return {changed:false,comparison};
        // ponytail: scan this personal staging directory; add an index only if its size becomes a bottleneck.
        for(const item of await list()) {
          if(item.stage==='invalid') continue;
          const {job}=await load(item.id), prior=job.remoteSource?.updateOf;
          if(prior?.id===previous.id && prior.version===previous.version && job.originalHash===digest(bytes) && (job.format||'md')===format && sourceKey(job.remoteSource)===sourceKey(remoteSource) && metadataFields.every(field=>job.remoteSource[field]===remoteSource[field])) return {changed:true,reused:true,comparison,job:await preview(job.id)};
        }
        remoteSource={...remoteSource,checkScope:metadataFields.length?'original_bytes_and_selected_metadata':'original_bytes_only',updateOf:comparison};
      }
      let text;
      if (format==='md') {
      try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes); } catch { throw failure(422, '文件不是有效 UTF-8；原件未转换或写入知识库'); }
      if (!text.trim() || text.includes('\0') || bytes.length > limit) throw failure(400, 'Markdown 为空、含二进制内容或超过 4 MiB');
      const front = text.replace(/\r\n/g,'\n').match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/);
      if (front) {
        const metadata = parseDocument(front[1],{schema:'core',logLevel:'silent'});
        if (metadata.errors.length || metadata.warnings.length || metadata.has('slug')) throw failure(422,'文件头无效或含固定 slug，无法在新路径下无损索引；请先通过原渠道核对原件');
      }
      }
      let parsed=null;
      if(format==='txt') {
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        if(!text.trim() || text.includes('\0')) throw failure(422,'纯文本快照无效');
        // Keep literal text literal: Markdown-like instructions, links and fences are not interpreted.
        let fence='```'; for(const match of text.matchAll(/`+/g)) if(match[0].length>=fence.length) fence=match[0]+'`';
        parsed={parser:'IMA OpenAPI plaintext',markdown:fence+'text\n'+text+'\n'+fence+'\n',assets:[],warnings:['仅保留 IMA 接口返回的纯文本；富文本排版、图片、附件与外部链接未读取。','上游修改时间来自搜索列表，不代表原子快照版本。']};
      } else if(format!=='md') parsed=await parseFile(bytes,format==='bin'?'html':format,config.imports.python);
      const id = randomUUID(), createdAt = new Date().toISOString();
      const job = {id,createdAt,stage:'draft',name,title:field(input.title || name.slice(0,-format.length-1),'标题',150),source:field(input.source || '本地上传：'+name+'（原路径未提供）','来源'),originalHash:digest(bytes)};
      if(remoteSource) { job.remoteSource=remoteSource; job.source=remoteSource.platform==='yuque'?'语雀文档：'+remoteSource.sourceUrl:'IMA '+(remoteSource.kind==='note'?'笔记':'知识库资料')+'（来源标识与读取时间见平台读取记录；临时下载地址不保存）'; }
      if (parsed) Object.assign(job,{format,parser:parsed.parser,warnings:parsed.warnings,files:[]});
      const segment = job.title.replace(/[<>:"/\\|?*\[\]\x00-\x1f.]/g, '-').slice(0,50).trim() || '资料';
      const selected = category(input.category ?? '');
      job.target = target(input.target || `${resourceRoot}/${selected?selected+'/':''}${createdAt.slice(0,10)}-${segment}-${id.slice(0,8)}`);
      if (input.category !== undefined && categoryFor(job.target)!==selected) throw failure(400,'主题分类与归档目录不一致');
      const card = classifyCard(await cardFor(job),categoryFor(job.target)); job.cardHash = digest(card);
      const artifacts = [{name:'original.'+format,bytes},{name:'draft.md',bytes:Buffer.from(card)}];
      if (parsed) artifacts.push({name:'content.md',bytes:Buffer.from(`[${remoteSource?(format==='txt'?'纯文本快照':format==='bin'?'网页 HTML 快照（仅下载）':'下载原件'):'完整原件'}](./原文.${format})\n\n`+parsed.markdown)},...parsed.assets);
      if(artifacts.some(file=>(file.name==='content.md'||file.name==='draft.md') && file.bytes.length>limit)) throw failure(422,'解析正文或资料卡超过 4 MiB，未暂存');
      if (parsed) job.files = artifacts.map(file=>({name:file.name,sha256:digest(file.bytes)}));
      job.version = version(job);
      const folder = jobDirectory(id); await fs.mkdir(folder);
      for (const file of artifacts) {
        await plainPath(path.dirname(path.join(folder,file.name)),true);
        await fs.writeFile(path.join(folder,file.name),file.bytes,{flag:'wx',mode:0o600});
      }
      await save(job);
      const result=await preview(id);
      return baseline?{changed:true,reused:false,comparison,job:result}:result;
    });
  }
  async function preview(id) {
    const {job,original,card} = await load(id);
    const folder = jobDirectory(id), entries = outputEntries(job);
    const stagedFiles = Object.fromEntries(entries.map(file=>[file.path.slice(job.target.length+1),file.name]));
    const library = await createLibrary({root:folder,include:Object.keys(stagedFiles)},stagedFiles);
    const originalView = await library.document(job.files?'解析正文.md':'原文.md');
    if (job.files && originalView.links.some(link=>link.status!=='resolved')) throw failure(409,'解析附件引用不完整，请核对任务');
    const html = originalView.html.replaceAll('/file?path=',`/api/imports/${id}/file?path=`).replaceAll('href="/?attachment=',`href="/api/imports/${id}/file?path=`);
    let previousSnapshot;
    if(job.remoteSource?.updateOf) {
      const prior=job.remoteSource.updateOf;
      try {
        const previous=await load(prior.id);
        if(previous.job.originalHash!==prior.originalHash) throw Error('changed');
        previousSnapshot={id:prior.id,version:prior.version,currentVersion:previous.job.version,original:(previous.artifacts.find(file=>file.name==='content.md')?.bytes||previous.original).toString('utf8')};
      } catch { previousSnapshot={error:'原任务不可读或摘要已变化，请通过审核交接记录人工核对旧快照。'}; }
    }
    return {...job,...(previousSnapshot?{previousSnapshot}:{}),category:categoryFor(job.target),outputs:entries.map(({path,sha256})=>({path,sha256})),original:job.files?await fs.readFile(path.join(folder,'content.md'),'utf8'):original.toString('utf8'),card:card.toString('utf8'),html,
      originalUrl:`/api/imports/${id}/file?path=${encodeURIComponent('原文.'+(job.format||'md'))}`,warnings:[...(job.warnings||[job.remoteSource?.platform==='yuque'?'语雀 API Markdown 正文快照；图片、附件、评论、历史版本和外链未读取，非原生文档完整备份。':'仅解析本次 Markdown 文字；附件与外链未读取。']),'资料归档不代表知识结论已审核。',...originalView.links.filter(link=>!['resolved','external'].includes(link.status)).map(link=>'未读取链接：'+link.raw)], resourceRoot};
  }
  async function update(id, input) {
    return locked(async () => {
      const {job} = await load(id);
      if (job.stage !== 'draft' || input.version !== job.version) throw failure(409, '任务版本或状态已变化，请刷新后重新审核');
      const previous = categoryFor(job.target), nextTarget = target(input.target);
      if (input.category !== undefined && category(input.category)!==categoryFor(nextTarget)) throw failure(400,'主题分类与归档目录不一致');
      if (typeof input.card !== 'string' || !input.card.trim() || Buffer.byteLength(input.card) > limit || input.card.includes('\0')) throw failure(400, '资料卡草稿无效或超过限制');
      const card = classifyCard(input.card,categoryFor(nextTarget),previous); job.target = nextTarget;
      // Updating a draft changes the reviewed version; approval is never inferred from a status field.
      await fs.writeFile(path.join(jobDirectory(id),'draft.md'),card,'utf8');
      job.cardHash = digest(card); if(job.files) job.files[1].sha256=job.cardHash; job.version = version(job); await save(job);
      return preview(id);
    });
  }
  async function list() {
    const jobs = [];
    for (const name of await fs.readdir(directory)) {
      if (!uuid.test(name)) continue;
      try { const {job} = await load(name); jobs.push({id:job.id,title:job.title,stage:job.stage,createdAt:job.createdAt}); }
      catch { jobs.push({id:name,title:'任务记录需核对',stage:'invalid'}); }
    }
    return jobs.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  }
  async function handoff(id) {
    const {job,card} = await load(id);
    if (job.stage==='draft') requireCategory(job,card);
    const prior=job.remoteSource?.updateOf;
    const updateNote=prior?`\n来源更新候选：对照原任务 ${prior.id}，版本 ${prior.version}，原件 SHA256 ${prior.originalHash}。\n旧目录：${prior.target}\n原任务及本地文件保持不变；这是独立新草稿，不能沿用旧批准或自动覆盖旧资料。\n${prior.metadataFields?.length?"本次同时比对重新选中的同源条目字段："+prior.metadataFields.join("、")+"；列表与原件不保证原子一致。":"本次只比对原件字节，标题与列表元数据未重新核验。"}\n变化记录：${JSON.stringify(prior.changes??{content:true,metadata:[]})}\n检查时本地差异：${prior.localChanges.length?JSON.stringify(prior.localChanges):'未发现已归档文件摘要差异，或原任务尚未发布'}\n请在页面对照前后正文，并在本次审核中决定新旧资料如何保留。\n`:'';
    return `# 资料归档审核交接\n${updateNote}\n任务：${id}\n版本：${job.version}\n暂存：${jobDirectory(id)}\n原件：original.${job.format||'md'}\n资料卡草稿：draft.md\n${job.files?'解析正文：content.md（非原件，未审核）\n解析范围：'+job.warnings.join('；')+'\n':''}\n拟新增文件：\n${outputEntries(job).map(file=>'- '+file.path+'\n  SHA256 '+file.sha256+'；暂存 '+file.name).join('\n')}\n\n请通过既有 Codex 渠道读取原件和草稿，核对来源、敏感内容、链接、阅读范围及重复资料；展示全文或精确差异，取得用户对这个版本及上述文件的归档/提交/既定私库发布确认。需提炼知识结论时仍走原查询与候选评审。网页没有执行或代替评审。\n\n确认后由原渠道在暂存区之外保存批准回执：\n\n\`\`\`json\n${JSON.stringify({taskId:id,version:job.version,decision:'pending',scope:'archive',reviewRef:'填写实际审核与用户确认的可定位记录',reviewedBy:'填写审核人'},null,2)}\n\`\`\`\n\n只有实际完成审核与用户确认，才把 decision 改为 approved。此样例不是审核证据，也不自动授权发布。草稿或目标变化后须重新确认。\n`;
  }
  async function readFile(id,name) {
    const {job,artifacts} = await load(id);
    const file = artifacts.find(file=>file.path.slice(job.target.length+1)===name);
    if (!file) throw failure(404,'附件不在本任务清单内');
    return file.bytes;
  }
  return {root,directory,resourceRoot,create,preview,update,list,handoff,load,save,locked,outputPaths,outputEntries,readFile,categories,requireCategory};
}
