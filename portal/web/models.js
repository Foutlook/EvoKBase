export function initModels() {
  const $=id=>document.getElementById(id);
  let data,pending=false,controller;
  const selected=()=>data?.providers.find(p=>p.id===$('model-provider').value);
  function buttons() {
    $('model-provider').disabled=pending;
    $('model-save').disabled=pending || !selected()?.available;
    $('model-test').disabled=pending || !selected()?.available || selected()?.id!==data?.selected;
    $('model-refresh').disabled=pending;
    $('model-cancel').hidden=!controller;
  }
  function show() {
    const provider=selected();if(!provider)return;
    $('model-install-status').textContent=provider.available?`已安装 · ${provider.runtimeVersion}`:'未就绪';
    $('model-hint').textContent=provider.available?provider.hint:provider.message;
    $('model-executable').textContent=provider.executable||'';
    buttons();
  }
  async function request(route,body,signal) {
    const response=await fetch(route,{cache:'no-store',signal,...(body?{method:'POST',headers:{'Content-Type':'application/json','X-EvoKBase-Request':'1'},body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Harness 请求失败');return result;
  }
  async function refresh() {
    if(pending)return;
    pending=true;buttons();
    try {
      data=await request('/api/models');$('model-form').hidden=!data.enabled;
      if(!data.enabled){$('model-status').textContent='本地 Harness 设置未启用。';return;}
      $('model-provider').replaceChildren(...data.providers.map(p=>new Option(p.name+(p.available?'':' · 未就绪'),p.id)));
      $('model-provider').value=data.selected||data.providers.find(p=>p.available)?.id||data.providers[0].id;
      show();$('model-status').textContent=data.selected?'当前使用：'+data.providers.find(p=>p.id===data.selected).name:'选择一个已安装的工具，点击“使用此 Harness”。';
    } catch(error){$('model-status').textContent=error.message;}
    finally{pending=false;buttons();}
  }
  $('model-provider').addEventListener('change',()=>{show();$('model-status').textContent=selected()?.id===data.selected?'正在使用此 Harness。':'尚未切换；点击“使用此 Harness”保存选择。';});
  $('model-form').addEventListener('submit',async event=>{
    event.preventDefault();if(pending || !selected()?.available)return;
    pending=true;buttons();
    try{data=await request('/api/models',{action:'save',version:data.version,provider:selected().id});show();$('model-status').textContent='已选择 '+selected().name+'。可以测试运行，或导入资料。';}
    catch(error){$('model-status').textContent=error.message;}
    finally{pending=false;buttons();}
  });
  $('model-test').addEventListener('click',async()=>{
    if(pending || !selected()?.available || selected().id!==data.selected)return;
    pending=true;controller=new AbortController();buttons();$('model-status').textContent='正在调用本地 Harness，最多等待 3 分钟…';
    try{const result=await request('/api/models/test',{provider:selected().id,version:data.version},controller.signal);$('model-status').textContent=`运行成功，收到 OK（${(result.elapsedMs/1000).toFixed(1)} 秒）。`;}
    catch(error){$('model-status').textContent=controller.signal.aborted?'已取消测试；上游可能已产生用量。':error.message;}
    finally{pending=false;controller=null;buttons();}
  });
  $('model-refresh').addEventListener('click',refresh);
  $('model-cancel').addEventListener('click',()=>controller?.abort());
  window.addEventListener('pagehide',()=>controller?.abort());
  return {refresh};
}
