export const SYMBOLS = ['GC', 'CL', 'ES'] as const;
export type SymbolName = typeof SYMBOLS[number];
export const STAGES = ['现场恢复', '拍卖背景', '价格结构', '交易位置', 'Setup 确认', '入场执行', '持仓管理'];
export const BIASES = ['未裁决', '正式多头', '正式空头', '平衡中性', '待定中性'] as const;
export type Bias = typeof BIASES[number];
export type Direction = '多头' | '空头';
export interface Candidate {
  id: string; taskId: string; label: string; direction: Direction; setup: 'PB' | 'BOF';
  valid: boolean; arrived: boolean; confirmed: boolean; permission: boolean; revision: number; completedStages?: number[];
}
export interface Execution {
  candidateId: string | null; order: 'none' | 'pending' | 'cancelRequested'; position: boolean;
  invalidationConfirmed: boolean; originalPoint: string; riskConfirmed: boolean;
  exitRequired: boolean; riskReview: boolean;
}
export interface Workflow {
  symbol: SymbolName; stage: number; bias: Bias;
  structure: { direction: string; phase: string; timeframe: string; confirmed: boolean };
  candidates: Candidate[]; activeId: string | null; execution: Execution;
  suspension: { stage: number; activeId: string | null; revision: number; candidateRevision: number; waiting: boolean; taskId: string } | null;
  revision: number; taskId: string; waiting: boolean; needsReconcile: boolean;
  returnStage: number | null; lastSeen: number; snapshotAt: number; notice: string;
  completedStages: number[];
}
export interface RouteEvent { type: string; from: number; to: number; reason: string; taskId: string; revision: number; }
export type ActionType = 'RECONCILE' | 'RECOVER_POSITION' | 'RECOVER_ORDER' | 'SET_BIAS' | 'BIAS_DONE' |
  'SET_STRUCTURE' | 'STRUCTURE_DONE' | 'ADD_CANDIDATE' | 'SELECT_CANDIDATE' | 'GRANT_DIRECTION' |
  'R01' | 'R02' | 'R03' | 'R04' | 'CONFIRM_SETUP' | 'INVALIDATE_SETUP' | 'INVALIDATE_LOCATION' |
  'CONFIRM_RISK' | 'CONFIRM_POINT' | 'PLACE_PENDING' | 'FILL' | 'PARTIAL_FILL' | 'REASON_INVALID' |
  'REQUEST_CANCEL' | 'CANCEL_CONFIRMED' | 'POINT_TOUCHED' | 'REQUEST_EXIT' | 'EXIT_CONFIRMED' |
  'RISK_REVIEWED' | 'WAIT' | 'WAKE' | 'U0' | 'U2' | 'NAVIGATE' | 'STRUCTURE_CHANGE';
export interface Action { type: ActionType; value?: string; id?: string; direction?: Direction; setup?: 'PB' | 'BOF'; field?: 'direction' | 'phase' | 'timeframe'; stage?: number; }
export const emptyExecution = (): Execution => ({ candidateId: null, order: 'none', position: false, invalidationConfirmed: false, originalPoint: '', riskConfirmed: false, exitRequired: false, riskReview: false });
export function initialWorkflow(symbol: SymbolName, now = Date.now()): Workflow {
  return { symbol, stage: 0, bias: '未裁决', structure: { direction: '未确认', phase: '未确认', timeframe: '30M', confirmed: false }, candidates: [], activeId: null, execution: emptyExecution(), suspension: null, revision: 0, taskId: `${symbol}-restore-${now}`, waiting: false, needsReconcile: true, returnStage: null, lastSeen: now, snapshotAt: now, notice: '', completedStages: [] };
}
export const activeCandidate = (w: Workflow) => w.candidates.find(c => c.id === w.activeId);
export const hasExposure = (w: Workflow) => w.execution.position || w.execution.order !== 'none';
export function directionAllowed(w: Workflow, c = activeCandidate(w)): boolean {
  if (!c || !c.valid || w.bias === '未裁决') return false;
  if (w.bias === '正式多头') return c.direction === '多头';
  if (w.bias === '正式空头') return c.direction === '空头';
  return c.permission;
}
export function entryBlock(w: Workflow): string | null {
  const c = activeCandidate(w);
  if (w.needsReconcile) return '请先核对真实交易平台';
  if (!directionAllowed(w, c)) return '方向权限不足：不得违背当前有效 Bias；中性须人工确认具体方向权限';
  if (!w.structure.confirmed) return '缺少已确认的价格结构';
  if (!c?.arrived || !c.valid) return '缺少已到位的合格 HTF 位置';
  if (!c.confirmed) return '缺少人工确认的 Setup';
  return null;
}
export function reduceWorkflow(input: Workflow, action: Action, now = Date.now()): { workflow: Workflow; events: RouteEvent[]; blocked: boolean } {
  const w = structuredClone(input); const events: RouteEvent[] = []; let blocked = false;
  const event = (type: string, reason: string, from = w.stage, to = w.stage, taskId = w.taskId) => events.push({ type, reason, from, to, taskId, revision: w.revision });
  const block = (reason: string) => { blocked = true; w.notice = reason; event('ROUTE_BLOCKED', reason); };
  const go = (stage: number, reason: string, complete = false) => {
    const from = w.stage;
    if (complete && !w.completedStages.includes(from)) { w.completedStages.push(from); const current=activeCandidate(w); if(current)current.completedStages=[...w.completedStages]; event('STAGE_COMPLETED', reason); }
    if (from === stage) return;
    if (w.completedStages.includes(stage)) event('STAGE_REVISITED', reason, from, stage);
    w.stage = stage; w.waiting = false;
    event('STAGE_TRANSITION', reason, from, stage); event('STAGE_ENTERED', reason, from, stage);
  };
  const riskRoute = (reason: string) => { if (w.execution.position) go(6, reason); else if (w.execution.order !== 'none') go(5, reason); else go(3, reason); };
  const clearPlan = () => { if (!hasExposure(w)) w.execution = emptyExecution(); };
  const invalidate = (c: Candidate | undefined, location: boolean, reason: string) => {
    if (!c) return;
    c.confirmed = false; c.revision++; if (location) { c.valid = false; c.arrived = false; c.permission = false; }
    event('TASK_INVALIDATED', reason, w.stage, location ? 3 : 4, c.taskId);
    if (!location) {
      c.completedStages=[];
      if(w.activeId===c.id) w.completedStages=[];
      c.taskId = `task-${c.id}-revision-${c.revision}`;
      if(w.activeId===c.id) w.taskId=c.taskId;
      event('TASK_STARTED', 'REOBSERVE_AFTER_INVALIDATION', w.stage, w.stage, c.taskId);
    }
    if (w.execution.candidateId === c.id && hasExposure(w)) {
      if (w.execution.order !== 'none') w.execution.order = 'cancelRequested';
      if (w.execution.position) w.execution.riskReview = true;
    } else if (w.activeId === c.id) clearPlan();
  };
  const important = ['R01', 'R02', 'R03', 'R04', 'SET_BIAS', 'STRUCTURE_CHANGE', 'INVALIDATE_LOCATION', 'INVALIDATE_SETUP', 'FILL', 'PARTIAL_FILL', 'POINT_TOUCHED', 'EXIT_CONFIRMED', 'U2'].includes(action.type);
  w.notice = ''; w.lastSeen = now;
  if (important) event('EVENT_CONFIRMED', action.type);
  if (['SET_BIAS', 'STRUCTURE_CHANGE', 'INVALIDATE_LOCATION', 'INVALIDATE_SETUP', 'R01', 'R02', 'R03', 'R04'].includes(action.type)) event('UPDATE_TRIGGERED', 'U1');
  const c = activeCandidate(w);
  // Mandatory platform reconciliation cannot be bypassed by event shortcuts.
  if (w.needsReconcile && !['RECONCILE', 'RECOVER_POSITION', 'RECOVER_ORDER', 'U2', 'U0'].includes(action.type)) {
    block('请先在 P0 核对真实持仓和未成交委托'); return { workflow: w, events, blocked };
  }
  switch (action.type) {
    case 'RECONCILE':
      if (!hasExposure(w) && w.stage===0) event('TASK_COMPLETED','SCENE_RESTORED');
      w.needsReconcile = false; w.snapshotAt = now;
      go(w.execution.position ? 6 : w.execution.order !== 'none' ? 5 : (w.returnStage ?? 1), 'PLATFORM_RECONCILED', true); w.returnStage = null; break;
    case 'RECOVER_POSITION':
      w.execution.position = true; w.execution.riskReview = true; w.needsReconcile = false;
      go(6, 'POSITION_RECOVERED'); w.notice = '已记录实际持仓。请沿用入场前确定的原逻辑失效点；本看板无法核验其数值。'; break;
    case 'RECOVER_ORDER':
      w.execution.order = 'pending'; w.execution.riskReview = true; w.needsReconcile = false;
      go(w.execution.position ? 6 : 5, 'ORDER_RECOVERED'); w.notice = '已记录实际挂单。请核对平台原计划；可记录后续成交或申请撤单。'; break;
    case 'SET_BIAS': {
      if (!(BIASES as readonly string[]).includes(action.value ?? '')) { block('无效 Bias'); break; }
      if (w.bias !== action.value) {
        w.bias = action.value as Bias; w.revision++;
        for (const item of w.candidates) {
          item.permission = false;
          // A formal opposite Bias or unresolved Bias invalidates dependent entry plans.
          if (!directionAllowed(w, item)) invalidate(item, false, 'BIAS_PERMISSION_CHANGED');
        }
        clearPlan();
        if (hasExposure(w)) { w.execution.riskReview = true; riskRoute('MARKET_BIAS_UPDATE'); }
        else go(w.structure.confirmed ? 3 : 1, 'MARKET_BIAS_UPDATE');
      }
      break;
    }
    case 'BIAS_DONE': if (w.bias === '未裁决') block('Bias 尚未裁决，请继续等待或人工确认状态'); else go(2, 'BIAS_CONFIRMED', true); break;
    case 'SET_STRUCTURE':
      if(w.stage!==2) {block('请先进入 P2 更新价格结构');break;}
      if (!action.field || !action.value) { block('缺少结构字段'); break; }
      if(w.structure.confirmed && w.structure[action.field]!==action.value && (!w.suspension || action.field!=='timeframe')) {
        w.structure.confirmed=false;
        w.revision++;
        for(const item of w.candidates.filter(item=>item.valid)) invalidate(item,false,'STRUCTURE_FIELD_CHANGED');
        if(hasExposure(w)) w.execution.riskReview=true;
      }
      w.structure[action.field] = action.value;
      if (!w.suspension) w.structure.confirmed = false;
      break;
    case 'STRUCTURE_DONE': {
      if (w.structure.direction === '未确认' || w.structure.phase === '未确认') { block('请确认结构方向和运行阶段'); break; }
      w.structure.confirmed = true; w.snapshotAt = now;
      if (w.suspension) {
        const saved = w.suspension; w.suspension = null;
        const original = w.candidates.find(item => item.id === saved.activeId);
        const valid = saved.revision === w.revision && (!saved.activeId || (!!original?.valid && saved.candidateRevision === original.revision));
        if (valid) { w.activeId = saved.activeId; w.taskId = saved.taskId; go(saved.stage, 'MARKET_R02_RESUME', true); w.waiting = saved.waiting; event('TASK_RESUMED', 'R02_DEPENDENCIES_VALID'); }
        else { event('TASK_INVALIDATED', 'R02_DEPENDENCIES_CHANGED', 2, 3, saved.taskId); riskRoute('R02_TASK_INVALID'); }
      } else if (hasExposure(w)) riskRoute('STRUCTURE_UPDATED');
      else go(3, 'STRUCTURE_CONFIRMED', true);
      break;
    }
    case 'ADD_CANDIDATE': {
      if(w.suspension) {block('请先完成 R02 局部更新与原任务恢复');break;}
      if (hasExposure(w)) { block('先完成现有持仓或委托的风险处理；其他候选仍保留'); break; }
      if (!w.structure.confirmed || w.bias === '未裁决') { block('请先确认 Bias 与价格结构'); break; }
      const id = `${w.symbol}-${now}-${w.candidates.length}`;
      const item: Candidate = { id, taskId: `task-${id}`, label: (action.value?.trim() || `HTF 位置 ${w.candidates.length + 1}`).slice(0, 40), direction: action.direction ?? '多头', setup: action.setup ?? 'PB', valid: true, arrived: false, confirmed: false, permission: false, revision: 0, completedStages: [] };
      w.candidates.push(item); w.activeId = id; w.taskId = item.taskId; w.completedStages = []; clearPlan(); go(3, 'CANDIDATE_CREATED'); event('TASK_STARTED', 'CANDIDATE_CREATED'); break;
    }
    case 'SELECT_CANDIDATE': {
      if(w.suspension) {block('请先完成 R02 局部更新与原任务恢复');break;}
      if (hasExposure(w)) { block('已有执行计划，先处理持仓或委托'); break; }
      const selected = w.candidates.find(item => item.id === action.id && item.valid);
      if (!selected) { block('候选已失效或不存在'); break; }
      clearPlan(); w.activeId = selected.id; w.taskId = selected.taskId; w.completedStages=[...(selected.completedStages??(selected.confirmed?[3,4]:selected.arrived?[3]:[]))];
      go(selected.confirmed ? 5 : selected.arrived ? 4 : 3, 'CANDIDATE_SELECTED'); break;
    }
    case 'GRANT_DIRECTION':
      if (!c || !['平衡中性', '待定中性'].includes(w.bias)) { block('仅在中性状态下对当前候选确认方向权限'); break; }
      c.permission = true; break;
    case 'R01':
      if(!w.structure.confirmed) {block('缺少已确认的价格结构，请先完成 P2 更新');break;}
      if (hasExposure(w)) { block('现有持仓或挂单优先处理'); break; }
      if (!c?.valid) { block('先选择有效且合格的 HTF 候选位置'); break; }
      if (!directionAllowed(w)) { block('方向权限不足：先核对 Bias 与当前候选方向权限'); break; }
      c.arrived = true; go(4, 'MARKET_R01', true); break;
    case 'R02':
      if (w.suspension) { block('已有 R02 局部更新，请先完成'); break; }
      if (w.execution.exitRequired || w.execution.order === 'cancelRequested' || w.execution.riskReview) { block('先完成当前平仓、撤单或持仓风险核对'); break; }
      w.suspension = { stage: w.stage, activeId: w.activeId, revision: w.revision, candidateRevision: c?.revision ?? 0, waiting: w.waiting, taskId: w.taskId };
      event('TASK_SUSPENDED', 'R02'); go(2, 'MARKET_R02'); break;
    case 'R03':
      if (hasExposure(w)) { w.execution.riskReview = true; riskRoute('MARKET_R03_RISK_FIRST'); }
      else if (c?.valid) { invalidate(c, false, 'MARKET_R03_REOBSERVE'); go(c.arrived ? 4 : 3, 'MARKET_R03'); }
      else go(3, 'MARKET_R03_NO_LOCATION_PERMISSION'); break;
    case 'R04':
      if (c) { invalidate(c, false, 'MARKET_R04_REASSESS'); c.arrived = false; c.permission = false; c.revision++; }
      if (hasExposure(w)) { w.execution.riskReview = true; riskRoute('MARKET_R04_RISK_FIRST'); }
      else { clearPlan(); go(3, 'MARKET_R04_REASSESS_DIRECTION'); }
      w.notice = 'R04 不改变 Bias。请在 P3 重新确认位置与拟交易方向，再观察反向 Setup。'; break;
    case 'CONFIRM_SETUP':
      if (w.stage !== 4 || !c?.arrived || !c.valid) { block('先确认合格位置已到位'); break; }
      if (!directionAllowed(w)) { block('方向权限不足，不能进入 P5'); break; }
      c.confirmed = true;
      if (entryBlock(w)) { c.confirmed = false; block(entryBlock(w)!); break; }
      clearPlan(); go(5, 'SETUP_CONFIRMED', true); break;
    case 'INVALIDATE_SETUP':
    case 'INVALIDATE_LOCATION': {
      const target = action.id ? w.candidates.find(item => item.id === action.id) : c;
      if (!target) { block('没有可更新的候选'); break; }
      invalidate(target, action.type === 'INVALIDATE_LOCATION', action.type);
      if (hasExposure(w) && (target.id===w.activeId || target.id===w.execution.candidateId)) riskRoute('PLAN_INVALID_RISK_FIRST');
      else if (target.id === w.activeId) go(action.type === 'INVALIDATE_LOCATION' ? 3 : (target.arrived ? 4 : 3), 'PLAN_INVALID'); break;
    }
    case 'CONFIRM_RISK':
    case 'CONFIRM_POINT':
      if (w.stage !== 5 || hasExposure(w) || entryBlock(w)) { block('仅在有效入场计划、尚未提交委托时确认'); break; }
      if (action.type === 'CONFIRM_RISK') w.execution.riskConfirmed = true;
      else { w.execution.invalidationConfirmed = true; w.execution.originalPoint = (action.value ?? '').slice(0, 120); }
      w.execution.candidateId = w.activeId; break;
    case 'PLACE_PENDING':
    case 'FILL':
    case 'PARTIAL_FILL': {
      const existingOrder = w.execution.order !== 'none';
      if (!existingOrder) {
        if (hasExposure(w)) { block('已有持仓，禁止重复新建执行计划'); break; }
        const reason = entryBlock(w); if (reason) { block(reason); break; }
        if (!w.execution.riskConfirmed || !w.execution.invalidationConfirmed) { block('缺少总体风险/订单冲突确认，或尚未确认入场前已确定逻辑失效点'); break; }
      }
      if (action.type === 'PLACE_PENDING') { if (existingOrder) { block('已记录挂单，请核对实际成交或撤单结果'); break; } w.execution.order = 'pending'; w.waiting = true; }
      else {
        // Actual fills must be recorded even after a cancellation request or stale analysis.
        const cancellation = w.execution.order === 'cancelRequested';
        w.execution.position = true;
        w.execution.order = action.type === 'PARTIAL_FILL' ? (cancellation ? 'cancelRequested' : 'pending') : 'none';
        if (cancellation) w.execution.riskReview = true;
        go(6, action.type === 'PARTIAL_FILL' ? 'PARTIAL_FILL_RECORDED' : 'FILL_RECORDED', true);
      }
      break;
    }
    case 'REASON_INVALID':
      if (!hasExposure(w)) { invalidate(c, false, 'ENTRY_REASON_INVALID'); go(3, 'ENTRY_REASON_INVALID'); }
      else { if (w.execution.order !== 'none') w.execution.order = 'cancelRequested'; if (w.execution.position) w.execution.riskReview = true; riskRoute('REASON_INVALID'); } break;
    case 'REQUEST_CANCEL':
      if (w.execution.order === 'none') { block('没有已记录的未成交委托'); break; }
      w.execution.order = 'cancelRequested'; w.notice = '请到交易平台撤销剩余委托；收到撤单成功结果后再确认。'; break;
    case 'CANCEL_CONFIRMED':
      if (w.execution.order === 'none') { block('没有需要核对的委托'); break; }
      w.execution.order = 'none';
      if (w.execution.position) go(6, 'CANCEL_CONFIRMED_POSITION_REMAINS');
      else { invalidate(c, false, 'ORDER_CANCELLED'); w.execution = emptyExecution(); go(3, 'CANCEL_CONFIRMED'); } break;
    case 'POINT_TOUCHED':
    case 'REQUEST_EXIT':
      if (!w.execution.position) { block('没有已记录的真实持仓'); break; }
      w.execution.exitRequired = true; if (w.execution.order !== 'none') w.execution.order = 'cancelRequested';
      go(6, 'EXIT_REQUIRED'); w.notice = '请按既定规则在平台平仓；看板不会自动执行或确认平仓。'; break;
    case 'EXIT_CONFIRMED':
      if (!w.execution.position) { block('没有待核对的持仓'); break; }
      w.execution.position = false; w.execution.exitRequired = false; w.execution.riskReview = false;
      event('TASK_COMPLETED', 'PLATFORM_EXIT_CONFIRMED');
      if (w.execution.order !== 'none') { w.execution.order = 'cancelRequested'; go(5, 'REMAINING_ORDER_MUST_CANCEL'); }
      else { if (c) { c.confirmed = false; c.arrived = false; c.valid = false; c.revision++; } w.execution = emptyExecution(); w.activeId = null; go(3, 'POSITION_CLOSED', true); } break;
    case 'RISK_REVIEWED':
      w.execution.riskReview = false;
      w.notice = '已记录人工风险核对，沿用原逻辑失效点。'; break;
    case 'WAIT': w.waiting = true; break;
    case 'WAKE': w.waiting = false; break;
    case 'U0': event('UPDATE_TRIGGERED', 'U0'); break;
    case 'U2':
      event('UPDATE_TRIGGERED', 'U2'); w.revision++;
      for (const item of w.candidates.filter(item => item.valid)) invalidate(item, true, 'U2_SNAPSHOT_EXPIRED');
      w.bias = '未裁决'; w.structure.confirmed = false; w.suspension = null; w.activeId = null; w.snapshotAt = now;
      if (hasExposure(w)) { w.needsReconcile = true; w.returnStage = w.execution.position ? 6 : 5; w.execution.riskReview = true; go(0, 'U2_RECONCILE_REAL_EXPOSURE'); }
      else { w.execution = emptyExecution(); w.needsReconcile = false; go(1, 'U2_REREAD'); } break;
    case 'STRUCTURE_CHANGE':
      w.revision++; w.structure.confirmed = false;
      for (const item of w.candidates.filter(item => item.valid)) invalidate(item, false, 'STRUCTURE_CHANGED');
      if (hasExposure(w)) { w.execution.riskReview = true; riskRoute('STRUCTURE_RISK_FIRST'); }
      else go(2, 'MARKET_STRUCTURE_UPDATE'); break;
    case 'NAVIGATE': {
      const to = action.stage;
      if (to === undefined || to < 0 || to > 6 || !Number.isInteger(to)) { block('无效环节'); break; }
      if (hasExposure(w) && to !== 0 && to !== (w.execution.position ? 6 : 5)) { block('持仓/挂单风险优先；结构局部更新请使用 R02'); break; }
      if (to >= 2 && w.bias === '未裁决' && !hasExposure(w)) { block('缺少人工裁决的 Bias'); break; }
      if (to >= 3 && !w.structure.confirmed && !hasExposure(w)) { block('缺少已确认的结构'); break; }
      if (to === 4 && (!c?.arrived || !directionAllowed(w))) { block('缺少已到位的位置或具体方向权限'); break; }
      if (to === 5 && !hasExposure(w) && entryBlock(w)) { block(entryBlock(w)!); break; }
      if (to === 6 && !w.execution.position) { block('尚无平台确认的真实持仓'); break; }
      if (to < w.stage) event('UPSTREAM_RETURN', 'USER_RETURN_REVIEW_REQUIRED', w.stage, to);
      if(to===0) {w.returnStage=w.stage; w.needsReconcile=true;}
      go(to, 'USER_NAVIGATION'); break;
    }
  }
  if(w.suspension) {
    const saved=w.suspension;
    const original=w.candidates.find(item=>item.id===saved.activeId);
    if(saved.revision!==w.revision || (saved.activeId && (!original?.valid || original.revision!==saved.candidateRevision))) {
      event('TASK_INVALIDATED','SUSPENDED_DEPENDENCIES_CHANGED',w.stage,w.structure.confirmed?3:2,saved.taskId);
      w.suspension=null;
      if(hasExposure(w)) riskRoute('INTERRUPTED_RISK_FIRST'); else go(w.structure.confirmed?3:2,'INTERRUPTED_DEPENDENCIES_INVALID');
    }
  }
  if(w.suspension && w.stage!==2) {
    w.suspension=null;
    event('TASK_RESUMED',hasExposure(w)?'R02_SUPERSEDED_BY_RISK':'R02_CANCELLED_BY_NAVIGATION');
  }
  // No branch is allowed to hide an existing position behind an opportunity task.
  if (w.execution.position && w.stage !== 6 && w.stage !== 0 && !w.suspension) { event('WORKFLOW_EXCEPTION', 'POSITION_PRIORITY_REPAIRED', w.stage, 6); go(6, 'POSITION_PRIORITY'); }
  return { workflow: w, events, blocked };
}
export function taskView(w: Workflow): { title: string; next: string; fallback: string; tone: string } {
  const c = activeCandidate(w); const e = w.execution;
  if (w.needsReconcile) return { title: '核对平台，恢复现场', next: '持仓与委托核对一致 → 恢复有效任务', fallback: '快照过期 → 重新读图 U2', tone: 'warning' };
  if (e.exitRequired) return { title: '执行平仓，并核对平台结果', next: '人工确认已平仓 → 检查剩余委托', fallback: '原逻辑失效点不得放宽', tone: 'danger' };
  if (e.order === 'cancelRequested') return { title: e.position ? '管理已成交部分，撤销剩余委托' : '撤销未成交委托，核对结果', next: '平台确认撤单成功 → 返回适当环节', fallback: '撤单期间成交 → 按真实成交记录并管理', tone: 'danger' };
  if (e.riskReview) return { title: '优先评估现有持仓 / 委托风险', next: '人工风险核对 → 继续既定管理', fallback: '原理由失效 → 撤单 / 持仓风险处理', tone: 'warning' };
  const list = [
    ['检查真实持仓、委托与快照', '核对一致 → P1', '快照过期 → U2'],
    ['人工确认当前有效 Bias', 'Bias 已裁决 → P2', '未裁决 → 继续等待'],
    [w.suspension ? '局部更新观察级别' : '确认母结构与运行阶段', w.suspension ? '依赖有效 → 恢复原任务' : '结构已确认 → P3', '原依赖失效 → 注销并返回上游'],
    [c?.valid ? `等待${c.direction}价格进入 ${c.label}` : '选择合格 HTF 候选位置', '价格已到位 R01 → P4', '位置失效 → P3，保留其他位置'],
    [`等待${c?.direction ?? ''} ${c?.setup ?? 'PB / BOF'}`, 'Setup 人工确认 → P5', 'Setup 失效 → 重新观察；位置失效 → P3'],
    [e.order !== 'none' ? '等待平台成交结果' : '确认入场条件与原逻辑失效点', '人工确认成交 → P6', '理由失效 → 撤单并核对结果'],
    ['按既定规则管理持仓', '平台确认离场 → P3', '触及原逻辑失效点 → 执行平仓并核对']
  ][w.stage];
  return { title: list[0], next: list[1], fallback: list[2], tone: w.waiting ? 'waiting' : 'ready' };
}
