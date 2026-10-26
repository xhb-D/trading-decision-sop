import test from 'node:test';
import assert from 'node:assert/strict';
import {initialWorkflow,reduceWorkflow,taskView} from '../src/engine.ts';
import {freshWorkspace,validateWorkspace} from '../src/persistence.ts';
import {displayText,stageName,symbolSummaries,executionLabel,eventName,reasonName} from '../src/presentation.ts';
import {freshAnalytics,recordAction,buildAnalyticsBundle,analyze} from '../src/analytics.ts';
const code=/\b(?:P[0-6]|R0[1-4]|U[0-2])\b/;
test('UI1 系统编号显示为中文，交易术语和自由文本数据不被改写',()=>{
 assert.equal(displayText('P3 → P4；R01；R02；R03；R04；U0；U1；U2'),'交易位置 → Setup 确认；价格到位；级别生长；对应级别极值假突破；更高级别极值假突破；维持当前判断；局部更新；重新读图');
 assert.equal(displayText('等待多头 PB / BOF，HTF+ 位置'),'等待多头 PB / BOF，HTF+ 位置');
 for(let i=0;i<=6;i++)for(const text of Object.values(taskView({...initialWorkflow('GC'),needsReconcile:false,stage:i})))assert(!code.test(displayText(text)));
});
test('UI2 同时呈现 GC/CL/ES 独立状态，改变选中项只改变突出显示',()=>{
 const w=freshWorkspace(1);w.workflows.GC.bias='正式多头';w.workflows.GC.stage=3;
 w.workflows.CL.bias='待定中性';w.workflows.CL.structure={direction:'平衡',phase:'震荡',timeframe:'30M',confirmed:true};
 w.workflows.ES.execution.position=true;w.workflows.ES.execution.order='pending';
 const before=structuredClone(w);
 const gc=symbolSummaries(w.workflows,'GC'),cl=symbolSummaries(w.workflows,'CL');
 assert.deepEqual(gc.map(s=>s.symbol),['GC','CL','ES']);assert.equal(gc[0].bias,'正式多头');assert.equal(gc[1].structure,'30M · 平衡 · 震荡');assert.equal(gc[2].execution,'持仓中 · 剩余挂单');
 assert.equal(gc[0].selected,true);assert.equal(cl[1].selected,true);
 assert.deepEqual(gc.map(({selected,...data})=>data),cl.map(({selected,...data})=>data));assert.deepEqual(w,before);
});
test('UI3 非当前品种的待撤单、待平仓、待核对和等待状态也明确可见',()=>{
 const w=freshWorkspace();w.workflows.GC.execution.order='cancelRequested';w.workflows.CL.execution.position=true;w.workflows.CL.execution.exitRequired=true;w.workflows.ES.needsReconcile=false;w.workflows.ES.waiting=true;
 const s=symbolSummaries(w.workflows,'GC');assert.equal(s[0].execution,'待核对撤单');assert.equal(s[1].execution,'待平仓');assert.equal(s[2].attention,'等待市场');assert(s[0].risk&&s[1].risk);
});
test('UI4 页面汉化不改变原始事件、SOP 规则版本或 Bundle 重算结果',()=>{
 const before=initialWorkflow('GC',1);before.needsReconcile=false;before.stage=3;const a={type:'NAVIGATE',stage:5};const r=reduceWorkflow(before,a,2);const log=freshAnalytics();recordAction(log,before,r.workflow,a,r.events,'test',2);
 const saved=JSON.stringify(log);for(const e of log.events){eventName(e.type);reasonName(e.reason);stageName(e.from);}assert.equal(JSON.stringify(log),saved);
 const b=buildAnalyticsBundle(log);assert(b.ruleSnapshot.rules.R02);assert(b.rawLog.events.some(e=>e.type==='ROUTE_BLOCKED'));const{events,...summary}=analyze(b.rawLog);assert.deepEqual(summary,b.summary);
 assert.deepEqual(validateWorkspace(freshWorkspace()).version,1);
});
test('UI5 旧快照中的提示与历史原因不再泄露界面编号',()=>{
 for(const reason of ['MARKET_R02','R02_DEPENDENCIES_VALID','MARKET_R03_RISK_FIRST','MARKET_R04_REASSESS_DIRECTION','U2_RECONCILE_REAL_EXPOSURE','请先在 P0 核对真实持仓和未成交委托'])assert(!code.test(reasonName(reason)));
 assert.equal(eventName('TASK_SUSPENDED'),'暂存原任务');assert.equal(executionLabel(initialWorkflow('GC')),'空仓');
});
test('UI6 用中文替换编号后不重复现有事件名称',()=>{assert.equal(displayText('快照过期 → 重新读图 U2'),'快照过期 → 重新读图');assert.equal(displayText('价格已到位 R01 → P4'),'价格已到位 → Setup 确认');});
