import { parseDocument, isScalar } from 'yaml';
import { failure } from './library.mjs';

// GBrain 0.47.7 path identity rules; adapted from core/sync.ts (MIT, THIRD-PARTY-NOTICES).
export function pathSlug(file) {
  return file.replace(/\.md$/i, '').split('/').map(segment => segment.normalize('NFD')
    .replace(/[\u0300-\u036f\u0591-\u05c7]/g, '').normalize('NFC').toLowerCase()
    .replace(/[^\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}.\s_-]/gu, '')
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')).filter(Boolean).join('/');
}
const normalize = text => text.replace(/\r\n/g, '\n').trim();
const snippetText = text => text.replace(/\s+/g, ' ').trim();
const frontmatter = /^---\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/;
const unavailable = () => failure(503, 'GBrain 搜索暂不可用，请稍后重试；本地目录仍可浏览');

export function createSearch(config, library) {
  if (config) {
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !config.sourceId || config.sourceId === '__all__') throw Error('搜索配置需要 HTTP(S) MCP 地址和单一 sourceId');
  }
  async function call(name, args) {
    if (!config) throw failure(503, '未配置 GBrain 搜索；本地目录仍可浏览');
    try {
      // Existing deployment is stateless Streamable HTTP. Only these two read tools are exposed.
      const response = await fetch(config.url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(12000) });
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw unavailable();
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const envelopes = response.headers.get('content-type')?.includes('text/event-stream')
        ? text.split(/\r?\n\r?\n/).filter(block => /^data:/m.test(block)).map(block => JSON.parse(block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')))
        : [JSON.parse(text)];
      const message = envelopes.find(item => item.id === 1);
      if (!message?.result || message.error || message.result.isError) throw unavailable();
      const data = message.result.structuredContent ?? JSON.parse(message.result.content.find(item => item.type === 'text').text);
      if (!data || typeof data !== 'object' || data.error) throw unavailable();
      return data;
    } catch { throw unavailable(); }
  }
  async function paths() {
    const mapped = new Map();
    // ponytail: derive identities from the allowed files per search; cache only if measured latency warrants it.
    for (const file of (await library.list()).files.filter(file => /\.md$/i.test(file))) {
      try {
        const data = await library.read(file);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data.bytes).replace(/\r\n/g, '\n');
        const front = text.match(frontmatter);
        let slug = pathSlug(file);
        if (/[\[\]\x00-\x1f]/.test(file)) continue;
        if (front) {
          const parsed = parseDocument(front[1], { schema: 'core', logLevel: 'silent' });
          if (parsed.errors.length || parsed.warnings.length) continue;
          const explicit = parsed.get('slug', true);
          if (explicit !== undefined) {
            if (!isScalar(explicit) || typeof explicit.value !== 'string' || !explicit.value) continue;
            if (slug && pathSlug(explicit.value) !== slug) continue;
            slug = explicit.value;
          }
        }
        if (!slug) continue;
        if (!mapped.has(slug)) mapped.set(slug, []);
        mapped.get(slug).push({ path: file, modified: data.modified, version: data.version, body: normalize(front ? text.slice(front[0].length) : text) });
      } catch { /* Unreadable local files cannot become search navigation targets. */ }
    }
    return mapped;
  }
  async function page(slug) {
    if (typeof slug !== 'string' || !slug || slug.length > 1000 || /[\x00-\x1f]/.test(slug)) throw failure(400, '无效知识 ID');
    const data = await call('get_page', { slug, source_id: config.sourceId, include_content: true });
    if (data.slug !== slug || data.source_id !== config.sourceId || typeof data.content !== 'string' || typeof data.compiled_truth !== 'string') throw unavailable();
    return data;
  }
  function localFor(data, mapping) {
    const matches = mapping.get(data.slug) ?? [];
    if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'outside' };
    const { body, ...local } = matches[0];
    return { status: 'available', ...local, bodyMatches: body === normalize(data.compiled_truth) };
  }
  async function search(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 500 || /[\x00-\x1f]/.test(query)) throw failure(400, '请输入 1—500 字的搜索内容');
    const response = await call('recall', { query, limit: 10 });
    if (!Array.isArray(response.results) || response.results.length > 10) throw unavailable();
    const mapping = await paths();
    const pages = new Map();
    const results = await Promise.all(response.results.map(async hit => {
      if (typeof hit.slug !== 'string' || typeof hit.chunk !== 'string' || typeof hit.title !== 'string') throw unavailable();
      const result = { slug: hit.slug, title: hit.title, snippet: hit.chunk, evidence: hit.evidence, local: { status: 'unverified' } };
      try {
        if (!pages.has(hit.slug)) pages.set(hit.slug, page(hit.slug));
        const data = await pages.get(hit.slug);
        // recall may omit source_id. Confirm the snippet against a page in the configured source before linking.
        // GBrain chunks collapse paragraph whitespace; this comparison checks source text, not file-version equality.
        if ((hit.source_id && hit.source_id !== data.source_id) || !snippetText(hit.chunk) || !snippetText(data.content).includes(snippetText(hit.chunk))) return result;
        return { ...result, sourceId: data.source_id, indexedAt: data.updated_at, indexHash: data.content_hash, local: localFor(data, mapping) };
      } catch { return result; }
    }));
    return { query, results, degraded: Boolean(response.search_degraded), limit: 10 };
  }
  async function indexed(slug) {
    if (!config) throw failure(503, '未配置 GBrain 搜索；本地目录仍可浏览');
    const [data, mapping] = await Promise.all([page(slug), paths()]);
    const local = localFor(data, mapping);
    if (local.status !== 'available') throw failure(404, '原文不在展示范围内，或无法唯一映射');
    return { slug, sourceId: data.source_id, indexedAt: data.updated_at, indexHash: data.content_hash, content: data.content, local };
  }
  return { search, indexed };
}
