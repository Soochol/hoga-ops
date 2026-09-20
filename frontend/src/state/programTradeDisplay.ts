import { create } from 'zustand';

export type ProgramTradeMeasure = 'amount' | 'qty';
export type ProgramTradeView = 'intraday' | 'daily';
export type ProgramDailyDisplay = 'all' | 'net' | 'buy' | 'sell';
/** 0 = loaded history 전체. Older pages are fetched progressively by the data window. */
export type ProgramDailySpan = 0 | 5 | 20 | 60;

const STORAGE_KEY = 'live.programTradeDisplay.v1';

type Persisted = {
  measure: ProgramTradeMeasure;
  view: ProgramTradeView;
  dailyDisplay: ProgramDailyDisplay;
  dailySpan: ProgramDailySpan;
  dailyUseK: boolean;
  dailyFollowCursor: boolean;
};

interface Store extends Persisted {
  setMeasure: (measure: ProgramTradeMeasure) => void;
  setView: (view: ProgramTradeView) => void;
  setDailyDisplay: (display: ProgramDailyDisplay) => void;
  setDailySpan: (span: ProgramDailySpan) => void;
  setDailyUseK: (value: boolean) => void;
  setDailyFollowCursor: (value: boolean) => void;
}

function isMeasure(value: unknown): value is ProgramTradeMeasure {
  return value === 'amount' || value === 'qty';
}

const defaults: Persisted = {
  measure: 'amount', view: 'intraday', dailyDisplay: 'all', dailySpan: 20, dailyUseK: true,
  dailyFollowCursor: true,
};

const validView = (value: unknown): value is ProgramTradeView => value === 'intraday' || value === 'daily';
const validDisplay = (value: unknown): value is ProgramDailyDisplay =>
  value === 'all' || value === 'net' || value === 'buy' || value === 'sell';
const validSpan = (value: unknown): value is ProgramDailySpan =>
  value === 0 || value === 5 || value === 20 || value === 60;

function readStorage(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      measure: isMeasure(parsed.measure) ? parsed.measure : 'amount',
      view: validView(parsed.view) ? parsed.view : defaults.view,
      dailyDisplay: validDisplay(parsed.dailyDisplay) ? parsed.dailyDisplay : defaults.dailyDisplay,
      dailySpan: validSpan(parsed.dailySpan) ? parsed.dailySpan : defaults.dailySpan,
      dailyUseK: typeof parsed.dailyUseK === 'boolean' ? parsed.dailyUseK : defaults.dailyUseK,
      dailyFollowCursor: typeof parsed.dailyFollowCursor === 'boolean'
        ? parsed.dailyFollowCursor : defaults.dailyFollowCursor,
    };
  } catch {
    return defaults;
  }
}

function persist(value: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable — keep the in-memory preference.
  }
}

export const useProgramTradeDisplayStore = create<Store>((set, get) => {
  const update = (partial: Partial<Persisted>) => {
    set(partial);
    const state = get();
    persist({
      measure: state.measure, view: state.view, dailyDisplay: state.dailyDisplay,
      dailySpan: state.dailySpan, dailyUseK: state.dailyUseK,
      dailyFollowCursor: state.dailyFollowCursor,
    });
  };
  return {
  ...readStorage(),
  setMeasure: (measure) => {
    if (!isMeasure(measure)) return;
    update({ measure });
  },
  setView: (view) => { if (validView(view)) update({ view }); },
  setDailyDisplay: (dailyDisplay) => { if (validDisplay(dailyDisplay)) update({ dailyDisplay }); },
  setDailySpan: (dailySpan) => { if (validSpan(dailySpan)) update({ dailySpan }); },
  setDailyUseK: (dailyUseK) => { if (typeof dailyUseK === 'boolean') update({ dailyUseK }); },
  setDailyFollowCursor: (dailyFollowCursor) => {
    if (typeof dailyFollowCursor === 'boolean') update({ dailyFollowCursor });
  },
  };
});
