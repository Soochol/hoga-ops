import { create } from 'zustand';

export type ProgramTradeMeasure = 'amount' | 'qty';

const STORAGE_KEY = 'live.programTradeDisplay.v1';

type Persisted = {
  measure: ProgramTradeMeasure;
};

interface Store extends Persisted {
  setMeasure: (measure: ProgramTradeMeasure) => void;
}

function isMeasure(value: unknown): value is ProgramTradeMeasure {
  return value === 'amount' || value === 'qty';
}

function readStorage(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { measure: 'amount' };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      measure: isMeasure(parsed.measure) ? parsed.measure : 'amount',
    };
  } catch {
    return { measure: 'amount' };
  }
}

function persist(value: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable — keep the in-memory preference.
  }
}

export const useProgramTradeDisplayStore = create<Store>((set) => ({
  ...readStorage(),
  setMeasure: (measure) => {
    if (!isMeasure(measure)) return;
    set({ measure });
    persist({ measure });
  },
}));
