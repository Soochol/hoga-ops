import { createPortal } from 'react-dom';
import { useMemo } from 'react';
import type { ScreenerRow } from '../api/screener';
import { ModalShell } from '../ui/ModalShell';
import { OccurrenceAction, OccurrenceLabel } from './OccurrenceExclusions';
import type { OccurrenceExclusions } from './useOccurrenceExclusions';

/** The rail navigates stocks; dates and per-occurrence actions live here. */
export function ScreenerOccurrenceDetails({ row, controller, onClose }: {
  row?: ScreenerRow;
  controller: OccurrenceExclusions;
  onClose: () => void;
}) {
  const events = useMemo(() => [...(row?.occurrences ?? [])].sort((a, b) =>
    b.date.localeCompare(a.date) || a.condition_id.localeCompare(b.condition_id)), [row?.occurrences]);
  return createPortal(<ModalShell title={`${row?.name ?? '검색 결과'} 발생 건`}
    ariaLabel={`${row?.name ?? '검색 결과'} 발생 건`} onClose={onClose} height="max-h-[80vh]">
    <div className="p-md border-b border-border text-xs text-fg-dim">
      발생 {events.length}건 · 선택한 조건·종목·날짜 한 건만 제외합니다.
      {controller.busy && <p role="status">저장·결과 갱신 중…</p>}
      {controller.error && <p role="alert" className="text-error">{controller.error}</p>}
    </div>
    <div className="min-h-0 overflow-y-auto p-md">
      {row && events.length ? <ul className="divide-y divide-border">
        {events.map(event => <li key={`${row.code}:${event.condition_id}:${event.condition_key}:${event.date}`} className="flex items-center gap-sm py-sm">
          <div className="min-w-0 flex-1">
            <div className="font-data text-sm">{event.date}</div>
            <OccurrenceLabel occurrence={event} controller={controller} />
          </div>
          <OccurrenceAction code={row.code} name={row.name} occurrence={event} controller={controller} />
        </li>)}
      </ul> : <p className="text-sm text-fg-dim">현재 검색 결과에 남은 발생 건이 없습니다.</p>}
    </div>
  </ModalShell>, document.body);
}
