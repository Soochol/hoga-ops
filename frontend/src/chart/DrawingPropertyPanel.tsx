// frontend/src/chart/DrawingPropertyPanel.tsx
//
// Drawing Property Panel — the floating DOM affordance that lets the user
// edit the selected Drawing's color, stroke width, and line style, and
// delete it. See CONTEXT.md "Drawing Property Panel" and ADR-0032.

import { useCallback, useState, useRef } from 'react';
import { EMPTY_SELECTION, useDrawingsStore } from '../state/drawings';
import { useDismissablePopover } from '../util/useDismissablePopover';
import {
  COLOR_PALETTE,
  STROKE_WIDTHS,
  LINE_STYLES,
  RECT_FILL_OPACITIES,
  TEXT_FONT_SIZES,
  isLocked,
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

/** Top-center dock offset from the chart's top edge (candle pane top). */
const TOP_DOCK_Y = 8;

/**
 * 다중 선택 툴바 — 개수와, 집합 전체에 뜻이 통하는 동작 둘만 남긴다.
 *
 * 스타일 컨트롤이 없는 이유는 자리 부족이 아니라 **의미의 부재**다: 선택에
 * 추세선과 텍스트가 섞이면 "두께" 는 한쪽에만 있고, 값이 서로 다르면 무엇을
 * 보여 줄지부터 새로 정해야 한다(혼합 값 표시). 색·두께 일괄 편집은 그 설계를
 * 마친 뒤 이 툴바에 덧붙일 수 있다 — 지금은 없는 편이 정직하다.
 *
 * 잠금이 **거는 방향만** 있는 것도 의도다. 다중 선택은 잠기지 않은 것만 모으므로
 * (hitTestUnlockedAt · drawingsInRect 모두 unlockedOnly 위에서 돈다) 이 집합에
 * 잠긴 도형은 원리적으로 없다. 그래서 "해제" 는 집합에 대상이 없고, 잠근 뒤에는
 * 선택을 비운다 — 잠긴 것을 선택에 남겨 두면 헤일로는 있는데 끌리지 않는,
 * 설명 없는 상태가 된다.
 */
function MultiSelectionToolbar({ scope, ids }: { scope: string; ids: readonly string[] }) {
  return (
    <div
      data-drawing-property-panel
      data-testid="drawing-multi-selection-panel"
      className="absolute z-30 inline-flex items-center gap-1.5 bg-bg-card border border-border rounded-lg p-1 pl-2.5 shadow-lg"
      style={{ top: TOP_DOCK_Y, left: '50%', transform: 'translateX(-50%)' }}
    >
      <span data-testid="drawing-multi-count" className="text-xs text-fg-dim tabular-nums">
        {ids.length}개 선택
      </span>
      <div className="w-px h-4 bg-border" />
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

      {/* min-w-max: containing block 인 툴바가 좁아지면 shrink-to-fit 으로 눌려
          grid-cols-4 의 minmax(0,1fr) 열이 붕괴하고 스와치가 겹친다(형제 메뉴들의
          min-w-[7rem] 과 달리 여기는 고정폭 자식 격자라 max-content 가 기준). */}
      {shownPopover === 'color' && (
        <div className="absolute top-full left-0 mt-1 min-w-max bg-bg-card border border-border rounded-md p-2 shadow-xl">
          <div className="grid grid-cols-4 gap-1.5">
            {COLOR_PALETTE.map((hex) => {
              const isSelected = hex === drawing.color;
              return (
                <button
                  key={hex}
                  type="button"
                  data-testid={`drawing-color-swatch-${hex}`}
                  onClick={() => pickColor(hex)}
                  className={
                    'w-6 h-6 rounded border-2 ' +
                    (isSelected ? 'border-white' : 'border-transparent')
                  }
                  style={{ background: hex }}
                  aria-label={hex}
                />
              );
            })}
          </div>
        </div>
      )}

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
        <div className="absolute top-full left-0 mt-1 bg-bg-card border border-border rounded-md p-1 shadow-xl min-w-[7rem]">
          {STROKE_WIDTHS.map((w) => {
            const isSelected = w === drawing.width;
            return (
              <button
                key={w}
                type="button"
                data-testid={`drawing-thickness-item-${w}`}
                onClick={() => pickWidth(w)}
                className={
                  'w-full px-2 py-1 flex items-center gap-2 rounded text-xs ' +
                  (isSelected ? 'bg-bg-input-hover text-accent' : 'text-fg hover:bg-bg-input-hover')
                }
              >
                <span className="inline-block w-6 border-t border-current" style={{ borderTopWidth: w }} />
                <span className="tabular-nums">{w}px</span>
              </button>
            );
          })}
        </div>
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
        <div className="absolute top-full left-0 mt-1 bg-bg-card border border-border rounded-md p-1 shadow-xl min-w-[7rem]">
          {LINE_STYLES.map((style) => {
            const isSelected = style === drawing.lineStyle;
            return (
              <button
                key={style}
                type="button"
                data-testid={`drawing-line-style-item-${style}`}
                onClick={() => pickLineStyle(style)}
                className={
                  'w-full px-2 py-1 flex items-center gap-2 rounded text-xs ' +
                  (isSelected ? 'bg-bg-input-hover text-accent' : 'text-fg hover:bg-bg-input-hover')
                }
              >
                <span
                  className="inline-block w-6 border-t border-current"
                  style={{ borderTopStyle: previewBorderStyle(style), borderTopWidth: 1.5 }}
                />
                {LINE_STYLE_LABELS[style]}
              </button>
            );
          })}
        </div>
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
            <div className="absolute top-full left-0 mt-1 bg-bg-card border border-border rounded-md p-1 shadow-xl min-w-[7rem]">
              {RECT_FILL_OPACITIES.map((op) => {
                const isSelected = op === drawing.fillOpacity;
                return (
                  <button
                    key={op}
                    type="button"
                    data-testid={`drawing-fill-item-${op}`}
                    onClick={() => pickFillOpacity(op)}
                    className={
                      'w-full px-2 py-1 flex items-center gap-2 rounded text-xs ' +
                      (isSelected ? 'bg-bg-input-hover text-accent' : 'text-fg hover:bg-bg-input-hover')
                    }
                  >
                    <span
                      className="inline-block h-4 w-6 rounded-sm border border-fg-dim"
                      style={{ background: drawing.color, opacity: Math.max(0.12, op) }}
                    />
                    <span className="tabular-nums">{Math.round(op * 100)}%</span>
                  </button>
                );
              })}
            </div>
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
            <div className="absolute top-full left-0 mt-1 bg-bg-card border border-border rounded-md p-1 shadow-xl min-w-[7rem]">
              {TEXT_FONT_SIZES.map((size) => {
                const isSelected = size === drawing.fontSize;
                return (
                  <button
                    key={size}
                    type="button"
                    data-testid={`drawing-font-size-item-${size}`}
                    onClick={() => pickFontSize(size)}
                    className={
                      'w-full px-2 py-1 flex items-center gap-2 rounded ' +
                      (isSelected ? 'bg-bg-input-hover text-accent' : 'text-fg hover:bg-bg-input-hover')
                    }
                    style={{ fontSize: Math.min(size, 18) }}
                  >
                    <span className="tabular-nums">{size}px</span>
                  </button>
                );
              })}
            </div>
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
