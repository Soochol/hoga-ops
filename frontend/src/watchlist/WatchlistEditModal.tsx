import { useEffect, useState } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, useDroppable, closestCenter,
  type CollisionDetection, type DragEndEvent, type DraggableAttributes, type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useWatchlist, useCreateFolder, useReorderEntries, useMoveMember,
  useRenameFolder, useDeleteFolder, useReorderFolders, useSetFolderCaptureEnabled,
} from './useWatchlist';
import { WatchlistEntryPane } from './WatchlistEntryPane';
import { resolveDrag, resolveFolderDrag, folderDroppableId } from './dragHandlers';
import {
  selectVisibleEntries, countOrphansIfFolderDeleted, folderCaptureEnabled, type Selected,
} from './grouping';
import { ModalShell } from '../ui/ModalShell';
import { TrashIcon } from '../ui/TrashIcon';
import { dropIndicatorClass, sortableDraggingStyle, type DropIndicator } from '../ui/sortableDragVisuals';
import { FolderDeleteConfirm } from './FolderDeleteConfirm';

// 삭제 확인이 떠 있는 동안 편집 모달의 닫기를 무력화하는 상수(모듈 스코프 —
// 인라인 () => {} 면 ModalShell 의 keydown useEffect 가 매 렌더 재구독한다).
const NOOP_CLOSE = () => {};

// Hoisted to module scope (stable identity) so the inline-edit <input> reconciles in place
// instead of remounting on every keystroke (remount → detached node → lost focus + blur).
// Droppable container (F8 drop target) + sibling selection / action buttons — the action
// buttons are NOT nested in the selection button (invalid DOM + click bubbling); they reveal
// on hover via `group-hover`.
function FolderRow(props: {
  id: string; name: string; count: number;
  captureEnabled: boolean;
  isSelected: boolean; isEditing: boolean; editName: string;
  onSelect: () => void; onStartEdit: () => void; onDelete: () => void;
  onToggleCapture: () => void;
  onEditNameChange: (v: string) => void; onCommit: () => void; onCancelEdit: () => void;
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
  dragActivatorRef?: (node: HTMLElement | null) => void;
  dragging?: boolean;
  dropIndicator?: DropIndicator;
}) {
  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    id: folderDroppableId(props.id),
    data: { type: 'entry-target' },
  });
  const setRowRef = (node: HTMLDivElement | null) => {
    setDroppableNodeRef(node);
    props.dragActivatorRef?.(node);
  };
  return (
    <div ref={setRowRef} data-testid={`folder-row-${props.id}`}
      {...props.dragAttributes}
      {...props.dragListeners}
      className={`group relative flex items-center gap-1 pl-2 pr-2 py-1.5 rounded text-sm touch-none ${
        // 선택 행은 `--tint-selection`(DESIGN.md, selected list rows) — 보조지표 nav
        // (SettingsSections) 와 같은 토큰이다. **`bg-bg-input` 은 여기서 죽은 코드였다**:
        // toss-light·ledger 는 `--bg-input` 과 `--bg-card` 가 같은 값이고(#ffffff /
        // #fdfcf8) obsidian 은 명도차 2/255 라, 4개 테마 중 3개에서 선택 표시가 한 픽셀도
        // 안 나왔다. 게다가 hover(`--bg-input-hover`)가 더 진해서 "스치는 행"이 "선택된
        // 행"보다 도드라지는 역전까지 났다. 값 통합으로 조용히 죽는 부류라 테스트는
        // 계산색이 아니라 **클래스를 못박는다**(jsdom 은 CSS 변수를 풀지 않는다).
        props.isSelected ? 'bg-tint-selection text-fg font-medium' : 'text-fg-dim hover:bg-bg-input-hover'} ${
        isOver ? 'ring-1 ring-accent bg-bg-input-hover' : ''} ${dropIndicatorClass(props.dropIndicator)}`}
      style={{
        ...(props.dragging ? sortableDraggingStyle() : {}),
        ...(props.dropIndicator ? { position: 'relative' } : {}),
      }}>
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
        // 이름 변경 진입은 **더블클릭 + F2** 다. hover 액션을 토글·삭제 둘로 단순화한
        // 0.12.17.2 결정을 유지하면서(연필 버튼을 되살리지 않는다) 키보드 경로만 연다 —
        // 그 단순화가 의도한 것은 행 조작 밀도이지 "키보드로는 이름을 못 바꾼다" 가 아니다.
        //
        // **Enter 는 못 쓴다**: 이 버튼의 click 이 그룹 선택이라 Enter 는 이미 거기에 묶여
        // 있다. F2 는 파일 탐색기 관례이고 다른 곳에서 안 쓴다. 드래그는 포인터 전용이라
        // (KeyboardSensor 미도입) dnd-kit 리스너와도 겹치지 않는다.
        <button type="button" onClick={props.onSelect} onDoubleClick={props.onStartEdit}
          onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); props.onStartEdit(); } }}
          aria-keyshortcuts="F2"
          title="더블클릭 또는 F2: 이름 변경"
          className="flex-1 min-w-0 flex items-center justify-between text-left pr-2">
          {/* span 의 title 은 truncate 된 **전체 이름**을 보여 주는 용도라 그대로 둔다 —
              이름 위에서는 이름이, 나머지 영역에서는 버튼의 안내가 뜬다. */}
          <span className="truncate" title={props.name}>{props.name}</span>
          <span className="shrink-0 font-data tabular-nums text-fg-dim text-xs">{props.count}</span>
        </button>
      )}
      {!props.isEditing && (
        // **토글은 상시 노출한다.** 이건 이 앱에서 `capture_enabled` 를 보여 주는 **유일한
        // 지점**인데 hover 뒤에 숨어 있었다 — 게다가 신규 폴더는 기본이 꺼짐이라
        // (ADR-0079, 실시간 저장은 명시적 옵트인) "그룹을 만들고 종목을 넣었는데 저장이
        // 안 된다" 가 **정상 경로**이고 그 사실을 알 방법이 없었다. 상시 노출이 상태
        // 표시와 조작을 동시에 해결한다(숨김 시절엔 `pointer-events-none` 이라 hover
        // 없이는 클릭조차 못 했다 — 실측).
        //
        // 파괴적인 휴지통만 hover 로 남긴다. opacity 숨김(display:none 아님)이라 Tab
        // 포커스가 닿고 `group-focus-within` 으로 드러난다(패널 GroupHeader ⋯과 같은
        // 키보드 접근성 계약).
        //
        // **absolute 를 쓰지 않는다.** 예전엔 액션 묶음이 `absolute right-2` 라 자리를
        // 안 차지했고, 그래서 이름 버튼에 hover 패딩(`pr-12`)을 줘 자리를 비워야 했다 —
        // 그 값(48px)이 액션 실제 폭(54px)보다 작아 카운트를 5px 덮었고 `10` 이 `1` 로
        // 읽혔다. 패딩과 액션 폭이 **손으로 맞춰야 하는 두 숫자**인 한 같은 사고가 다시
        // 난다. 평범한 flex 아이템으로 두면 겹침이 원리적으로 불가능하다. 대가는 휴지통
        // 자리(≈22px)를 늘 비워 두는 것이고, 그만큼 이름이 일찍 truncate 된다.
        <div data-testid={`folder-row-actions-${props.id}`}
          className="shrink-0 flex items-center gap-0.5 text-fg-dimmer">
          <button
            type="button"
            role="switch"
            aria-checked={props.captureEnabled}
            aria-label={`${props.name} 실시간 저장`}
            title={props.captureEnabled
              ? '실시간 저장 대상 — 이 그룹의 종목을 실시간으로 저장한다'
              : '실시간 저장 안 함 — 일별 과거 데이터 수집은 계속된다'}
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleCapture();
            }}
            // 행 전체가 드래그 활성 영역이라(dnd-kit PointerSensor, distance 5) 토글을
            // 누른 채 손이 흔들리면 폴더 드래그가 시작된다. entry 행 버튼들과 같은
            // 관용구로 pointerdown 에서 끊는다 — 상시 노출이 되면서 빈도가 올라간다.
            onPointerDown={(e) => e.stopPropagation()}
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
          <button type="button" aria-label={`${props.name} 삭제`}
            onClick={props.onDelete}
            onPointerDown={(e) => e.stopPropagation()}
            className="px-1 leading-none hover:text-error opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
            <TrashIcon className="w-[1em] h-[1em]" />
          </button>
        </div>
      )}
    </div>
  );
}

function SortableFolderRow(props: Parameters<typeof FolderRow>[0]) {
  const { setNodeRef, setActivatorNodeRef, transform, transition, listeners, attributes, isDragging, activeIndex, overIndex, index } =
    useSortable({ id: props.id, data: { type: 'folder' } });
  const dropIndicator = activeIndex !== -1 && overIndex !== -1 && index === overIndex && index !== activeIndex
    ? (activeIndex < overIndex ? 'after' : 'before')
    : undefined;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <FolderRow {...props}
        dragListeners={listeners}
        dragAttributes={attributes}
        dragActivatorRef={setActivatorNodeRef}
        dragging={isDragging}
        dropIndicator={dropIndicator} />
    </div>
  );
}

const modalCollision: CollisionDetection = (args) => {
  const type = args.active.data.current?.type;
  if (type === 'folder') {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => c.data.current?.type === 'folder'),
    });
  }
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => c.data.current?.type !== 'folder'),
  });
};

export function WatchlistEditModal({ onClose }: { onClose: () => void }) {
  const { data } = useWatchlist();
  const createM = useCreateFolder();
  const reorderM = useReorderEntries();
  const moveMember = useMoveMember();
  const renameM = useRenameFolder();
  const deleteM = useDeleteFolder();
  const reorderFoldersM = useReorderFolders();
  const captureM = useSetFolderCaptureEnabled();
  const [selected, setSelected] = useState<Selected | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  // 고아 수는 **확인을 띄우는 시점에 얼려서** state 에 담는다 — 확인이 떠 있는 동안
  // 폴링으로 `data` 가 갱신되면 다시 센 값이 사용자가 읽은 숫자와 어긋난다(패널과 동일).
  const [deleteConfirm, setDeleteConfirm] = useState<{ folderId: string; orphanCount: number } | null>(null);
  // 우측 pane 이 Escape 로 닫히는 것(이동 메뉴·일괄 제거 확인)을 띄웠는지. 이걸 받아야
  // 하는 이유는 **리스너 등록 순서**다: 이 모달의 document keydown 이 먼저 등록돼 먼저
  // 발화하므로, pane 쪽에서 stopPropagation 을 해도 모달은 이미 닫힌 뒤다. setState 를
  // 그대로 넘긴다 — 참조가 안정적이라 pane 의 effect 가 매 렌더 재실행되지 않는다.
  const [paneOverlayOpen, setPaneOverlayOpen] = useState(false);

  // distance constraint so selecting a group and starting a group drag stay distinct.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const folders = [...(data?.folders ?? [])].sort((a, b) => a.order - b.order);
  const countIn = (id: string | null) => (data?.entries ?? []).filter((e) => e.folder_id === id).length;

  useEffect(() => {
    if (selected === undefined && folders.length > 0) setSelected(folders[0].id);
    else if (selected !== undefined && selected !== null && !folders.some((f) => f.id === selected)) {
      setSelected(folders[0]?.id ?? null);
    }
  }, [folders, selected]);

  // Same derivation the pane renders (selectVisibleEntries) so resolveDrag's row
  // indices line up with the pane — the parallelism is now structural (one helper).
  const selectedFolder = selected === undefined ? folders[0]?.id ?? null : selected;
  const visible = selectVisibleEntries(data?.entries ?? [], selectedFolder);

  const onDragEnd = (ev: DragEndEvent) => {
    if (!ev.over) return;
    if (ev.active.data.current?.type === 'folder') {
      const overFolderId = ev.over.data.current?.type === 'folder' ? String(ev.over.id) : null;
      if (!overFolderId) return;
      const r = resolveFolderDrag(folders.map((f) => f.id), String(ev.active.id), overFolderId);
      if (r.kind === 'reorder') reorderFoldersM.mutate(r.orderedIds);
      return;
    }

    const r = resolveDrag(visible, selectedFolder, String(ev.active.id), String(ev.over.id));
    if (r.kind === 'reorder' && r.folderId !== null) {
      reorderM.mutate({ folderId: r.folderId, orderedCodes: r.orderedCodes });
    } else if (r.kind === 'move' && selectedFolder !== null && r.folderId !== null) {
      // v3: 폴더 간 드래그 = 멤버십 이동(대상 추가 후 출처 제거).
      const target = r.folderId;
      for (const code of r.codes) void moveMember({ code, from: selectedFolder, to: target });
    }
  };

  const submitFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    await createM.mutateAsync(newName.trim());
    setNewName(''); setAdding(false);
  };

  // v3 폴더 삭제는 파괴적이다(ADR-0070 P6) — 이 폴더에만 있는 코드는 관심종목에서
  // 빠진다. 고아가 생기면 확인을 거치고, 없으면(빈 그룹·전부 다른 그룹에도 있는 그룹)
  // 곧바로 지운다. **패널 그룹 ⋯ 메뉴와 같은 분기·같은 확인 UI**다.
  const requestDeleteFolder = (folderId: string) => {
    const orphanCount = countOrphansIfFolderDeleted(data?.entries ?? [], folderId);
    if (orphanCount > 0) {
      setDeleteConfirm({ folderId, orphanCount });
      return;
    }
    performDeleteFolder(folderId);
  };

  // 다음 선택은 **이 함수가 불리는 시점의** folders 에서 고른다 — 확인이 떠 있는 동안
  // 폴링이 폴더 목록을 바꿨을 수 있어, 삭제를 요청하던 시점의 스냅샷으로 고르면 이미
  // 사라진 폴더를 가리킬 수 있다.
  const performDeleteFolder = (folderId: string) => {
    deleteM.mutate(folderId);
    if (selected === folderId) {
      setSelected(folders.find((candidate) => candidate.id !== folderId)?.id ?? null);
    }
  };

  const commitRename = (folderId: string) => {
    if (editingId !== folderId) return;       // guard: blur after Enter shouldn't double-mutate
    const name = editName.trim();
    if (name) renameM.mutate({ folderId, name });
    setEditingId(null);
  };

  // Aligned with the 보조지표 modal (IndicatorPanel): shared ModalShell chrome
  // (backdrop/Escape/title/✕), a left nav with a small-caps section header + rows,
  // and a footer-anchored 닫기. Folder CRUD + the right entry pane are unchanged;
  // rows keep member counts (folders are select/edit targets, not on/off toggles,
  // so the indicator panel's checkbox icon would be the wrong affordance).
  return (
    <>
    {/* 삭제 확인은 이 모달의 **형제**로 띄운다(자식이면 편집 카드의 Tab trap·포커스
        목록에 확인 버튼이 섞인다). 두 ModalShell 이 각자 document keydown 을 듣기
        때문에 Escape 한 번이 둘 다 닫으므로, 확인이 떠 있는 동안은 편집 모달의
        onClose 를 막는다 — Escape·백드롭 둘 다 같은 onClose 를 타서 가드 하나로
        충분하다. 확인 취소 후 포커스는 ModalShell 의 복원 계약이 휴지통으로 돌린다. */}
    <ModalShell ariaLabel="관심종목 편집" title="관심종목 편집"
      width="w-[860px]" height="h-[600px] max-h-[88vh]"
      onClose={deleteConfirm || paneOverlayOpen ? NOOP_CLOSE : onClose}>
      <DndContext sensors={sensors} collisionDetection={modalCollision} onDragEnd={onDragEnd}>
        <div className="flex-1 grid grid-cols-[220px_1fr] min-h-0">
          {/* 좌: 폴더 pane — 보조지표 nav 패턴(섹션 헤더 + 행)과 정렬 */}
          <div className="border-r border-border flex flex-col min-h-0">
            {/* 「실시간 저장」 캡션은 토글 컬럼 위에 온다 — 행마다 라벨을 붙이면 220px
                nav 에서 그룹 이름을 잡아먹으므로, 라벨 하나로 컬럼 전체를 설명한다.
                맨 스위치는 무엇을 켜는지 말해 주지 않는다(aria-label 은 시각 사용자에게
                안 보인다). 휴지통은 hover 로만 나오므로 캡션 대상이 아니다. */}
            <div className="flex items-baseline justify-between text-fg-dim text-xs px-3 pt-3 pb-2">
              <span className="uppercase">관심 그룹</span>
              <span className="text-fg-dimmer">실시간 저장</span>
            </div>
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
              <SortableContext items={folders.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                {folders.map((f) => {
                  const captureEnabled = folderCaptureEnabled(f);
                  return (
                    <SortableFolderRow key={f.id} id={f.id} name={f.name} count={countIn(f.id)}
                      captureEnabled={captureEnabled}
                      isSelected={selected === f.id} isEditing={editingId === f.id}
                      editName={editName}
                      onSelect={() => setSelected(f.id)}
                      onStartEdit={() => { setEditingId(f.id); setEditName(f.name); }}
                      onDelete={() => requestDeleteFolder(f.id)}
                      onToggleCapture={() => captureM.mutate({
                        folderId: f.id,
                        captureEnabled: !captureEnabled,
                      })}
                      onEditNameChange={setEditName}
                      onCommit={() => commitRename(f.id)}
                      onCancelEdit={() => setEditingId(null)} />
                  );
                })}
              </SortableContext>
            </div>
          </div>

          {/* 우: entry pane (F7) */}
          <WatchlistEntryPane selected={selectedFolder} onOverlayOpenChange={setPaneOverlayOpen} />
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
    {deleteConfirm && (
      <FolderDeleteConfirm
        orphanCount={deleteConfirm.orphanCount}
        onConfirm={() => { performDeleteFolder(deleteConfirm.folderId); setDeleteConfirm(null); }}
        onClose={() => setDeleteConfirm(null)} />
    )}
    </>
  );
}
