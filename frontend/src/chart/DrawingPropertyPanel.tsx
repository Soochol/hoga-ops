// frontend/src/chart/DrawingPropertyPanel.tsx
//
// Drawing Property Panel — the floating DOM affordance that lets the user
// edit the selected Drawing's color, stroke width, and line style, and
// delete it. See CONTEXT.md "Drawing Property Panel" and ADR-0032.

import { useCallback, useMemo, useState, useRef } from 'react';
import { EMPTY_SELECTION, useDrawingsStore } from '../state/drawings';
import { useDismissablePopover } from '../util/useDismissablePopover';
import {
  eligibleFor, planAlign, planDistribute,
  type AlignCoords, type AlignEdge, type DistributeAxis,
} from './drawing/translate';
import {
  COLOR_PALETTE,
  STROKE_WIDTHS,
  LINE_STYLES,
  RECT_FILL_OPACITIES,
  TEXT_FONT_SIZES,
  isLocked,
  isExtendedRight,
  type DrawingKind,
  type LineStyle,
  type Drawing,
} from './drawing/types';

export type DrawingAnchor = { x: number; y: number };
export type ComputeAnchorFn = (d: Drawing) => DrawingAnchor | null;

// The panel now docks to the chart's top-center (see the re-dock effect) rather
// than anchoring to each drawing, so it takes no positioning props.
type Props = {
  /** 이 패널이 붙은 차트의 (종목, 봉 슬롯) scope — 선택 드로잉 조회·변이의
   *  귀속 대상(C2c-2b). */
  scope: string | null;
  /**
   * 지금 화면 오른쪽 끝의 시각(real Unix-ms), 또는 null.
   *
   * 사각형의 "보이는 영역까지 우측 확장" 버튼이 쓰는 단 하나의 차트 정보다. 이
   * 패널은 `IChartApi` 를 받지 않는다 — DOM 툴바가 차트 API 를 쥐면 좌표 규칙이
   * 두 곳으로 갈라지므로, 차트를 아는 호스트(LiveChartRoot)가 값 하나만 내려 준다.
   * 없으면 그 버튼은 비활성이고 나머지 컨트롤은 그대로 동작한다.
   */
  resolveVisibleRightRealMs?: () => number | null;
  /**
   * 정렬·분배가 쓸 좌표 뭉치. `resolveVisibleRightRealMs` 와 같은 이유로 함수다 —
   * 이 패널은 `IChartApi` 를 쥐지 않고, 차트를 아는 호스트가 만들어 내려 준다.
   * 없으면 정렬 버튼이 비활성이고 나머지는 그대로 동작한다.
   */
  resolveAlignCoords?: () => AlignCoords | null;
};

const LINE_STYLE_LABELS: Record<LineStyle, string> = {
  solid: '실선',
  dashed: '대시',
  dotted: '도트',
};

const previewBorderStyle = (style: LineStyle): 'solid' | 'dashed' | 'dotted' =>
  style === 'solid' ? 'solid' : style === 'dashed' ? 'dashed' : 'dotted';

type OpenPopover = 'color' | 'thickness' | 'lineStyle' | 'fill' | 'fontSize' | 'align' | null;

/** 참조 안정 빈 목록 — 셀렉터 fallback (EMPTY_SELECTION 과 같은 이유). */
const EMPTY_DRAWINGS: readonly Drawing[] = [];

/** Top-center dock offset from the chart's top edge (candle pane top). */
const TOP_DOCK_Y = 8;

/** 다중 선택에서 일괄 편집할 수 있는 스타일 속성. */
type StyleProp = 'color' | 'width' | 'lineStyle' | 'fillOpacity' | 'fontSize';

/** 값이 갈렸을 때 트리거에 쓰는 라벨. */
const MIXED_LABEL = '혼합';

/**
 * 이 종류가 그 스타일 속성을 갖는가.
 *
 * 표시 여부 · 혼합값 계산 · 패치 생성 **셋이 같은 판정을 써야 한다.** 갈리면
 * 두 가지로 조용히 망가진다: 텍스트에 `width` 를 흘려 저장 데이터에 유령 필드가
 * 남거나, 사각형만 가진 속성을 못 고치게 된다.
 */
function kindHasProp(kind: DrawingKind, prop: StyleProp): boolean {
  switch (prop) {
    case 'color':
      return true;
    // 텍스트는 획이 없다 — 대신 글자 크기를 갖는다.
    case 'width':
    case 'lineStyle':
      return kind !== 'text';
    case 'fillOpacity':
      return kind === 'rect';
    case 'fontSize':
      return kind === 'text';
  }
}

function carriersOf(members: readonly Drawing[], prop: StyleProp): Drawing[] {
  return members.filter((m) => kindHasProp(m.kind, prop));
}

/**
 * 이 속성을 **가진 멤버들**의 공통값.
 *
 * 세 결과가 서로 다른 뜻이다:
 *  - 값          — 전원이 같다. 트리거가 그 값을, 팝오버가 그 줄을 강조한다.
 *  - `null`      — 갈렸다(혼합). 트리거는 "혼합", 팝오버는 **아무 줄도** 강조하지 않는다.
 *  - `undefined` — 가진 멤버가 아예 없다. **컨트롤 자체를 숨긴다.**
 *
 * ⚠ carrier 만 센다. 추세선 2개(둘 다 2px) + 텍스트 1개의 두께는 "혼합" 이 아니라
 * "2px" 다 — 텍스트는 두께라는 개념이 없지 갈린 값을 가진 게 아니다.
 */
function commonValue(members: readonly Drawing[], prop: StyleProp): string | number | null | undefined {
  const carriers = carriersOf(members, prop);
  if (carriers.length === 0) return undefined;
  const read = (d: Drawing) => (d as unknown as Record<string, string | number>)[prop];
  const first = read(carriers[0]);
  return carriers.every((m) => read(m) === first) ? first : null;
}

/** 팝오버 껍데기 — 위치·테두리·그림자만. 안의 목록은 호출부가 넣는다. */
function PopoverShell({ wide, children }: { wide?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={
        'absolute top-full left-0 mt-1 bg-bg-card border border-border rounded-md shadow-xl ' +
        // min-w-max: containing block 인 툴바가 좁아지면 shrink-to-fit 으로 눌려
        // grid-cols-4 의 minmax(0,1fr) 열이 붕괴하고 스와치가 겹친다(형제 메뉴들의
        // min-w-[7rem] 과 달리 색 격자는 고정폭 자식이라 max-content 가 기준).
        (wide ? 'min-w-max p-2' : 'p-1 min-w-[7rem]')
      }
    >
      {children}
    </div>
  );
}

/** 목록형 팝오버의 한 줄. `selected` 는 **현재 값과 일치**할 때만 참이다 —
 *  다중 선택에서 값이 갈리면(혼합) 어느 줄도 강조되지 않는다. */
function PopoverItem({
  testId, selected, onClick, style, children,
}: {
  testId: string;
  selected: boolean;
  onClick: () => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      style={style}
      className={
        'w-full px-2 py-1 flex items-center gap-2 rounded text-xs ' +
        (selected ? 'bg-bg-input-hover text-accent' : 'text-fg hover:bg-bg-input-hover')
      }
    >
      {children}
    </button>
  );
}

// 아래 다섯 팝오버는 단일 선택 패널과 다중 선택 툴바가 **함께** 쓴다. `current` 가
// null 이면 "값이 갈렸다"(혼합)는 뜻이고, 그때는 아무 줄도 강조하지 않는다.

function ColorPalettePopover({ current, onPick }: { current: string | null; onPick: (hex: string) => void }) {
  return (
    <PopoverShell wide>
      <div className="grid grid-cols-4 gap-1.5">
        {COLOR_PALETTE.map((hex) => (
          <button
            key={hex}
            type="button"
            data-testid={`drawing-color-swatch-${hex}`}
            onClick={() => onPick(hex)}
            className={'w-6 h-6 rounded border-2 ' + (hex === current ? 'border-white' : 'border-transparent')}
            style={{ background: hex }}
            aria-label={hex}
          />
        ))}
      </div>
    </PopoverShell>
  );
}

function WidthPopover({ current, onPick }: { current: number | null; onPick: (w: number) => void }) {
  return (
    <PopoverShell>
      {STROKE_WIDTHS.map((w) => (
        <PopoverItem key={w} testId={`drawing-thickness-item-${w}`} selected={w === current} onClick={() => onPick(w)}>
          <span className="inline-block w-6 border-t border-current" style={{ borderTopWidth: w }} />
          <span className="tabular-nums">{w}px</span>
        </PopoverItem>
      ))}
    </PopoverShell>
  );
}

function LineStylePopover({ current, onPick }: { current: LineStyle | null; onPick: (s: LineStyle) => void }) {
  return (
    <PopoverShell>
      {LINE_STYLES.map((style) => (
        <PopoverItem
          key={style}
          testId={`drawing-line-style-item-${style}`}
          selected={style === current}
          onClick={() => onPick(style)}
        >
          <span
            className="inline-block w-6 border-t border-current"
            style={{ borderTopStyle: previewBorderStyle(style), borderTopWidth: 1.5 }}
          />
          {LINE_STYLE_LABELS[style]}
        </PopoverItem>
      ))}
    </PopoverShell>
  );
}

function FillOpacityPopover({
  current, previewColor, onPick,
}: { current: number | null; previewColor: string; onPick: (op: number) => void }) {
  return (
    <PopoverShell>
      {RECT_FILL_OPACITIES.map((op) => (
        <PopoverItem key={op} testId={`drawing-fill-item-${op}`} selected={op === current} onClick={() => onPick(op)}>
          <span
            className="inline-block h-4 w-6 rounded-sm border border-fg-dim"
            style={{ background: previewColor, opacity: Math.max(0.12, op) }}
          />
          <span className="tabular-nums">{Math.round(op * 100)}%</span>
        </PopoverItem>
      ))}
    </PopoverShell>
  );
}

function FontSizePopover({ current, onPick }: { current: number | null; onPick: (size: number) => void }) {
  return (
    <PopoverShell>
      {TEXT_FONT_SIZES.map((size) => (
        <PopoverItem
          key={size}
          testId={`drawing-font-size-item-${size}`}
          selected={size === current}
          onClick={() => onPick(size)}
          style={{ fontSize: Math.min(size, 18) }}
        >
          <span className="tabular-nums">{size}px</span>
        </PopoverItem>
      ))}
    </PopoverShell>
  );
}

/** 정렬 6 + 분배 2. 각 항목이 자기 비활성 조건을 함께 들고 다닌다. */
const ALIGN_ITEMS: { edge: AlignEdge; label: string }[] = [
  { edge: 'left', label: '왼쪽' },
  { edge: 'hcenter', label: '가로 가운데' },
  { edge: 'right', label: '오른쪽' },
  { edge: 'top', label: '위' },
  { edge: 'vcenter', label: '세로 가운데' },
  { edge: 'bottom', label: '아래' },
];
const DISTRIBUTE_ITEMS: { axis: DistributeAxis; label: string }[] = [
  { axis: 'horizontal', label: '가로 균등' },
  { axis: 'vertical', label: '세로 균등' },
];

/**
 * 정렬·분배 팝오버.
 *
 * 비활성 판정이 커널과 **같은 술어**(`eligibleFor`)를 쓴다 — 갈리면 눌리는데 아무
 * 일도 안 하는 버튼이 생긴다. 정렬은 그 축에 자격 있는 멤버가 **둘 이상**, 분배는
 * **셋 이상**이어야 한다(둘은 양 끝이라 나눌 사이가 없다).
 *
 * hline 은 x 축에, vline 은 y 축에 자격이 없다 — 각각 캔버스 전폭·전고를 차지해
 * 그 축의 "가장자리" 가 없기 때문이다. 그래서 hline 만 고른 선택에서는 가로 항목이
 * 전부 비활성이고 세로 항목은 살아 있다.
 */
function AlignPopover({
  members, coords, onDone,
}: {
  members: readonly Drawing[];
  coords: AlignCoords | null;
  onDone: (patches: { id: string; patch: Partial<Drawing> }[]) => void;
}) {
  const xCount = eligibleFor(members, 'x').length;
  const yCount = eligibleFor(members, 'y').length;
  const canAlign = (edge: AlignEdge) =>
    coords != null && (edge === 'left' || edge === 'hcenter' || edge === 'right' ? xCount : yCount) >= 2;
  const canDistribute = (axis: DistributeAxis) =>
    coords != null && (axis === 'horizontal' ? xCount : yCount) >= 3;
  const itemCls = (enabled: boolean) =>
    'w-full px-2 py-1 flex items-center rounded text-xs ' +
    (enabled ? 'text-fg hover:bg-bg-input-hover' : 'text-fg-dim opacity-40 cursor-not-allowed');

  return (
    <PopoverShell>
      {ALIGN_ITEMS.map(({ edge, label }) => (
        <button
          key={edge}
          type="button"
          data-testid={`drawing-align-${edge}`}
          disabled={!canAlign(edge)}
          onClick={() => coords && onDone(planAlign(members, edge, coords))}
          className={itemCls(canAlign(edge))}
        >
          {label}
        </button>
      ))}
      <div className="my-1 h-px bg-border" />
      {DISTRIBUTE_ITEMS.map(({ axis, label }) => (
        <button
          key={axis}
          type="button"
          data-testid={`drawing-distribute-${axis}`}
          disabled={!canDistribute(axis)}
          onClick={() => coords && onDone(planDistribute(members, axis, coords))}
          className={itemCls(canDistribute(axis))}
        >
          {label}
        </button>
      ))}
    </PopoverShell>
  );
}

/**
 * 겹침 순서 버튼 한 쌍 — 단일 패널과 다중 툴바가 함께 쓴다.
 *
 * 배열 순서가 곧 z-order 이고, 그것이 **클릭이 어느 도형에 가는지**를 정한다
 * (`hitTestDrawings` 는 뒤에서부터 훑어 최상단을 집는다). 겹친 도형 중 아래 것을
 * 골라 올릴 방법이 그전에는 없었다.
 */
function ZOrderButtons({
  scope, ids, disabled,
}: { scope: string; ids: readonly string[]; disabled: boolean }) {
  const cls =
    'h-7 w-7 inline-flex items-center justify-center rounded text-xs text-fg-dim' +
    (disabled ? ' opacity-40 cursor-not-allowed' : ' hover:bg-bg-input-hover');
  const move = (to: 'front' | 'back') => useDrawingsStore.getState().reorder(scope, ids, to);
  return (
    <>
      <button
        type="button"
        data-testid="drawing-bring-front"
        aria-label="맨 앞으로"
        title="맨 앞으로 — 겹친 도형 위로 올립니다"
        disabled={disabled}
        onClick={() => move('front')}
        className={cls}
      >
        앞
      </button>
      <button
        type="button"
        data-testid="drawing-send-back"
        aria-label="맨 뒤로"
        title="맨 뒤로 — 겹친 도형 아래로 내립니다"
        disabled={disabled}
        onClick={() => move('back')}
        className={cls}
      >
        뒤
      </button>
    </>
  );
}

/**
 * 다중 선택 툴바 — 개수, 스타일 일괄 편집, 겹침 순서, 잠금·삭제.
 *
 * 컨트롤이 뜨는 규칙은 하나다: **그 속성을 가진 멤버가 하나라도 있으면 뜬다.**
 * 적용도 그 멤버들에게만 간다(`kindHasProp`). 그래서 추세선과 텍스트를 함께 골라
 * 두께를 바꾸면 추세선만 굵어진다 — 텍스트에 획이 없기 때문이고, 이건 잠긴 항목을
 * 건너뛰는 것과 같은 종류의 부분 적용이다.
 *
 * 값이 갈리면 트리거가 "혼합" 을 보이고 팝오버는 아무 줄도 강조하지 않는다. 고르는
 * 순간 전원이 그 값으로 맞춰지므로, 혼합은 **읽기 상태일 뿐 쓰기 상태가 아니다.**
 *
 * per-kind sticky(다음에 그릴 도형이 물려받는 마지막 스타일)는 **갱신하지 않는다.**
 * `updateMany` 가 그 경로를 의도적으로 안 타기도 하고, 종류가 섞인 배치를 어느 kind
 * 의 sticky 에 귀속시킬지가 정의되지 않는다. 단건 편집과 비대칭이지만, 임의로 하나를
 * 고르는 것보다 안 건드리는 편이 설명 가능하다.
 *
 * **집합에는 잠긴 도형이 섞일 수 있다.** 그래서 자물쇠는 토글이고(하나라도 안
 * 잠겼으면 잠금, 전부 잠겼으면 해제), 잠근 뒤에도 선택을 비우지 않는다 — 잠긴
 * 채로 선택된 상태가 이제 정당하기 때문이다. 그 상태의 툴바가 곧 해제 버튼을
 * 내밀므로 잠금이 **그 자리에서 되돌려진다**.
 *
 * 표시는 잠긴 것까지 읽고, **편집은 잠기지 않은 것에만 간다**(#1667 의 문장을
 * 빌리면 "a lock forbids editing, not measuring"). 그래서 일괄 적용 뒤에도 잠긴
 * 멤버가 옛 값을 지켜 "혼합" 이 남을 수 있다 — 거짓이 아니라 사실이다.
 *
 * 적용 대상이 하나도 없는 컨트롤은 **숨기지 않고 비활성**한다. 단일 패널이 같은
 * 판단을 한다: 눌리는데 아무 일도 안 나는 버튼이 고장으로 읽힌다.
 */
function MultiSelectionToolbar({
  scope, ids, resolveAlignCoords, resolveVisibleRightRealMs,
}: {
  scope: string;
  ids: readonly string[];
  resolveAlignCoords?: () => AlignCoords | null;
  resolveVisibleRightRealMs?: () => number | null;
}) {
  // 도형 배열은 **안정 참조**를 구독하고 멤버는 파생한다. 셀렉터 안에서 filter/map
  // 하면 매 렌더 새 배열이라 무한 리렌더가 된다(EMPTY_SELECTION 과 같은 함정).
  const items = useDrawingsStore((s) => s.byScope.get(scope) ?? EMPTY_DRAWINGS);
  const members = useMemo(
    () => ids.map((id) => items.find((d) => d.id === id)).filter((d): d is Drawing => d != null),
    [items, ids],
  );
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closePopover = useCallback(() => setOpenPopover(null), []);
  useDismissablePopover(openPopover != null, rootRef, closePopover);

  // 잠금 혼재. `allLocked` 는 자물쇠의 방향을, `lockedCount` 는 개수 표시를 정한다
  // (DrawingMenu 의 일괄 잠금과 같은 규칙).
  const lockedCount = members.filter((m) => isLocked(m)).length;
  const allLocked = members.length > 0 && lockedCount === members.length;
  /** 이 속성을 실제로 고칠 수 있는 멤버가 있는가 — 없으면 컨트롤을 비활성한다. */
  const editable = (prop: StyleProp) => carriersOf(members, prop).some((m) => !isLocked(m));

  // 우측 확장은 사각형 전용 **속성**이지 스타일이 아니다 — 불리언이고 토글 의미라
  // `StyleProp` 의 혼합값·팝오버 기계에 맞지 않는다. 잠금 버튼과 같은 모양으로 다룬다.
  const rects = members.filter((m) => m.kind === 'rect');
  const allExtended = rects.length > 0 && rects.every((r) => isExtendedRight(r));
  const canToggleExtend = rects.some((r) => !isLocked(r));
  // "보이는 영역까지" 는 무한 확장 중인 사각형에 아무것도 바꾸지 않는다(이미 화면 끝
  // 이다) — 단일 패널이 같은 이유로 비활성한다. 손댈 수 있는 사각형이 하나도 없으면
  // 버튼을 죽인다: 눌리는데 아무 일도 안 나는 것이 고장으로 읽힌다.
  const extendToViewTargets = rects.filter((r) => !isLocked(r) && !isExtendedRight(r));
  const canExtendToView = resolveVisibleRightRealMs != null && extendToViewTargets.length > 0;

  const color = commonValue(members, 'color') as string | null | undefined;
  const width = commonValue(members, 'width') as number | null | undefined;
  const lineStyle = commonValue(members, 'lineStyle') as LineStyle | null | undefined;
  const fillOpacity = commonValue(members, 'fillOpacity') as number | null | undefined;
  const fontSize = commonValue(members, 'fontSize') as number | null | undefined;

  /** 한 속성을 집합에 일괄 적용 — carrier 에게만, 되돌리기 한 단계로. */
  const apply = (prop: StyleProp, value: string | number) => {
    const patches = carriersOf(members, prop).map((m) => ({
      id: m.id,
      patch: { [prop]: value } as Partial<Drawing>,
    }));
    useDrawingsStore.getState().updateMany(scope, patches);
    setOpenPopover(null);
  };

  const toggle = (which: Exclude<OpenPopover, null>) =>
    setOpenPopover(openPopover === which ? null : which);
  const triggerBase = 'h-7 px-2 inline-flex items-center rounded';
  const triggerClass = (prop: StyleProp) =>
    triggerBase + (editable(prop) ? ' hover:bg-bg-input-hover' : ' opacity-40 cursor-not-allowed');
  // 혼합일 때의 색 바 — 값이 하나로 정해지지 않았음을 색 대신 줄무늬로 말한다.
  const MIXED_BAR = 'repeating-linear-gradient(45deg, var(--fg-dim) 0 2px, transparent 2px 4px)';

  return (
    <div
      ref={rootRef}
      data-drawing-property-panel
      data-testid="drawing-multi-selection-panel"
      className="absolute z-30 inline-flex items-center gap-0.5 bg-bg-card border border-border rounded-lg p-1 pl-2.5 shadow-lg"
      style={{ top: TOP_DOCK_Y, left: '50%', transform: 'translateX(-50%)' }}
    >
      <span data-testid="drawing-multi-count" className="mr-1 text-xs text-fg-dim tabular-nums">
        {ids.length}개 선택{lockedCount > 0 && ` · ${lockedCount} 잠김`}
      </span>
      <div className="w-px h-4 bg-border mx-0.5" />

      <button
        type="button"
        data-testid="drawing-color-trigger"
        aria-label="색상"
        disabled={!editable('color')}
        onClick={() => toggle('color')}
        className={triggerClass('color') + ' flex-col justify-center gap-0.5'}
      >
        <span className="text-sm leading-none">✎</span>
        <span
          data-testid="drawing-color-bar"
          className="block h-[3px] w-4 rounded-sm"
          style={color == null ? { background: MIXED_BAR } : { background: color }}
        />
      </button>
      {openPopover === 'color' && (
        <ColorPalettePopover current={color ?? null} onPick={(hex) => apply('color', hex)} />
      )}

      {width !== undefined && (
        <button
          type="button"
          data-testid="drawing-thickness-trigger"
          aria-label="두께"
          disabled={!editable('width')}
          onClick={() => toggle('thickness')}
          className={triggerClass('width') + ' gap-1.5 text-xs'}
        >
          <span className="inline-block w-4 border-t border-fg" style={{ borderTopWidth: width ?? 1 }} />
          <span className="tabular-nums">{width == null ? MIXED_LABEL : `${width}px`}</span>
        </button>
      )}
      {openPopover === 'thickness' && (
        <WidthPopover current={width ?? null} onPick={(w) => apply('width', w)} />
      )}

      {lineStyle !== undefined && (
        <button
          type="button"
          data-testid="drawing-line-style-trigger"
          data-current-style={lineStyle ?? 'mixed'}
          aria-label="선 스타일"
          disabled={!editable('lineStyle')}
          onClick={() => toggle('lineStyle')}
          className={triggerClass('lineStyle')}
        >
          <span
            className="inline-block w-4 border-t border-fg"
            style={{
              borderTopStyle: previewBorderStyle(lineStyle ?? 'dotted'),
              borderTopWidth: 1.5,
              opacity: lineStyle == null ? 0.5 : 1,
            }}
          />
        </button>
      )}
      {openPopover === 'lineStyle' && (
        <LineStylePopover current={lineStyle ?? null} onPick={(st) => apply('lineStyle', st)} />
      )}

      {fillOpacity !== undefined && (
        <button
          type="button"
          data-testid="drawing-fill-trigger"
          aria-label="채우기 농도"
          disabled={!editable('fillOpacity')}
          onClick={() => toggle('fill')}
          className={triggerClass('fillOpacity') + ' gap-1.5 text-xs'}
        >
          <span
            className="inline-block h-4 w-4 rounded-sm border border-fg-dim"
            style={{ background: color ?? 'var(--fg-dim)', opacity: Math.max(0.15, fillOpacity ?? 0.2) }}
          />
          <span className="tabular-nums">
            {fillOpacity == null ? MIXED_LABEL : `${Math.round(fillOpacity * 100)}%`}
          </span>
        </button>
      )}
      {openPopover === 'fill' && (
        <FillOpacityPopover
          current={fillOpacity ?? null}
          previewColor={color ?? 'var(--fg-dim)'}
          onPick={(op) => apply('fillOpacity', op)}
        />
      )}

      {/* 단일 패널과 **같은 testid** 를 쓴다 — 단일과 다중은 배타적으로 렌더되므로
          충돌하지 않고, 복사본 testid 를 만들면 grep 표면이 갈린다(팝오버와 같은 규율).
          글리프의 뜻도 그대로다: `→` 는 끝이 열려 "계속 간다", `⇥` 는 "여기서 멈춘다". */}
      {rects.length > 0 && (
        <>
          <button
            type="button"
            data-testid="drawing-extend-right"
            aria-label="우측 무한 확장"
            aria-pressed={allExtended}
            disabled={!canToggleExtend}
            title={
              allExtended
                ? '선택한 사각형의 우측 무한 확장을 함께 해제합니다'
                : '선택한 사각형의 오른쪽 변을 항상 화면 끝에 붙입니다'
            }
            onClick={() =>
              useDrawingsStore.getState().updateMany(
                scope,
                // 해제도 `false` 를 쓴다 — 단일 패널과 같은 표현이고, 저장 단계가
                // `extendRight !== true` 를 지운다(persistence).
                rects.map((r) => ({ id: r.id, patch: { extendRight: !allExtended } as Partial<Drawing> })),
              )
            }
            className={
              'h-7 w-7 inline-flex items-center justify-center rounded leading-none' +
              (!canToggleExtend
                ? ' opacity-40 cursor-not-allowed'
                : allExtended
                  ? ' bg-tint-selection text-accent'
                  : ' text-fg-dim hover:bg-bg-input-hover')
            }
          >
            →
          </button>
          <button
            type="button"
            data-testid="drawing-extend-to-view"
            aria-label="보이는 영역까지 우측 확장"
            disabled={!canExtendToView}
            title={
              allExtended
                ? '우측 무한 확장이 켜져 있어 이미 화면 끝까지 닿아 있습니다'
                : '선택한 사각형의 오른쪽 변을 지금 화면 끝에 맞춥니다 (Ctrl+Z 로 되돌리기)'
            }
            onClick={() => {
              // 좌표는 **누르는 시점**에 한 번만 굳힌다 — 멤버마다 다시 물으면 그 사이
              // 팬·줌이 끼어들어 사각형마다 다른 끝에 맞을 수 있다(정렬과 같은 규칙).
              const rightMs = resolveVisibleRightRealMs?.() ?? null;
              if (rightMs == null) return;
              const patches = extendToViewTargets.flatMap((r) => {
                if (r.kind !== 'rect') return [];
                // 어느 코너가 오른쪽인지는 저장 순서(a/b)가 아니라 realMs 비교로 정한다.
                // 핸들을 가로질러 끌면 `a` 가 `b` 의 오른쪽에 놓이므로, `b` 를 고정으로
                // 삼으면 그 사각형은 **왼쪽 변이 끌려가 뒤집힌다**(단일 패널의 함정을
                // 그대로 옮겨 왔다). price 는 보존한다 — 이 버튼은 가로 폭만 다룬다.
                const farKey = r.b.realMs >= r.a.realMs ? 'b' : 'a';
                const far = r[farKey];
                if (far.realMs === rightMs) return []; // 이미 그 자리
                return [{ id: r.id, patch: { [farKey]: { realMs: rightMs, price: far.price } } as Partial<Drawing> }];
              });
              useDrawingsStore.getState().updateMany(scope, patches);
            }}
            className={
              'h-7 w-7 inline-flex items-center justify-center rounded leading-none' +
              (canExtendToView ? ' text-fg-dim hover:bg-bg-input-hover' : ' opacity-40 cursor-not-allowed')
            }
          >
            ⇥
          </button>
        </>
      )}

      {fontSize !== undefined && (
        <button
          type="button"
          data-testid="drawing-font-size-trigger"
          aria-label="글자 크기"
          disabled={!editable('fontSize')}
          onClick={() => toggle('fontSize')}
          className={triggerClass('fontSize') + ' gap-1 text-xs'}
        >
          <span className="font-semibold leading-none">A</span>
          <span className="tabular-nums">{fontSize == null ? MIXED_LABEL : `${fontSize}px`}</span>
        </button>
      )}
      {openPopover === 'fontSize' && (
        <FontSizePopover current={fontSize ?? null} onPick={(size) => apply('fontSize', size)} />
      )}

      <div className="w-px h-4 bg-border mx-0.5" />
      <button
        type="button"
        data-testid="drawing-align-trigger"
        aria-label="정렬"
        title="정렬·분배"
        disabled={allLocked}
        onClick={() => toggle('align')}
        className={
          'h-7 px-2 inline-flex items-center rounded text-xs text-fg-dim' +
          (allLocked ? ' opacity-40 cursor-not-allowed' : ' hover:bg-bg-input-hover')
        }
      >
        정렬
      </button>
      {openPopover === 'align' && (
        <AlignPopover
          members={members}
          // 좌표는 **팝오버를 여는 시점**이 아니라 누르는 시점에 굳는다 — 그 사이
          // 팬·줌이 있었다면 옛 좌표로 정렬해서 눈에 보이는 것과 어긋난다.
          coords={resolveAlignCoords?.() ?? null}
          onDone={(patches) => {
            useDrawingsStore.getState().updateMany(scope, patches);
            setOpenPopover(null);
          }}
        />
      )}
      {/* 순서 변경은 편집이라 전부 잠겼으면 비활성된다 — 스타일·삭제와 같은 판정. */}
      <ZOrderButtons scope={scope} ids={ids} disabled={allLocked} />
      <button
        type="button"
        data-testid="drawing-multi-lock"
        aria-label={allLocked ? '선택 잠금 해제' : '선택 잠금'}
        aria-pressed={allLocked}
        title={
          allLocked
            ? '선택한 도형의 잠금을 함께 풉니다'
            : '선택한 도형을 잠급니다 — 이동·수정·삭제를 막습니다'
        }
        onClick={() =>
          useDrawingsStore.getState().updateMany(
            scope,
            // 키가 `locked` 뿐인 패치라 잠긴 항목에도 적용된다 — 그것이 일괄 해제의
            // 통로다(updateMany 참조). 해제는 `false` 를 쓴다: 단일 패널과 같은
            // 표현이고, 저장 단계가 `locked !== true` 를 지운다(persistence).
            ids.map((id) => ({ id, patch: { locked: !allLocked } as Partial<Drawing> })),
          )
        }
        className={
          'h-7 w-7 inline-flex items-center justify-center rounded hover:bg-bg-input-hover ' +
          (allLocked ? 'bg-tint-selection text-accent' : 'text-fg-dim')
        }
      >
        {allLocked ? '🔒' : '🔓'}
      </button>
      <button
        type="button"
        data-testid="drawing-multi-delete"
        aria-label="선택 삭제"
        title="선택한 도형을 모두 삭제합니다 (Delete)"
        disabled={allLocked}
        onClick={() => useDrawingsStore.getState().removeMany(scope, ids)}
        className={
          'h-7 w-7 inline-flex items-center justify-center rounded text-[#F43F5E]' +
          (allLocked ? ' opacity-40 cursor-not-allowed' : ' hover:bg-bg-input-hover')
        }
      >
        🗑
      </button>
    </div>
  );
}

export default function DrawingPropertyPanel({
  scope, resolveVisibleRightRealMs, resolveAlignCoords,
}: Props) {
  const activeTool = useDrawingsStore((s) => s.activeTool);
  const selectedIds = useDrawingsStore((s) =>
    scope ? s.selectedByScope.get(scope) ?? EMPTY_SELECTION : EMPTY_SELECTION,
  );
  // 스타일 편집기는 **단일 선택 전용**이다. 두 개 이상이면 아래 슬림 툴바로
  // 갈라진다 — 종류가 섞인 집합에서는 편집할 공통 속성이 애초에 정의되지 않는다
  // (텍스트의 글자 크기, 사각형의 채움 불투명도는 서로에게 없는 필드다).
  const drawing = useDrawingsStore((s) => {
    if (scope == null) return null;
    const sel = s.selectedByScope.get(scope) ?? EMPTY_SELECTION;
    return sel.length === 1 ? s.byScope.get(scope)?.find((d) => d.id === sel[0]) ?? null : null;
  });

  const hiddenAll = useDrawingsStore((s) => s.defaults.hiddenAll);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The panel is a fixed toolbar docked to the chart's top-center (candle pane
  // top) — CSS `left:50%` + translateX(-50%), so it reads as a toolbar rather
  // than a panel chasing each shape. Positioning is pure CSS (no drag/measure),
  // superseding the draggable/sticky model of ADR-0108/ADR-0032.

  const closePopover = useCallback(() => setOpenPopover(null), []);
  useDismissablePopover(openPopover != null, rootRef, closePopover);

  // Visibility gate. The hiddenAll clause keeps the editor off a hidden layer —
  // there's no shape on screen to point at.
  if (activeTool !== 'select' || selectedIds.length === 0 || hiddenAll || scope == null) return null;

  if (selectedIds.length > 1) {
    return (
      <MultiSelectionToolbar
        scope={scope}
        ids={selectedIds}
        resolveAlignCoords={resolveAlignCoords}
        resolveVisibleRightRealMs={resolveVisibleRightRealMs}
      />
    );
  }
  if (drawing == null) return null;

  const id = selectedIds[0];
  // 잠기면 자물쇠만 살아 있다. 이건 정확성이 아니라 감촉이다 — 스토어가 어차피
  // 거부하므로(ADR-0164), 여기 disabled 는 "눌리는데 아무 일도 안 나는 버튼"이
  // 고장으로 읽히는 것을 막는 몫이다.
  const locked = isLocked(drawing);
  const controlDisabled = locked ? ' opacity-40 cursor-not-allowed' : ' hover:bg-bg-input-hover';
  // 잠금은 열려 있던 팝오버도 닫는다. `useDismissablePopover` 는 **바깥** mousedown
  // 에만 반응하는데 자물쇠 버튼은 rootRef 안이라, 이 파생이 없으면 색상 팔레트를
  // 펼쳐 둔 채 잠갔을 때 그 팔레트가 전부 죽은 채로 남아 있는다.
  const shownPopover: OpenPopover = locked ? null : openPopover;

  const pickColor = (color: string) => {
    useDrawingsStore.getState().update(scope, id, { color });
    setOpenPopover(null);
  };

  const pickWidth = (width: number) => {
    useDrawingsStore.getState().update(scope, id, { width });
    setOpenPopover(null);
  };

  const pickLineStyle = (lineStyle: LineStyle) => {
    useDrawingsStore.getState().update(scope, id, { lineStyle });
    setOpenPopover(null);
  };

  const pickFillOpacity = (fillOpacity: number) => {
    useDrawingsStore.getState().update(scope, id, { fillOpacity } as Partial<Drawing>);
    setOpenPopover(null);
  };

  const pickFontSize = (fontSize: number) => {
    useDrawingsStore.getState().update(scope, id, { fontSize } as Partial<Drawing>);
    setOpenPopover(null);
  };

  const extendedRight = isExtendedRight(drawing);
  // 무한 확장 중에는 "보이는 영역까지" 가 **화면상 아무것도 바꾸지 않는다** — 오른쪽
  // 변이 이미 화면 끝이다. 좌표는 조용히 바뀌므로 버튼은 "먹통" 으로 읽힌다. 그래서
  // 비활성으로 두고 title 이 이유를 말한다. 확장을 좌표로 굳히고 싶으면 토글을 끄고
  // 누르면 된다 — 두 컨트롤의 순서가 그대로 그 절차다.
  const extendToViewDisabled = locked || extendedRight || resolveVisibleRightRealMs == null;

  /**
   * 오른쪽 코너를 **지금 화면 오른쪽 끝**으로. 늘리기도 줄이기도 한다("보이는
   * 영역까지" 가 곧 계약이다) — 되돌리기가 한 단계이므로 잘못 눌러도 비용이 없다.
   *
   * 어느 코너가 오른쪽인지는 저장 순서(a/b)가 아니라 `realMs` 비교로 정한다. 핸들을
   * 가로질러 끌면 `a` 가 `b` 의 오른쪽에 놓이므로, `b` 를 고정으로 삼으면 그 사각형은
   * 왼쪽 변이 끌려가 뒤집힌다. **price 는 보존한다** — 이 버튼은 가로 폭만 다룬다.
   */
  const extendToView = () => {
    if (drawing.kind !== 'rect') return;
    const rightMs = resolveVisibleRightRealMs?.() ?? null;
    if (rightMs == null) return;
    const farKey = drawing.b.realMs >= drawing.a.realMs ? 'b' : 'a';
    const far = drawing[farKey];
    // 이미 그 자리면 아무것도 하지 않는다 — 되돌리기 스택에 빈 단계를 쌓지 않기 위해.
    if (far.realMs === rightMs) return;
    useDrawingsStore
      .getState()
      .update(scope, id, { [farKey]: { realMs: rightMs, price: far.price } } as Partial<Drawing>);
  };

  // Text labels have no stroke width or line style; they carry a font size
  // instead. Hide the stroke controls and show a size picker for them.
  const isText = drawing.kind === 'text';

  return (
    <div
      ref={rootRef}
      data-drawing-property-panel
      data-testid="drawing-property-panel"
      className="absolute z-30 inline-flex items-center gap-0.5 bg-bg-card border border-border rounded-lg p-1 shadow-lg"
      style={{
        // Fixed toolbar, docked to the top-center of the chart (candle pane top).
        top: TOP_DOCK_Y,
        left: '50%',
        transform: 'translateX(-50%)',
      }}
    >
      <button
        type="button"
        data-testid="drawing-color-trigger"
        aria-label="색상"
        disabled={locked}
        onClick={() => setOpenPopover(openPopover === 'color' ? null : 'color')}
        className={'h-7 px-2 inline-flex flex-col items-center justify-center rounded gap-0.5' + controlDisabled}
      >
        <span className="text-sm leading-none">✎</span>
        <span
          data-testid="drawing-color-bar"
          className="block h-[3px] w-4 rounded-sm"
          style={{ background: drawing.color }}
        />
      </button>

      {shownPopover === 'color' && <ColorPalettePopover current={drawing.color} onPick={pickColor} />}

      {!isText && (
      <button
        type="button"
        data-testid="drawing-thickness-trigger"
        aria-label="두께"
        disabled={locked}
        onClick={() => setOpenPopover(openPopover === 'thickness' ? null : 'thickness')}
        className={'h-7 px-2 inline-flex items-center gap-1.5 rounded text-xs' + controlDisabled}
      >
        <span className="inline-block w-4 border-t border-fg" style={{ borderTopWidth: drawing.width }} />
        <span className="tabular-nums">{drawing.width}px</span>
      </button>
      )}

      {!isText && shownPopover === 'thickness' && (
        <WidthPopover current={drawing.width} onPick={pickWidth} />
      )}

      {!isText && (
      <button
        type="button"
        data-testid="drawing-line-style-trigger"
        data-current-style={drawing.lineStyle}
        aria-label="선 스타일"
        disabled={locked}
        onClick={() => setOpenPopover(openPopover === 'lineStyle' ? null : 'lineStyle')}
        className={'h-7 px-2 inline-flex items-center rounded' + controlDisabled}
      >
        <span
          className="inline-block w-4 border-t border-fg"
          style={{ borderTopStyle: previewBorderStyle(drawing.lineStyle), borderTopWidth: 1.5 }}
        />
      </button>
      )}

      {!isText && shownPopover === 'lineStyle' && (
        <LineStylePopover current={drawing.lineStyle} onPick={pickLineStyle} />
      )}

      {drawing.kind === 'rect' && (
        <>
          <button
            type="button"
            data-testid="drawing-fill-trigger"
            aria-label="채우기 농도"
            disabled={locked}
            onClick={() => setOpenPopover(openPopover === 'fill' ? null : 'fill')}
            className={'h-7 px-2 inline-flex items-center gap-1.5 rounded text-xs' + controlDisabled}
          >
            <span
              className="inline-block h-4 w-4 rounded-sm border border-fg-dim"
              style={{ background: drawing.color, opacity: Math.max(0.15, drawing.fillOpacity) }}
            />
            <span className="tabular-nums">{Math.round(drawing.fillOpacity * 100)}%</span>
          </button>

          {shownPopover === 'fill' && (
            <FillOpacityPopover
              current={drawing.fillOpacity}
              previewColor={drawing.color}
              onPick={pickFillOpacity}
            />
          )}

          {/* 우측 확장 두 개. **성격이 다르다** — 왼쪽은 도형에 붙는 지속 속성이고
              오른쪽은 좌표를 한 번 옮기는 액션이다. 그래서 하나는 눌린 상태를 갖고
              (aria-pressed) 하나는 안 갖는다. 글리프도 그 차이를 말한다: `→` 는
              끝이 열려 "계속 간다", `⇥` 는 막대에 닿아 "여기서 멈춘다". */}
          <button
            type="button"
            data-testid="drawing-extend-right"
            aria-label="우측 무한 확장"
            aria-pressed={extendedRight}
            disabled={locked}
            title={
              extendedRight
                ? '우측 무한 확장 해제 — 그린 폭으로 돌아갑니다'
                : '우측 무한 확장 — 오른쪽 변이 팬·줌과 무관하게 항상 화면 끝에 붙습니다'
            }
            onClick={() =>
              useDrawingsStore
                .getState()
                .update(scope, id, { extendRight: !extendedRight } as Partial<Drawing>)
            }
            className={
              // 크기 토큰을 **안 건다** — 상속(자물쇠·휴지통과 같은 13px)이다. `text-sm`
              // (11.5px)로 두면 획이 얇은 화살표가 옆의 이모지보다 눈에 띄게 작아
              // 같은 줄에서 무게가 어긋난다(실측). 임의값 px 는 밀도 다이얼을 이탈한다.
              'h-7 w-7 inline-flex items-center justify-center rounded leading-none' +
              (locked ? controlDisabled : extendedRight ? ' bg-tint-selection text-accent' : controlDisabled)
            }
          >
            →
          </button>

          <button
            type="button"
            data-testid="drawing-extend-to-view"
            aria-label="보이는 영역까지 우측 확장"
            disabled={extendToViewDisabled}
            title={
              extendedRight
                ? '우측 무한 확장이 켜져 있어 이미 화면 끝까지 닿아 있습니다'
                : '보이는 영역까지 우측 확장 — 오른쪽 변을 지금 화면 끝에 맞춥니다 (Ctrl+Z 로 되돌리기)'
            }
            onClick={extendToView}
            className={
              'h-7 w-7 inline-flex items-center justify-center rounded leading-none' +
              (extendToViewDisabled ? ' opacity-40 cursor-not-allowed' : ' hover:bg-bg-input-hover')
            }
          >
            ⇥
          </button>
        </>
      )}

      {isText && drawing.kind === 'text' && (
        <>
          <button
            type="button"
            data-testid="drawing-font-size-trigger"
            aria-label="글자 크기"
            disabled={locked}
            onClick={() => setOpenPopover(openPopover === 'fontSize' ? null : 'fontSize')}
            className={'h-7 px-2 inline-flex items-center gap-1 rounded text-xs' + controlDisabled}
          >
            <span className="font-semibold leading-none">A</span>
            <span className="tabular-nums">{drawing.fontSize}px</span>
          </button>

          {shownPopover === 'fontSize' && (
            <FontSizePopover current={drawing.fontSize} onPick={pickFontSize} />
          )}
        </>
      )}

      <div className="w-px h-4 bg-border mx-0.5" />
      <ZOrderButtons scope={scope} ids={[id]} disabled={locked} />
      {/* 자물쇠는 이 툴바에서 **잠금 상태와 무관하게 항상 살아 있는 유일한 컨트롤**
          이다 — 잠금을 푸는 다른 경로가 없다. 그래서 삭제 왼쪽, 구분선 오른쪽에
          둔다(스타일 그룹과 분리, 파괴적 동작 앞). */}
      <button
        type="button"
        data-testid="drawing-lock"
        aria-label={locked ? '잠금 해제' : '잠금'}
        aria-pressed={locked}
        title={locked ? '잠금 해제 — 이동·수정·삭제가 다시 가능해집니다' : '잠금 — 이동·수정·삭제를 막습니다'}
        onClick={() => useDrawingsStore.getState().update(scope, id, { locked: !locked } as Partial<Drawing>)}
        className={
          'h-7 w-7 inline-flex items-center justify-center rounded hover:bg-bg-input-hover ' +
          (locked ? 'bg-tint-selection text-accent' : 'text-fg-dim')
        }
      >
        {locked ? '🔒' : '🔓'}
      </button>
      <button
        type="button"
        data-testid="drawing-delete"
        aria-label="삭제"
        disabled={locked}
        onClick={() => useDrawingsStore.getState().remove(scope, id)}
        className={
          'h-7 w-7 inline-flex items-center justify-center rounded text-[#F43F5E]' + controlDisabled
        }
      >
        🗑
      </button>
    </div>
  );
}
