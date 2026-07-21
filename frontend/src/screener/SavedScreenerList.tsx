import { useEffect, useRef, useState } from 'react';
import type { SavedScreener } from '../api/savedScreeners';
import { useSavedScreeners } from './useSavedScreeners';
import { ConfirmModal } from './ConfirmModal';
import { suggestSaveName } from './suggestName';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { EmptyState, ListRow } from '../ui/DataSurface';

type Editing =
  | { mode: 'create'; initial: string }
  | { mode: 'rename'; id: string; initial: string }
  | null;
type Confirm =
  | { kind: 'delete'; save: SavedScreener }
  | null;

// Inline name editor. Owns its own draft text so per-keystroke typing does not
// re-render the whole list, and a single-fire guard prevents the Enter→blur
// double commit (Enter blurs the input, which would otherwise commit twice).
function NameRowInput({ initial, onCommit, onCancel }: {
  initial: string; onCommit: (name: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(value); else onCancel();
  };
  return (
    <input ref={ref} autoFocus aria-label="조건검색 이름" value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); ref.current?.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); ref.current?.blur(); }
      }}
      className="flex-1 min-w-0 bg-bg-input border border-border rounded-lg text-fg px-2 py-1 text-sm" />
  );
}

function SavedScreenerRowMenu({ left, top, onRename, onDuplicate, onDelete }: {
  left: number;
  top: number;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { ref, left: clampedLeft, top: clampedTop } = useClampedFixedPosition<HTMLDivElement>(left, top);
  return (
    <div ref={ref} role="menu"
      className="fixed z-50 min-w-[104px] overflow-hidden rounded-md border border-border-strong bg-bg-card shadow-overlay"
      style={{ left: clampedLeft, top: clampedTop }}>
      <button type="button" role="menuitem" onClick={(e) => {
        e.stopPropagation(); onRename();
      }} className="block w-full px-3 py-2 text-left text-sm text-fg hover:bg-bg-input-hover">이름변경</button>
      <button type="button" role="menuitem" onClick={(e) => {
        e.stopPropagation(); onDuplicate();
      }} className="block w-full px-3 py-2 text-left text-sm text-fg hover:bg-bg-input-hover">복제</button>
      <button type="button" role="menuitem" onClick={(e) => {
        e.stopPropagation(); onDelete();
      }} className="block w-full px-3 py-2 text-left text-sm hover:bg-bg-input-hover" style={{ color: 'var(--error)' }}>삭제</button>
    </div>
  );
}

export function SavedScreenerList({ anchorId, dirty, onLoad, onNewDraft, onSaveAsNew, onDuplicate, onRename, onRemove }: {
  anchorId: string | null; dirty: boolean;
  onLoad: (s: SavedScreener) => void;
  onNewDraft: () => void;
  onSaveAsNew: (name: string) => void;
  onDuplicate: (s: SavedScreener) => void;
  onRename: (s: SavedScreener, name: string) => void;
  onRemove: (s: SavedScreener) => void;
}) {
  const { data } = useSavedScreeners();
  const saves = data?.saves ?? [];
  const rootRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [menu, setMenu] = useState<{ id: string; left: number; top: number } | null>(null);
  const [query, setQuery] = useState('');
  useDismissablePopover(Boolean(menu), rootRef, () => setMenu(null));
  const visibleSaves = query.trim()
    ? saves.filter((s) => s.name.includes(query.trim()))
    : saves;

  // create re-anchors to the new save; rename never re-anchors and must carry
  // the SAVE's own conditions/universe (forwarding the live builder is the ✎
  // data-loss bug). The editor owns the begin→mutate→settle race guard now; the
  // view just trims the name and fires the op.
  const commitCreate = (raw: string) => {
    const name = raw.trim();
    if (name) onSaveAsNew(name);
    setEditing(null);
  };
  const commitRename = (s: SavedScreener, raw: string) => {
    const name = raw.trim();
    if (name && name !== s.name) onRename(s, name);
    setEditing(null);
  };

  // Overwrite/delete go through the shared center ConfirmModal. The confirm
  // message NAMES the target so "load A → 덮어쓰기 on B" can't silently clobber
  // the wrong save. The editor's ops own the mutation + anchor settlement.
  const runConfirm = () => {
    if (!confirm) return;
    const s = confirm.save;
    onRemove(s);
    setConfirm(null);
  };

  return (
    <div ref={rootRef} className="flex h-full flex-col gap-sm min-h-0 overflow-auto p-md">
      <div className="flex items-center gap-1.5">
        <span className="text-[10.5px] font-semibold uppercase text-fg-dimmer">저장한 조건검색</span>
        <button type="button" aria-label="새 조건검색"
          onClick={() => { onNewDraft(); setEditing({ mode: 'create', initial: suggestSaveName(saves.map((s) => s.name)) }); }}
          className="ml-auto w-[22px] h-[22px] rounded-md bg-bg-input border text-fg-dim hover:text-fg">＋</button>
      </div>
      <input aria-label="저장 조건검색 검색" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="검색"
        className="w-full bg-bg-input border border-border rounded-md px-2 py-1 text-sm text-fg placeholder:text-fg-dimmer" />
      <div className="flex flex-col gap-1">
        {editing?.mode === 'create' && (
          <ListRow className="flex items-center gap-2 px-2.5 py-2 bg-bg-input text-fg">
            <NameRowInput initial={editing.initial} onCommit={commitCreate} onCancel={() => setEditing(null)} />
          </ListRow>
        )}
        {visibleSaves.map((s) => {
          // anchor+clean -> selection tint + bar; anchor+dirty -> bar only + 수정됨.
          const isAnchor = s.id === anchorId;
          const clean = isAnchor && !dirty;
          const isRenaming = editing?.mode === 'rename' && editing.id === s.id;
          return (
            <ListRow key={s.id} role="button" tabIndex={0}
              onClick={() => { if (!isRenaming) onLoad(s); }}
              onKeyDown={(e) => { if (!isRenaming && (e.key === 'Enter' || e.key === ' ')) onLoad(s); }}
              className={`group relative flex items-center gap-2 px-2.5 py-2 cursor-pointer ${
                clean ? 'bg-tint-selection text-fg shadow-[inset_2px_0_0_var(--accent)]'
                  : isAnchor ? 'bg-bg-input text-fg shadow-[inset_2px_0_0_var(--accent)]'
                    : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
              {isRenaming ? (
                <NameRowInput initial={editing.initial} onCommit={(name) => commitRename(s, name)} onCancel={() => setEditing(null)} />
              ) : (
                <span className="truncate flex-1">{s.name}</span>
              )}
              {isAnchor && dirty && !isRenaming && <span className="shrink-0 text-[10px] text-fg-dimmer">수정됨</span>}
              {!isRenaming && (
                <button type="button" aria-label="저장 조건 메뉴" aria-expanded={menu?.id === s.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (menu?.id === s.id) {
                      setMenu(null);
                    } else {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setMenu({ id: s.id, left: rect.right - 104, top: rect.bottom + 4 });
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-fg-dimmer hover:text-fg px-1">⋯</button>
              )}
              {menu?.id === s.id && !isRenaming && (
                <SavedScreenerRowMenu
                  left={menu.left}
                  top={menu.top}
                  onRename={() => { setMenu(null); setEditing({ mode: 'rename', id: s.id, initial: s.name }); }}
                  onDuplicate={() => { setMenu(null); onDuplicate(s); }}
                  onDelete={() => { setMenu(null); setConfirm({ kind: 'delete', save: s }); }}
                />
              )}
            </ListRow>
          );
        })}
        {saves.length === 0 && editing?.mode !== 'create' && (
          <EmptyState className="h-auto items-start justify-start gap-0 px-1 py-2 text-left text-xs text-fg-dimmer">
            저장된 조건검색이 없습니다. ＋ 로 현재 조건을 저장하세요.
          </EmptyState>
        )}
        {saves.length > 0 && visibleSaves.length === 0 && (
          <EmptyState className="h-auto items-start justify-start gap-0 px-1 py-2 text-left text-xs text-fg-dimmer">
            검색 결과가 없습니다.
          </EmptyState>
        )}
      </div>

      {confirm && (
        <ConfirmModal
          message={`"${confirm.save.name}" 삭제?`}
          confirmLabel="삭제"
          tone="destructive"
          onConfirm={runConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
