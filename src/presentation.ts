import { STAGES, SYMBOLS, taskView } from './engine.ts';
import type { SymbolName, Workflow } from './engine.ts';

/** Display-only names. Persisted actions, routing rules and exports keep their IDs. */
const names: Record<string, string> = {
  ...Object.fromEntries(STAGES.map((name, stage) => [`P${stage}`, name])),
  R01: '价格到位', R02: '级别生长', R03: '对应级别极值假突破', R04: '更高级别极值假突破',
  U0: '维持当前判断', U1: '局部更新', U2: '重新读图'
};
export function displayText(text: string): string {
  return text.replace(/重新读图\s+U2\b/g, '重新读图').replace(/价格已到位\s+R01\b/g, '价格已到位')
    .replace(/\b(?:P[0-6]|R0[1-4]|U[0-2])\b/g, code => names[code]);
}
export const stageName = (stage: number) => STAGES[stage] ?? '待核对环节';
export function executionLabel(w: Workflow): string {
  const e = w.execution;
  if (e.exitRequired) return e.order !== 'none' ? '待平仓 · 待撤单' : '待平仓';
  if (e.order === 'cancelRequested') return e.position ? '持仓中 · 待撤单' : '待核对撤单';
  if (e.position) return e.order !== 'none' ? '持仓中 · 剩余挂单' : '持仓中';
  return e.order !== 'none' ? '有挂单' : '空仓';
}
export function symbolSummaries(workflows: Record<SymbolName, Workflow>, activeSymbol: SymbolName) {
  return SYMBOLS.map(symbol => {
    const w = workflows[symbol];
    const task = taskView(w);
    return { symbol, selected: symbol === activeSymbol, bias: w.bias,
      structure: w.structure.confirmed ? `${w.structure.timeframe} · ${w.structure.direction} · ${w.structure.phase}` : '待人工确认',
      stage: stageName(w.stage), execution: executionLabel(w),
      task: displayText(task.title), attention: w.needsReconcile ? '待平台核对' : w.waiting ? '等待市场' : w.execution.riskReview ? '待风险核对' : '',
      risk: w.execution.position || w.execution.order !== 'none' || w.execution.exitRequired };
  });
}
const eventNames: Record<string,string> = {
  SESSION_STARTED:'开始使用', STAGE_ENTERED:'进入环节', USER_ACTION:'人工操作', EVENT_CONFIRMED:'事件已确认',
  STAGE_TRANSITION:'环节切换', STAGE_REVISITED:'重新进入已完成环节', TASK_SUSPENDED:'暂存原任务',
  TASK_RESUMED:'恢复原任务', TASK_INVALIDATED:'任务已注销', ROUTE_BLOCKED:'前置条件不足',
  WORKFLOW_EXCEPTION:'流程异常', STAGE_COMPLETED:'完成环节', TASK_STARTED:'开始任务', TASK_COMPLETED:'完成任务',
  UPDATE_TRIGGERED:'更新判断', UPSTREAM_RETURN:'主动返回上游', STATE_CHANGED:'状态已更新'
};
export const eventName = (type: string) => eventNames[type] ?? '流程记录';
const reasons: Record<string,string> = {
  RECONCILE:'已核对真实平台', RECOVER_POSITION:'补录实际持仓', RECOVER_ORDER:'补录实际挂单',
  SET_BIAS:'更新有效 Bias', BIAS_DONE:'已确认 Bias', SET_STRUCTURE:'更新价格结构', STRUCTURE_DONE:'已确认结构',
  ADD_CANDIDATE:'新增合格候选', SELECT_CANDIDATE:'切换候选', GRANT_DIRECTION:'确认当前候选方向权限',
  CONFIRM_SETUP:'已确认 Setup', INVALIDATE_SETUP:'Setup 已失效', INVALIDATE_LOCATION:'位置已失效',
  CONFIRM_RISK:'已检查总体风险与订单冲突', CONFIRM_POINT:'已确定原逻辑失效点',
  PLACE_PENDING:'已记录挂单，等待成交', FILL:'已记录全部成交', PARTIAL_FILL:'已记录部分成交',
  REASON_INVALID:'原交易理由失效', REQUEST_CANCEL:'申请撤单，等待平台结果',
  POINT_TOUCHED:'人工确认触及原逻辑失效点', REQUEST_EXIT:'按既定计划离场', EXIT_CONFIRMED:'平台已确认平仓',
  RISK_REVIEWED:'已核对风险，沿用原失效点', WAIT:'继续等待', WAKE:'恢复当前判断',
  NAVIGATE:'人工选择环节', STRUCTURE_CHANGE:'母结构发生变化',
  BROWSER_OPEN:'打开看板', RESTORED_SNAPSHOT:'恢复已有快照', SYMBOL_SELECTED:'切换品种',
  RECOVERY_TASK:'恢复现场任务', REOPEN_PLATFORM_RECONCILIATION:'重新打开后核对真实平台',
  USER_RETURN_REVIEW_REQUIRED:'主动返回上游，待人工复核', USER_NAVIGATION:'人工选择环节',
  PLATFORM_RECONCILED:'平台记录已核对', SCENE_RESTORED:'现场恢复完成', POSITION_RECOVERED:'已补录实际持仓',
  ORDER_RECOVERED:'已补录实际挂单', BIAS_CONFIRMED:'Bias 已确认', BIAS_PERMISSION_CHANGED:'Bias 方向权限变化',
  MARKET_BIAS_UPDATE:'Bias 更新后检查依赖', STRUCTURE_FIELD_CHANGED:'结构判断变化，清理旧依赖',
  MARKET_STRUCTURE_UPDATE:'更新结构与受影响下游', STRUCTURE_CONFIRMED:'价格结构已确认', STRUCTURE_UPDATED:'结构局部更新完成',
  CANDIDATE_CREATED:'新候选已加入', CANDIDATE_SELECTED:'切换到有效候选', SETUP_CONFIRMED:'Setup 已确认，进入入场检查',
  REOBSERVE_AFTER_INVALIDATION:'旧判断失效后重新观察', PLAN_INVALID:'计划依赖失效，返回相关环节',
  PLAN_INVALID_RISK_FIRST:'计划失效，先处理现有敞口', ENTRY_REASON_INVALID:'入场理由失效',
  ORDER_CANCELLED:'未成交委托已撤销', CANCEL_CONFIRMED_POSITION_REMAINS:'剩余委托已撤，继续管理持仓',
  CANCEL_CONFIRMED:'撤单已核对，重新评估位置', FILL_RECORDED:'实际成交已记录，进入持仓管理',
  PARTIAL_FILL_RECORDED:'部分成交已记录，分别管理持仓与剩余挂单', EXIT_REQUIRED:'按既定规则平仓并核对',
  PLATFORM_EXIT_CONFIRMED:'平台已确认离场', REMAINING_ORDER_MUST_CANCEL:'持仓已平，剩余挂单仍须撤销',
  POSITION_CLOSED:'离场已核对，重新观察交易位置', STRUCTURE_CHANGED:'母结构变化，清理旧 Setup',
  SUSPENDED_DEPENDENCIES_CHANGED:'暂存任务的依赖已改变', INTERRUPTED_RISK_FIRST:'任务中断，风险处理优先',
  INTERRUPTED_DEPENDENCIES_INVALID:'原任务依赖失效，返回上游', POSITION_PRIORITY:'优先处理真实持仓',
  POSITION_PRIORITY_REPAIRED:'已恢复持仓优先顺序', OBSERVABLE_RUNTIME_ERROR:'检测到界面运行异常'
};
export function reasonName(reason: string): string {
  if (reasons[reason]) return reasons[reason];
  if (names[reason]) return names[reason];
  if (reason.startsWith('MARKET_R01')) return '合格位置已到位，开始观察 Setup';
  if (reason.startsWith('MARKET_R02') || reason.startsWith('R02_')) {
    if (/CHANGED|INVALID/.test(reason)) return '级别更新后原依赖失效';
    if (/RISK/.test(reason)) return '级别更新被风险事件中断，优先恢复风险处理';
    if (/RESUME|VALID|CANCELLED/.test(reason)) return '级别更新完成，恢复有效原任务';
    return '级别生长，暂存原任务并局部更新结构';
  }
  if (reason.startsWith('MARKET_R03')) return reason.includes('RISK') ? '对应级别假突破，现有敞口优先风险评估' : '对应级别假突破，更新原有观察任务';
  if (reason.startsWith('MARKET_R04')) return reason.includes('RISK') ? '更高级别假突破，现有敞口优先风险评估' : '更高级别假突破，重新评估位置与方向权限';
  if (reason.startsWith('U2_')) return '原分析快照失效，保留真实敞口并重新读图';
  if (/^[A-Z][A-Z0-9_]+$/.test(reason)) return '流程状态已更新';
  return displayText(reason);
}
