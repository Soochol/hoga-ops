import { AppIcon } from '../ui/AppIcon';
import { DrawingToolIcon } from './DrawingToolIcon';
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TooltipButton } from '../ui/TextTooltip';
import { TOOLS, shortcutLabel } from '../chart/drawing/tools';
import type { DrawingTool } from '../chart/drawing/types';
import { drawingScopeFor, EMPTY_SELECTION, useDrawingsStore } from '../state/drawings';
import type { LiveTimeframe } from '../state/livePage';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { COMPACT_PADDING_INLINE } from './workspace/chartHeaderCompact';
import './DrawingMenu.css';

const EMPTY_DRAWINGS: never[] = [];
const DEFAULT_FAVORITES: DrawingTool[] = ['hray', 'trendline', 'fib'];
const GROUPS: { label: string; tools: DrawingTool[] }[] = [
  { label: '선 · 채널', tools: ['select', 'hline', 'hray', 'vline', 'trendline', 'channel', 'regression'] },
  { label: '피보나치', tools: ['fib', 'fib-extension'] },
  { label: '포지션 · 측정', tools: ['long-position', 'short-position', 'measure'] },
  { label: '일자 기준선', tools: ['day-high', 'day-low', 'day-open', 'day-close'] },
  { label: '도형 · 메모', tools: ['rect', 'path', 'text', 'callout', 'pencil', 'eraser'] },
];

type Props = { code: string | null; timeframe: LiveTimeframe; showLabel?: boolean };

export function DrawingMenu({ code, timeframe, showLabel = true }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'tools' | 'objects'>('tools');
  const [query, setQuery] = useState('');
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const scope = drawingScopeFor(code, timeframe);
  const activeTool = useDrawingsStore(s => s.activeTool);
  const favorites = useDrawingsStore(s => s.defaults.favorites ?? DEFAULT_FAVORITES);
  const keepDrawing = useDrawingsStore(s => s.defaults.keepDrawing === true);
  const drawings = useDrawingsStore(s => scope ? s.byScope.get(scope) ?? EMPTY_DRAWINGS : EMPTY_DRAWINGS);
  const selected = useDrawingsStore(s => scope ? s.selectedByScope.get(scope) ?? EMPTY_SELECTION : EMPTY_SELECTION);
  const { ref: menuRef, left, top } = useClampedFixedPosition<HTMLDivElement>(anchorRect?.left ?? 0, anchorRect ? anchorRect.bottom + 4 : 0);
  const close = useCallback(() => setOpen(false), []);
  const escape = useCallback(() => { setOpen(false); buttonRef.current?.focus(); }, []);
  useDismissablePopover(open, wrapRef, close, menuRef, escape);
  const lockedCount = drawings.filter(d => d.locked).length;
  const allLocked = drawings.length > 0 && lockedCount === drawings.length;
  const activeSpec = TOOLS[activeTool];
  const drawing = activeTool !== 'select';
  const pickTool = (tool: DrawingTool) => {
    const store = useDrawingsStore.getState();
    if (tool !== 'select') store.clearAllSelections();
    store.setActiveTool(tool); setQuery(''); setOpen(false); buttonRef.current?.focus();
  };
  const toolButton = (tool: DrawingTool, favorite = false) => {
    const spec = TOOLS[tool];
    return <button type="button" key={tool} aria-pressed={activeTool === tool}
      aria-label={favorite ? `${spec.label} 즐겨찾기 실행` : spec.label}
      aria-keyshortcuts={spec.shortcut ? `${spec.shortcut.alt ? 'Alt' : 'Shift'}+${spec.shortcut.key.toUpperCase()}` : undefined}
      className={favorite ? 'drawing-favorite' : 'drawing-tool-choice'} onClick={() => pickTool(tool)}>
      <DrawingToolIcon tool={tool} size={16} /><span>{spec.label}</span>
      {!favorite && spec.shortcut && <kbd>{shortcutLabel(spec.shortcut)}</kbd>}
    </button>;
  };
  const filtered = GROUPS.map(group => ({ ...group, tools: group.tools.filter(tool => TOOLS[tool].label.includes(query.trim())) })).filter(g => g.tools.length);
  const menu = open && anchorRect ? <div ref={menuRef} role="dialog" aria-label="그리기 도구"
    data-testid="drawing-menu" className="drawing-quick-menu" style={{ position: 'fixed', left, top }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); escape(); }
    }} onMouseDown={e => e.stopPropagation()}>
    <div className="drawing-menu-heading"><strong>그리기</strong><span>{code ?? '종목 미선택'} · {timeframe}</span>
      <button type="button" aria-label="그리기 메뉴 닫기" onClick={escape}><AppIcon name="close" /></button></div>
    <div className="drawing-menu-tabs">
      <button type="button" aria-pressed={tab === 'tools'} onClick={() => { setTab('tools'); setQuery(''); }}>도구</button>
      <button type="button" aria-pressed={tab === 'objects'} onClick={() => { setTab('objects'); setQuery(''); }}>그리기 목록 {drawings.length}</button>
    </div>
    <label className="drawing-menu-search"><AppIcon name="search" /><input type="search" autoFocus
      aria-label={tab === 'tools' ? '그리기 도구 검색' : '그리기 목록 검색'} value={query}
      placeholder={tab === 'tools' ? '도구 검색' : '이름 · 도구 검색'} onChange={e => setQuery(e.target.value)} /></label>
    <div className="drawing-menu-content">
      {tab === 'tools' ? <>
        {!query && favorites.length > 0 && <div className="drawing-favorites" aria-label="즐겨찾기 도구">{favorites.map(t => toolButton(t, true))}</div>}
        {filtered.map(group => <section key={group.label} aria-label={group.label}>
          <h3>{group.label}</h3>
          {group.tools.map(tool => <div className="drawing-tool-row" key={tool}>
            {toolButton(tool)}
            {tool !== 'select' && <button type="button" className="drawing-star" aria-label={`${TOOLS[tool].label} 즐겨찾기`}
              aria-pressed={favorites.includes(tool)} onClick={() => useDrawingsStore.getState().setDefaults({ favorites: favorites.includes(tool) ? favorites.filter(t => t !== tool) : [...favorites, tool] })}>
              <AppIcon name="star" filled={favorites.includes(tool)} /></button>}
          </div>)}
        </section>)}
        {filtered.length === 0 && <p className="drawing-menu-empty">일치하는 도구가 없습니다.</p>}
      </> : <>
        {drawings.filter(d => `${d.name ?? ''} ${TOOLS[d.kind].label}`.includes(query.trim())).map(d => <div key={d.id} className="drawing-object-row">
          <button type="button" className="drawing-object-name" aria-pressed={selected.includes(d.id)} onClick={() => {
            const store = useDrawingsStore.getState(); store.setActiveTool('select');
            if (scope) store.setSelected(scope, d.id); setOpen(false);
          }}><DrawingToolIcon tool={d.kind} /><span>{d.name || TOOLS[d.kind].label}</span></button>
          <button type="button" disabled={d.locked} aria-label={`${d.name || TOOLS[d.kind].label} ${d.hidden ? '표시' : '숨기기'}`}
            onClick={() => { if (scope) useDrawingsStore.getState().update(scope, d.id, { hidden: !d.hidden }); }}><AppIcon name={d.hidden ? 'eyeOff' : 'eye'} /></button>
          <button type="button" aria-label={`${d.name || TOOLS[d.kind].label} ${d.locked ? '잠금 해제' : '잠금'}`}
            onClick={() => { if (scope) useDrawingsStore.getState().update(scope, d.id, { locked: !d.locked }); }}><AppIcon name={d.locked ? 'lock' : 'unlock'} /></button>
          <button type="button" disabled={d.locked} aria-label={`${d.name || TOOLS[d.kind].label} 삭제`}
            onClick={() => { if (scope) useDrawingsStore.getState().remove(scope, d.id); }}><AppIcon name="trash" /></button>
        </div>)}
        {drawings.length === 0 && <p className="drawing-menu-empty">이 종목·봉 범위에 그리기가 없습니다.</p>}
      </>}
    </div>
    <div className="drawing-menu-footer"><label><input type="checkbox" checked={keepDrawing}
      onChange={e => useDrawingsStore.getState().setDefaults({ keepDrawing: e.target.checked })} />연속 그리기</label><span>Esc로 선택 모드</span></div>
    <div className="drawing-menu-actions">
      <button type="button" data-testid="drawing-menu-lock-all" disabled={!scope || !drawings.length} onClick={() => {
        if (scope) useDrawingsStore.getState().setLockedAll(scope, !allLocked); setOpen(false);
      }}><AppIcon name={allLocked ? 'unlock' : 'lock'} />{allLocked ? '모두 잠금 해제' : '모두 잠금'}{lockedCount > 0 && !allLocked && <span>{lockedCount}/{drawings.length}</span>}</button>
      <button type="button" data-testid="drawing-menu-clear" disabled={!scope} onClick={() => {
        if (scope) useDrawingsStore.getState().requestClearAll(scope); setOpen(false);
      }}><AppIcon name="trash" />모두 지우기 <kbd>⌥C</kbd></button>
    </div>
  </div> : null;
  return <div ref={wrapRef} className="relative shrink-0">
    <TooltipButton ref={buttonRef} type="button" data-testid="drawing-menu-trigger"
      aria-haspopup="dialog" aria-expanded={open} aria-label={drawing ? `그리기: ${activeSpec.label}` : '그리기'}
      title={drawing ? `그리기: ${activeSpec.label} — Esc로 해제` : '그리기'}
      onClick={() => { setAnchorRect(buttonRef.current?.getBoundingClientRect() ?? null); setQuery(''); setOpen(v => !v); }}
      className="inline-flex min-h-6 items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-bg-input-hover hover:text-fg"
      style={{ background: drawing ? 'var(--tint-selection)' : 'transparent', color: drawing ? 'var(--accent)' : 'var(--fg-dim)', paddingInline: showLabel ? undefined : COMPACT_PADDING_INLINE }}>
      <DrawingToolIcon tool={drawing ? activeTool : 'pencil'} />{showLabel && <span className="live-action-label">{drawing ? activeSpec.label : '그리기'}</span>}
    </TooltipButton>{menu && createPortal(menu, document.body)}
  </div>;
}
export default DrawingMenu;
