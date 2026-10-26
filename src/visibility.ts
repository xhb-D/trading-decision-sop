import { SYMBOLS } from './engine.ts';
import type { SymbolName } from './engine.ts';
interface DisplayState { activeSymbol: SymbolName; hiddenSymbols?: SymbolName[]; }
export function visibleSymbols(state: Pick<DisplayState,'hiddenSymbols'>): SymbolName[] {
  return SYMBOLS.filter(symbol => !state.hiddenSymbols?.includes(symbol));
}
export function withHiddenSymbols<T extends DisplayState>(state: T, hidden: SymbolName[]): T {
  const hiddenSymbols=SYMBOLS.filter(symbol=>hidden.includes(symbol));
  const visible=visibleSymbols({hiddenSymbols});
  return {...state,hiddenSymbols,activeSymbol:visible.includes(state.activeSymbol)?state.activeSymbol:(visible[0]??state.activeSymbol)};
}
/** Visibility never changes workflows, executions, candidates or analytics. */
export function setSymbolVisible<T extends DisplayState>(state: T, symbol: SymbolName, shown: boolean): T {
  const hidden=(state.hiddenSymbols??[]).filter(s=>s!==symbol);
  if(!shown) hidden.push(symbol);
  return withHiddenSymbols(state,hidden);
}
