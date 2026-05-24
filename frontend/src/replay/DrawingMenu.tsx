// frontend/src/replay/DrawingMenu.tsx
import { useEffect, useRef, useState } from 'react';
import { useDrawingsStore } from '../state/drawings';
import type { DrawingTool } from '../chart/drawing/types';

const TOOL_ITEMS: { tool: Exclude<DrawingTool, 'select'>; label: string; glyph: string }[] = [
  { tool: 'hline', label: '수평선', glyph: '━' },
  { tool: 'trendline', label: '추세선', glyph: '╱' },
  { tool: 'pencil', label: '연필', glyph: '✎' },
  { tool: 'eraser', label: '지우개', glyph: '⌫' },
];

const TOOL_GLYPH: Record<DrawingTool, string> = {
  select: '✏',
  hline: '━',
  trendline: '╱',
  pencil: '✎',
  eraser: '⌫',
};

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
        {TOOL_GLYPH[activeTool]}
      </button>
      {open && (
        <div
          role="menu"
          data-drawing-menu
          className="absolute left-0 top-full mt-1 w-44 bg-bg-card border border-border rounded shadow-lg z-30 py-1"
        >
          {TOOL_ITEMS.map((item) => (
            <button
              key={item.tool}
              type="button"
              role="menuitem"
              data-drawing-tool={item.tool}
              onClick={() => pick(item.tool)}
              className={
                (activeTool === item.tool
                  ? 'bg-bg-input-hover text-fg'
                  : 'text-fg-dim hover:text-fg hover:bg-bg-input-hover') +
                ' w-full text-left px-3 py-1.5 text-sm flex items-center gap-2'
              }
            >
              <span className="font-mono w-4 text-center">{item.glyph}</span>
              {item.label}
            </button>
          ))}
          <div className="border-t border-border my-1" />
          <button
            type="button"
            role="menuitem"
            onClick={() => pick('select')}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
          >
            <span className="font-mono w-4 text-center">↶</span>선택
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
