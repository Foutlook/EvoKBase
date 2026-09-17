const $ = id => document.getElementById(id);
const statusText = { ambiguous: '同名目标不唯一', missing: '目标不存在或不在展示范围', invalid: '链接不允许', unavailable: '目标不可读', 'missing-anchor': '标题锚点不存在', 'unsupported-anchor': '暂不支持块锚点' };
const docUrl = path => '/?doc=' + encodeURIComponent(path);
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function link(path, label = path) {
  const anchor = element('a', label); anchor.href = docUrl(path); return anchor;
}
function evidence(source, reference) {
  const anchor = link(source, `${reference.section === 'frontmatter' ? '文件头' : '正文'} L${reference.lineStart}–${reference.lineEnd}`);
  anchor.href += '&line=' + reference.lineStart;
  anchor.href += '&version=' + encodeURIComponent(reference.sourceVersion);
  anchor.title = reference.excerpt;
  return anchor;
}
export function initGraph(getCurrent) {
  let data, chart, request = 0;
  function show() {
    document.body.classList.add('graph-open');
    document.querySelector('.skip').href = '#graph-canvas';
    document.querySelector('.skip').textContent = '跳到关系图谱';
    $('relations').hidden = false; $('document-view').hidden = true;
  }
  function invalidate() {
    chart?.destroy(); chart = undefined;
    request++; data = undefined;
    $('graph-canvas').replaceChildren(); $('graph-records').replaceChildren();
    $('graph-unresolved').hidden = true; $('graph-warnings').hidden = true;
    $('graph-status').textContent = '正在重建关系图谱…';
  }
  async function load() {
    chart?.destroy(); chart = undefined;
    const run = ++request;
    $('graph-status').textContent = '正在从本地文档核对引用…';
    $('graph-canvas').replaceChildren(); $('graph-records').replaceChildren();
    $('graph-unresolved').hidden = true; $('graph-warnings').hidden = true;
    data = undefined;
    try {
      const query = $('graph-scope').value === 'local' ? '?path=' + encodeURIComponent(getCurrent()) : '';
      const response = await fetch('/api/graph' + query, {cache:'no-store'});
      const result = await response.json();
      if (run !== request) return;
      if (!response.ok) throw Error(result.error);
      data = result; render();
    } catch (error) { if (run === request) $('graph-status').textContent = `关系图谱暂不可用：${error.message}。仍可从左侧打开文档。`; }
  }
  function render() {
    if (!data) return;
    const term = $('graph-filter').value.trim().toLocaleLowerCase();
    const selected = new Set(data.nodes.filter(n => n.path.toLocaleLowerCase().includes(term) || (data.scope === 'local' && n.path === data.current)).map(n => n.path));
    const edges = data.edges.filter(e => selected.has(e.source) && selected.has(e.target));
    const connected = new Set(edges.flatMap(e => [e.source, e.target]));
    const nodes = data.nodes.filter(n => selected.has(n.path) && ($('graph-orphans').checked || connected.has(n.path) || (data.scope === 'local' && n.path === data.current)));
    $('graph-status').textContent = `${data.scope === 'local' ? '当前文档一跳' : '全部展示文档'} · ${nodes.length} / ${data.nodes.length} 篇文档 · ${edges.length} 组关系 · ${edges.reduce((sum, e) => sum + e.references.length, 0)} 处引用${term ? '（已筛选）' : ''}`;
    chart?.destroy();
    chart = drawGraph(nodes, edges, getCurrent());
    $('graph-records').replaceChildren();
    function section(title, entries) {
      const box = element('section', undefined, 'relation-list');
      box.append(element('h2', title + ` · ${entries.length}`));
      if (!entries.length) box.append(element('p', '没有明确的文档引用。', 'graph-hint'));
      for (const edge of entries) {
        const row = element('details', undefined, 'relation-record');
        row.append(element('summary', `${edge.source} → ${edge.target} · ${edge.references.length} 处`));
        const nav = element('p'); nav.append(link(edge.source, '打开引用方'), document.createTextNode('　·　'), link(edge.target, '打开目标文档')); row.append(nav);
        for (const ref of edge.references) {
          const p = element('p', undefined, 'relation-evidence');
          p.append(evidence(edge.source, ref), document.createTextNode('　' + ref.raw), element('code', ref.excerpt)); row.append(p);
        }
        box.append(row);
      }
      $('graph-records').append(box);
    }
    if (data.scope === 'local') {
      section('引用了谁', edges.filter(e => e.source === data.current));
      section('被谁引用', edges.filter(e => e.target === data.current && e.source !== data.current));
    } else section('引用记录', edges);
    const problems = data.unresolved.filter(ref => !term || [ref.source, ref.raw, ref.path ?? ''].some(value => value.toLocaleLowerCase().includes(term)));
    $('graph-problems').replaceChildren();
    for (const ref of problems) {
      const li = element('li');
      li.append(link(ref.source), document.createTextNode(`：${ref.raw} — ${statusText[ref.status] ?? ref.status}　`), evidence(ref.source, ref));
      if (ref.candidates?.length) li.append(element('small', '候选：' + ref.candidates.join('、')));
      $('graph-problems').append(li);
    }
    $('graph-unresolved-title').textContent = `未解析引用 · ${problems.length}`;
    $('graph-unresolved').hidden = !problems.length;
    $('graph-warning-list').replaceChildren();
    for (const warning of data.warnings) $('graph-warning-list').append(element('li', `${warning.path}：${warning.message}`));
    $('graph-warnings').hidden = !data.warnings.length;
  }
  $('graph-scope').addEventListener('change', load);
  $('graph-filter').addEventListener('input', render);
  $('graph-orphans').addEventListener('change', render);
  for (const id of ['graph-arrows', 'graph-node-size', 'graph-text-size', 'graph-line-size']) $(id).addEventListener('input', () => chart?.display());
  for (const id of ['graph-center', 'graph-repel', 'graph-strength', 'graph-distance']) $(id).addEventListener('input', () => chart?.forces());
  $('graph-zoom-in').addEventListener('click', () => chart?.zoom(1.3));
  $('graph-zoom-out').addEventListener('click', () => chart?.zoom(1 / 1.3));
  $('graph-fit').addEventListener('click', () => chart?.fit());
  $('graph-expand').addEventListener('click', () => {
    const expanded = document.body.classList.toggle('graph-expanded');
    $('graph-expand').setAttribute('aria-pressed', String(expanded));
    $('graph-expand').textContent = expanded ? '收起画布' : '展开画布';
    chart?.resize();
  });
  $('graph-add-group').addEventListener('click', () => {
    const row = element('div', undefined, 'graph-group');
    const color = element('input'); color.type = 'color'; color.value = '#8b6cc1'; color.setAttribute('aria-label', '分组颜色');
    const query = element('input'); query.type = 'search'; query.placeholder = '文件名或路径包含…'; query.setAttribute('aria-label', '分组匹配文字');
    const remove = element('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', '删除分组');
    row.append(color, query, remove); $('graph-groups').append(row);
    row.addEventListener('input', () => chart?.display());
    remove.addEventListener('click', () => { row.remove(); chart?.display(); });
    query.focus();
  });
  return { invalidate, load, show };
}

// D3 mutates nodes and link endpoints; keep the evidence response untouched.
export function createLayout(d3, sourceNodes, sourceEdges) {
  const nodes = sourceNodes.map(node => ({ ...node, neighbors: new Set() }));
  const byPath = new Map(nodes.map(node => [node.path, node]));
  const edges = sourceEdges.map(edge => ({ source: edge.source, target: edge.target }));
  for (const edge of edges) {
    byPath.get(edge.source).neighbors.add(edge.target);
    byPath.get(edge.target).neighbors.add(edge.source);
  }
  for (const node of nodes) node.radius = 3.5 + Math.sqrt(node.neighbors.size) * 1.4;
  const simulation = d3.forceSimulation(nodes).stop()
    .force('link', d3.forceLink(edges).id(node => node.path).distance(100).strength(0.3))
    .force('charge', d3.forceManyBody().strength(-180))
    .force('x', d3.forceX().strength(0.025)).force('y', d3.forceY().strength(0.025))
    .force('collide', d3.forceCollide(node => node.radius + 7));
  return { nodes, edges, simulation };
}

function drawGraph(sourceNodes, sourceEdges, current) {
  const container = $('graph-canvas'); container.replaceChildren(); $('graph-hover').hidden = true;
  if (!sourceNodes.length) { container.append(element('p', '没有匹配的文档。')); return; }
  const d3 = globalThis.d3;
  const { nodes, edges, simulation } = createLayout(d3, sourceNodes, sourceEdges);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = container.clientWidth, height = container.clientHeight, scale = 1, active;
  const svg = d3.select(container).append('svg').attr('width', '100%').attr('height', '100%').attr('role', 'group').attr('aria-label', '可交互的关系图谱');
  svg.append('defs').append('marker').attr('id', 'graph-arrow').attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5).attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto').append('path').attr('d', 'M 0 0 L 10 5 L 0 10 z').attr('fill', '#999');
  const layer = svg.append('g').attr('class', 'graph-world');
  const lines = layer.append('g').selectAll('path').data(edges).join('path').attr('class', 'graph-edge');
  const dots = layer.append('g').selectAll('a').data(nodes).join('a').attr('class', 'graph-node').classed('is-current', d => d.path === current)
    .attr('href', d => docUrl(d.path)).attr('aria-label', d => '打开文档：' + d.path);
  dots.append('circle').attr('class', 'graph-hit').attr('r', d => Math.max(12, d.radius));
  dots.append('circle').attr('class', 'graph-dot');
  dots.append('text').attr('text-anchor', 'middle').text(d => d.title);
  dots.append('title').text(d => d.path);
  function highlight(node) {
    active = node;
    dots.classed('is-dimmed', d => Boolean(node && d !== node && !node.neighbors.has(d.path)))
      .classed('is-focused', d => d === node);
    lines.classed('is-connected', e => Boolean(node && (e.source === node || e.target === node)))
      .classed('is-dimmed', e => Boolean(node && e.source !== node && e.target !== node));
    $('graph-hover').hidden = !node;
    $('graph-hover').textContent = node ? `${node.path} · ${node.neighbors.size} 个关联文档` : '';
    labels();
  }
  function labels() {
    const fontSize = 12 * Number($('graph-text-size').value) / Math.sqrt(scale);
    dots.select('text').attr('font-size', fontSize).attr('y', d => d.radius * Number($('graph-node-size').value) + fontSize + 3)
      .attr('opacity', d => active === d || (active && active.neighbors.has(d.path)) ? 1 : Math.min(1, Math.max(0.12, scale * 1.3)));
  }
  function paint() {
    dots.attr('transform', d => `translate(${d.x},${d.y})`);
    lines.attr('d', e => {
      const a = e.source, b = e.target;
      if (a === b) return `M ${a.x-4} ${a.y-4} c -25 -35,35 -35,8 0`;
      const dx = b.x-a.x, dy = b.y-a.y, distance = Math.hypot(dx, dy) || 1;
      const r = (b.radius * Number($('graph-node-size').value) + 2) / distance;
      return `M ${a.x} ${a.y} L ${b.x-dx*r} ${b.y-dy*r}`;
    });
  }
  function display() {
    const groups = [...$('graph-groups').children].map(row => ({ term: row.querySelector('input[type=search]').value.trim().toLocaleLowerCase(), color: row.querySelector('input[type=color]').value }));
    dots.select('.graph-dot').attr('r', d => d.radius * Number($('graph-node-size').value))
      .attr('fill', d => groups.find(g => g.term && d.path.toLocaleLowerCase().includes(g.term))?.color ?? '#777');
    lines.attr('stroke-width', Number($('graph-line-size').value)).attr('marker-end', $('graph-arrows').checked ? 'url(#graph-arrow)' : null);
    simulation.force('collide').radius(d => d.radius * Number($('graph-node-size').value) + 7);
    labels(); paint();
  }
  function forces() {
    simulation.force('charge').strength(-Number($('graph-repel').value));
    simulation.force('link').distance(Number($('graph-distance').value)).strength(Number($('graph-strength').value));
    simulation.force('x').strength(Number($('graph-center').value)); simulation.force('y').strength(Number($('graph-center').value));
    simulation.alpha(0.6);
    if (reducedMotion) { simulation.stop().tick(180); paint(); } else simulation.restart();
  }
  const zoom = d3.zoom().scaleExtent([0.12, 6]).extent(() => [[0,0],[width,height]])
    .filter(event => (!event.button || event.type === 'wheel') && (event.type === 'wheel' || !event.target.closest('.graph-node')))
    .on('zoom', event => { layer.attr('transform', event.transform); scale = event.transform.k; labels(); });
  svg.call(zoom).on('dblclick.zoom', null);
  // The drag click-distance prevents releasing a moved node from opening its document.
  dots.call(d3.drag().clickDistance(5).on('start', (event, node) => {
    if (!reducedMotion && !event.active) simulation.alphaTarget(0.15).restart();
    node.fx = node.x; node.fy = node.y; highlight(node);
  }).on('drag', (event, node) => {
    node.fx = node.x = event.x; node.fy = node.y = event.y; paint();
  }).on('end', (event, node) => {
    if (!event.active) simulation.alphaTarget(0);
    node.fx = node.fy = null;
  }));
  dots.on('mouseenter', (_, node) => highlight(node)).on('mouseleave', () => highlight(undefined))
    .on('focus', (_, node) => highlight(node)).on('blur', () => highlight(undefined))
    .on('dragstart', event => event.preventDefault());
  function fit(minimum = 0.12) {
    const x = d3.extent(nodes, n => n.x), y = d3.extent(nodes, n => n.y);
    const k = Math.max(minimum, Math.min(1.4, (width-110)/Math.max(120,x[1]-x[0]), (height-140)/Math.max(120,y[1]-y[0])));
    svg.call(zoom.transform, d3.zoomIdentity.translate(width/2,height/2).scale(k).translate(-(x[0]+x[1])/2,-(y[0]+y[1])/2));
  }
  function resize() {
    if (!container.clientWidth || !container.clientHeight) return;
    const oldWidth = width, oldHeight = height;
    width = container.clientWidth; height = container.clientHeight;
    const t = d3.zoomTransform(svg.node());
    svg.call(zoom.transform, d3.zoomIdentity.translate(t.x+(width-oldWidth)/2,t.y+(height-oldHeight)/2).scale(t.k));
  }
  function keydown(event) {
    if (event.target !== container) return;
    if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
    if (event.key === '+' || event.key === '=') svg.call(zoom.scaleBy, 1.3);
    else if (event.key === '-') svg.call(zoom.scaleBy, 1/1.3);
    else if (event.key === '0') fit();
    else if (event.key.startsWith('Arrow')) {
      const step = (event.shiftKey ? 100 : 35) / scale;
      svg.call(zoom.translateBy, event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0, event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0);
    }
  }
  container.addEventListener('keydown', keydown);
  const observer = new ResizeObserver(resize); observer.observe(container);
  simulation.on('tick', paint);
  // Start at a readable scale; distant orphans remain reachable with pan or fit-all.
  forces(); simulation.stop().tick(160); display(); fit(0.85);
  if (!reducedMotion) simulation.alpha(0.12).restart();
  return { display, forces, fit, resize, zoom: amount => svg.call(zoom.scaleBy, amount), destroy() { simulation.stop(); observer.disconnect(); container.removeEventListener('keydown', keydown); svg.remove(); } };
}
