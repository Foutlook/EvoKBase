import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {failure} from './library.mjs';

export function parseDocument(bytes, format, python = 'python') {
  return new Promise((resolve,reject)=>{
    // ponytail: one bounded local child per import; a worker pool only if measured throughput needs it.
    const child = execFile(python,['-I',fileURLToPath(new URL('./parse_document.py',import.meta.url))],{windowsHide:true,timeout:45000,maxBuffer:64*1024*1024},(error,stdout)=>{
      let result; try { result = JSON.parse(stdout); } catch { /* Return a bounded error, never raw parser logs. */ }
      if (error || result?.error) return reject(failure(422,result?.error || '格式解析不可用、超时或超过限制，请核对 Python 与解析依赖；原件未写入知识库'));
      if (typeof result?.markdown !== 'string' || Buffer.byteLength(result.markdown)>4*1024*1024 || !Array.isArray(result.assets) || result.assets.length>300 || !Array.isArray(result.warnings) || !result.warnings.every(w=>typeof w==='string')) return reject(failure(422,'解析结果格式或大小不符合约定'));
      let total = 0;
      const names = new Set();
      for (const asset of result.assets) {
        if (!/^images\/\d{4}\.(?:png|jpg|jpeg|gif|webp|bin)$/.test(asset.name) || names.has(asset.name) || typeof asset.base64 !== 'string') return reject(failure(422,'解析附件路径无效'));
        names.add(asset.name); asset.bytes = Buffer.from(asset.base64,'base64'); total += asset.bytes.length;
        if (asset.bytes.toString('base64') !== asset.base64 || total>32*1024*1024) return reject(failure(422,'解析附件大小或编码无效'));
        delete asset.base64;
      }
      resolve(result);
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({format,base64:bytes.toString('base64')}));
  });
}
