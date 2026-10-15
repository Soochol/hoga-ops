import { useMemo } from 'react';
import { useLiveSeries } from '../../api/liveSeries';
import { useConnectionLiveness } from '../../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../../api/liveness';
import { SidebarState } from '../../sidebar/SidebarSurface';
import { useLiveVenueStore } from '../../state/liveVenue';
import { priceDirClass } from '../../ui/priceDir';
import { unixMsToKSTClock } from '../../util/time';
import { useKstDay } from '../../util/useKstDay';
import { buildProgramTradeTicks } from '../programTradeTicks';

const COLS = 'grid-cols-[auto_1fr_1fr]';

/** Latest-only tape from the shared program buffer; no chart link required. */
export function ProgramTradeTickWindow({ code }: { code: string }) {
  const connected = useConnectionLiveness(LIVE_STALE_MS);
  const venue = useLiveVenueStore(s => s.venue);
  const date = useKstDay();
  const live = useLiveSeries(code, venue);
  const ticks = useMemo(() => buildProgramTradeTicks(live.program, date), [live.program, date]);
  return <div data-testid="program-trade-window" className="flex h-full flex-col bg-bg-card">
    <div className="min-h-0 flex-1 overflow-auto font-data text-sm tabular-nums">
      {ticks.length === 0 ? <SidebarState>
        {connected ? '최근 수신 프로그램 증감 없음 · 새 수신 대기' : '실시간 연결 확인 중 · 프로그램 수신 대기'}
      </SidebarState> : <div role="table" aria-label="프로그램 체결 내역">
        <div role="row" className={`sticky top-0 z-10 grid ${COLS} gap-2 bg-bg-subtle px-2.5 py-1 text-2xs text-fg-dim`}>
          <span role="columnheader">수신시각</span>
          <span role="columnheader" className="text-right">현재가(원)</span>
          <span role="columnheader" className="text-right">순매수 증감(주)</span>
        </div>
        {ticks.map(tick => <div role="row" key={tick.key} className={`grid ${COLS} gap-2 px-2.5 py-0.5`}>
          <span role="cell" className="text-fg-dim">{unixMsToKSTClock(tick.tMs)}</span>
          <span role="cell" className="text-right">{tick.price?.toLocaleString('ko-KR') ?? '—'}</span>
          <span role="cell" className={`text-right ${priceDirClass(tick.deltaQty)}`}>
            {tick.deltaQty > 0 ? '+' : '−'}{Math.abs(tick.deltaQty).toLocaleString('ko-KR')}
          </span>
        </div>)}
      </div>}
    </div>
  </div>;
}
