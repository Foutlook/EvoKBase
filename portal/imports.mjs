import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { createLibrary, failure } from './library.mjs';

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
  const outputPaths = job => [job.target + '/原文.md', job.target + '/原始资料卡.md'];
  async function save(job) { await writeJSON(path.join(jobDirectory(job.id), 'job.json'), job); }
  async function load(id) {
    const folder = jobDirectory(id); await plainPath(folder);
    for (const name of ['job.json', 'original.md', 'draft.md']) await plainPath(path.join(folder, name));
    const job = JSON.parse(await fs.readFile(path.join(folder, 'job.json'), 'utf8'));
    if (job.id !== id || !job.version || !['draft','writing','files_written','committed','pushed','refresh_failed','complete'].includes(job.stage)) throw failure(409, '导入记录不完整，请人工核对');
    target(job.target);
    const original = await fs.readFile(path.join(folder, 'original.md')), card = await fs.readFile(path.join(folder, 'draft.md'));
    if (original.length > limit || card.length > limit || digest(original) !== job.originalHash || digest(card) !== job.cardHash || version(job) !== job.version) throw failure(409, '原件、草稿或路径已变化，旧审核版本失效，请重新建立待审任务');
    return { job, original, card };
  }
  function version(job) { return digest(JSON.stringify([job.id,job.originalHash,job.cardHash,...outputPaths(job)])); }
  async function cardFor(job) {
    const date = job.createdAt.slice(0,10);
    const fields = {
      'title: ""':'title: '+JSON.stringify(job.title), 'created: ""':'created: '+JSON.stringify(date), 'updated: ""':'updated: '+JSON.stringify(date),
      'source: []':'source: ["[[./原文]]"]', '# {{title}}':'# '+job.title,
      '- 原始路径或 URL：':'- 原始路径或 URL：'+job.source,
      '- 获取日期：':'- 获取日期：'+date, '- 版本或文件哈希：':'- 版本或文件哈希：SHA256 '+job.originalHash,
      '- 阅读状态：未读 / 部分阅读 / 全文阅读':'- 阅读状态：未读（仅完成 UTF-8 文本解析，待人工审核）',
      '- 未读取范围：':'- 未读取范围：文档中的附件与外部链接未读取；未开展知识提炼。',
      '- 来源：':'- 来源：[[./原文|上传的 Markdown 原件]]'
    };
    // Replace original template lines once: user text must not become replacement syntax or another placeholder.
    return (await fs.readFile(template,'utf8')).replace(/[^\r\n]+/g,line=>Object.hasOwn(fields,line)?fields[line]:line);
  }
  function field(value, name, maximum = 500) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f]/.test(value)) throw failure(400, name + '为空、过长或包含控制字符');
    return value.trim();
  }
  async function create(input) {
    return locked(async () => {
      const name = field(input.name, '文件名', 150);
      if (!/\.md$/i.test(name) || /[/\\]/.test(name)) throw failure(400, '首版只接受单个 Markdown 文件');
      if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(limit/3)*4) throw failure(400, '上传内容无效或超过 4 MiB');
      const bytes = Buffer.from(input.base64, 'base64');
      if (bytes.toString('base64') !== input.base64) throw failure(400, '上传内容编码无效');
      let text;
      try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes); } catch { throw failure(422, '文件不是有效 UTF-8；原件未转换或写入知识库'); }
      if (!text.trim() || text.includes('\0') || bytes.length > limit) throw failure(400, 'Markdown 为空、含二进制内容或超过 4 MiB');
      const front = text.replace(/\r\n/g,'\n').match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/);
      if (front) {
        const metadata = parseDocument(front[1],{schema:'core',logLevel:'silent'});
        if (metadata.errors.length || metadata.warnings.length || metadata.has('slug')) throw failure(422,'文件头无效或含固定 slug，无法在新路径下无损索引；请先通过原渠道核对原件');
      }
      const id = randomUUID(), createdAt = new Date().toISOString();
      const job = {id,createdAt,stage:'draft',name,title:field(input.title || name.slice(0,-3),'标题',150),source:field(input.source || '本地上传：'+name+'（原路径未提供）','来源'),originalHash:digest(bytes)};
      const segment = job.title.replace(/[<>:"/\\|?*\[\]\x00-\x1f.]/g, '-').slice(0,50).trim() || '资料';
      job.target = target(input.target || `${resourceRoot}/${createdAt.slice(0,10)}-${segment}-${id.slice(0,8)}`);
      const card = await cardFor(job); job.cardHash = digest(card); job.version = version(job);
      const folder = jobDirectory(id); await fs.mkdir(folder);
      await fs.writeFile(path.join(folder,'original.md'),bytes,{flag:'wx',mode:0o600});
      await fs.writeFile(path.join(folder,'draft.md'),card,{flag:'wx',mode:0o600});
      await save(job); return preview(id);
    });
  }
  async function preview(id) {
    const {job,original,card} = await load(id);
    const library = await createLibrary({root:jobDirectory(id),include:['original.md','draft.md']});
    const originalView = await library.document('original.md');
    return {...job,outputs:outputPaths(job).map((file,index)=>({path:file,sha256:index?job.cardHash:job.originalHash})),original:original.toString('utf8'),card:card.toString('utf8'),html:originalView.html,
      warnings:['仅解析本次 Markdown 文字；附件与外链未读取。','资料归档不代表知识结论已审核。',...originalView.links.filter(link=>!['resolved','external'].includes(link.status)).map(link=>'未读取链接：'+link.raw)], resourceRoot};
  }
  async function update(id, input) {
    return locked(async () => {
      const {job} = await load(id);
      if (job.stage !== 'draft' || input.version !== job.version) throw failure(409, '任务版本或状态已变化，请刷新后重新审核');
      job.target = target(input.target);
      if (typeof input.card !== 'string' || !input.card.trim() || Buffer.byteLength(input.card) > limit || input.card.includes('\0')) throw failure(400, '资料卡草稿无效或超过限制');
      // Updating a draft changes the reviewed version; approval is never inferred from a status field.
      await fs.writeFile(path.join(jobDirectory(id),'draft.md'),input.card,'utf8');
      job.cardHash = digest(input.card); job.version = version(job); await save(job);
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
    const {job} = await load(id);
    return `# Markdown 资料归档审核交接\n\n任务：${id}\n版本：${job.version}\n暂存：${jobDirectory(id)}\n原件：original.md\n资料卡草稿：draft.md\n\n拟新增文件：\n${outputPaths(job).map(file=>'- '+file).join('\n')}\n\n请通过既有 Codex 渠道读取原件和草稿，核对来源、敏感内容、链接、阅读范围及重复资料；展示全文或精确差异，取得用户对这个版本及上述文件的归档/提交/既定私库发布确认。需提炼知识结论时仍走原查询与候选评审。网页没有执行或代替评审。\n\n确认后由原渠道在暂存区之外保存批准回执：\n\n\`\`\`json\n${JSON.stringify({taskId:id,version:job.version,decision:'pending',scope:'archive',reviewRef:'填写实际审核与用户确认的可定位记录',reviewedBy:'填写审核人'},null,2)}\n\`\`\`\n\n只有实际完成审核与用户确认，才把 decision 改为 approved。此样例不是审核证据，也不自动授权发布。草稿或目标变化后须重新确认。\n`;
  }
  return {root,directory,resourceRoot,create,preview,update,list,handoff,load,save,locked,outputPaths};
}
