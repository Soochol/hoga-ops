// frontend/src/chart/DrawingPropertyPanel.tsx
//
// Drawing Property Panel — the floating DOM affordance that lets the user
// edit the selected Drawing's color, stroke width, and line style, and
// delete it. See CONTEXT.md "Drawing Property Panel" and ADR-0032.

import { useCallback, useState, useRef } from 'react';
import { useDrawingsStore } from '../state/drawings';
import { useDismissablePopover } from '../util/useDismissablePopover';
import {
  COLOR_PALETTE,
  STROKE_WIDTHS,
  LINE_STYLES,
  RECT_FILL_OPACITIES,
  TEXT_FONT_SIZES,
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

export default function DrawingPropertyPanel({ scope }: Props) {
  const activeTool = useDrawingsStore((s) => s.activeTool);
  const selectedId = useDrawingsStore((s) => (scope ? s.selectedByScope.get(scope) ?? null : null));
  const drawing = useDrawingsStore((s) => {
    if (scope == null) return null;
    const sel = s.selectedByScope.get(scope) ?? null;
    return sel == null ? null : s.byScope.get(scope)?.find((d) => d.id === sel) ?? null;
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
  if (activeTool !== 'select' || selectedId == null || drawing == null || hiddenAll || scope == null) return null;

  const id = selectedId;

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
        onClick={() => setOpenPopover(openPopover === 'color' ? null : 'color')}
        className="h-7 px-2 inline-flex flex-col items-center justify-center rounded gap-0.5 hover:bg-bg-input-hover"
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
      {openPopover === 'color' && (
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
        onClick={() => setOpenPopover(openPopover === 'thickness' ? null : 'thickness')}
        className="h-7 px-2 inline-flex items-center gap-1.5 rounded hover:bg-bg-input-hover text-xs"
      >
        <span className="inline-block w-4 border-t border-fg" style={{ borderTopWidth: drawing.width }} />
        <span className="tabular-nums">{drawing.width}px</span>
      </button>
      )}

      {!isText && openPopover === 'thickness' && (
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
        onClick={() => setOpenPopover(openPopover === 'lineStyle' ? null : 'lineStyle')}
        className="h-7 px-2 inline-flex items-center rounded hover:bg-bg-input-hover"
      >
        <span
          className="inline-block w-4 border-t border-fg"
          style={{ borderTopStyle: previewBorderStyle(drawing.lineStyle), borderTopWidth: 1.5 }}
        />
      </button>
      )}

      {!isText && openPopover === 'lineStyle' && (
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
            onClick={() => setOpenPopover(openPopover === 'fill' ? null : 'fill')}
            className="h-7 px-2 inline-flex items-center gap-1.5 rounded hover:bg-bg-input-hover text-xs"
          >
            <span
              className="inline-block h-4 w-4 rounded-sm border border-fg-dim"
              style={{ background: drawing.color, opacity: Math.max(0.15, drawing.fillOpacity) }}
            />
            <span className="tabular-nums">{Math.round(drawing.fillOpacity * 100)}%</span>
          </button>

          {openPopover === 'fill' && (
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
            onClick={() => setOpenPopover(openPopover === 'fontSize' ? null : 'fontSize')}
            className="h-7 px-2 inline-flex items-center gap-1 rounded hover:bg-bg-input-hover text-xs"
          >
            <span className="font-semibold leading-none">A</span>
            <span className="tabular-nums">{drawing.fontSize}px</span>
          </button>

          {openPopover === 'fontSize' && (
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
      <button
        type="button"
        data-testid="drawing-delete"
        aria-label="삭제"
        onClick={() => useDrawingsStore.getState().remove(scope, id)}
        className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-bg-input-hover text-[#F43F5E]"
      >
        🗑
      </button>
    </div>
  );
}
