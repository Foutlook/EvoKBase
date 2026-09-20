const $ = id => document.getElementById(id);
const stages = {draft:'待审核',writing:'正式文件写入中，需恢复',files_written:'文件已保存，待提交',committed:'已提交，待推送',pushed:'已推送，待刷新验收',refresh_failed:'刷新失败，需核对',complete:'已发布并验收',invalid:'任务记录需核对'};
export function initImports(source = 'local') {
  let current, revision = 0, busy = false, imaPage, imaLibrariesNext, imaFolder='', imaRequests=[], selectedToken='', yuqueState;
  const knowledgeMode=()=>$('ima-source').value==='knowledge';
  function imaControls() {
    $('ima-fields').disabled=busy;
    $('ima-prev').disabled=busy || !imaPage || imaPage.start===0;
    $('ima-next').disabled=busy || !imaPage || imaPage.isEnd;
    $('ima-import').disabled=busy || !selectedToken;
    $('ima-libraries-more').disabled=busy || !imaLibrariesNext;
    $('ima-import').textContent=imaPage?.items.find(item=>item.token===selectedToken)?.kind==='folder'?'打开文件夹 →':'暂存所选资料 →';
  }
  function setBusy(value) {
    busy = value;
    $('import-jobs').disabled = $('import-upload').disabled = value;
    $('import-category').disabled = $('import-target').disabled = $('import-card').disabled = $('import-save').disabled = value || current?.stage !== 'draft';
    imaControls();
    $('yuque-fields').disabled=value || !yuqueState?.configured || !yuqueState?.enabled;
    $('yuque-config-fields').disabled=value || !yuqueState || yuqueState.environment;
    $('yuque-clear').disabled=value || !yuqueState?.configured || yuqueState.environment;
    $('import-check-update').disabled=value || current?.remoteSource?.platform!=='ima' || !['draft','complete'].includes(current?.stage);
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
    $('import-source-update').hidden=job.remoteSource?.platform!=='ima';
    $('import-check-update').disabled=busy || !['draft','complete'].includes(job.stage);
    $('import-update-status').textContent=selectedToken?'将同时核对上方所选条目的标题等来源信息；必须与此任务属于同一篇资料。':'当前只检查原件。要核对改名，请先在 IMA 列表中重新选中同一篇资料，再点击检查。';
    $('import-previous').hidden=!job.previousSnapshot;
    $('import-previous-text').textContent=job.previousSnapshot?.original || '';
    $('import-previous-info').textContent=job.previousSnapshot?.error || (job.previousSnapshot?`原任务 ${job.previousSnapshot.id} · 对照版本 ${job.previousSnapshot.version}。${job.previousSnapshot.currentVersion!==job.previousSnapshot.version?'原任务资料卡或目录已修改，审核时重新核对。':''}${updateChangeNotice(job.remoteSource.updateOf)}${localUpdateNotice(job.remoteSource.updateOf)}`:'');
    $('import-download').href = job.originalUrl;
    $('import-download').textContent=job.remoteSource?.platform==='yuque'?'下载语雀 Markdown 正文快照':job.remoteSource?(job.format==='bin'?'下载网页 HTML 快照（不执行）':job.format==='txt' || job.remoteSource.kind==='note'?'下载接口纯文本快照（不含附件）':'下载平台原文件，对照核对'):'下载完整原件，对照核对';
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
      $('import-form').hidden = source !== 'local' || !data.enabled;
      $('import-status').textContent = data.enabled ? '' : '未配置独立暂存目录；现有浏览和搜索仍可使用。';
      $('import-jobs').replaceChildren(new Option('选择已有导入任务',''));
      $('import-categories').replaceChildren(...(data.categories || []).map(name=>new Option(name,name)));
      for (const job of data.jobs) $('import-jobs').append(new Option(`${job.title} · ${stages[job.stage]}`,job.id));
      if (current) { $('import-jobs').value = current.id; const job = await api('/api/imports/'+current.id); if (run === revision && !keepDraft()) show(job); }
      if (source === 'ima') try {
        const ima=await api('/api/ima'); if(run!==revision) return;
        $('ima-form').hidden=!ima.enabled || !ima.configured;
        $('ima-connection').textContent=!ima.enabled?'请先配置独立暂存目录。':ima.configured?'已连接本机 IMA 凭据 · 仅在暂存或手动检查更新时读取正文。':'未找到完整 IMA 凭据，请展开连接设置。';
        if (!imaPage) $('ima-status').textContent='选择知识库后浏览或搜索，也可以切换到笔记。';
      } catch(error) { $('ima-form').hidden=true; $('ima-connection').textContent=error.message; }
      if (source === 'yuque') {
        $('yuque-token').value='';
        try {
          const state=await api('/api/yuque'); if(run!==revision) return;
          yuqueState=state; setBusy(false);
          $('yuque-key-status').textContent=state.environment?'正在使用本机 YUQUE_TOKEN 环境变量，页面不修改此凭据。':state.configured?'本机 Token 已保存，不回显；填写新 Token 可替换。':'还没有配置 Token。';
          $('yuque-status').textContent=!state.enabled?'请先配置独立暂存目录。':state.configured?'Token 已配置；读取文档时会验证访问权限。':'先连接语雀，再粘贴文档链接。';
          $('yuque-settings').open=!state.configured;
        } catch(error) { yuqueState=null; setBusy(false); $('yuque-status').textContent=error.message; }
      }
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
  function localUpdateNotice(comparison) {
    const changes=comparison?.localChanges || [];
    return changes.length?'检测到原归档文件被编辑或缺失（也可能已移动），保留原文件，审核时需人工核对：'+changes.map(file=>file.path).join('、'):'原任务与已归档文件均未被此操作修改。';
  }
  function updateChangeNotice(comparison) {
    if(!comparison?.changes) return '';
    const labels={title:'标题',libraryTitle:'知识库名称',parentFolderId:'所在目录标识',modifiedAt:'列表修改时间（毫秒）'};
    return (comparison.changes.content?'原件字节有变化。':'原件字节未变化。')+comparison.changes.metadata.map(change=>`${labels[change.field] || change.field}：${change.before??'此前未记录'} → ${change.after}。`).join('');
  }
  $('import-check-update').addEventListener('click',async()=>{
    if(!current || busy || keepDraft()) return;
    const input={action:'check-update',id:current.id,version:current.version,...(selectedToken?{token:selectedToken}:{})};
    ++revision; setBusy(true); $('import-update-status').textContent='正在读取当前 IMA 原件并比对…';
    try {
      const result=await api('/api/ima',input);
      if(result.changed) { show(result.job); setBusy(false); await refresh(); }
      $('import-update-status').textContent=(result.changed?(result.reused?'相同更新已有任务，已打开；没有重复暂存。':'发现变化，已创建新草稿；请对照正文和来源信息重新审核。'):(result.comparison?.metadataFields?.length?'原件及本次核对的来源信息未变化，没有创建新任务。':'原件内容未变化，没有创建新任务；本次未核对标题等来源信息。'))+(result.changed?updateChangeNotice(result.comparison):'')+localUpdateNotice(result.comparison);
    } catch(error) { $('import-update-status').textContent=error.message+'；原任务和本地资料保持不变。'; }
    finally { setBusy(false); }
  });
  async function configureYuque(action) {
    if(busy || keepDraft() || !yuqueState) return;
    const input={action,version:yuqueState.version,...(action==='configure'?{token:$('yuque-token').value}:{})};
    $('yuque-token').value=''; ++revision; setBusy(true);
    try { await api('/api/yuque',input); setBusy(false); await refresh(); }
    catch(error) { $('yuque-status').textContent=error.message; }
    finally { setBusy(false); }
  }
  $('yuque-config').addEventListener('submit',event=>{event.preventDefault(); return configureYuque('configure');});
  $('yuque-clear').addEventListener('click',()=>configureYuque('clear'));
  $('yuque-form').addEventListener('submit',async event=>{
    event.preventDefault(); if(busy || keepDraft() || !yuqueState?.configured) return;
    const input={action:'import',version:yuqueState.version,url:$('yuque-url').value.trim(),category:$('yuque-category').value.split('/').map(part=>part.trim()).join('/')};
    ++revision; setBusy(true); $('yuque-status').textContent='正在读取语雀正文并暂存…';
    try { show(await api('/api/yuque',input)); setBusy(false); await refresh(); $('yuque-status').textContent='已暂存，请在下方核对正文、来源和未读取范围。'; }
    catch(error) { $('yuque-status').textContent=error.message; }
    finally { setBusy(false); }
  });
  function resetImaResults() {
    imaPage=null; imaRequests=[]; clearImaResults(); imaControls();
  }
  function clearImaResults() {
    selectedToken=''; $('ima-results').replaceChildren(); $('ima-result-count').textContent='';
    if(current?.remoteSource?.platform==='ima') $('import-update-status').textContent='当前未选择列表条目，仅检查原件。核对改名需重新选中同一篇资料。';
    $('ima-empty').hidden=false; $('ima-empty').textContent=knowledgeMode()?'选择知识库后，点击“搜索 / 浏览”查看资料。':'输入标题关键词，搜索你的笔记。';
  }
  function renderImaResults() {
    $('ima-result-count').textContent=String(imaPage.items.length);
    $('ima-empty').hidden=imaPage.items.length>0; $('ima-empty').textContent='没有找到资料，试试其他关键词。';
    for (const item of imaPage.items) {
      const row=document.createElement('label'), radio=document.createElement('input'), text=document.createElement('span'), title=document.createElement('strong'), detail=document.createElement('small');
      row.className='ima-result'; radio.type='radio'; radio.name='ima-item'; radio.value=item.token;
      title.textContent=item.title;
      const date=item.modifiedAt?new Date(Number(item.modifiedAt)):null;
      detail.textContent=item.kind==='folder'?'文件夹 · 选择后打开':knowledgeMode()?'知识库资料':date && !Number.isNaN(date.getTime())?'笔记 · '+date.toLocaleString():'笔记';
      text.append(title,detail); row.append(radio,text); $('ima-results').append(row);
    }
  }
  async function loadLibraries(more=false) {
    if(busy || keepDraft()) return;
    ++revision; setBusy(true); $('ima-status').textContent='正在读取知识库列表…';
    try {
      const page=await api('/api/ima',more?{action:'page',token:imaLibrariesNext}:{action:'libraries'});
      if(!more) { $('ima-library').replaceChildren(new Option('请选择知识库','')); imaFolder=''; resetImaResults(); }
      for(const item of page.items) $('ima-library').append(new Option(`${item.title}${item.baseType?' · '+item.baseType:''}`,item.token));
      imaLibrariesNext=page.nextToken;
      $('ima-status').textContent='选择知识库后搜索；关键词留空可浏览。订阅库资料能否导出由 IMA 权限决定。';
    } catch(error) { $('ima-status').textContent=error.message; }
    finally { setBusy(false); }
  }
  $('ima-libraries-load').addEventListener('click',()=>loadLibraries());
  $('ima-libraries-more').addEventListener('click',()=>loadLibraries(true));
  $('ima-source').addEventListener('change',()=>{
    $('ima-knowledge').hidden=!knowledgeMode(); $('ima-query').required=!knowledgeMode();
    $('ima-root').hidden=!knowledgeMode(); $('ima-query').placeholder=knowledgeMode()?'搜索资料，留空可浏览全部':'按标题关键词搜索笔记';
    imaFolder=''; resetImaResults(); $('ima-status').textContent=knowledgeMode()?'请加载并选择知识库，包含平台提供的个人知识库。':'笔记按标题筛选当前返回页，不包含收藏的网页和文件。';
  });
  $('ima-library').addEventListener('change',()=>{imaFolder=''; resetImaResults();});
  $('ima-root').addEventListener('click',()=>{imaFolder=''; $('ima-query').value=''; return searchIma(0);});
  async function searchIma(start) {
    if(busy || keepDraft()) return;
    const query=$('ima-query').value.trim();
    let body={action:'search',query,start};
    if(knowledgeMode()) {
      if(!$('ima-library').value) { $('ima-status').textContent='请先加载并选择知识库。'; return; }
      if(start===0) imaRequests=[{action:'knowledge',token:imaFolder||$('ima-library').value,query}];
      body=imaRequests[start]; if(!body) return;
    }
    ++revision; setBusy(true); $('ima-status').textContent='正在读取 IMA 资料列表…';
    imaPage=null; clearImaResults(); $('ima-empty').textContent='正在读取资料列表…';
    try {
      imaPage=await api('/api/ima',body);
      if(knowledgeMode()) { imaPage.start=start; imaPage.isEnd=!imaPage.nextToken; if(imaPage.nextToken) imaRequests[start+20]={action:'page',token:imaPage.nextToken}; }
      renderImaResults();
      $('ima-status').textContent=`${imaPage.scope||'笔记'} · 第 ${start/20+1} 页${imaPage.notice?' · '+imaPage.notice:''}`;
    } catch(error) { $('ima-status').textContent=error.message; $('ima-empty').textContent='列表读取失败，请重试。'; }
    finally { setBusy(false); }
  }
  $('ima-form').addEventListener('submit',event=>{event.preventDefault(); return searchIma(0);});
  $('ima-prev').addEventListener('click',()=>searchIma(Math.max(0,(imaPage?.start||0)-20)));
  $('ima-next').addEventListener('click',()=>searchIma((imaPage?.start||0)+20));
  $('ima-query').addEventListener('input',resetImaResults);
  $('ima-results').addEventListener('change',event=>{
    selectedToken=event.target.value; imaControls();
    if(current?.remoteSource?.platform==='ima') $('import-update-status').textContent='已选择列表条目；点击“检查 IMA 更新”会校验是否同源，并核对原件与该条目的来源信息。';
  });
  $('ima-import').addEventListener('click',async()=>{
    if(busy || keepDraft() || !selectedToken) return;
    if(imaPage?.items.find(item=>item.token===selectedToken)?.kind==='folder') { imaFolder=selectedToken; $('ima-query').value=''; return searchIma(0); }
    const category=$('ima-category').value.split('/').map(part=>part.trim()).join('/');
    if(!category) { $('ima-status').textContent='请先填写主题分类。'; $('ima-category').focus(); return; }
    ++revision; setBusy(true); $('ima-status').textContent='正在读取所选资料并暂存…';
    try {
      const job=await api('/api/ima',{action:'import',token:selectedToken,category});
      show(job); resetImaResults(); setBusy(false); await refresh();
      $('ima-status').textContent='已暂存，请在下方核对来源、未读取范围与正文并导出审核交接。';
    } catch(error) { $('ima-status').textContent=error.message; }
    finally { setBusy(false); }
  });
  return {refresh};
}
