import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSymbolSearch } from '../capture/useSymbols';
import { useCombobox } from '../util/useCombobox';
import { activateLiveCode, activateLiveInstrument } from './liveNavigate';
import { onFocusLiveSearch } from './liveSearchFocus';
import { shouldIgnoreEvent } from '../util/keyboard';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
import type { SymbolHit } from '../api/types';
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
  localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(recent.slice(0, RECENT_SEARCH_LIMIT)));
}

export function LiveSymbolSearch() {
  const [query, setQuery] = useState('');
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

  // Global "/" opens the centered search surface. The shared guard skips when
  // focus is already in an input, so "/" types literally there.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || shouldIgnoreEvent(e.target)) return;
      e.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => onFocusLiveSearch(() => setOpen(true)), [setOpen]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [inputRef, open]);

  const showingRecent = open && q.length === 0 && recentItems.length > 0;
  const listVisible = query.trim().length >= 1 || showingRecent;
  const searchPopover = open ? (
    <div
      ref={wrapperRef}
      role="dialog"
      aria-label="종목 검색"
      style={{ boxShadow: 'var(--shadow-modal)' }}
      className="fixed left-1/2 top-[12vh] z-50 w-[min(960px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-border-strong bg-bg-card p-4 font-ui"
    >
      <div className="flex items-center gap-2.5 h-11 px-3 rounded-lg bg-bg-input">
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-dimmer w-[18px] h-[18px] shrink-0">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={listVisible}
          aria-controls="live-symbol-search-list"
          type="text"
          placeholder="검색어를 입력해주세요"
          // focus-visible:outline-none 은 global.css 의 전역 포커스 링을 이 input 에서만
          // 끈다(variant 가 붙어야 특이도로 이긴다 — 맨 outline-none 은 나중에 선언된
          // 전역 :focus-visible 과 동점이라 진다). 팔레트는 열리는 순간 여기로 포커스가
          // 가고 캐럿이 위치를 알려 주므로 링이 없어도 키보드 사용자가 길을 잃지 않는다.
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none focus-visible:outline-none placeholder:text-fg-dimmer"
          {...inputProps}
        />
      </div>

      {listVisible && (
        <div
          id="live-symbol-search-list"
          {...listProps}
          className="mt-5 max-h-[50vh] overflow-y-auto"
        >
          {items.length === 0 ? (
            <div className="py-3 px-2.5 text-sm text-fg-dim">검색 결과가 없습니다</div>
          ) : showingRecent ? (
            <>
              <div className="mb-3 px-1 text-sm font-semibold text-fg">
                최근 검색
              </div>
              <div className="flex flex-wrap gap-3">
                {items.map((item, i) => item.kind === 'stock' && (
                  <button
                    key={`recent:${item.hit.code}`}
                    type="button"
                    role="option"
                    {...getOptionProps(i)}
                    onClick={() => { selectItem(item); setOpen(false); }}
                    style={{ background: i === highlightedIndex ? 'var(--tint-selection)' : 'var(--bg-input)' }}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold text-fg"
                  >
                    <span className="truncate">{item.hit.name}</span>
                    <span aria-hidden className="text-fg-dimmer">×</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            items.map((item, i) => (
              <div
                key={item.kind === 'stock' ? `stock:${item.hit.code}` : `index:${item.index.id}`}
                role="option"
                {...getOptionProps(i)}
                onClick={() => { selectItem(item); setOpen(false); }}
                style={{ background: i === highlightedIndex ? 'var(--tint-selection)' : 'transparent' }}
                className="grid grid-cols-[1fr_auto_auto_auto] gap-2.5 items-center rounded-lg py-2 px-2.5 cursor-pointer"
              >
                {item.kind === 'stock' ? (
                  <>
                    <span className="text-sm text-fg">{item.hit.name}</span>
                    <span className="text-sm font-data text-fg-dim tabular-nums">{item.hit.code}</span>
                    <span className="border border-border-strong rounded px-1 text-badge font-semibold text-fg-dim">{item.hit.market}</span>
                    <WatchlistHeartButton code={item.hit.code} name={item.hit.name}
                      isMember={isMember(item.hit.code)} />
                  </>
                ) : (
                  <>
                    <span className="text-sm text-fg">{item.index.label}</span>
                    <span className="text-sm font-data text-fg-dim tabular-nums">{item.index.id}</span>
                    <span className="border border-border-strong rounded px-1 text-badge font-semibold text-fg-dim">지수</span>
                    <span aria-hidden />
                  </>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="relative flex-1 min-w-0 max-w-[360px] font-ui [container-type:inline-size]">
      <button
        type="button"
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
