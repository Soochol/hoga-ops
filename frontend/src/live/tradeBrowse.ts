import { create } from 'zustand';
import { useLiveCursorStore, type SidebarCursorOrigin } from './useLiveCursorStore';
import { useWorkspaceStore, windowSymbolOf } from '../state/workspace';
import { useLiveVenueStore, type LiveVenueOption } from '../state/liveVenue';
import { tradeSpotScope, type TradeSpotScope } from './tradeSpotScope';

export interface TradeBrowseSession {
  ownerId: string;
  origin: SidebarCursorOrigin;
  seed: TradeSpotScope;
  cursorMs: number;
  browsing: boolean;
  selectedVenue: LiveVenueOption;
  sourcePref: string;
  minAmountManwon: number;
}
interface Candidate { cursorMs: number; origin: SidebarCursorOrigin; observedAt: number }
interface State {
  candidate: Candidate | null;
  session: TradeBrowseSession | null;
  begin: (ownerId: string, code: string, group: number, venue: LiveVenueOption, pref: string, amount: number) => void;
  move: (ownerId: string, scope: TradeSpotScope) => void;
  leave: (ownerId: string) => void;
  end: (ownerId?: string) => void;
  clearChart: (chartId: string) => void;
}

/** Chart hover and tape browsing have different lifetimes. Never persist either. */
export const useTradeBrowseStore = create<State>((set, get) => ({
  candidate: null, session: null,
  begin: (ownerId, code, group, venue, pref, amount) => {
    const { candidate, session } = get();
    if (session?.ownerId === ownerId || !candidate || Date.now() - candidate.observedAt > 2000) return;
    const scope = tradeSpotScope(candidate.cursorMs, candidate.origin, code, group, venue);
    const workspace = useWorkspaceStore.getState();
    const chart = workspace.windows.find(w => w.id === candidate.origin.windowId);
    const owner = workspace.windows.find(w => w.id === ownerId);
    if (!scope || !chart || owner?.kind !== 'trade' || owner.group !== group
        || windowSymbolOf(workspace, owner)?.code !== code || chart.chart?.hoverLinked === false || chart.group !== group
        || chart.chart?.timeframe !== candidate.origin.timeframe
        || (chart.chart?.regularSessionOnly ?? false) !== (candidate.origin.regularSessionOnly ?? false)
        || windowSymbolOf(useWorkspaceStore.getState(), chart)?.code !== code) return;
    set({ session: { ownerId, origin: candidate.origin, seed: scope, cursorMs: scope.fromMs,
      browsing: false, selectedVenue: venue, sourcePref: pref, minAmountManwon: amount } });
  },
  move: (ownerId, scope) => {
    const session = get().session;
    if (!session || session.ownerId !== ownerId) return;
    if (session.browsing && session.cursorMs === scope.fromMs) return;
    set({ candidate: null, session: { ...session, cursorMs: scope.fromMs, browsing: true,
      origin: { ...session.origin, barStartMs: scope.fromMs } } });
  },
  leave: ownerId => {
    const session = get().session;
    if (session?.ownerId === ownerId && !session.browsing) set({ session: null });
  },
  end: ownerId => {
    if (ownerId !== undefined && get().session?.ownerId !== ownerId) return;
    set({ session: null, candidate: null });
  },
  clearChart: chartId => {
    const { session, candidate } = get();
    if (session?.origin.windowId === chartId) set({ session: null });
    if (candidate?.origin.windowId === chartId) set({ candidate: null });
  },
}));

useLiveCursorStore.subscribe((state, previous) => {
  if (state.sidebarCursorMs === null || state.sidebarCursorOrigin === null) return;
  if (state.sidebarCursorMs === previous.sidebarCursorMs && state.sidebarCursorOrigin === previous.sidebarCursorOrigin) return;
  // Only the chart publication path writes this channel. Synthetic draws are gated there.
  useTradeBrowseStore.setState({ session: null, candidate: { cursorMs: state.sidebarCursorMs,
    origin: state.sidebarCursorOrigin, observedAt: Date.now() } });
});

useWorkspaceStore.subscribe(state => {
  const session = useTradeBrowseStore.getState().session;
  if (!session) return;
  const source = state.windows.find(w => w.id === session.origin.windowId);
  const owner = state.windows.find(w => w.id === session.ownerId);
  if (!source || !owner || source.group !== session.origin.group || owner.group !== session.origin.group
      || source.chart?.hoverLinked === false || source.chart?.timeframe !== session.origin.timeframe
      || (source.chart?.regularSessionOnly ?? false) !== (session.origin.regularSessionOnly ?? false)
      || windowSymbolOf(state, source)?.code !== session.origin.code || windowSymbolOf(state, owner)?.code !== session.origin.code) {
    useTradeBrowseStore.getState().end();
  }
});
useLiveVenueStore.subscribe((state, previous) => {
  if (state.venue !== previous.venue) useTradeBrowseStore.getState().end();
});

if (import.meta.env.DEV) (window as unknown as { __tradeBrowseStore: unknown }).__tradeBrowseStore = useTradeBrowseStore;
