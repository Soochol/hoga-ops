import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

const MAX_RENDERED_TABS = 24;

type ChartTabLike = {
  id: string;
  code: string;
  label: string;
};

type NewTabButtonProps = {
  ariaLabel: string;
  disabled?: boolean;
  onClick: () => void;
};

export type ChartTabStatus = 'idle' | 'loading' | 'ready' | 'error';

type Props<T extends ChartTabLike> = {
  tabs: T[];
  activeTabId: string | null;
  activeLoading: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  renderLabel: (tab: T) => string;
  newTabButton?: NewTabButtonProps | null;
  trailingActions?: ReactNode;
  tabCountLabel?: (count: number) => string;
  tablistAriaLabel?: string;
  tabStatus?: (tab: T, active: boolean) => ChartTabStatus;
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
  newTabButton,
  trailingActions,
  tabCountLabel = (count) => `${count} open`,
  tablistAriaLabel = '열린 탭',
  tabStatus,
}: Props<T>) {
  const activeElRef = useRef<HTMLDivElement | null>(null);
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

  return (
    <div className="flex h-full min-w-0 items-end gap-1 px-2 font-ui" style={{ background: 'var(--bg-subtle)' }}>
      <div
        role="tablist"
        aria-label={tablistAriaLabel}
        className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: 'none' }}
      >
        {windowStart > 0 && (
          <div aria-hidden="true" className="h-8 px-1.5 flex items-center shrink-0 text-xs" style={{ color: 'var(--fg-dimmer)' }}>
            …
          </div>
        )}
        {visibleTabs.map((tab, offset) => {
          const idx = windowStart + offset;
          const active = tab.id === activeTabId;
          const displayLabel = renderLabel(tab);
          const status = tabStatus?.(tab, active) ?? (active && activeLoading ? 'loading' : active ? 'ready' : 'idle');
          return (
            <div
              key={tab.id}
              ref={active ? activeElRef : null}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => onFocus(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/tab-index', String(idx));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('text/tab-index')) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const raw = e.dataTransfer.getData('text/tab-index');
                if (raw === '') return;
                const from = Number(raw);
                if (Number.isInteger(from) && from !== idx) onReorder(from, idx);
              }}
              className={`relative flex items-center gap-1.5 h-8 px-2.5 rounded-t-md cursor-pointer select-none group shrink-0 ${
                active ? 'bg-bg-card' : 'bg-bg-input hover:bg-bg-input-hover'
              }`}
              style={{
                borderTop: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 32%, var(--border))' : 'var(--border)'}`,
                borderRight: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 32%, var(--border))' : 'var(--border)'}`,
                borderLeft: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 32%, var(--border))' : 'var(--border)'}`,
                borderBottom: `1px solid ${active ? 'var(--bg-card)' : 'transparent'}`,
                boxShadow: active ? '0 0 0 1px rgba(45, 212, 191, 0.04)' : 'none',
              }}
            >
              {active && (
                <span className="absolute left-0 right-0 top-0 h-[2px]" style={{ background: 'var(--accent)' }} />
              )}
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={statusDotStyle(active, status)} />
              <span className="text-sm shrink-0 max-w-36 truncate" title={displayLabel} style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)' }}>{displayLabel}</span>
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
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-[11px] h-[11px]">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
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
