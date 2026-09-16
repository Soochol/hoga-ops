import { create } from 'zustand';

export type ProgramTradeSide = 'net' | 'buy' | 'sell';
export type ProgramTradeMeasure = 'amount' | 'qty';

const STORAGE_KEY = 'live.programTradeDisplay.v1';

type Persisted = {
  side: ProgramTradeSide;
  measure: ProgramTradeMeasure;
};

interface Store extends Persisted {
  setSide: (side: ProgramTradeSide) => void;
  setMeasure: (measure: ProgramTradeMeasure) => void;
}

function isSide(value: unknown): value is ProgramTradeSide {
  return value === 'net' || value === 'buy' || value === 'sell';
}

function isMeasure(value: unknown): value is ProgramTradeMeasure {
  return value === 'amount' || value === 'qty';
}

function readStorage(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { side: 'net', measure: 'amount' };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      side: isSide(parsed.side) ? parsed.side : 'net',
      measure: isMeasure(parsed.measure) ? parsed.measure : 'amount',
    };
  } catch {
    return { side: 'net', measure: 'amount' };
  }
}

function persist(value: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable — keep the in-memory preference.
  }
}

export const useProgramTradeDisplayStore = create<Store>((set, get) => ({
  ...readStorage(),
  setSide: (side) => {
    if (!isSide(side)) return;
    set({ side });
    persist({ side, measure: get().measure });
  },
  setMeasure: (measure) => {
    if (!isMeasure(measure)) return;
    set({ measure });
    persist({ side: get().side, measure });
  },
}));
