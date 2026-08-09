/**
 * StudyWorkspaceCanvas — 코어 캔버스에 /study 결합부를 배선한다 (ADR-0123 PR-3).
 *
 * /live 래퍼(`live/workspace/WorkspaceCanvas.tsx`)의 study 판. 링크 그룹·entryDrag
 * 정밀 드롭·드롭 어포던스가 전부 없다 — 탭(활성 저장뷰)이 콘텐츠 선택자라 창은
 * 배치만 담당한다(방안 A). 창 콘텐츠는 ctx 로 주입받는다: 차트/메모는 StudyPage 가
 * 조립한 노드·props, 데이터 창은 kind 분기(studyWindowContents).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  WorkspaceCanvasCore,
  type WindowItemProps,
} from '../workspace/WorkspaceCanvas';
import { WindowFrameCore } from '../workspace/WindowFrame';
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
  type StudyWindowKind,
  type StudyWorkspaceWindow,
} from '../state/studyWorkspace';

/** 차트 창 타이틀바 식별 — 활성 저장뷰의 이름·코드·뷰 종류. */
export interface StudyChartSymbol {
  label: string;
  code: string;
  kindLabel: string;
}

/** 창 항목들이 공유하는 /study 컨텍스트 — StudyPage 가 useMemo 로 안정화해 주입. */
export interface StudyItemCtx {
  save: StudyViewReference | null;
  bundle: RangeBundle | null;
  /** 차트 창 타이틀바가 그리는 식별 행(#903 의 페이지 툴바 식별부에서 이관). */
  symbol: StudyChartSymbol;
  /** 차트 창 배선 — 창이 헤더·셸·차트를 소유하고(#908) 페이지는 데이터만 준다.
   *  `windowId` 만 창 쪽에서 채운다(창이 자기 id 를 안다).
   *
   *  창마다 봉·번들이 다르므로 값이 아니라 **함수**다(#801). */
  chartFor: (windowId: string) => Omit<StudyChartWindowProps, 'windowId'>;
  /** 이 창을 닫을 수 있는가 — 스토어의 술어와 같은 것을 쓴다(어포던스 불일치 방지). */
  canClose: (windowId: string) => boolean;
  /** 메모 창 본문 props(onClose 제외 — 창 닫기와 결속). null 이면 로딩 카드. */
  memo: Omit<StudyMemoPanelProps, 'onClose'> | null;
  closeWindow: (id: string) => void;
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
        // 차트 창은 종목 식별 행을 타이틀바에 그린다(/live 와 같은 자리). 코드가
        // 아직 없으면(저장뷰 미선택) 종류 라벨로 폴백해 빈 제목을 만들지 않는다.
        win.kind === 'chart' && ctx.symbol.code ? (
          <StudyTitleBarSymbolRow {...ctx.symbol} />
        ) : (
          <span className="truncate text-sm font-medium text-fg">
            {STUDY_WINDOW_LABEL[win.kind]}
          </span>
        )
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
            ctx.memo ? (
              <StudyMemoPanel {...ctx.memo} onClose={() => ctx.closeWindow(win.id)} />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-xs text-fg-dim">
                <span className="font-data">학습뷰 불러오는 중…</span>
              </div>
            )
          ) : (
            <StudyDataWindowContent
              kind={win.kind as StudyDataWindowKind}
              save={ctx.save}
              bundle={ctx.bundle}
            />
          )}
        </ChartErrorBoundary>
      )}
    </WindowFrameCore>
  );
}

export function StudyWorkspaceCanvas({
  save,
  bundle,
  chartFor,
  memo,
  symbolLabel,
  symbolCode,
  symbolKindLabel,
}: {
  save: StudyViewReference | null;
  bundle: RangeBundle | null;
  /** 창 id → 그 창의 차트 props. 창마다 봉·번들이 다르므로 값이 아니라 **함수**다(#801). */
  chartFor: (windowId: string) => Omit<StudyChartWindowProps, 'windowId'>;
  memo: Omit<StudyMemoPanelProps, 'onClose'> | null;
  /** 차트 창 타이틀바 식별 — 스칼라 3개로 받아 itemCtx 재생성 축을 늘리지 않는다. */
  symbolLabel: string;
  symbolCode: string;
  symbolKindLabel: string;
}) {
  const windows = useStudyWorkspaceStore((s) => s.windows);
  const zOrder = useStudyWorkspaceStore((s) => s.zOrder);
  const focusWindow = useStudyWorkspaceStore((s) => s.focusWindow);
  const closeWindow = useStudyWorkspaceStore((s) => s.closeWindow);
  const canClose = useCallback(
    (id: string) => canCloseStudyWindow(useStudyWorkspaceStore.getState().windows, id),
    [windows],
  );
  const setWindowRects = useStudyWorkspaceStore((s) => s.setWindowRects);

  const itemCtx = useMemo<StudyItemCtx>(
    () => ({
      save,
      bundle,
      chartFor,
      canClose,
      memo,
      closeWindow,
      symbol: { label: symbolLabel, code: symbolCode, kindLabel: symbolKindLabel },
    }),
    [save, bundle, chartFor, canClose, memo, closeWindow, symbolLabel, symbolCode, symbolKindLabel],
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
