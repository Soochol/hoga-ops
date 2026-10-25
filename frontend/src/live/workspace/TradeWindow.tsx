import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveSeries } from '../../api/liveSeries';
import { useTradeHistory } from '../../api/tradeHistory';
import { useConnectionLiveness } from '../../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../../api/liveness';
import TradeTickTable from '../../sidebar/TradeTickTable';
import { useLiveVenueStore, type LiveVenueOption } from '../../state/liveVenue';
import { useTradeHighlight } from '../tradeHighlight';
import { realMsToYyyymmdd } from '../liveDateTime';
import { useKstDay } from '../../util/useKstDay';
import { buildTradeTickView, combineTradeHistory, mergeTradeTicks } from '../tradeTicks';
import { useEffectiveVenue } from '../useEffectiveVenue';
import { useTapeScroll } from './useTapeScroll';
import { formatTradeMinAmount } from '../../state/tradeWindowSettings';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { tradeSpotScope } from '../tradeSpotScope';
import { TradeSpotContent } from './TradeSpotContent';
import { useTradeBrowseStore } from '../tradeBrowse';

export function TradeWindow({ code, group, windowId, minAmountManwon = 0, onClearFilter }: {
  code: string; group?: number; windowId?: string; minAmountManwon?: number; onClearFilter?: () => void;
}) {
  const selected = useLiveVenueStore(s => s.venue);
  const venue = useEffectiveVenue(code, selected);
  const date = useKstDay();
  const cursorMs = useLiveCursorStore(s => s.sidebarCursorOrigin?.group === group && s.sidebarCursorOrigin?.code === code ? s.sidebarCursorMs : null);
  const origin = useLiveCursorStore(s => s.sidebarCursorOrigin?.group === group && s.sidebarCursorOrigin?.code === code ? s.sidebarCursorOrigin : null);
  const session = useTradeBrowseStore(s => s.session !== null && s.session.ownerId === windowId && s.session.origin.code === code
    && s.session.origin.group === group ? s.session : null);
  const pref = useRef<string | null>(null);
  const ready = useCallback((value: string) => { pref.current = value; }, []);
  useEffect(() => () => { if (windowId) useTradeBrowseStore.getState().end(windowId); }, [windowId, code, group]);
  const scope = session?.seed ?? tradeSpotScope(cursorMs, origin, code, group, venue);
  return <div className="h-full min-h-0" onPointerEnter={() => {
    if (windowId && group !== undefined && pref.current !== null) {
      useTradeBrowseStore.getState().begin(windowId, code, group, selected, pref.current, minAmountManwon);
    }
  }} onPointerLeave={() => { if (windowId) useTradeBrowseStore.getState().leave(windowId); }}>
    {scope ? <TradeSpotContent key={`${code}:${scope.venue}:${scope.fromMs}:${scope.toMs}`} code={code} scope={scope}
      minAmountManwon={minAmountManwon} session={session} onHandoffReady={ready} />
      : <TradeContent key={`${code}:${venue}:${date}`} code={code} venue={venue} date={date}
        minAmountManwon={minAmountManwon} onClearFilter={onClearFilter} />}
  </div>;
}

function TradeContent({ code, venue, date, minAmountManwon, onClearFilter }: {
  code: string; venue: LiveVenueOption; date: string; minAmountManwon: number; onClearFilter?: () => void;
}) {
  const connected = useConnectionLiveness(LIVE_STALE_MS);
  const live = useLiveSeries(code, venue);
  const history = useTradeHistory(code, date, venue);
  const liveView = useMemo(() => buildTradeTickView(live.trade, Infinity), [live.trade]);
  const todayTicks = useMemo(() => liveView.ticks.filter(tick => realMsToYyyymmdd(tick.tMs) === date), [liveView.ticks, date]);
  const [remembered, setRemembered] = useState(todayTicks);
  const observed = useMemo(() => mergeTradeTicks(todayTicks, remembered), [todayTicks, remembered]);
  if (observed.length !== remembered.length || observed.some((tick, i) => tick.key !== remembered[i].key
    || tick.price !== remembered[i].price || tick.qty !== remembered[i].qty || tick.side !== remembered[i].side)) setRemembered(observed);
  const past = useMemo(() => (history.data?.pages.flatMap(page => page.rows) ?? []).map(row => ({
    key: row.event_id, tMs: row.t_ms, price: row.price, qty: row.qty, side: row.side, cumVolume: row.cum_volume,
  })), [history.data]);
  const latest = history.data?.pages[0];
  const all = useMemo(() => combineTradeHistory(observed, past, latest?.latest_at_ms ?? null, latest?.latest_volume ?? null), [observed, past, latest]);
  // Filter before the 200-row display limit, so hidden small trades cannot mask older matches.
  const filtered = useMemo(() => minAmountManwon > 0
    ? all.filter(tick => tick.price * tick.qty >= minAmountManwon * 10_000) : all, [all, minAmountManwon]);
  // A sparse filter must not auto-drain the entire day's history to fill the viewport.
  // Scrolling/wheeling still requests the next page, including when no rows match.
  const { scroll, end, ticks, onScroll, onWheel, failed } = useTapeScroll(filtered, history,
    { resetKey: minAmountManwon, autoLoad: minAmountManwon === 0 });
  const view = { ticks, prevClose: liveView.prevClose ?? latest?.prev_close ?? null };
  const highlight = useTradeHighlight();
  return <div data-testid="trade-window" data-mode="latest" className="flex h-full flex-col bg-bg-card [container:trade-tape/inline-size]">
    <div ref={scroll} aria-label="체결 목록" className="min-h-0 flex-1 overflow-auto" onScroll={onScroll} onWheel={onWheel}>
      <TradeTickTable view={view} highlight={highlight} emptyText={!connected ? '실시간 연결 확인 중 · 체결 수신 대기'
        : minAmountManwon > 0 ? `${formatTradeMinAmount(minAmountManwon)} 이상 체결 없음 · 새 체결 수신 대기`
          : '최근 수신 체결 없음 · 새 체결 수신 대기'} />
      {minAmountManwon > 0 && ticks.length === 0 && onClearFilter && <div className="px-2.5 pb-2 text-center">
        <button type="button" className="ui-choice" onClick={onClearFilter}>전체 체결 보기</button>
      </div>}
      {history.isFetching && <div role="status" className="px-2.5 py-1 text-xs text-fg-dim">이전 내역 조회 중…</div>}
      {failed && <button type="button" className="ui-choice m-1" onClick={() => {
        void (history.isFetchNextPageError ? history.fetchNextPage({ cancelRefetch: false }) : history.refetch());
      }}>이전 내역 조회 실패 · 재시도</button>}
      <div ref={end} aria-hidden className="h-px" />
    </div>
  </div>;
}
