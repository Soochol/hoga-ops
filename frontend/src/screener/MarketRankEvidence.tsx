import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ScreenerRow } from '../api/screener';
import { ModalShell } from '../ui/ModalShell';
import { BarMatchEvidence } from './BarMatchEvidence';

/** The rank remains the scan observation even while live prices change. */
export function MarketRankEvidence({ row }: { row: Pick<ScreenerRow, 'name' | 'occurrences'> }) {
  const [open, setOpen] = useState<string | null>(null);
  const items = [
    { label: '거래대금', event: row.occurrences?.find(item => item.trade_value_rank_match) },
    { label: '등락률', event: row.occurrences?.find(item => item.change_pct_rank_match) },
  ];
  const selected = items.find(item => item.label === open);
  if (!items.some(item => item.event)) return null;
  return <span onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    {items.map(({ event, label }) => {
      const rank = event?.trade_value_rank_match ?? event?.change_pct_rank_match;
      return rank ? <button key={label} type="button" aria-label={`${row.name} ${label} 순위 근거`}
        onClick={() => setOpen(label)}
        className="block border-0 bg-transparent p-0 text-2xs text-fg-dim hover:text-fg">
        {label} {rank.rank}위
      </button> : null;
    })}
    {selected?.event && createPortal(<ModalShell title={`${row.name} ${selected.label} 순위 근거`}
      ariaLabel={`${row.name} ${selected.label} 순위 근거`} onClose={() => setOpen(null)}>
      <div className="p-md"><BarMatchEvidence event={selected.event} /></div>
    </ModalShell>, document.body)}
  </span>;
}
