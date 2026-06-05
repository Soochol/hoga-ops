import { useEffect, useMemo, useRef, useState } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useWatchlist, useRemoveEntries, useMoveEntries, useCatchupOne } from './useWatchlist';
import { useDismissablePopover } from '../util/useDismissablePopover';
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
        <input type="checkbox" aria-label="전체 선택" checked={allChecked} onChange={toggleAll} />
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

      {/* list — sortable only in a concrete folder; ALL view is read-order (no ⠿ handle) */}
      <ul className="flex-1 overflow-auto" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {selected === 'ALL' ? (
          entries.map((e) => (
            <EntryRow key={e.code} entry={e} checked={checked.has(e.code)} onToggle={() => toggle(e.code)}
              onCatchup={() => onCatchup(e.code, e.name)}
              catchingUp={catchupOneM.isPending && catchupOneM.variables === e.code} />
          ))
        ) : (
          <SortableContext items={entries.map((e) => e.code)} strategy={verticalListSortingStrategy}>
            {entries.map((e) => (
              <SortableEntryRow key={e.code} entry={e} checked={checked.has(e.code)} onToggle={() => toggle(e.code)}
                onCatchup={() => onCatchup(e.code, e.name)}
                catchingUp={catchupOneM.isPending && catchupOneM.variables === e.code} />
            ))}
          </SortableContext>
        )}
        {entries.length === 0 && <li className="p-4 text-sm text-fg-dimmer">이 폴더에 종목이 없습니다</li>}
      </ul>
    </div>
  );
}

type RowProps = {
  entry: WatchlistEntry; checked: boolean; onToggle: () => void;
  onCatchup: () => void; catchingUp: boolean;
};

const ROW_CLASS =
  'grid grid-cols-[2ch_1ch_6ch_1fr_8ch_2.5ch] items-center gap-2 px-3 py-2 border-b border-border text-sm hover:bg-bg-input';

/** ALL view: read-order, no drag handle (structurally non-sortable). The handle
 *  cell renders an empty aria-hidden span so the 6-column grid stays aligned. */
function EntryRow(props: RowProps) {
  const { entry, checked, onToggle } = props;
  return (
    <li data-testid={`edit-row-${entry.code}`} className={ROW_CLASS}>
      <input type="checkbox" aria-label={`${entry.code} 선택`} checked={checked} onChange={onToggle} />
      <span aria-hidden />
      <span className="font-mono text-fg-dim text-xs">{entry.code}</span>
      <span className="truncate">{entry.name}</span>
      <LastSuccessBadge date={entry.last_success_date} />
      <button type="button" aria-label={`${entry.name} 수집`} onClick={props.onCatchup} disabled={props.catchingUp}
        className={`text-fg-dimmer hover:text-accent disabled:opacity-40 ${props.catchingUp ? 'animate-spin' : ''}`}>↻</button>
    </li>
  );
}

/** Folder view: sortable row. ⠿ is the drag handle (listeners on the handle only,
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
      <input type="checkbox" aria-label={`${entry.code} 선택`} checked={props.checked} onChange={props.onToggle} />
      <span {...listeners} aria-hidden
        className="text-fg-dimmer cursor-grab select-none touch-none">⠿</span>
      <span className="font-mono text-fg-dim text-xs">{entry.code}</span>
      <span className="truncate">{entry.name}</span>
      <LastSuccessBadge date={entry.last_success_date} />
      <button type="button" aria-label={`${entry.name} 수집`} onClick={props.onCatchup} disabled={props.catchingUp}
        className={`text-fg-dimmer hover:text-accent disabled:opacity-40 ${props.catchingUp ? 'animate-spin' : ''}`}>↻</button>
    </li>
  );
}
