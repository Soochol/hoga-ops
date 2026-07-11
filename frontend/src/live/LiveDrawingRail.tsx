import { useRef } from 'react';
import type { DrawingTool } from '../chart/drawing/types';
import { DRAWABLE_TOOLS_ORDER, TOOLS } from '../chart/drawing/tools';
import { normalizeItems } from '../chart/drawing/persistence';
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

function tooltipFor(tool: DrawingTool): string {
  const spec = TOOLS[tool];
  const shortcut = spec.shortcut ? ` (Alt+${spec.shortcut.key.toUpperCase()})` : '';
  return `${spec.label}${shortcut}`;
}

export default function LiveDrawingRail() {
  const activeTool = useDrawingsStore((state) => state.activeTool);
  const setActiveTool = useDrawingsStore((state) => state.setActiveTool);
  const clearAll = useDrawingsStore((state) => state.clearAll);
  const magnet = useDrawingsStore((state) => state.defaults.magnet);
  const hiddenAll = useDrawingsStore((state) => state.defaults.hiddenAll);
  const setDefaults = useDrawingsStore((state) => state.setDefaults);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const store = useDrawingsStore.getState();
    const code = store.activeCode;
    if (code == null) return;
    const items = store.drawingsFor(code);
    if (items.length === 0) return;
    const payload = JSON.stringify({ v: 1, code, items }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `drawings-${code}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { items?: unknown };
      const items = normalizeItems(parsed.items);
      if (items.length > 0) useDrawingsStore.getState().importDrawings(items);
    } catch {
      // Malformed file — ignore silently (nothing imported).
    }
  };

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
          const title = tooltipFor(tool);
          return (
            <button
              key={tool}
              type="button"
              aria-label={spec.label}
              aria-pressed={active}
              title={title}
              className={buttonClass(active)}
              onClick={() => setActiveTool(tool)}
            >
              <span aria-hidden="true">{spec.glyph}</span>
            </button>
          );
        })}
      </div>
      <div className="my-2 h-px w-8 bg-border" />
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          aria-label="자석"
          aria-pressed={magnet}
          title="자석 — 캔들에 스냅 (Ctrl로 일시 해제)"
          className={buttonClass(magnet)}
          onClick={() => setDefaults({ magnet: !magnet })}
        >
          <span aria-hidden="true">🧲</span>
        </button>
        <button
          type="button"
          aria-label="그림 표시 전환"
          aria-pressed={!hiddenAll}
          title={hiddenAll ? '그림 표시' : '그림 숨김'}
          className={buttonClass(false)}
          onClick={() => setDefaults({ hiddenAll: !hiddenAll })}
        >
          <span aria-hidden="true">{hiddenAll ? '🙈' : '👁'}</span>
        </button>
      </div>
      <div className="my-2 h-px w-8 bg-border" />
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          aria-label="내보내기"
          title="그림 내보내기 (JSON)"
          className={buttonClass(false)}
          onClick={handleExport}
        >
          <span aria-hidden="true">⭳</span>
        </button>
        <button
          type="button"
          aria-label="가져오기"
          title="그림 가져오기 (JSON)"
          className={buttonClass(false)}
          onClick={() => fileInputRef.current?.click()}
        >
          <span aria-hidden="true">⭱</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportFile(file);
            e.target.value = ''; // allow re-importing the same file
          }}
        />
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
