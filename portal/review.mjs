import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {plainPath,writeJSON} from './imports.mjs';
import {failure} from './library.mjs';
import {archiveImport} from './publish.mjs';

const literal=text=>text.replace(/[\\`*_{}\[\]<>#|]/g,'\\$&').replace(/\r?\n/g,' ');
export function createReview(imports,processing,library) {
  const filename=id=>path.join(imports.directory,id,'review.json');
  async function read(id) {
    await imports.load(id); await plainPath(filename(id));
    try {
      if((await fs.stat(filename(id))).size>8*1024*1024) throw Error();
      const record=JSON.parse(await fs.readFile(filename(id),'utf8'));
      if(record.id!==id || typeof record.token!=='string') throw Error();
      return record;
    } catch(error) { if(error.code==='ENOENT') return null; throw failure(409,'保存预览不可读，请重新检查资料'); }
  }
  async function state(id) {
    if(!imports) return null;
    const {job}=await imports.load(id), record=await read(id);
    if(!record || record.version!==job.version) return null;
    const {baseCard,...visible}=record;
    return {...visible,stage:job.stage,documentUrl:'/?doc='+encodeURIComponent(job.target+'/原始资料卡.md')};
  }
  async function checkReferences(references) {
    for(const ref of references) if((await library.read(ref.path)).version!==ref.version) throw failure(409,'对照的旧知识已经变化，请重新整理后核对');
  }
  async function prepare(id,input) {
    const {job,card}=await imports.load(id), previous=await read(id), data=await processing.state(id);
    if(job.stage!=='draft' || input.version!==job.version) throw failure(409,'资料已变化，请刷新后重新查看');
    const reusable=previous?.version===job.version && previous.runId===data.runId;
    if(!Array.isArray(input.selections) || input.selections.length>3) throw failure(400,'保留内容无效');
    if(['queued','running'].includes(data.status)) throw failure(409,'正在整理，请完成或取消后保存');
    if(input.selections.length && (data.status!=='ready' || (data.stale && !reusable) || input.runId!==data.runId)) throw failure(409,'整理结果已变化，请重新查看');
    const used=new Set();
    const selections=input.selections.map(item=>{
      if(!item || !Number.isInteger(item.index) || used.has(item.index) || !data.result?.candidates[item.index]) throw failure(400,'选择的要点不存在或重复');
      used.add(item.index);
      for(const [field,max] of [['title',160],['claim',3000]]) if(typeof item[field]!=='string' || !item[field].trim() || item[field].length>max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item[field])) throw failure(400,'要点标题或内容为空、过长或包含控制字符');
      return {index:item.index,title:item.title.trim(),claim:item.claim.trim()};
    });
    const selected=selections.map(item=>({...data.result.candidates[item.index],...item}));
    const referenceIds=new Set(selected.flatMap(item=>item.evidence.map(ref=>ref.id)));
    const references=(data.references||[]).filter(ref=>referenceIds.has(ref.id)).map(({id,path,version})=>({id,path,version}));
    await checkReferences(references);
    const baseCard=reusable?previous.baseCard:card.toString('utf8');
    const note=selected.length?'\n\n## 我保留的要点\n\n以下内容由模型辅助整理、用户选择保留，仍需结合原文判断适用范围。\n'+selected.map(item=>`\n### ${literal(item.title)}\n\n${literal(item.claim)}\n\n- 原文依据：${literal(item.sourceQuote)}\n- 与已有知识的比较：${literal(item.reason)}\n`+item.evidence.map(ref=>{const source=data.references.find(source=>source.id===ref.id);return `- 对照来源：${literal(source.path)}；摘录：${literal(ref.quote)}\n`;}).join('')).join(''):'';
    const category=typeof input.category==='string'?input.category.trim():'';
    if(!category) throw failure(400,'请选择保存分类');
    const target=imports.resourceRoot+'/'+category+'/'+job.target.split('/').at(-1);
    const updated=await imports.update(id,{version:job.version,target,category,card:baseCard+note});
    const record={id,token:randomUUID(),version:updated.version,runId:data.runId,baseCard,selections,references,preparedAt:new Date().toISOString()};
    await plainPath(filename(id)); await writeJSON(filename(id),record);
    return {...updated,processing:await processing.state(id),review:await state(id)};
  }
  async function confirm(id,input) {
    const {job}=await imports.load(id), record=await read(id);
    if(input.confirmed!==true || !record || record.version!==job.version || input.version!==job.version || input.token!==record.token) throw failure(409,'请先查看本次保存预览，再确认保存');
    if(job.stage==='draft') await checkReferences(record.references);
    await archiveImport(imports,id,{taskId:id,version:job.version,decision:'approved',scope:'archive',reviewedBy:'本机页面用户',reviewRef:'review.json#'+record.token});
    return {...await imports.preview(id),processing:await processing.state(id),review:await state(id)};
  }
  return {state,prepare,confirm};
}
