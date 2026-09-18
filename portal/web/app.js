import { initGraph } from './graph.js';
import { initImports } from './imports.js';

const $ = id => document.getElementById(id);
let files = [];
let current = new URL(location.href).searchParams.get('doc');
const attachment = new URL(location.href).searchParams.get('attachment');
const graphPage = new URL(location.href).searchParams.get('view') === 'graph';
const searchPage = new URL(location.href).searchParams.get('view') === 'search';
const importPage = new URL(location.href).searchParams.get('view') === 'imports';
const importsView = importPage ? initImports() : null;
let revision = 0;
const graphView = initGraph(() => current);
if (graphPage) graphView.show();
if (searchPage) {
  $('document-view').hidden = true;
  $('search-panel').hidden = false;
  $('status').hidden = true;
  document.querySelector('.eyebrow').hidden = true;
  document.querySelector('.skip').href = '#query';
  document.querySelector('.skip').textContent = '跳到搜索';
}
if (importPage) {
  $('document-view').hidden = true; $('import-panel').hidden = false; $('status').hidden = true;
  document.querySelector('.eyebrow').hidden = true;
  document.querySelector('.skip').href = '#import-file'; document.querySelector('.skip').textContent = '跳到导入';
}
async function get(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || '读取失败');
  return body;
}
function tree() {
  $('home-link').hidden = !files.includes('首页.md');
  $('home-link').setAttribute('aria-current', !graphPage && !searchPage && !importPage && !attachment && current === '首页.md' ? 'page' : 'false');
  $('import-view').setAttribute('aria-current', importPage ? 'page' : 'false');
  $('search-view').setAttribute('aria-current', searchPage ? 'page' : 'false');
  $('graph-view').setAttribute('aria-current', graphPage ? 'page' : 'false');
  $('graph-view').href = '/?view=graph' + (current ? '&doc=' + encodeURIComponent(current) : '');
  const term = $('filter').value.trim().toLocaleLowerCase();
  const root = new Map();
  for (const file of files.filter(x => x.toLocaleLowerCase().includes(term))) {
    let branch = root;
    const parts = file.split('/');
    parts.forEach((part, index) => {
      if (index === parts.length - 1) branch.set(part, file);
      else { if (!branch.has(part)) branch.set(part, new Map()); branch = branch.get(part); }
    });
  }
  function render(branch, parent) {
    for (const [name, value] of branch) {
      if (value instanceof Map) {
        const details = document.createElement('details');
        details.open = Boolean(term) || files.some(f => f === (attachment || current) && f.split('/').includes(name));
        const summary = document.createElement('summary'); summary.textContent = name;
        details.append(summary); render(value, details); parent.append(details);
      } else {
        const link = document.createElement('a');
        const markdown = /\.md$/i.test(value);
        link.textContent = markdown ? name.slice(0, -3) : name;
        link.href = (markdown ? '/?doc=' : '/?attachment=') + encodeURIComponent(value);
        link.title = value;
        if (!markdown) link.className = 'attachment';
        if (!graphPage && !searchPage && !importPage && value === (attachment || current)) link.setAttribute('aria-current', 'page');
        parent.append(link);
      }
    }
  }
  $('tree').replaceChildren(); render(root, $('tree'));
  if (!root.size) $('tree').textContent = '没有匹配的文件';
  const documents = files.filter(file => /\.md$/i.test(file)).length;
  $('count').textContent = `${documents} 篇 · ${files.length - documents} 附件`;
  $('count').title = '当前配置允许展示的文档和附件';
}
async function refresh() {
  const run = ++revision;
  $('status').textContent = '正在读取本地文件…';
  $('metadata').hidden = true; $('link-issues').hidden = true;
  graphView.invalidate();
  try {
    const listing = await get('/api/tree');
    if (run !== revision) return;
    files = listing.files;
    current ??= files.find(p => p === '首页.md') ?? files.find(p => /\.md$/i.test(p));
    if (graphPage && (!files.includes(current) || !/\.md$/i.test(current))) current = files.find(p => /\.md$/i.test(p));
    tree();
    if (importPage) {
      $('breadcrumb').textContent = '导入资料'; document.title = '导入资料 · EvoKBase';
      await importsView.refresh(); return;
    }
    if (searchPage) {
      $('breadcrumb').textContent = '搜索知识';
      document.title = '搜索知识 · EvoKBase';
      await runSearch();
      return;
    }
    if (graphPage) {
      $('breadcrumb').textContent = '关系图谱';
      document.title = '关系图谱 · EvoKBase';
      $('graph-scope').querySelector('[value=local]').disabled = !current;
      if (!current) $('graph-scope').value = 'all';
      await graphView.load();
      return;
    }
    if (attachment) {
      const data = await get('/api/attachment?path=' + encodeURIComponent(attachment));
      if (run !== revision) return;
      $('breadcrumb').textContent = data.path;
      document.title = data.path.split('/').at(-1) + ' · EvoKBase';
      const heading = document.createElement('h1'); heading.textContent = data.path.split('/').at(-1);
      const note = document.createElement('p'); note.textContent = `${Math.ceil(data.size / 1024)} KiB · 原始附件。浏览器不支持预览时，请下载后用本机应用打开。`;
      const open = document.createElement('a'); open.href = '/file?path=' + encodeURIComponent(data.path); open.textContent = '在新窗口打开'; open.target = '_blank'; open.rel = 'noopener';
      const download = document.createElement('a'); download.href = open.href + '&download=1'; download.textContent = '下载原文件';
      $('article').replaceChildren(heading, note, open, document.createTextNode('　·　'), download);
      if (data.type.startsWith('image/')) { const image = document.createElement('img'); image.src = open.href; image.alt = data.path; $('article').append(document.createElement('hr'), image); }
      $('status').textContent = '附件已就绪';
      return;
    }
    if (!current) {
      $('article').textContent = '展示范围内还没有 Markdown。请核对启动配置中的目录。';
      $('status').textContent = listing.warnings.map(x => `${x.path}：${x.message}`).join('；') || '目录为空';
      return;
    }
    const doc = await get('/api/document?path=' + encodeURIComponent(current));
    if (run !== revision) return;
    $('breadcrumb').textContent = doc.path;
    document.title = doc.path.split('/').at(-1).replace(/\.md$/i, '') + ' · EvoKBase';
    // Only the local renderer produces this HTML; raw HTML and external image loads are disabled there.
    $('article').innerHTML = doc.html;
    $('frontmatter').textContent = doc.frontmatter || '无文件头信息';
    $('file-info').replaceChildren();
    for (const [key, value] of [['路径', doc.path], ['修改时间', new Date(doc.modified).toLocaleString('zh-CN')], ['内容 SHA256', doc.version]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = key; dd.textContent = value; $('file-info').append(dt, dd);
    }
    $('metadata').hidden = false;
    const issues = doc.links.filter(l => !['resolved', 'external'].includes(l.status));
    $('issues').replaceChildren();
    for (const issue of issues) {
      const li = document.createElement('li');
      li.textContent = `${issue.raw} — ${issue.status === 'ambiguous' ? '同名目标不唯一：' + issue.candidates.join('、') : '不存在或不在展示范围'}`;
      $('issues').append(li);
    }
    $('link-issues').hidden = !issues.length;
    $('issue-summary').textContent = `${issues.length} 个未解析链接`;
    const warnings = [...listing.warnings, ...doc.warnings];
    $('status').textContent = warnings.length ? warnings.map(x => `${x.path}：${x.message}`).join('；') : '已读取本地最新文件';
    if (new URL(location.href).searchParams.get('from') === 'search') $('status').textContent += '。搜索命中来自已发布索引；此处是本地最新文件，可能包含未发布修改。';
    const sourceLine = Number(new URL(location.href).searchParams.get('line'));
    const sourceVersion = new URL(location.href).searchParams.get('version');
    if (sourceVersion && sourceVersion !== doc.version) {
      $('status').textContent = '文档已变化，引用位置可能不再准确；请重新打开关系图谱核对。';
    } else if (Number.isInteger(sourceLine) && sourceLine > 0) {
      const target = sourceLine < doc.bodyLine ? $('metadata') : $('article').querySelector(`[data-source-line="${sourceLine}"]`);
      if (target) { if (target === $('metadata')) target.open = true; target.classList.add('source-highlight'); target.scrollIntoView({block:'center'}); }
      else $('status').textContent = '原文位置可能已变化，请核对当前内容';
    }
    if (location.hash) {
      let anchor;
      try { anchor = decodeURIComponent(location.hash.slice(1)); } catch { anchor = ''; }
      const heading = document.getElementById(anchor);
      if (heading && $('article').contains(heading)) heading.scrollIntoView();
      else $('status').textContent = '正文已加载，未找到所选锚点';
    }
  } catch (error) {
    if (run !== revision) return;
    if (importPage) { $('import-status').textContent = error.message; return; }
    if (searchPage) { $('search-status').textContent = `读取失败：${error.message}`; return; }
    if (graphPage) { $('graph-status').textContent = `关系图谱暂不可用：${error.message}。可刷新重试。`; return; }
    $('article').textContent = '无法读取此文档。你仍可以从左侧选择其他文件。';
    $('status').textContent = `${attachment || current || '目录'}：${error.message}`;
  }
}
let searchRevision = 0;
const localStatus = { outside: '不在本地展示范围内，或已移动 / 删除', ambiguous: '对应多个本地文件，未猜测目标', unverified: '来源或片段暂未核实，未生成本地链接' };
function element(tag, text, className) {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function runSearch() {
  const run = ++searchRevision, query = $('query').value;
  $('search-status').textContent = '正在搜索已发布的知识…';
  $('search-results').replaceChildren();
  $('search-results').setAttribute('aria-busy', 'true');
  const url = new URL(location.href); url.searchParams.set('q', query); history.replaceState(null, '', url);
  if (!query.trim()) {
    url.searchParams.delete('q'); history.replaceState(null, '', url);
    $('search-status').textContent = '输入内容后搜索。';
    $('search-results').setAttribute('aria-busy', 'false');
    return;
  }
  try {
    const data = await get('/api/search?q=' + encodeURIComponent(query));
    if (run !== searchRevision) return;
    $('search-status').textContent = (data.results.length ? `返回 ${data.results.length} 条命中（最多 ${data.limit} 条），保持 GBrain 返回顺序。` : '没有命中。可换个关键词；未发布的本地修改不在搜索范围内。') + (data.degraded ? ' 当前服务使用降级检索。' : '');
    for (const hit of data.results) {
      const card = element('section', '', 'search-result'), heading = element('h2', hit.title);
      const local = hit.local;
      if (local.status === 'available') {
        const link = element('a', hit.title); link.href = '/?doc=' + encodeURIComponent(local.path) + '&from=search';
        heading.replaceChildren(link);
      }
      card.append(heading, element('p', (hit.sourceId ? `来源：${hit.sourceId} · ` : '') + hit.slug, 'search-source'), element('p', hit.snippet, 'search-snippet'));
      if (local.status === 'available') {
        card.append(element('p', `本地：${local.path} · ${local.bodyMatches ? '正文与索引正文一致（未核验文件头及发布提交）' : '本地正文与索引不同，可能有未发布修改或索引转换差异'}`, 'search-version'));
        const details = document.createElement('details'); details.append(element('summary', '查看索引原文与版本'));
        details.addEventListener('toggle', async () => {
          if (!details.open || details.dataset.loaded || details.dataset.loading) return;
          details.dataset.loading = 'true';
          const content = element('div', '正在读取索引原文…'); details.append(content);
          try {
            const page = await get('/api/search/page?slug=' + encodeURIComponent(hit.slug));
            const changed = page.indexHash !== hit.indexHash ? '索引已在搜索后更新，请重新搜索核对片段。\n' : '';
            content.replaceChildren(element('p', changed + `索引页更新时间：${page.indexedAt || '未知'}\n索引摘要：${page.indexHash || '未知'}\n本地修改时间：${page.local.modified}\n本地文件 SHA256：${page.local.version}\n两种摘要口径不同，不能直接比较；页面时间不代表刷新提交版本。`, 'search-version'), element('pre', page.content));
            details.dataset.loaded = 'true';
          } catch (error) { content.textContent = error.message; }
          finally { delete details.dataset.loading; if (!details.dataset.loaded) details.addEventListener('toggle', () => content.remove(), { once: true }); }
        });
        card.append(details);
      } else card.append(element('p', localStatus[local.status], 'search-version'));
      $('search-results').append(card);
    }
  } catch (error) { if (run === searchRevision) $('search-status').textContent = error.message; }
  finally { if (run === searchRevision) $('search-results').setAttribute('aria-busy', 'false'); }
}
$('query').value = new URL(location.href).searchParams.get('q') ?? '';
$('search-form').addEventListener('submit', event => { event.preventDefault(); runSearch(); });
$('filter').addEventListener('input', tree);
$('refresh').addEventListener('click', refresh);
refresh();
