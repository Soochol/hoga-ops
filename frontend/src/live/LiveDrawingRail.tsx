import type { DrawingTool } from '../chart/drawing/types';
import { DRAWABLE_TOOLS_ORDER, TOOLS } from '../chart/drawing/tools';
import { useDrawingsStore } from '../state/drawings';

const TOOL_ORDER: readonly DrawingTool[] = ['select', ...DRAWABLE_TOOLS_ORDER];

function buttonClass(active: boolean): string {
  return [
    'flex h-8 w-8 items-center justify-center rounded-md border text-sm font-mono transition-colors',
    active
      ? 'border-accent bg-accent text-accent-fg'
      : 'border-transparent bg-transparent text-fg-dim hover:border-border-strong hover:bg-bg-input-hover hover:text-fg',
  ].join(' ');
}

export default function LiveDrawingRail() {
  const activeTool = useDrawingsStore((state) => state.activeTool);
  const setActiveTool = useDrawingsStore((state) => state.setActiveTool);
  const clearAll = useDrawingsStore((state) => state.clearAll);

  return (
    <aside
      aria-label="그리기 도구"
      role="toolbar"
      data-testid="live-drawing-rail"
      className="flex h-full w-[44px] shrink-0 flex-col items-center border-r border-border bg-bg-card/80 py-2"
    >
      <div className="flex flex-col items-center gap-1">
        {TOOL_ORDER.map((tool) => {
          const spec = TOOLS[tool];
          const active = activeTool === tool;
          return (
            <button
              key={tool}
              type="button"
              aria-label={spec.label}
              aria-pressed={active}
              title={spec.label}
              className={buttonClass(active)}
              onClick={() => setActiveTool(tool)}
            >
              <span aria-hidden="true">{spec.glyph}</span>
            </button>
          );
        })}
      </div>
      <div className="my-2 h-px w-8 bg-border" />
      <button
        type="button"
        aria-label="모두 지우기"
        title="모두 지우기"
        className={buttonClass(false)}
        onClick={clearAll}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </aside>
  );
}
