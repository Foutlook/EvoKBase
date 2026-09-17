import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startPortal } from '../server.mjs';
import { createLibrary, resolveLink } from '../library.mjs';
import * as d3 from 'd3';
import { createLayout } from '../web/graph.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evokbase-p1-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entries = {
    '首页.md': '---\ntitle: 隔离样本\ntags: [阅读]\n---\n# 阅览室\n\n[[中文 空格/文章#小节 标题|继续阅读]]\n\n[[重名]] [[失效]]\n\n[相对](中文%20空格/文章.md#小节%20标题)\n\n![[附件/示意.png]]\n\n![外部](https://example.com/tracker.png)\n\n[PDF](附件/文字.pdf)\n\n| 项目 | 状态 |\n|---|---|\n| 浏览 | 可用 |\n\n`[[代码内]]`\n\n```md\n[[代码块内]]\n```\n\n<script>alert(1)</script>\n\n[[javascript:alert(2)|危险]]\n\n[危险](javascript:alert(3))',
    '中文 空格/文章.md': '# 示例\n\n## 小节 标题\n\n最新正文。\n\n[返回](../首页.md)\n\n[[#小节 标题]]',
    '甲/重名.md': '# 甲', '乙/重名.md': '# 乙',
    '.git/private.md': 'hidden', 'tmp/暂存.md': 'hidden', '秘密/不展示.md': 'private',
    'AGENTS.md': 'internal', '附件/恶意.html': '<script>alert(1)</script>',
    '附件/恶意.svg': '<svg onload="alert(1)"/>', '附件/key.env': 'test-only',
    '附件/示意.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=', 'base64'),
    '附件/文字.pdf': '%PDF-1.4\n%%EOF', '附件/资料.docx': Buffer.from('synthetic-download'),
    '坏编码.md': Buffer.from([0xff, 0xfe, 0xfa]),
  };
  for (const [name, data] of Object.entries(entries)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), data);
  }
  const config = { root, include: ['首页.md', '中文 空格', '甲', '乙', '附件', '坏编码.md'], exclude: [] };
  return { root, config, entries };
}

test('目录、正文、frontmatter、中文相对路径、别名、锚点与歧义', async t => {
  const { config } = await fixture(t), library = await createLibrary(config);
  const { files } = await library.list();
  assert.equal(files.length, 8);
  assert.ok(!files.some(f => /秘密|\.git|tmp|AGENTS|html|svg|env/.test(f)));
  const doc = await library.document('首页.md');
  assert.equal(doc.frontmatter, 'title: 隔离样本\ntags: [阅读]');
  assert.match(doc.html, /<table(?:\s|>)/);
  assert.match(doc.html, /继续阅读<\/a>/);
  assert.match(doc.html, /%E5%B0%8F%E8%8A%82-%E6%A0%87%E9%A2%98/);
  assert.equal(doc.links.find(l => l.raw === '重名').status, 'ambiguous');
  assert.equal(doc.links.find(l => l.raw === '失效').status, 'missing');
  assert.ok(!doc.links.some(l => /代码内|代码块内/.test(l.raw)));
  assert.ok(!doc.html.includes('<script>'));
  assert.ok(!doc.html.includes('src="https://'));
  assert.ok(!doc.html.includes('href="javascript:'));
  assert.match((await library.document('中文 空格/文章.md')).html, /id="小节-标题"/);
  assert.equal(resolveLink('../首页.md', '中文 空格/文章.md', files).path, '首页.md');
  assert.equal(resolveLink('甲/重名', '首页.md', files, true).path, '甲/重名.md');
  assert.equal(resolveLink('%ZZ', '首页.md', files).status, 'invalid');
  assert.equal(resolveLink('file:///private', '首页.md', files).status, 'invalid');
});

test('HTTP 只读、同源、附件、越界与新鲜读取；异常文档不阻断其他文件', async t => {
  const { root, config } = await fixture(t);
  const server = await startPortal(config, 0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(route, options) { return fetch(base + route, options); }
  const d3Asset = await api('/vendor/d3.min.js');
  assert.equal(d3Asset.status, 200);
  assert.match(d3Asset.headers.get('content-type'), /text\/javascript/);
  assert.equal(await (await api('/vendor/d3.LICENSE')).text(), await fs.readFile(new URL('../node_modules/d3/LICENSE', import.meta.url), 'utf8'));
  assert.equal((await api('/vendor/package.json')).status, 404);
  const before = await (await api('/api/document?path=' + encodeURIComponent('首页.md'))).json();
  for (const file of ['../outside.md', 'C:/outside.md', '首页.md:stream', '.git/private.md', 'tmp/暂存.md', '秘密/不展示.md', '附件/恶意.svg', '附件/恶意.html', '中文 空格/../../outside.md', '中文 空格\\文章.md']) {
    assert.equal((await api('/file?path=' + encodeURIComponent(file))).status, 404, file);
  }
  assert.equal((await api('/api/document')).status, 400);
  assert.equal((await api('/api/document?path=' + encodeURIComponent('坏编码.md'))).status, 422);
  assert.equal((await api('/api/document?path=' + encodeURIComponent('首页.md'))).status, 200);
  assert.equal((await api('/api/tree', { method: 'POST' })).status, 405);
  assert.equal((await api('/api/tree', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await api('/api/tree', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const badHost = await new Promise(resolve => {
    http.get(base + '/api/tree', { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
  });
  assert.equal(badHost, 403);
  const png = await api('/file?path=' + encodeURIComponent('附件/示意.png'));
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('cache-control'), 'no-store');
  assert.ok(png.headers.get('content-security-policy').includes("default-src 'none'"));
  assert.equal((await api('/file?path=' + encodeURIComponent('附件/文字.pdf'))).headers.get('content-type'), 'application/pdf');
  assert.match((await api('/file?path=' + encodeURIComponent('附件/文字.pdf') + '&download=1')).headers.get('content-disposition'), /^attachment/);
  assert.equal((await (await api('/api/attachment?path=' + encodeURIComponent('附件/文字.pdf'))).json()).type, 'application/pdf');
  assert.equal((await api('/api/attachment?path=../outside.md')).status, 404);
  assert.match((await api('/file?path=' + encodeURIComponent('附件/资料.docx'))).headers.get('content-disposition'), /^attachment/);
  await fs.appendFile(path.join(root, '首页.md'), '\n\n隔离修改：立即可见。');
  const after = await (await api('/api/document?path=' + encodeURIComponent('首页.md'))).json();
  assert.notEqual(after.version, before.version);
  assert.match(after.html, /隔离修改：立即可见/);
  await fs.writeFile(path.join(root, '甲/新增.md'), '# 新文件');
  assert.ok((await (await api('/api/tree')).json()).files.includes('甲/新增.md'));
});

test('力导向布局保留证据数据，处理孤立/自环/双向节点并在拖动释放后收敛', () => {
  const nodes = ['中心', '关联', '孤立'].map(title => ({path: title + '.md', title}));
  const edges = [{source:'中心.md', target:'关联.md'}, {source:'关联.md', target:'中心.md'}, {source:'中心.md', target:'中心.md'}];
  const before = JSON.stringify({nodes, edges});
  const layout = createLayout(d3, nodes, edges);
  try {
    layout.simulation.tick(200);
    assert.equal(JSON.stringify({nodes, edges}), before);
    assert.ok(layout.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
    assert.ok(layout.nodes[0].radius > layout.nodes[2].radius);
    assert.ok(Math.hypot(layout.nodes[0].x-layout.nodes[1].x, layout.nodes[0].y-layout.nodes[1].y) > 1);
    const dragged = layout.nodes[0];
    dragged.fx = 250; dragged.fy = -100;
    layout.simulation.alpha(0.5).tick(10);
    assert.equal(dragged.x, 250); assert.equal(dragged.y, -100);
    dragged.fx = dragged.fy = null;
    layout.simulation.alpha(0.5).tick(200);
    assert.ok(Math.abs(dragged.x-250) > 1);
    assert.ok(layout.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
  } finally { layout.simulation.stop(); }
});

test('符号链接/目录联接不扩大范围；浏览不改文件', async t => {
  const { root, config, entries } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'evokbase-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, '越界.md'), 'outside');
  await fs.symlink(outside, path.join(root, '甲/外链'), process.platform === 'win32' ? 'junction' : 'dir');
  const library = await createLibrary(config);
  assert.ok(!(await library.list()).files.includes('甲/外链/越界.md'));
  await assert.rejects(library.read('甲/外链/越界.md'), { status: 403 });
  await library.document('首页.md');
  for (const [file, expected] of Object.entries(entries)) {
    const bytes = await fs.readFile(path.join(root, file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(expected).digest('hex'), file);
  }
  await assert.rejects(createLibrary({ root, include: ['../escape'] }));
  await assert.rejects(createLibrary({ root, include: [] }));
});

test('一跳与反向关系只来自真实链接，保留正文/文件头位置和未解析原因', async t => {
  const { root, config } = await fixture(t);
  const original = await fs.readFile(path.join(root, '首页.md'), 'utf8');
  const source = original.replace('tags: [阅读]', 'tags: [阅读]\nsource:\n  - "[[中文 空格/文章#小节 标题|来源]]"\n  - "[明确引用](甲/重名.md)"\nprojects: [重名, 中文 空格/文章]\nexample: "`[[乙/重名]]`"\n# [[乙/重名]]') + '\n\n[[中文 空格/文章#缺失标题]] [[中文 空格/文章#^块]] [[坏编码]]\n\n| 链接 | 说明 |\n|---|---|\n| [[甲/重名]] | 表格 WikiLink |\n| [目标](甲/重名.md) | 表格 Markdown |';
  await fs.writeFile(path.join(root, '首页.md'), source);
  const library = await createLibrary(config);
  const all = await library.graph();
  const out = all.edges.filter(e => e.source === '首页.md');
  assert.deepEqual(out.map(e => e.target).sort(), ['中文 空格/文章.md', '甲/重名.md'].sort());
  const edge = out.find(e => e.target === '中文 空格/文章.md');
  assert.equal(edge.references.length, 3);
  assert.deepEqual(new Set(edge.references.map(r => r.section)), new Set(['body', 'frontmatter']));
  for (const ref of out.flatMap(e => e.references)) {
    assert.equal(ref.sourceVersion, createHash('sha256').update(source).digest('hex'));
    assert.equal(ref.excerpt, source.split('\n').slice(ref.lineStart - 1, ref.lineEnd).join('\n'));
    assert.ok(ref.lineStart > 0 && ref.lineEnd >= ref.lineStart);
  }
  assert.equal(edge.references.find(r => r.section === 'frontmatter').lineStart, 5);
  const tableReferences = out.find(e => e.target === '甲/重名.md').references.filter(r => r.excerpt.includes('|'));
  assert.equal(tableReferences.length, 2);
  assert.equal(tableReferences[1].lineStart - tableReferences[0].lineStart, 1);
  assert.ok(all.edges.some(e => e.source === '中文 空格/文章.md' && e.target === '首页.md'));
  for (const status of ['ambiguous', 'missing', 'invalid', 'missing-anchor', 'unsupported-anchor', 'unavailable']) assert.ok(all.unresolved.some(r => r.status === status), status);
  assert.ok(!all.edges.some(e => /代码|附件|乙/.test(e.target)));
  assert.ok(all.warnings.some(w => w.path === '坏编码.md'));
  const local = await library.graph('甲/重名.md');
  assert.deepEqual(local.nodes.map(n => n.path).sort(), ['甲/重名.md', '首页.md'].sort());
  assert.equal(local.edges.length, 1);
  assert.equal(local.version, all.version);
  assert.deepEqual(await (await createLibrary(config)).graph(), all);
  await fs.writeFile(path.join(root, '甲/重名.md'), '# 甲\n\n[[乙/重名]]');
  const updated = await library.graph();
  assert.notEqual(updated.version, all.version);
  assert.ok(updated.edges.some(e => e.source === '甲/重名.md' && e.target === '乙/重名.md'));
  await assert.rejects(library.graph('../outside.md'), { status: 404 });
});

test('文件头无效或使用 YAML 别名时不猜引用，正文仍能形成关系', async t => {
  const { root, config } = await fixture(t);
  await fs.writeFile(path.join(root, '甲/重名.md'), '---\nsource: [broken\n---\n# 甲\n\n[返回](../首页.md)');
  await fs.writeFile(path.join(root, '乙/重名.md'), '---\nsource: &ref "[[首页]]"\nrelated: *ref\n---\n# 乙\n\n[跨行\n引用](../首页.md)\n\n[参考][id]\n\n[id]: ../首页.md');
  const library = await createLibrary(config), graph = await library.graph();
  assert.ok(graph.warnings.some(w => w.path === '甲/重名.md'));
  assert.equal(graph.edges.find(e => e.source === '甲/重名.md' && e.target === '首页.md').references.length, 1);
  const refs = graph.edges.find(e => e.source === '乙/重名.md' && e.target === '首页.md').references;
  assert.equal(refs.length, 3);
  assert.equal(refs.filter(r => r.section === 'frontmatter').length, 1);
  assert.ok(refs.some(r => r.lineStart < r.lineEnd));
  const server = await startPortal(config, 0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/graph?path=' + encodeURIComponent('首页.md'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scope, 'local');
  assert.equal((await fetch(base + '/api/graph?path=../outside.md')).status, 404);
  assert.equal((await fetch(base + '/api/graph', {method:'POST'})).status, 405);
  assert.equal((await fetch(base + '/api/graph', {headers:{Origin:'https://example.com'}})).status, 403);
});
