/**
 * StudyWorkspaceCanvas — 코어 캔버스에 /study 결합부를 배선한다 (ADR-0123 PR-3).
 *
 * /live 래퍼(`live/workspace/WorkspaceCanvas.tsx`)의 study 판. 링크 그룹·entryDrag
 * 정밀 드롭·드롭 어포던스가 전부 없다 — 탭(활성 저장뷰)이 콘텐츠 선택자라 창은
 * 배치만 담당한다(방안 A). 창 콘텐츠는 ctx 로 주입받는다: 차트/메모는 StudyPage 가
 * 조립한 노드·props, 데이터 창은 kind 분기(studyWindowContents).
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  WorkspaceCanvasCore,
  type WindowItemProps,
} from '../workspace/WorkspaceCanvas';
import { WindowFrameCore } from '../workspace/WindowFrame';
import { registerWorkspaceTidy } from '../workspace/workspaceCanvasControls';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { IconToolbarButton } from '../ui/WorkspaceShell';
import type { RangeBundle } from '../api/types';
import type { StudyViewReference } from '../api/studyViews';
import { StudyMemoPanel, type StudyMemoPanelProps } from './StudyMemoPanel';
import { StudyDataWindowContent } from './studyWindowContents';
import { STUDY_WINDOW_LABEL, type StudyDataWindowKind } from './studyWindowMeta';
import {
  useStudyWorkspaceStore,
  type StudyWindowKind,
  type StudyWorkspaceWindow,
} from '../state/studyWorkspace';

/** 창 항목들이 공유하는 /study 컨텍스트 — StudyPage 가 useMemo 로 안정화해 주입. */
export interface StudyItemCtx {
  save: StudyViewReference | null;
  bundle: RangeBundle | null;
  /** 차트 창 본문 — 로딩/차트 셸 조립은 StudyPage 소유. */
  chartContent: ReactNode;
  /** 메모 창 본문 props(onClose 제외 — 창 닫기와 결속). null 이면 로딩 카드. */
  memo: Omit<StudyMemoPanelProps, 'onClose'> | null;
  closeWindow: (id: string) => void;
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
      // 차트 창은 v1 단일 고정(스토어가 닫기를 거부) — 어포던스도 숨긴다.
      closable={win.kind !== 'chart'}
      // /study 통일: 안착 그림자·카드 배경 스텝 제거 → 콘텐츠가 필드에 평평하게 얹힌다.
      flat

      onHandleDown={onHandleDown}
      onFocus={onFocus}
      onClose={ctx.closeWindow}
      header={
        <span className="truncate text-[12px] font-medium text-fg">
          {STUDY_WINDOW_LABEL[win.kind]}
        </span>
      }
    >
      {win.kind === 'chart' ? (
        ctx.chartContent
      ) : win.kind === 'memo' ? (
        ctx.memo ? (
          <StudyMemoPanel {...ctx.memo} onClose={() => ctx.closeWindow(win.id)} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-[11px] text-fg-dimmer">
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
    </WindowFrameCore>
  );
}

export function StudyWorkspaceCanvas({
  save,
  bundle,
  chartContent,
  memo,
}: {
  save: StudyViewReference | null;
  bundle: RangeBundle | null;
  chartContent: ReactNode;
  memo: Omit<StudyMemoPanelProps, 'onClose'> | null;
}) {
  const windows = useStudyWorkspaceStore((s) => s.windows);
  const zOrder = useStudyWorkspaceStore((s) => s.zOrder);
  const focusWindow = useStudyWorkspaceStore((s) => s.focusWindow);
  const closeWindow = useStudyWorkspaceStore((s) => s.closeWindow);
  const setWindowRects = useStudyWorkspaceStore((s) => s.setWindowRects);
  const tidyAll = useStudyWorkspaceStore((s) => s.tidyAll);

  const itemCtx = useMemo<StudyItemCtx>(
    () => ({ save, bundle, chartContent, memo, closeWindow }),
    [save, bundle, chartContent, memo, closeWindow],
  );

  return (
    <WorkspaceCanvasCore<StudyWorkspaceWindow, StudyItemCtx>
      windows={windows}
      zOrder={zOrder}
      focusWindow={focusWindow}
      setWindowRects={setWindowRects}
      tidyAll={tidyAll}
      registerTidy={registerWorkspaceTidy}
      windowItem={StudyWindowItem}
      itemCtx={itemCtx}
    />
  );
}

/** 창 추가 드롭다운의 kind 목록 — chart 는 v1 단일 고정이라 제외(ADR-0123). */
const STUDY_ADD_KINDS: readonly StudyWindowKind[] = ['book', 'broker', 'vdist', 'program', 'memo'];

/**
 * 창 추가 메뉴(/study) — /live WindowAddMenu 의 축소판. 헤더 툴바는 스크롤 컨테이너가
 * 아니라 in-flow absolute 팝오버로 충분하다(포털·클램프 불필요).
 */
export function StudyWindowAddMenu() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(open, anchorRef, () => setOpen(false));
  const addWindow = useStudyWorkspaceStore((s) => s.addWindow);
  return (
    <div ref={anchorRef} className="relative shrink-0">
      <IconToolbarButton
        data-testid="study-window-add"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        + 창 추가
      </IconToolbarButton>
      {open && (
        <div
          role="menu"
          aria-label="창 추가"
          className="absolute right-0 top-full z-50 mt-1 w-max rounded-md border border-border bg-bg-subtle p-1 shadow-overlay"
        >
          {STUDY_ADD_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              data-testid={`study-add-${kind}`}
              className="flex w-full items-center rounded px-2 py-1 text-left text-[12px] text-fg hover:bg-tint-selection"
              onClick={() => {
                addWindow(kind);
                setOpen(false);
              }}
            >
              {STUDY_WINDOW_LABEL[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
