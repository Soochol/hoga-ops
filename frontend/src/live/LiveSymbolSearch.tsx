import { useUsStocks } from '../api/usDailyCandles';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSymbols } from '../capture/useSymbols';
import { useCombobox } from '../util/useCombobox';
import { activateLiveCode, activateLiveInstrument } from './liveNavigate';
import { activationTarget, focusedWindowSymbol, useWorkspaceStore } from '../state/workspace';
import { onFocusLiveSearch } from './liveSearchFocus';
import { shouldIgnoreEvent } from '../util/keyboard';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
import { ClearSearchIcon } from '../ui/ClearSearchIcon';
import { useLiveIndices } from '../api/liveIndices';
import { indexInstrument, usStockInstrument, usStockKey, usStockFromKey, type LiveIndexId } from './liveInstrument';
import { buildLiveSearchCatalog, searchItemIdentity, searchLiveCatalog, type SearchItem } from './liveSymbolSearchModel';

type RecentSearch = { code: string; name: string; market: string };

const RECENT_SEARCH_KEY = 'hoga.liveSymbolSearch.recent';
const RECENT_SEARCH_LIMIT = 5;

function readRecentSearches(): RecentSearch[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentSearch => (
        typeof item === 'object' && item !== null
        && typeof (item as RecentSearch).code === 'string'
        && typeof (item as RecentSearch).name === 'string'
        && typeof (item as RecentSearch).market === 'string'
      ))
      .slice(0, RECENT_SEARCH_LIMIT);
  } catch {
    return [];
  }
}

function writeRecentSearches(recent: RecentSearch[]) {
  try {
    localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(recent.slice(0, RECENT_SEARCH_LIMIT)));
  } catch {
    // The in-memory history remains usable when browser storage is unavailable.
  }
}

function MatchedName({ name, query }: { name: string; query: string }) {
  const at = query ? name.toLowerCase().indexOf(query) : -1;
  if (at < 0) return name;
  return <>{name.slice(0, at)}<mark className="bg-transparent font-bold text-inherit">{name.slice(at, at + query.length)}</mark>{name.slice(at + query.length)}</>;
}

export function LiveSymbolSearch() {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const listId = `${searchId}-list`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keyboardScroll = useRef(false);
  const blocked = useWorkspaceStore((state) => activationTarget(state).kind === 'blocked');
  const currentKey = useWorkspaceStore((state) => {
    const current = focusedWindowSymbol(state);
    return current ? `${current.kind ?? 'stock'}:${current.code}` : null;
  });
  // 드롭다운 항목마다가 아니라 **여기서 한 번** — useWatchlistMembership 의 계약
  // ("ONCE per component, not per row")대로. 하트가 직접 부르던 시절엔 항목 수만큼
  // react-query 옵저버가 붙었다.
  const { isMember } = useWatchlistMembership();
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>(() => readRecentSearches());
  const symbolsQuery = useSymbols();
  const indicesQuery = useLiveIndices();
  const usStocksQuery = useUsStocks();
  const { refetch: refetchSymbols, isFetching: symbolsFetching } = symbolsQuery;
  const symbolsStatus = symbolsQuery.data?.status;
  const catalog = useMemo(() => buildLiveSearchCatalog(
    symbolsQuery.data?.symbols ?? [], indicesQuery.data ?? [], usStocksQuery.data?.stocks ?? [],
  ), [symbolsQuery.data?.symbols, indicesQuery.data, usStocksQuery.data?.stocks]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => searchLiveCatalog(catalog, q), [catalog, q]);
  const recentItems: SearchItem[] = q.length === 0
    ? recentSearches.map((hit): SearchItem => {
        const us = usStockFromKey(hit.code, hit.name);
        if (us?.kind === 'us_stock') return { kind: 'us_stock', stock: { exchange: us.exchange, symbol: us.symbol, label: hit.name, english_name: '', is_etf: false } };
        return { kind: 'stock', hit: {
        ...hit, market: hit.market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI',
        captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
      } }; })
    : [];
  const items = q ? matches : recentItems;
  const stockFailed = symbolsQuery.isError || symbolsQuery.data?.status === 'unavailable';
  const stockLoading = !stockFailed && (symbolsQuery.isPending || symbolsQuery.data?.status === 'loading');
  const indexLoading = indicesQuery.isPending;
  const indexFailed = indicesQuery.isError;
  const loading = stockLoading || indexLoading;
  const failedSources = [stockFailed && '종목', indexFailed && '지수'].filter(Boolean).join('·');
  const loadingSources = [stockLoading && '종목', indexLoading && '지수'].filter(Boolean).join('·');
  const catalogNotice = failedSources
    ? `${failedSources} 목록을 불러오지 못했습니다.${items.length ? ' 표시된 목록은 계속 사용할 수 있습니다.' : ''}`
    : loadingSources ? `${loadingSources} 목록을 불러오는 중입니다.` : null;

  const retryCatalog = () => {
    if (stockFailed) void symbolsQuery.refetch();
    if (indexFailed) void indicesQuery.refetch();
  };

  const selectItem = (item: SearchItem) => {
    // Re-read the destination at commit time; pinned windows never change and
    // failed selections must not close the search or enter recent history.
    if (activationTarget(useWorkspaceStore.getState()).kind === 'blocked') return;
    if (item.kind === 'us_stock') {
      activateLiveInstrument(usStockInstrument(item.stock.exchange, item.stock.symbol, item.stock.label));
      const code = usStockKey(item.stock.exchange, item.stock.symbol);
      const nextRecent = [{ code, name: item.stock.label, market: item.stock.exchange }, ...recentSearches.filter(r => r.code !== code)].slice(0, RECENT_SEARCH_LIMIT);
      setRecentSearches(nextRecent); writeRecentSearches(nextRecent);
    } else if (item.kind === 'stock') {
      activateLiveCode(item.hit.code, item.hit.name);
      const nextRecent = [
        { code: item.hit.code, name: item.hit.name, market: item.hit.market },
        ...recentSearches.filter((recent) => recent.code !== item.hit.code),
      ].slice(0, RECENT_SEARCH_LIMIT);
      setRecentSearches(nextRecent);
      writeRecentSearches(nextRecent);
    } else {
      activateLiveInstrument(indexInstrument(item.index.id as LiveIndexId, item.index.label));
    }
    setQuery('');
  };

  const combo = useCombobox<SearchItem>({
    query,
    setQuery,
    items: blocked ? [] : items,
    onSelect: selectItem,
    onEnterEmpty: (q) => {
      const t = q.trim();
      // Keep direct six-digit navigation during a catalog outage, but never
      // navigate an unknown code after a successful catalog lookup.
      if (!blocked && (stockLoading || stockFailed) && /^\d{6}$/.test(t)) {
        activateLiveCode(t); setQuery(''); return true;
      }
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

  // The server can return HTTP 200 with a catalog still loading. Poll only
  // while search is open; the shared query cache deduplicates the request.
  useEffect(() => {
    if (!open || symbolsStatus !== 'loading' || symbolsFetching || stockFailed) return;
    const timer = window.setTimeout(() => { void refetchSymbols(); }, 1000);
    return () => window.clearTimeout(timer);
  }, [open, symbolsStatus, symbolsFetching, refetchSymbols, stockFailed]);

  const removeRecent = (code: string) => {
    const nextRecent = recentSearches.filter((recent) => recent.code !== code);
    setRecentSearches(nextRecent);
    writeRecentSearches(nextRecent);
    inputRef.current?.focus();
  };

  // Global "/" opens the centered search surface. The shared guard skips when
  // focus is already in an input, so "/" types literally there.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || shouldIgnoreEvent(e.target)) return;
      e.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => onFocusLiveSearch(() => setOpen(true)), [setOpen]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : triggerRef.current;
    const surface = wrapperRef.current;
    inputRef.current?.focus();
    return () => {
      // Outside clicks may already have focused another control. Leave it alone.
      if (document.activeElement === document.body || surface?.contains(document.activeElement)) {
        previous?.focus({ preventScroll: true });
      }
    };
  }, [inputRef, wrapperRef, open]);

  useEffect(() => {
    if (open && keyboardScroll.current) {
      document.getElementById(`${listId}-${highlightedIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    }
    keyboardScroll.current = false;
  }, [open, listId, highlightedIndex]);

  const showingRecent = open && q.length === 0 && recentItems.length > 0;
  const listVisible = query.trim().length >= 1 || showingRecent;
  const selectedItem = highlightedIndex >= 0 ? items[highlightedIndex] : undefined;
  const directCode = !items.length && (stockLoading || stockFailed) && /^\d{6}$/.test(q);
  const actionLabel = blocked ? '창 고정 해제 필요'
    : selectedItem ? `${searchItemIdentity(selectedItem).name} 열기`
    : directCode ? `${q} 코드로 열기` : '선택할 결과 없음';
  const searchPopover = open ? (
    <div
      ref={wrapperRef}
      role="dialog"
      aria-label="종목 검색"
      aria-describedby={`${searchId}-help`}
      style={{ boxShadow: 'var(--shadow-modal)' }}
      className="fixed left-1/2 top-[12vh] z-50 flex max-h-[80dvh] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col rounded-lg border border-border-strong bg-bg-card p-4 font-ui"
      onKeyDown={(e) => {
        // Escape belongs to this surface, not the maximized chart behind it.
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (!e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) setOpen(false);
        }
      }}
    >
      <div className="mb-2 flex shrink-0 items-center justify-between px-3">
        <label htmlFor={`${searchId}-input`} className="text-sm font-semibold text-fg">종목 검색</label>
        <button type="button" aria-label="종목 검색 닫기" onClick={() => setOpen(false)}
          className="flex h-8 items-center justify-center gap-2 rounded px-1 text-fg-dim hover:bg-bg-input hover:text-fg [@media(pointer:coarse)]:min-h-11">
          <kbd className="rounded border border-border-strong px-1 text-sm font-normal">Esc</kbd>
          <ClearSearchIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-3 h-11 px-3 rounded-lg border border-border-strong bg-bg-input focus-within:border-accent focus-within:ring-1 focus-within:ring-accent [@media(pointer:coarse)]:h-14">
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-dim w-[18px] h-[18px] shrink-0">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          id={`${searchId}-input`}
          role="combobox"
          aria-expanded={listVisible}
          aria-controls={listVisible ? listId : undefined}
          aria-activedescendant={listVisible && highlightedIndex >= 0 ? `${listId}-${highlightedIndex}` : undefined}
          aria-autocomplete="list"
          type="text"
          placeholder="종목명·코드·초성·지수 검색"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-base font-medium text-fg outline-none focus-visible:outline-none placeholder:font-normal placeholder:text-fg-dim [@media(pointer:coarse)]:text-lg"
          {...inputProps}
          onKeyDown={(e) => {
            keyboardScroll.current = !e.nativeEvent.isComposing && (e.key === 'ArrowDown' || e.key === 'ArrowUp');
            inputProps.onKeyDown(e);
          }}
        />
        {query && <button type="button" aria-label="검색어 지우기"
          onClick={() => { setQuery(''); setOpen(true); inputRef.current?.focus(); }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11">
          <ClearSearchIcon className="h-4 w-4" />
        </button>}
      </div>

      {blocked && <p className="mt-3 shrink-0 px-3 text-sm text-fg-dim" role="status">
        모든 창이 고정되어 있습니다 · 변경할 창의 고정을 해제한 뒤 선택하세요
      </p>}
      {catalogNotice && <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2 px-3 text-sm text-fg-dim" role={failedSources ? 'alert' : 'status'}>
        <span>{catalogNotice}</span>
        {failedSources && <button type="button" onClick={retryCatalog}
          disabled={symbolsQuery.isFetching || indicesQuery.isFetching}
          className="rounded px-2 py-1 text-fg underline underline-offset-2 disabled:opacity-50">다시 시도</button>}
      </div>}
      {listVisible && <div className="mt-4 mb-1 flex shrink-0 items-center justify-between gap-2 px-3 text-sm text-fg-dim" aria-live="polite" aria-atomic="true">
        <span>{showingRecent ? '최근 검색' : '검색 결과'}</span>
        <span className="font-data tabular-nums">{items.length}개{!showingRecent && items.length === 20 ? ' 표시' : ''}</span>
      </div>}
      {listVisible ? (
        <div id={listId} {...listProps} aria-label={showingRecent ? '최근 검색' : '검색 결과'}
          aria-busy={loading && q.length > 0}
          className="mt-2 min-h-0 max-h-[50vh] overflow-y-auto overscroll-contain">
          {items.length === 0 ? (
            !catalogNotice && <div className="px-3 py-8 text-center">
              <p className="text-base font-medium text-fg">일치하는 종목이 없습니다</p>
              <p className="mt-2 text-sm text-fg-dim">종목명·코드·미국 티커·초성을 확인해 주세요.</p>
            </div>
          ) : items.map((item, i) => {
            const { name, code, market } = searchItemIdentity(item);
            const isCurrent = currentKey === `${item.kind}:${item.kind === 'us_stock' ? usStockKey(item.stock.exchange, item.stock.symbol) : code}`;
            return (
              <div key={`${item.kind}:${market}:${code}`} role="presentation"
                style={{ background: i === highlightedIndex ? 'var(--tint-selection)' : 'transparent' }}
                className="flex items-center gap-2 rounded-lg px-3">
                <button type="button" role="option" id={`${listId}-${i}`} tabIndex={-1} disabled={blocked}
                  aria-disabled={blocked || undefined}
                  {...getOptionProps(i)}
                  onClick={() => { selectItem(item); setOpen(false); }}
                  className="min-w-0 flex-1 py-2.5 text-left text-base text-fg disabled:cursor-default">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="min-w-0 truncate" data-tooltip={name}><MatchedName name={name} query={q} /></span>
                    {isCurrent && <span className="shrink-0 text-sm font-normal text-fg-dim">현재</span>}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-sm text-fg-dim">
                    <span className="font-data tabular-nums">{code}</span>
                    <span>{market}</span>
                  </span>
                </button>
                {item.kind !== 'index' && <WatchlistHeartButton code={item.kind === 'us_stock' ? usStockKey(item.stock.exchange, item.stock.symbol) : code} name={name} isMember={isMember(item.kind === 'us_stock' ? usStockKey(item.stock.exchange, item.stock.symbol) : code)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-bg-input-hover focus-visible:outline focus-visible:outline-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" />}
                {showingRecent && item.kind !== 'index' && (
                  <button type="button" aria-label={`${name} 최근 검색 삭제`}
                    onClick={() => removeRecent(item.kind === 'us_stock' ? usStockKey(item.stock.exchange, item.stock.symbol) : code)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-bg-input hover:text-fg [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11">
                    <ClearSearchIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="px-3 py-5 text-sm text-fg-dim">종목명·코드·초성·지수를 입력하세요.</p>
      )}
      <p id={`${searchId}-help`} className="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-3 pt-3 text-sm text-fg-dim">
        <span className="shrink-0"><kbd className="rounded border border-border-strong px-1">↑</kbd> <kbd className="rounded border border-border-strong px-1">↓</kbd> 이동</span>
        <span className="ml-auto min-w-0 text-right text-fg"><kbd className="mr-1 rounded border border-border-strong px-1">Enter</kbd> {actionLabel}</span>
      </p>
    </div>
  ) : null;

  return (
    <div className="relative flex-1 min-w-0 max-w-[360px] font-ui [container-type:inline-size]">
      <button
        type="button"
        ref={triggerRef}
        aria-label="종목 검색 열기"
        onClick={() => setOpen(true)}
        className={`flex items-center gap-2 h-7 w-full px-2.5 bg-bg-input border rounded-lg text-left overflow-hidden ${
          open ? 'border-accent' : 'border-border-strong'
        }`}
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-dimmer w-[14px] h-[14px] shrink-0">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        {/* min-w-0 + truncate: 헤더가 좁아지면(드로어 열림 등) 두 줄 줄바꿈 대신 한 줄 말줄임. */}
        <span className="flex-1 min-w-0 truncate text-sm text-fg-dim">종목명 또는 코드 검색…</span>
        {/* kbd 는 shrink-0 이라 좁은 헤더에서 버튼 밖으로 흘러 Settings 라벨과 겹쳤다 —
            버튼 overflow-hidden 이 탈출을 막고, 반쯤 잘린 칩이 남지 않도록 컨테이너 폭
            9rem 아래에서는 칩 자체를 숨긴다(뷰포트가 아니라 드로어 개폐가 폭을 정하므로
            media query 가 아닌 container query). */}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-fg-dim text-xs [@container(max-width:9rem)]:hidden">
          <kbd className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 border border-border-strong rounded bg-bg-input font-data">/</kbd>
        </span>
      </button>

      {searchPopover && createPortal(searchPopover, document.body)}
    </div>
  );
}

export default LiveSymbolSearch;
