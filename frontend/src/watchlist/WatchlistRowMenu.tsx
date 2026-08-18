import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { HeartIcon } from '../ui/HeartIcon';
import { CheckIcon } from '../ui/CheckIcon';
import { TrashIcon } from '../ui/TrashIcon';

type MenuItem = { key: string; label: string; icon: React.ReactNode; onClick: () => void };

// 메뉴 전용 장식 글리프 — `--fg-dimmer` 가 아니라 currentColor 를 따른다(메뉴 항목 색).
// DESIGN.md 2026-08-04 의 승격 제외 (2) "장식 글리프" 에 해당한다.
function MenuGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {children}
    </svg>
  );
}
/** 빈칸(메모) 행 — 실선 위에 점선 한 줄로 "빈 자리"를 표현(드로어 ⋯ 메뉴와 같은 글리프). */
const BlankRowIcon = () => <MenuGlyph><path d="M4 8h16" /><path d="M4 16h16" strokeDasharray="3 3" /></MenuGlyph>;
const PlusIcon = () => <MenuGlyph><path d="M12 5v14" /><path d="M5 12h14" /></MenuGlyph>;

/**
 * 커서 좌표에 뜨는 컨텍스트 메뉴 셸 — 위치 보정·dismiss·항목 렌더를 한 곳에 둔다.
 * 종목 행 메뉴와 메모("빈칸") 행 메뉴가 공유한다: 둘은 **항목 구성만** 다르고
 * 컨테이너/스타일/키보드 계약은 같아야 한다(드로어의 AnchoredMenu 와 같은 근거).
 *
 * `useClampedFixedPosition` 이 렌더 후 자기 rect 를 실측해 우/하단 오버플로를 보정하므로
 * 호출부는 raw 커서 좌표를 그대로 넘긴다.
 */
function ContextMenuShell({ x, y, ariaLabel, testId, items, onClose }: {
  x: number;
  y: number;
  ariaLabel: string;
  testId: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      data-testid={testId}
      onContextMenu={(e) => e.preventDefault()}
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1"
      style={{ position: 'fixed', left, top, minWidth: '8rem' }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-testid={`watchlist-menu-${item.key}`}
          onClick={item.onClick}
          className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
        >
          <span className="w-4 grid place-items-center">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  );
}

interface Props {
  x: number;            // raw 커서 viewport 좌표
  y: number;
  name: string;         // 접근성 라벨용
  onEditGroups: () => void;   // "그룹 편집" → WatchlistGroupPicker 오픈(v3, ADR-0070)
  onRemove: () => void;       // 관심 해제(모든 폴더에서 제거)
  /** "위에 종목 추가" — 이 행 자리에 종목을 넣는다(v5). 미분류·등락률 정렬 그룹은
   *  삽입 위치가 의미를 잃으므로 미전달 → 항목이 아예 안 뜬다(빈칸 삽입과 같은 게이트). */
  onAddSymbolAbove?: () => void;
  /** "위에 빈칸 삽입" — 이 행 자리에 메모를 넣는다(v4). 미분류 행은 넣을 폴더가
   *  없으므로 미전달 → 항목이 아예 안 뜬다. */
  onInsertMemoAbove?: () => void;
  onClose: () => void;
}

/**
 * 관심종목 **종목 행** 우클릭 컨텍스트 메뉴 (워치리스트 전용, v3).
 * v2의 "그룹으로 이동"(단일 folder_id 교체)은 다중 소속에서 의미가 깨져, "그룹 편집"
 * (WatchlistGroupPicker)으로 통일했다 — 하트 팝업과 동일 primitive(ADR-0070 P5).
 *
 * 항목 순서는 **삽입 계열을 가운데 묶는다**: 그룹 편집 / (종목·빈칸 삽입) / 관심 해제.
 * 파괴적 항목(관심 해제)이 맨 아래라 오클릭 거리가 가장 멀다.
 */
export function WatchlistRowMenu({
  x, y, name, onEditGroups, onRemove, onAddSymbolAbove, onInsertMemoAbove, onClose,
}: Props) {
  const items: MenuItem[] = [
    {
      key: 'edit-groups',
      label: '그룹 편집',
      icon: <CheckIcon filled size={16} />,
      onClick: () => { onEditGroups(); onClose(); },
    },
    ...(onAddSymbolAbove ? [{
      key: 'add-symbol',
      label: '위에 종목 추가',
      icon: <PlusIcon />,
      onClick: () => { onAddSymbolAbove(); onClose(); },
    }] : []),
    ...(onInsertMemoAbove ? [{
      key: 'insert-memo',
      label: '위에 빈칸 삽입',
      icon: <BlankRowIcon />,
      onClick: () => { onInsertMemoAbove(); onClose(); },
    }] : []),
    {
      key: 'remove',
      label: '관심 해제',
      icon: <HeartIcon filled className="w-[1em] h-[1em]" />,
      onClick: () => { onRemove(); onClose(); },
    },
  ];

  return (
    <ContextMenuShell x={x} y={y} ariaLabel={`${name} 컨텍스트 메뉴`}
      testId="watchlist-row-menu" items={items} onClose={onClose} />
  );
}

/**
 * 메모("빈칸") 행 우클릭 컨텍스트 메뉴 (v5).
 *
 * **"여기에 종목 넣기" 가 이 메뉴의 존재 이유다** — 빈칸은 "자리를 미리 잡아 둔다" 는
 * 용도라, 나중에 그 자리를 종목으로 채우는 경로가 없으면 반쪽이다. 종목 행 메뉴의
 * "위에 종목 추가" 와 달리 **교체**다(넣고 빈칸을 지운다).
 *
 * 정렬 게이트가 여기엔 없다 — 등락률 정렬 그룹은 메모 행 자체를 렌더하지 않으므로
 * (WatchlistDrawer::renderGroups) 이 메뉴는 default 정렬에서만 존재한다.
 */
export function WatchlistMemoRowMenu({ x, y, text, onFillWithSymbol, onInsertMemoAbove, onDelete, onClose }: {
  x: number;
  y: number;
  /** 접근성 라벨용. 빈 줄이면 '' 이라 라벨이 "빈칸" 으로 떨어진다. */
  text: string;
  /** "여기에 종목 넣기" — 이 빈칸 자리에 종목을 넣고 빈칸을 지운다. */
  onFillWithSymbol: () => void;
  /** "위에 빈칸 삽입" — 종목 행 메뉴와 같은 의미(이 행 자리에 새 빈칸). */
  onInsertMemoAbove: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const items: MenuItem[] = [
    {
      key: 'memo-fill-symbol',
      label: '여기에 종목 넣기',
      icon: <PlusIcon />,
      onClick: () => { onFillWithSymbol(); onClose(); },
    },
    {
      key: 'memo-insert-memo',
      label: '위에 빈칸 삽입',
      icon: <BlankRowIcon />,
      onClick: () => { onInsertMemoAbove(); onClose(); },
    },
    {
      key: 'memo-delete',
      label: '빈칸 삭제',
      icon: <TrashIcon className="w-[1em] h-[1em]" />,
      onClick: () => { onDelete(); onClose(); },
    },
  ];

  return (
    <ContextMenuShell x={x} y={y} ariaLabel={`${text || '빈칸'} 컨텍스트 메뉴`}
      testId="watchlist-memo-row-menu" items={items} onClose={onClose} />
  );
}
