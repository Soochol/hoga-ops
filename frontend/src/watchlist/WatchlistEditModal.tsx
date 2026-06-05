import { useEffect, useState } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, useDroppable, closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  useWatchlist, useCreateFolder, useReorderEntries, useMoveEntries,
  useRenameFolder, useDeleteFolder, useReorderFolders,
} from './useWatchlist';
import { WatchlistEntryPane } from './WatchlistEntryPane';
import { resolveDrag, folderDroppableId } from './dragHandlers';
import { selectVisibleEntries, type Selected } from './grouping';

// Hoisted to module scope (stable identity) so the inline-edit <input> reconciles in place
// instead of remounting on every keystroke (remount → detached node → lost focus + blur).
// Droppable container (F8 drop target) + sibling selection / action buttons — the action
// buttons are NOT nested in the selection button (invalid DOM + click bubbling); they reveal
// on hover via `group-hover`.
function FolderRow(props: {
  id: string; name: string; idx: number; count: number;
  isSelected: boolean; isEditing: boolean; isLast: boolean; editName: string;
  onSelect: () => void; onStartEdit: () => void; onDelete: () => void;
  onMoveUp: () => void; onMoveDown: () => void;
  onEditNameChange: (v: string) => void; onCommit: () => void; onCancelEdit: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: folderDroppableId(props.id) });
  return (
    <div ref={setNodeRef}
      className={`group flex items-center gap-1 px-2 py-1 rounded text-sm ${
        props.isSelected ? 'bg-bg-input text-fg' : 'text-fg-dim hover:bg-bg-input-hover'} ${
        isOver ? 'ring-1 ring-accent bg-bg-input-hover' : ''}`}>
      {props.isEditing ? (
        <input autoFocus value={props.editName} maxLength={40}
          onChange={(e) => props.onEditNameChange(e.target.value)}
          onBlur={props.onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onCommit();
            else if (e.key === 'Escape') { e.stopPropagation(); props.onCancelEdit(); }
          }}
          className="flex-1 min-w-0 px-1 py-0.5 rounded bg-bg-input text-sm border border-border" />
      ) : (
        <button type="button" onClick={props.onSelect}
          className="flex-1 min-w-0 flex items-center justify-between text-left">
          <span className="truncate">{props.name}</span>
          <span className="font-mono tabular-nums text-fg-dimmer text-xs">{props.count}</span>
        </button>
      )}
      {!props.isEditing && (
        <div className="hidden group-hover:flex items-center gap-0.5 text-fg-dimmer">
          <button type="button" aria-label={`${props.name} 위로`} disabled={props.idx === 0}
            onClick={props.onMoveUp}
            className="px-1 leading-none hover:text-fg disabled:opacity-40">▲</button>
          <button type="button" aria-label={`${props.name} 아래로`} disabled={props.isLast}
            onClick={props.onMoveDown}
            className="px-1 leading-none hover:text-fg disabled:opacity-40">▼</button>
          <button type="button" aria-label={`${props.name} 이름변경`}
            onClick={props.onStartEdit}
            className="px-1 leading-none hover:text-accent">✎</button>
          <button type="button" aria-label={`${props.name} 삭제`}
            onClick={props.onDelete}
            className="px-1 leading-none hover:text-error">🗑</button>
        </div>
      )}
    </div>
  );
}

export function WatchlistEditModal({ onClose }: { onClose: () => void }) {
  const { data } = useWatchlist();
  const createM = useCreateFolder();
  const reorderM = useReorderEntries();
  const moveM = useMoveEntries();
  const renameM = useRenameFolder();
  const deleteM = useDeleteFolder();
  const reorderFoldersM = useReorderFolders();
  const [selected, setSelected] = useState<Selected>('ALL');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // distance constraint so a click on the ⠿ handle still fires checkbox/↻ buttons.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const folders = [...(data?.folders ?? [])].sort((a, b) => a.order - b.order);
  const countIn = (id: string | null) => (data?.entries ?? []).filter((e) => e.folder_id === id).length;

  // Same derivation the pane renders (selectVisibleEntries) so resolveDrag's row
  // indices line up with the pane — the parallelism is now structural (one helper).
  const visible = selectVisibleEntries(data?.entries ?? [], selected);

  const onDragEnd = (ev: DragEndEvent) => {
    if (!ev.over) return;
    const r = resolveDrag(visible, selected === 'ALL' ? null : selected, String(ev.active.id), String(ev.over.id));
    if (r.kind === 'reorder' && selected !== 'ALL') reorderM.mutate({ folderId: r.folderId, orderedCodes: r.orderedCodes });
    else if (r.kind === 'move') moveM.mutate({ codes: r.codes, folderId: r.folderId });
  };

  const submitFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    await createM.mutateAsync(newName.trim());
    setNewName(''); setAdding(false);
  };

  const commitRename = (folderId: string) => {
    if (editingId !== folderId) return;       // guard: blur after Enter shouldn't double-mutate
    const name = editName.trim();
    if (name) renameM.mutate({ folderId, name });
    setEditingId(null);
  };

  // Authoritative ordered_ids: send the full id list and let the server re-assign 0..N-1.
  const moveFolder = (idx: number, dir: -1 | 1) => {
    const ids = folders.map((x) => x.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    reorderFoldersM.mutate(ids);
  };

  const FolderButton = ({ sel, label, count }: { sel: Selected; label: string; count: number | null }) => {
    // ALL is not a drop target (cross-folder dest is ambiguous); disabled also suppresses isOver.
    const { setNodeRef, isOver } = useDroppable({
      id: folderDroppableId(sel),
      disabled: sel === 'ALL',
    });
    return (
      <button ref={setNodeRef} type="button" onClick={() => setSelected(sel)}
        className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm ${
          selected === sel ? 'bg-bg-input text-fg' : 'text-fg-dim hover:bg-bg-input-hover'} ${
          isOver ? 'ring-1 ring-accent bg-bg-input-hover' : ''}`}>
        <span className="truncate">{label}</span>
        {count !== null && <span className="font-mono tabular-nums text-fg-dimmer text-xs">{count}</span>}
      </button>
    );
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="관심종목 편집" onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[860px] max-w-[92vw] h-[600px] max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-fg text-base font-medium">관심종목 편집</h2>
          <button type="button" aria-label="닫기" onClick={onClose} className="text-fg-dim hover:text-fg text-lg leading-none">✕</button>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="flex-1 grid grid-cols-[220px_1fr] min-h-0">
          {/* 좌: 폴더 pane */}
          <div className="border-r border-border flex flex-col min-h-0">
            <div className="p-2">
              {adding ? (
                <form data-testid="folder-create-form" onSubmit={submitFolder} className="flex gap-1">
                  <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                    placeholder="폴더 이름" maxLength={40}
                    onKeyDown={(e) => {
                      // Escape cancels the create input; stopPropagation so it
                      // doesn't bubble to the modal's document keydown (= close modal).
                      if (e.key === 'Escape') { e.stopPropagation(); setNewName(''); setAdding(false); }
                    }}
                    className="flex-1 min-w-0 px-2 py-1 rounded bg-bg-input text-sm border border-border" />
                  <button type="submit" className="px-2 rounded bg-accent text-bg text-sm">추가</button>
                </form>
              ) : (
                <button type="button" onClick={() => setAdding(true)}
                  className="w-full px-3 py-2 rounded border border-border text-sm text-fg-dim hover:text-accent hover:border-accent">
                  ＋ 폴더 추가
                </button>
              )}
            </div>
            <div className="flex-1 overflow-auto px-2 pb-2 flex flex-col gap-px">
              <FolderButton sel="ALL" label="모든 종목" count={data?.entries.length ?? 0} />
              {folders.map((f, idx) => (
                <FolderRow key={f.id} id={f.id} name={f.name} idx={idx} count={countIn(f.id)}
                  isSelected={selected === f.id} isEditing={editingId === f.id}
                  isLast={idx === folders.length - 1} editName={editName}
                  onSelect={() => setSelected(f.id)}
                  onStartEdit={() => { setEditingId(f.id); setEditName(f.name); }}
                  onDelete={() => { deleteM.mutate(f.id); if (selected === f.id) setSelected('ALL'); }}
                  onMoveUp={() => moveFolder(idx, -1)}
                  onMoveDown={() => moveFolder(idx, +1)}
                  onEditNameChange={setEditName}
                  onCommit={() => commitRename(f.id)}
                  onCancelEdit={() => setEditingId(null)} />
              ))}
              <FolderButton sel={null} label="미분류" count={countIn(null)} />
            </div>
          </div>

          {/* 우: entry pane (F7) */}
          <WatchlistEntryPane selected={selected} />
        </div>
        </DndContext>
      </div>
    </div>
  );
}
