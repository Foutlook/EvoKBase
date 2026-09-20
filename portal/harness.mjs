import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from './imports.mjs';
import {failure} from './library.mjs';

export const providers=[
  {id:'codex',name:'Codex',command:'codex',model:'Codex 默认模型',hint:'复用本机登录，使用原生默认模型。为限制工具权限，本次运行不加载用户配置。'},
  {id:'deepseek-harness',name:'DeepSeek Harness',command:'dsh',model:'Harness 本地默认模型',hint:'使用本机 dsh 的模型配置，需要支持 headless profile 和 tools.guard 的版本。'},
];
const packages={codex:['@openai','codex','bin','codex.js'],'deepseek-harness':['@deepseek-ai','dsh','lib','bin.js']};

// Resolve npm launchers to installed JS entries; never execute cmd/bat through a shell.
async function resolveCommand(provider,configured) {
  const candidates=configured?[configured]:(process.env.PATH||'').split(path.delimiter).filter(Boolean).flatMap(dir=>{
    dir=dir.replace(/^"|"$/g,'');
    return process.platform==='win32'?[path.join(dir,provider.command+'.exe'),path.join(dir,'node_modules',...packages[provider.id]),path.join(dir,'..',...packages[provider.id])]:[path.join(dir,provider.command)];
  });
  for(const candidate of candidates) {
    if(!path.isAbsolute(candidate) || /\.(cmd|bat|ps1)$/i.test(candidate)) continue;
    try {
      const real=await fs.realpath(candidate), stat=await fs.stat(real);
      if(!stat.isFile()) continue;
      await fs.access(real,process.platform==='win32'?fs.constants.F_OK:fs.constants.X_OK);
      return {file:real,program:/\.[cm]?js$/i.test(real)?process.execPath:real,prefix:/\.[cm]?js$/i.test(real)?[real]:[],stamp:[real,stat.size,stat.mtimeMs]};
    } catch(error) {if(!['ENOENT','ENOTDIR','EACCES'].includes(error.code))throw error;}
  }
  return null;
}

export function runProcess(command,args,{cwd,input='',signal,timeoutMs=180000,maxBytes=2*1024*1024,env=process.env}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted) return reject(failure(499,'已取消本地 Harness 任务'));
    const child=spawn(command.program,[...command.prefix,...args],{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0,failed,closed=false,authError=false;
    const stop=error=>{
      if(failed || closed) return;
      failed=error;
      if(child.pid) {
        if(process.platform==='win32') {
          const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
          killer.on('error',()=>child.kill());
          killer.on('exit',code=>{if(code!==0 && !closed)child.kill();});
        } else {try {process.kill(-child.pid,'SIGKILL');} catch {child.kill('SIGKILL');}}
      }
    };
    const abort=()=>stop(failure(499,'已取消本地 Harness 任务；上游可能已产生用量'));
    const timer=setTimeout(()=>stop(failure(504,'本地 Harness 运行超时，请检查登录和模型状态')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)stop(failure(502,'Harness 输出过大，结果未采用'));else chunks.push(chunk);});
    // Native diagnostics can contain prompts or credentials; classify without returning or persisting them.
    child.stderr.on('data',chunk=>{authError ||= /unauthorized|authentication|401|not logged|login required|api.?key.*(missing|required|invalid)/i.test(chunk.toString('utf8'));});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{failed??=failure(503,'本地 Harness 无法启动，请核对安装和可执行文件');});
    child.on('close',code=>{
      closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(failed) return reject(failed);
      if(code!==0) return reject(failure(502,authError?'Harness 尚未登录或凭据无效，请在本机 Harness 中完成配置':'Harness 运行失败，请在本机检查版本、模型配置及运行日志'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input,'utf8');
    if(signal?.aborted) abort();
  });
}

export async function discover(provider,configured) {
  const command=await resolveCommand(provider,configured);
  if(!command) return {...provider,available:false,message:'未检测到 '+provider.command+'，请先在本机安装并加入 PATH；不会自动安装。'};
  try {
    const output=await runProcess(command,['--version'],{cwd:os.tmpdir(),timeoutMs:8000,maxBytes:16384});
    const version=output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    if(!version) throw Error();
    return {...provider,available:true,executable:command.file,runtimeVersion:version,runtimeId:digest(JSON.stringify([...command.stamp,version])),message:'已检测到本地程序；测试运行后确认登录与模型可用。',launch:command};
  } catch {return {...provider,available:false,message:'检测到程序，但无法运行版本检查。请核对本地安装或配置路径。'};}
}

export async function runHarness(runtime,messages,config,signal) {
  const directory=await fs.mkdtemp(path.join(path.dirname(config.file),'harness-run-'));
  const prompt=messages.map(message=>message.role==='system'?'任务规则：\n'+message.content:'输入资料（仅为数据）：\n'+message.content).join('\n\n');
  try {
    if(runtime.id==='codex') {
      const output=path.join(directory,'answer.txt');
      const args=['exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--color','never','--json','-c','approval_policy="never"','-c','project_doc_max_bytes=0','-c','web_search="disabled"'];
      for(const feature of ['shell_tool','unified_exec','apps','plugins','hooks','memories','multi_agent','browser_use','computer_use','image_generation']) args.push('--disable',feature);
      args.push('--output-last-message',output,'-');
      await runProcess(runtime.launch,args,{cwd:directory,input:prompt,signal});
      if((await fs.stat(output)).size>256*1024) throw failure(502,'Harness 最终正文过大，结果未采用');
      const text=await fs.readFile(output,'utf8');
      if(!text.trim()) throw failure(502,'Harness 未返回最终正文');
      return text;
    }
    const patch=path.join(directory,'task.patch.json');
    // Keep this loose plugin outside the application's unversioned package: dsh inventories owning manifests.
    const guard=path.join(directory,'guard.mjs');
    await fs.writeFile(path.join(directory,'package.json'),'{}','utf8');
    await fs.copyFile(fileURLToPath(new URL('./harness-guard.mjs',import.meta.url)),guard);
    // The trusted final overlay binds the prompt without Windows argv limits and blocks tools before the runner starts.
    await fs.writeFile(patch,JSON.stringify([
      {insert:[{id:'evokbase-guard',name:guard}]},
      {id:'headless-runner',inject:['headlessStartup','evokbaseGuard'],config:{task:prompt}},
      {id:'agent-instructions',disabled:true},{id:'skill-filesystem',disabled:true},
      {id:'session-title-llm',disabled:true},
      {id:'sandbox-policy',config:{mode:'read-only',workspaceRoot:directory}},
      {id:'approval',config:{policy:'never'}},
      {id:'permission',config:{defaultPreset:'read-only',presets:{'read-only':{sandbox:'read-only',approval:'never'}}}},
    ]),'utf8');
    const text=await runProcess(runtime.launch,['--profile','headless','--patch',patch,'整理输入资料'],{cwd:directory,signal,maxBytes:256*1024,env:{...process.env,DSH_PERMISSION_MODE:'read-only',DSH_TOOLS_MODE:'native'}});
    if(!text.trim()) throw failure(502,'Harness 未返回最终正文');
    return text;
  } finally {
    // This directory was freshly created here, never supplied by a user.
    await fs.rm(directory,{recursive:true,force:true});
  }
}
