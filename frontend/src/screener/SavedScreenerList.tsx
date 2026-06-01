import { useEffect, useRef, useState } from 'react';
import type { SavedScreener } from '../api/savedScreeners';
import { useSavedScreeners } from './useSavedScreeners';
import { ConfirmModal } from './ConfirmModal';
import { suggestSaveName } from './suggestName';

type Editing =
  | { mode: 'create'; initial: string }
  | { mode: 'rename'; id: string; initial: string }
  | null;
type Confirm =
  | { kind: 'overwrite'; save: SavedScreener }
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

export function SavedScreenerList({ anchorId, dirty, onLoad, onNewDraft, onSaveAsNew, onOverwrite, onRename, onRemove }: {
  anchorId: string | null; dirty: boolean;
  onLoad: (s: SavedScreener) => void;
  onNewDraft: () => void;
  onSaveAsNew: (name: string) => void;
  onOverwrite: (s: SavedScreener) => void;
  onRename: (s: SavedScreener, name: string) => void;
  onRemove: (s: SavedScreener) => void;
}) {
  const { data } = useSavedScreeners();
  const saves = data?.saves ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

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
    if (confirm.kind === 'overwrite') onOverwrite(s);
    else onRemove(s);
    setConfirm(null);
  };

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      <div className="flex items-center gap-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">저장한 조건검색</span>
        <button type="button" aria-label="새 조건검색"
          onClick={() => { onNewDraft(); setEditing({ mode: 'create', initial: suggestSaveName(saves.map((s) => s.name)) }); }}
          className="ml-auto w-[22px] h-[22px] rounded-md bg-bg-input border text-fg-dim hover:text-fg">＋</button>
      </div>
      <div className="flex flex-col gap-1">
        {editing?.mode === 'create' && (
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-bg-input">
            <NameRowInput initial={editing.initial} onCommit={commitCreate} onCancel={() => setEditing(null)} />
          </div>
        )}
        {saves.map((s) => {
          // anchor+clean → teal fill + bar; anchor+dirty → bar only + 수정됨.
          const isAnchor = s.id === anchorId;
          const clean = isAnchor && !dirty;
          const isRenaming = editing?.mode === 'rename' && editing.id === s.id;
          return (
            <div key={s.id} role="button" tabIndex={0}
              onClick={() => { if (!isRenaming) onLoad(s); }}
              onKeyDown={(e) => { if (!isRenaming && (e.key === 'Enter' || e.key === ' ')) onLoad(s); }}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-md text-sm cursor-pointer ${
                clean ? 'bg-[rgba(20,184,166,0.14)] text-fg shadow-[inset_2px_0_0_var(--accent)]'
                  : isAnchor ? 'bg-bg-input text-fg shadow-[inset_2px_0_0_var(--accent)]'
                    : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
              {isRenaming ? (
                <NameRowInput initial={editing.initial} onCommit={(name) => commitRename(s, name)} onCancel={() => setEditing(null)} />
              ) : (
                <span className="truncate flex-1">{s.name}</span>
              )}
              {isAnchor && dirty && !isRenaming && <span className="shrink-0 text-[10px] tracking-[0.04em] text-fg-dimmer">수정됨</span>}
              {!isRenaming && (<>
                <button type="button" aria-label="현재 조건으로 덮어쓰기" onClick={(e) => { e.stopPropagation(); setConfirm({ kind: 'overwrite', save: s }); }}
                  className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">⤓</button>
                <button type="button" aria-label="이름변경" onClick={(e) => { e.stopPropagation(); setEditing({ mode: 'rename', id: s.id, initial: s.name }); }}
                  className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">✎</button>
                <button type="button" aria-label="삭제" onClick={(e) => { e.stopPropagation(); setConfirm({ kind: 'delete', save: s }); }}
                  className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">🗑</button>
              </>)}
            </div>
          );
        })}
        {saves.length === 0 && editing?.mode !== 'create' && (
          <div className="text-fg-dimmer text-xs px-1 py-2">저장된 조건검색이 없습니다. ＋ 로 현재 조건을 저장하세요.</div>
        )}
      </div>

      {confirm && (
        <ConfirmModal
          message={confirm.kind === 'overwrite'
            ? `"${confirm.save.name}"을(를) 현재 빌더 조건으로 덮어쓸까요?`
            : `"${confirm.save.name}" 삭제?`}
          confirmLabel={confirm.kind === 'overwrite' ? '덮어쓰기' : '삭제'}
          tone={confirm.kind === 'overwrite' ? 'primary' : 'destructive'}
          onConfirm={runConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
