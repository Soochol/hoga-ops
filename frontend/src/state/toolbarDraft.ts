import { create } from 'zustand';
import type { Timeframe } from '../api/types';

export type Draft = {
  code: string | null;
  from: string | null;
  to: string | null;
  timeframe: Timeframe | null;
};

const EMPTY: Draft = { code: null, from: null, to: null, timeframe: '1m' };

type Store = {
  drafts: Record<string, Draft>;
  getDraft: (tabId: string) => Draft;
  setDraft: (tabId: string, draft: Partial<Draft>) => void;
  setStock: (tabId: string, code: string) => void;
  setDates: (tabId: string, from: string, to: string) => void;
  setTimeframe: (tabId: string, timeframe: Timeframe) => void;
  clearTab: (tabId: string) => void;
  reset: () => void;
};

/**
 * Toolbar draft state, keyed by tab id.
 *
 * Lives outside `useTabsStore` because draft != committed selection —
 * the user can tinker with stock/date/timeframe before pressing
 * "데이터 불러오기" to commit. OnboardingCard reads this so its step
 * indicator reacts to draft progress in real time (ISSUE-003).
 */
export const useToolbarDraftStore = create<Store>((set, get) => ({
  drafts: {},
  getDraft: (tabId) => get().drafts[tabId] ?? EMPTY,
  setDraft: (tabId, draft) =>
    set((s) => ({
      drafts: { ...s.drafts, [tabId]: { ...EMPTY, ...s.drafts[tabId], ...draft } },
    })),
  setStock: (tabId, code) =>
    set((s) => {
      const cur = s.drafts[tabId] ?? EMPTY;
      // Picking a new stock clears date range but preserves timeframe.
      return {
        drafts: {
          ...s.drafts,
          [tabId]: { code, from: null, to: null, timeframe: cur.timeframe ?? '1m' },
        },
      };
    }),
  setDates: (tabId, from, to) =>
    set((s) => {
      const cur = s.drafts[tabId] ?? EMPTY;
      return { drafts: { ...s.drafts, [tabId]: { ...cur, from, to } } };
    }),
  setTimeframe: (tabId, timeframe) =>
    set((s) => {
      const cur = s.drafts[tabId] ?? EMPTY;
      return { drafts: { ...s.drafts, [tabId]: { ...cur, timeframe } } };
    }),
  clearTab: (tabId) =>
    set((s) => {
      const next = { ...s.drafts };
      delete next[tabId];
      return { drafts: next };
    }),
  reset: () => set({ drafts: {} }),
}));
