import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {failure} from './library.mjs';

function publicIPv4(address) {
  if(isIP(address)!==4) return false;
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99))) || (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
}

export async function downloadIma(info, maximum, signal, {resolve=lookup,request=https.request,redirects=0}={}) {
  const lookupAddress=resolve;
  let url;
  try { url=new URL(info?.url); } catch { throw failure(422,'IMA 未提供可读取的原文地址，请在 IMA 客户端导出'); }
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') || isIP(url.hostname) || url.hostname.endsWith('.')) throw failure(422,'原文地址不符合安全下载要求，请使用 IMA 客户端导出');
  const headers={};
  if(info.headers!==undefined && (!info.headers || typeof info.headers!=='object' || Array.isArray(info.headers))) throw failure(422,'原文下载凭据格式无效');
  for(const [key,value] of Object.entries(info.headers||{})) {
    // Signed resource headers belong only to IMA's resource host; never attach the OpenAPI keys.
    if(url.hostname!=='res-pkb.ima.qq.com' || !/^x-ima-(?:create-url-time|platform|resource-category|sign|trace-id|uid-sha256)$/i.test(key) || typeof value!=='string' || !/^[\x20-\x7e]{0,4096}$/.test(value)) throw failure(422,'下载地址或认证头尚未支持，请使用 IMA 客户端导出');
    headers[key]=value;
  }
  const timeout=AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]);
  try {
    // Fixed official origins have an exact hostname allowlist and normal TLS verification, like the OpenAPI endpoint.
    // Keep the system resolver for them so an installed proxy's fake-IP DNS still works; arbitrary origins use public-IP pinning.
    const official=['res-pkb.ima.qq.com','mp.weixin.qq.com'].includes(url.hostname);
    // Pin a verified public IPv4 address, so DNS rebinding cannot reach loopback or LAN services.
    // ponytail: IPv6-only origins require manual export until a public IPv6 policy is needed.
    const addresses=official?null:await Promise.race([resolve(url.hostname,{family:4,all:true}),new Promise((_,reject)=>{
      if(timeout.aborted) reject(timeout.reason);
      else timeout.addEventListener('abort',()=>reject(timeout.reason),{once:true});
    })]);
    if(addresses && (!addresses.length || addresses.some(item=>!publicIPv4(item.address)))) throw failure(422,'原文域名解析到非公开地址，已停止下载');
    timeout.throwIfAborted();
    return await new Promise((resolve,reject)=>{
      const req=request(url,{method:'GET',headers,agent:false,family:4,signal:timeout,...(addresses?{lookup:(_host,_options,done)=>done(null,addresses[0].address,4)}:{})},res=>{
        if([301,302,303,307,308].includes(res.statusCode) && !Object.keys(headers).length && redirects<2) {
          let target; try { target=new URL(res.headers.location,url); } catch { /* Reject an unusable redirect below. */ }
          if(res.headers.location && target?.origin===url.origin) {
            res.destroy();
            resolve(downloadIma({url:target.href},maximum,timeout,{resolve:lookupAddress,request,redirects:redirects+1})); return;
          }
        }
        if(res.statusCode!==200) { res.destroy(); reject(failure(422,'原文下载失败或要求跳转/登录，请在 IMA 客户端导出')); return; }
        if(Number(res.headers['content-length'])>maximum) { res.destroy(); reject(failure(413,'原文超过导入大小限制')); return; }
        const chunks=[]; let size=0;
        res.on('data',chunk=>{
          size+=chunk.length;
          if(size>maximum) { res.destroy(); reject(failure(413,'原文超过导入大小限制')); }
          else chunks.push(chunk);
        });
        res.on('error',reject);
        res.on('end',()=>resolve({bytes:Buffer.concat(chunks),contentType:String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase(),host:url.hostname}));
      });
      req.on('error',reject); req.end();
    });
  } catch(error) {
    if(error.status) throw error;
    throw failure(502,signal?.aborted?'已取消原文下载':'原文下载不可用或超时，请在 IMA 客户端导出');
  }
}
