const $ = id => document.getElementById(id);
const stages = {draft:'待你确认',archiving:'保存未完成，可继续保存',archived:'已存入本地知识库',writing:'正式文件写入中，需恢复',files_written:'文件已保存，待提交',committed:'已提交，待推送',pushed:'已推送，待刷新验收',refresh_failed:'刷新失败，需核对',complete:'已发布并验收',invalid:'任务记录需核对'};
export function initImports(source = 'local') {
  let current, revision = 0, busy = false, imaPage, imaLibrariesNext, imaFolder='', imaRequests=[], selectedToken='', yuqueState;
  let processingState, pollTimer, pollRevision=0, modelConfigured=false;
  let candidateDirty=false, candidateFields=[], displayedRun;
  let enabled=false;
  let imaRevision=0, imaLoading=false, imaLibrariesLoaded=false;
  let resumeId;
  try { resumeId=window.sessionStorage.getItem('evokbase.importTask'); } catch {}
  const connectedSources=new Set();
  const knowledgeMode=()=>$('ima-source').value==='knowledge';
  function progress(tone,title,detail,step=1) {
    $('import-progress').hidden=false;
    $('import-progress').className='import-progress '+tone;
    $('import-progress-title').textContent=title;
    $('import-progress-detail').textContent=detail;
    $('import-progress-open').hidden=!current || step===1;
    for(let index=1;index<=3;index++) {
      $('import-step-'+index).className=index<step?'done':index===step?'active':'';
      $('import-step-'+index).ariaCurrent=index===step?'step':null;
    }
  }
  function importing(title) {
    // A pending poll for the previous article must not overwrite this import's feedback.
    ++pollRevision; if(pollTimer) clearTimeout(pollTimer);
    progress('working','正在准备导入',title+' · 正在准备读取正文；启用 AI 整理时会先请你确认。');
    $('import-progress').focus();
  }
  function imaControls() {
    $('ima-fields').disabled=busy;
    $('ima-library').disabled=$('ima-query').disabled=busy || imaLoading==='libraries';
    $('ima-prev').disabled=busy || imaLoading || !imaPage || imaPage.start===0;
    $('ima-next').disabled=busy || imaLoading || !imaPage || imaPage.isEnd;
    $('ima-import').disabled=busy || imaLoading || !selectedToken;
    $('ima-libraries-load').disabled=busy || imaLoading;
    $('ima-libraries-more').disabled=busy || imaLoading || !imaLibrariesNext;
    $('ima-import').textContent=imaPage?.items.find(item=>item.token===selectedToken)?.kind==='folder'?'打开文件夹 →':'导入所选资料 →';
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
    $('import-auto-process').disabled=value || !modelConfigured;
    processingControls();
  }
  const dirty = () => current?.stage === 'draft' && (candidateDirty || $('import-category').value !== (current.category || '') || $('import-target').value !== current.target || $('import-card').value !== current.card);
  function keepDraft() {
    if (!dirty()) return false;
    $('import-status').textContent = '有尚未保存的修改，请先点击“下一步”保存选择；高级文本修改请使用“保存草稿与目标”。'; return true;
  }
  window.addEventListener('beforeunload',event=>{ if (busy || dirty()) { event.preventDefault(); event.returnValue = ''; } });
  async function api(url, body) {
    const response = await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json','X-EvoKBase-Request':'1'},body:JSON.stringify(body)}:{cache:'no-store'});
    const data = await response.json(); if (!response.ok) throw Error(data.error || '导入操作未完成'); return data;
  }
  function processingControls() {
    const running=['queued','running'].includes(processingState?.status);
    $('processing-start').disabled=busy || running || current?.stage!=='draft';
    $('processing-cancel').hidden=!running;
    $('processing-cancel').disabled=busy;
    $('processing-adopt').disabled=busy || dirty() || processingState?.status!=='ready' || processingState?.stale || current?.stage!=='draft';
    $('review-prepare').disabled=busy || running || current?.stage!=='draft';
    $('review-confirm').disabled=busy || !$('review-confirm-check').checked || !current?.review || dirty();
    $('review-back').disabled=busy || current?.stage!=='draft';
    for(const fields of candidateFields) for(const field of [fields.keep,fields.title,fields.claim]) field.disabled=busy || current?.stage!=='draft';
  }
  function selectedPoints() { return candidateFields.filter(fields=>fields.keep.checked).map(fields=>({index:fields.index,title:fields.title.value,claim:fields.claim.value})); }
  function selectionChanged() {
    candidateDirty=true; $('review-confirmation').hidden=true; $('review-controls').hidden=false; $('review-confirm-check').checked=false;
    $('review-count').textContent=`已选择 ${selectedPoints().length} 条要点。不选择要点时，只保存原文和已有备注。`;
    processingControls();
  }
  function renderCandidates(data) {
    const stamp=current.id+':'+(data.runId||'')+':'+data.status+':'+(current.review?.token||'');
    if(displayedRun===stamp) return;
    displayedRun=stamp; candidateFields=[]; $('review-candidates').replaceChildren();
    $('review-summary').textContent=data.result?.summary||'';
    const labels={new:'新增内容',supplement:'可以补充已有知识',conflict:'与已有知识有分歧',duplicate:'已有相近内容',uncertain:'还需要核实'};
    for(const [index,item] of (data.result?.candidates||[]).entries()) {
      const saved=current.review?.runId===data.runId?current.review.selections.find(point=>point.index===index):undefined;
      const card=document.createElement('section'); card.className='review-point';
      const top=document.createElement('div'); top.className='review-point-top';
      const label=document.createElement('label'), keep=document.createElement('input'); keep.type='checkbox';
      keep.checked=current.review?.runId===data.runId?Boolean(saved):['new','supplement'].includes(item.action); label.append(keep,document.createTextNode('保留这条'));
      const badge=document.createElement('span'); badge.textContent=labels[item.action]; top.append(label,badge);
      const titleLabel=document.createElement('label'), title=document.createElement('input'); title.id='point-title-'+index; title.maxLength=160; title.value=saved?.title||item.title; titleLabel.htmlFor=title.id; titleLabel.textContent='要点 '+(index+1)+' · 标题';
      const claimLabel=document.createElement('label'), claim=document.createElement('textarea'); claim.id='point-claim-'+index; claim.maxLength=3000; claim.rows=4; claim.value=saved?.claim||item.claim; claimLabel.htmlFor=claim.id; claimLabel.textContent='值得记住的内容';
      const reason=document.createElement('p'); reason.className='review-comparison'; reason.textContent='与已有知识的比较：'+item.reason;
      const details=document.createElement('details'), summary=document.createElement('summary'); summary.textContent='查看原文依据和对照来源'; details.append(summary);
      const quote=document.createElement('blockquote'); quote.textContent=item.sourceQuote; details.append(quote);
      for(const ref of item.evidence) { const source=data.references.find(source=>source.id===ref.id), p=document.createElement('p'), link=document.createElement('a'); link.textContent=source?.title||source?.path||ref.id; link.href='/?doc='+encodeURIComponent(source?.path||''); link.target='_blank'; link.rel='noopener'; p.append(link,document.createTextNode('：'+ref.quote)); details.append(p); }
      card.append(top,titleLabel,title,claimLabel,claim,reason,details); $('review-candidates').append(card);
      candidateFields.push({index,keep,title,claim});
      for(const field of [keep,title,claim]) field.addEventListener('input',selectionChanged);
    }
    $('review-question-list').replaceChildren();
    for(const text of data.result?.questions||[]) { const li=document.createElement('li'); li.textContent=text; $('review-question-list').append(li); }
    $('review-questions').hidden=!data.result?.questions?.length;
    $('review-count').textContent=`已选择 ${selectedPoints().length} 条要点。不选择要点时，只保存原文和已有备注。`;
  }
  function showConfirmation() {
    const record=current.review, archived=current.stage==='archived';
    $('review-saved').hidden=!archived; $('review-controls').hidden=archived || Boolean(record);
    $('review-confirmation').hidden=!record || !['draft','archiving'].includes(current.stage);
    $('review-editor').hidden=archived || Boolean(record);
    $('review-confirm-check').checked=false;
    $('review-status').textContent='';
    $('review-full-section').hidden=!record; $('review-full-card').textContent='';
    if(!record) return;
    if(current.stage==='draft') $('import-status').textContent='选择已保存。核对下面的内容，确认后存入本地知识库。';
    $('review-open').href=record.documentUrl;
    $('review-destination').textContent=`保存到「${current.category}」 · 原文及附件 ${Math.max(1,current.outputs.length-1)} 份 · 保留 ${record.selections.length} 条要点`;
    $('review-classification').textContent=record.classification?`${record.classification.isNew?'确认保存时新建分类':'使用已有分类'}。${record.classification.reason}`:'';
    $('review-final-items').replaceChildren();
    for(const item of record.selections) { const section=document.createElement('section'), title=document.createElement('h3'), text=document.createElement('p'); title.textContent=item.title; text.textContent=item.claim; section.append(title,text); $('review-final-items').append(section); }
    $('review-full-card').textContent=current.card;
  }
  $('review-prepare').addEventListener('click',async()=>{
    if(!current || busy) return;
    if($('import-card').value!==current.card) { $('review-status').textContent='高级文本有未保存修改，请先点击“保存草稿与目标”。'; return; }
    setBusy(true); $('review-status').textContent='正在根据保留的要点选择分类并生成保存预览…';
    progress('working','正在自动归类','正在匹配已有主题分类，完成后会显示保存位置和归类理由。',3);
    try { show(await api('/api/imports/'+current.id+'/review',{action:'prepare',version:current.version,runId:processingState?.runId,selections:selectedPoints()})); }
    catch(error) { $('review-status').textContent=error.message; progress('error','保存预览未完成',error.message,3); }
    finally { setBusy(false); }
  });
  $('review-confirm-check').addEventListener('change',processingControls);
  $('review-back').addEventListener('click',()=>{if(busy)return; $('review-confirmation').hidden=true; $('review-editor').hidden=false; $('review-controls').hidden=false; $('review-confirm-check').checked=false; $('import-status').textContent='修改要点后，点击“下一步”重新核对保存内容。'; processingControls();});
  $('review-confirm').addEventListener('click',async()=>{
    if(busy || dirty() || !current?.review || !$('review-confirm-check').checked) return;
    const id=current.id, input={action:'confirm',version:current.version,token:current.review.token,confirmed:true};
    setBusy(true); $('review-save-status').textContent='正在保存到本地知识库…';
    progress('working','正在保存到本地知识库','正在保存已确认的原文与要点，请勿重复点击。',3);
    try { show(await api('/api/imports/'+id+'/review',input)); $('review-save-status').textContent='保存成功，已可在本地知识库查看。'; }
    catch(error) { try { show(await api('/api/imports/'+id)); } catch {} $('review-save-status').textContent=error.message+'；未确认保存完成。'; progress('error','保存未完成',$('review-save-status').textContent,3); }
    finally { setBusy(false); }
  });
  function showProcessing(data={status:'idle'}) {
    const pollRun=++pollRevision;
    processingState=data;
    const names={idle:'还没有整理结果。可以点击“开始整理”，也可以直接保存原文。',queued:'资料已收到，正在排队整理…',running:'正在阅读资料、对照已有知识，稍后会在这里显示结果。',ready:'整理好了。选择你想保留的内容，也可以直接修改文字。',failed:'整理失败，原文已保留。可以重试，或直接保存原文。',cancelled:'整理已取消，仍可保存原文。',interrupted:'上次整理已中断，可以重试。'};
    if(data.status==='running' && data.progress) {
      const {phase,completedParts,totalParts}=data.progress;
      names.running={searching:'正在查找可对照的已有知识…',full:'正在整篇阅读资料并提炼要点…',part:`模型反馈容量不足，已自动分段；正在整理第 ${Math.min(completedParts+1,totalParts)} / ${totalParts} 段，后续可能继续细分。`,merging:`已读取 ${completedParts} / ${totalParts} 段，正在合并要点并去重…`,checking:'正在核对引用及资料版本…'}[phase]||names.running;
    }
    if(data.status==='ready' && data.progress?.totalParts>1) names.ready+=` 已完成 ${data.progress.totalParts} 段处理并合并结果。`;
    $('processing-status').textContent=(names[data.status]||'状态需核对')+(data.error?' '+data.error:'')+(data.stale && !current?.review?' 原资料版本已变化，请重新整理。':'')+(data.status==='ready'?` 已按标题检索并对照 ${data.references.length} 份已有知识，仅覆盖本次找到的内容。${data.searchDegraded?' 部分搜索结果暂不可用。':''}`:'');
    $('processing-start').textContent=data.status==='idle'?'开始整理':'重新整理';
    if(current.stage==='archived' || current.stage==='complete') progress('ready',stages[current.stage],current.title+(current.stage==='archived'?' · 原文与要点已保存，远程同步和索引尚未更新。':' · 可继续浏览和检索。'),4);
    else if(current.stage!=='draft') progress('error',stages[current.stage],current.title+' · 请核对保存状态。',3);
    else if(data.status==='ready') progress(data.stale && !current.review?'error':'ready',current.review?'等待确认保存':`整理完成 · ${data.result?.candidates?.length||0} 条要点待审核`,$('processing-status').textContent,3);
    else if(['queued','running'].includes(data.status)) progress('working',data.status==='queued'?'资料已导入，等待整理':'正在整理资料',current.title+' · '+$('processing-status').textContent,2);
    else progress(data.status==='idle'?'':'error',data.status==='idle'?'资料已导入，尚未整理':'资料已保留，整理未完成',$('processing-status').textContent,2);
    $('processing-result').hidden=data.status!=='ready'; $('processing-result').textContent=data.markdown||'';
    renderCandidates(data);
    processingControls();
    if(pollTimer) clearTimeout(pollTimer);
    if(['queued','running'].includes(data.status)) {
      const id=current.id;
      pollTimer=setTimeout(async()=>{
        try { const next=await api('/api/imports/'+id+'/processing'); if(current?.id===id && pollRun===pollRevision) showProcessing(next); }
        catch(error) { if(current?.id===id && pollRun===pollRevision) { $('processing-status').textContent=error.message+'；刷新可恢复查看。'; progress('error','暂时无法读取整理进度',$('processing-status').textContent,2); } }
      },1500);
    }
  }
  async function processingConsent(title,force=false) {
    if(!force && !$('import-auto-process').checked) return undefined;
    const state=await api('/api/models'), provider=state.providers?.find(item=>item.id===state.selected);
    if(!state.enabled || !provider?.available) throw Error('请先选择已安装的本地 Harness，或取消自动整理。');
    if(!window.confirm(`使用本机 ${provider.name} 整理《${title}》。\n会将本篇正文及最多 3 份旧知识片段交给 Harness，由其已登录的模型处理，可能产生用量。模型明确报告容量不足时，会自动分段并多次调用后合并结果。\n本地调用不等于离线；整理结果由你审核后保存。是否继续？`)) throw Error('已取消本次操作，未发送资料。');
    return {confirmed:true,provider:provider.id,modelVersion:state.version};
  }
  $('processing-start').addEventListener('click',async()=>{
    if(!current || busy || keepDraft()) return;
    setBusy(true);
    progress('working','正在准备整理',current.title+' · 请确认本次整理。',2);
    try {
      const consent=await processingConsent(current.title,true);
      showProcessing(await api('/api/imports/'+current.id+'/processing',{action:'start',sourceVersion:current.version,...consent}));
    } catch(error) { $('processing-status').textContent=error.message; progress('error','整理未启动',error.message,2); }
    finally { setBusy(false); }
  });
  $('processing-cancel').addEventListener('click',async()=>{
    if(!current || busy) return;
    try { showProcessing(await api('/api/imports/'+current.id+'/processing',{action:'cancel'})); }
    catch(error) { $('processing-status').textContent=error.message; }
  });
  $('processing-adopt').addEventListener('click',()=>{
    if(busy || dirty() || processingState?.status!=='ready' || processingState.stale || current?.stage!=='draft') return;
    if($('import-card').value.includes(processingState.markdown)) { $('processing-status').textContent='这份候选已在资料卡中。'; return; }
    $('import-card').value+=processingState.markdown;
    $('import-handoff').hidden=true; $('import-status').textContent='候选已填入，尚未保存。请核对、编辑后保存草稿。'; processingControls();
  });
  window.addEventListener('pagehide',()=>{if(pollTimer) clearTimeout(pollTimer);});
  function show(job) {
    const opened=current?.id!==job.id;
    current = job; candidateDirty=false; displayedRun=undefined; $('import-draft').hidden = false;
    resumeId=job.id;
    try { window.sessionStorage.setItem('evokbase.importTask',job.id); } catch {}
    $('import-intake').open=false;
    $('review-save-status').textContent='';
    for(const option of $('import-jobs').options||[]) if(option.value===job.id) option.textContent=job.title+' · '+stages[job.stage];
    $('import-task-title').textContent = job.title;
    $('import-version').textContent = stages[job.stage];
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
    $('import-handoff').hidden = !['draft','archived'].includes(job.stage) || !job.category;
    $('import-handoff').href = '/api/imports/'+job.id+'/handoff';
    $('import-status').textContent = job.stage === 'draft' ? `《${job.title}》已导入，当前进度如下。` : stages[job.stage];
    showProcessing(job.processing);
    showConfirmation(); processingControls();
    if(job.processingError) { $('processing-status').textContent='资料已暂存，但自动处理未启动：'+job.processingError; progress('error','资料已保留，整理未启动',job.processingError,2); }
    if(opened) $('import-progress').focus();
  }
  async function refresh(preserveDraft=false) {
    if (busy || (!preserveDraft && keepDraft())) return;
    const run = ++revision;
    try {
      const data = await api('/api/imports'); if (run !== revision) return;
      enabled=data.enabled;
      $('import-form').hidden = source !== 'local' || !enabled;
      if (!preserveDraft || !current) $('import-status').textContent = enabled ? '' : '未配置独立暂存目录；现有浏览和搜索仍可使用。';
      $('import-jobs').replaceChildren(new Option('选择已有导入任务',''));
      $('import-categories').replaceChildren(...(data.categories || []).map(name=>new Option(name,name)));
      for (const job of data.jobs) $('import-jobs').append(new Option(`${job.title} · ${stages[job.stage]}`,job.id));
      const selected=current?.id || (data.jobs.some(job=>job.id===resumeId)?resumeId:null);
      if (selected) $('import-jobs').value=selected;
      try {
        const state=await api('/api/models'); if(run!==revision) return;
        const provider=state.providers?.find(item=>item.id===state.selected);
        modelConfigured=Boolean(state.enabled && provider?.available);
        $('import-model-status').textContent=modelConfigured?`本地 ${provider.name} · ${provider.model}。导入后由此 Harness 整理。`:'请在模型渠道选择已安装的 Harness；仍可直接导入原文。';
      } catch { if(run!==revision) return; modelConfigured=false; $('import-model-status').textContent='本地 Harness 暂不可用，仍可直接导入原文。'; }
      $('import-auto-process').disabled=!modelConfigured; if(!modelConfigured) $('import-auto-process').checked=false;
      if (selected && (!preserveDraft || !current)) { const job = await api('/api/imports/'+selected); if (run !== revision) return; if (!keepDraft()) show(job); }
      if (source === 'ima' && (!preserveDraft || !connectedSources.has('ima'))) try {
        const ima=await api('/api/ima'); if(run!==revision) return;
        $('ima-form').hidden=!ima.enabled || !ima.configured;
        $('ima-connection').textContent=!ima.enabled?'请先配置独立暂存目录。':ima.configured?'已连接本机 IMA 凭据 · 仅在暂存或手动检查更新时读取正文。':'未找到完整 IMA 凭据，请展开连接设置。';
        if (!imaPage) $('ima-status').textContent='选择知识库后浏览或搜索，也可以切换到笔记。';
        connectedSources.add('ima');
        if (ima.enabled && ima.configured && knowledgeMode() && !imaLibrariesLoaded && !imaLoading) await loadLibraries();
      } catch(error) { if(run!==revision) return; $('ima-form').hidden=true; $('ima-connection').textContent=error.message; }
      if (source === 'yuque' && (!preserveDraft || !connectedSources.has('yuque'))) {
        if (!preserveDraft) $('yuque-token').value='';
        try {
          const state=await api('/api/yuque'); if(run!==revision) return;
          yuqueState=state; setBusy(false);
          $('yuque-key-status').textContent=state.environment?'正在使用本机 YUQUE_TOKEN 环境变量，页面不修改此凭据。':state.configured?'本机 Token 已保存，不回显；填写新 Token 可替换。':'还没有配置 Token。';
          $('yuque-status').textContent=!state.enabled?'请先配置独立暂存目录。':state.configured?'Token 已配置；读取文档时会验证访问权限。':'先连接语雀，再粘贴文档链接。';
          $('yuque-settings').open=!state.configured;
          connectedSources.add('yuque');
        } catch(error) { if(run!==revision) return; yuqueState=null; setBusy(false); $('yuque-status').textContent=error.message; }
      }
    } catch(error) { if(run===revision) $('import-status').textContent = error.message; }
  }
  $('import-form').addEventListener('submit',async event=>{
    event.preventDefault(); if (busy || keepDraft()) return; const file = $('import-file').files[0]; if (!file) return;
    ++revision; setBusy(true); $('import-status').textContent = '正在校验并保存到暂存区…';
    importing($('import-title').value||file.name);
    try {
      if (file.size > (/\.md$/i.test(file.name)?4:16)*1024*1024) throw Error('Markdown 上限 4 MiB，DOCX / PDF 上限 16 MiB');
      const bytes = new Uint8Array(await file.arrayBuffer()); let raw = '';
      for (let offset=0;offset<bytes.length;offset+=32768) raw += String.fromCharCode(...bytes.subarray(offset,offset+32768));
      const processing=await processingConsent($('import-title').value||file.name);
      progress('working','正在导入资料','正在上传、读取正文并创建任务；完成后会自动显示整理进度。');
      const job = await api('/api/imports',{name:file.name,base64:btoa(raw),title:$('import-title').value,source:$('import-source').value,processing});
      show(job); setBusy(false); await refresh();
    } catch(error) { $('import-status').textContent = error.message; progress('error','导入未完成',error.message); }
    finally { setBusy(false); }
  });
  $('import-jobs').addEventListener('change',async()=>{
    if (busy || keepDraft()) { $('import-jobs').value = current?.id || ''; return; }
    const id = $('import-jobs').value, run = ++revision;
    if (!id) { current = null; resumeId=null; try { window.sessionStorage.removeItem('evokbase.importTask'); } catch {} $('import-draft').hidden = $('import-progress').hidden = true; $('import-status').textContent=''; return; }
    try {
      const job = await api('/api/imports/'+id);
      if (run === revision) { if (keepDraft()) $('import-jobs').value = current.id; else show(job); }
    }
    catch(error) { if (run === revision) $('import-status').textContent = error.message; }
  });
  for (const id of ['import-category','import-target','import-card']) $(id).addEventListener('input',()=>{
    if(id==='import-category') { $('review-confirmation').hidden=true; $('review-controls').hidden=false; $('review-confirm-check').checked=false; }
    if (id==='import-category' && current) {
      const category = $('import-category').value.split('/').map(part=>part.trim()).join('/');
      $('import-target').value = current.resourceRoot+'/'+(category?category+'/':'')+$('import-target').value.split('/').at(-1);
    }
    if (id==='import-target' && current) $('import-category').value = $('import-target').value.startsWith(current.resourceRoot+'/') ? $('import-target').value.slice(current.resourceRoot.length+1).split('/').slice(0,-1).join('/') : '';
    $('import-handoff').hidden = true; $('import-status').textContent = '存在未保存修改；保存后会产生新的确认版本，旧审核不能复用。';
    processingControls();
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
      input.processing=await processingConsent(current.title);
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
    const input={action:'import',version:yuqueState.version,url:$('yuque-url').value.trim()};
    ++revision; setBusy(true); $('yuque-status').textContent='正在读取语雀正文并暂存…';
    importing('语雀文档');
    try { input.processing=await processingConsent('此语雀文档'); progress('working','正在导入资料','正在读取语雀正文并创建任务…'); show(await api('/api/yuque',input)); setBusy(false); await refresh(); $('yuque-status').textContent='已暂存，请在下方核对正文、来源和未读取范围。'; }
    catch(error) { $('yuque-status').textContent=error.message; progress('error','导入未完成',error.message); }
    finally { setBusy(false); }
  });
  function resetImaResults() {
    // A changed selection/query invalidates earlier reads without touching the review draft.
    ++imaRevision; imaLoading=false;
    imaPage=null; imaRequests=[]; clearImaResults(); imaControls();
  }
  function clearImaResults() {
    selectedToken=''; $('ima-results').replaceChildren(); $('ima-result-count').textContent='';
    if(current?.remoteSource?.platform==='ima') $('import-update-status').textContent='当前未选择列表条目，仅检查原件。核对改名需重新选中同一篇资料。';
    $('ima-empty').hidden=false; $('ima-empty').textContent=knowledgeMode()?($('ima-library').value?'输入关键词后按回车或点击搜索，留空可浏览。':'选择知识库后自动显示资料。'):'输入标题关键词，搜索你的笔记。';
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
    if(more && !imaLibrariesNext) return;
    if(!more) {
      $('ima-library').replaceChildren(new Option('请选择知识库','')); imaFolder=''; imaLibrariesNext=null; imaLibrariesLoaded=false;
      resetImaResults();
    }
    const run=++imaRevision; imaLoading='libraries'; imaControls(); $('ima-status').textContent='正在读取知识库列表…';
    try {
      const page=await api('/api/ima',more?{action:'page',token:imaLibrariesNext}:{action:'libraries'});
      if(run!==imaRevision) return;
      for(const item of page.items) $('ima-library').append(new Option(`${item.title}${item.baseType?' · '+item.baseType:''}`,item.token));
      imaLibrariesNext=page.nextToken; imaLibrariesLoaded=true;
      $('ima-status').textContent=page.items.length?'选择知识库后自动加载资料；输入关键词可搜索整个知识库。':page.nextToken?'本页没有知识库，可点击“更多”。':'没有可读取的知识库。';
    } catch(error) { if(run===imaRevision) $('ima-status').textContent=error.message+' 可点击“刷新知识库”重试。'; }
    finally { if(run===imaRevision) { imaLoading=false; imaControls(); } }
  }
  $('ima-libraries-load').addEventListener('click',()=>loadLibraries());
  $('ima-libraries-more').addEventListener('click',()=>loadLibraries(true));
  $('ima-source').addEventListener('change',()=>{
    $('ima-knowledge').hidden=!knowledgeMode(); $('ima-query').required=!knowledgeMode();
    $('ima-root').hidden=!knowledgeMode(); $('ima-query').placeholder=knowledgeMode()?'搜索资料，留空可浏览全部':'按标题关键词搜索笔记';
    imaFolder=''; $('ima-query').value=''; resetImaResults();
    if(knowledgeMode()) return loadLibraries();
    $('ima-status').textContent='笔记按标题筛选当前返回页，不包含收藏的网页和文件。';
  });
  $('ima-library').addEventListener('change',()=>{
    imaFolder=''; $('ima-query').value=''; resetImaResults();
    if($('ima-library').value) return searchIma(0);
    $('ima-status').textContent='请选择知识库。';
  });
  $('ima-root').addEventListener('click',()=>{imaFolder=''; $('ima-query').value=''; return searchIma(0);});
  async function searchIma(start) {
    if(busy || keepDraft()) return;
    const query=$('ima-query').value.trim();
    let body={action:'search',query,start};
    if(knowledgeMode()) {
      if(!$('ima-library').value) { $('ima-status').textContent='请先选择知识库。'; return; }
      if(start===0) imaRequests=[{action:'knowledge',token:imaFolder||$('ima-library').value,query}];
      body=imaRequests[start]; if(!body) return;
    }
    const run=++imaRevision, isKnowledge=knowledgeMode(); imaLoading=true; imaControls(); $('ima-status').textContent='正在读取 IMA 资料列表…';
    imaPage=null; clearImaResults(); $('ima-empty').textContent='正在读取资料列表…';
    try {
      const page=await api('/api/ima',body); if(run!==imaRevision) return;
      imaPage=page;
      if(isKnowledge) { imaPage.start=start; imaPage.isEnd=!imaPage.nextToken; if(imaPage.nextToken) imaRequests[start+20]={action:'page',token:imaPage.nextToken}; }
      renderImaResults();
      $('ima-status').textContent=`${imaPage.scope||'笔记'} · 第 ${start/20+1} 页${imaPage.notice?' · '+imaPage.notice:''}`;
    } catch(error) { if(run===imaRevision) { $('ima-status').textContent=error.message; $('ima-empty').textContent='列表读取失败，可点击“搜索 / 浏览”重试。'; } }
    finally { if(run===imaRevision) { imaLoading=false; imaControls(); } }
  }
  $('ima-form').addEventListener('submit',event=>{event.preventDefault(); return searchIma(0);});
  $('ima-prev').addEventListener('click',()=>searchIma(Math.max(0,(imaPage?.start||0)-20)));
  $('ima-next').addEventListener('click',()=>searchIma((imaPage?.start||0)+20));
  $('ima-query').addEventListener('input',()=>{resetImaResults(); $('ima-status').textContent='按回车或点击“搜索 / 浏览”更新结果。';});
  $('ima-results').addEventListener('change',event=>{
    selectedToken=event.target.value; imaControls();
    if(current?.remoteSource?.platform==='ima') $('import-update-status').textContent='已选择列表条目；点击“检查 IMA 更新”会校验是否同源，并核对原件与该条目的来源信息。';
  });
  $('ima-import').addEventListener('click',async()=>{
    if(busy || keepDraft() || !selectedToken) return;
    if(imaPage?.items.find(item=>item.token===selectedToken)?.kind==='folder') { imaFolder=selectedToken; $('ima-query').value=''; return searchIma(0); }
    ++revision; setBusy(true); $('ima-status').textContent='正在读取所选资料并暂存…';
    $('ima-import-feedback').textContent='正在准备导入，请留意页面上方的处理进度。';
    const title=imaPage?.items.find(item=>item.token===selectedToken)?.title||'所选 IMA 资料';
    importing(title);
    try {
      const processing=await processingConsent(title);
      progress('working','正在从 IMA 导入资料',title+' · 正在读取正文并创建任务，较大的资料可能需要一些时间。');
      const job=await api('/api/ima',{action:'import',token:selectedToken,processing});
      show(job); resetImaResults(); setBusy(false); await refresh();
      $('ima-status').textContent='已导入。查看下方整理结果，选择你想保留的内容。';
      $('ima-import-feedback').textContent='资料已导入，请查看处理进度和整理结果。';
    } catch(error) { $('ima-status').textContent=error.message; $('ima-import-feedback').textContent=error.message; progress('error','导入未完成',error.message); }
    finally { setBusy(false); }
  });
  return {refresh, activate(nextSource) {
    source=nextSource;
    $('import-form').hidden=source!=='local' || !enabled;
    // Navigation reuses the live draft and form nodes, including unsaved selections and files.
    return refresh(true);
  }};
}
