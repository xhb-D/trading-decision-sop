import { SOP_VERSION, ROUTING_VERSION, RULE_SNAPSHOT } from './rules.ts';
import type { Workflow, RouteEvent, Action, SymbolName } from './engine.ts';
export const MAX_EVENTS = 4000;
export interface UsageEvent {
  version: 1; id: number; at: number; date: string; sessionId: string; symbol: SymbolName;
  taskId: string; from: number; to: number; type: string; reason: string;
  origin: 'user' | 'system'; revision: number;
  activeMs?: number; waitMs?: number; idleMs?: number;
  sopVersion?: string; routingVersion?: string;
  stateChange?: { before: Record<string, unknown>; after: Record<string, unknown>; paths: string[] };
}
export interface Analytics { version: 1; nextId: number; dropped: number; events: UsageEvent[]; }
export const freshAnalytics = (): Analytics => ({ version: 1, nextId: 1, dropped: 0, events: [] });
export function localDate(now: number): string {
  const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function appendEvent(log: Analytics, w: Workflow, sessionId: string, now: number, data: Partial<UsageEvent> & {type: string}): void {
  log.events.push({ version: 1, id: log.nextId++, at: now, date: localDate(now), sessionId, symbol: w.symbol, taskId: w.taskId, from: w.stage, to: w.stage, reason: '', origin: 'system', revision: w.revision, sopVersion: SOP_VERSION, routingVersion: ROUTING_VERSION, ...data });
  if (log.events.length > MAX_EVENTS) {
    const overflow = log.events.length - MAX_EVENTS;
    // Drop a bounded prefix; incomplete tasks are explicitly excluded from task averages.
    const cut = Math.max(overflow, Math.min(500, log.events.length));
    log.events.splice(0, cut); log.dropped += cut;
  }
}
export function recordAction(log: Analytics, before: Workflow, after: Workflow, action: Action, routes: RouteEvent[], sessionId: string, now: number): void {
  // Exactly one click/action, regardless of how many system transitions it causes.
  const task = action.type === 'ADD_CANDIDATE' || action.type === 'SELECT_CANDIDATE' ? after : before;
  appendEvent(log, task, sessionId, now, { type: 'USER_ACTION', reason: action.type, origin: 'user', from: before.stage, to: after.stage });
  const prior=observableState(before), next=observableState(after);
  const paths=Object.keys(prior).filter(key=>JSON.stringify(prior[key])!==JSON.stringify(next[key]));
  if(paths.length) appendEvent(log, after, sessionId, now, {type:'STATE_CHANGED',reason:action.type,from:before.stage,to:after.stage,stateChange:{before:prior,after:next,paths}});
  for (const route of routes) appendEvent(log, after, sessionId, now, { ...route, origin: 'system' });
}
export interface ClockSnapshot { at: number; activeUntil: number; waiting: boolean; visible: boolean; }
export const startClock = (now: number, waiting: boolean, visible = true): ClockSnapshot => ({ at: now, activeUntil: now + 30000, waiting, visible });
export function elapsed(clock: ClockSnapshot, now: number): { activeMs: number; waitMs: number; idleMs: number } {
  const duration = Math.max(0, now - clock.at);
  if (!clock.visible) return { activeMs: 0, waitMs: 0, idleMs: duration };
  if (clock.waiting) return { activeMs: 0, waitMs: duration, idleMs: 0 };
  const activeMs = Math.max(0, Math.min(now, clock.activeUntil) - clock.at);
  return { activeMs, waitMs: 0, idleMs: duration - activeMs };
}
const average = (n: number[]) => n.length ? n.reduce((a,b) => a+b,0) / n.length : 0;
const median = (n: number[]) => { const s = [...n].sort((a,b)=>a-b); return s.length ? (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)]) / 2 : 0; };
export interface Filter { dateFrom?: string; dateTo?: string; symbol?: string; }
export function analyze(log: Analytics, filter: Filter = {}) {
  const events = log.events.filter(e => (!filter.symbol || e.symbol === filter.symbol) && (!filter.dateFrom || e.date >= filter.dateFrom) && (!filter.dateTo || e.date <= filter.dateTo));
  const tasks = new Map<string, UsageEvent[]>();
  for (const e of events) { const entries = tasks.get(e.taskId) ?? []; entries.push(e); tasks.set(e.taskId, entries); }
  const complete: {id: string; clicks: number; activeMs: number}[] = [];
  let incomplete = 0;
  for (const [id, list] of tasks) {
    const start=list.findIndex(e=>e.type==='TASK_STARTED');
    const end=list.findIndex(e=>e.type==='TASK_COMPLETED'||e.type==='TASK_INVALIDATED');
    if (start>=0 && end>=start) {
      const interval=list.slice(start,end+1);
      // Creation click precedes TASK_STARTED in the same reducer action.
      const creation=list.slice(0,start).filter(e=>e.type==='USER_ACTION'&&e.at===list[start].at);
      complete.push({ id, clicks: [...creation,...interval].filter(e => e.type === 'USER_ACTION').length, activeMs: interval.reduce((s,e)=>s+(e.activeMs??0),0) });
    } else incomplete++;
  }
  const stages = Array.from({length: 7}, (_,stage) => {
    const group = events.filter(e => e.from === stage);
    const visits = new Map<string, number>();
    for (const e of group.filter(e=>e.type === 'DURATION_RECORDED')) {
      // stage visit ID is encoded in reason, including across waits in the same visit.
      const key = `${e.sessionId}:${e.taskId}:${e.reason}`;
      visits.set(key, (visits.get(key)??0)+(e.activeMs??0));
    }
    const durations = [...visits.values()];
    return { stage, entries: events.filter(e=>e.type === 'STAGE_ENTERED' && e.to===stage).length,
      exits: events.filter(e=>e.type==='STAGE_TRANSITION'&&e.from===stage).length,
      revisits: events.filter(e=>e.type==='STAGE_REVISITED'&&e.to===stage).length,
      activeMs: group.reduce((s,e)=>s+(e.activeMs??0),0), waitMs: group.reduce((s,e)=>s+(e.waitMs??0),0),
      idleMs: group.reduce((s,e)=>s+(e.idleMs??0),0), averageMs: average(durations), medianMs: median(durations), samples: durations.length };
  });
  const returns = events.filter(e=>e.type === 'UPSTREAM_RETURN');
  // Only observable same-revision user returns are suspicious; no inference about missing market events.
  const seen = new Set<string>(); let suspicious = 0;
  const traces=upstreamEvidence(events);
  for (const e of returns) {
    const key=`${e.taskId}:${e.to}`; const trace=traces.find(t=>t.returnEventId===e.id);
    if(seen.has(key) && !trace?.hasRecordedConditionChange) suspicious++;
    seen.add(key);
  }
  return { retained: events.length, dropped: log.dropped, taskCount: [...tasks.values()].filter(es=>es.some(e=>e.type==='TASK_STARTED')).length,
    completedTasks: complete, incompleteTasks: incomplete, averageClicks: average(complete.map(x=>x.clicks)),
    averageActiveMs: average(complete.map(x=>x.activeMs)), medianActiveMs: median(complete.map(x=>x.activeMs)),
    totalClicks: events.filter(e=>e.type==='USER_ACTION').length,
    userReturns: returns.length, marketUpdates: events.filter(e=>e.type==='STAGE_TRANSITION'&&e.to<e.from&&e.reason.startsWith('MARKET_')).length,
    suspiciousReturns: suspicious, reviewLabel: '待人工复核',
    blocked: events.filter(e=>e.type==='ROUTE_BLOCKED').length,
    exceptions: events.filter(e=>e.type==='WORKFLOW_EXCEPTION').length,
    missingPrerequisites: events.filter(e=>e.type==='ROUTE_BLOCKED'&&/缺少|尚未|先|权限/.test(e.reason)).length,
    updates: Object.fromEntries(['U0','U1','U2'].map(key=>[key,events.filter(e=>e.type==='UPDATE_TRIGGERED'&&e.reason===key).length])),
    stages, events };
}
export function toCSV(log: Analytics, filter: Filter = {}): string {
  const columns = ['version','id','at','date','sessionId','symbol','taskId','from','to','type','reason','origin','revision','sopVersion','routingVersion','activeMs','waitMs','idleMs','stateChange'] as const;
  const cell = (v: unknown) => `"${(typeof v==='object'&&v!==null?JSON.stringify(v):String(v ?? '')).replace(/"/g,'""')}"`;
  return '\ufeff' + [columns.join(','), ...analyze(log,filter).events.map(e=>columns.map(k=>cell(e[k])).join(','))].join('\r\n');
}

/** A deliberately small whitelist: no labels, prices, notes, account/order numbers. */
export function observableState(w: Workflow): Record<string, unknown> {
  return { bias:w.bias, structure:structuredClone(w.structure), activeId:w.activeId,
    candidates:w.candidates.map(c=>({id:c.id,taskId:c.taskId,direction:c.direction,setup:c.setup,valid:c.valid,arrived:c.arrived,confirmed:c.confirmed,permission:c.permission,revision:c.revision})),
    execution:{candidateId:w.execution.candidateId,order:w.execution.order,position:w.execution.position,invalidationConfirmed:w.execution.invalidationConfirmed,riskConfirmed:w.execution.riskConfirmed,exitRequired:w.execution.exitRequired,riskReview:w.execution.riskReview},
    stage:w.stage,waiting:w.waiting,needsReconcile:w.needsReconcile,revision:w.revision };
}
const conditionCodes = new Set(['SET_BIAS','SET_STRUCTURE','STRUCTURE_CHANGE','INVALIDATE_LOCATION','INVALIDATE_SETUP','R01','R02','R03','R04','U2','FILL','PARTIAL_FILL','POINT_TOUCHED']);
export function upstreamEvidence(events: UsageEvent[]) {
  return events.filter(e=>e.type==='UPSTREAM_RETURN'||(e.type==='STAGE_TRANSITION'&&e.to<e.from&&e.reason!=='USER_NAVIGATION')).map(e=>{
    const prior=events.filter(x=>x.id<e.id&&x.taskId===e.taskId&&x.symbol===e.symbol);
    const anchor=prior.filter(x=>x.type==='STAGE_ENTERED'&&x.to===e.to).at(-1)??prior.find(x=>x.type==='TASK_STARTED');
    const interval=prior.filter(x=>x.id>(anchor?.id??0));
    const changes=interval.filter(x=>x.type==='STATE_CHANGED'&&x.stateChange?.paths.some(p=>['bias','structure','candidates','execution'].includes(p)));
    const confirmations=interval.filter(x=>x.type==='EVENT_CONFIRMED'&&conditionCodes.has(x.reason));
    const hasRecordedConditionChange=changes.length>0||confirmations.length>0;
    return {returnEventId:e.id,taskId:e.taskId,symbol:e.symbol,from:e.from,to:e.to,at:e.at,reason:e.reason,
      origin:e.type==='UPSTREAM_RETURN'?'user':'system',anchorEventId:anchor?.id??null,
      stateChangeEventIds:changes.map(x=>x.id),confirmedConditionEventIds:confirmations.map(x=>x.id),
      hasRecordedConditionChange,hasRecordedStateChange:changes.length>0,evidenceComplete:!!anchor,
      assessment:hasRecordedConditionChange?'存在已记录状态变化/条件事件；是否足以支持返回仍待人工复核':anchor?'可见记录中未发现状态变化；待人工复核':'保留窗口或旧日志证据不足；待人工复核'};
  });
}
export function buildAnalyticsBundle(log: Analytics, filter: Filter = {}, now=Date.now()) {
  const summary=analyze(log,filter); const events=structuredClone(summary.events);
  const lifecycle=[...new Set(events.map(e=>e.taskId))].map(taskId=>{
    const timeline=events.filter(e=>e.taskId===taskId);
    const start=timeline.find(e=>e.type==='TASK_STARTED');
    const terminal=timeline.find(e=>e.type==='TASK_COMPLETED'||e.type==='TASK_INVALIDATED');
    return {taskId,symbol:timeline[0].symbol,startEventId:start?.id??null,terminalEventId:terminal?.id??null,
      status:!start?'incomplete-window':terminal?(terminal.type==='TASK_COMPLETED'?'completed':'invalidated'):'open',
      eventIds:timeline.map(e=>e.id),lifecycleEvents:timeline.filter(e=>['TASK_STARTED','TASK_SUSPENDED','TASK_RESUMED','TASK_INVALIDATED','TASK_COMPLETED'].includes(e.type))};
  });
  const {events:_,...metrics}=summary;
  return {format:'SOP Analytics Bundle',schemaVersion:1,exportedAt:new Date(now).toISOString(),
    sopVersion:SOP_VERSION,routingVersion:ROUTING_VERSION,eventSchemaVersion:1,
    ruleSnapshot:{version:ROUTING_VERSION,rules:RULE_SNAPSHOT},filters:filter,
    retention:{maxEvents:MAX_EVENTS,retainedEvents:events.length,droppedEvents:log.dropped,completeHistory:log.dropped===0&&!filter.dateFrom&&!filter.dateTo&&!filter.symbol},
    metricDefinitions:{task:'TASK_STARTED 到首个 TASK_COMPLETED/TASK_INVALIDATED，缺少边界的任务不纳入完成均值',clicks:'USER_ACTION；系统路由不计点击。机会创建前的界面准备点击属于此前恢复/观察任务。',active:'DURATION_RECORDED.activeMs；排除 W 等待、后台和超过30秒无交互；这是估计而非心理决策耗时',date:'浏览器本地事件日期；跨筛选边界的任务可能不完整',upstream:'关联上次进入目标阶段/任务开始之后的 STATE_CHANGED 与已确认条件事件；不能据此自动认定交易纪律违规'},
    rawLog:{version:1,nextId:log.nextId,dropped:log.dropped,events},
    taskLifecycles:lifecycle,stateChanges:events.filter(e=>e.type==='STATE_CHANGED'),
    routes:events.filter(e=>['STAGE_TRANSITION','UPSTREAM_RETURN','ROUTE_BLOCKED','WORKFLOW_EXCEPTION'].includes(e.type)),
    upstreamReturns:upstreamEvidence(events),summary:metrics,
    recomputation:{module:'src/analytics.ts',function:'analyze(bundle.rawLog)',test:'npm test',input:'rawLog 是汇总唯一事实输入，导出包含当前筛选内原始事件；重算时不必再次应用 filters'},
    evidenceWarnings:[...(events.some(e=>!e.sopVersion)?['包含旧日志：其事件没有逐条 SOP/规则版本或状态快照，不能追溯补造。']:[]),...(log.dropped?['日志已裁剪；缺失窗口仅能标记证据不足。']:[])]};
}
