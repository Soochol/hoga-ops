import { createPortal } from 'react-dom';
import { useState } from 'react';
import type { ScreenerOccurrence } from '../api/screener';
import { CONDITION_CATALOG } from './catalog';
import type { OccurrenceExclusions } from './useOccurrenceExclusions';
import { ModalShell } from '../ui/ModalShell';
import { ToolbarButton } from '../ui/PageShell';

export function OccurrenceExclusionToolbar({ controller }: { controller: OccurrenceExclusions }) {
  const [open, setOpen] = useState(false);
  const { exclusions, busy, ready, error, lastExcluded, restore } = controller;
  if (!open && exclusions.length === 0 && !busy && !error) return null;
  return <div className="flex flex-wrap items-center gap-2 text-xs text-fg-dim">
    {exclusions.length > 0 && <ToolbarButton disabled={!ready} onClick={() => setOpen(true)}>제외한 발생 건 {exclusions.length}</ToolbarButton>}
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


export function OccurrenceAction({ code, name, occurrence, controller }: {
  code: string; name: string; occurrence: ScreenerOccurrence; controller: OccurrenceExclusions;
}) {
  const [confirm, setConfirm] = useState(false);
  const condition = controller.conditions.find(c => c.id === occurrence.condition_id);
  const label = condition ? CONDITION_CATALOG[condition.type].label : '';
  const remove = () => { controller.exclude(code, name, occurrence); setConfirm(false); };
  return <span onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    <ToolbarButton disabled={controller.busy || !controller.ready || !condition}
      aria-label={`${name} ${occurrence.date} ${label} 발생 건 제외`}
      onClick={() => controller.affectedOtherRows(code, occurrence) > 0 ? setConfirm(true) : remove()}>제외</ToolbarButton>
    {confirm && createPortal(<ModalShell title="제외 영향 확인" ariaLabel="제외 영향 확인" onClose={() => setConfirm(false)} width="w-[480px]">
      <div className="p-md text-sm">
        <p>{name} · {occurrence.date} · {label}</p>
        <p className="py-sm">이 조건의 마지막 발생 건입니다. 제외하면 AND 조건을 충족하지 못해 이 종목의 다른 발생 {controller.affectedOtherRows(code, occurrence)}건도 결과에서 빠집니다. 다른 발생 건 자체는 제외 기록에 저장되지 않습니다.</p>
        <div className="flex justify-end gap-sm"><ToolbarButton onClick={() => setConfirm(false)}>취소</ToolbarButton>
          <ToolbarButton disabled={controller.busy} onClick={remove}>이 발생 건 제외</ToolbarButton></div>
      </div>
    </ModalShell>, document.body)}
  </span>;
}

export function OccurrenceLabel({ occurrence, controller }: { occurrence: ScreenerOccurrence; controller: OccurrenceExclusions }) {
  const condition = controller.conditions.find(c => c.id === occurrence.condition_id);
  return <span className="text-xs text-fg-dim">{condition
    ? `${CONDITION_CATALOG[condition.type].label} ${CONDITION_CATALOG[condition.type].summarize(condition.params)}`
    : '조건 정보 없음 · 재조회 필요'}</span>;
}
