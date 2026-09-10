import type { CSSProperties } from 'react';
import { formatMarketDate, fmtSigned } from './marketFormat';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import { priceDirClass } from '../ui/priceDir';

type DailyRow = { date: string; values: (number | null)[] };

/** The scroll viewport keeps the header and period totals visible in both cards. */
export function DailyNetList({ label, columns, rows, compact = false, todayProvisional = false }: {
  label: string; columns: string[]; rows: DailyRow[]; compact?: boolean; todayProvisional?: boolean;
}) {
  const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date));
  const today = todayKstYyyymmdd();
  const totals = columns.map((_, i) => rows.length && rows.every(row => row.values[i] != null && Number.isFinite(row.values[i]))
    ? rows.reduce((sum, row) => sum + row.values[i]!, 0) : null);
  const cell = (value: number | null | undefined) => <span className={value == null || !Number.isFinite(value) ? 'text-fg-dim' : priceDirClass(value)}>
    {value == null || !Number.isFinite(value) ? '—' : fmtSigned(value)}
  </span>;
  return <div className={`daily-net-list ${compact ? 'daily-net-list-compact' : ''}`} tabIndex={0}
    role="region" aria-label={`${label} 목록 스크롤`}>
    <div role="table" aria-label={`${label} · 단위 억원`} className="font-data text-sm tabular-nums"
      style={{ '--daily-columns': `minmax(4.5rem, 1fr) repeat(${columns.length}, minmax(0, 1fr))` } as CSSProperties}>
      <div role="rowgroup" className="daily-net-heading">
        <div role="row" className="daily-net-row text-2xs text-fg-dim">
          <span role="columnheader">날짜</span>
          {columns.map(name => <span key={name} role="columnheader" className="text-right">{name}</span>)}
        </div>
      </div>
      <div role="rowgroup" className="daily-net-rows">
        {sorted.map(row => <div role="row" key={row.date} className="daily-net-row">
          <span role="rowheader" className="text-fg-dim">
            {formatMarketDate(row.date)}{todayProvisional && row.date.slice(0, 8) === today && <span className="ml-2xs text-2xs">잠정</span>}
          </span>
          {columns.map((name, i) => <span role="cell" key={name} className="text-right">{cell(row.values[i])}</span>)}
        </div>)}
      </div>
      <div role="rowgroup" className="daily-net-total">
        <div role="row" className="daily-net-row">
          <span role="rowheader" className="text-xs text-fg-dim">기간 합계</span>
          {totals.map((value, i) => <span role="cell" key={columns[i]} className="text-right font-semibold"
            title={value == null ? '누락된 값이 있어 기간 합계를 계산하지 않았습니다.' : undefined}>{cell(value)}</span>)}
        </div>
      </div>
    </div>
  </div>;
}
