// frontend/src/chart/DrawingPropertyPanel.tsx
//
// Drawing Property Panel — the floating DOM affordance that lets the user
// edit the selected Drawing's color, stroke width, and line style, and
// delete it. See CONTEXT.md "Drawing Property Panel" and ADR-0032.

import { useState, useEffect, useRef } from 'react';
import { useDrawingsStore } from '../state/drawings';
import { COLOR_PALETTE } from './drawing/types';

type OpenPopover = 'color' | 'thickness' | 'lineStyle' | null;

export default function DrawingPropertyPanel() {
  const activeTool = useDrawingsStore((s) => s.activeTool);
  const selectedId = useDrawingsStore((s) => s.selectedId);
  const drawing = useDrawingsStore((s) => {
    if (s.activeCode == null || s.selectedId == null) return null;
    return s.byCode.get(s.activeCode)?.find((d) => d.id === s.selectedId) ?? null;
  });

  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openPopover == null) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpenPopover(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenPopover(null);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openPopover]);

  // Visibility gate — both clauses required.
  if (activeTool !== 'select' || selectedId == null || drawing == null) return null;

  const id = selectedId;

  const pickColor = (color: string) => {
    useDrawingsStore.getState().update(id, { color });
    setOpenPopover(null);
  };

  return (
    <div
      ref={rootRef}
      data-drawing-property-panel
      className="absolute z-30 inline-flex items-center gap-0.5 bg-bg-card border border-border rounded-lg p-1 shadow-lg"
      style={{ top: 20, left: 14 }}
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
    </div>
  );
}
