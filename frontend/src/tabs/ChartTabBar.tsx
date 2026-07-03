import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { dropIndicatorClass, sortableDraggingStyle, type DropIndicator } from '../ui/sortableDragVisuals';

const MAX_RENDERED_TABS = 24;

type ChartTabLike = {
  id: string;
  code: string;
  label: string;
  pinned?: boolean;
};

type NewTabButtonProps = {
  ariaLabel: string;
  disabled?: boolean;
  onClick: () => void;
};

export type ChartTabStatus = 'idle' | 'loading' | 'ready' | 'error';

export type ChartTabLabelParts = {
  primary: string;
  detail?: string;
  full: string;
};

type Props<T extends ChartTabLike> = {
  tabs: T[];
  activeTabId: string | null;
  activeLoading: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  renderLabel: (tab: T) => string;
  renderLabelParts?: (tab: T) => ChartTabLabelParts;
  newTabButton?: NewTabButtonProps | null;
  trailingActions?: ReactNode;
  tabCountLabel?: (count: number) => string;
  tablistAriaLabel?: string;
  tabStatus?: (tab: T, active: boolean) => ChartTabStatus;
  onTogglePin?: (id: string) => void;
};

/** 상태점: 활성+로딩=accent pulse(◌), 활성+로드=success(●), 비활성=dimmer outline(○). */
function statusDotStyle(active: boolean, status: ChartTabStatus): CSSProperties {
  if (status === 'error') return { background: 'var(--error)', boxShadow: '0 0 4px color-mix(in srgb, var(--error) 50%, transparent)' };
  if (status === 'loading') return { background: 'var(--accent)', animation: 'tab-pulse 1.5s ease-in-out infinite' };
  if (status === 'ready' || active) return { background: 'var(--success)', boxShadow: '0 0 4px color-mix(in srgb, var(--success) 50%, transparent)' };
  return { background: 'transparent', border: '1px solid var(--fg-dimmer)' };
}

export function ChartTabBar<T extends ChartTabLike>({
  tabs,
  activeTabId,
  activeLoading,
  onFocus,
  onClose,
  onReorder,
  renderLabel,
  renderLabelParts,
  newTabButton,
  trailingActions,
  tabCountLabel = (count) => `${count} open`,
  tablistAriaLabel = '열린 탭',
  tabStatus,
  onTogglePin,
}: Props<T>) {
  const activeElRef = useRef<HTMLDivElement | null>(null);
  const [draggingTab, setDraggingTab] = useState<{ id: string; index: number; pinned: boolean } | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const activeIdx = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
  const windowStart = tabs.length <= MAX_RENDERED_TABS
    ? 0
    : Math.min(
        Math.max(0, activeIdx - Math.floor(MAX_RENDERED_TABS / 2)),
        tabs.length - MAX_RENDERED_TABS,
      );
  const visibleTabs = tabs.slice(windowStart, windowStart + MAX_RENDERED_TABS);

  useEffect(() => {
    if (typeof activeElRef.current?.scrollIntoView === 'function') {
      activeElRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeTabId]);

  const clearDragVisuals = () => {
    setDraggingTab(null);
    setDropTargetId(null);
  };

  return (
    <div className="flex h-full min-w-0 items-end gap-1 px-2 font-ui" style={{ background: 'var(--bg-subtle)' }}>
      <div
        role="tablist"
        aria-label={tablistAriaLabel}
        className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: 'none' }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTargetId(null);
        }}
      >
        {windowStart > 0 && (
          <div aria-hidden="true" className="h-8 px-1.5 flex items-center shrink-0 text-xs" style={{ color: 'var(--fg-dimmer)' }}>
            …
          </div>
        )}
        {visibleTabs.map((tab, offset) => {
          const idx = windowStart + offset;
          const active = tab.id === activeTabId;
          const labelParts = renderLabelParts?.(tab);
          const displayLabel = labelParts?.full ?? renderLabel(tab);
          const status = tabStatus?.(tab, active) ?? (active && activeLoading ? 'loading' : active ? 'ready' : 'idle');
          const pinned = tab.pinned === true;
          const isDragging = draggingTab?.id === tab.id;
          const dropIndicator: DropIndicator | undefined =
            draggingTab != null &&
            dropTargetId === tab.id &&
            draggingTab.index !== idx &&
            draggingTab.pinned === pinned
              ? (draggingTab.index < idx ? 'after' : 'before')
              : undefined;
          return (
            <div
              key={tab.id}
              ref={active ? activeElRef : null}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={active}
              aria-label={displayLabel}
              onClick={() => onFocus(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1 && !pinned) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/tab-index', String(idx));
                e.dataTransfer.effectAllowed = 'move';
                setDraggingTab({ id: tab.id, index: idx, pinned });
                setDropTargetId(null);
              }}
              onDragEnd={clearDragVisuals}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('text/tab-index')) return;
                e.preventDefault();
                setDropTargetId(draggingTab?.pinned === pinned ? tab.id : null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                clearDragVisuals();
                const raw = e.dataTransfer.getData('text/tab-index');
                if (raw === '') return;
                const from = Number(raw);
                if (
                  Number.isInteger(from) &&
                  from >= 0 &&
                  from < tabs.length &&
                  from !== idx &&
                  Boolean(tabs[from]?.pinned) === pinned
                ) {
                  onReorder(from, idx);
                }
              }}
              className={`relative flex items-center gap-1.5 h-8 px-2.5 rounded-t-md cursor-pointer select-none group shrink-0 ${
                active ? 'bg-bg-card' : 'bg-bg-input hover:bg-bg-input-hover'
              } ${dropIndicatorClass(dropIndicator, 'horizontal')}`}
              style={{
                borderTop: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 32%, var(--border))' : 'var(--border)'}`,
                borderRight: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 32%, var(--border))' : 'var(--border)'}`,
                borderLeft: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 32%, var(--border))' : 'var(--border)'}`,
                borderBottom: `1px solid ${active ? 'var(--bg-card)' : 'transparent'}`,
                boxShadow: active ? '0 0 0 1px rgba(45, 212, 191, 0.04)' : 'none',
                ...(isDragging ? sortableDraggingStyle(18) : {}),
              }}
              title={displayLabel}
            >
              {active && (
                <span className="absolute left-0 right-0 top-0 h-[2px]" style={{ background: 'var(--accent)' }} />
              )}
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={statusDotStyle(active, status)} />
              {labelParts ? (
                <span className="flex min-w-0 max-w-[190px] items-baseline gap-1.5 text-sm" style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)' }}>
                  <span className="min-w-0 max-w-36 truncate">{labelParts.primary}</span>
                  {labelParts.detail && (
                    <span className="shrink-0 whitespace-nowrap font-mono text-xs" style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)' }}>
                      {labelParts.detail}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-sm shrink-0 max-w-36 truncate" title={displayLabel} style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)' }}>{displayLabel}</span>
              )}
              {onTogglePin && (
                <button
                  type="button"
                  draggable={false}
                  aria-label={pinned ? `${displayLabel} 고정 해제` : `${displayLabel} 고정`}
                  title={pinned ? '고정 해제' : '고정'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(tab.id);
                  }}
                  className="ml-0.5 w-[18px] h-[18px] flex items-center justify-center rounded"
                  style={{ color: pinned ? 'var(--accent)' : 'var(--fg-dimmer)', opacity: pinned ? 1 : 0.68 }}
                >
                  <svg viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" className="w-[12px] h-[12px]" aria-hidden="true">
                    <path d="M14 3l7 7-3 1-4 4v5l-2 2-3-6-6-3 2-2h5l4-4 1-3z" />
                  </svg>
                </button>
              )}
              {!pinned && (
                <button
                  type="button"
                  draggable={false}
                  aria-label={`${tab.code} 닫기`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                  className="ml-1 w-[18px] h-[18px] flex items-center justify-center rounded opacity-0 group-hover:opacity-100"
                  style={{ color: 'var(--fg-dimmer)' }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-[11px] h-[11px]" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
        {windowStart + visibleTabs.length < tabs.length && (
          <div aria-hidden="true" className="h-8 px-1.5 flex items-center shrink-0 text-xs" style={{ color: 'var(--fg-dimmer)' }}>
            …
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 self-center shrink-0">
        {newTabButton && (
          <button
            type="button"
            aria-label={newTabButton.ariaLabel}
            onClick={newTabButton.onClick}
            disabled={newTabButton.disabled}
            className="w-7 h-7 flex items-center justify-center rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ color: 'var(--fg-dim)', border: '1px solid var(--border)' }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="w-[13px] h-[13px]">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
        {trailingActions}
        <span className="text-xs font-mono whitespace-nowrap" style={{ color: 'var(--fg-dimmer)' }}>
          {tabCountLabel(tabs.length)}
        </span>
      </div>
    </div>
  );
}
