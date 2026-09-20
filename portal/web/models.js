export function initModels() {
  const $=id=>document.getElementById(id);
  let data, dirty=false, pending=false, controller, displayed;
  const fields=['model-provider','model-name','model-base-url','model-key'];
  const selected=()=>data?.providers.find(provider=>provider.id===$('model-provider').value);
  function buttons() {
    for(const id of fields) $(id).disabled=pending;
    $('model-save').disabled=pending;
    $('model-test').disabled=pending || dirty || !selected()?.hasKey;
    $('model-remove').disabled=pending || !selected()?.hasKey;
    $('model-cancel').hidden=!controller;
  }
  function show() {
    const provider=selected(); if(!provider) return;
    displayed=provider.id;
    $('model-name').value=provider.model;
    $('model-name').placeholder='例如 '+provider.example+'；以账号可用模型为准';
    $('model-base-url').value=provider.baseUrl;
    $('model-base-url').readOnly=provider.id!=='qwen';
    $('model-key').value='';
    $('model-key').placeholder=provider.hasKey?'已保存；留空保留原密钥':'输入此供应商的 API Key';
    $('model-key-status').textContent=provider.hasKey?'此供应商已保存密钥；未在本次页面中测试。':'此供应商尚未配置密钥。';
    $('model-docs').href=provider.docs;
    $('model-hint').textContent=provider.hint||'使用该供应商的标准对话 API，模型名请从官方控制台复制。';
    dirty=false; buttons();
  }
  async function request(route,body,signal) {
    const response=await fetch(route,{cache:'no-store',signal,...(body?{method:'POST',headers:{'Content-Type':'application/json','X-EvoKBase-Request':'1'},body:JSON.stringify(body)}:{})});
    const result=await response.json(); if(!response.ok) throw Error(result.error||'模型设置请求失败'); return result;
  }
  async function refresh() {
    if(pending || dirty) { $('model-status').textContent='请先保存修改或完成当前操作。'; return; }
    pending=true; buttons();
    try {
      data=await request('/api/models');
      $('model-form').hidden=!data.enabled;
      if(!data.enabled) { $('model-status').textContent='模型设置未启用。'; return; }
      $('model-provider').replaceChildren(...data.providers.map(provider=>new Option(provider.name,provider.id)));
      $('model-provider').value=data.selected||data.providers[0].id;
      show(); $('model-status').textContent='选择供应商后填写模型和密钥。保存不会发送请求。';
    } catch(error) { $('model-form').hidden=true; $('model-status').textContent=error.message; }
    finally { pending=false; buttons(); }
  }
  $('model-provider').addEventListener('change',()=>{
    if(dirty && !window.confirm('切换供应商会丢弃未保存的修改，继续？')) { $('model-provider').value=displayed; return; }
    show(); $('model-status').textContent='已切换供应商，请核对模型和密钥。';
  });
  for(const id of fields.slice(1)) $(id).addEventListener('input',()=>{ dirty=true; buttons(); $('model-status').textContent='有未保存的修改；保存后才能测试。'; });
  async function save(action) {
    if(pending) return;
    if(action==='remove' && !window.confirm('清除此供应商已保存的模型和 API Key？')) return;
    pending=true; buttons();
    try {
      const provider=$('model-provider').value;
      data=await request('/api/models',{action,version:data.version,provider,model:$('model-name').value,baseUrl:$('model-base-url').value,apiKey:$('model-key').value});
      $('model-provider').value=provider;
      show(); $('model-status').textContent=action==='remove'?'已清除此供应商配置。':'已保存到本机。点击测试连接后才会向所选供应商发送固定测试文字。';
    } catch(error) { $('model-status').textContent=error.message; }
    finally { $('model-key').value=''; pending=false; buttons(); }
  }
  $('model-form').addEventListener('submit',event=>{ event.preventDefault(); save('save'); });
  $('model-remove').addEventListener('click',()=>save('remove'));
  $('model-test').addEventListener('click',async()=>{
    if(pending || dirty || !selected()?.hasKey) return;
    pending=true; controller=new AbortController(); buttons();
    $('model-status').textContent='正在连接所选供应商，最多等待 30 秒…';
    try {
      const result=await request('/api/models/test',{provider:$('model-provider').value,version:data.version},controller.signal);
      $('model-status').textContent=`连接成功，收到模型响应（${(result.elapsedMs/1000).toFixed(1)} 秒）。`;
      $('model-key-status').textContent='本次连接测试通过；不代表模型效果或后续任务已验证。';
    } catch(error) { $('model-status').textContent=controller.signal.aborted?'已取消本次连接等待；供应商可能仍产生少量用量。':error.message; }
    finally { pending=false; controller=null; buttons(); }
  });
  $('model-cancel').addEventListener('click',()=>controller?.abort());
  window.addEventListener('beforeunload',event=>{ if(dirty) { event.preventDefault(); event.returnValue=''; } });
  window.addEventListener('pagehide',()=>{ controller?.abort(); $('model-key').value=''; });
  return {refresh};
}
