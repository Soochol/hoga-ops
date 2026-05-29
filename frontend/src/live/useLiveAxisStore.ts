import { create } from 'zustand';
import type { VirtualAxis } from '../util/virtualAxis';

interface State {
  axis: VirtualAxis | null;
  setAxis: (axis: VirtualAxis | null) => void;
}

/**
 * The /live VirtualAxis lives in LiveChartRoot. LiveSidebar borrows it
 * to evaluate axis.inClosingAuctionWindow(cursorMs) for TotalQtyBar's
 * Auction Mask. Stored as a ref-style singleton — the chart re-publishes
 * on segment changes (memoised in LiveChartRoot).
 */
export const useLiveAxisStore = create<State>((set, get) => ({
  axis: null,
  setAxis: (axis) => {
    if (get().axis === axis) return;
    set({ axis });
  },
}));
