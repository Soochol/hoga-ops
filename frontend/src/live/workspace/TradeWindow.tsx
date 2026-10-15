import { useMemo, useState } from 'react';
import { useLiveSeries } from '../../api/liveSeries';
import { useTradeHistory } from '../../api/tradeHistory';
import { useConnectionLiveness } from '../../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../../api/liveness';
import TradeTickTable from '../../sidebar/TradeTickTable';
import { useLiveVenueStore, type LiveVenueOption } from '../../state/liveVenue';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { realMsToYyyymmdd } from '../liveDateTime';
import { useKstDay } from '../../util/useKstDay';
import { buildTradeTickView, combineTradeHistory, mergeTradeTicks } from '../tradeTicks';
import { useEffectiveVenue } from '../useEffectiveVenue';
import { useTapeScroll } from './useTapeScroll';

export function TradeWindow({ code }: { code: string }) {
  const selected = useLiveVenueStore(s => s.venue);
  const venue = useEffectiveVenue(code, selected);
  const date = useKstDay();
  return <TradeContent key={`${code}:${venue}:${date}`} code={code} venue={venue} date={date} />;
}

function TradeContent({ code, venue, date }: { code: string; venue: LiveVenueOption; date: string }) {
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
  const { scroll, end, ticks, onScroll, onWheel, failed } = useTapeScroll(all, history);
  const view = { ticks, prevClose: liveView.prevClose ?? latest?.prev_close ?? null };
  const highlightEnabled = useChartPrefsStore(s => s.tradeHighlightEnabled);
  const thresholdManwon = useChartPrefsStore(s => s.tradeHighlightThresholdManwon);
  const highlightColor = useChartPrefsStore(s => s.tradeHighlightColor);
  const highlight = useMemo(() => highlightEnabled
    ? { thresholdWon: thresholdManwon * 10_000, color: highlightColor } : null,
  [highlightEnabled, thresholdManwon, highlightColor]);
  return <div data-testid="trade-window" className="flex h-full flex-col bg-bg-card">
    <div ref={scroll} aria-label="체결 목록" className="min-h-0 flex-1 overflow-auto" onScroll={onScroll} onWheel={onWheel}>
      <TradeTickTable view={view} highlight={highlight} emptyText={connected ? '최근 수신 체결 없음 · 새 체결 수신 대기' : '실시간 연결 확인 중 · 체결 수신 대기'} />
      {history.isFetching && <div role="status" className="px-2.5 py-1 text-xs text-fg-dim">이전 내역 조회 중…</div>}
      {failed && <button type="button" className="ui-choice m-1" onClick={() => {
        void (history.isFetchNextPageError ? history.fetchNextPage({ cancelRefetch: false }) : history.refetch());
      }}>이전 내역 조회 실패 · 재시도</button>}
      <div ref={end} aria-hidden className="h-px" />
    </div>
  </div>;
}
