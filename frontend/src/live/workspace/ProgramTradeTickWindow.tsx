import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLiveSeries } from '../../api/liveSeries';
import { useConnectionLiveness } from '../../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../../api/liveness';
import { SidebarState } from '../../sidebar/SidebarSurface';
import { useLiveVenueStore } from '../../state/liveVenue';
import { priceDirClass } from '../../ui/priceDir';
import { unixMsToKSTClock } from '../../util/time';
import { useKstDay } from '../../util/useKstDay';
import { buildProgramTradeTicks, combineProgramTradeHistory, mergeProgramTradeTicks } from '../programTradeTicks';
import { useProgramTradeHistory } from '../../api/programTradeTicks';
import { useEffectiveVenue } from '../useEffectiveVenue';
import type { LiveVenueOption } from '../../state/liveVenue';

const COLS = 'grid-cols-[auto_1fr_1fr]';

/** Live program tape with earlier captured events; no chart link required. */
export function ProgramTradeTickWindow({ code }: { code: string }) {
  const venue = useLiveVenueStore(s => s.venue);
  const date = useKstDay();
  const effective = useEffectiveVenue(code, venue);
  return <ProgramTradeTickContent key={`${code}:${effective}:${date}`} code={code} venue={effective} date={date} />;
}

function ProgramTradeTickContent({ code, venue, date }: { code: string; venue: LiveVenueOption; date: string }) {
  const connected = useConnectionLiveness(LIVE_STALE_MS);
  const live = useLiveSeries(code, venue);
  const history = useProgramTradeHistory(code, date, venue);
  const liveTicks = useMemo(() => buildProgramTradeTicks(live.program, date, Infinity), [live.program, date]);
  const [remembered, setRemembered] = useState(liveTicks);
  // Keep already observed events when the shared 15-minute buffer evicts them.
  const observed = useMemo(() => mergeProgramTradeTicks(liveTicks, remembered), [liveTicks, remembered]);
  if (observed.length !== remembered.length || observed.some((tick, i) => tick.key !== remembered[i].key
    || tick.price !== remembered[i].price || tick.deltaQty !== remembered[i].deltaQty)) setRemembered(observed);
  const archive = useMemo(() => buildProgramTradeTicks(
    (history.data?.pages.flatMap(page => page.rows.map(row => ({ ...row }))) ?? []).slice().reverse(), date, Infinity,
  ), [history.data, date]);
  const latestAtMs = history.data?.pages[0]?.latest_at_ms ?? null;
  const all = useMemo(() => combineProgramTradeHistory(observed, archive, latestAtMs), [observed, archive, latestAtMs]);
  const [visible, setVisible] = useState(200);
  const ticks = all.slice(0, visible);
  const scroll = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const hasMore = all.length > visible || !!history.hasNextPage;
  const failed = history.isError || history.isFetchNextPageError;
  const { hasNextPage, isFetching, fetchNextPage } = history;
  const loadMore = useCallback(async () => {
    if (all.length > visible) { setVisible(visible + 200); return; }
    if (!hasNextPage || isFetching || failed || loading.current) return;
    loading.current = true;
    try {
      const result = await fetchNextPage({ cancelRefetch: false });
      if (!result.isError) setVisible(n => n + 200);
    } finally { loading.current = false; }
  }, [all.length, visible, hasNextPage, isFetching, fetchNextPage, failed]);
  const captureAnchor = () => {
    const root = scroll.current;
    if (!root || root.scrollTop === 0) { anchor.current = null; return; }
    const top = root.getBoundingClientRect().top;
    const header = root.querySelector('[role="columnheader"]')?.parentElement?.getBoundingClientRect().height ?? 0;
    for (const row of root.querySelectorAll<HTMLElement>('[data-program-event]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top + header) {
        anchor.current = { key: row.dataset.programEvent!, offset: rect.top - top }; return;
      }
    }
  };
  useLayoutEffect(() => {
    const root = scroll.current;
    const saved = anchor.current;
    if (!root || !saved) return;
    const row = [...root.querySelectorAll<HTMLElement>('[data-program-event]')].find(el => el.dataset.programEvent === saved.key);
    if (row) root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.offset;
  }, [all, visible]);
  useEffect(() => {
    if (!hasMore || failed || !end.current || !scroll.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: scroll.current, rootMargin: '0px 0px 80px 0px' });
    observer.observe(end.current);
    return () => observer.disconnect();
  }, [hasMore, failed, loadMore]);
  return <div data-testid="program-trade-window" className="flex h-full flex-col bg-bg-card">
    <div ref={scroll} aria-label="프로그램 체결 목록" className="min-h-0 flex-1 overflow-auto font-data text-sm tabular-nums"
      onScroll={() => { captureAnchor(); const el = scroll.current!; if (el.scrollHeight - el.clientHeight - el.scrollTop < 80) void loadMore(); }}
      onWheel={event => { const el = scroll.current!; if (event.deltaY > 0 && el.scrollHeight - el.clientHeight - el.scrollTop < 80) void loadMore(); }}>
      {ticks.length === 0 ? <SidebarState>
        {connected ? '최근 수신 프로그램 증감 없음 · 새 수신 대기' : '실시간 연결 확인 중 · 프로그램 수신 대기'}
      </SidebarState> : <div role="table" aria-label="프로그램 체결 내역">
        <div role="row" className={`sticky top-0 z-10 grid ${COLS} gap-2 bg-bg-subtle px-2.5 py-1 text-2xs text-fg-dim`}>
          <span role="columnheader" title="과거 내역은 키움 제공 시각, 실시간 내역은 수신 시각">시간</span>
          <span role="columnheader" className="text-right">현재가(원)</span>
          <span role="columnheader" className="text-right">순매수 증감(주)</span>
        </div>
        {ticks.map(tick => <div role="row" key={tick.key} data-program-event={tick.key} className={`grid ${COLS} gap-2 px-2.5 py-0.5`}>
          <span role="cell" className="text-fg-dim">{unixMsToKSTClock(tick.tMs)}</span>
          <span role="cell" className="text-right">{tick.price?.toLocaleString('ko-KR') ?? '—'}</span>
          <span role="cell" className={`text-right ${priceDirClass(tick.deltaQty)}`}>
            {tick.deltaQty > 0 ? '+' : '−'}{Math.abs(tick.deltaQty).toLocaleString('ko-KR')}
          </span>
        </div>)}
      </div>}
      {history.isFetching && <div role="status" className="px-2.5 py-1 text-xs text-fg-dim">이전 내역 조회 중…</div>}
      {failed && <button type="button" className="ui-choice m-1" onClick={() => {
        void (history.isFetchNextPageError ? history.fetchNextPage({ cancelRefetch: false }) : history.refetch());
      }}>이전 내역 조회 실패 · 재시도</button>}
      <div ref={end} aria-hidden className="h-px" />
    </div>
  </div>;
}
