/**
 * WindowAddMenu — 창 추가 드롭다운 (ADR-0119 후속, /live 툴바 A안).
 *
 * 이전에는 `+차트 +호가 +거래원 +프로그램 +투자자 +매물대 +섹터랭킹` 7개 버튼이
 * 툴바 가로폭을 통째로 먹고, 창 종류가 늘 때마다 선형으로 더 먹었다. 단일
 * `창 추가` 버튼 + 드롭다운 리스트로 접어 툴바를 상수 폭으로 만든다 —
 * 리스트는 버튼 라벨이 담지 못하던 한 줄 설명까지 실을 수 있어 정보량은 오히려 는다.
 *
 * 팝오버 3종 세트(`useDismissablePopover` + `useClampedFixedPosition` + portal)는
 * LayoutPresetMenu 와 동일 — 툴바가 `overflow-x-auto` 라 in-flow 로 띄우면 잘린다.
 *
 * 아이템의 `data-testid` 는 구 버튼과 같은 `workspace-add-${kind}` 를 유지한다
 * (셀렉터 계약 보존 — 달라진 건 "메뉴를 열어야 보인다" 뿐).
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
import { useDismissablePopover } from '../../util/useDismissablePopover';
import { useClampedFixedPosition } from '../../util/useClampedFixedPosition';
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { WINDOW_KIND_LABEL } from './windowKindLabels';
import { useWorkspaceStore, activeGroupOf, type WindowKind } from '../../state/workspace';

type AddItem = {
  kind: WindowKind;
  /** 리스트에서만 보이는 한 줄 설명 — 버튼 라벨이던 시절엔 실을 자리가 없었다. */
  desc: string;
  icon: ReactNode;
  /** 지수 그룹 전용 창(현재 'sector-ranking' 뿐) — 주식 그룹에선 안내 태그를 단다. */
  indexOnly?: boolean;
};

const svg = (children: ReactNode) => (
  <svg
    aria-hidden="true"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

const ADD_ITEMS: readonly AddItem[] = [
  {
    kind: 'chart',
    desc: '캔들 + 보조지표 스택',
    icon: svg(
      <>
        <path d="M8 3v4M8 17v4M16 3v6M16 15v6" />
        <rect x="5" y="7" width="6" height="10" rx="1" />
        <rect x="13" y="9" width="6" height="6" rx="1" />
      </>,
    ),
  },
  {
    kind: 'book',
    desc: '매수·매도 호가 잔량',
    icon: svg(
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 12h18M12 4v16" />
      </>,
    ),
  },
  {
    kind: 'trade',
    desc: '실시간 체결 틱 흐름',
    icon: svg(
      <>
        <path d="M7.5 4v16M7.5 20l-3-3M7.5 20l3-3" />
        <path d="M16.5 20V4M16.5 4l-3 3M16.5 4l3 3" />
      </>,
    ),
  },
  {
    kind: 'broker',
    desc: '증권사별 매수·매도 상위',
    icon: svg(
      <>
        <path d="M3.5 9.5 12 4.5l8.5 5" />
        <path d="M4 20h16M6.5 20v-8M10.5 20v-8M14.5 20v-8M18.5 20v-8" />
      </>,
    ),
  },
  {
    kind: 'program',
    desc: '프로그램 매매 순매수',
    icon: svg(
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 10 2.5 2.5L7 15M13 15h4" />
      </>,
    ),
  },
  {
    kind: 'investor',
    desc: '기관·외국인·개인 수급',
    icon: svg(
      <>
        <circle cx="9.5" cy="8" r="3" />
        <path d="M15.5 19v-1.5a3.5 3.5 0 0 0-3.5-3.5H7a3.5 3.5 0 0 0-3.5 3.5V19" />
        <path d="M15 5.3a3 3 0 0 1 0 5.4" />
        <path d="M20.5 19v-1.5a3.5 3.5 0 0 0-2.5-3.35" />
      </>,
    ),
  },
  {
    kind: 'vdist',
    desc: '가격대별 체결 분포',
    icon: svg(<path d="M4 5h9M4 9.7h15M4 14.3h6M4 19h11" />),
  },
  {
    kind: 'sector-ranking',
    desc: '지수 구성 섹터 등락 순위',
    indexOnly: true,
    icon: svg(
      <>
        <rect x="3" y="10" width="5" height="10" rx="1" />
        <rect x="9.5" y="4.5" width="5" height="15.5" rx="1" />
        <rect x="16" y="13.5" width="5" height="6.5" rx="1" />
      </>,
    ),
  },
];

export function WindowAddMenu() {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const addWindow = useWorkspaceStore((s) => s.addWindow);
  // 지수 그룹 여부만 파생(원시값) — groupSymbols 객체를 구독하면 무관한 종목 교체에도 재렌더된다.
  const isIndexGroup = useWorkspaceStore(
    (s) => s.groupSymbols[activeGroupOf(s)]?.kind === 'index',
  );

  const close = useCallback(() => setOpen(false), []);
  useDismissablePopover(open, wrapRef, close);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  // 열릴 때 첫 아이템으로 포커스 — 키보드만으로 열고 바로 방향키를 쓸 수 있어야 한다.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const toggle = () => {
    setAnchorRect(wrapRef.current?.getBoundingClientRect() ?? null);
    setOpen((prev) => !prev);
  };

  const add = (kind: WindowKind) => {
    addWindow(kind);
    close();
    // 닫은 뒤 트리거로 포커스 복귀 — 연속으로 여러 창을 추가하는 흐름이 끊기지 않는다.
    triggerRef.current?.focus();
  };

  const onItemKeyDown = (e: ReactKeyboardEvent, index: number) => {
    const last = ADD_ITEMS.length - 1;
    const focusAt = (i: number) => {
      e.preventDefault();
      itemRefs.current[i]?.focus();
    };
    if (e.key === 'ArrowDown') focusAt(index === last ? 0 : index + 1);
    else if (e.key === 'ArrowUp') focusAt(index === 0 ? last : index - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(last);
  };

  const menu = open && anchorRect ? (
    <div
      ref={menuPositionRef}
      role="menu"
      aria-label="창 추가"
      data-testid="workspace-add-menu"
      onMouseDown={(e) => e.stopPropagation()}
      className="min-w-[232px] rounded border border-border bg-bg-card py-1 shadow-overlay z-50"
      style={{ position: 'fixed', left, top }}
    >
      {ADD_ITEMS.map((item, index) => {
        // 지수 전용 창을 주식 그룹에서 막지는 않는다(창 먼저 만들고 그룹을 지수로
        // 바꾸는 흐름이 정상) — 대신 클릭 전에 제약을 태그로 알린다.
        const inapplicable = item.indexOnly && !isIndexGroup;
        return (
          <button
            key={item.kind}
            ref={(el) => { itemRefs.current[index] = el; }}
            type="button"
            role="menuitem"
            data-testid={`workspace-add-${item.kind}`}
            title={inapplicable ? '지수 그룹에서만 내용이 표시됩니다' : undefined}
            onClick={() => add(item.kind)}
            onKeyDown={(e) => onItemKeyDown(e, index)}
            className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-fg-dim outline-none hover:bg-bg-input-hover hover:text-fg focus-visible:bg-bg-input-hover focus-visible:text-fg"
          >
            <span className="shrink-0 text-fg-dimmer">{item.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-xs">{WINDOW_KIND_LABEL[item.kind]}</span>
                {inapplicable && (
                  <span className="shrink-0 rounded-sm bg-bg-input px-1 py-px text-[9.5px] text-fg-dimmer">
                    지수 전용
                  </span>
                )}
              </span>
              <span className="block truncate text-[10.5px] text-fg-dimmer">{item.desc}</span>
            </span>
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <IconToolbarButton
        ref={triggerRef}
        data-testid="workspace-add-menu-button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className={open ? 'bg-bg-input-hover text-fg' : undefined}
        icon={(
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
      >
        <span>창 추가</span>
      </IconToolbarButton>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
