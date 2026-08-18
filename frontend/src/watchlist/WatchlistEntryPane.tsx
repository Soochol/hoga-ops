import { useEffect, useMemo, useRef, useState } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useWatchlist, useRemoveEntries, useRemoveMember, useMoveMember, useCatchupOne } from './useWatchlist';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { CheckIcon } from '../ui/CheckIcon';
import { useWatchlistFeedback } from './useWatchlistFeedback';
import { WatchlistAddForm } from './WatchlistAddForm';
import { Banner } from './Banner';
import { ConfirmModal } from '../ui/ConfirmModal';
import { LastSuccessBadge } from './rowFormat';
import { formatCaughtUpOneMessage, symbolLabel } from './banners';
import { selectVisibleEntries, countOrphansIfRemovedFrom, type Selected } from './grouping';
import type { WatchlistEntry } from '../api/watchlist';
import { dropIndicatorClass, sortableDraggingStyle } from '../ui/sortableDragVisuals';

export function WatchlistEntryPane({ selected, onOverlayOpenChange }: {
  selected: Selected;
  /** 이 pane 이 **Escape 로 닫히는 것**(이동 메뉴·확인 모달)을 띄우고 있는지 부모에게
   *  알린다. 편집 모달이 이걸 받아 자기 닫기를 막아야 한다 — 두 ModalShell 과 팝오버가
   *  각자 `document` keydown 을 듣는데 **편집 모달의 리스너가 먼저 등록돼 먼저 발화**
   *  하므로, 안쪽에서 stopPropagation 을 해도 이미 늦다. 그래서 "막아 달라" 를 위로
   *  올리는 것 말고는 방법이 없다.
   *
   *  optional 이라 pane 을 단독으로 렌더하는 소비처·테스트는 그대로 둔다. */
  onOverlayOpenChange?: (open: boolean) => void;
}) {
  const { data } = useWatchlist();
  const removeM = useRemoveEntries();
  const removeMemberM = useRemoveMember();
  const moveMember = useMoveMember();
  const catchupOneM = useCatchupOne();
  const { recentAction, setRecentAction } = useWatchlistFeedback();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [moveMenu, setMoveMenu] = useState(false);
  const [confirmAction, setConfirmAction] =
    useState<{ kind: 'unlink' | 'purge'; codes: string[]; orphanCount: number } | null>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(moveMenu, moveMenuRef, () => setMoveMenu(false));

  // Multi-select is per-view: clear it when the viewed folder changes, else
  // checkmarks leak across folder switches (stale selection on a never-remounted pane).
  useEffect(() => { setChecked(new Set()); }, [selected]);

  // 이동 메뉴·확인 모달 중 하나라도 떠 있으면 부모(편집 모달)의 Escape 닫기를 막는다.
  const overlayOpen = moveMenu || confirmAction !== null;
  useEffect(() => { onOverlayOpenChange?.(overlayOpen); }, [overlayOpen, onOverlayOpenChange]);
  // 언마운트 시 해제 — 안 그러면 확인이 열린 채 pane 이 사라졌을 때 부모의 닫기가
  // 영구히 막힌다(모달이 닫히지 않는 상태로 눌러붙는다).
  useEffect(() => () => onOverlayOpenChange?.(false), [onOverlayOpenChange]);

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

  const doMove = async (targetId: string) => {
    if (selected === null) return;       // v3: 미분류 뷰 없음 — selected는 실폴더
    const codes = selectedCodes;
    setMoveMenu(false);
    try {
      // v3 이동 = 대상 추가 후 출처 제거(멤버십). 선택 순서대로 순차 실행.
      for (const code of codes) await moveMember({ code, from: selected, to: targetId });
      setChecked(new Set());
    } catch {
      // 멤버십 mutation이 onError로 낙관적 캐시를 롤백; 선택은 유지해 재시도 가능.
    }
  };
  // v3 는 다중 소속이라 "뺀다" 가 두 가지다. 하나로 합쳐 두면 **좁은 쪽으로 읽히고
  // 넓은 쪽이 실행된다** — 이전의 「🗑 삭제」가 그랬다: 그룹 목록 화면이라 "이 그룹에서
  // 뺀다" 로 읽히는데 실제로는 `remove_entries`(모든 폴더에서 제거 + entry 삭제)였다.
  //
  //  - 「이 그룹에서 빼기」= 멤버십 제거. 다른 그룹에도 있으면 거기 남는다. 단, **마지막
  //    소속에서 빼면 관심종목을 떠난다**(서버 remove_member 가 orphan entry 를 prune).
  //    그래서 고아가 생길 때만 확인한다 — 폴더 삭제의 무고아 분기와 같은 계약.
  //  - 「관심 해제」= 전역 제거. 선택 전부가 entry 삭제이고 undo 가 없으니 **항상** 확인
  //    한다(조용한 유실 금지, ADR-0065).
  const requestUnlink = () => {
    const codes = selectedCodes;
    if (codes.length === 0 || selected === null) return;
    const orphanCount = countOrphansIfRemovedFrom(data?.entries ?? [], selected, codes);
    if (orphanCount === 0) {
      void doUnlink(codes);                 // 순수 멤버십 편집 — 잃는 것이 없다
      return;
    }
    setConfirmAction({ kind: 'unlink', codes, orphanCount });
  };

  const requestPurge = () => {
    const codes = selectedCodes;
    if (codes.length === 0) return;
    // 여기서 세는 고아는 "이 그룹에만 있는 수" 다. 나머지(다른 그룹에도 있는 것)까지
    // 전부 빠진다는 게 이 액션의 요점이라 문구가 그 차이를 말한다.
    const orphanCount = selected === null
      ? codes.length
      : countOrphansIfRemovedFrom(data?.entries ?? [], selected, codes);
    setConfirmAction({ kind: 'purge', codes, orphanCount });
  };

  const doUnlink = async (codes: string[]) => {
    if (selected === null) return;
    try {
      // 벌크 엔드포인트가 없어 순차 실행한다(doMove 와 같은 관용구). 중간에 실패하면
      // 앞쪽만 빠진 상태로 끝나므로 선택을 남겨 재시도할 수 있게 한다.
      for (const code of codes) await removeMemberM.mutateAsync({ folderId: selected, code });
      setChecked(new Set());
    } catch {
      // 낙관적 캐시는 mutation 의 onError 가 롤백한다; 선택은 유지.
    }
  };

  const doPurge = async (codes: string[]) => {
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
        {/* 부분 선택은 `mixed` 다(WAI-ARIA tri-state checkbox). 이전엔 2/10 을 골라도
            `false` 라 "일부가 선택됐다" 를 보조기술이 알 수 없었다. **시각 쪽은 옆의 개수가
            담당한다** — CheckIcon 은 보조지표 패널·그룹 피커 등 6곳이 공유하는 glyph 라
            여기 사정으로 dash 상태를 늘리지 않는다. */}
        <button type="button" role="checkbox" aria-label="전체 선택"
          aria-checked={allChecked ? 'true' : selectedCodes.length > 0 ? 'mixed' : 'false'}
          onClick={toggleAll} className="flex items-center cursor-pointer">
          <CheckIcon filled={allChecked} size={16} />
        </button>
        {/* 선택 개수 — 파괴적 액션(관심 해제) 앞에서 "몇 개를 지우는지" 가 안 보이면 안 된다.
            0 일 때 **언마운트하지 않고 invisible** 로 자리를 지킨다: 사라지면 오른쪽 버튼들이
            통째로 왼쪽으로 점프한다. 숫자 자릿수가 늘 때의 미세 이동은 `tabular-nums` +
            최소 폭(4.5rem = 72px)이 잡는다 — 실측으로 "9999개 선택" 까지 72px 안이라
            min-w 가 항상 지배하고, 0·1·40개 세 상태에서 오른쪽 버튼 x 좌표가 동일했다
            (707 / 762 / 857 고정). */}
        <span data-testid="selection-count"
          className={`min-w-[4.5rem] font-data tabular-nums text-xs text-fg-dim ${
            selectedCodes.length === 0 ? 'invisible' : ''}`}>
          {selectedCodes.length}개 선택
        </span>
        <div className="relative" ref={moveMenuRef}>
          <button type="button" disabled={selectedCodes.length === 0} onClick={() => setMoveMenu((v) => !v)}
            className="px-2 py-1 rounded border border-border text-xs text-fg-dim hover:text-accent disabled:opacity-40">⇄ 이동</button>
          {moveMenu && (
            <div role="menu" className="absolute z-10 mt-1 bg-bg-card border border-border rounded shadow-lg min-w-[140px]">
              {folders.filter((f) => f.id !== selected).map((f) => (
                <button key={f.id} role="menuitem" onClick={() => doMove(f.id)}
                  className="block w-full text-left px-3 py-1.5 text-sm hover:bg-bg-input-hover">{f.name}</button>
              ))}
            </div>
          )}
        </div>
        {/* 실폴더에서만 의미가 있다 — 미분류 뷰에는 뺄 그룹이 없다. */}
        {selected !== null && (
          <button type="button" disabled={selectedCodes.length === 0} onClick={requestUnlink}
            className="px-2 py-1 rounded border border-border text-xs text-fg-dim hover:text-accent disabled:opacity-40">
            이 그룹에서 빼기
          </button>
        )}
        <button type="button" disabled={selectedCodes.length === 0} onClick={requestPurge}
          className="px-2 py-1 rounded border border-border text-xs text-fg-dim hover:text-error disabled:opacity-40">
          관심 해제
        </button>
        <div className="flex-1" />
        <span className="text-xs text-fg-dim">직접 설정한 순</span>
      </div>

      {/* add form — v3: 실폴더 선택 시에만(미분류 추가 대상 없음) */}
      {selected !== null && (
        <div className="px-3 py-2 border-b border-border">
          <WatchlistAddForm folderId={selected}
            onAdded={(hit) => setRecentAction({ kind: 'added', code: hit.code, name: hit.name })} />
        </div>
      )}

      {/* feedback banner (added / caught_up_one) — modal owns this feedback instance */}
      {recentAction?.kind === 'added' && (
        <div className="mx-3 mt-2"><Banner kind="success">{`✓ ${symbolLabel(recentAction)} 추가됨`}</Banner></div>
      )}
      {recentAction?.kind === 'caught_up_one' && (
        <div className="mx-3 mt-2">
          <Banner kind={recentAction.error ? 'error' : 'success'}>{formatCaughtUpOneMessage(recentAction)}</Banner>
        </div>
      )}

      {/* list — drag-reorder within the selected folder / 미분류 */}
      <ul className="flex-1 overflow-auto" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        <SortableContext items={entries.map((e) => e.code)} strategy={verticalListSortingStrategy}>
          {entries.map((e) => (
            <SortableEntryRow key={e.code} entry={e} checked={checked.has(e.code)} onToggle={() => toggle(e.code)}
              onCatchup={() => onCatchup(e.code, e.name)}
              catchingUp={catchupOneM.isPending && catchupOneM.variables === e.code} />
          ))}
        </SortableContext>
        {entries.length === 0 && <li className="p-4 text-sm text-fg-dim">이 그룹에 종목이 없습니다</li>}
      </ul>

      {confirmAction && (
        <ConfirmModal
          message={confirmAction.kind === 'unlink'
            ? <>선택한 <b className="font-data">{confirmAction.codes.length}</b>종목 중{' '}
                <b className="font-data">{confirmAction.orphanCount}</b>종목은 이 그룹에만 있어
                관심종목에서 빠집니다(데이터 수집 중단)</>
            : <>선택한 <b className="font-data">{confirmAction.codes.length}</b>종목이
                <b> 모든 그룹</b>에서 빠집니다(데이터 수집 중단)
                {confirmAction.orphanCount < confirmAction.codes.length && <>
                  {' '}— 이 중 <b className="font-data">{confirmAction.codes.length - confirmAction.orphanCount}</b>종목은
                  다른 그룹에도 있습니다
                </>}</>}
          confirmLabel={confirmAction.kind === 'unlink' ? '빼기' : '관심 해제'}
          tone="destructive"
          onConfirm={() => {
            const { kind, codes } = confirmAction;
            setConfirmAction(null);
            void (kind === 'unlink' ? doUnlink(codes) : doPurge(codes));
          }}
          onClose={() => setConfirmAction(null)} />
      )}
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
  'relative grid grid-cols-[16px_1fr_8ch_2.5ch] items-center gap-2 px-3 py-2 border-b border-border text-sm hover:bg-bg-input touch-none';

function SortableEntryRow(props: RowProps) {
  const { entry } = props;
  const { listeners, attributes, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, activeIndex, overIndex, index } =
    useSortable({ id: entry.code });
  const dropIndicator = activeIndex !== -1 && overIndex !== -1 && index === overIndex && index !== activeIndex
    ? (activeIndex < overIndex ? 'after' : 'before')
    : undefined;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? sortableDraggingStyle() : {}),
    ...(dropIndicator ? { position: 'relative' } : {}),
  };
  return (
    <li ref={(node) => { setNodeRef(node); setActivatorNodeRef(node); }}
      {...attributes}
      {...listeners}
      style={style}
      data-testid={`edit-row-${entry.code}`}
      className={`${ROW_CLASS} ${dropIndicatorClass(dropIndicator)}`}>
      <button type="button" role="checkbox" aria-checked={props.checked} aria-label={`${entry.code} 선택`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={props.onToggle} className="flex items-center cursor-pointer">
        <CheckIcon filled={props.checked} size={16} />
      </button>
      <span className="truncate">{entry.name}</span>
      <LastSuccessBadge date={entry.last_success_date} />
      <button type="button" aria-label={`${entry.name} 수집`} onClick={props.onCatchup} disabled={props.catchingUp}
        onPointerDown={(e) => e.stopPropagation()}
        className={`text-fg-dimmer hover:text-accent disabled:opacity-40 ${props.catchingUp ? 'animate-spin' : ''}`}>↻</button>
    </li>
  );
}
