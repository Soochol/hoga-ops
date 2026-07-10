import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useJumpToLive } from '../live/useJumpToLive';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLivePageStore } from '../state/livePage';
import { useLiveVenueStore } from '../state/liveVenue';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { persistJson, readJsonObject } from '../state/persist';
import { groupByFolder, swapFolderOrder } from '../watchlist/grouping';
import { GroupNameModal } from '../watchlist/GroupNameModal';
import { QuoteRow } from '../rightrail/QuoteRow';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailState } from '../ui/RailShell';
import { TrashIcon } from '../ui/TrashIcon';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { HeatmapRowMenu } from './HeatmapRowMenu';
import { useAddToFolder } from './useAddToFolder';
import { QuoteSortIcon } from '../rightrail/QuoteSortIcon';
import { quoteSortModeDescription } from '../rightrail/quoteSortDescription';
import { priceDirClass } from '../ui/priceDir';
import { filterGroups } from './filterGroups';
import { sortEntries, avgPct, orderFolderGroups, makePctOf, toQuoteSortMode, type SortMode } from './heat';
import {
  useHeatmap, useAddToHeatmap, useRemoveFromHeatmap, useMoveHeatmapEntries,
  useCreateHeatmapFolder, useRenameHeatmapFolder, useDeleteHeatmapFolder,
  useReorderHeatmapFolders,
} from './useHeatmap';

const COLLAPSE_STORAGE_KEY = 'heatmapDrawer.collapsed';
const UNCAT_KEY = '__uncat__';

// --- 아이콘 (WatchlistDrawer 의 module-private glyph 들과 동일 계약: SVG 로 통일해
//     폰트별 유니코드 렌더 불일치를 피한다). 히트맵 드로어는 watchlist 를 건드리지 않기
//     위해 공용화 대신 이 사본을 둔다(ADR-0068 정신 — 독립 표면). ---
function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  );
}
function MenuGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const PencilIcon = () => <MenuGlyph><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></MenuGlyph>;
const ArrowUpIcon = () => <MenuGlyph><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></MenuGlyph>;
const ArrowDownIcon = () => <MenuGlyph><path d="M12 5v14" /><path d="M6 13l6 6 6-6" /></MenuGlyph>;
const PlusIcon = () => <MenuGlyph><path d="M12 5v14" /><path d="M5 12h14" /></MenuGlyph>;

/** 우측 정렬 앵커드 메뉴 셸 — WatchlistDrawer.AnchoredMenu 사본(독립 표면). */
function AnchoredMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="menu" aria-label={label}
      className="absolute right-0 z-30 mt-1 bg-bg-card border border-border rounded shadow-lg py-1 min-w-[150px]">
      <div className="px-3 py-1 text-xs text-fg-dimmer">{label}</div>
      {children}
    </div>
  );
}

/**
 * 그룹 헤더 행 — 라벨/chevron 클릭 = 접기 토글, ⋯ 메뉴(이름 변경/순서/삭제; 실폴더만 —
 * 미분류는 onRename 미전달 → ⋯ 없이 chevron+라벨 버튼만). 실폴더 헤더 우측에는 ＋종목
 * (trailing 슬롯). WatchlistDrawer.GroupHeader 의 축약판: 폴더별 정렬 토글·드래그 핸들을
 * 뺐다(드로어 v1은 재정렬을 /heatmap 페이지에 위임, 그룹 순서만 ⋯ 위/아래로 제공).
 */
function GroupHeader(props: {
  label: string; count: number; collapsed: boolean;
  avg?: number | null;
  onToggle: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onAddSymbol?: (code: string) => Promise<void>;
  addPending?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(menuOpen, menuRef, () => setMenuOpen(false));
  const itemClass =
    'w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div className={`group sticky top-0 ${menuOpen ? 'z-20' : 'z-10'} flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-fg-dim bg-bg-card hover:bg-bg-input-hover`}>
      <button type="button" aria-label={`${props.label} ${props.collapsed ? '펼치기' : '접기'}`}
        aria-expanded={!props.collapsed}
        onClick={props.onToggle} className="px-1 leading-none text-fg-dimmer hover:text-fg">
        <ChevronIcon collapsed={props.collapsed} />
      </button>
      <button type="button" onClick={props.onToggle}
        aria-label={`${props.label} ${props.count}`} aria-expanded={!props.collapsed}
        className="flex-1 min-w-0 text-left flex items-baseline gap-1.5">
        <span className="truncate">{props.label}</span>
        <span className="flex-none text-xs font-normal text-fg-dimmer">{props.count}</span>
      </button>
      {/* 그룹 평균 등락률(비가중, 시세 도착 종목만; 전부 결측이면 미표시). 방향색만 —
          배경 틴트는 없다(섹터 스트립과 달리 드로어는 숫자만). 정렬키(avgPct)와 동일값. */}
      {props.avg != null && (
        <span className={`flex-none text-xs font-normal font-mono tabular-nums ${priceDirClass(props.avg)}`}>
          {`${props.avg > 0 ? '+' : ''}${props.avg.toFixed(2)}%`}
        </span>
      )}
      {props.onRename && (
        <div className="relative" ref={menuRef}>
          <button type="button" aria-label={`${props.label} 그룹 메뉴`}
            aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="px-1 leading-none text-fg-dimmer hover:text-fg">
            ⋯
          </button>
          {menuOpen && (
            <AnchoredMenu label={props.label}>
              {/* 종목 추가 — 클릭 시 메뉴를 닫고 검색 팝오버를 연다(팝오버는 메뉴와 별개 레이어라
                  메뉴 언마운트에 딸려 사라지지 않는다). 예전 헤더의 ＋종목 버튼을 이 항목으로 이동. */}
              {props.onAddSymbol && (
                <button type="button" role="menuitem"
                  onClick={() => { setMenuOpen(false); setAddOpen(true); }}
                  className={itemClass}>
                  <span className="w-4 grid place-items-center"><PlusIcon /></span> 종목 추가
                </button>
              )}
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onRename?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center"><PencilIcon /></span> 그룹 이름 변경
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveUp}
                onClick={() => { setMenuOpen(false); props.onMoveUp?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center"><ArrowUpIcon /></span> 위로 이동
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveDown}
                onClick={() => { setMenuOpen(false); props.onMoveDown?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center"><ArrowDownIcon /></span> 아래로 이동
              </button>
              <div role="separator" className="my-1 border-t border-border" />
              {/* 히트맵 그룹 삭제는 비파괴적(백엔드가 멤버를 미분류로 reparent) — confirm 없이
                  라벨로만 결과를 명시한다(watchlist 의 파괴적 삭제 confirm 과의 의미 차이). */}
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onDelete?.(); }}
                className="w-full text-left px-3 py-1.5 text-sm text-error hover:bg-tint-error flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent">
                <span className="w-4 grid place-items-center"><TrashIcon className="w-[1em] h-[1em]" /></span> 그룹 삭제 (종목은 미분류로)
              </button>
            </AnchoredMenu>
          )}
          {addOpen && props.onAddSymbol && (
            <SymbolAddPopover anchorRef={menuRef} onClose={() => setAddOpen(false)}
              onAdd={props.onAddSymbol} pending={!!props.addPending} />
          )}
        </div>
      )}
    </div>
  );
}

/** 행 우측 ⋯ 버튼 — 평시 opacity-0(호버/포커스 시 등장), 클릭이 행(차트 이동)으로
 *  통과하지 않게 stopPropagation. WatchlistDrawer.RowTrailing 의 수집상태 점을 뺀 최소판. */
function RowTrailing({ name, onOpenMenu }: { name: string; onOpenMenu: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      aria-label={`${name} 행 메뉴`}
      aria-haspopup="menu"
      onClick={(e) => { e.stopPropagation(); onOpenMenu(e); }}
      className="grid place-items-center px-1 leading-none text-fg-dimmer hover:text-fg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
    >
      ⋯
    </button>
  );
}

// w-64 = 320px @ 20px root. FolderAddButton 과 동일한 우측정렬 초기추정폭.
const POP_W = 320;

/** 종목 검색 팝오버 (controlled) — 마운트되면 열린 상태. anchorRef 우하단 기준 우측정렬 후
 *  useClampedFixedPosition 으로 뷰포트 보정, createPortal 로 body 에 fixed(드로어 overflow
 *  탈출). 선택+추가 시 onAdd(code) 후 onClose; 바깥 클릭·Escape 로도 onClose. 헤더 "종목 추가"
 *  (미분류)와 그룹 ⋯ 메뉴 "종목 추가"(폴더 지정)가 공유 — 팝오버 UI/닫힘 로직 단일 출처. */
function SymbolAddPopover({ anchorRef, onClose, onAdd, pending }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onAdd: (code: string) => Promise<void>;
  pending: boolean;
}) {
  const [picked, setPicked] = useState<SymbolHit | null>(null);
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.right - POP_W, top: r.bottom + 4 });
  }, [anchorRef]);
  const { ref: popRef, left, top } = useClampedFixedPosition<HTMLDivElement>(anchor.left, anchor.top);
  useLayoutEffect(() => { popRef.current?.querySelector('input')?.focus(); }, [popRef]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || popRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, popRef, onClose]);
  const submit = async () => {
    if (!picked) return;
    try {
      await onAdd(picked.code);
    } catch {
      return; // 실패 시 팝오버 유지(재시도) — fire-and-forget rejection 삼킴.
    }
    onClose();
  };
  return createPortal(
    <div ref={popRef} role="dialog" aria-label="종목 추가"
      style={{ position: 'fixed', left, top, width: POP_W }}
      className="z-30 bg-bg-card border border-border-strong rounded p-2 flex flex-col gap-2 shadow-lg">
      <SymbolSearch value={picked} onChange={setPicked} />
      <div className="flex justify-end gap-2">
        <button type="button" className="text-xs px-2 py-1 text-fg-dim" onClick={onClose}>닫기</button>
        <button type="button" className="text-xs px-2 py-1 rounded bg-accent text-accent-fg disabled:opacity-40"
          disabled={!picked || pending} onClick={submit}>추가</button>
      </div>
    </div>,
    document.body,
  );
}

/** 드로어 헤더 "종목 추가" — SymbolAddPopover → useAddToHeatmap(미분류로 추가). */
function HeaderAddButton() {
  const [open, setOpen] = useState(false);
  const addM = useAddToHeatmap();
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btnRef} type="button" title="종목 추가" data-testid="heatmap-header-add"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-fg-dim hover:text-accent">
        종목 추가
      </button>
      {open && (
        <SymbolAddPopover anchorRef={btnRef} onClose={() => setOpen(false)} pending={addM.isPending}
          onAdd={async (code) => { await addM.mutateAsync(code); }} />
      )}
    </>
  );
}

/** 검색 돋보기 + × 클리어 아이콘 (SVG 통일). */
function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

/** 다음 정렬 상태(관심종목과 동일 순환): 기본(manual) → 내림(desc) → 오름(asc) → 기본. */
function nextSort(mode: SortMode): SortMode {
  return mode === 'manual' ? 'desc' : mode === 'desc' ? 'asc' : 'manual';
}

/** 단일 아이콘 정렬 버튼 — 관심종목 정렬 버튼 계약을 미러: 클릭할 때마다 기본→내림→오름
 *  순환, 아이콘(QuoteSortIcon)은 방향만, title/aria 는 현재 상태+다음 동작을 설명한다.
 *  라벨(종목/그룹) 은 정렬 *키*(등락률)의 축을 알린다. 활성(desc/asc)=accent, 기본=dim. */
function SortCycleButton({ label, mode, onCycle }: {
  label: string; mode: SortMode; onCycle: () => void;
}) {
  const qm = toQuoteSortMode(mode);
  return (
    <button type="button" aria-label={`${label} 정렬`} title={quoteSortModeDescription(qm)}
      onClick={onCycle}
      className={`flex items-center gap-1 px-1 py-0.5 leading-none rounded hover:bg-bg-input-hover ${
        mode === 'manual' ? 'text-fg-dimmer' : 'text-accent'
      }`}>
      <span className="text-[11px]">{label}</span>
      <QuoteSortIcon mode={qm} className="w-[1em] h-[1em]" />
    </button>
  );
}

/**
 * 드로어 툴바 — 목록 필터 검색창 + 행/그룹 등락률 정렬 토글. 정렬은 useHeatmapPrefsStore
 * (localStorage heatmap.sortMode.v1 / groupSort.v1)를 구독·기록하므로 /heatmap 페이지와
 * 단일 진실(양방향 동기화)이다. 검색 query 는 드로어 로컬 상태(패널을 닫으면 리셋 — 필터는
 * 일시적 조회 보조이지 저장 설정이 아니다).
 */
function DrawerToolbar({ query, onQuery }: { query: string; onQuery: (v: string) => void }) {
  const sortMode = useHeatmapPrefsStore((s) => s.sortMode);
  const setSortMode = useHeatmapPrefsStore((s) => s.setSortMode);
  const groupSort = useHeatmapPrefsStore((s) => s.groupSort);
  const setGroupSort = useHeatmapPrefsStore((s) => s.setGroupSort);
  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-md py-sm">
      <div className="relative flex items-center">
        <span className="pointer-events-none absolute left-2 text-fg-dimmer"><SearchIcon /></span>
        <input
          type="text" value={query} onChange={(e) => onQuery(e.target.value)}
          aria-label="종목·그룹 검색" placeholder="종목·그룹 검색"
          data-testid="heatmap-drawer-search"
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); onQuery(''); } }}
          className="w-full rounded bg-bg-input pl-7 pr-7 py-1 text-xs text-fg border border-border placeholder:text-fg-dimmer focus:outline-none focus:border-line-strong"
        />
        {query && (
          <button type="button" aria-label="검색 지우기" onClick={() => onQuery('')}
            className="absolute right-1.5 grid h-4 w-4 place-items-center rounded text-fg-dimmer hover:text-fg">
            ✕
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <SortCycleButton label="종목" mode={sortMode} onCycle={() => setSortMode(nextSort(sortMode))} />
        <SortCycleButton label="그룹" mode={groupSort} onCycle={() => setGroupSort(nextSort(groupSort))} />
      </div>
    </div>
  );
}

/**
 * Heatmap Panel — /live 우측 레일에서 히트맵(/heatmap 페이지)의 그룹-종목을 관심종목
 * 드로어와 같은 문법으로 보고 편집한다. 데이터는 useHeatmap(['heatmap']) 공유 — 드로어의
 * 변경(추가/삭제/그룹 CRUD)은 HEATMAP_KEY invalidate 를 타고 페이지에도 즉시 반영되고,
 * 페이지의 변경도 여기로 반영된다(같은 QueryClient, ADR-0068 독립 스토어).
 *
 * 툴바: 목록 필터 검색창(종목명·코드·그룹명) + 행/그룹 등락률 정렬 토글(heatmapPrefs 공유 →
 * /heatmap 페이지와 양방향). 렌더 파이프라인은
 *   groupByFolder → orderFolderGroups(그룹간) → filterGroups(검색) → sortEntries(그룹내).
 * 종목/그룹 추가·삭제, 그룹 이름변경·순서변경(⋯), 행 클릭 차트 점프, Delete/⋯ 제거·이동.
 * 그룹 순서 변경(⋯ 위/아래)은 수동 정렬 + 비검색 상태에서만 활성(정렬/필터 중엔 화면 순서와
 * folder.order 가 어긋나므로 비활성). 드래그 재정렬은 /heatmap 페이지가 담당한다.
 */
export function HeatmapDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const onPick = useJumpToLive();
  const { data, isLoading, error } = useHeatmap();
  const removeM = useRemoveFromHeatmap();
  const moveM = useMoveHeatmapEntries();
  const createM = useCreateHeatmapFolder();
  const renameM = useRenameHeatmapFolder();
  const deleteM = useDeleteHeatmapFolder();
  const reorderFoldersM = useReorderHeatmapFolders();
  // 그룹 지정 종목 추가(⋯ 메뉴의 "종목 추가"). 훅 1회, folderId 는 호출 시 바인딩.
  const { addToFolder, isPending: addingToFolder } = useAddToFolder();

  // 접기 상태는 localStorage 영속 — 패널을 닫았다 열어도(언마운트) 유지된다.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const saved = readJsonObject(COLLAPSE_STORAGE_KEY);
    const keys = Array.isArray(saved.keys) ? saved.keys.filter((k): k is string => typeof k === 'string') : [];
    return new Set(keys);
  });
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState('');
  const [menu, setMenu] =
    useState<{ x: number; y: number; code: string; name: string; folderId: string | null } | null>(null);

  // 정렬 취향은 페이지와 공유(heatmapPrefs). 행=sortMode, 그룹=groupSort.
  const sortMode = useHeatmapPrefsStore((s) => s.sortMode);
  const groupSort = useHeatmapPrefsStore((s) => s.groupSort);

  // 히트맵 엔트리는 code 유일(단일 folder_id)이지만 방어적으로 dedup.
  const codes = useMemo(() => [...new Set(data?.entries.map((e) => e.code) ?? [])], [data]);
  const venue = useLiveVenueStore((s) => s.venue);
  const quoteByCode = useQuoteByCode(codes, venue);

  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  // 영속화는 상태 변화에 반응. 기록 시점에 실존 그룹 키만 남겨 삭제된 그룹 키가 누적되지
  // 않게 한다(WatchlistDrawer.collapsed 와 동일 패턴).
  useEffect(() => {
    const valid = data ? new Set([...data.folders.map((f) => f.id), UNCAT_KEY]) : null;
    persistJson(COLLAPSE_STORAGE_KEY, { keys: [...collapsed].filter((k) => !valid || valid.has(k)) });
  }, [collapsed, data]);

  const openMenu = (e: React.MouseEvent, code: string, name: string, folderId: string | null) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, code, name, folderId });
  };

  // 렌더 파이프라인: groupByFolder → orderFolderGroups(그룹간 정렬) → filterGroups(검색)
  //   → (렌더 시) sortEntries(그룹내 정렬). pctOf 는 시세 Map 파생이라 change/desc/asc 모드는
  // 매 폴링 라이브 재정렬(페이지와 동일). 드로어는 행 드래그가 없어 재정렬이 안전하다
  // (페이지의 useFrozenWhileDragging 텔레포트 가드 불필요).
  const pctOf = useMemo(() => makePctOf(quoteByCode), [quoteByCode]);
  const visibleGroups = useMemo(() => {
    if (!data) return [];
    const grouped = groupByFolder(data.folders, data.entries);
    const ordered = orderFolderGroups(grouped, groupSort, (g) => avgPct(g.entries, pctOf));
    return filterGroups(ordered, query);
  }, [data, groupSort, pctOf, query]);

  const isSearching = query.trim() !== '';
  // 그룹 순서 조작(⋯ 위/아래)은 수동 정렬 + 비검색일 때만 — 정렬/필터 중엔 화면 순서가
  // folder.order 와 어긋나 조작이 혼란스럽다.
  const canMoveGroups = groupSort === 'manual' && !isSearching;
  const folderCount = data?.folders.length ?? 0;
  const moveFolder = (folderId: string, dir: -1 | 1) => {
    const ids = swapFolderOrder(data?.folders ?? [], folderId, dir);
    if (ids) reorderFoldersM.mutate(ids);
  };

  return (
    <RailDrawer id="right-rail-heatmap-panel" testId="heatmap-panel" ariaLabel="히트맵">
      <RailDrawerHeader
        title="히트맵"
        actions={(
          <div className="flex items-center gap-2">
            <button type="button" aria-label="새 그룹 만들기" title="새 그룹 만들기"
                    onClick={() => setAddGroupOpen(true)}
                    className="grid h-5 w-5 place-items-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg">
              <PlusIcon />
            </button>
            <HeaderAddButton />
          </div>
        )}
      />

      <DrawerToolbar query={query} onQuery={setQuery} />

      <RailDrawerBody testId="heatmap-drawer-scroll" quoteNav>
        {isLoading && <RailState>불러오는 중</RailState>}
        {error && <RailState tone="error">히트맵을 불러올 수 없습니다</RailState>}
        {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (data?.folders.length ?? 0) === 0 && (
          <RailState>히트맵이 비어 있습니다</RailState>
        )}
        {!isLoading && !error && isSearching && visibleGroups.length === 0 && (
          <RailState>검색 결과 없음</RailState>
        )}
        {visibleGroups.map((g, gi) => {
          const key = g.folder?.id ?? UNCAT_KEY;
          const label = g.folder?.name ?? '미분류';
          // 빈 미분류만 숨긴다. 빈 실폴더는 표시 — 새 그룹 직후 ＋종목으로 채울 수 있어야
          // 하기 때문(/heatmap 보드의 visibleFolderGroups 는 빈 폴더 전부 숨김 → 의도적 비대칭).
          if (g.entries.length === 0 && g.folder === null) return null;
          // 검색 중엔 접기 무시 — 매칭된 행이 보여야 한다(collapsed Set 은 안 건드림).
          const isCollapsed = !isSearching && collapsed.has(key);
          const folder = g.folder;
          const rows = sortEntries(g.entries, sortMode, pctOf);
          return (
            <div key={key}>
              <GroupHeader label={label} count={g.entries.length} collapsed={isCollapsed}
                avg={avgPct(g.entries, pctOf)}
                onToggle={() => toggle(key)}
                onRename={folder ? () => setRenameTarget({ id: folder.id, name: folder.name }) : undefined}
                onDelete={folder ? () => deleteM.mutate(folder.id) : undefined}
                onMoveUp={folder ? () => moveFolder(folder.id, -1) : undefined}
                onMoveDown={folder ? () => moveFolder(folder.id, +1) : undefined}
                canMoveUp={canMoveGroups && gi > 0}
                canMoveDown={canMoveGroups && gi < folderCount - 1}
                onAddSymbol={folder ? (code) => addToFolder(code, folder.id) : undefined}
                addPending={addingToFolder} />
              {!isCollapsed && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {rows.map((entry) => {
                    const q = quoteByCode.get(entry.code);
                    return (
                      <QuoteRow
                        key={entry.code}
                        name={entry.name}
                        price={q?.price ?? null}
                        pct={q?.change_pct ?? null}
                        changeWon={q?.change_won ?? null}
                        active={entry.code === activeCode}
                        ariaLabel={[entry.name, entry.code, '차트 열기'].join(' ')}
                        testId={`heatmap-drawer-row-${entry.code}`}
                        onClick={(options) => onPick(entry.code, entry.name, options)}
                        onContextMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)}
                        onDelete={() => removeM.mutate(entry.code)}
                        indented
                        trailingAction={
                          <RowTrailing name={entry.name}
                            onOpenMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)} />
                        }
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </RailDrawerBody>

      {menu && (
        <HeatmapRowMenu x={menu.x} y={menu.y} name={menu.name}
          folders={data?.folders ?? []}
          currentFolderId={menu.folderId}
          onRemove={() => removeM.mutate(menu.code)}
          onMove={(folderId) => moveM.mutate({ codes: [menu.code], folderId })}
          onClose={() => setMenu(null)} />
      )}
      {addGroupOpen && (
        <GroupNameModal title="그룹 추가하기" submitLabel="추가" busy={createM.isPending}
          onSubmit={async (name) => { await createM.mutateAsync(name); }}
          onClose={() => setAddGroupOpen(false)} />
      )}
      {renameTarget && (
        <GroupNameModal title="그룹 이름 변경" submitLabel="변경"
          initialName={renameTarget.name} busy={renameM.isPending}
          onSubmit={async (name) => { await renameM.mutateAsync({ folderId: renameTarget.id, name }); }}
          onClose={() => setRenameTarget(null)} />
      )}
    </RailDrawer>
  );
}
