import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLibrary, types, failure } from './library.mjs';
import { createSearch } from './search.mjs';

const web = fileURLToPath(new URL('./web/', import.meta.url));
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/graph.js': ['graph.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/vendor/d3.min.js': ['../node_modules/d3/dist/d3.min.js', 'text/javascript'], '/vendor/d3.LICENSE': ['../node_modules/d3/LICENSE', 'text/plain'] };
export async function startPortal(config, port = 4317) {
  const library = await createLibrary(config);
  const search = createSearch(config.gbrain, library);
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
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw failure(405, '只读入口'); }
      const url = new URL(req.url, origin);
      if (assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        return send(200, type + '; charset=utf-8', req.method === 'HEAD' ? '' : await fs.readFile(path.join(web, file)));
      }
      let result;
      if (url.pathname === '/api/tree') result = await library.list();
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
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args[0] !== '--config' || (args.length !== 2 && (args.length !== 4 || args[2] !== '--port'))) throw Error('用法：node server.mjs --config <仓库外的配置.json> [--port 4317]');
    const port = args[3] === undefined ? 4317 : Number(args[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('端口必须为 1—65535');
    const config = JSON.parse(await fs.readFile(args[1], 'utf8'));
    const server = await startPortal(config, port);
    console.log(`EvoKBase 只读门户：http://127.0.0.1:${server.address().port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
