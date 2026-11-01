import { MA_CONDITION_TYPES } from './maLabels';
import { VOLUME_CONDITION_TYPES } from './volumeLabels';
import { useCallback, useMemo, useState } from 'react';
import type { ScreenerRow } from '../api/screener';
import { ScreenerOccurrenceDetails } from './ScreenerOccurrenceDetails';
import type { OccurrenceExclusions } from './useOccurrenceExclusions';

/** Keep the drawer's row callbacks stable; one modal follows the latest scan. */
type EvidenceKind = 'change' | 'compare' | 'ma' | 'volume';
const KINDS: EvidenceKind[] = ['change', 'compare', 'ma', 'volume'];
const LABELS = { change: '기간내 등락률', compare: '주가 비교', ma: '이동평균', volume: '거래량' };

export function usePriceOccurrenceDetails(rows: ScreenerRow[], controller?: OccurrenceExclusions) {
  const [selected, setSelected] = useState<{ code: string; kind: EvidenceKind } | null>(null);
  const conditionKinds = useMemo(() => {
    const kinds = new Map<string, EvidenceKind>();
    for (const c of controller?.conditions ?? []) {
      if (MA_CONDITION_TYPES.has(c.type)) kinds.set(c.id, 'ma');
      if (VOLUME_CONDITION_TYPES.has(c.type)) kinds.set(c.id, 'volume');
      if (c.type === 'change_pct_period') kinds.set(c.id, 'change');
      if (c.type === 'price_compare' || c.type === 'price_compare_period') kinds.set(c.id, 'compare');
    }
    return kinds;
  }, [controller?.conditions]);
  const onOpen = useCallback((code: string, kind: EvidenceKind) => setSelected({ code, kind }), []);
  const row = selected ? rows.find(r => r.code === selected.code) : undefined;
  return { conditionKinds, onOpen,
    modal: selected && controller ? <ScreenerOccurrenceDetails controller={controller} onClose={() => setSelected(null)}
      row={row ? { ...row, occurrences: row.occurrences?.filter(e => conditionKinds.get(e.condition_id) === selected.kind) } : undefined} /> : null,
  };
}

export interface PriceOccurrenceDetailsProps {
  occurrenceKinds?: ReadonlyMap<string, EvidenceKind>;
  onOccurrenceDetails?: (code: string, kind: EvidenceKind) => void;
}

export function PriceOccurrenceButtons({ row, occurrenceKinds, onOccurrenceDetails }: PriceOccurrenceDetailsProps & { row: Pick<ScreenerRow, 'code' | 'name' | 'occurrences'> }) {
  if (!onOccurrenceDetails) return null;
  const counts = { change: 0, compare: 0, ma: 0, volume: 0 };
  for (const event of row.occurrences ?? []) {
    const kind = occurrenceKinds?.get(event.condition_id);
    if (kind) counts[kind]++;
  }
  return <>{KINDS.map(kind => counts[kind] ? <button key={kind} type="button"
    className="block border-0 bg-transparent p-0 text-2xs text-fg-dim hover:text-fg"
    aria-label={`${row.name} ${LABELS[kind]} 발생 ${counts[kind]}건`} onPointerDown={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onOccurrenceDetails(row.code, kind); }}>
    {kind === 'change' ? '등락률' : LABELS[kind]} 발생 {counts[kind]}건
  </button> : null)}</>;
}
