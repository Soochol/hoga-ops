// frontend/src/replay/DrawingMenu.tsx
//
// Drawing Tool picker. Reads from the central `TOOLS` registry in
// `chart/drawing/tools.ts` — adding a new tool there automatically
// adds it to the menu (label + glyph are owned by the spec).

import { useEffect, useRef, useState } from 'react';
import { useDrawingsStore } from '../state/drawings';
import type { DrawingTool } from '../chart/drawing/types';
import { TOOLS, DRAWABLE_TOOLS_ORDER } from '../chart/drawing/tools';

export default function DrawingMenu() {
  const [open, setOpen] = useState(false);
  const activeTool = useDrawingsStore((s) => s.activeTool);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (tool: DrawingTool) => {
    useDrawingsStore.getState().setActiveTool(tool);
    setOpen(false);
  };

  // Toolbar button glyph — the active tool's icon (or a default pencil
  // when in select mode, signalling the button OPENS the drawing menu).
  const buttonGlyph = activeTool === 'select' ? '✏' : TOOLS[activeTool].glyph;

  return (
    <div ref={popoverRef} className="relative">
      <button
        type="button"
        aria-label="그리기"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          (activeTool === 'select'
            ? 'bg-bg-card text-fg-dim hover:text-fg'
            : 'bg-accent text-accent-fg') +
          ' px-3 py-1.5 text-sm border border-border rounded'
        }
        data-drawing-menu-button
      >
        {buttonGlyph}
      </button>
      {open && (
        <div
          role="menu"
          data-drawing-menu
          className="absolute left-0 top-full mt-1 w-44 bg-bg-card border border-border rounded shadow-lg z-30 py-1"
        >
          {DRAWABLE_TOOLS_ORDER.map((kind) => {
            const spec = TOOLS[kind];
            return (
              <button
                key={kind}
                type="button"
                role="menuitem"
                data-drawing-tool={kind}
                onClick={() => pick(kind)}
                className={
                  (activeTool === kind
                    ? 'bg-bg-input-hover text-fg'
                    : 'text-fg-dim hover:text-fg hover:bg-bg-input-hover') +
                  ' w-full text-left px-3 py-1.5 text-sm flex items-center gap-2'
                }
              >
                <span className="font-mono w-4 text-center">{spec.glyph}</span>
                {spec.label}
              </button>
            );
          })}
          <div className="border-t border-border my-1" />
          <button
            type="button"
            role="menuitem"
            onClick={() => pick('select')}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
          >
            <span className="font-mono w-4 text-center">{TOOLS.select.glyph}</span>
            {TOOLS.select.label}
          </button>
          <button
            type="button"
            role="menuitem"
            data-drawing-clear-all
            onClick={() => {
              useDrawingsStore.getState().clearAll();
              setOpen(false);
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
          >
            <span className="font-mono w-4 text-center">✕</span>모두 지우기
          </button>
        </div>
      )}
    </div>
  );
}
