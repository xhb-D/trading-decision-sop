import { initialWorkflow, SYMBOLS, BIASES, hasExposure, entryBlock } from './engine.ts';
import type { Workflow, SymbolName } from './engine.ts';
import { freshAnalytics, MAX_EVENTS } from './analytics.ts';
import type { Analytics } from './analytics.ts';
export const STORAGE_KEY = 'trading-decision-sop:v1:workspace';
export const BACKUP_KEY = 'trading-decision-sop:v1:backup';
export const QUARANTINE_KEY = 'trading-decision-sop:v1:damaged';
export interface Workspace { version: 1; activeSymbol: SymbolName; theme: 'dark' | 'light'; workflows: Record<SymbolName, Workflow>; analytics: Analytics; savedAt: number; }
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; }
export function freshWorkspace(now = Date.now()): Workspace {
  return { version: 1, activeSymbol: 'GC', theme: 'dark', workflows: Object.fromEntries(SYMBOLS.map(s=>[s,initialWorkflow(s,now)])) as Record<SymbolName,Workflow>, analytics: freshAnalytics(), savedAt: now };
}
function fail(message: string): never { throw new Error(message); }
const obj = (x: unknown): x is Record<string, any> => !!x && typeof x==='object' && !Array.isArray(x);
const boolean = (x: unknown) => typeof x === 'boolean';
const stage = (x: unknown) => Number.isInteger(x) && Number(x)>=0 && Number(x)<=6;
const bounded = (s: unknown, limit=160) => typeof s==='string' && s.length<=limit;
export function validateWorkspace(value: unknown): Workspace {
  if (!obj(value) || value.version !== 1) fail('不支持的数据版本，未执行覆盖');
  if (!SYMBOLS.includes(value.activeSymbol) || !['dark','light'].includes(value.theme) || !obj(value.workflows)) fail('工作区格式错误');
  for (const symbol of SYMBOLS) {
    const w = value.workflows[symbol];
    if (!obj(w)||w.symbol!==symbol||!stage(w.stage)||!BIASES.includes(w.bias)||!bounded(w.taskId)||!Array.isArray(w.candidates)||w.candidates.length>1000) fail('流程数据损坏');
    if (!obj(w.structure)||!boolean(w.structure.confirmed)||!bounded(w.structure.direction)||!bounded(w.structure.phase)||!bounded(w.structure.timeframe)) fail('结构数据损坏');
    if (!Number.isSafeInteger(w.revision)||w.revision<0||!boolean(w.waiting)||!boolean(w.needsReconcile)||!Number.isFinite(w.lastSeen)||!Number.isFinite(w.snapshotAt)||!bounded(w.notice,1000)||!Array.isArray(w.completedStages)||!w.completedStages.every(stage)||!(w.returnStage===null||stage(w.returnStage))) fail('流程标记损坏');
    const ids = new Set();
    for (const c of w.candidates) {
      if (!obj(c)||!bounded(c.id)||!bounded(c.taskId)||!bounded(c.label,40)||!['多头','空头'].includes(c.direction)||!['PB','BOF'].includes(c.setup)||!['valid','arrived','confirmed','permission'].every(k=>boolean(c[k]))||!Number.isSafeInteger(c.revision)||c.revision<0||ids.has(c.id)) fail('候选数据损坏或重复');
      if (c.confirmed && (!c.arrived||!c.valid)) fail('Setup 与候选依赖不一致');
      if(c.completedStages!==undefined&&(!Array.isArray(c.completedStages)||!c.completedStages.every(stage))) fail('候选阶段记录损坏');
      ids.add(c.id);
    }
    if (w.activeId!==null&&!ids.has(w.activeId)) fail('当前候选引用损坏');
    const e = w.execution;
    if (!obj(e)||!['none','pending','cancelRequested'].includes(e.order)||!['position','invalidationConfirmed','riskConfirmed','exitRequired','riskReview'].every(k=>boolean(e[k]))||!bounded(e.originalPoint,120)||(e.candidateId!==null&&!ids.has(e.candidateId))) fail('委托或持仓数据损坏');
    if (e.exitRequired&&!e.position) fail('平仓状态与持仓不一致');
    if (w.suspension!==null) {
      const s = w.suspension;
      if (!obj(s)||!stage(s.stage)||!bounded(s.taskId)||!boolean(s.waiting)||!Number.isSafeInteger(s.revision)||!Number.isSafeInteger(s.candidateRevision)||(s.activeId!==null&&!ids.has(s.activeId))) fail('中断任务数据损坏');
    }
  }
  for(const w of Object.values(value.workflows) as Workflow[]) {
    if(w.stage===6&&!w.execution.position) fail('P6 缺少真实持仓记录');
    if(w.stage===5&&!hasExposure(w)&&entryBlock(w)) fail('P5 前置条件不一致');
    if(w.stage===4&&(!w.structure.confirmed||!w.candidates.some(c=>c.id===w.activeId&&c.valid&&c.arrived))) fail('P4 候选依赖不一致');
  }
  const a=value.analytics;
  if (!obj(a)||a.version!==1||!Array.isArray(a.events)||a.events.length>MAX_EVENTS||!Number.isSafeInteger(a.nextId)||!Number.isSafeInteger(a.dropped)||a.dropped<0) fail('统计日志格式错误');
  let lastId = 0;
  const eventTypes = new Set(['SESSION_STARTED','STAGE_ENTERED','USER_ACTION','EVENT_CONFIRMED','STAGE_TRANSITION','STAGE_REVISITED','TASK_SUSPENDED','TASK_RESUMED','TASK_INVALIDATED','ROUTE_BLOCKED','WORKFLOW_EXCEPTION','STAGE_COMPLETED','TASK_STARTED','TASK_COMPLETED','UPDATE_TRIGGERED','UPSTREAM_RETURN','DURATION_RECORDED','STATE_CHANGED']);
  for (const e of a.events) {
    if (!obj(e)||e.version!==1||!Number.isSafeInteger(e.id)||e.id<=lastId||!Number.isFinite(e.at)||!/^\d{4}-\d{2}-\d{2}$/.test(e.date)||!bounded(e.sessionId)||!SYMBOLS.includes(e.symbol)||!bounded(e.taskId)||!stage(e.from)||!stage(e.to)||!eventTypes.has(e.type)||!bounded(e.reason,1000)||!['user','system'].includes(e.origin)||!Number.isSafeInteger(e.revision)) fail('统计事件损坏');
    if (![e.activeMs,e.waitMs,e.idleMs].every(n=>n===undefined||(Number.isFinite(n)&&n>=0))) fail('统计耗时损坏');
    if(e.sopVersion!==undefined&&!bounded(e.sopVersion,40)) fail('SOP 版本格式错误');
    if(e.routingVersion!==undefined&&!bounded(e.routingVersion,40)) fail('路由版本格式错误');
    if(e.type==='STATE_CHANGED'&&(!obj(e.stateChange)||!obj(e.stateChange.before)||!obj(e.stateChange.after)||!Array.isArray(e.stateChange.paths)||!e.stateChange.paths.every((p:unknown)=>bounded(p,80)))) fail('状态变化证据损坏');
    lastId=e.id;
  }
  if (a.nextId<=lastId||!Number.isFinite(value.savedAt)) fail('版本序列或保存时间错误');
  return structuredClone(value) as Workspace;
}
export function saveWorkspace(storage: StorageLike, workspace: Workspace, now=Date.now()): void {
  workspace.savedAt=now;
  // Keep primary + rolling backup comfortably below common localStorage quotas.
  while(JSON.stringify(workspace).length>900000 && workspace.analytics.events.length>100) {
    const count=Math.min(250,workspace.analytics.events.length-100);
    workspace.analytics.events.splice(0,count); workspace.analytics.dropped+=count;
  }
  const previous=storage.getItem(STORAGE_KEY);
  if (previous) { try { validateWorkspace(JSON.parse(previous)); storage.setItem(BACKUP_KEY,previous); } catch { /* Do not overwrite a good backup with a corrupt primary. */ } }
  storage.setItem(STORAGE_KEY,JSON.stringify(workspace));
}
export function loadWorkspace(storage: StorageLike, now=Date.now()): {workspace: Workspace; warning: string} {
  let raw: string|null=null;
  try {
    raw=storage.getItem(STORAGE_KEY);
    if (!raw) return {workspace:freshWorkspace(now),warning:''};
    return {workspace:validateWorkspace(JSON.parse(raw)),warning:''};
  } catch {
    try { if (raw) storage.setItem(QUARANTINE_KEY,raw); } catch { /* Surface read-only/quota failures. */ }
    try {
      const backup=storage.getItem(BACKUP_KEY);
      if (backup) return {workspace:validateWorkspace(JSON.parse(backup)),warning:'主数据损坏，已从本地备用副本恢复；请核对真实平台。损坏原文保留在隔离区。'};
    } catch { /* Recovery screen must remain usable. */ }
    const workspace=freshWorkspace(now);
    return {workspace,warning:'本地数据不可读，已进入现场恢复。请先核对平台；损坏原文（如可保存）留在隔离区，可从 JSON 备份导入。'};
  }
}
export function prepareReopen(workspace: Workspace, now=Date.now()): string[] {
  const expired: string[]=[];
  for(const w of Object.values(workspace.workflows)) {
    if (now-w.lastSeen>8*60*60*1000 || new Date(now).toDateString()!==new Date(w.lastSeen).toDateString()) expired.push(w.symbol);
    if (hasExposure(w)) { if (w.stage!==0) w.returnStage=w.stage; w.stage=0; w.needsReconcile=true; w.waiting=false; }
  }
  return expired;
}
export function importWorkspace(current: Workspace, text: string): Workspace {
  if(text.length>8_000_000) fail('文件过大，上限 8 MB');
  const next=validateWorkspace(JSON.parse(text));
  for (const s of SYMBOLS) if(hasExposure(current.workflows[s])) fail(`${s} 仍有持仓或委托记录，禁止用导入覆盖。请先核对真实平台并处理敞口记录。`);
  prepareReopen(next); return next;
}
