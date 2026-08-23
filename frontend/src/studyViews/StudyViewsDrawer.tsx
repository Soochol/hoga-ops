import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { StudyViewListRow } from '../api/studyViews';
import { dropPoint, isPointOnStudy, useEntryDragStore } from '../state/entryDrag';
import {
  activeStudyGroup,
  studyGroupViewFromSave,
  useStudyWorkspaceStore,
} from '../state/studyWorkspace';
import { wantsNewTab } from '../live/useJumpToLive';
import { activateLiveCode } from '../live/liveNavigate';
import { useLivePageStore } from '../state/livePage';
import { savedRangeFocusFromView } from './savedRangeFocus';
import { openSavedViewInNewTab } from './studyDeepLink';
import { latestStudyViewForCode } from './studyViewSelection';
import { useStudyViewMutations, useStudyViews } from './useStudyViews';
import {
  RailDrawer,
  RailDrawerBody,
  RailDrawerHeader,
  RailDrawerSection,
  RailGroupHeader,
  RailState,
  RailToolbarIconButton,
  RailTreeRow,
} from '../ui/RailShell';
import { CollapseAllIcon, ExpandAllIcon } from '../ui/CollapseAllIcon';
import { ChevronIcon } from '../ui/ChevronIcon';
import { SortCycleButton } from '../ui/SortCycleButton';
import { normalizeStudyViewQuery } from './studyViewTree';
import {
  resolveStudyViewTreeDrag,
  studyViewGroupDndId,
  studyViewRowDndId,
  studyViewTreeCollision,
} from './studyViewTreeDnd';
import { useStudyViewTreeState } from './useStudyViewTreeState';
import { StudyViewRowMenu } from './StudyViewRowMenu';

/** 삭제 유예(ms) — 이 시간 안에 "실행 취소"를 누르면 서버 DELETE 자체가 나가지 않는다. */
const DELETE_UNDO_MS = 5000;

export function filterStudyViews<T extends { name: string; code: string; memo: string }>(rows: T[], query: string): T[] {
  const q = normalizeStudyViewQuery(query);
  if (!q) return rows;
  return rows.filter((row) => [row.name, row.code, row.memo].some((v) => normalizeStudyViewQuery(v).includes(q)));
}

/** YYYYMMDD → "YYYY-MM-DD", `withYear=false` 면 "MM-DD".
 *
 *  원래는 "같은 연도 가정" 으로 연도를 통째로 버렸는데, 저장뷰는 해를 넘겨 쌓이므로
 *  그 전제가 성립하지 않았다 — 목록만 봐선 어느 해의 복기인지 알 수 없다. 이제
 *  연도를 다는 것이 기본이고, 생략은 아래 범위 표기에서 **앞뒤 연도가 같을 때만**
 *  쓰는 축약이다. */
function shortDate(yyyymmdd: string, withYear: boolean): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
  const monthDay = `${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  return withYear ? `${yyyymmdd.slice(0, 4)}-${monthDay}` : monthDay;
}

/** 저장뷰 아이템 메타 = 타임프레임 · 복기 대상일(범위면 from~to). 종목은 그룹
 *  헤더가 이미 이므로 생략 — 아이템엔 "무엇을 저장했나"(분봉·날짜)만 남긴다.
 *
 *  범위가 한 해 안에 있으면 `to` 쪽 연도를 접는다(`2026-07-01~07-08`). 메타행이
 *  `truncate` 라 넘치면 잘려 나가는 게 하필 `to` 날짜여서, 폭을 아끼는 편이
 *  같은 연도를 두 번 찍는 것보다 읽힌다. 해를 걸치면 접지 않는다. */
export function formatStudyViewMeta(row: { timeframe: string; range: { from_date: string; to_date: string } }): string {
  const { from_date, to_date } = row.range;
  if (from_date === to_date) return `${row.timeframe} · ${shortDate(from_date, true)}`;
  const sameYear = from_date.slice(0, 4) === to_date.slice(0, 4);
  return `${row.timeframe} · ${shortDate(from_date, true)}~${shortDate(to_date, !sameYear)}`;
}

function ClearSearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function SortableStudyViewGroup({
  id,
  code,
  disabled,
  children,
}: {
  id: string;
  code: string;
  disabled: boolean;
  children: (listeners: DraggableSyntheticListeners | undefined) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: studyViewGroupDndId(id),
    disabled,
    data: { type: 'group', code },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.65, position: 'relative', zIndex: 20 } : {}),
      }}
    >
      {children(listeners)}
    </div>
  );
}

function SortableStudyViewRow({
  row,
  groupKey,
  disabled,
  children,
}: {
  row: StudyViewListRow;
  groupKey: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: studyViewRowDndId(row.id),
    disabled,
    data: { type: 'row', groupKey },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.65, position: 'relative', zIndex: 10 } : {}),
      }}
    >
      {children}
    </div>
  );
}

export function StudyViewsDrawer() {
  const { data, isLoading, isError, refetch } = useStudyViews();
  const mutations = useStudyViewMutations();
  const [rowMenu, setRowMenu] = useState<{ row: StudyViewListRow; left: number; top: number } | null>(null);
  const [renameState, setRenameState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const [memoState, setMemoState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StudyViewListRow | null>(null);
  const renameCommittingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const memoCommittingRef = useRef(false);
  const memoInputRef = useRef<HTMLTextAreaElement>(null);
  const pendingDeleteTimerRef = useRef<number | null>(null);
  const navigateClickTimerRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  // 삭제 유예 중인 행은 트리·그룹 최신뷰 계산 모두에서 즉시 사라져야 하므로
  // 소스 배열 단계에서 걸러낸다(실행 취소 시 원배열 복귀 = 상태 복원).
  const allSaves = data?.saves ?? [];
  const saves = pendingDelete ? allSaves.filter((row) => row.id !== pendingDelete.id) : allSaves;
  const {
    query,
    setQuery,
    sortAction,
    cycleSortMode,
    dragEnabled,
    visibleGroups,
    visibleGroupsCollapsed,
    isCollapsed,
    toggleGroup,
    toggleVisibleGroups,
    reorderGroup,
    reorderRow,
  } = useStudyViewTreeState(saves);
  const currentStudyViewId = useMemo(() => new URLSearchParams(location.search).get('view'), [location.search]);
  // 스토어를 읽는 이유: 이 드로어는 **우측 레일의 전역 컴포넌트**라 `/live` 등 다른
  // 라우트에서는 URL 에 `?view=` 가 아예 없다. URL 만 보면 그 라우트들에서 행 하이라이트가
  // 통째로 사라진다.
  //
  // ADR-0155 로 **열린 뷰가 여럿**이 됐다(그룹마다 하나). 하이라이트도 집합이다 — 하나만
  // 칠하면 그룹 2 에서 보고 있는 뷰가 목록에서 "안 열린 것" 으로 보인다.
  const groupViews = useStudyWorkspaceStore((s) => s.groupViews);
  const openStudyViewIds = useMemo(() => {
    const ids = new Set<string>();
    for (const view of Object.values(groupViews)) if (view) ids.add(view.viewId);
    // URL 폴백은 그룹이 아직 하이드레이션되기 전(딥링크 첫 프레임)을 메운다.
    if (ids.size === 0 && currentStudyViewId) ids.add(currentStudyViewId);
    return ids;
  }, [groupViews, currentStudyViewId]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const startEntryDrag = useEntryDragStore((s) => s.startDrag);
  const setOverStudy = useEntryDragStore((s) => s.setOverStudy);
  const endEntryDrag = useEntryDragStore((s) => s.endDrag);
  useEffect(() => () => {
    if (navigateClickTimerRef.current === null) return;
    window.clearTimeout(navigateClickTimerRef.current);
    navigateClickTimerRef.current = null;
  }, []);

  useEffect(() => {
    if (!renameState) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameState?.id]);

  useEffect(() => {
    if (!memoState) return;
    memoInputRef.current?.focus();
    memoInputRef.current?.select();
  }, [memoState?.id]);

  const startRename = (row: StudyViewListRow) => {
    setMemoState(null);
    setRenameState({ id: row.id, value: row.name, error: null });
  };

  const cancelRename = () => {
    renameCommittingRef.current = false;
    setRenameState(null);
  };

  const startMemoEdit = (row: StudyViewListRow) => {
    setRenameState(null);
    setMemoState({ id: row.id, value: row.memo, error: null });
  };

  const cancelMemoEdit = () => {
    memoCommittingRef.current = false;
    setMemoState(null);
  };

  function cancelPendingStudyViewNavigation() {
    if (navigateClickTimerRef.current === null) return;
    window.clearTimeout(navigateClickTimerRef.current);
    navigateClickTimerRef.current = null;
  }

  /** `/study` 그룹 드롭의 앱 내 이동. 경로를 `studyDeepLink` 에서 빌려 오지 않고
   *  리터럴로 두는 것이 의도다 — 그 모듈은 이제 **`/live` 딥링크**를 만들고(북마크·새
   *  탭), 이쪽은 드롭이 일어난 그 페이지에 머무는 이동이라 목적지가 서로 다르다.
   *  이 리터럴은 `/study` 와 함께 죽는다. */
  function navigateToStudyView(row: StudyViewListRow) {
    cancelPendingStudyViewNavigation();
    navigate(`/study?view=${encodeURIComponent(row.id)}`);
  }

  /**
   * 저장뷰를 `/study` 의 활성 그룹에서 연다 — 그 그룹의 뷰를 제자리 교체한다
   * (ADR-0155).
   *
   * ⚠ **이제 소비자가 하나뿐이다: `/study` 캔버스로의 그룹 드롭.** 행 클릭·키보드
   * Enter·행 메뉴 「열기」는 2026-08-21 결정으로 전부 `openSavedRangeInLive`(→`/live`)
   * 로 옮겼다. 이 함수가 남은 이유는 드롭 타깃이 `/study` 페이지 안에만 존재하기
   * 때문이다 — 거기에 떨어뜨린 것을 다른 페이지로 보내면 제스처가 거짓말이 된다.
   *
   * 활성 그룹은 포커스 창에서 파생하므로, 그룹 2 창을 누른 뒤 드롭하면 그룹 2 만
   * 갈아탄다. 다른 그룹 창들은 그대로다 — 그게 나란히 비교라는 이 기능의 요점이다.
   *
   * 앱 안에 **탭**이 쌓이는 자리는 여전히 없다(ADR-0149): 탭바도 disposition 도
   * 되살아나지 않았다. 뷰를 여럿 여는 축이 탭에서 **그룹**으로 바뀌었을 뿐이다.
   *
   * 다른 뷰를 곁눈질하려면 **브라우저 탭**도 그대로 쓸 수 있다 — 행 ctrl/⌘+클릭이
   * `openSavedViewInNewTab` 으로 `/live?view=` 딥링크를 새 탭에 띄우고, 이 함수는 그 경로에서
   * 아예 호출되지 않는다(그래야 이 탭의 그룹들이 그대로다). 두 「탭」의 구별은
   * `studyDeepLink.ts` 도크스트링에 있다.
   *
   * 봉은 넘기지 않는다 — 차트 창이 유일한 소유자다(#1326). 저장뷰가 정하는 것은
   * 종목과 구간이다.
   */
  function openStudyView(row: StudyViewListRow) {
    const workspace = useStudyWorkspaceStore.getState();
    workspace.setGroupView(activeStudyGroup(workspace), studyGroupViewFromSave(row));
    navigateToStudyView(row);
  }

  /**
   * 저장뷰를 **`/live` 에서 연다** — 행 클릭의 목적지 (2026-08-21 사용자 결정,
   * `/study` 진입로를 대체한다).
   *
   * 두 단계이고 **순서가 계약이다**:
   *  1. `activateLiveCode` — 종목 교체. 목적지는 `activationTarget` 이 고르므로
   *     **포커스 그룹만** 바뀌고 **핀 걸린 창은 건드리지 않는다**(ADR-0153).
   *     이 호출이 이전 슬롯을 해제한다(종목이 다를 때만).
   *  2. `focusSavedRange` — 기간 슬롯 세팅. 반드시 **나중**이다. 역순이면 1단계의
   *     해제 트리거가 방금 세운 슬롯을 스스로 지운다.
   *
   * 여기서 `/study` 워크스페이스(`setGroupView`)는 건드리지 않는다 — 두 페이지가
   * 같은 저장뷰 슬롯을 공유하면 `/live` 클릭이 `/study` 창 배치를 조용히 바꾼다.
   *
   * ctrl/⌘+클릭은 이 함수를 부르지 않지만 **목적지는 같다** — 새 브라우저 탭에서
   * `/live?view=` 를 열고(`openSavedViewInNewTab`), 착지 쪽이 여기와 같은 두 단계를
   * 같은 순서로 밟는다(`useSavedRangeDeepLink`). 2026-08-23 까지는 그쪽만 `/study`
   * 새 탭이라 같은 행의 두 제스처가 다른 페이지로 갈라져 있었다.
   */
  function openSavedRangeInLive(row: StudyViewListRow) {
    cancelPendingStudyViewNavigation();
    activateLiveCode(row.code, row.label);
    useLivePageStore.getState().focusSavedRange(savedRangeFocusFromView(row));
    if (location.pathname !== '/live') navigate('/live');
  }

  function scheduleStudyViewNavigation(row: StudyViewListRow) {
    cancelPendingStudyViewNavigation();
    navigateClickTimerRef.current = window.setTimeout(() => {
      navigateClickTimerRef.current = null;
      openSavedRangeInLive(row);
    }, 180);
  }

  const commitRename = (row: StudyViewListRow) => {
    if (!renameState || renameState.id !== row.id || renameCommittingRef.current) return;
    const name = renameState.value.trim();
    if (!name || name === row.name) {
      cancelRename();
      return;
    }
    renameCommittingRef.current = true;
    mutations.updateMetadata.mutate(
      { id: row.id, body: { name } },
      {
        onSuccess: () => cancelRename(),
        onError: (error) => {
          renameCommittingRef.current = false;
          setRenameState((current) => current?.id === row.id
            ? { ...current, error: error instanceof Error ? error.message : '이름 변경에 실패했습니다' }
            : current);
        },
      },
    );
  };

  const commitMemo = (row: StudyViewListRow) => {
    if (!memoState || memoState.id !== row.id || memoCommittingRef.current) return;
    const memo = memoState.value.trim();
    if (memo === row.memo) {
      cancelMemoEdit();
      return;
    }
    memoCommittingRef.current = true;
    mutations.updateMetadata.mutate(
      { id: row.id, body: { memo } },
      {
        onSuccess: () => cancelMemoEdit(),
        onError: (error) => {
          memoCommittingRef.current = false;
          setMemoState((current) => current?.id === row.id
            ? { ...current, error: error instanceof Error ? error.message : '메모 저장에 실패했습니다' }
            : current);
        },
      },
    );
  };

  const executeDelete = (row: StudyViewListRow) => {
    const deletedId = row.id;
    mutations.remove.mutate(deletedId, {
      onSuccess: () => {
        // 지운 뷰를 보던 **모든 그룹**을 비운다(ADR-0155). 남은 뷰 중 하나로 자동
        // 이동하지 않는 것은 ADR-0149 그대로다 — 사용자가 지운 직후 뜻밖의 뷰가 뜨는
        // 것보다 빈 상태가 낫고, 빈 상태에는 "저장뷰 열기" 버튼이 있다.
        //
        // 그룹이 여럿일 수 있으므로 "활성 그룹만" 이 아니다: 같은 뷰를 두 그룹에서
        // 보고 있었다면 한쪽만 비우고 다른 쪽이 삭제된 뷰를 계속 조회한다.
        useStudyWorkspaceStore.getState().clearGroupsOfView(deletedId);
        if (location.pathname === '/study' && currentStudyViewId === deletedId) {
          navigate('/study');
        }
      },
    });
  };

  // 언마운트(패널 전환) 시점의 flush 가 stale location/mutation 을 잡지 않도록
  // 최신 클로저를 ref 로 유지한다.
  const executeDeleteRef = useRef(executeDelete);
  useEffect(() => { executeDeleteRef.current = executeDelete; });
  const pendingDeleteRef = useRef<StudyViewListRow | null>(null);
  useEffect(() => { pendingDeleteRef.current = pendingDelete; }, [pendingDelete]);

  /** 유예 삭제 — 행은 즉시 사라지고, DELETE 는 유예 후에만 나간다. 유예 중 다른
   *  삭제가 오면 앞선 것은 그 자리에서 확정한다(단일 실행취소 슬롯). */
  const requestDelete = (row: StudyViewListRow) => {
    if (pendingDeleteTimerRef.current !== null) {
      window.clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
      if (pendingDeleteRef.current) executeDeleteRef.current(pendingDeleteRef.current);
    }
    setPendingDelete(row);
    pendingDeleteTimerRef.current = window.setTimeout(() => {
      pendingDeleteTimerRef.current = null;
      setPendingDelete(null);
      executeDeleteRef.current(row);
    }, DELETE_UNDO_MS);
  };

  const undoDelete = () => {
    if (pendingDeleteTimerRef.current !== null) {
      window.clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
    }
    setPendingDelete(null);
  };

  // 유예가 남은 채로 패널이 닫히면 삭제 의사는 이미 확정된 것 — 즉시 flush.
  useEffect(() => () => {
    if (pendingDeleteTimerRef.current !== null) {
      window.clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
    }
    if (pendingDeleteRef.current) executeDeleteRef.current(pendingDeleteRef.current);
  }, []);

  const handleDragStart = (event: DragStartEvent) => {
    if (event.active.data.current?.type !== 'group') return;
    const draggedGroup = event.active.data.current as { code?: string };
    if (draggedGroup.code) startEntryDrag(draggedGroup.code);
  };

  const handleDragMove = (event: DragMoveEvent) => {
    if (event.active.data.current?.type !== 'group') return;
    setOverStudy(isPointOnStudy(dropPoint(event)));
  };

  const handleDragCancel = () => {
    endEntryDrag();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const wasGroupDrag = event.active.data.current?.type === 'group';
    endEntryDrag();
    if (event.active.data.current?.type === 'group' && isPointOnStudy(dropPoint(event))) {
      const draggedGroup = visibleGroups.find((group) => studyViewGroupDndId(group.key) === String(event.active.id));
      const save = draggedGroup ? latestStudyViewForCode(saves, draggedGroup.code) : null;
      if (save) openStudyView(save);
      return;
    }

    if (wasGroupDrag && !event.over) return;
    const intent = resolveStudyViewTreeDrag(event);
    if (!intent) return;
    if (intent.type === 'group') {
      reorderGroup(intent.activeKey, intent.overKey);
      return;
    }
    reorderRow(intent.groupKey, intent.activeId, intent.overId);
  };

  const renderStudyViewRow = (row: StudyViewListRow) => {
    const isActive = openStudyViewIds.has(row.id);
    const isEditing = renameState?.id === row.id || memoState?.id === row.id;
    return (
      <RailTreeRow
        key={row.id}
        className="group"
        role={isEditing ? undefined : 'button'}
        tabIndex={isEditing ? undefined : 0}
        aria-label={isEditing ? undefined : `${row.name} 저장뷰 열기`}
        aria-current={isActive ? 'true' : undefined}
        style={{
          background: isActive ? 'var(--tint-selection)' : 'transparent',
        }}
        // Ctrl/⌘+클릭 = **브라우저** 새 탭. ADR-0149 가 없앤 것은 앱 안의 저장뷰 탭이고
        // (그 disposition 은 되살리지 않는다), 여기서 타는 것은 같은 ADR §7 이 정식 경로로
        // 못박은 `?view=` 딥링크다 — 새 상태가 0이라 결정과 충돌하지 않는다.
        //
        // 지연 스케줄(180ms — 이름 변경 더블클릭과의 모호성 해소)을 **거치지 않는다**:
        // 수정자 클릭에는 그 모호성이 없고, 사용자 제스처 핸들러 안에서 동기로 열어야
        // 팝업 차단에 걸리지 않는다. **이 탭은 아무것도 바뀌지 않는 것이 계약**이라
        // `openSavedRangeInLive`(종목 활성화 + 기간 슬롯)도 `openStudyView`(=`setGroupView`
        // + navigate)도 부르지 않는다 — 새 탭이 URL 로 자기 상태를 세운다.
        onClick={isEditing ? undefined : (e) => {
          if (wantsNewTab(e)) {
            cancelPendingStudyViewNavigation();
            openSavedViewInNewTab(row.id);
            return;
          }
          scheduleStudyViewNavigation(row);
        }}
        onContextMenu={isEditing ? undefined : (e) => {
          e.preventDefault();
          setRowMenu({ row, left: e.clientX, top: e.clientY });
        }}
        onKeyDown={isEditing ? undefined : (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          openSavedRangeInLive(row);
        }}
      >
        {renameState?.id === row.id ? (
          <div className="min-w-0 flex-1 space-y-1">
            <input
              aria-label="저장뷰 이름 수정"
              autoFocus
              ref={renameInputRef}
              value={renameState.value}
              onChange={(e) => setRenameState({ ...renameState, value: e.target.value, error: null })}
              onBlur={() => commitRename(row)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename(row);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              className="w-full rounded border border-border bg-bg-input px-1 py-0.5 text-xs text-fg"
            />
            {renameState.error && <div className="text-xs text-danger">{renameState.error}</div>}
          </div>
        ) : memoState?.id === row.id ? (
          <div className="min-w-0 flex-1 space-y-1">
            <div className="truncate text-xs text-fg">{row.name}</div>
            <textarea
              aria-label="저장뷰 메모 수정"
              autoFocus
              ref={memoInputRef}
              rows={2}
              value={memoState.value}
              onChange={(e) => setMemoState({ ...memoState, value: e.target.value, error: null })}
              onBlur={() => commitMemo(row)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitMemo(row);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelMemoEdit();
                }
              }}
              className="w-full resize-none rounded border border-border bg-bg-input px-1 py-0.5 text-xs text-fg"
            />
            {memoState.error && <div className="text-xs text-danger">{memoState.error}</div>}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 leading-tight">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-border bg-bg" aria-hidden />
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-xs text-fg"
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelPendingStudyViewNavigation();
                  startRename(row);
                }}
              >
                {row.name}
              </div>
              {/* 메타행 — 저장뷰 이름만으론 "무엇을 저장했나"를 알 수 없던 것 보완:
                  타임프레임 · 복기 대상일(종목은 그룹 헤더가 이미 표시). */}
              <div className="truncate text-badge text-fg-dimmer tabular-nums">
                {formatStudyViewMeta(row)}
              </div>
              {/* 메모 미리보기(첫 줄) — 검색만 되고 화면엔 없던 복기 노트를 목록에서
                  바로 훑을 수 있게 한다. 메타보다 한 단계 밝은 fg-dim 으로 구분. */}
              {row.memo && (
                <div className="truncate text-badge text-fg-dim">{row.memo.split('\n', 1)[0]}</div>
              )}
            </div>
            {/* 행 메뉴 ⋯ — 평시 opacity-0 + pointer-events-none 이라 클릭이 행(열기)으로
                통과하고, 호버/포커스 시에만 보이며 클릭 가능(관심종목 RowTrailing 과 동일
                계약). opacity(=DOM 유지)라 Tab 포커스가 닿는다. */}
            <button
              type="button"
              aria-label={`${row.name} 행 메뉴`}
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                cancelPendingStudyViewNavigation();
                setRowMenu({ row, left: e.clientX, top: e.clientY });
              }}
              className="shrink-0 grid place-items-center px-1 leading-none text-fg-dimmer hover:text-fg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
            >
              ⋯
            </button>
          </div>
        )}
      </RailTreeRow>
    );
  };

  return (
    <RailDrawer id="right-rail-saved-views-panel" ariaLabel="저장뷰">
      <RailDrawerHeader
        title="저장뷰"
      />
      <RailDrawerSection className="p-3">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <input
                aria-label="저장뷰 검색"
                placeholder="검색하세요"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full bg-bg-input border rounded py-1 pl-2 pr-8 text-sm"
              />
              {query && (
                <button
                  type="button"
                  aria-label="검색어 지우기"
                  title="검색어 지우기"
                  onClick={() => setQuery('')}
                  className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                >
                  <ClearSearchIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {visibleGroups.length > 0 && (
              <div className="flex shrink-0 gap-1">
                <RailToolbarIconButton
                  type="button"
                  onClick={toggleVisibleGroups}
                  aria-label={visibleGroupsCollapsed ? '전체 펼치기' : '전체 접기'}
                  title={visibleGroupsCollapsed ? '전체 펼치기' : '전체 접기'}
                >
                  {visibleGroupsCollapsed
                    ? <ExpandAllIcon className="h-4 w-4" />
                    : <CollapseAllIcon className="h-4 w-4" />}
                </RailToolbarIconButton>
                <SortCycleButton
                  onClick={cycleSortMode}
                  direction={sortAction.direction === 'default' ? 'none' : sortAction.direction}
                  label={sortAction.label}
                />
              </div>
            )}
          </div>
      </RailDrawerSection>
        {isLoading && <RailState>불러오는 중</RailState>}
        {isError && (
          <RailState tone="error">
            <p>저장뷰를 불러오지 못했습니다</p>
            <button type="button" onClick={() => refetch()} className="mt-2 underline">다시 시도</button>
          </RailState>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) === 0 && (
          <RailState>저장된 뷰가 없습니다</RailState>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) > 0 && visibleGroups.length === 0 && (
          <RailState>검색 결과가 없습니다</RailState>
        )}
        <RailDrawerBody>
          <DndContext
            sensors={sensors}
            collisionDetection={studyViewTreeCollision}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={visibleGroups.map((group) => studyViewGroupDndId(group.key))} strategy={verticalListSortingStrategy}>
              {visibleGroups.map((group) => {
                const groupCollapsed = isCollapsed(group.key);
                return (
                  <SortableStudyViewGroup key={group.key} id={group.key} code={group.code} disabled={!dragEnabled}>
                    {(groupDragListeners) => (
                      <section aria-label={`${group.label} ${group.code} 저장뷰`}>
                        <RailGroupHeader
                          type="button"
                          {...(groupDragListeners ?? {})}
                          aria-label={`${group.label} ${group.code} ${groupCollapsed ? '펼치기' : '접기'}`}
                          aria-expanded={!groupCollapsed}
                          title={`${group.label} ${group.code}`}
                          // Ctrl/⌘+클릭 = 그 종목의 최신 저장뷰를 앱 탭으로 열던 분기는
                          // ADR-0149 로 사라졌다. 헤더 클릭은 이제 접기/펼치기 하나다.
                          // 행에 생긴 브라우저 새 탭(ctrl/⌘+클릭)을 여기까지 넓히지 않은 것은
                          // 의도다 — 헤더의 클릭 하나는 접기이고, 어느 뷰를 열지는 헤더가
                          // 아니라 행이 정한다.
                          onClick={() => {
                            toggleGroup(group.key);
                          }}
                          className={dragEnabled ? 'cursor-grab active:cursor-grabbing' : ''}
                          leading={<span className="text-fg-dimmer"><ChevronIcon collapsed={groupCollapsed} /></span>}
                          count={group.rows.length}
                        >
                          {group.label}
                        </RailGroupHeader>
                        {!groupCollapsed && (
                          <SortableContext items={group.rows.map((row) => studyViewRowDndId(row.id))} strategy={verticalListSortingStrategy}>
                            {group.rows.map((row) => (
                              <SortableStudyViewRow key={row.id} row={row} groupKey={group.key} disabled={!dragEnabled}>
                                {renderStudyViewRow(row)}
                              </SortableStudyViewRow>
                            ))}
                          </SortableContext>
                        )}
                      </section>
                    )}
                  </SortableStudyViewGroup>
                );
              })}
            </SortableContext>
          </DndContext>
        </RailDrawerBody>
      {/* 삭제 유예 토스트 — 패널 하단 고정 슬롯. 유예 중에만 존재하며 "실행 취소"가
          유일한 액션(확인 다이얼로그 대신 사후 복구를 택해 정상 삭제 흐름은 무마찰). */}
      {pendingDelete && (
        <div role="status" className="flex items-center gap-2 border-t border-border bg-bg-subtle px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-fg-dim">‘{pendingDelete.name}’ 삭제됨</span>
          <button
            type="button"
            onClick={undoDelete}
            className="shrink-0 font-medium text-accent hover:underline"
          >
            실행 취소
          </button>
        </div>
      )}
      {rowMenu && (
        <StudyViewRowMenu
          x={rowMenu.left}
          y={rowMenu.top}
          name={rowMenu.row.name}
          onOpen={() => openSavedRangeInLive(rowMenu.row)}
          onRename={() => startRename(rowMenu.row)}
          onEditMemo={() => startMemoEdit(rowMenu.row)}
          onDelete={() => requestDelete(rowMenu.row)}
          onClose={() => setRowMenu(null)}
        />
      )}
    </RailDrawer>
  );
}
