import { useState } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, useDroppable, closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  useWatchlist, useCreateFolder, useReorderEntries, useMoveMember,
  useRenameFolder, useDeleteFolder, useReorderFolders, useSetFolderCaptureEnabled,
} from './useWatchlist';
import { WatchlistEntryPane } from './WatchlistEntryPane';
import { resolveDrag, folderDroppableId } from './dragHandlers';
import { selectVisibleEntries, swapFolderOrder, type Selected } from './grouping';
import { ModalShell } from '../ui/ModalShell';

const DEFAULT_CAPTURE_ENABLED = true;

// Hoisted to module scope (stable identity) so the inline-edit <input> reconciles in place
// instead of remounting on every keystroke (remount → detached node → lost focus + blur).
// Droppable container (F8 drop target) + sibling selection / action buttons — the action
// buttons are NOT nested in the selection button (invalid DOM + click bubbling); they reveal
// on hover via `group-hover`.
function FolderRow(props: {
  id: string; name: string; idx: number; count: number;
  captureEnabled: boolean;
  isSelected: boolean; isEditing: boolean; isLast: boolean; editName: string;
  onSelect: () => void; onStartEdit: () => void; onDelete: () => void;
  onToggleCapture: () => void;
  onMoveUp: () => void; onMoveDown: () => void;
  onEditNameChange: (v: string) => void; onCommit: () => void; onCancelEdit: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: folderDroppableId(props.id) });
  return (
    <div ref={setNodeRef} data-testid={`folder-row-${props.id}`}
      className={`group relative flex items-center gap-1 pl-3 pr-2 py-1.5 rounded text-sm ${
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
          className="flex-1 min-w-0 flex items-center justify-between text-left pr-2 group-hover:pr-24 group-focus-within:pr-24">
          <span className="truncate" title={props.name}>{props.name}</span>
          <span className="shrink-0 font-mono tabular-nums text-fg-dimmer text-xs">{props.count}</span>
        </button>
      )}
      {!props.isEditing && (
        // opacity 숨김(display:none 아님) — Tab 포커스 도달 + group-focus-within 노출
        // (패널 GroupHeader ⋯과 같은 키보드 접근성 계약).
        <div data-testid={`folder-row-actions-${props.id}`}
          className={`absolute right-2 flex items-center gap-0.5 text-fg-dimmer opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto ${
            props.isSelected ? 'bg-bg-input' : 'bg-bg-input-hover'
          }`}>
          <button
            type="button"
            role="switch"
            aria-checked={props.captureEnabled}
            aria-label={`${props.name} 저장 대상`}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleCapture();
            }}
            className={`w-8 h-4 rounded-full border ${
              props.captureEnabled ? 'bg-accent border-accent' : 'bg-bg-input border-border'
            }`}
          >
            <span
              aria-hidden
              className={`block w-3 h-3 rounded-full bg-fg transition-transform ${
                props.captureEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
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
  const moveMember = useMoveMember();
  const renameM = useRenameFolder();
  const deleteM = useDeleteFolder();
  const reorderFoldersM = useReorderFolders();
  const captureM = useSetFolderCaptureEnabled();
  const [selected, setSelected] = useState<Selected>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // distance constraint so a click on the ⠿ handle still fires checkbox/↻ buttons.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const folders = [...(data?.folders ?? [])].sort((a, b) => a.order - b.order);
  const countIn = (id: string | null) => (data?.entries ?? []).filter((e) => e.folder_id === id).length;

  // Same derivation the pane renders (selectVisibleEntries) so resolveDrag's row
  // indices line up with the pane — the parallelism is now structural (one helper).
  const visible = selectVisibleEntries(data?.entries ?? [], selected);

  const onDragEnd = (ev: DragEndEvent) => {
    if (!ev.over) return;
    const r = resolveDrag(visible, selected, String(ev.active.id), String(ev.over.id));
    if (r.kind === 'reorder' && r.folderId !== null) {
      reorderM.mutate({ folderId: r.folderId, orderedCodes: r.orderedCodes });
    } else if (r.kind === 'move' && selected !== null && r.folderId !== null) {
      // v3: 폴더 간 드래그 = 멤버십 이동(대상 추가 후 출처 제거).
      const target = r.folderId;
      for (const code of r.codes) void moveMember({ code, from: selected, to: target });
    }
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

  // Authoritative ordered_ids 계약은 swapFolderOrder(grouping.ts)에 — 패널 ⋯ 메뉴와 공유.
  const moveFolder = (folderId: string, dir: -1 | 1) => {
    const ids = swapFolderOrder(folders, folderId, dir);
    if (ids) reorderFoldersM.mutate(ids);
  };

  // Aligned with the 보조지표 modal (IndicatorPanel): shared ModalShell chrome
  // (backdrop/Escape/title/✕), a left nav with a small-caps section header + rows,
  // and a footer-anchored 닫기. Folder CRUD + the right entry pane are unchanged;
  // rows keep member counts (folders are select/edit targets, not on/off toggles,
  // so the indicator panel's checkbox icon would be the wrong affordance).
  return (
    <ModalShell ariaLabel="관심종목 편집" title="관심종목 편집"
      width="w-[860px]" height="h-[600px] max-h-[88vh]" onClose={onClose}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="flex-1 grid grid-cols-[220px_1fr] min-h-0">
          {/* 좌: 폴더 pane — 보조지표 nav 패턴(섹션 헤더 + 행)과 정렬 */}
          <div className="border-r border-border flex flex-col min-h-0">
            <div className="text-fg-dimmer text-xs uppercase tracking-wider px-3 pt-3 pb-2">관심 그룹</div>
            <div className="px-2 pb-2">
              {adding ? (
                <form data-testid="folder-create-form" onSubmit={submitFolder} className="flex gap-1">
                  <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                    placeholder="그룹 이름" maxLength={40}
                    onKeyDown={(e) => {
                      // Escape cancels the create input; stopPropagation so it
                      // doesn't bubble to ModalShell's document keydown (= close modal).
                      if (e.key === 'Escape') { e.stopPropagation(); setNewName(''); setAdding(false); }
                    }}
                    className="flex-1 min-w-0 px-2 py-1 rounded bg-bg-input text-sm border border-border" />
                  <button type="submit" className="px-2 rounded bg-accent text-bg text-sm">추가</button>
                </form>
              ) : (
                <button type="button" onClick={() => setAdding(true)}
                  className="w-full px-3 py-2 rounded border border-border text-sm text-fg-dim hover:text-accent hover:border-accent">
                  ＋ 그룹 추가
                </button>
              )}
            </div>
            <div className="flex-1 overflow-auto px-2 pb-2 flex flex-col gap-px">
              {folders.map((f, idx) => {
                const captureEnabled = f.capture_enabled ?? DEFAULT_CAPTURE_ENABLED;
                return (
                  <FolderRow key={f.id} id={f.id} name={f.name} idx={idx} count={countIn(f.id)}
                    captureEnabled={captureEnabled}
                    isSelected={selected === f.id} isEditing={editingId === f.id}
                    isLast={idx === folders.length - 1} editName={editName}
                    onSelect={() => setSelected(f.id)}
                    onStartEdit={() => { setEditingId(f.id); setEditName(f.name); }}
                    onDelete={() => { deleteM.mutate(f.id); if (selected === f.id) setSelected(null); }}
                    onToggleCapture={() => captureM.mutate({
                      folderId: f.id,
                      captureEnabled: !captureEnabled,
                    })}
                    onMoveUp={() => moveFolder(f.id, -1)}
                    onMoveDown={() => moveFolder(f.id, +1)}
                    onEditNameChange={setEditName}
                    onCommit={() => commitRename(f.id)}
                    onCancelEdit={() => setEditingId(null)} />
                );
              })}
            </div>
          </div>

          {/* 우: entry pane (F7) */}
          <WatchlistEntryPane selected={selected} />
        </div>
      </DndContext>

      {/* footer — 보조지표 모달과 동일: border-t + 우측 닫기 버튼 */}
      <div className="flex justify-end px-4 py-3 border-t border-border">
        <button type="button" onClick={onClose}
          className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">
          닫기
        </button>
      </div>
    </ModalShell>
  );
}
