import { create } from 'zustand';
import type { TimingSummary } from '../../api/types';

interface CaptureTimingsState {
  timings: Record<string, TimingSummary>; // key: `${code}:${date}`
  upsert: (id: string, summary: TimingSummary) => void;
  get: (id: string) => TimingSummary | undefined;
  clear: () => void;
}

export const useCaptureTimings = create<CaptureTimingsState>((set, get) => ({
  timings: {},
  upsert: (id, summary) => set((state) => ({
    timings: { ...state.timings, [id]: summary },
  })),
  get: (id) => get().timings[id],
  clear: () => set({ timings: {} }),
}));
