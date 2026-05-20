import { create } from 'zustand';

/**
 * Visible time range, in Unix milliseconds (the app-wide convention).
 *
 * ChartStage publishes here whenever lightweight-charts emits a
 * `visibleTimeRangeChange`. Sibling components (PriceStrip in Task 6.5,
 * potentially others later) subscribe without prop-drilling through
 * ReplayViewer.
 */
type Viewport = {
  fromMs: number | null;
  toMs: number | null;
  set: (fromMs: number | null, toMs: number | null) => void;
  reset: () => void;
};

export const useViewportStore = create<Viewport>((set) => ({
  fromMs: null,
  toMs: null,
  set: (fromMs, toMs) => set({ fromMs, toMs }),
  reset: () => set({ fromMs: null, toMs: null }),
}));
