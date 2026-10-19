import { useMemo, useState } from 'react';
import { useLiveSeries } from '../../api/liveSeries';
import { useConnectionLiveness } from '../../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../../api/liveness';
import { ProgramTradeTickTable } from '../../sidebar/ProgramTradeTickTable';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useKstDay } from '../../util/useKstDay';
import { buildProgramTradeTicks, combineProgramTradeHistory, mergeProgramTradeTicks } from '../programTradeTicks';
import { useProgramTradeHistory } from '../../api/programTradeTicks';
import { useEffectiveVenue } from '../useEffectiveVenue';
import { useTapeScroll } from './useTapeScroll';
import type { LiveVenueOption } from '../../state/liveVenue';

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
  const { scroll, end, ticks, onScroll, onWheel, failed } = useTapeScroll(all, history);
  return <div data-testid="program-trade-window" className="flex h-full flex-col bg-bg-card [container:trade-tape/inline-size]">
    <div ref={scroll} aria-label="프로그램 체결 목록" className="min-h-0 flex-1 overflow-auto font-data text-sm tabular-nums"
      onScroll={onScroll}
      onWheel={onWheel}>
      <ProgramTradeTickTable ticks={ticks} emptyText={connected
        ? '최근 수신 프로그램 증감 없음 · 새 수신 대기' : '실시간 연결 확인 중 · 프로그램 수신 대기'} />
      {history.isFetching && <div role="status" className="px-2.5 py-1 text-xs text-fg-dim">이전 내역 조회 중…</div>}
      {failed && <button type="button" className="ui-choice m-1" onClick={() => {
        void (history.isFetchNextPageError ? history.fetchNextPage({ cancelRefetch: false }) : history.refetch());
      }}>이전 내역 조회 실패 · 재시도</button>}
      <div ref={end} aria-hidden className="h-px" />
    </div>
  </div>;
}
