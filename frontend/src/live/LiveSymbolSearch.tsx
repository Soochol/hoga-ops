import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSymbolSearch } from '../capture/useSymbols';
import { useCombobox } from '../util/useCombobox';
import { activateLiveCode, activateLiveInstrument } from './liveNavigate';
import { activationTarget, useWorkspaceStore } from '../state/workspace';
import { onFocusLiveSearch } from './liveSearchFocus';
import { shouldIgnoreEvent } from '../util/keyboard';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
import type { SymbolHit } from '../api/types';
import { ClearSearchIcon } from '../ui/ClearSearchIcon';
import { useLiveIndices, type LiveIndexEntry } from '../api/liveIndices';
import { indexInstrument, type LiveIndexId } from './liveInstrument';

type SearchItem =
  | { kind: 'stock'; hit: SymbolHit; recent?: boolean }
  | { kind: 'index'; index: LiveIndexEntry };

type RecentSearch = Pick<SymbolHit, 'code' | 'name' | 'market'>;

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

function SearchAvailabilityNotice() {
  const blocked = useWorkspaceStore((state) => activationTarget(state).kind === 'blocked');
  if (!blocked) return null;
  return (
    <p className="mt-3 shrink-0 px-3 text-sm text-fg-dim" role="status">
      모든 창이 고정되어 있습니다 · 고정을 해제한 뒤 선택하세요
    </p>
  );
}

export function LiveSymbolSearch() {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const listId = `${searchId}-list`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keyboardScroll = useRef(false);
  // 드롭다운 항목마다가 아니라 **여기서 한 번** — useWatchlistMembership 의 계약
  // ("ONCE per component, not per row")대로. 하트가 직접 부르던 시절엔 항목 수만큼
  // react-query 옵저버가 붙었다.
  const { isMember } = useWatchlistMembership();
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>(() => readRecentSearches());
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
  const recentItems: SearchItem[] = q.length === 0
    ? recentSearches.map((hit) => ({ kind: 'stock', hit: {
        ...hit,
        captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
      }, recent: true }))
    : [];
  const items = recentItems.length > 0 ? recentItems : [...indexItems, ...stockItems];

  const selectItem = (item: SearchItem) => {
    if (item.kind === 'stock') {
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
    items,
    onSelect: selectItem,
    onEnterEmpty: (q) => {
      const t = q.trim();
      // 여기는 **드롭다운이 비었을 때만** 탄다(useCombobox) — 즉 심볼 마스터가 아직
      // 로딩 중인 순간이라 넘길 실명이 없다. name=code 로 들어간 값은 LivePage 의
      // backfillSymbolNames 가 마스터 도착 시점에 고친다.
      if (/^\d{6}$/.test(t)) { activateLiveCode(t); setQuery(''); return true; }
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
          className="flex h-8 w-8 items-center justify-center rounded text-fg-dim hover:bg-bg-input hover:text-fg">
          <ClearSearchIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-2.5 h-11 px-3 rounded-lg bg-bg-input focus-within:ring-1 focus-within:ring-accent">
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-dimmer w-[18px] h-[18px] shrink-0">
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
          placeholder="종목명·코드·지수 검색"
          className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none focus-visible:outline-none placeholder:text-fg-dim"
          {...inputProps}
          onKeyDown={(e) => {
            keyboardScroll.current = !e.nativeEvent.isComposing && (e.key === 'ArrowDown' || e.key === 'ArrowUp');
            inputProps.onKeyDown(e);
          }}
        />
      </div>

      <SearchAvailabilityNotice />
      {showingRecent && <p className="mt-4 mb-1 shrink-0 px-3 text-sm font-semibold text-fg">최근 검색</p>}
      {listVisible ? (
        <div id={listId} {...listProps} aria-label={showingRecent ? '최근 검색' : '검색 결과'}
          className="mt-2 min-h-0 max-h-[50vh] overflow-y-auto overscroll-contain">
          {items.length === 0 ? (
            <div className="py-4 px-3 text-sm text-fg-dim">검색 결과가 없습니다. 종목명 또는 코드를 확인하세요.</div>
          ) : items.map((item, i) => {
            const name = item.kind === 'stock' ? item.hit.name : item.index.label;
            const code = item.kind === 'stock' ? item.hit.code : item.index.id;
            return (
              <div key={`${item.kind}:${code}`} role="presentation"
                style={{ background: i === highlightedIndex ? 'var(--tint-selection)' : 'transparent' }}
                className="flex items-center gap-2 rounded-lg px-3">
                <button type="button" role="option" id={`${listId}-${i}`} tabIndex={-1}
                  {...getOptionProps(i)}
                  onClick={() => { selectItem(item); setOpen(false); }}
                  className="min-w-0 flex-1 py-2.5 text-left text-base text-fg">
                  <span className="block truncate font-medium" title={name}>{name}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-sm text-fg-dim">
                    <span className="font-data tabular-nums">{code}</span>
                    <span>{item.kind === 'stock' ? item.hit.market : '지수'}</span>
                  </span>
                </button>
                {showingRecent && item.kind === 'stock' ? (
                  <button type="button" aria-label={`${name} 최근 검색 삭제`}
                    onClick={() => removeRecent(code)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-bg-input hover:text-fg">
                    <ClearSearchIcon className="h-4 w-4" />
                  </button>
                ) : item.kind === 'stock' ? (
                  <WatchlistHeartButton code={code} name={name} isMember={isMember(code)} />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="px-3 py-5 text-sm text-fg-dim">종목명, 코드 또는 지수를 입력하세요.</p>
      )}
      <p id={`${searchId}-help`} className="mt-3 flex shrink-0 flex-wrap gap-x-4 gap-y-1 px-3 text-xs text-fg-dim">
        <span><kbd>↑↓</kbd> 이동</span><span><kbd>Enter</kbd> 적용</span><span><kbd>Esc</kbd> 닫기</span>
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
