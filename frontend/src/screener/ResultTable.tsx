import type { ScreenerRowLive } from './useScreenerRowsLive';
import { dispositionFromMouseEvent, type LiveOpenDisposition } from '../live/liveActivation';
import { ChangeCell } from './ChangeCell';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';

interface Props {
  /** Live Quote 가 이미 머지된 결과 행(useScreenerRowsLive). 표시만 하면 된다. */
  rows: ScreenerRowLive[];
  onActivate: (code: string, name?: string, options?: { disposition?: LiveOpenDisposition }) => void;
}

const COLS = 'grid-cols-[3.5rem_1fr_4rem_6rem_5rem_6rem_2.4rem]';
/** Won → 억 (100M), rounded to whole 억 for the table — matches the filter
 *  unit (거래대금 하한 is entered in 억). */
const toEok = (won: number) => Math.round(won / 1e8).toLocaleString('ko-KR');

export function ResultTable({ rows, onActivate }: Props) {
  return (
    <div className="min-w-0 bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-auto">
      <div className="min-w-[640px] flex min-h-full flex-col">
        <div className={`grid ${COLS} items-center gap-2 px-sm py-1 border-b text-xs font-semibold uppercase tracking-[0.06em] text-fg-dimmer`}>
          <span>코드</span><span>종목명</span><span>시장</span>
          <span className="text-right">현재가</span><span className="text-right">등락률</span>
          <span className="text-right">거래대금(억)</span><span className="text-right">액션</span>
        </div>
        <div className="flex-1 min-h-0">
          {rows.length === 0 ? (
            <div className="p-md text-fg-dim text-sm">조건에 맞는 종목이 없습니다.</div>
          ) : rows.map((r) => {
            const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(r.code, r.name); }
            };
            return (
              <div key={r.code} role="button" tabIndex={0} aria-label={`${r.name} ${r.code} 호가창 열기`}
                onClick={(e) => onActivate(r.code, r.name, { disposition: dispositionFromMouseEvent(e) })} onKeyDown={onKeyDown}
                className={`grid ${COLS} items-center gap-2 px-sm h-orderbook-row border-b text-sm text-fg cursor-pointer outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover`}>
                <span className="font-mono tabular-nums text-fg-dim">{r.code}</span>
                <span className="truncate">{r.name}</span>
                <span className="font-mono text-xs text-fg-dim">{r.market}</span>
                <span className="font-mono tabular-nums text-right">{r.price.toLocaleString('ko-KR')}</span>
                <span className="font-mono tabular-nums text-right"><ChangeCell pct={r.change_pct} /></span>
                <span className="font-mono tabular-nums text-right text-fg-dim">{toEok(r.trade_value_won)}</span>
                <span className="flex items-center justify-end gap-2">
                  <WatchlistHeartButton code={r.code} name={r.name} variant="row" />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
