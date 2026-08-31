// frontend/src/chart/DrawingPropertyPanel.tsx
//
// Drawing Property Panel — the floating DOM affordance that lets the user
// edit the selected Drawing's color, stroke width, and line style, and
// delete it. See CONTEXT.md "Drawing Property Panel" and ADR-0032.

import { useCallback, useMemo, useState, useRef } from 'react';
import { EMPTY_SELECTION, useDrawingsStore } from '../state/drawings';
import { useDismissablePopover } from '../util/useDismissablePopover';
import {
  COLOR_PALETTE,
  STROKE_WIDTHS,
  LINE_STYLES,
  RECT_FILL_OPACITIES,
  TEXT_FONT_SIZES,
  isLocked,
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
};

const LINE_STYLE_LABELS: Record<LineStyle, string> = {
  solid: '실선',
  dashed: '대시',
  dotted: '도트',
};

const previewBorderStyle = (style: LineStyle): 'solid' | 'dashed' | 'dotted' =>
  style === 'solid' ? 'solid' : style === 'dashed' ? 'dashed' : 'dotted';

type OpenPopover = 'color' | 'thickness' | 'lineStyle' | 'fill' | 'fontSize' | null;

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

/**
 * 다중 선택 툴바 — 개수, 집합 전체에 뜻이 통하는 스타일 편집, 그리고 잠금·삭제.
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
 * 잠금이 **거는 방향만** 있는 것도 의도다. 다중 선택은 잠기지 않은 것만 모으므로
 * (hitTestUnlockedAt · drawingsInRect 모두 unlockedOnly 위에서 돈다) 이 집합에
 * 잠긴 도형은 원리적으로 없다. 그래서 "해제" 는 집합에 대상이 없고, 잠근 뒤에는
 * 선택을 비운다 — 잠긴 것을 선택에 남겨 두면 헤일로는 있는데 끌리지 않는,
 * 설명 없는 상태가 된다.
 */
function MultiSelectionToolbar({ scope, ids }: { scope: string; ids: readonly string[] }) {
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
  const triggerClass = 'h-7 px-2 inline-flex items-center rounded hover:bg-bg-input-hover';
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
        {ids.length}개 선택
      </span>
      <div className="w-px h-4 bg-border mx-0.5" />

      <button
        type="button"
        data-testid="drawing-color-trigger"
        aria-label="색상"
        onClick={() => toggle('color')}
        className={triggerClass + ' flex-col justify-center gap-0.5'}
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
          onClick={() => toggle('thickness')}
          className={triggerClass + ' gap-1.5 text-xs'}
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
          onClick={() => toggle('lineStyle')}
          className={triggerClass}
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
          onClick={() => toggle('fill')}
          className={triggerClass + ' gap-1.5 text-xs'}
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

      {fontSize !== undefined && (
        <button
          type="button"
          data-testid="drawing-font-size-trigger"
          aria-label="글자 크기"
          onClick={() => toggle('fontSize')}
          className={triggerClass + ' gap-1 text-xs'}
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
        data-testid="drawing-multi-lock"
        aria-label="선택 잠금"
        title="선택한 도형을 잠급니다 — 이동·수정·삭제를 막습니다"
        onClick={() => {
          const store = useDrawingsStore.getState();
          store.updateMany(scope, ids.map((id) => ({ id, patch: { locked: true } as Partial<Drawing> })));
          store.setSelected(scope, null);
        }}
        className="h-7 w-7 inline-flex items-center justify-center rounded text-fg-dim hover:bg-bg-input-hover"
      >
        🔒
      </button>
      <button
        type="button"
        data-testid="drawing-multi-delete"
        aria-label="선택 삭제"
        title="선택한 도형을 모두 삭제합니다 (Delete)"
        onClick={() => useDrawingsStore.getState().removeMany(scope, ids)}
        className="h-7 w-7 inline-flex items-center justify-center rounded text-[#F43F5E] hover:bg-bg-input-hover"
      >
        🗑
      </button>
    </div>
  );
}

export default function DrawingPropertyPanel({ scope }: Props) {
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
    return <MultiSelectionToolbar scope={scope} ids={selectedIds} />;
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
