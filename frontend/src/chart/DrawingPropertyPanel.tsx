// frontend/src/chart/DrawingPropertyPanel.tsx
//
// Drawing Property Panel — the floating DOM affordance that lets the user
// edit the selected Drawing's color, stroke width, and line style, and
// delete it. See CONTEXT.md "Drawing Property Panel" and ADR-0032.

import { useCallback, useState, useEffect, useRef } from 'react';
import { useDrawingsStore } from '../state/drawings';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { COLOR_PALETTE, STROKE_WIDTHS, LINE_STYLES, type LineStyle, type Drawing } from './drawing/types';

export type DrawingAnchor = { x: number; y: number };
export type ComputeAnchorFn = (d: Drawing) => DrawingAnchor | null;

type Props = {
  computeAnchor?: ComputeAnchorFn;
};

const LINE_STYLE_LABELS: Record<LineStyle, string> = {
  solid: '실선',
  dashed: '대시',
  dotted: '도트',
};

const previewBorderStyle = (style: LineStyle): 'solid' | 'dashed' | 'dotted' =>
  style === 'solid' ? 'solid' : style === 'dashed' ? 'dashed' : 'dotted';

type OpenPopover = 'color' | 'thickness' | 'lineStyle' | null;

const INITIAL_POSITION = { x: 14, y: 20 };

export default function DrawingPropertyPanel({ computeAnchor }: Props = {}) {
  const activeTool = useDrawingsStore((s) => s.activeTool);
  const selectedId = useDrawingsStore((s) => s.selectedId);
  const drawing = useDrawingsStore((s) => {
    if (s.activeCode == null || s.selectedId == null) return null;
    return s.byCode.get(s.activeCode)?.find((d) => d.id === s.selectedId) ?? null;
  });

  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [position, setPosition] = useState<{ x: number; y: number }>(INITIAL_POSITION);
  const dragRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startPanelX: number;
    startPanelY: number;
  } | null>(null);
  // Once the user has dragged the panel, it stops re-anchoring on selection
  // changes and stays where they parked it (session-scoped; see ADR-0062).
  // Set inside onMove (a real drag), not startDrag (a bare grip mousedown).
  const userMovedRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      userMovedRef.current = true;
      setPosition({
        x: d.startPanelX + (e.clientX - d.startMouseX),
        y: d.startPanelY + (e.clientY - d.startMouseY),
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Re-anchor when selection identity changes — but only until the user has
  // dragged the panel. After a manual drag the panel is sticky: it keeps the
  // last position across selections instead of snapping back to each drawing's
  // anchor (ADR-0062, reversing ADR-0032's per-selection re-anchor clause).
  useEffect(() => {
    if (drawing == null) return;
    if (userMovedRef.current) return;
    const anchor = computeAnchor?.(drawing) ?? null;
    setPosition(anchor ?? INITIAL_POSITION);
  // Re-anchor only on selection identity change, not on every drawing edit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing?.id]);

  const closePopover = useCallback(() => setOpenPopover(null), []);
  useDismissablePopover(openPopover != null, rootRef, closePopover);

  // Visibility gate — both clauses required.
  if (activeTool !== 'select' || selectedId == null || drawing == null) return null;

  const id = selectedId;

  const pickColor = (color: string) => {
    useDrawingsStore.getState().update(id, { color });
    setOpenPopover(null);
  };

  const pickWidth = (width: number) => {
    useDrawingsStore.getState().update(id, { width });
    setOpenPopover(null);
  };

  const pickLineStyle = (lineStyle: LineStyle) => {
    useDrawingsStore.getState().update(id, { lineStyle });
    setOpenPopover(null);
  };

  const startDrag = (e: React.MouseEvent) => {
    dragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPanelX: position.x,
      startPanelY: position.y,
    };
  };

  return (
    <div
      ref={rootRef}
      data-drawing-property-panel
      data-testid="drawing-property-panel"
      className="absolute z-30 inline-flex items-center gap-0.5 bg-bg-card border border-border rounded-lg p-1 shadow-lg"
      style={{
        top: position.y,
        left: position.x,
        // hline panels are anchored to the chart's horizontal centre and to
        // their own bottom edge: translateX(-50%) lands the visual centre on
        // `position.x` (not the left edge), and translateY(-100%) lifts the
        // panel fully above `position.y` so it rests over the line rather than
        // covering it. trendline / pencil keep top-left anchoring.
        transform: drawing.kind === 'hline' ? 'translate(-50%, -100%)' : undefined,
      }}
    >
      <span
        data-testid="drawing-panel-grip"
        onMouseDown={startDrag}
        className="px-1 h-7 inline-flex items-center text-fg-dim cursor-grab select-none"
      >
        ⋮⋮
      </span>

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

      {openPopover === 'color' && (
        <div className="absolute top-full left-0 mt-1 bg-bg-card border border-border rounded-md p-2 shadow-xl">
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

      {openPopover === 'thickness' && (
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

      {openPopover === 'lineStyle' && (
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

      <div className="w-px h-4 bg-border mx-0.5" />
      <button
        type="button"
        data-testid="drawing-delete"
        aria-label="삭제"
        onClick={() => useDrawingsStore.getState().remove(id)}
        className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-bg-input-hover text-[#F43F5E]"
      >
        🗑
      </button>
    </div>
  );
}
