import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {plainPath,writeJSON,digest} from './imports.mjs';
import {failure} from './library.mjs';
import {providers,discover,runHarness} from './harness.mjs';

export function createModels(config) {
  const settings=config.harnesses, filename=settings?.file;
  let busy=false;
  async function load(create=false) {
    const roots=[config.root,config.imports?.directory,fileURLToPath(new URL('../',import.meta.url))].filter(Boolean);
    if(!path.isAbsolute(filename??'') || path.extname(filename)!=='.json' || roots.some(root=>{const rel=path.relative(root,filename);return !rel || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel));})) throw failure(503,'Harness 配置文件须位于知识库、暂存区和应用仓库之外');
    await plainPath(path.dirname(filename),create);await plainPath(filename);
    try {
      if((await fs.stat(filename)).size>16384) throw Error();
      const data=JSON.parse(await fs.readFile(filename,'utf8'));
      if(data.schemaVersion!==1 || typeof data.version!=='string' || (data.selected!==null && !providers.some(p=>p.id===data.selected)) || Object.keys(data).some(key=>!['schemaVersion','version','selected'].includes(key))) throw Error();
      return data;
    } catch(error) {
      if(error.code==='ENOENT') return {schemaVersion:1,version:'new',selected:null};
      throw failure(503,'Harness 配置不可读，未覆盖现有文件');
    }
  }
  async function snapshot(create=false) {
    const data=await load(create), runtimes=await Promise.all(providers.map(p=>discover(p,settings.commands?.[p.id])));
    const version=digest(JSON.stringify([data.version,...runtimes.map(p=>p.runtimeId??null)]));
    return {data,runtimes,visible:{enabled:true,version,selected:data.selected,providers:runtimes.map(({launch,...p})=>p)}};
  }
  async function state() {return filename?(await snapshot()).visible:{enabled:false,providers};}
  async function save(input) {
    if(busy) throw failure(409,'Harness 正在运行，请完成或取消后切换');
    if(input.action!=='save' || !providers.some(p=>p.id===input.provider) || Object.keys(input).some(key=>!['action','version','provider'].includes(key))) throw failure(400,'请选择本地 Harness；API 配置已停用');
    await load(true);await plainPath(filename+'.lock');
    let lock;
    try {lock=await fs.open(filename+'.lock','wx',0o600);} catch(error) {if(error.code==='EEXIST')throw failure(409,'另一个配置保存正在进行');throw error;}
    try {
      const {data,visible,runtimes}=await snapshot();
      if(input.version!==visible.version) throw failure(409,'配置或本地程序已变化，请刷新后重试');
      const runtime=runtimes.find(p=>p.id===input.provider);
      if(!runtime.available) throw failure(409,runtime.message);
      data.selected=input.provider;data.version=randomUUID();await writeJSON(filename,data);
      return (await snapshot()).visible;
    } finally {await lock.close();await fs.unlink(filename+'.lock');}
  }
  async function generate(input,messages,signal,timeoutMs) {
    if(busy) throw failure(409,'已有 Harness 请求正在进行');
    busy=true;
    try {
      const {visible,runtimes}=await snapshot();
      if(input.version!==visible.version || input.provider!==visible.selected) throw failure(409,'Harness 配置已变化，请重新确认');
      const runtime=runtimes.find(p=>p.id===input.provider);
      if(!runtime?.available) throw failure(409,runtime?.message||'请先选择本地 Harness');
      const result=await runHarness(runtime,messages,settings,signal,timeoutMs);
      if((await snapshot()).visible.version!==visible.version) throw failure(409,'运行期间 Harness 配置发生变化，结果未采用');
      return result;
    } finally {busy=false;}
  }
  async function test(input,signal) {
    const start=Date.now();
    const text=await generate(input,[{role:'user',content:'这是一项连接测试。不要调用任何工具，只回复 OK。'}],signal);
    if(text.trim()!=='OK') throw failure(502,'Harness 已返回，但未通过固定文字测试，请核对本地配置');
    return {status:'connected',elapsedMs:Date.now()-start};
  }
  return {state,save,test,generate};
}
