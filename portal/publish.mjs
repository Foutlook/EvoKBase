import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createImports, digest, plainPath } from './imports.mjs';
import { createLibrary, failure } from './library.mjs';
import { createSearch, pathSlug } from './search.mjs';

const execute = promisify(execFile);
async function command(program, args, cwd) {
  try { return (await execute(program,args,{cwd,windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024})).stdout.trimEnd(); }
  catch { throw failure(409, `${program} 操作未完成，请核对本机认证、仓库状态或任务回执后重试；未自动回退文件`); }
}
const git = (store,...args) => command('git',args,store.root);
function settings(config) {
  const value = config.imports?.publish;
  if (!value || !/^[a-z\d][\w.-]*$/i.test(value.remote) || typeof value.remoteUrl !== 'string' || !value.remoteUrl) throw failure(409,'未配置既定 Git 发布通道');
  return value;
}
async function repository(store, config) {
  const publish = settings(config);
  if (path.resolve(await git(store,'rev-parse','--show-toplevel')) !== path.resolve(store.root) || await git(store,'branch','--show-current') !== 'main') throw failure(409,'发布仅允许知识库根目录的 main 分支');
  if (await git(store,'remote','get-url','--all',publish.remote) !== publish.remoteUrl || await git(store,'remote','get-url','--push','--all',publish.remote) !== publish.remoteUrl) throw failure(409,'Git 远程地址已变化或存在多个目标，发布已停止');
  const branch = await git(store,'ls-remote','--exit-code',publish.remote,'refs/heads/main');
  const remoteHead = branch.split(/\s/)[0];
  if (!/^[a-f\d]{40}$/.test(remoteHead)) throw failure(409,'无法核对远程 main 版本');
  return {head:await git(store,'rev-parse','HEAD'),remoteHead,publish};
}
async function clean(store, allowed = []) {
  const status = await git(store,'status','--porcelain=v1','-z','--untracked-files=all');
  const entries = status.split('\0').filter(Boolean);
  if (entries.some(entry=>!allowed.includes(entry.slice(3)) || /[RD]/.test(entry.slice(0,2)))) throw failure(409,'知识库存在非本任务的暂存或未提交改动，请通过原流程处理后重试；未自动整理这些修改');
}
function review(job, approval) {
  if (approval?.taskId !== job.id || approval.version !== job.version || approval.decision !== 'approved' || approval.scope !== 'archive' || typeof approval.reviewRef !== 'string' || !approval.reviewRef.trim() || typeof approval.reviewedBy !== 'string' || !approval.reviewedBy.trim() || /填写/.test(approval.reviewRef+approval.reviewedBy)) throw failure(409,'缺少与当前任务、内容版本一致的实际审核和用户确认回执');
}
async function blobsMatch(store, job, commit) {
  const names = (await git(store,'diff-tree','--no-commit-id','--name-only','-r','-z',commit)).split('\0').filter(Boolean).sort();
  if (JSON.stringify(names) !== JSON.stringify(store.outputPaths(job).sort())) return false;
  for (const file of store.outputEntries(job)) {
    const blob = await git(store,'rev-parse',`${commit}:${file.path}`);
    const expected = await git(store,'hash-object','--no-filters',path.join(store.directory,job.id,file.name));
    if (blob !== expected) return false;
  }
  return true;
}
async function writtenFiles(store, job, bytes) {
  for (const [index,file] of store.outputPaths(job).entries()) {
    const target = path.join(store.root,file); await plainPath(target);
    try {
      if (digest(await fs.readFile(target)) !== digest(bytes[index])) throw failure(409,'本任务正式文件被修改，已停止恢复以保护后续编辑');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!['writing','archiving'].includes(job.stage)) throw failure(409,'本任务正式文件缺失，请人工核对后恢复');
      await plainPath(path.dirname(target),true);
      await fs.writeFile(target,bytes[index],{flag:'wx'});
    }
  }
}

// Local saving uses the same immutable manifest and recovery checks; Git publication remains CLI-only.
export async function archiveImport(store,id,approval) {
  return store.locked(async()=>{
    const {job,artifacts}=await store.load(id); review(job,approval);
    if(!['draft','archiving','archived'].includes(job.stage)) throw failure(409,'此资料已进入同步流程，请核对状态');
    store.requireCategory(job,artifacts[1].bytes);
    if(job.stage==='draft') {
      const target=path.join(store.root,job.target); await plainPath(target);
      try { await fs.lstat(target); throw failure(409,'此位置已有资料，请修改保存位置；不会覆盖原文件'); }
      catch(error) { if(error.code!=='ENOENT') throw error; }
      job.stage='archiving'; job.approval={version:approval.version,reviewRef:approval.reviewRef,reviewedBy:approval.reviewedBy};
      await store.save(job);
    }
    await plainPath(path.join(store.root,job.target),true);
    await writtenFiles(store,job,artifacts.map(file=>file.bytes));
    job.stage='archived'; job.archivedAt??=new Date().toISOString(); await store.save(job);
    return job;
  });
}

export async function commitImport(store, config, id, approval) {
  return store.locked(async()=>{
    const {job,artifacts} = await store.load(id); review(job,approval);
    if (job.commit) return job;
    const {head,remoteHead} = await repository(store,config);
    const files = store.outputPaths(job);
    if (['draft','archived'].includes(job.stage)) {
      store.requireCategory(job,artifacts[1].bytes);
      await clean(store,job.stage==='archived'?files:[]);
      if (head !== remoteHead) throw failure(409,'本地与远程 main 不一致，禁止夹带其他待推送提交');
      await plainPath(path.join(store.root,job.target));
      if(job.stage==='archived') await writtenFiles(store,job,artifacts.map(file=>file.bytes));
      else {
        try { await fs.lstat(path.join(store.root,job.target)); throw failure(409,'目标目录已存在，请修改草稿目标并重新审核；不会覆盖同名资料'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      job.base = head; job.stage = 'writing'; job.approval = {version:approval.version,reviewRef:approval.reviewRef,reviewedBy:approval.reviewedBy};
      await store.save(job);
    } else if (!['writing','files_written'].includes(job.stage)) throw failure(409,'导入阶段不支持提交，请检查任务记录');
    await clean(store,files);
    if (head !== job.base) {
      // Recover a commit that succeeded immediately before a process interruption.
      if (await git(store,'rev-parse','HEAD^') !== job.base || !(await git(store,'log','-1','--format=%B')).includes(`EvoKBase-Import: ${job.id}/${job.version}`) || !await blobsMatch(store,job,head)) throw failure(409,'HEAD 已被其他提交改变，不能自动恢复本任务');
      job.commit = head; job.stage = 'committed'; await store.save(job); return job;
    }
    if (remoteHead !== job.base) throw failure(409,'远程 main 已变化，请人工处理并重新核对发布范围');
    await plainPath(path.join(store.root,job.target),true);
    await writtenFiles(store,job,artifacts.map(file=>file.bytes));
    job.stage = 'files_written'; await store.save(job);
    await git(store,'-c','core.autocrlf=false','add','--',...files);
    const staged = (await git(store,'diff','--cached','--name-only','-z')).split('\0').filter(Boolean).sort();
    if (JSON.stringify(staged) !== JSON.stringify([...files].sort())) throw failure(409,'暂存文件与已确认清单不一致，未提交');
    for (const file of store.outputEntries(job)) {
      if (await git(store,'rev-parse',`:${file.path}`) !== await git(store,'hash-object','--no-filters',path.join(store.directory,id,file.name))) throw failure(409,'Git 属性或过滤器改变了已确认内容，未提交；请人工核对');
    }
    await git(store,'-c','core.autocrlf=false','commit','-m',`归档资料：${job.title}`,'-m',`EvoKBase-Import: ${job.id}/${job.version}`);
    const commit = await git(store,'rev-parse','HEAD');
    if (!await blobsMatch(store,job,commit)) throw failure(409,'提交内容与已确认文件不一致，未推送，请人工检查 Git 属性或钩子');
    job.commit = commit; job.stage = 'committed'; await store.save(job); return job;
  });
}
export async function pushImport(store, config, id, approval) {
  return store.locked(async()=>{
    const {job,artifacts} = await store.load(id); review(job,approval);
    if (!job.commit) throw failure(409,'请先完成本任务的精确提交');
    if (['pushed','refresh_failed','complete'].includes(job.stage)) return job;
    const {head,remoteHead,publish} = await repository(store,config);
    await clean(store); await writtenFiles(store,job,artifacts.map(file=>file.bytes));
    if (head !== job.commit || await git(store,'rev-parse','HEAD^') !== job.base || !await blobsMatch(store,job,head) || ![job.base,job.commit].includes(remoteHead)) throw failure(409,'提交或远程范围发生变化，禁止夹带或覆盖其他提交');
    if (remoteHead !== job.commit) await git(store,'push',publish.remote,`${job.commit}:refs/heads/main`);
    job.stage = 'pushed'; await store.save(job); return job;
  });
}
export function parseReceipt(log, expectedCommit) {
  for (const line of log.split('\n').reverse()) {
    const start = line.indexOf('{'); if (start < 0) continue;
    let data; try { data = JSON.parse(line.slice(start)); } catch { continue; }
    if (!data.requested_sha || !data.stage) continue;
    if (data.requested_sha !== expectedCommit || data.status !== 'success' || data.stage !== 'complete' || data.index_may_be_partial !== false || data.counts?.coverage !== 100 || !/^[a-f\d]{40}$/.test(data.actual_sha) || data.last_success_sha !== data.actual_sha) throw failure(409,'刷新回执未证明成功或索引完整，不能标记完成');
    return data;
  }
  throw failure(409,'工作流日志未提供可核对的固定刷新回执');
}
export async function recoverLock(store, expectedHash) {
  const filename = path.join(store.directory,'.import.lock'); await plainPath(filename);
  const bytes = await fs.readFile(filename), record = JSON.parse(bytes);
  if (digest(bytes) !== expectedHash || !Number.isInteger(record.pid) || record.pid < 1) throw failure(409,'锁记录已变化或无效，不能清理');
  try { process.kill(record.pid,0); }
  catch(error) {
    if (error.code !== 'ESRCH') throw failure(409,'无法确认锁所属进程已结束，保留锁');
    if (digest(await fs.readFile(filename)) !== expectedHash) throw failure(409,'锁记录已变化，保留锁');
    await fs.unlink(filename); return {stage:'lock_recovered'};
  }
  throw failure(409,'锁所属进程仍在运行，不能清理');
}
export async function checkImport(store, config, id, retry = false) {
  return store.locked(async()=>{
    const {job,artifacts} = await store.load(id);
    if (!job.commit || !['pushed','refresh_failed','complete'].includes(job.stage)) throw failure(409,'本任务尚未推送');
    if (job.stage === 'complete') return job;
    const publish = settings(config);
    if (!/^[\w.-]+\/[\w.-]+$/.test(publish.repository || '') || !/^[\w.-]+\.ya?ml$/.test(publish.workflow || '')) throw failure(409,'未配置既定 GitHub 仓库和刷新工作流');
    const gh = (...args)=>command('gh',[...args,'--repo',publish.repository],store.root);
    const runs = JSON.parse(await gh('run','list','--workflow',publish.workflow,'--branch','main','--commit',job.commit,'--limit','10','--json','databaseId,headSha,status,conclusion,url'));
    const run = runs.find(run=>run.headSha === job.commit);
    if (!run) { job.refresh = {status:'waiting',message:'尚未发现此提交的刷新工作流，可稍后检查'}; await store.save(job); return job; }
    job.refresh = run;
    if (retry) {
      if (run.status !== 'completed' || run.conclusion === 'success') throw failure(409,'只能重跑已结束且未成功的同一刷新任务');
      await gh('run','rerun',String(run.databaseId)); job.stage = 'pushed'; job.refresh = {...run,status:'queued',conclusion:null};
    } else if (run.status === 'completed') {
      if (run.conclusion !== 'success') { job.stage = 'refresh_failed'; job.refresh.message = '正文已推送，索引未验收；可核对后重跑同一工作流'; }
      else {
        const receipt = parseReceipt(await gh('run','view',String(run.databaseId),'--log'),job.commit);
        await git(store,'fetch',publish.remote,'main');
        await git(store,'merge-base','--is-ancestor',job.commit,receipt.actual_sha);
        const search = createSearch(config.gbrain,await createLibrary(config));
        await writtenFiles(store,job,artifacts.map(file=>file.bytes));
        for (const file of store.outputEntries(job).filter(file=>file.path.endsWith('.md'))) {
          const indexed = await search.indexed(pathSlug(file.path));
          if (!indexed.local.bodyMatches || indexed.local.version !== file.sha256) throw failure(409,'已收到刷新回执，但原文与已确认资料版本不一致，请核对');
        }
        const hits = await search.search(job.originalHash);
        if (!hits.results.some(hit=>hit.local?.path === store.outputPaths(job)[1])) throw failure(409,'刷新后尚未召回本次资料卡，不能标记完成');
        job.stage = 'complete'; job.receipt = receipt; job.verifiedAt = new Date().toISOString();
      }
    }
    await store.save(job); return job;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action,configPath,id,approvalPath] = process.argv.slice(2);
    if (!['publish','check','retry','unlock'].includes(action) || !configPath || !id || (action === 'publish' && !approvalPath)) throw Error('用法：node publish.mjs publish <配置.json> <任务ID> <已批准回执.json> | check/retry <配置.json> <任务ID> | unlock <配置.json> <锁文件SHA256>');
    const config = JSON.parse(await fs.readFile(configPath,'utf8')), store = await createImports(config);
    if (!store) throw Error('未配置导入模块');
    let job;
    if (action === 'publish') {
      const approval = JSON.parse(await fs.readFile(approvalPath,'utf8'));
      await commitImport(store,config,id,approval); job = await pushImport(store,config,id,approval);
    } else if (action === 'unlock') job = await recoverLock(store,id);
    else job = await checkImport(store,config,id,action === 'retry');
    console.log(JSON.stringify({id:job.id,stage:job.stage,commit:job.commit,refresh:job.refresh,receipt:job.receipt},null,2));
  } catch (error) { console.error(error.status ? error.message : '导入操作未完成，请核对配置、任务记录和本机工具；未自动回退或清理文件'); process.exitCode = 1; }
}
