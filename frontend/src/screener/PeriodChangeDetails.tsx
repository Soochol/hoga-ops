import { useMemo, useState } from 'react';
import type { ScreenerRow } from '../api/screener';
import { ScreenerOccurrenceDetails } from './ScreenerOccurrenceDetails';
import type { OccurrenceExclusions } from './useOccurrenceExclusions';

/** Keep the drawer's row callbacks stable; one modal follows the latest scan. */
export function usePeriodChangeDetails(rows: ScreenerRow[], controller?: OccurrenceExclusions) {
  const [code, setCode] = useState<string | null>(null);
  const conditionIds = useMemo(() => new Set(controller?.conditions
    .filter(c => c.type === 'change_pct_period').map(c => c.id) ?? []), [controller?.conditions]);
  const row = code ? rows.find(r => r.code === code) : undefined;
  return { conditionIds, onOpen: setCode,
    modal: code && controller ? <ScreenerOccurrenceDetails controller={controller} onClose={() => setCode(null)}
      row={row ? { ...row, occurrences: row.occurrences?.filter(e => conditionIds.has(e.condition_id)) } : undefined} /> : null,
  };
}

export interface PeriodChangeDetailsProps {
  periodConditionIds?: ReadonlySet<string>;
  onPeriodDetails?: (code: string) => void;
}

export function PeriodChangeButton({ row, periodConditionIds, onPeriodDetails }: PeriodChangeDetailsProps & { row: Pick<ScreenerRow, 'code' | 'name' | 'occurrences'> }) {
  const count = row.occurrences?.filter(e => periodConditionIds?.has(e.condition_id)).length ?? 0;
  if (!count || !onPeriodDetails) return null;
  return <button type="button" className="block border-0 bg-transparent p-0 text-2xs text-fg-dim hover:text-fg"
    aria-label={`${row.name} 기간내 등락률 발생 ${count}건`} onPointerDown={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onPeriodDetails(row.code); }}>
    등락률 발생 {count}건
  </button>;
}
