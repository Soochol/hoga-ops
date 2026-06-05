import { useEffect, useMemo, useRef, useState } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useWatchlist, useRemoveEntries, useMoveEntries, useCatchupOne } from './useWatchlist';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { CheckIcon } from '../ui/CheckIcon';
import { useWatchlistFeedback } from './useWatchlistFeedback';
import { WatchlistAddForm } from './WatchlistAddForm';
import { Banner } from './Banner';
import { LastSuccessBadge } from './rowFormat';
import { formatCaughtUpOneMessage, symbolLabel } from './banners';
import { selectVisibleEntries, type Selected } from './grouping';
import type { WatchlistEntry } from '../api/watchlist';

export function WatchlistEntryPane({ selected }: { selected: Selected }) {
  const { data } = useWatchlist();
  const removeM = useRemoveEntries();
  const moveM = useMoveEntries();
  const catchupOneM = useCatchupOne();
  const { recentAction, setRecentAction } = useWatchlistFeedback();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [moveMenu, setMoveMenu] = useState(false);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(moveMenu, moveMenuRef, () => setMoveMenu(false));

  // Multi-select is per-view: clear it when the viewed folder changes, else
  // checkmarks leak across folder switches (stale selection on a never-remounted pane).
  useEffect(() => { setChecked(new Set()); }, [selected]);

  const onCatchup = (code: string, name: string) =>
    catchupOneM.mutate(code, {
      onSuccess: (r) => setRecentAction({ kind: 'caught_up_one', code, name,
        enqueued: r.enqueued.length, deduped: r.deduped.length }),
      onError: (err) => setRecentAction({ kind: 'caught_up_one', code, name,
        enqueued: 0, deduped: 0, error: (err as Error).message }),
    });

  const entries = useMemo(() => selectVisibleEntries(data?.entries ?? [], selected), [data, selected]);

  const folders = [...(data?.folders ?? [])].sort((a, b) => a.order - b.order);
  const allChecked = entries.length > 0 && entries.every((e) => checked.has(e.code));
  const toggle = (code: string) =>
    setChecked((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });
  const toggleAll = () =>
    setChecked(allChecked ? new Set() : new Set(entries.map((e) => e.code)));
  // Derive from `entries` (already .order-sorted) so the selection is in VISUAL
  // order, not checkbox-click order — a multi-select move/delete must preserve
  // the on-screen relative order of the moved rows.
  const selectedCodes = entries.filter((e) => checked.has(e.code)).map((e) => e.code);

  const doMove = async (folderId: string | null) => {
    const codes = selectedCodes;
    setMoveMenu(false);
    try {
      await moveM.mutateAsync({ codes, folderId });
      setChecked(new Set());
    } catch {
      // useMoveEntries.onError already rolled the optimistic cache back; keep the
      // selection so the user can retry, and swallow so this fire-and-forget
      // onClick doesn't surface as an unhandled promise rejection.
    }
  };
  const doDelete = async () => {
    const codes = selectedCodes;
    try {
      await removeM.mutateAsync(codes);
      setChecked(new Set());
    } catch {
      // keep selection for retry; swallow to avoid an unhandled rejection.
    }
  };

  return (
    <div className="flex flex-col min-h-0">
      {/* 툴바 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <button type="button" role="checkbox" aria-checked={allChecked} aria-label="전체 선택"
          onClick={toggleAll} className="flex items-center cursor-pointer">
          <CheckIcon filled={allChecked} size={16} />
        </button>
        <div className="relative" ref={moveMenuRef}>
          <button type="button" disabled={selectedCodes.length === 0} onClick={() => setMoveMenu((v) => !v)}
            className="px-2 py-1 rounded border border-border text-xs text-fg-dim hover:text-accent disabled:opacity-40">⇄ 이동</button>
          {moveMenu && (
            <div role="menu" className="absolute z-10 mt-1 bg-bg-card border border-border rounded shadow-lg min-w-[140px]">
              {folders.filter((f) => f.id !== selected).map((f) => (
                <button key={f.id} role="menuitem" onClick={() => doMove(f.id)}
                  className="block w-full text-left px-3 py-1.5 text-sm hover:bg-bg-input-hover">{f.name}</button>
              ))}
              {selected !== null && (
                <button role="menuitem" onClick={() => doMove(null)}
                  className="block w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:bg-bg-input-hover">미분류</button>
              )}
            </div>
          )}
        </div>
        <button type="button" disabled={selectedCodes.length === 0} onClick={doDelete}
          className="px-2 py-1 rounded border border-border text-xs text-fg-dim hover:text-error disabled:opacity-40">🗑 삭제</button>
        <div className="flex-1" />
        <span className="text-xs text-fg-dimmer">직접 설정한 순</span>
      </div>

      {/* add form */}
      <div className="px-3 py-2 border-b border-border">
        <WatchlistAddForm onAdded={(hit) => setRecentAction({ kind: 'added', code: hit.code, name: hit.name })} />
      </div>

      {/* feedback banner (added / caught_up_one) — modal owns this feedback instance */}
      {recentAction?.kind === 'added' && (
        <div className="mx-3 mt-2"><Banner kind="success">{`✓ ${symbolLabel(recentAction)} 추가됨`}</Banner></div>
      )}
      {recentAction?.kind === 'caught_up_one' && (
        <div className="mx-3 mt-2">
          <Banner kind={recentAction.error ? 'error' : 'success'}>{formatCaughtUpOneMessage(recentAction)}</Banner>
        </div>
      )}

      {/* list — drag-reorder within the selected folder / 미분류 (⠿ handle) */}
      <ul className="flex-1 overflow-auto" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        <SortableContext items={entries.map((e) => e.code)} strategy={verticalListSortingStrategy}>
          {entries.map((e) => (
            <SortableEntryRow key={e.code} entry={e} checked={checked.has(e.code)} onToggle={() => toggle(e.code)}
              onCatchup={() => onCatchup(e.code, e.name)}
              catchingUp={catchupOneM.isPending && catchupOneM.variables === e.code} />
          ))}
        </SortableContext>
        {entries.length === 0 && <li className="p-4 text-sm text-fg-dimmer">이 그룹에 종목이 없습니다</li>}
      </ul>
    </div>
  );
}

type RowProps = {
  entry: WatchlistEntry; checked: boolean; onToggle: () => void;
  onCatchup: () => void; catchingUp: boolean;
};

// 1st col 16px = CheckIcon size (보조지표 IndicatorPanel과 같은 glyph; 행 밀도 때문에 18 대신 16).
// 종목코드는 표시하지 않음 — 체크박스 aria-label(`{code} 선택`)에만 남는다(이름과 달리 유일).
const ROW_CLASS =
  'grid grid-cols-[16px_1ch_1fr_8ch_2.5ch] items-center gap-2 px-3 py-2 border-b border-border text-sm hover:bg-bg-input';

/** Sortable row. ⠿ is the drag handle (listeners on the handle only,
 *  so the checkbox / ↻ button stay clickable). */
function SortableEntryRow(props: RowProps) {
  const { entry } = props;
  // listeners-only on the handle (no `attributes`): keeps ⠿ a clean decorative,
  // non-focusable span (matches the original) — pointer-dnd only, no keyboard-dnd.
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: entry.code });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };
  return (
    <li ref={setNodeRef} style={style} data-testid={`edit-row-${entry.code}`} className={ROW_CLASS}>
      <button type="button" role="checkbox" aria-checked={props.checked} aria-label={`${entry.code} 선택`}
        onClick={props.onToggle} className="flex items-center cursor-pointer">
        <CheckIcon filled={props.checked} size={16} />
      </button>
      <span {...listeners} aria-hidden
        className="text-fg-dimmer cursor-grab select-none touch-none">⠿</span>
      <span className="truncate">{entry.name}</span>
      <LastSuccessBadge date={entry.last_success_date} />
      <button type="button" aria-label={`${entry.name} 수집`} onClick={props.onCatchup} disabled={props.catchingUp}
        className={`text-fg-dimmer hover:text-accent disabled:opacity-40 ${props.catchingUp ? 'animate-spin' : ''}`}>↻</button>
    </li>
  );
}
