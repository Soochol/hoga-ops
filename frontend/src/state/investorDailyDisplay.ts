import { create } from 'zustand';
import type { InvestorTradeSide } from '../api/types';

export type InvestorDailyCompactDisplay = 'all' | InvestorTradeSide;

const STORAGE_KEY = 'live.investorDailyDisplay.v1';

type Persisted = {
  compactDisplay: InvestorDailyCompactDisplay;
  selectedTradeSide: InvestorTradeSide;
  useK: boolean;
  showDetails: boolean;
  followCursor: boolean;
};

interface Store extends Persisted {
  setCompactDisplay: (value: InvestorDailyCompactDisplay) => void;
  setSelectedTradeSide: (value: InvestorTradeSide) => void;
  setUseK: (value: boolean) => void;
  setShowDetails: (value: boolean) => void;
  setFollowCursor: (value: boolean) => void;
}

const DEFAULTS: Persisted = {
  compactDisplay: 'all',
  selectedTradeSide: 'net',
  useK: true,
  showDetails: false,
  followCursor: true,
};

function isTradeSide(value: unknown): value is InvestorTradeSide {
  return value === 'net' || value === 'buy' || value === 'sell';
}

function isCompactDisplay(value: unknown): value is InvestorDailyCompactDisplay {
  return value === 'all' || isTradeSide(value);
}

function readStorage(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      compactDisplay: isCompactDisplay(parsed.compactDisplay) ? parsed.compactDisplay : DEFAULTS.compactDisplay,
      selectedTradeSide: isTradeSide(parsed.selectedTradeSide) ? parsed.selectedTradeSide : DEFAULTS.selectedTradeSide,
      useK: typeof parsed.useK === 'boolean' ? parsed.useK : DEFAULTS.useK,
      showDetails: typeof parsed.showDetails === 'boolean' ? parsed.showDetails : DEFAULTS.showDetails,
      followCursor: typeof parsed.followCursor === 'boolean' ? parsed.followCursor : DEFAULTS.followCursor,
    };
  } catch {
    return DEFAULTS;
  }
}

function persisted(state: Store): Persisted {
  return {
    compactDisplay: state.compactDisplay,
    selectedTradeSide: state.selectedTradeSide,
    useK: state.useK,
    showDetails: state.showDetails,
    followCursor: state.followCursor,
  };
}

function persist(value: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable — keep the in-memory preference.
  }
}

export const useInvestorDailyDisplayStore = create<Store>((set, get) => {
  const update = (partial: Partial<Persisted>) => {
    set(partial);
    persist(persisted(get()));
  };
  return {
    ...readStorage(),
    setCompactDisplay: (value) => { if (isCompactDisplay(value)) update({ compactDisplay: value }); },
    setSelectedTradeSide: (value) => { if (isTradeSide(value)) update({ selectedTradeSide: value }); },
    setUseK: (value) => { if (typeof value === 'boolean') update({ useK: value }); },
    setShowDetails: (value) => { if (typeof value === 'boolean') update({ showDetails: value }); },
    setFollowCursor: (value) => { if (typeof value === 'boolean') update({ followCursor: value }); },
  };
});
