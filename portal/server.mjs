import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLibrary, types, failure } from './library.mjs';
import { createSearch } from './search.mjs';
import { createImports } from './imports.mjs';
import { createModels } from './models.mjs';
import { createIma } from './ima.mjs';
import { createYuque } from './yuque.mjs';
import { createProcessing } from './processing.mjs';
import { createReview } from './review.mjs';

const web = fileURLToPath(new URL('./web/', import.meta.url));
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/graph.js': ['graph.js', 'text/javascript'], '/imports.js': ['imports.js', 'text/javascript'], '/models.js': ['models.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/vendor/d3.min.js': ['../node_modules/d3/dist/d3.min.js', 'text/javascript'], '/vendor/d3.LICENSE': ['../node_modules/d3/LICENSE', 'text/plain'] };
export async function startPortal(config, port = 4317) {
  const library = await createLibrary(config);
  const search = createSearch(config.gbrain, library);
  const imports = await createImports(config);
  const models = createModels(config);
  const ima = createIma(imports);
  const yuque = createYuque(imports);
  const processing = createProcessing(imports,models,search,library);
  const review = createReview(imports,processing,library);
  async function afterImport(result,input) {
    const job=result.changed?result.job:result.id?result:null;
    if(job && input.processing) {
      try { job.processing=await processing.enqueue(job.id,{...input.processing,sourceVersion:job.version}); }
      catch(error) {
        job.processingError=error.status?error.message:'自动处理未启动，资料已暂存';
        try { job.processing=await processing.failed(job.id,job.processingError); }
        catch { job.processing={status:'failed',error:job.processingError+'；处理状态未能保存，请刷新核对。'}; }
      }
    }
    return result;
  }
  const server = http.createServer(async (req, res) => {
    const authority = `127.0.0.1:${server.address().port}`;
    const origin = `http://${authority}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    function send(status, type, body) { res.writeHead(status, { 'Content-Type': type }); res.end(body); }
    try {
      if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, '仅允许本机同源访问');
      const url = new URL(req.url, origin);
      const modelRoute = /^\/api\/models(?:\/test)?$/.test(url.pathname);
      const imaRoute = url.pathname === '/api/ima';
      const yuqueRoute = url.pathname === '/api/yuque';
      const processingRoute = /^\/api\/imports\/[a-f\d-]+\/processing$/.test(url.pathname);
      const reviewRoute = /^\/api\/imports\/[a-f\d-]+\/review$/.test(url.pathname);
      if (req.method === 'POST' && (modelRoute || imaRoute || yuqueRoute || processingRoute || reviewRoute || (imports && /^\/api\/imports(?:\/[a-f\d-]+)?$/.test(url.pathname)))) {
        if (req.headers.origin !== origin || req.headers['x-evokbase-request'] !== '1' || req.headers['content-type'] !== 'application/json') throw failure(403,'写入只接受本机页面的明确操作');
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > (reviewRoute?64*1024:modelRoute||imaRoute||yuqueRoute||processingRoute?16*1024:23*1024*1024)) throw failure(413,'请求超过大小限制'); chunks.push(chunk); }
        let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(400,'请求不是有效 JSON'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure(400,'请求无效');
        if(reviewRoute) {
          if(!imports) throw failure(503,'未启用资料导入');
          if(!['prepare','confirm'].includes(input.action)) throw failure(400,'不支持的保存操作');
          return send(200,'application/json; charset=utf-8',JSON.stringify(await review[input.action](url.pathname.split('/')[3],input)));
        }
        if(processingRoute) {
          const id=url.pathname.split('/')[3];
          if(!['start','cancel'].includes(input.action)) throw failure(400,'不支持的处理操作');
          const result=input.action==='cancel'?await processing.cancel(id):await processing.enqueue(id,input);
          return send(200,'application/json; charset=utf-8',JSON.stringify(result));
        }
        if (modelRoute || imaRoute || yuqueRoute) {
          const controller = new AbortController();
          const cancel = () => { if (!res.writableEnded) controller.abort(); };
          res.once('close', cancel);
          if(res.destroyed) controller.abort();
          try {
            const data = yuqueRoute ? await yuque.run(input,controller.signal) : imaRoute ? await ima.run(input,controller.signal) : url.pathname.endsWith('/test') ? await models.test(input,controller.signal) : await models.save(input);
            return send(200,'application/json; charset=utf-8',JSON.stringify(imaRoute || yuqueRoute?await afterImport(data,input):data));
          } finally { res.removeListener('close',cancel); }
        }
        const id = url.pathname.split('/')[3];
        const result = id ? await imports.update(id,input) : await imports.create(input);
        if(id) result.processing=await processing.state(id);
        return send(200,'application/json; charset=utf-8',JSON.stringify(id?result:await afterImport(result,input)));
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw failure(405, '只读入口；导入暂存仅允许专用入口'); }
      if (assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        return send(200, type + '; charset=utf-8', req.method === 'HEAD' ? '' : await fs.readFile(path.join(web, file)));
      }
      let result;
      if (url.pathname === '/api/models') result = await models.state();
      else if (reviewRoute) result = await review.state(url.pathname.split('/')[3]);
      else if (processingRoute) result = await processing.state(url.pathname.split('/')[3]);
      else if (imaRoute) result = await ima.state();
      else if (yuqueRoute) result = await yuque.state();
      else if (url.pathname === '/api/tree') result = await library.list();
      else if (/^\/api\/imports\/[a-f\d-]+\/file$/.test(url.pathname)) {
        if (!imports) throw failure(503,'未配置导入暂存目录');
        const file = url.searchParams.get('path');
        const bytes = await imports.readFile(url.pathname.split('/')[3],file);
        const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.setHeader('Content-Disposition',`${type.startsWith('image/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file)).replace(/'/g,'%27')}`);
        return send(200,type,req.method==='HEAD'?'':bytes);
      }
      else if (url.pathname === '/api/imports') result = {enabled:Boolean(imports),jobs:imports?await imports.list():[],categories:imports?await imports.categories():[],resourceRoot:imports?.resourceRoot};
      else if (/^\/api\/imports\/[a-f\d-]+(?:\/handoff)?$/.test(url.pathname)) {
        if (!imports) throw failure(503,'未配置导入暂存目录');
        const id = url.pathname.split('/')[3];
        if (url.pathname.endsWith('/handoff')) {
          res.setHeader('Content-Disposition',`attachment; filename="review-${id}.md"`);
          return send(200,'text/markdown; charset=utf-8',await imports.handoff(id));
        }
        result = {...await imports.preview(id),processing:await processing.state(id),review:await review.state(id)};
      }
      else if (url.pathname === '/api/search') result = await search.search(url.searchParams.get('q'));
      else if (url.pathname === '/api/search/page') result = await search.indexed(url.searchParams.get('slug'));
      else if (url.pathname === '/api/graph') result = await library.graph(url.searchParams.get('path') ?? undefined);
      else if (url.pathname === '/api/document') result = await library.document(url.searchParams.get('path'));
      else if (url.pathname === '/api/attachment') {
        const file = url.searchParams.get('path');
        const data = await library.read(file);
        result = { path: file, type: types[path.extname(file).toLowerCase()], size: data.bytes.length, version: data.version };
      }
      else if (url.pathname === '/file') {
        const file = url.searchParams.get('path');
        if (!file) throw failure(400, '缺少文件路径');
        const data = await library.read(file);
        const type = types[path.extname(file).toLowerCase()];
        // Active formats (HTML/SVG/scripts) never enter the allowlist. Office files download only.
        const inline = url.searchParams.get('download') !== '1' && (type.startsWith('image/') || type === 'application/pdf' || type === 'text/plain');
        res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file)).replace(/'/g, '%27')}`);
        return send(200, type + (type === 'text/plain' ? '; charset=utf-8' : ''), req.method === 'HEAD' ? '' : data.bytes);
      } else throw failure(404, '入口不存在');
      send(200, 'application/json; charset=utf-8', req.method === 'HEAD' ? '' : JSON.stringify(result));
    } catch (error) {
      const status = error.status ?? (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : error.code === 'EACCES' ? 403 : 500);
      send(status, 'application/json; charset=utf-8', JSON.stringify({ error: error.status ? error.message : status === 404 ? '文件不存在' : '文件不可读，请核对所选路径' }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  server.once('close',()=>processing.stop());
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args[0] !== '--config' || (args.length !== 2 && (args.length !== 4 || args[2] !== '--port'))) throw Error('用法：node server.mjs --config <仓库外的配置.json> [--port 4317]');
    const port = args[3] === undefined ? 4317 : Number(args[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('端口必须为 1—65535');
    const config = JSON.parse(await fs.readFile(args[1], 'utf8'));
    if (config.models === undefined) config.models = {file:path.resolve(args[1])+'.models.json'};
    const server = await startPortal(config, port);
    console.log(`EvoKBase 只读门户：http://127.0.0.1:${server.address().port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
