import { useEffect, useMemo, useState } from 'react';
import { useSymbolSearch } from '../capture/useSymbols';
import { useSymbolCombobox } from '../symbols/useSymbolCombobox';
import { useLivePageStore } from '../state/livePage';
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from '../watchlist/useWatchlist';
import { shouldIgnoreEvent } from './useLiveKeyboard';
import { HeartIcon } from '../ui/HeartIcon';
import type { SymbolHit } from '../api/types';

export function LiveSymbolSearch() {
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const [query, setQuery] = useState('');
  const rawItems = useSymbolSearch(query, 20);
  // `filterSymbols('')` returns ALL symbols (not []), so without this gate a
  // focus-then-Enter on an empty input would invisibly select rawItems[0]
  // (the dropdown is hidden when the query is empty). Mirrors capture/SymbolSearch.
  const items = query.trim().length >= 1 ? rawItems : [];

  const { data: watchlist } = useWatchlist();
  const memberCodes = useMemo(
    () => new Set(watchlist?.entries.map((e) => e.code) ?? []),
    [watchlist],
  );
  const addM = useAddToWatchlist();
  const removeM = useRemoveFromWatchlist();

  const selectHit = (hit: SymbolHit) => { setActiveCode(hit.code); setQuery(''); };

  const combo = useSymbolCombobox<SymbolHit>({
    query,
    setQuery,
    items,
    onSelect: selectHit,
    onEnterEmpty: (q) => {
      const t = q.trim();
      if (/^\d{6}$/.test(t)) { setActiveCode(t); setQuery(''); return true; }
      return false;
    },
  });

  // Global "/" focuses the input (Discord/Linear pattern). The shared guard
  // skips when focus is already in an input, so "/" types literally there.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || shouldIgnoreEvent(e.target)) return;
      e.preventDefault();
      combo.inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo.inputRef]);

  const toggleMember = (hit: SymbolHit) => {
    if (memberCodes.has(hit.code)) removeM.mutate(hit.code);
    else addM.mutate(hit.code);
  };

  const dropdownVisible = combo.open && query.trim().length >= 1;

  return (
    <div className="relative flex-1 max-w-[360px] font-ui">
      <div
        className={`flex items-center gap-2 h-7 px-2.5 bg-bg-input border rounded-lg ${
          combo.open ? 'border-accent' : 'border-border-strong'
        }`}
      >
        <span aria-hidden className="text-fg-dimmer text-sm">🔍</span>
        <input
          // eslint-disable-next-line react-hooks/refs -- false positive: assigning a RefObject to ref= is not a .current read
          ref={combo.inputRef}
          role="combobox"
          aria-expanded={dropdownVisible}
          aria-controls="live-symbol-search-list"
          type="text"
          placeholder="종목명 또는 코드 검색…"
          className="flex-1 bg-transparent text-fg text-sm outline-none placeholder:text-fg-dimmer"
          // eslint-disable-next-line react-hooks/refs -- false positive: inputProps holds no ref, only value/onChange/onFocus/onKeyDown
          {...combo.inputProps}
        />
        <span className="ml-auto flex items-center gap-1 text-fg-dimmer text-xs">
          <kbd className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 border border-border-strong rounded bg-bg-input font-mono">/</kbd>
        </span>
      </div>

      {dropdownVisible && (
        <div
          id="live-symbol-search-list"
          // eslint-disable-next-line react-hooks/refs -- false positive: listProps is only { role: 'listbox' }, no ref
          {...combo.listProps}
          style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
          className="absolute z-20 top-full left-0 right-0 mt-1 bg-bg-card border border-border-strong rounded-lg max-h-80 overflow-y-auto"
        >
          {items.length === 0 ? (
            <div className="py-3 px-2.5 text-sm text-fg-dim">검색 결과가 없습니다.</div>
          ) : (
            // eslint-disable-next-line react-hooks/refs -- false positive: map callback closes over getOptionProps (props only), no render-time .current read
            items.map((hit, i) => {
              const member = memberCodes.has(hit.code);
              return (
                <div
                  key={hit.code}
                  role="option"
                  {...combo.getOptionProps(i)}
                  onClick={() => { selectHit(hit); combo.setOpen(false); }}
                  style={{ background: i === combo.highlightedIndex ? 'var(--tint-selection)' : 'transparent' }}
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-2.5 items-center py-2 px-2.5 cursor-pointer"
                >
                  <span className="text-sm text-fg">{hit.name}</span>
                  <span className="text-sm font-mono text-fg-dim tabular-nums">{hit.code}</span>
                  <span className="border border-border-strong rounded px-1 text-badge font-semibold tracking-wider text-fg-dim">{hit.market}</span>
                  <button
                    type="button"
                    aria-label={member ? '관심종목 해제' : '관심종목 추가'}
                    aria-pressed={member}
                    className={`leading-none ${member ? 'text-fg' : 'text-fg-dimmer hover:text-fg'}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => { e.stopPropagation(); toggleMember(hit); }}
                  >
                    <HeartIcon filled={member} className="w-[1em] h-[1em]" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export default LiveSymbolSearch;
