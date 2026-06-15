import { useMemo, useRef, useState } from 'react';
import type { LiveTab } from '../state/liveTabs';
import { useDismissablePopover } from '../util/useDismissablePopover';

interface Props {
  tabs: LiveTab[];
  activeTabId: string | null;
  onFocus: (id: string) => void;
}

export function LiveTabOverflowMenu({ tabs, activeTabId, onFocus }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useDismissablePopover(open, rootRef, () => setOpen(false));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tabs;
    return tabs.filter((t) =>
      t.label.toLowerCase().includes(q) || t.code.toLowerCase().includes(q)
    );
  }, [query, tabs]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="열린 탭 목록"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-7 h-7 flex items-center justify-center rounded-md"
        style={{ color: 'var(--fg-dim)', border: '1px solid var(--border)' }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-[14px] h-[14px]">
          <line x1="5" y1="7" x2="19" y2="7" />
          <line x1="5" y1="12" x2="19" y2="12" />
          <line x1="5" y1="17" x2="19" y2="17" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-50 w-72 rounded-md p-2 shadow-lg"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="탭 검색"
            data-prevent-shortcuts
            className="w-full h-8 px-2 rounded text-sm outline-none"
            style={{ background: 'var(--bg-input)', color: 'var(--fg)', border: '1px solid var(--border)' }}
          />
          <div className="mt-2 max-h-80 overflow-y-auto">
            {filtered.map((t) => {
              const active = t.id === activeTabId;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  aria-label={active ? `활성 탭: ${t.label}` : undefined}
                  onClick={() => {
                    onFocus(t.id);
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
                  style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)', background: active ? 'var(--bg-input)' : 'transparent' }}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: active ? 'var(--success)' : 'transparent', border: active ? 'none' : '1px solid var(--fg-dimmer)' }} />
                  <span className="min-w-0 flex-1 truncate" title={t.label}>{t.label}</span>
                  {t.code && t.code !== t.label && (
                    <span className="font-mono text-xs shrink-0" style={{ color: 'var(--fg-dimmer)' }}>{t.code}</span>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-sm" style={{ color: 'var(--fg-dimmer)' }}>일치하는 탭 없음</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
