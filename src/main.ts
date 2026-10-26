import './style.css';
import { SYMBOLS, STAGES, BIASES, activeCandidate, hasExposure, directionAllowed, reduceWorkflow, taskView } from './engine.ts';
import type { Action, SymbolName, Direction } from './engine.ts';
import { appendEvent, recordAction, startClock, elapsed, analyze, toCSV, freshAnalytics, buildAnalyticsBundle } from './analytics.ts';
import type { Filter } from './analytics.ts';
import { loadWorkspace, saveWorkspace, prepareReopen, importWorkspace, STORAGE_KEY, QUARANTINE_KEY } from './persistence.ts';

const root = document.querySelector<HTMLDivElement>('#app')!;
const storage = {getItem:(key:string)=>window.localStorage.getItem(key),setItem:(key:string,value:string)=>window.localStorage.setItem(key,value)};
const loaded = loadWorkspace(storage);
let state = loaded.workspace;
let storageWarning = loaded.warning;
let reopened = Object.values(state.workflows).map(w=>({symbol:w.symbol,from:w.stage}));
let expired = prepareReopen(state);
const sessionId = `usage-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
let clock = startClock(Date.now(), current().waiting, document.visibilityState === 'visible');
let visit = `${Date.now()}`;
let modal = '';
let confirming: {message: string; action: () => void} | null = null;
let candidateDirection: Direction = '多头';
let candidateSetup: 'PB'|'BOF' = 'PB';
let candidateLabel = '';
let pointNote = '';
let analysisOpen = false;
let analysisFilter: Filter = {};
let historyOpen = false;
let sopOpen = false;
let readOnly = false;
const esc = (s: unknown) => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const duration = (ms: number) => ms < 60000 ? `${(ms/1000).toFixed(1)} 秒` : `${(ms/60000).toFixed(1)} 分`;
function current() { return state.workflows[state.activeSymbol]; }
function persist() {
  if(readOnly) return;
  try { saveWorkspace(storage,state); storageWarning = loaded.warning; }
  catch { storageWarning = '本地保存失败（空间不足或浏览器限制）。当前状态仍在内存中，请立即导出 JSON 备份。'; }
}
function flush(now=Date.now()) {
  const values=elapsed(clock,now);
  if(Object.values(values).some(n=>n>0)) appendEvent(state.analytics,current(),sessionId,now,{type:'DURATION_RECORDED',reason:visit,...values});
  clock.at=now;
}
function resetClock() { clock=startClock(Date.now(),current().waiting,document.visibilityState==='visible'); }
function startUsage() {
  for(const item of reopened) {
    const w=state.workflows[item.symbol];
    if(item.from!==w.stage) appendEvent(state.analytics,w,sessionId,Date.now(),{type:'STAGE_TRANSITION',from:item.from,to:w.stage,reason:'REOPEN_PLATFORM_RECONCILIATION'});
  }
  reopened=[];
  appendEvent(state.analytics,current(),sessionId,Date.now(),{type:'SESSION_STARTED',reason:'BROWSER_OPEN'});
  if(!state.analytics.events.some(e=>e.taskId===current().taskId&&e.type==='TASK_STARTED')) appendEvent(state.analytics,current(),sessionId,Date.now(),{type:'TASK_STARTED',reason:'RECOVERY_TASK'});
  appendEvent(state.analytics,current(),sessionId,Date.now(),{type:'STAGE_ENTERED',reason:'RESTORED_SNAPSHOT'});
}
function uiClick(reason: string) {
  flush(); appendEvent(state.analytics,current(),sessionId,Date.now(),{type:'USER_ACTION',reason,origin:'user'}); resetClock(); persist();
}
function dispatch(action: Action) {
  if(readOnly) return;
  const before=current(); const now=Date.now(); flush(now);
  const result=reduceWorkflow(before,action,now);
  state.workflows[state.activeSymbol]=result.workflow;
  recordAction(state.analytics,before,result.workflow,action,result.events,sessionId,now);
  if(before.stage!==result.workflow.stage || before.taskId!==result.workflow.taskId) visit=`${now}-${state.analytics.nextId}`;
  resetClock(); modal=''; confirming=null; persist(); render();
}
function confirm(message: string, action: () => void) { uiClick('UI_OPEN_CONFIRMATION'); confirming={message,action}; modal='confirm'; render(); }
function button(label: string, command: string, style='', value='', disabled=false) {
  return `<button type="button" class="${style}" data-command="${command}"${value?` data-value="${esc(value)}"`:''}${disabled?' disabled':''}>${label}</button>`;
}
function options(values: readonly string[], selected: string, command: string, field='') {
  return `<div class="segments">${values.map(v=>`<button type="button" class="chip ${selected===v?'selected':''}" data-command="${command}" data-value="${esc(v)}" ${field?`data-field="${field}"`:''} aria-pressed="${selected===v}">${esc(v)}</button>`).join('')}</div>`;
}
function stageControls() {
  const w=current(), c=activeCandidate(w), e=w.execution;
  if(w.needsReconcile) return `<div class="recovery-context">${hasExposure(w)?`<p class="risk-text">保存记录：${e.position?'有持仓':''} ${e.order!=='none'?'有未成交委托':''}。先到真实平台核对。</p>`:'<p>检查交易平台持仓与挂单；确认后恢复保存的流程。</p>'}</div><div class="actions">${button('已核对平台，记录一致','RECONCILE','primary')}${button('发现已有持仓','RECOVER_POSITION')}${button('发现已有挂单','RECOVER_ORDER')}</div>`;
  if(e.exitRequired) return `<p class="risk-text">逻辑失效已由你确认。请在平台执行平仓，并撤销剩余挂单。</p><div class="actions">${button('平台已确认平仓','exit-confirm','danger')}${e.order!=='none'?button('平台已确认撤单','cancel-confirm'):''}</div>`;
  if(e.order==='cancelRequested') return `<p class="risk-text">撤单尚未确认。看板不会代替平台执行；若期间成交，请按实际结果记录。</p><div class="actions">${button('平台已确认撤单','cancel-confirm','primary')}${button('已全部成交','FILL')}${button('已部分成交','PARTIAL_FILL')}${e.position?button('原逻辑失效点已触及','point-touched','danger'):''}</div>`;
  if(e.riskReview) return `<div class="actions">${button('已核对风险，沿用原失效点','RISK_REVIEWED','primary')}${e.order!=='none'?button('原理由失效，处理委托','reason-invalid','danger'):''}${e.position?button('原逻辑失效点已触及','point-touched','danger'):''}</div>`;
  switch(w.stage) {
    case 1:return `<div class="field"><span>当前有效 Bias · 人工提供</span>${options(BIASES,w.bias,'bias')}</div><div class="actions">${button('Bias 已确认 → 价格结构','BIAS_DONE','primary')}${button(w.waiting?'恢复判断':'继续等待','wait')}</div>`;
    case 2:return `<div class="structure-fields"><div class="field"><span>母结构方向</span>${options(['多头','空头','平衡'],w.structure.direction,'structure','direction')}</div><div class="field"><span>运行阶段</span>${options(['延续','回调','转折观察','震荡'],w.structure.phase,'structure','phase')}</div><div class="field"><span>观察级别</span>${options(['3M','5M','15M','30M','1H','4H','日线'],w.structure.timeframe,'structure','timeframe')}</div></div><div class="actions">${button(w.suspension?'更新完成，检查并恢复原任务':'结构已确认 → 交易位置','STRUCTURE_DONE','primary')}${button(w.waiting?'恢复判断':'继续等待','wait')}</div>`;
    case 3:return `${c?.valid?`<div class="current-candidate"><b>${esc(c.label)}</b><span>${c.direction} · ${c.setup}</span></div>${!directionAllowed(w)?`<p class="risk-text">${w.bias.includes('中性')?'中性状态需要你确认此候选的具体方向权限。':'候选方向尚未取得当前 Bias 准入。'}</p>${w.bias.includes('中性')?button(`确认当前候选${c.direction}权限`,'GRANT_DIRECTION','permission'):''}`:''}`:'<p class="muted">加入候选即表示你已人工确认该位置合格。不需要填写价格和长篇理由。</p>'}<div class="actions">${c?.valid?button('价格已到位 R01 → Setup','R01','primary'):button('新增候选位置','open-candidate','primary')}${c?.valid?button('新增候选位置','open-candidate'):''}${button(w.waiting?'恢复判断':'继续等待','wait')}${c?.valid?button('位置已失效','invalidate-location','subtle danger-text'):''}</div>`;
    case 4:return `<div class="setup-line"><span>${esc(c?.label)}</span><b>${c?.direction} ${c?.setup}</b><span>位置已到位 · 人工观察中</span></div><div class="actions">${button('Setup 已确认 → 入场检查','CONFIRM_SETUP','primary')}${button(w.waiting?'恢复判断':'继续等待','wait')}${button('Setup 已失效','invalidate-setup')}${button('位置已失效','invalidate-location','subtle danger-text')}</div>`;
    case 5:
      if(e.order!=='none') return `<div class="actions">${button('已全部成交','FILL','primary')}${button('已部分成交','PARTIAL_FILL')}${button('原交易理由失效','reason-invalid','danger')}${button('申请撤销委托','REQUEST_CANCEL')}${button('平台已确认撤单','cancel-confirm')}</div>`;
      return `<div class="entry-checks">${button(`${e.riskConfirmed?'✓':'○'} 已检查总体风险及订单冲突`,'CONFIRM_RISK',e.riskConfirmed?'checked':'')}${button(`${e.invalidationConfirmed?'✓':'○'} 入场前已确定逻辑失效点`,'CONFIRM_POINT',e.invalidationConfirmed?'checked':'')}<details><summary>可选：记录原逻辑失效点</summary><input id="point-note" value="${esc(pointNote)}" maxlength="120" placeholder="价格或简短描述；可留空" aria-label="原逻辑失效点备注"><small>仅在首次确认时保存，进入委托后不能放宽。</small></details></div><div class="actions">${button('已提交委托，等待成交','PLACE_PENDING','primary')}${button('平台已确认成交','FILL')}${button('平台已部分成交','PARTIAL_FILL')}${button('入场条件失效','reason-invalid','subtle danger-text')}</div><p class="micro">这是人工状态记录。是否已成交，以真实交易平台为准。</p>`;
    case 6:return `<div class="holding-strip"><span>原逻辑失效点</span><b>${e.originalPoint?esc(e.originalPoint):e.invalidationConfirmed?'入场前已确认':'请沿用平台原计划'}</b><small>不可事后放宽 · 无实时监测</small></div><div class="actions">${button('原逻辑失效点已触及','point-touched','danger')}${button('按既定计划离场','REQUEST_EXIT')}${button('平台已确认平仓','exit-confirm')}${e.order!=='none'?button('撤销未成交部分','REQUEST_CANCEL'):''}${button(w.waiting?'恢复管理':'继续持有 / 等待','wait')}</div>`;
    default:return '';
  }
}
function analysisHTML() {
  if(!analysisOpen) return '';
  const a=analyze(state.analytics,analysisFilter); const max=Math.max(1,...a.stages.map(s=>s.activeMs));
  return `<div class="analysis-body"><div class="filters"><label>从 <input type="date" id="date-from" value="${analysisFilter.dateFrom??''}"></label><label>至 <input type="date" id="date-to" value="${analysisFilter.dateTo??''}"></label><label>品种 <select id="filter-symbol"><option value="">全部品种</option>${SYMBOLS.map(s=>`<option${analysisFilter.symbol===s?' selected':''}>${s}</option>`).join('')}</select></label>${button('一键导出 SOP Analytics Bundle','export-bundle','primary')}${button('导出统计 JSON','export-analytics')}${button('导出原始 CSV','export-csv')}${button('清空使用日志','clear-analytics','subtle danger-text')}</div><div class="metrics"><div><strong>${a.taskCount}</strong><span>决策任务 · 完成 ${a.completedTasks.length}</span></div><div><strong>${a.averageClicks.toFixed(1)}</strong><span>完成任务平均点击</span></div><div><strong>${duration(a.averageActiveMs)}</strong><span>平均活跃操作估计</span></div><div><strong>${duration(a.medianActiveMs)}</strong><span>中位活跃操作估计</span></div><div><strong>${a.exceptions}</strong><span>可观察流程异常</span></div></div><div class="analysis-table"><table><thead><tr><th>环节</th><th>进入 / 退出 / 重访</th><th>平均 / 中位活跃</th><th>活跃分布</th><th>市场等待</th></tr></thead><tbody>${a.stages.map(s=>`<tr><td>P${s.stage} ${STAGES[s.stage]}</td><td>${s.entries} / ${s.exits} / ${s.revisits}</td><td>${duration(s.averageMs)} / ${duration(s.medianMs)}</td><td><span class="bar" style="width:${Math.max(2,s.activeMs/max*90)}px"></span> ${duration(s.activeMs)}</td><td>${duration(s.waitMs)}</td></tr>`).join('')}</tbody></table></div><div class="stat-notes"><p>主动返回上游 ${a.userReturns} · 市场事件上游更新 ${a.marketUpdates} · 重复返回待人工复核 ${a.suspiciousReturns} · 路由阻断 ${a.blocked}（前置条件/权限 ${a.missingPrerequisites}）</p><p>U0 ${a.updates.U0} / U1 ${a.updates.U1} / U2 ${a.updates.U2} · 日志 ${a.retained} 条 · 已裁剪 ${a.dropped} 条 · 未完成或窗口不完整任务 ${a.incompleteTasks}</p><p>活跃时间仅为可观察估计：W 等待、后台与超过 30 秒无交互均排除。任务均值只计算保留窗口内有开始与完成/注销事件的任务。重复访问提示不代表违反纪律。筛选按事件本地日期；跨日任务可能不完整。</p></div></div>`;
}
function dialogHTML() {
  if(!modal) return '';
  let title='',body='';
  if(modal==='candidate') { title='新增合格 HTF 候选'; body=`<p>仅记录你已经确认合格的位置，不自动识别或排名。</p><div class="field"><span>拟交易方向 · 每次机会独立确定</span>${options(['多头','空头'],candidateDirection,'candidate-direction')}</div><div class="field"><span>观察 Setup</span>${options(['PB','BOF'],candidateSetup,'candidate-setup')}</div><label class="field"><span>位置标签（可选）</span><input id="candidate-label" maxlength="40" value="${esc(candidateLabel)}" placeholder="如：30M 回调区域"></label><div class="actions">${button('确认合格并加入','add-candidate','primary')}${button('返回','close-modal')}</div>`; }
  if(modal==='events') { title='发生了什么变化？'; body=`<p>只更新受影响的判断。持仓或挂单风险始终优先。</p><div class="event-grid">${[
    ['Bias 更新','event-bias','P1 · 人工修改有效 Bias'],['结构变化','STRUCTURE_CHANGE','U1 · 更新结构与下游'],['级别生长 R02','R02','P2 局部更新后恢复'],['价格到位 R01','R01','当前候选 → P4'],['极值假突破 R03','R03','空仓更新观察 / 持仓评估风险'],['HTF+ 假突破 R04','event-r04','回 P3 核对方向权限'],['位置失效','invalidate-location','仅失效当前候选'],['Setup 失效','invalidate-setup','重新观察 Setup'],['实际入场成交','FILL','按交易平台结果记录'],['持仓离场事件','REQUEST_EXIT','执行后核对平台'],['没有实质变化 U0','U0','维持当前任务'],['重新读图 U2','reread','保留真实持仓与委托']
  ].map(([label,cmd,note])=>`<button data-command="${cmd}"><b>${label}</b><small>${note}</small></button>`).join('')}</div>`; }
  if(modal==='bias') { title='更新当前有效 Bias'; body=`<p>人工确认后只清理受影响的下游计划；不会根据 Setup 推断 Bias。</p>${options(BIASES,current().bias,'bias')}<div class="actions">${button('返回','close-modal')}</div>`; }
  if(modal==='confirm') { title='请确认这次更新'; body=`<p>${esc(confirming?.message)}</p><div class="actions">${button('确认','confirm-yes','primary')}${button('返回','close-modal')}</div>`; }
  if(modal==='data') { title='本地数据与备份'; body=`<p>工作状态与使用日志仅保存在此浏览器。与原日内看板使用不同存储键。</p><div class="data-options">${button('导出完整 JSON 备份','export-workspace','primary')}<label class="file-button">导入 JSON 备份<input type="file" id="import-file" accept="application/json,.json"></label>${button('导出损坏原文（若存在）','export-damaged')}</div><p class="micro">导入会先验证并保留导入前备份。有真实敞口记录时禁止覆盖。浏览器清理站点数据将删除本地内容，请定期导出。</p>`; }
  return `<div class="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="dialog-title" class="dialog"><header><h2 id="dialog-title">${title}</h2>${button('×','close-modal','icon')}</header>${body}</section></div>`;
}
function render() {
  const w=current(),c=activeCandidate(w),v=taskView(w),e=w.execution;
  document.documentElement.dataset.theme=state.theme;
  root.innerHTML=`<main class="shell"><header class="page-header"><div><div class="eyebrow">TRADING DECISION / SOP V1</div><h1>交易决策导航</h1><p>当前只做一件事</p></div><div class="header-tools">${button(state.theme==='dark'?'☀ 浅色':'☾ 深色','theme')}${button('备份 / 导入','open-data')}<span class="save-state">${storageWarning?'保存需关注':'● 本地已保存'}</span></div></header>
  ${readOnly?'<div class="banner danger-text">另一标签页已更新工作区，本页暂停写入。请刷新后恢复，避免相互覆盖。</div>':''}
  ${storageWarning?`<div class="banner" role="alert">${esc(storageWarning)}</div>`:''}
  ${expired.includes(w.symbol)?`<div class="banner">${w.symbol} 快照可能过期（跨日或离开超过 8 小时）。${button('新 Session，重新读图','reread')}${button('已核对，快照仍有效','keep-snapshot')}</div>`:''}
  <section class="context-bar" aria-label="已确认背景"><div class="symbols">${SYMBOLS.map(s=>button(s,'symbol',s===state.activeSymbol?'selected':'',s)).join('')}</div><div class="context"><small>有效 Bias</small><strong>${w.bias}</strong></div><div class="context"><small>价格结构</small><strong>${w.structure.confirmed?`${esc(w.structure.timeframe)} · ${esc(w.structure.direction)} · ${esc(w.structure.phase)}`:'待人工确认'}</strong></div><div class="context"><small>执行状态</small><strong class="${hasExposure(w)?'risk-text':''}">${e.position?'持仓中':e.order!=='none'?'有挂单':'空仓'}${e.position&&e.order!=='none'?' + 剩余挂单':''}</strong></div></section>
  <nav class="progress" aria-label="决策环节">${STAGES.map((s,i)=>`<button data-command="navigate" data-value="${i}" class="${w.stage===i?'current':''}" ${w.stage===i?'aria-current="step"':''}><span>P${i}</span><b>${s}</b></button>`).join('')}</nav>
  <div class="workspace"><section class="task-card ${v.tone}" aria-label="当前任务"><div class="task-heading"><span class="stage-label">P${w.stage} / ${STAGES[w.stage]}</span><span class="status-tag">${w.waiting?'W · 等待市场':v.tone==='danger'?'优先处理风险':v.tone==='warning'?'需要人工核对':'可继续判断'}</span></div>${w.suspension?`<div class="suspended">↩ 已暂存 P${w.suspension.stage} ${STAGES[w.suspension.stage]} · 完成局部更新后检查恢复</div>`:''}<div class="task-focus"><div class="eyebrow">现在只需要</div><h2>${esc(v.title)}</h2>${c?.valid?`<p>${esc(c.label)} <span> / ${c.direction} / ${c.setup}</span></p>`:''}</div><div class="routes"><div><span>下一触发</span><b>${esc(v.next)}</b></div><div><span>失效去向</span><b>${esc(v.fallback)}</b></div></div><div class="controls">${stageControls()}</div>${w.notice?`<div class="notice" role="status">${esc(w.notice)}</div>`:''}</section>
  <aside class="sidebar"><section class="candidate-panel"><header><h2>候选位置 <span>${w.candidates.filter(c=>c.valid).length}</span></h2>${button('＋','open-candidate','icon')}</header>${w.candidates.some(c=>c.valid)?w.candidates.filter(c=>c.valid).map(item=>item.id===w.activeId?`<div class="candidate active"><span class="mini-label">当前观察</span><b>${esc(item.label)}</b><p>${item.direction} · ${item.setup}<span>${item.confirmed?'Setup 已确认':item.arrived?'位置已到位':'等待到位'}</span></p></div>`:`<details class="candidate"><summary>${esc(item.label)} <span>${item.direction} ${item.setup}</span></summary><p>${item.confirmed?'Setup 已确认':item.arrived?'位置已到位':'等待到位'}</p><div class="actions">${button('切换观察','select-candidate','',item.id)}${button('此位置失效','invalidate-other','subtle danger-text',item.id)}</div></details>`).join(''):'<div class="empty-state">尚无候选位置<br><small>确认合格位置后再加入</small></div>'}</section><button class="event-entry" data-command="open-events"><span>＋</span><div><b>发生新事件</b><small>快速路由 / 局部更新</small></div><span>↗</span></button><div class="local-note">人工判断 · 本地保存<br>无行情识别 · 无自动执行</div></aside></div>
  <section class="foldout"><button class="foldout-title" aria-expanded="${analysisOpen}" data-command="toggle-analysis"><span>${analysisOpen?'−':'＋'} SOP 使用分析</span><small>零额外操作 · 本地统计</small></button>${analysisHTML()}</section>
  <section class="foldout"><button class="foldout-title" aria-expanded="${historyOpen}" data-command="toggle-history"><span>${historyOpen?'−':'＋'} 事件历史</span><small>最近 40 条路由事件</small></button>${historyOpen?`<div class="history">${state.analytics.events.filter(x=>x.symbol===w.symbol&&!['USER_ACTION','DURATION_RECORDED'].includes(x.type)).slice(-40).reverse().map(x=>`<p><time>${new Date(x.at).toLocaleTimeString('zh-CN',{hour12:false})}</time><span>P${x.from} → P${x.to}</span><b>${esc(x.type)}</b><small>${esc(x.reason)}</small></p>`).join('')||'暂无事件'}</div>`:''}</section>
  <section class="foldout"><button class="foldout-title" aria-expanded="${sopOpen}" data-command="toggle-sop"><span>${sopOpen?'−':'＋'} 完整 SOP 速查</span><small>P0–P6 / D01–D03 / R01–R04</small></button>${sopOpen?`<div class="sop"><p>${STAGES.map((s,i)=>`P${i} ${s}`).join(' → ')}</p><p>每个机会独立确定方向；不得违背有效 Bias。中性须人工确认权限。Setup、R02、R04 不自动改变 Bias。</p><p>R01 合格位置到位 → P4；R02 P2 局部更新 → 检查恢复；R03 空仓更新观察、有敞口优先风险；R04 重新评估位置与方向权限，不能直接入场。</p><p>U0 维持；U1 更新受影响下游；U2 重新读图但保留真实持仓与委托。未成交理由失效 → 平台撤单并核对；部分成交拆分管理；原逻辑失效点触及 → 按既定规则平仓并核对。</p></div>`:''}</section><footer>Trading Decision SOP · 独立工作区 · V1.0 <span>决定来自你，下一步交给流程。</span></footer></main>${dialogHTML()}`;
  if(modal) { const d=root.querySelector<HTMLElement>('[role=dialog]'); const first=d?.querySelector<HTMLElement>('button,input'); first?.focus(); }
}
function download(filename: string, content: string, type='application/json') {
  const url=URL.createObjectURL(new Blob([content],{type})); const a=document.createElement('a'); a.href=url; a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
root.addEventListener('input',event=>{
  const el=event.target as HTMLInputElement;
  if(el.id==='candidate-label') candidateLabel=el.value;
  if(el.id==='point-note') pointNote=el.value;
});
root.addEventListener('change',async event=>{
  const el=event.target as HTMLInputElement;
  if(el.id==='date-from'||el.id==='date-to'||el.id==='filter-symbol') {
    analysisFilter={dateFrom:(root.querySelector('#date-from') as HTMLInputElement)?.value,dateTo:(root.querySelector('#date-to') as HTMLInputElement)?.value,symbol:(root.querySelector('#filter-symbol') as HTMLSelectElement)?.value}; render();
  }
  if(el.id==='import-file'&&el.files?.[0]) {
    try {
      const next=importWorkspace(state,await el.files[0].text());
      confirm('验证通过。将保留当前副本并替换本地工作区；此操作不改变真实平台持仓或委托。',()=>{flush();persist();state=next;expired=prepareReopen(state);resetClock();modal='';confirming=null;startUsage();persist();render();});
    } catch(error) { storageWarning=`导入未执行：${(error as Error).message}`; render(); }
  }
});
root.addEventListener('click',event=>{
  const target=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-command]'); if(!target||target.disabled) return;
  const cmd=target.dataset.command!,value=target.dataset.value??'';
  if(readOnly) return;
  switch(cmd) {
    case 'symbol': flush(); persist(); state.activeSymbol=value as SymbolName; resetClock(); visit=`${Date.now()}`; appendEvent(state.analytics,current(),sessionId,Date.now(),{type:'STAGE_ENTERED',reason:'SYMBOL_SELECTED'}); persist(); render(); break;
    case 'theme': state.theme=state.theme==='dark'?'light':'dark';persist();render();break;
    case 'open-events':uiClick('UI_OPEN_EVENTS');modal='events';render();break;
    case 'open-candidate':uiClick('UI_OPEN_CANDIDATE');modal='candidate';candidateLabel='';render();break;
    case 'open-data':modal='data';render();break;
    case 'close-modal':if(['candidate','events','bias','confirm'].includes(modal))uiClick('UI_CLOSE_DIALOG');modal='';confirming=null;render();break;
    case 'candidate-direction':uiClick('UI_CANDIDATE_DIRECTION');candidateDirection=value as Direction;render();break;
    case 'candidate-setup':uiClick('UI_CANDIDATE_SETUP');candidateSetup=value as 'PB'|'BOF';render();break;
    case 'add-candidate':dispatch({type:'ADD_CANDIDATE',value:candidateLabel,direction:candidateDirection,setup:candidateSetup});break;
    case 'select-candidate':dispatch({type:'SELECT_CANDIDATE',id:value});break;
    case 'bias': {
      const action=()=>dispatch({type:'SET_BIAS',value});
      if(current().bias!==value&&current().candidates.some(c=>c.valid)) confirm('变更 Bias 会注销受影响的 Setup 和入场权限；有真实敞口时先进入风险处理。',action); else action();break;
    }
    case 'structure':dispatch({type:'SET_STRUCTURE',field:target.dataset.field as Action['field'],value});break;
    case 'navigate':dispatch({type:'NAVIGATE',stage:Number(value)});break;
    case 'wait':dispatch({type:current().waiting?'WAKE':'WAIT'});break;
    case 'event-bias':uiClick('UI_BIAS_UPDATE');modal='bias';render();break;
    case 'event-r04':confirm('确认 HTF+ 极值假突破并迅速收回？将重评当前位置与方向，清理当前旧 Setup；Bias 不变。',()=>dispatch({type:'R04'}));break;
    case 'invalidate-location':confirm('仅注销当前位置及其依赖计划，其他有效候选保留。若有挂单，仍须平台撤单并核对。',()=>dispatch({type:'INVALIDATE_LOCATION'}));break;
    case 'invalidate-other':confirm('注销这个候选及其依赖 Setup？其他候选保留。',()=>dispatch({type:'INVALIDATE_LOCATION',id:value}));break;
    case 'invalidate-setup':confirm('确认当前 Setup 已失效？将清理它的入场确认，位置仍保留。',()=>dispatch({type:'INVALIDATE_SETUP'}));break;
    case 'reason-invalid':confirm('确认原交易理由失效？未成交部分进入撤单核对；已成交部分优先风险管理。',()=>dispatch({type:'REASON_INVALID'}));break;
    case 'point-touched':confirm('你已人工确认触及入场时的逻辑失效点？请按既定规则到平台执行平仓。',()=>dispatch({type:'POINT_TOUCHED'}));break;
    case 'cancel-confirm':confirm('你已在真实交易平台看到剩余委托撤销成功？这只记录平台结果。',()=>dispatch({type:'CANCEL_CONFIRMED'}));break;
    case 'exit-confirm':confirm('你已在真实交易平台确认该持仓已全部平仓？剩余挂单仍须另行撤销核对。',()=>dispatch({type:'EXIT_CONFIRMED'}));break;
    case 'reread':confirm('开始新 Session / U2 重新读图？分析快照与候选失效，真实持仓及挂单保留并要求核对。',()=>{expired=expired.filter(s=>s!==state.activeSymbol);dispatch({type:'U2'});});break;
    case 'keep-snapshot':uiClick('UI_SNAPSHOT_REVIEWED');expired=expired.filter(s=>s!==state.activeSymbol);current().lastSeen=Date.now();persist();render();break;
    case 'confirm-yes': {const action=confirming?.action;confirming=null;action?.();break;}
    case 'CONFIRM_POINT':dispatch({type:'CONFIRM_POINT',value:pointNote});break;
    case 'toggle-analysis':flush();analysisOpen=!analysisOpen;render();break;
    case 'toggle-history':historyOpen=!historyOpen;render();break;
    case 'toggle-sop':sopOpen=!sopOpen;render();break;
    case 'export-workspace':flush();persist();download('trading-decision-sop-backup.json',JSON.stringify(state,null,2));break;
    case 'export-bundle':flush();persist();download('sop-analytics-bundle-v1.json',JSON.stringify(buildAnalyticsBundle(state.analytics,analysisFilter),null,2));break;
    case 'export-analytics':flush();download('sop-usage-analysis.json',JSON.stringify({version:1,definition:'Active estimate excludes waiting, hidden time and idle over 30 seconds; incomplete retained tasks excluded from averages.',...analyze(state.analytics,analysisFilter)},null,2));break;
    case 'export-csv':flush();download('sop-usage-events.csv',toCSV(state.analytics,analysisFilter),'text/csv;charset=utf-8');break;
    case 'export-damaged': {const raw=storage.getItem(QUARANTINE_KEY);if(raw)download('sop-damaged-original.txt',raw,'text/plain');else{storageWarning='没有隔离的损坏原文。';render();}break;}
    case 'clear-analytics':confirm('清空本地使用日志？交易状态不变。建议先导出 JSON/CSV；此操作会保留清空前本地备用副本。',()=>{flush();persist();state.analytics=freshAnalytics();startUsage();resetClock();modal='';persist();render();});break;
    default:dispatch({type:cmd as Action['type']});
  }
});
function activity() {
  const now=Date.now();
  if(now>clock.activeUntil&&!clock.waiting) { flush(now);clock.activeUntil=now+30000; }
  else clock.activeUntil=now+30000;
}
document.addEventListener('pointerdown',activity,{passive:true});
document.addEventListener('keydown',event=>{
  activity(); if(event.key==='Escape'&&modal) {if(['candidate','events','bias','confirm'].includes(modal))uiClick('UI_CLOSE_DIALOG');modal='';confirming=null;render();}
  if(event.key==='Tab'&&modal) {
    const nodes=[...root.querySelectorAll<HTMLElement>('[role=dialog] button,[role=dialog] input')].filter(x=>!(x as HTMLButtonElement).disabled);
    const first=nodes[0],last=nodes.at(-1); if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
});
document.addEventListener('visibilitychange',()=>{flush();clock.visible=document.visibilityState==='visible';clock.activeUntil=Date.now()+30000;persist();});
window.addEventListener('pagehide',()=>{flush();persist();});
window.addEventListener('storage',event=>{if(event.key===STORAGE_KEY){readOnly=true;render();}});
setInterval(()=>{if(!readOnly){flush();persist();}},15000);
window.addEventListener('error',()=>{appendEvent(state.analytics,current(),sessionId,Date.now(),{type:'WORKFLOW_EXCEPTION',reason:'OBSERVABLE_RUNTIME_ERROR'});persist();});
startUsage();persist();render();
