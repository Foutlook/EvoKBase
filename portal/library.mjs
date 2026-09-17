import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { parseDocument, LineCounter, visit, isScalar } from 'yaml';

export const types = { '.md': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const hidden = /^(?:\.|tmp$|temp$|node_modules$|logs?$|backups?$|credentials?$|secrets?$)/i;
const internal = /^(?:AGENTS|task_plan|findings|progress)\.md$/i;
const md = new MarkdownIt({ html: false, linkify: false });
const escape = md.utils.escapeHtml;
export function failure(status, message) { return Object.assign(new Error(message), { status }); }

export async function createLibrary(config) {
  if (!config.root || !Array.isArray(config.include) || !config.include.length || !config.include.every(x => typeof x === 'string')) throw Error('配置必须提供 root 和非空 include 列表');
  const root = await fs.realpath(path.resolve(config.root));
  if (!(await fs.stat(root)).isDirectory()) throw Error('root 必须是目录');
  const excludes = config.exclude ?? [];
  if (!Array.isArray(excludes) || !excludes.every(x => typeof x === 'string')) throw Error('exclude 必须是路径列表');
  const safe = value => typeof value === 'string' && value && !value.includes('\\') && !/[\x00-\x1f:]/.test(value) && !value.startsWith('/') && value.split('/').every(p => p && p !== '..' && !hidden.test(p) && !internal.test(p) && !/[. ]$/.test(p));
  if (![...config.include, ...excludes].every(safe)) throw Error('include/exclude 必须是安全的库内相对路径');
  const within = (file, base) => file === base || file.startsWith(base + '/');
  function allowed(file) {
    return safe(file) && config.include.some(p => within(file, p)) && !excludes.some(p => within(file, p));
  }
  async function checked(file) {
    if (!allowed(file) || !types[path.extname(file).toLowerCase()]) throw failure(404, '文件不在展示范围内');
    let current = root;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      // Windows junctions and POSIX symlinks must not widen the selected library.
      if (stat.isSymbolicLink()) throw failure(403, '不读取符号链接或目录联接');
      const real = await fs.realpath(current);
      const relative = path.relative(root, real);
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw failure(403, '路径超出知识库');
    }
    if (!(await fs.stat(current)).isFile()) throw failure(404, '不是普通文件');
    return current;
  }
  async function list() {
    // ponytail: rescan for fresh files; add an application-side index only if large vaults become slow.
    const files = [], warnings = [];
    async function walk(dir, relative = '') {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { warnings.push({ path: relative, message: '目录不可读' }); return; }
      for (const entry of entries) {
        const file = relative ? relative + '/' + entry.name : entry.name;
        if (!safe(file) || excludes.some(p => within(file, p)) || entry.isSymbolicLink()) continue;
        if (!config.include.some(p => within(file, p) || within(p, file))) continue;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), file);
        else if (entry.isFile() && allowed(file) && types[path.extname(file).toLowerCase()]) files.push(file);
      }
    }
    await walk(root);
    return { files: files.sort((a, b) => a.localeCompare(b, 'zh-CN')), warnings };
  }
  async function read(file) {
    const filename = await checked(file);
    const handle = await fs.open(filename, 'r');
    try {
      const stat = await handle.stat();
      const maximum = path.extname(file).toLowerCase() === '.md' ? 4 * 1024 * 1024 : 64 * 1024 * 1024;
      if (stat.size > maximum) throw failure(413, '文件超过预览限制');
      const bytes = await handle.readFile();
      if (bytes.length > maximum) throw failure(413, '文件超过预览限制');
      return { bytes, modified: stat.mtime.toISOString(), version: createHash('sha256').update(bytes).digest('hex') };
    } finally { await handle.close(); }
  }
  async function document(file, inventory) {
    if (typeof file !== 'string' || !file) throw failure(400, '缺少文件路径');
    if (path.extname(file).toLowerCase() !== '.md') throw failure(400, '请选择 Markdown 文件');
    const data = await read(file);
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(data.bytes).replace(/\r\n/g, '\n'); }
    catch { throw failure(422, '文件不是有效 UTF-8，未修改原文件'); }
    const front = source.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/);
    const files = inventory ?? (await list()).files;
    const offset = front ? front[0].split('\n').length - 1 : 0;
    const env = { file, files, links: [], headings: [], lines: source.split('\n'), offset, warnings: [] };
    const html = md.render(front ? source.slice(front[0].length) : source, env);
    if (front) {
      const counter = new LineCounter();
      try {
        const metadata = parseDocument(front[1], { lineCounter: counter, logLevel: 'silent', schema: 'core' });
        if (metadata.errors.length || metadata.warnings.length) throw Error('文件头语法或标签不支持');
        visit(metadata, (_key, node) => {
          // Inspect scalar values only; never expand YAML aliases or infer paths from category names.
          if (_key === 'key' || !isScalar(node) || typeof node.value !== 'string' || !node.range) return;
          const start = counter.linePos(node.range[0]).line + 1;
          const end = counter.linePos(Math.max(node.range[0], node.range[1] - 1)).line + 1;
          md.renderInline(node.value, { ...env, location: { section: 'frontmatter', lineStart: start, lineEnd: end } });
        });
      } catch { env.warnings.push({ path: file, message: '文件头引用未解析，请核对 YAML；正文仍可浏览' }); }
    }
    return { path: file, html, frontmatter: front?.[1] ?? '', modified: data.modified, version: data.version, links: env.links, headings: env.headings, warnings: env.warnings, bodyLine: offset + 1 };
  }
  async function graph(current) {
    const inventory = await list();
    const paths = inventory.files.filter(file => path.extname(file).toLowerCase() === '.md');
    if (current !== undefined && !paths.includes(current)) throw failure(404, '文档不在展示范围内');
    const documents = new Map(), warnings = [...inventory.warnings];
    // ponytail: rebuild from files per request; cache by content hashes only if measured vault size warrants it.
    for (const file of paths) {
      try { const doc = await document(file, inventory.files); documents.set(file, doc); warnings.push(...doc.warnings); }
      catch { warnings.push({ path: file, message: '文档不可读，相关引用未计入关系' }); }
    }
    const grouped = new Map(), unresolved = [];
    for (const [source, doc] of documents) {
      for (const reference of doc.links) {
        if (reference.status === 'external') continue;
        let status = reference.status;
        if (status === 'resolved' && path.extname(reference.path).toLowerCase() !== '.md') continue;
        const target = documents.get(reference.path);
        if (status === 'resolved' && !target) status = 'unavailable';
        if (status === 'resolved' && reference.anchor && !target.headings.includes(fragment(reference.anchor))) status = reference.anchor.startsWith('^') ? 'unsupported-anchor' : 'missing-anchor';
        const evidence = { ...reference, sourceVersion: doc.version };
        if (status !== 'resolved') { unresolved.push({ source, ...evidence, status }); continue; }
        const key = JSON.stringify([source, reference.path]);
        if (!grouped.has(key)) grouped.set(key, { source, target: reference.path, references: [] });
        grouped.get(key).references.push(evidence);
      }
    }
    const edges = [...grouped.values()];
    const selectedEdges = current === undefined ? edges : edges.filter(edge => edge.source === current || edge.target === current);
    const visible = current === undefined ? new Set(paths) : new Set([current, ...selectedEdges.flatMap(edge => [edge.source, edge.target])]);
    const nodes = paths.filter(file => visible.has(file)).map(file => ({ path: file, title: path.posix.basename(file, path.extname(file)), version: documents.get(file)?.version ?? null }));
    return { nodes, edges: selectedEdges, unresolved: current === undefined ? unresolved : unresolved.filter(link => link.source === current || link.path === current), warnings,
      scope: current === undefined ? 'all' : 'local', current: current ?? null, documentCount: paths.length,
      version: createHash('sha256').update(JSON.stringify(paths.map(file => [file, documents.get(file)?.version ?? null]))).digest('hex') };
  }
  return { list, read, document, graph };
}

export function resolveLink(raw, current, files, wiki = false) {
  let target;
  try { target = decodeURIComponent(raw); } catch { return { status: 'invalid' }; }
  if (/^(https?:|mailto:)/i.test(target)) return { status: 'external', href: target };
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//') || target.includes('\\') || /[\x00-\x1f]/.test(target)) return { status: 'invalid' };
  const hash = target.indexOf('#');
  const anchor = hash < 0 ? '' : target.slice(hash + 1);
  target = hash < 0 ? target : target.slice(0, hash);
  if (!target) return { status: 'resolved', path: current, anchor };
  const candidate = value => [value, value + '.md'].find(p => files.includes(p));
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(current), target));
  // Explicit Markdown paths stay relative. Bare WikiLinks require a unique name.
  let found;
  if (wiki && !target.includes('/')) {
    const matches = files.filter(p => path.posix.basename(p) === target || path.posix.basename(p) === target + '.md');
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
    found = matches[0];
  } else found = wiki ? candidate(target.replace(/^\//, '')) ?? candidate(relative) : candidate(target.startsWith('/') ? target.slice(1) : relative);
  return found ? { status: 'resolved', path: found, anchor } : { status: 'missing' };
}
const fragment = value => value.normalize('NFC').trim().replace(/\s+/g, '-').toLowerCase();
function urlFor(link) {
  if (link.status === 'external') return link.href;
  const mdFile = path.posix.extname(link.path).toLowerCase() === '.md';
  return (mdFile ? '/?doc=' : '/?attachment=') + encodeURIComponent(link.path) + (link.anchor ? '#' + encodeURIComponent(mdFile ? fragment(link.anchor) : link.anchor) : '');
}
const fileUrl = file => '/file?path=' + encodeURIComponent(file);
function record(raw, env, wiki, token) {
  const link = resolveLink(raw, env.file, env.files, wiki);
  const location = token?.meta?.location ?? env.location;
  env.links.push({ raw, ...link, ...location, excerpt: location ? env.lines.slice(location.lineStart - 1, location.lineEnd).join('\n').slice(0, 500) : '' });
  return link;
}
function renderedLink(link, label) {
  if (!['resolved', 'external'].includes(link.status)) return `<span class="unresolved" title="${escape(({ ambiguous: '同名目标不唯一', invalid: '链接不允许', missing: '目标不存在或不在展示范围' })[link.status])}">${escape(label)} · 未解析</span>`;
  return `<a href="${escape(urlFor(link))}"${link.status === 'external' ? ' target="_blank" rel="noreferrer noopener"' : ''}>${escape(label)}</a>`;
}
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const match = state.src.slice(state.pos).match(/^(!?)\[\[([^\]\n]+)\]\]/);
  if (!match || state.linkLevel > 0) return false;
  if (!silent) {
    const token = state.push('wikilink', '', 0);
    token.content = match[2];
    token.meta = { embed: Boolean(match[1]) };
  }
  state.pos += match[0].length;
  return true;
});
md.renderer.rules.wikilink = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  const [raw, ...aliases] = token.content.split('|');
  const label = aliases.join('|') || raw;
  const link = record(raw, env, true, token);
  if (token.meta.embed && link.status === 'resolved' && types[path.extname(link.path).toLowerCase()]?.startsWith('image/')) return `<img src="${escape(fileUrl(link.path))}" alt="${escape(label)}" loading="lazy">`;
  return renderedLink(link, label);
};
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const link = record(token.attrGet('href'), env, false, token);
  if (['resolved', 'external'].includes(link.status)) {
    token.attrSet('href', urlFor(link));
    if (link.status === 'external') { token.attrSet('target', '_blank'); token.attrSet('rel', 'noreferrer noopener'); }
  } else {
    token.attrs = [['class', 'unresolved'], ['title', link.status === 'ambiguous' ? '同名目标不唯一' : '目标不存在或不允许']];
    token.attrSet('aria-disabled', 'true');
  }
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.image = (tokens, idx, _options, env) => {
  const token = tokens[idx], link = record(token.attrGet('src'), env, false, token);
  if (link.status === 'resolved' && types[path.extname(link.path).toLowerCase()]?.startsWith('image/')) return `<img src="${escape(fileUrl(link.path))}" alt="${escape(token.content)}" loading="lazy">`;
  return `<span class="unresolved">${escape(token.content || '图片')}（未加载：外部图片或不支持的目标）</span>`;
};
md.core.ruler.push('heading_ids', state => {
  const counts = new Map();
  state.tokens.forEach((token, idx) => {
    if (token.type !== 'heading_open') return;
    const text = (state.tokens[idx + 1]?.children ?? []).map(t => t.type === 'wikilink' ? t.content.split('|').at(-1) : t.content).join('');
    const id = fragment(text), count = counts.get(id) ?? 0;
    counts.set(id, count + 1);
    const heading = id + (count ? '-' + count : '');
    token.attrSet('id', heading);
    state.env.headings?.push(heading);
  });
});
md.core.ruler.push('source_positions', state => {
  if (state.env.location) return;
  const blocks = [];
  for (const token of state.tokens) {
    // Table-cell inline tokens have no map; their enclosing row supplies the exact source range.
    const location = token.map ? { section: 'body', lineStart: state.env.offset + token.map[0] + 1, lineEnd: state.env.offset + token.map[1] } : blocks.at(-1);
    if (token.nesting === 1) { blocks.push(location); if (location) token.attrSet('data-source-line', String(location.lineStart)); }
    if (token.type === 'inline' && location) for (const child of token.children ?? []) child.meta = { ...child.meta, location };
    if (token.nesting === -1) blocks.pop();
  }
});
