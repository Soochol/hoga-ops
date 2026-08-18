import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useWatchlist, useRemoveEntries, useRemoveMembers, useAddMember, useCatchupOne,
} from './useWatchlist';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { CheckIcon } from '../ui/CheckIcon';
import { useWatchlistFeedback } from './useWatchlistFeedback';
import { WatchlistAddForm } from './WatchlistAddForm';
import { Banner } from './Banner';
import { ConfirmModal } from '../ui/ConfirmModal';
import { MoveIcon } from '../ui/MoveIcon';
import { RefreshIcon } from '../ui/RefreshIcon';
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
  const removeMembersM = useRemoveMembers();
  const addMemberM = useAddMember();
  const catchupOneM = useCatchupOne();
  const { recentAction, setRecentAction } = useWatchlistFeedback();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [moveMenu, setMoveMenu] = useState(false);
  const [confirmAction, setConfirmAction] =
    useState<{ kind: 'unlink' | 'purge'; codes: string[]; orphanCount: number } | null>(null);
  // 중복 안내가 가리키는 행 — 잠깐 하이라이트하고 그 자리로 스크롤한다.
  const [duplicateCode, setDuplicateCode] = useState<string | null>(null);
  const duplicateTimer = useRef<number | null>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(moveMenu, moveMenuRef, () => setMoveMenu(false));

  // Multi-select is per-view: clear it when the viewed folder changes, else
  // checkmarks leak across folder switches (stale selection on a never-remounted pane).
  // 중복 하이라이트도 같이 끈다 — 다른 그룹으로 옮기면 그 행은 더 이상 보이지 않는다.
  useEffect(() => { setChecked(new Set()); setDuplicateCode(null); }, [selected]);

  // AddForm 에 넘기므로 **참조가 안정적이어야** 한다(매 렌더 새 함수면 그쪽이 매번 리렌더).
  const flashDuplicate = useCallback((code: string) => {
    setDuplicateCode(code);
    if (duplicateTimer.current !== null) window.clearTimeout(duplicateTimer.current);
    duplicateTimer.current = window.setTimeout(() => setDuplicateCode(null), DUPLICATE_FLASH_MS);
  }, []);
  useEffect(() => () => {
    if (duplicateTimer.current !== null) window.clearTimeout(duplicateTimer.current);
  }, []);

  // 하이라이트만으로는 부족하다 — 그 행이 화면 밖이면 아무것도 안 보인다(사용자의
  // 삼성화재가 40행 중 40번째였다). `'center'` 인 이유: `'nearest'` 면 리스트 끝에
  // 걸쳐서 "하이라이트가 잘린" 상태가 된다.
  useEffect(() => {
    if (duplicateCode === null) return;
    const row = document.querySelector(`[data-testid="edit-row-${duplicateCode}"]`);
    row?.scrollIntoView?.({ block: 'center' });
  }, [duplicateCode]);

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
      // v3 이동 = 대상 추가 후 출처 제거(멤버십, ADR-0070). **추가는 순차, 제거는 벌크**다.
      //
      // 이 비대칭이 부분 실패의 성격을 바꾼다: 추가가 중간에 실패하면 일부가 **양쪽 그룹에**
      // 있는 상태로 끝나는데, 다중 소속 모델에서 그건 **합법 상태**이고 재시도로 낫는다.
      // 반대로 제거가 순차였을 때는 "출처에서만 사라진" 유실이 날 수 있었다 — 그쪽을
      // 원자적 벌크로 옮겨 유실 모드를 없앤다. 서버 원자 move 는 만들지 않았다(중간
      // 상태가 합법이라 필요 없다).
      for (const code of codes) await addMemberM.mutateAsync({ folderId: targetId, code, name: '' });
      await removeMembersM.mutateAsync({ folderId: selected, codes });
      setChecked(new Set());
    } catch {
      // 낙관적 캐시는 mutation 의 onError 가 롤백; 선택은 유지해 재시도 가능.
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
      // **한 번의 요청**이다 — 서버가 한 락에서 처리하므로 전부 아니면 전무다.
      // (순차 루프였을 때는 중간 실패가 "절반만 빠짐" 으로 끝났다.)
      await removeMembersM.mutateAsync({ folderId: selected, codes });
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
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border text-xs text-fg-dim hover:text-accent disabled:opacity-40">
            <MoveIcon /> 이동
          </button>
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
        {/* 「직접 설정한 순」은 **컨트롤처럼 읽혔다** — 툴바 우측 끝이라는 자리가 패널의
            그룹별 정렬 컨트롤과 같고, "~순" 이라는 어미가 정렬 드롭다운을 연상시킨다.
            그런데 클릭해도 아무 일도 없다(정적 span).

            **정렬 선택기로 만들지 않는다.** 이 pane 의 드래그 재정렬은 `resolveDrag` 가
            `selectVisibleEntries` 의 order 인덱스와 맞물려 돌아가는 구조라, 등락률 정렬을
            허용하면 그 인덱스 계약이 깨진다(패널이 정렬 모드에서 행 드래그를 아예 끄는 것도
            같은 이유다). 이 화면의 순서는 **항상 직접 설정**이고, 문구가 그것을 말하면 된다.

            상태 서술에 조작 안내를 붙인다 — 드래그로 바꿀 수 있다는 것 자체가 이 화면에서
            발견하기 어려운 기능이었다. */}
        <span className="text-xs text-fg-dim">순서: 직접 설정 — 드래그로 변경</span>
      </div>

      {/* add form — v3: 실폴더 선택 시에만(미분류 추가 대상 없음) */}
      {selected !== null && (
        <div className="px-3 py-2 border-b border-border">
          {/* 이 pane 은 638px — 검색 입력이 넉넉해 2줄일 이유가 없다(팝오버와 반대). */}
          <WatchlistAddForm folderId={selected} layout="inline"
            onAdded={(hit) => setRecentAction({ kind: 'added', code: hit.code, name: hit.name })}
            onDuplicate={flashDuplicate} />
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

      {/* 컬럼 헤더 — **`<ul>` 밖**에 둔다. 안에 넣으면 리스트가 `overflow-auto` 라 스크롤
          할 때 같이 밀려 올라간다(sticky 를 얹을 수도 있지만, 형제로 두면 그럴 필요가 없다).
          행과 **같은 grid 상수**를 쓰므로 컬럼이 어긋나지 않는다.

          「마지막 수집」 라벨이 붙는 순간 `08/14`·`아직 없음` 이 무슨 날짜인지가 닫힌다 —
          그전까진 화면에 설명이 없었다. **「수집」이 맞는 어휘다**: 이 값은 Daily Scheduler
          캐치업의 마지막 성공일이라, 폴더 토글이 가르는 「실시간 저장」 축과 다르다(↻ 버튼의
          aria-label 도 이미 "수집" 이다). 재수집 컬럼은 아이콘만 있어 라벨을 비운다. */}
      {entries.length > 0 && (
        // ⚠ **컨테이너 폰트 크기를 행과 같게(`text-sm`) 유지한다.** 컬럼 폭이 `ch` 단위라
        // 폰트 크기에 비례하는데, 헤더에만 `text-2xs` 를 걸면 같은 `7ch` 가 다른 픽셀이 되어
        // **같은 클래스를 쓰고도 컬럼이 어긋난다**(실측: 코드 컬럼 헤더 1114 vs 행 1061).
        // 작은 글씨는 자식 span 이 쓴다. jsdom 은 레이아웃을 계산하지 않아 클래스 비교
        // 테스트로는 원리적으로 못 잡는 종류다 — 도그푸딩이 잡았다.
        <div data-testid="entry-column-header"
          className={`${GRID_COLS} py-1.5 border-b border-border text-sm text-fg-dimmer`}>
          <span aria-hidden />
          <span className="text-2xs uppercase">종목</span>
          <span className="text-2xs uppercase">코드</span>
          <span className="text-2xs uppercase">마지막 수집</span>
          <span aria-hidden />
        </div>
      )}

      {/* list — drag-reorder within the selected folder / 미분류 */}
      <ul className="flex-1 overflow-auto" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        <SortableContext items={entries.map((e) => e.code)} strategy={verticalListSortingStrategy}>
          {entries.map((e) => (
            <SortableEntryRow key={e.code} entry={e} checked={checked.has(e.code)} onToggle={() => toggle(e.code)}
              flash={duplicateCode === e.code}
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

const DUPLICATE_FLASH_MS = 2500;

type RowProps = {
  entry: WatchlistEntry; checked: boolean; onToggle: () => void;
  /** 중복 안내가 가리키는 행 — 공용 `.row-flash`(global.css) 를 쓴다. 배경 클래스가
   *  아닌 이유가 거기 적혀 있다: 행은 이미 hover·선택 틴트를 갖고 있어 **칠해진 행에서는
   *  배경 flash 가 안 보인다**(실측으로 그렇게 죽었다). box-shadow 는 그 위에 겹친다. */
  flash?: boolean;
  onCatchup: () => void; catchingUp: boolean;
};

// 1st col 16px = CheckIcon size (보조지표 IndicatorPanel과 같은 glyph; 행 밀도 때문에 18 대신 16).
//
// **종목코드 컬럼은 v0.6.1.0(#34)의 "표시하지 않음" 결정을 뒤집은 것이다.** 그때는 코드가
// 체크박스 aria-label 에만 남았는데, 근거 두 가지가 그 판단을 이긴다: (1) 이 pane 은 시세도
// 등락률도 없는 **관리 화면**이라 행을 특정할 단서가 이름뿐이었고, (2) 우선주·스팩처럼 이름이
// 겹치는 계열을 화면에서 구별할 방법이 없었다. 코드는 6자리 고정이라 7ch 면 충분하다.
//
// **인라인(`이름 코드`)이 아니라 전용 컬럼인 이유**: 인라인이면 truncate 가 이름과 코드를 한
// 덩어리로 잘라 **긴 이름에서 코드가 먼저 사라진다** — 구별하려고 넣은 것이 구별이 필요한
// 상황에서 없어진다.
//
// 헤더 행과 **같은 상수를 공유한다**. 따로 적으면 컬럼이 조용히 어긋난다.
const GRID_COLS = 'grid grid-cols-[16px_1fr_7ch_8ch_2.5ch] items-center gap-2 px-3';
const ROW_CLASS =
  `relative ${GRID_COLS} py-2 border-b border-border text-sm hover:bg-bg-input touch-none`;

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
      className={`${ROW_CLASS} ${dropIndicatorClass(dropIndicator)} ${
        props.flash ? 'row-flash' : ''}`}>
      <button type="button" role="checkbox" aria-checked={props.checked} aria-label={`${entry.code} 선택`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={props.onToggle} className="flex items-center cursor-pointer">
        <CheckIcon filled={props.checked} size={16} />
      </button>
      <span className="truncate" title={entry.name}>{entry.name}</span>
      <span className="font-data tabular-nums text-xs text-fg-dim">{entry.code}</span>
      <LastSuccessBadge date={entry.last_success_date} />
      <button type="button" aria-label={`${entry.name} 수집`} onClick={props.onCatchup} disabled={props.catchingUp}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex items-center justify-center text-fg-dimmer hover:text-accent disabled:opacity-40">
        <RefreshIcon className={`w-[1em] h-[1em] ${props.catchingUp ? 'animate-spin' : ''}`} />
      </button>
    </li>
  );
}
