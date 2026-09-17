import { initGraph } from './graph.js';

const $ = id => document.getElementById(id);
let files = [];
let current = new URL(location.href).searchParams.get('doc');
const attachment = new URL(location.href).searchParams.get('attachment');
const graphPage = new URL(location.href).searchParams.get('view') === 'graph';
let revision = 0;
const graphView = initGraph(() => current);
if (graphPage) graphView.show();
async function get(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || '读取失败');
  return body;
}
function tree() {
  $('home-link').hidden = !files.includes('首页.md');
  $('home-link').setAttribute('aria-current', !graphPage && !attachment && current === '首页.md' ? 'page' : 'false');
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
        if (!graphPage && value === (attachment || current)) link.setAttribute('aria-current', 'page');
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
    if (graphPage) { $('graph-status').textContent = `关系图谱暂不可用：${error.message}。可刷新重试。`; return; }
    $('article').textContent = '无法读取此文档。你仍可以从左侧选择其他文件。';
    $('status').textContent = `${attachment || current || '目录'}：${error.message}`;
  }
}
$('filter').addEventListener('input', tree);
$('refresh').addEventListener('click', refresh);
refresh();
