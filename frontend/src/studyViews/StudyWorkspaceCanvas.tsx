/**
 * StudyWorkspaceCanvas — 코어 캔버스에 /study 결합부를 배선한다 (ADR-0123 PR-3).
 *
 * /live 래퍼(`live/workspace/WorkspaceCanvas.tsx`)의 study 판. **링크 그룹은 이제
 * 있다**(ADR-0154) — 뱃지·팔레트 배선이 저쪽과 같은 모양이고, 다른 것은 번호가
 * 저장뷰를 가리킨다는 점뿐이다. entryDrag 정밀 드롭·드롭 어포던스는 여전히 없다.
 *
 * 창 콘텐츠는 ctx 로 주입받는다: 차트/메모는 StudyPage 가 조립한 노드·props, 데이터
 * 창은 kind 분기(studyWindowContents). **전부 창 id 를 받는 함수**다 — 창마다 그룹이
 * 다를 수 있으므로 값으로 실으면 그룹 축이 사라진다.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  WorkspaceCanvasCore,
  type WindowItemProps,
} from '../workspace/WorkspaceCanvas';
import { WindowFrameCore } from '../workspace/WindowFrame';
import { GroupBadge } from '../workspace/GroupBadge';
import ChartErrorBoundary from '../chart/ChartErrorBoundary';
import { createPortal } from 'react-dom';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { IconToolbarButton } from '../ui/WorkspaceShell';
import type { RangeBundle } from '../api/types';
import type { StudyViewReference } from '../api/studyViews';
import { StudyMemoPanel, type StudyMemoPanelProps } from './StudyMemoPanel';
import { StudyChartWindow, type StudyChartWindowProps } from './StudyChartWindow';
import { StudyDataWindowContent } from './studyWindowContents';
import { STUDY_WINDOW_LABEL, type StudyDataWindowKind } from './studyWindowMeta';
import {
  canCloseStudyWindow,
  useStudyWorkspaceStore,
  type GroupId,
  type StudyWindowKind,
  type StudyWorkspaceWindow,
} from '../state/studyWorkspace';

/** 차트 창 타이틀바 식별 — 활성 저장뷰의 이름·코드·뷰 종류. */
export interface StudyChartSymbol {
  label: string;
  code: string;
  kindLabel: string;
}

/**
 * 창 항목들이 공유하는 /study 컨텍스트 — StudyPage 가 useMemo 로 안정화해 주입.
 *
 * **거의 전부가 `windowId` 를 받는 함수다**(ADR-0154). 값으로 실으면 "모든 창이 같은
 * 저장뷰를 본다" 가 타입에 박히고, 그게 정확히 이 변경이 없앤 전제다.
 */
export interface StudyItemCtx {
  /** 이 창의 그룹이 보는 저장뷰. null = 그 그룹에 뷰가 없거나 아직 안 왔다. */
  saveFor: (windowId: string) => StudyViewReference | null;
  /** 이 창의 그룹 번들(그룹의 포커스 차트 창이 먹인다). */
  bundleFor: (windowId: string) => RangeBundle | null;
  /** 이 창의 그룹에 저장뷰가 **없다** — 로딩과 구분한다(쿼리가 아예 안 걸린다). */
  viewMissing: (windowId: string) => boolean;
  /** 이 창의 그룹에 차트 창이 있는가. 데이터 창의 번들 소스가 그것뿐이라, 없으면
   *  저장뷰가 있어도 그릴 것이 없다(팔레트로 차트만 옮기면 도달한다). */
  groupHasChart: (windowId: string) => boolean;
  /** 차트 창 타이틀바가 그리는 식별 행(#903 의 페이지 툴바 식별부에서 이관).
   *  null = 그 그룹에 저장뷰가 없다 → 타이틀은 `그룹 N` 으로 폴백. */
  symbolFor: (windowId: string) => StudyChartSymbol | null;
  /** 차트 창 배선 — 창이 헤더·셸·차트를 소유하고(#908) 페이지는 데이터만 준다.
   *  `windowId` 만 창 쪽에서 채운다(창이 자기 id 를 안다).
   *
   *  창마다 봉·번들·저장뷰가 다르므로 값이 아니라 **함수**다(#801 · ADR-0154). */
  chartFor: (windowId: string) => Omit<StudyChartWindowProps, 'windowId'>;
  /** 이 창을 닫을 수 있는가 — 스토어의 술어와 같은 것을 쓴다(어포던스 불일치 방지). */
  canClose: (windowId: string) => boolean;
  /** 메모 창 본문 props(onClose 제외 — 창 닫기와 결속). null 이면 로딩 카드. */
  memoFor: (windowId: string) => Omit<StudyMemoPanelProps, 'onClose'> | null;
  closeWindow: (id: string) => void;
  /** 열려 있는 그룹 팔레트의 창 id(한 번에 하나) — `/live` 캔버스와 같은 모양. */
  paletteId: string | null;
  onTogglePalette: (id: string) => void;
  onPickGroup: (id: string, group: GroupId) => void;
}

/**
 * 차트 창 타이틀바의 종목 식별 행 — `/live` `TitleBarSymbolRow` 의 /study 판.
 *
 * **복제가 아니라 거울상**이다. /live 판은 현재가·등락률·히트맵·수집점을 `code` 로
 * self-fetch 하는데, 복기뷰는 과거 고정 구간이라 그걸 그대로 얹으면 과거 차트 위에
 * **오늘의 실시간 시세**가 붙는다. 그래서 남기는 건 `· 복기뷰` 꼬리표다 — 이게
 * "이 창은 과거다" 라는 유일한 신호라 #900 이 타이틀바 이관을 미룬 이유였다.
 */
function StudyTitleBarSymbolRow({ label, code, kindLabel }: StudyChartSymbol) {
  return (
    <span
      data-testid="study-titlebar-symbol-row"
      className="inline-flex min-w-0 items-center gap-1.5"
    >
      <span className="truncate text-sm font-medium text-fg">{label}</span>
      {/* 코드와 뷰 종류는 한 노드에 둔다 — 페이지 툴바 시절과 같은 한 덩어리
          문자열(`005930 · 복기뷰`)이라 읽기·검색 계약이 이관 전후로 같다. */}
      <span className="whitespace-nowrap text-xs text-fg-dim">
        {code} · {kindLabel}
      </span>
    </span>
  );
}

/** 코어의 `windowItem` 슬롯 — 모듈 스코프 필수(인라인 정의는 리마운트). */
function StudyWindowItem({
  win, rect, zIndex, focused, lifting, onHandleDown, onFocus, ctx,
}: WindowItemProps<StudyWorkspaceWindow, StudyItemCtx>) {
  const symbol = ctx.symbolFor(win.id);
  const viewMissing = ctx.viewMissing(win.id);
  // 데이터 창은 "뷰 없음" 과 "그룹에 차트 창 없음" 을 **구분해서** 말한다 — 둘 다
  // 쿼리가 안 걸리는 상태라 로딩 문구로 뭉치면 영영 끝나지 않는 거짓말이 된다.
  const dataEmptyReason = viewMissing
    ? 'no-view' as const
    : ctx.groupHasChart(win.id) ? null : 'no-chart' as const;
  const memoProps = win.kind === 'memo' ? ctx.memoFor(win.id) : null;
  // `/live` `WindowFrame` 의 `symbolLabel ?? \`그룹 ${group}\`` 과 같은 폴백이다 —
  // 대상이 없을 때 제목이 사라지지 않고 **번호가 남는다**.
  const title = symbol?.label || `그룹 ${win.group}`;
  return (
    <WindowFrameCore
      id={win.id}
      rect={rect}
      zIndex={zIndex}
      focused={focused}
      lifting={lifting}
      // 마지막 차트 창은 스토어가 닫기를 거부한다 — 어포던스도 같은 술어로 숨긴다.
      closable={ctx.canClose(win.id)}
      // /study 통일: 안착 그림자·카드 배경 스텝 제거 → 콘텐츠가 필드에 평평하게 얹힌다.
      flat

      onHandleDown={onHandleDown}
      onFocus={onFocus}
      onClose={ctx.closeWindow}
      header={
        <>
          {/* 뱃지·팔레트는 `/live` 와 **같은 컴포넌트**다 — 번호가 가리키는 것만
              다르다(그쪽은 종목, 여기는 저장뷰). */}
          <GroupBadge
            group={win.group}
            open={ctx.paletteId === win.id}
            onToggle={() => ctx.onTogglePalette(win.id)}
            onPick={(g) => ctx.onPickGroup(win.id, g)}
            title="저장뷰 링크 그룹 변경"
          />
          {/* 차트 창은 종목 식별 행을 타이틀바에 그린다(/live 와 같은 자리). 코드가
              아직 없으면(그 그룹에 저장뷰 미선택) 종류 라벨로 폴백해 빈 제목을 만들지
              않는다. 데이터 창은 `/live` 처럼 `종류 · 대상` 으로 어느 그룹인지 읽힌다. */}
          {win.kind === 'chart' && symbol?.code ? (
            <StudyTitleBarSymbolRow {...symbol} />
          ) : (
            <span className="truncate text-sm font-medium text-fg">
              {win.kind === 'chart'
                ? title
                : `${STUDY_WINDOW_LABEL[win.kind]} · ${title}`}
            </span>
          )}
        </>
      }
    >
      {win.kind === 'chart' ? (
        <StudyChartWindow {...ctx.chartFor(win.id)} windowId={win.id} />
      ) : (
        /* 창 단위 격리(/live WorkspaceCanvas 와 동일) — 데이터·메모 창의 throw 가
           워크스페이스 전체를 백지로 만들지 않게 한다. 차트 창은 내부 경계 보유.
           로딩 텍스트 색은 main 의 fg-dimmer→fg-dim 승격(대비 AA)을 따른다. */
        <ChartErrorBoundary title="창 렌더링에 실패했습니다">
          {win.kind === 'memo' ? (
            memoProps ? (
              <StudyMemoPanel {...memoProps} onClose={() => ctx.closeWindow(win.id)} />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-bg-subtle/40 text-xs text-fg-dim">
                {/* 메모도 그룹의 저장뷰에 딸린다 — 뷰가 없으면 저장할 대상이 없다. */}
                <span className="font-data">{viewMissing ? `그룹 ${win.group}` : ''}</span>
                <span>{viewMissing ? '저장뷰를 선택하세요' : '학습뷰 불러오는 중…'}</span>
              </div>
            )
          ) : (
            <StudyDataWindowContent
              kind={win.kind as StudyDataWindowKind}
              group={win.group}
              emptyReason={dataEmptyReason}
              save={ctx.saveFor(win.id)}
              bundle={ctx.bundleFor(win.id)}
            />
          )}
        </ChartErrorBoundary>
      )}
    </WindowFrameCore>
  );
}

export function StudyWorkspaceCanvas({
  saveFor,
  bundleFor,
  viewMissing,
  groupHasChart,
  symbolFor,
  chartFor,
  memoFor,
}: {
  /** 아래 다섯은 전부 **창 id → 값**이다(ADR-0154) — 창마다 그룹이, 그룹마다 저장뷰가
   *  다를 수 있다. 페이지가 `useCallback` 으로 안정화해 넘긴다. */
  saveFor: (windowId: string) => StudyViewReference | null;
  bundleFor: (windowId: string) => RangeBundle | null;
  viewMissing: (windowId: string) => boolean;
  groupHasChart: (windowId: string) => boolean;
  symbolFor: (windowId: string) => StudyChartSymbol | null;
  chartFor: (windowId: string) => Omit<StudyChartWindowProps, 'windowId'>;
  memoFor: (windowId: string) => Omit<StudyMemoPanelProps, 'onClose'> | null;
}) {
  const windows = useStudyWorkspaceStore((s) => s.windows);
  const zOrder = useStudyWorkspaceStore((s) => s.zOrder);
  const focusWindow = useStudyWorkspaceStore((s) => s.focusWindow);
  const closeWindow = useStudyWorkspaceStore((s) => s.closeWindow);
  const setWindowGroup = useStudyWorkspaceStore((s) => s.setWindowGroup);
  const canClose = useCallback(
    (id: string) => canCloseStudyWindow(useStudyWorkspaceStore.getState().windows, id),
    [windows],
  );
  const setWindowRects = useStudyWorkspaceStore((s) => s.setWindowRects);

  // 팔레트는 한 번에 하나만 열린다 — 상태를 캔버스가 들고 창은 `paletteId` 비교로
  // 자기 차례인지 안다(`/live` WorkspaceCanvas 와 같은 모양).
  const [palette, setPalette] = useState<string | null>(null);
  const onTogglePalette = useCallback((id: string) => {
    setPalette((p) => (p === id ? null : id));
  }, []);
  const onPickGroup = useCallback((id: string, g: GroupId) => {
    setWindowGroup(id, g);
    setPalette(null);
  }, [setWindowGroup]);

  const itemCtx = useMemo<StudyItemCtx>(
    () => ({
      saveFor,
      bundleFor,
      viewMissing,
      groupHasChart,
      symbolFor,
      chartFor,
      canClose,
      memoFor,
      closeWindow,
      paletteId: palette,
      onTogglePalette,
      onPickGroup,
    }),
    [
      saveFor, bundleFor, viewMissing, groupHasChart, symbolFor, chartFor, canClose, memoFor,
      closeWindow, palette, onTogglePalette, onPickGroup,
    ],
  );

  return (
    <WorkspaceCanvasCore<StudyWorkspaceWindow, StudyItemCtx>
      windows={windows}
      zOrder={zOrder}
      focusWindow={focusWindow}
      setWindowRects={setWindowRects}
      windowItem={StudyWindowItem}
      itemCtx={itemCtx}
    />
  );
}

/** 창 추가 드롭다운의 kind 목록 — 차트를 포함한다(#801: 창 여러 개 허용). */
const STUDY_ADD_KINDS: readonly StudyWindowKind[] = ['chart', 'book', 'broker', 'vdist', 'program', 'memo'];

/**
 * 창 추가 메뉴(/study) — /live WindowAddMenu 의 축소판.
 *
 * 팝오버 3종 세트(`useDismissablePopover` + `useClampedFixedPosition` + portal)를 쓴다.
 * 이전 주석은 "헤더 툴바는 스크롤 컨테이너가 아니라 in-flow absolute 로 충분하다" 였는데,
 * `/study` 가 `WorkspaceToolbar` 를 쓰기 시작하면서(#921) 그 전제가 깨졌다 — 그 툴바는
 * `overflow-x-auto` 라 **양 축 모두 클리핑 컨텍스트**가 된다(한 축이 visible 이 아니면
 * 다른 축도 auto 로 계산된다). 그래서 in-flow 팝오버는 툴바 높이(36px) 밖으로 나가는
 * 순간 통째로 잘려 **메뉴가 아예 보이지 않았다**(실측: 143px 메뉴 전체가 잘림).
 *
 * 같은 툴바의 창 목록·프리셋 메뉴가 멀쩡했던 건 둘 다 portal 을 쓰기 때문이다.
 */
export function StudyWindowAddMenu() {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(open, anchorRef, () => setOpen(false));
  const addWindow = useStudyWorkspaceStore((s) => s.addWindow);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const toggle = () => {
    setAnchorRect(anchorRef.current?.getBoundingClientRect() ?? null);
    setOpen((v) => !v);
  };

  const menu = open && anchorRect ? (
    <div
      ref={menuPositionRef}
      role="menu"
      aria-label="창 추가"
      onMouseDown={(e) => e.stopPropagation()}
      className="z-50 w-max rounded-md border border-border bg-bg-subtle p-1 shadow-overlay"
      style={{ position: 'fixed', left, top }}
    >
      {STUDY_ADD_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="menuitem"
          data-testid={`study-add-${kind}`}
          className="flex w-full items-center rounded px-2 py-1 text-left text-sm text-fg hover:bg-tint-selection"
          onClick={() => {
            addWindow(kind);
            setOpen(false);
          }}
        >
          {STUDY_WINDOW_LABEL[kind]}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div ref={anchorRef} className="relative shrink-0">
      <IconToolbarButton
        data-testid="study-window-add"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        + 창 추가
      </IconToolbarButton>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
