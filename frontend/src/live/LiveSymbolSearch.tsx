import { useEffect, useState } from 'react';
import { useSymbolSearch } from '../capture/useSymbols';
import { useCombobox } from '../util/useCombobox';
import { useLiveTabsStore } from '../state/liveTabs';
import { onFocusLiveSearch } from './liveSearchFocus';
import { shouldIgnoreEvent } from './useLiveKeyboard';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import type { SymbolHit } from '../api/types';
import { useLiveIndices, type LiveIndexEntry } from '../api/liveIndices';
import { indexInstrument, type LiveIndexId } from './liveInstrument';

type SearchItem =
  | { kind: 'stock'; hit: SymbolHit }
  | { kind: 'index'; index: LiveIndexEntry };

export function LiveSymbolSearch() {
  const setActiveTabCode = useLiveTabsStore((s) => s.setActiveTabCode);
  const setActiveTabInstrument = useLiveTabsStore((s) => s.setActiveTabInstrument);
  const [query, setQuery] = useState('');
  const rawItems = useSymbolSearch(query, 20);
  const indices = useLiveIndices().data ?? [];
  // `filterSymbols('')` returns ALL symbols (not []), so without this gate a
  // focus-then-Enter on an empty input would invisibly select rawItems[0]
  // (the dropdown is hidden when the query is empty). Mirrors capture/SymbolSearch.
  const q = query.trim().toLowerCase();
  const indexItems: SearchItem[] = q.length >= 1
    ? indices
        .filter((idx) => idx.id.toLowerCase().includes(q) || idx.label.toLowerCase().includes(q))
        .map((index) => ({ kind: 'index', index }))
    : [];
  const stockItems: SearchItem[] = query.trim().length >= 1
    ? rawItems.map((hit) => ({ kind: 'stock', hit }))
    : [];
  const items = [...indexItems, ...stockItems];

  const selectItem = (item: SearchItem) => {
    if (item.kind === 'stock') {
      setActiveTabCode(item.hit.code, item.hit.name);
    } else {
      setActiveTabInstrument(indexInstrument(item.index.id as LiveIndexId, item.index.label));
    }
    setQuery('');
  };

  const combo = useCombobox<SearchItem>({
    query,
    setQuery,
    items,
    onSelect: selectItem,
    onEnterEmpty: (q) => {
      const t = q.trim();
      if (/^\d{6}$/.test(t)) { setActiveTabCode(t); setQuery(''); return true; }
      return false;
    },
  });

  // Destructure so render code uses plain identifiers — the react-hooks/refs rule
  // fires on `combo.*` member-access when the result contains refs.
  const {
    open, setOpen, highlightedIndex,
    inputRef, wrapperRef,
    inputProps, getOptionProps, listProps,
  } = combo;

  // Global "/" focuses the input (Discord/Linear pattern). The shared guard
  // skips when focus is already in an input, so "/" types literally there.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || shouldIgnoreEvent(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inputRef]);

  useEffect(() => onFocusLiveSearch(() => inputRef.current?.focus()), [inputRef]);

  const dropdownVisible = open && query.trim().length >= 1;

  return (
    <div ref={wrapperRef} className="relative flex-1 max-w-[360px] font-ui">
      <div
        className={`flex items-center gap-2 h-7 px-2.5 bg-bg-input border rounded-lg ${
          open ? 'border-accent' : 'border-border-strong'
        }`}
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-dimmer w-[14px] h-[14px] shrink-0">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={dropdownVisible}
          aria-controls="live-symbol-search-list"
          type="text"
          placeholder="종목명 또는 코드 검색…"
          className="flex-1 bg-transparent text-fg text-sm outline-none placeholder:text-fg-dimmer"
          {...inputProps}
        />
        <span className="ml-auto flex items-center gap-1 text-fg-dimmer text-xs">
          <kbd className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 border border-border-strong rounded bg-bg-input font-mono">/</kbd>
        </span>
      </div>

      {dropdownVisible && (
        <div
          id="live-symbol-search-list"
          {...listProps}
          style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
          className="absolute z-20 top-full left-0 right-0 mt-1 bg-bg-card border border-border-strong rounded-lg max-h-80 overflow-y-auto"
        >
          {items.length === 0 ? (
            <div className="py-3 px-2.5 text-sm text-fg-dim">검색 결과가 없습니다.</div>
          ) : (
            items.map((item, i) => (
              <div
                key={item.kind === 'stock' ? `stock:${item.hit.code}` : `index:${item.index.id}`}
                role="option"
                {...getOptionProps(i)}
                onClick={() => { selectItem(item); setOpen(false); }}
                style={{ background: i === highlightedIndex ? 'var(--tint-selection)' : 'transparent' }}
                className="grid grid-cols-[1fr_auto_auto_auto] gap-2.5 items-center py-2 px-2.5 cursor-pointer"
              >
                {item.kind === 'stock' ? (
                  <>
                    <span className="text-sm text-fg">{item.hit.name}</span>
                    <span className="text-sm font-mono text-fg-dim tabular-nums">{item.hit.code}</span>
                    <span className="border border-border-strong rounded px-1 text-badge font-semibold tracking-wider text-fg-dim">{item.hit.market}</span>
                    <WatchlistHeartButton code={item.hit.code} name={item.hit.name} />
                  </>
                ) : (
                  <>
                    <span className="text-sm text-fg">{item.index.label}</span>
                    <span className="text-sm font-mono text-fg-dim tabular-nums">{item.index.id}</span>
                    <span className="border border-border-strong rounded px-1 text-badge font-semibold tracking-wider text-fg-dim">지수</span>
                    <span aria-hidden />
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default LiveSymbolSearch;
