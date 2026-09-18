const $ = id => document.getElementById(id);
const stages = {draft:'待审核',writing:'正式文件写入中，需恢复',files_written:'文件已保存，待提交',committed:'已提交，待推送',pushed:'已推送，待刷新验收',refresh_failed:'刷新失败，需核对',complete:'已发布并验收',invalid:'任务记录需核对'};
export function initImports() {
  let current, revision = 0, busy = false;
  function setBusy(value) {
    busy = value;
    $('import-jobs').disabled = $('import-upload').disabled = value;
    $('import-category').disabled = $('import-target').disabled = $('import-card').disabled = $('import-save').disabled = value || current?.stage !== 'draft';
  }
  const dirty = () => current?.stage === 'draft' && ($('import-category').value !== (current.category || '') || $('import-target').value !== current.target || $('import-card').value !== current.card);
  function keepDraft() {
    if (!dirty()) return false;
    $('import-status').textContent = '请先保存当前草稿，避免刷新或切换任务丢失修改。'; return true;
  }
  window.addEventListener('beforeunload',event=>{ if (busy || dirty()) { event.preventDefault(); event.returnValue = ''; } });
  async function api(url, body) {
    const response = await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json','X-EvoKBase-Request':'1'},body:JSON.stringify(body)}:{cache:'no-store'});
    const data = await response.json(); if (!response.ok) throw Error(data.error || '导入操作未完成'); return data;
  }
  function show(job) {
    current = job; $('import-draft').hidden = false;
    $('import-task-title').textContent = job.title;
    $('import-version').textContent = `${stages[job.stage]} · 确认版本 ${job.version}`;
    $('import-target').value = job.target; $('import-card').value = job.card;
    $('import-category').value = job.category || '';
    $('import-original').textContent = job.original;
    $('import-download').href = job.originalUrl;
    // The same local Markdown renderer as document viewing; untrusted HTML and remote images stay disabled.
    $('import-preview').innerHTML = job.html;
    $('import-warnings').textContent = job.warnings.join('\n');
    $('import-files').textContent = job.outputs.map(file=>`${file.path}\nSHA256 ${file.sha256}`).join('\n\n');
    $('import-save').disabled = job.stage !== 'draft';
    $('import-category').disabled = $('import-target').disabled = $('import-card').disabled = job.stage !== 'draft';
    $('import-handoff').hidden = job.stage !== 'draft' || !job.category;
    $('import-handoff').href = '/api/imports/'+job.id+'/handoff';
    $('import-status').textContent = job.stage === 'draft' ? (job.category?'草稿仅在独立暂存区。确认前不会进入知识库或索引。':'尚未分类，请选择主题分类并保存，再进行审核交接。') : stages[job.stage] + '；以下保留发布时清单，后续整理位置以知识目录为准。';
  }
  async function refresh() {
    if (busy || keepDraft()) return;
    const run = ++revision;
    try {
      const data = await api('/api/imports'); if (run !== revision) return;
      $('import-form').hidden = !data.enabled;
      $('import-status').textContent = data.enabled ? '上传 Markdown、DOCX 或 PDF，预览后导出审核交接任务。' : '未配置独立暂存目录；现有浏览和搜索仍可使用。';
      $('import-jobs').replaceChildren(new Option('选择已有导入任务',''));
      $('import-categories').replaceChildren(...(data.categories || []).map(name=>new Option(name,name)));
      for (const job of data.jobs) $('import-jobs').append(new Option(`${job.title} · ${stages[job.stage]}`,job.id));
      if (current) { $('import-jobs').value = current.id; const job = await api('/api/imports/'+current.id); if (run === revision && !keepDraft()) show(job); }
    } catch(error) { $('import-status').textContent = error.message; }
  }
  $('import-form').addEventListener('submit',async event=>{
    event.preventDefault(); if (busy || keepDraft()) return; const file = $('import-file').files[0]; if (!file) return;
    ++revision; setBusy(true); $('import-status').textContent = '正在校验并保存到暂存区…';
    try {
      if (file.size > (/\.md$/i.test(file.name)?4:16)*1024*1024) throw Error('Markdown 上限 4 MiB，DOCX / PDF 上限 16 MiB');
      const bytes = new Uint8Array(await file.arrayBuffer()); let raw = '';
      for (let offset=0;offset<bytes.length;offset+=32768) raw += String.fromCharCode(...bytes.subarray(offset,offset+32768));
      const job = await api('/api/imports',{name:file.name,base64:btoa(raw),title:$('import-title').value,source:$('import-source').value,category:$('import-new-category').value.split('/').map(part=>part.trim()).join('/')});
      show(job); setBusy(false); await refresh();
    } catch(error) { $('import-status').textContent = error.message; }
    finally { setBusy(false); }
  });
  $('import-jobs').addEventListener('change',async()=>{
    if (busy || keepDraft()) { $('import-jobs').value = current?.id || ''; return; }
    const id = $('import-jobs').value, run = ++revision;
    if (!id) { current = null; $('import-draft').hidden = true; return; }
    try {
      const job = await api('/api/imports/'+id);
      if (run === revision) { if (keepDraft()) $('import-jobs').value = current.id; else show(job); }
    }
    catch(error) { if (run === revision) $('import-status').textContent = error.message; }
  });
  for (const id of ['import-category','import-target','import-card']) $(id).addEventListener('input',()=>{
    if (id==='import-category' && current) {
      const category = $('import-category').value.split('/').map(part=>part.trim()).join('/');
      $('import-target').value = current.resourceRoot+'/'+(category?category+'/':'')+$('import-target').value.split('/').at(-1);
    }
    if (id==='import-target' && current) $('import-category').value = $('import-target').value.startsWith(current.resourceRoot+'/') ? $('import-target').value.slice(current.resourceRoot.length+1).split('/').slice(0,-1).join('/') : '';
    $('import-handoff').hidden = true; $('import-status').textContent = '存在未保存修改；保存后会产生新的确认版本，旧审核不能复用。';
  });
  $('import-save').addEventListener('click',async()=>{
    if (!current || busy) return;
    ++revision; setBusy(true);
    try { show(await api('/api/imports/'+current.id,{version:current.version,target:$('import-target').value,card:$('import-card').value,category:$('import-category').value.split('/').map(part=>part.trim()).join('/')})); }
    catch(error) { $('import-status').textContent = error.message; }
    finally { setBusy(false); }
  });
  return {refresh};
}
