import type { ProgramTradeSeries } from '../api/types';

export type ProgramLineLoadState = 'loading' | 'ready' | 'error';

/** Data-window history is independent of the candle pane's date/axis gate. */
export interface ProgramWindowData {
  series: ProgramTradeSeries;
  state: ProgramLineLoadState;
  closeState: ProgramLineLoadState;
}
