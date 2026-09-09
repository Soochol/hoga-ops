import { useState } from 'react';
import type { ScreenerOccurrence } from '../api/screener';
import { CONDITION_CATALOG } from './catalog';
import type { OccurrenceExclusions } from './useOccurrenceExclusions';
import { ModalShell } from '../ui/ModalShell';
import { ToolbarButton } from '../ui/PageShell';

export function OccurrenceExclusionToolbar({ controller }: { controller: OccurrenceExclusions }) {
  const [open, setOpen] = useState(false);
  const { exclusions, busy, ready, error, lastExcluded, restore } = controller;
  return <div className="flex flex-wrap items-center gap-2 text-xs text-fg-dim">
    <ToolbarButton disabled={!ready} onClick={() => setOpen(true)}>제외한 발생 건 {exclusions.length}</ToolbarButton>
    {busy && <span role="status">저장·결과 갱신 중…</span>}
    {error && <span role="alert" style={{ color: 'var(--error)' }}>{error}</span>}
    {lastExcluded && exclusions.some(e => e.id === lastExcluded.id) && <span role="status">
      {lastExcluded.stock_name} · {lastExcluded.date} 발생 건 제외됨{' '}
      <ToolbarButton disabled={busy} onClick={() => restore(lastExcluded)}>되돌리기</ToolbarButton>
    </span>}
    {open && <ModalShell title="제외한 발생 건" ariaLabel="제외한 발생 건" onClose={() => setOpen(false)} width="w-[640px]">
      <div className="max-h-96 overflow-auto p-md text-sm">
        <p className="pb-sm text-fg-dim">모든 조건검색에서 공유합니다. 같은 조건의 같은 종목·날짜만 제외합니다.</p>
        {exclusions.length === 0 ? <p>제외한 발생 건이 없습니다.</p> : <ul className="space-y-2">
          {exclusions.map(entry => <li key={entry.id} className="flex items-center gap-2 border-b border-border py-sm">
            <div className="min-w-0 flex-1">
              <div>{entry.stock_name} · {entry.code} · {entry.date}</div>
              <div className="text-xs text-fg-dim">{CONDITION_CATALOG[entry.condition.type].label}{' '}
                {CONDITION_CATALOG[entry.condition.type].summarize(entry.condition.params)}</div>
            </div>
            <ToolbarButton disabled={busy} aria-label={`${entry.stock_name} ${entry.date} 복원`} onClick={() => restore(entry)}>복원</ToolbarButton>
          </li>)}
        </ul>}
      </div>
    </ModalShell>}
  </div>;
}

export function OccurrenceDetails({ code, name, occurrences, controller }: {
  code: string; name: string; occurrences: ScreenerOccurrence[]; controller: OccurrenceExclusions;
}) {
  const [open, setOpen] = useState(false);
  return <details onToggle={e => setOpen(e.currentTarget.open)} className="col-span-full cursor-default pb-sm text-xs" onClick={e => e.stopPropagation()}
    onKeyDown={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    <summary className="cursor-pointer py-1 text-fg-dim hover:text-fg" aria-label={`${name} 발생 ${occurrences.length}건`}>
      발생 {occurrences.length}건
    </summary>
    {open && <ul className="max-h-64 overflow-auto pl-sm">
      {occurrences.map(item => {
        const condition = controller.conditions.find(c => c.id === item.condition_id);
        return <li key={`${item.condition_id}:${item.date}`} className="flex items-center gap-2 py-1">
          <span className="font-data">{item.date}</span>
          <span className="min-w-0 flex-1 text-fg-dim">{condition
            ? `${CONDITION_CATALOG[condition.type].label} ${CONDITION_CATALOG[condition.type].summarize(condition.params)}`
            : '조건 정보 없음 · 재조회 필요'}</span>
          <ToolbarButton disabled={controller.busy || !controller.ready || !condition}
            aria-label={`${name} ${item.date} ${condition ? CONDITION_CATALOG[condition.type].label : ''} 발생 건 제외`}
            onClick={() => controller.exclude(code, name, item)}>이 발생 건 제외</ToolbarButton>
        </li>;
      })}
    </ul>}
  </details>;
}
