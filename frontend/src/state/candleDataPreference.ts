import { create } from 'zustand';

export type CandleDataPreference =
  | 'auto'
  | 'hogaplay_first'
  | 'kis_api_first'
  | 'screener_daily_first';

export const CANDLE_DATA_PREFERENCE_OPTIONS = [
  'auto',
  'hogaplay_first',
  'kis_api_first',
  'screener_daily_first',
] as const satisfies readonly CandleDataPreference[];

const STORAGE_KEY = 'chart.candleDataPreference.v1';

const LABEL: Record<CandleDataPreference, string> = {
  auto: '자동',
  hogaplay_first: 'hogaplay 우선',
  kis_api_first: 'KIS API 우선',
  screener_daily_first: '스크리너 일봉 우선',
};

export function getCandleDataPreferenceLabel(value: CandleDataPreference): string {
  return LABEL[value];
}

interface Store {
  candleDataPreference: CandleDataPreference;
  setCandleDataPreference: (value: CandleDataPreference) => void;
  hydrateFromStorage: () => void;
}

function readStorage(): { candleDataPreference: CandleDataPreference } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { candleDataPreference: string };
    if (CANDLE_DATA_PREFERENCE_OPTIONS.includes(parsed.candleDataPreference as CandleDataPreference)) {
      return { candleDataPreference: parsed.candleDataPreference as CandleDataPreference };
    }
    return null;
  } catch {
    return null;
  }
}

function persist(value: CandleDataPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ candleDataPreference: value }));
  } catch {
    // localStorage may be unavailable — silent fallback.
  }
}

export const useCandleDataPreferenceStore = create<Store>((set) => ({
  candleDataPreference: readStorage()?.candleDataPreference ?? 'auto',

  setCandleDataPreference: (value) => {
    if (!CANDLE_DATA_PREFERENCE_OPTIONS.includes(value)) return;
    set({ candleDataPreference: value });
    persist(value);
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ candleDataPreference: stored.candleDataPreference });
  },
}));
