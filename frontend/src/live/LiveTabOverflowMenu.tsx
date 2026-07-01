import { useCallback, useMemo, useRef, useState } from 'react';
import type { LiveTab } from '../state/liveTabs';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { formatLiveViewLabel } from './liveViewLabel';

const MAX_RENDERED_RESULTS = 200;

interface Props {
  tabs: LiveTab[];
  activeTabId: string | null;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
}

export function LiveTabOverflowMenu({ tabs, activeTabId, onFocus, onClose }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  const dismiss = useCallback(() => setOpen(false), []);
  useDismissablePopover(open, rootRef, dismiss);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tabs;
    return tabs.filter((t) => {
      const displayLabel = formatLiveViewLabel(t.label, t.timeframe).toLowerCase();
      return displayLabel.includes(q) || t.label.toLowerCase().includes(q) || t.code.toLowerCase().includes(q);
    });
  }, [query, tabs]);
  const visible = filtered.slice(0, MAX_RENDERED_RESULTS);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="열린 탭 목록"
        aria-haspopup="dialog"
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
          role="dialog"
          aria-label="열린 탭"
          className="absolute right-0 top-8 z-50 w-72 rounded-md p-2 shadow-lg"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="탭 검색"
            data-prevent-shortcuts
            className="w-full h-8 px-2 rounded text-sm focus-visible:outline focus-visible:outline-2"
            style={{ background: 'var(--bg-input)', color: 'var(--fg)', border: '1px solid var(--border)' }}
          />
          <div className="mt-2 max-h-80 overflow-y-auto">
            {visible.map((t) => {
              const active = t.id === activeTabId;
              const displayLabel = formatLiveViewLabel(t.label, t.timeframe);
              const pinned = t.pinned === true;
              return (
                <div
                  key={t.id}
                  className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
                  style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)', background: active ? 'var(--bg-input)' : 'transparent' }}
                >
                  <button
                    type="button"
                    aria-label={active ? `활성 탭: ${displayLabel}` : undefined}
                    onClick={() => {
                      onFocus(t.id);
                      setOpen(false);
                    }}
                    className="min-w-0 flex flex-1 items-center gap-2 text-left"
                    style={{ color: 'inherit' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: active ? 'var(--success)' : 'transparent', border: active ? 'none' : '1px solid var(--fg-dimmer)' }} />
                    <span className="min-w-0 flex-1 truncate" title={displayLabel}>{displayLabel}</span>
                    {t.code && t.code !== t.label && (
                      <span className="font-mono text-xs shrink-0" style={{ color: 'var(--fg-dimmer)' }}>{t.code}</span>
                    )}
                  </button>
                  {pinned ? (
                    <span
                      aria-label={`고정된 탭: ${displayLabel}`}
                      title="고정됨"
                      className="w-7 h-7 flex items-center justify-center rounded shrink-0"
                      style={{ color: 'var(--accent)' }}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" className="w-[12px] h-[12px]" aria-hidden="true">
                        <path d="M14 3l7 7-3 1-4 4v5l-2 2-3-6-6-3 2-2h5l4-4 1-3z" />
                      </svg>
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`탭 닫기: ${displayLabel}`}
                      title="탭 닫기"
                      onClick={() => onClose(t.id)}
                      className="w-7 h-7 flex items-center justify-center rounded shrink-0"
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
            {filtered.length > visible.length && (
              <div className="px-2 py-2 text-xs" style={{ color: 'var(--fg-dimmer)' }}>
                {filtered.length}개 중 {visible.length}개 표시
              </div>
            )}
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-sm" style={{ color: 'var(--fg-dimmer)' }}>일치하는 탭 없음</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
