/**
 * WindowListMenu — 열린 창 목록 드롭다운 (페이지 공용 프리젠테이션).
 *
 * 툴바의 죽은 "N창 · 그룹 X" 라벨을 대체한다 — 개수만 알리던 텍스트를, 열린 창을
 * 한눈에 보고 **점프(포커스)·닫기·정리** 하는 진입점으로 승격한다. 창 추가(WindowAddMenu)
 * 가 창을 만드는 입구라면 이건 이미 만든 창을 관리하는 입구다.
 *
 * 스토어·kind 타입에 무의존하다 — /live 와 /study 가 각자 자기 스토어에서 창을
 * `WindowListSection[]` 으로 정규화해 넘긴다(그룹 있는 /live, 평면인 /study 를 같은
 * 컴포넌트로). 팝오버 3종 세트(useDismissablePopover + useClampedFixedPosition +
 * portal)는 WindowAddMenu·LayoutPresetMenu 와 동일 — 툴바가 overflow-x-auto 라
 * in-flow 로 띄우면 잘린다.
 *
 * 창은 ADR-0122 불변식(비율 rect 가 항상 [0,1] 안)상 화면 밖으로 못 나가므로, 목록
 * 클릭은 focusWindow(z-최상단 raise)만으로 "겹친 창을 위로" 를 달성한다 — 좌표를
 * 되돌릴 필요가 없다.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { IconToolbarButton } from '../ui/WorkspaceShell';

export type WindowListRow = {
  id: string;
  /** 주 라벨 — 창 종류 표시명(예 "차트", "10호가"). */
  label: string;
  /** 부 라벨 — 그룹의 종목명(/live). /study 는 종목 개념이 없어 생략된다. */
  sublabel?: string;
  icon?: ReactNode;
  /** 포커스(z-최상단) 창 — 강조 + "포커스" 배지. */
  isFocused: boolean;
  /** 닫기 가능 여부 — /study 의 유일 차트 창은 불변식상 닫을 수 없다. */
  closable: boolean;
};

export type WindowListSection = {
  key: string;
  /** 섹션 헤더(예 "그룹 1 · 삼성전자"). 없으면 헤더를 그리지 않는다(/study 평면 목록). */
  heading?: string;
  /** 그룹 색점 — 캔버스의 그룹 배지 색과 맞춘다. */
  dotColor?: string;
  rows: WindowListRow[];
};

type Props = {
  /** 트리거 뱃지의 창 개수. */
  count: number;
  /** 팝오버 상단 요약(예 "열린 창 6 · 그룹 3" / "열린 창 4"). */
  summary: string;
  sections: WindowListSection[];
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onTidy: () => void;
  /** 트리거·팝오버 testid 접두(예 "live-window-list"). */
  testId: string;
};

export function WindowListMenu({
  count,
  summary,
  sections,
  onFocus,
  onClose,
  onTidy,
  testId,
}: Props) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(() => setOpen(false), []);
  useDismissablePopover(open, wrapRef, close);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  // 평면 행 인덱스 — 섹션을 가로지르는 방향키 순환용(포커스 관리는 섹션과 무관).
  const flatRows = sections.flatMap((s) => s.rows);

  // 열릴 때 포커스된 행(없으면 첫 행)으로 — 키보드만으로 열고 바로 방향키를 쓴다.
  useEffect(() => {
    if (!open) return;
    const focusedIdx = flatRows.findIndex((r) => r.isFocused);
    rowRefs.current[focusedIdx >= 0 ? focusedIdx : 0]?.focus();
  }, [open, flatRows]);

  const toggle = () => {
    setAnchorRect(wrapRef.current?.getBoundingClientRect() ?? null);
    setOpen((prev) => !prev);
  };

  const focus = (id: string) => {
    onFocus(id);
    close();
    triggerRef.current?.focus();
  };

  const onRowKeyDown = (e: ReactKeyboardEvent, index: number) => {
    const last = flatRows.length - 1;
    const focusAt = (i: number) => {
      e.preventDefault();
      rowRefs.current[i]?.focus();
    };
    if (e.key === 'ArrowDown') focusAt(index === last ? 0 : index + 1);
    else if (e.key === 'ArrowUp') focusAt(index === 0 ? last : index - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(last);
  };

  // 섹션을 평면 인덱스로 펴면서 그린다 — rowRefs·방향키 인덱스가 flatRows 와 정렬돼야 한다.
  let flatIndex = -1;
  const menu = open && anchorRect ? (
    <div
      ref={menuPositionRef}
      role="menu"
      aria-label="창 목록"
      data-testid={`${testId}-menu`}
      onMouseDown={(e) => e.stopPropagation()}
      className="min-w-[248px] rounded border border-border bg-bg-card py-1 shadow-overlay z-50"
      style={{ position: 'fixed', left, top }}
    >
      <div className="flex items-center justify-between px-3 pb-1.5 pt-0.5 text-[11px] text-fg-dimmer">
        <span>{summary}</span>
        <button
          type="button"
          data-testid={`${testId}-tidy`}
          onClick={() => {
            onTidy();
            close();
          }}
          className="rounded px-1.5 py-0.5 text-accent hover:bg-bg-input-hover"
        >
          모두 정리
        </button>
      </div>

      {flatRows.length === 0 ? (
        <div className="px-3 py-2 text-xs text-fg-dimmer">열린 창이 없습니다</div>
      ) : (
        sections.map((section) => (
          <div key={section.key}>
            {section.heading && (
              <div className="flex items-center gap-1.5 border-t border-border px-3 pb-1 pt-1.5 text-[10.5px] text-fg-dimmer first:border-t-0">
                {section.dotColor && (
                  <span
                    aria-hidden
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: section.dotColor }}
                  />
                )}
                <span className="truncate">{section.heading}</span>
              </div>
            )}
            {section.rows.map((row) => {
              flatIndex += 1;
              const index = flatIndex;
              return (
                <div
                  key={row.id}
                  className={`group/row flex items-center ${row.isFocused ? 'bg-tint-selection' : ''}`}
                >
                  <button
                    ref={(el) => { rowRefs.current[index] = el; }}
                    type="button"
                    role="menuitem"
                    data-testid={`${testId}-focus-${row.id}`}
                    onClick={() => focus(row.id)}
                    onKeyDown={(e) => onRowKeyDown(e, index)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 text-left outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover"
                  >
                    {row.icon && <span className="shrink-0 text-fg-dimmer">{row.icon}</span>}
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">
                      {row.label}
                      {row.sublabel && <span className="text-fg-dimmer"> · {row.sublabel}</span>}
                    </span>
                    {row.isFocused && (
                      <span className="shrink-0 rounded-full border border-accent px-1.5 text-[9.5px] text-accent">
                        포커스
                      </span>
                    )}
                  </button>
                  {row.closable && (
                    <button
                      type="button"
                      aria-label={`${row.label} 창 닫기`}
                      data-testid={`${testId}-close-${row.id}`}
                      onClick={() => onClose(row.id)}
                      className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dimmer opacity-0 hover:bg-bg-input-hover hover:text-fg focus-visible:opacity-100 group-hover/row:opacity-100"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6 6 18" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <IconToolbarButton
        ref={triggerRef}
        data-testid={`${testId}-button`}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className={open ? 'bg-bg-input-hover text-fg' : undefined}
        icon={(
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        )}
      >
        <span>창 목록</span>
        <span className="ml-0.5 rounded-full bg-bg-input px-1.5 font-data text-[11px] text-fg-dim">
          {count}
        </span>
      </IconToolbarButton>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
