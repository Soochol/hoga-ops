import { useEffect, useMemo, useRef, useState } from 'react';
import { useJumpToLive } from '../live/useJumpToLive';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLivePageStore } from '../state/livePage';
import {
  useWatchlist, useCatchupAll, useRemoveFromWatchlist,
  useCreateFolder, useRenameFolder, useDeleteFolder, useReorderFolders, useMoveEntries,
} from './useWatchlist';
import { persistJson, readJsonObject } from '../state/persist';
import { useWatchlistFeedback } from './useWatchlistFeedback';
import { groupByFolder, swapFolderOrder } from './grouping';
import { Countdown } from './Countdown';
import { Banner } from './Banner';
import { WatchlistEditModal } from './WatchlistEditModal';
import { GroupNameModal } from './GroupNameModal';
import { WatchlistRowMenu } from './WatchlistRowMenu';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { TrashIcon } from '../ui/TrashIcon';
import { QuoteRow } from '../rightrail/QuoteRow';
import { summarizeCaughtUpAll, formatCaughtUpAllHeader } from './banners';

/** 우측 정렬 앵커드 메뉴 셸 — dim 라벨 헤더 + menuitem children. 패널의 두 메뉴
 *  (헤더 편집 메뉴, 그룹 ⋯ 메뉴)가 공유해 컨테이너/헤더 스타일 드리프트를 막는다. */
function AnchoredMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="menu" aria-label={label}
      className="absolute right-0 z-30 mt-1 bg-bg-card border border-border rounded shadow-lg py-1 min-w-[150px]">
      <div className="px-3 py-1 text-xs text-fg-dimmer">{label}</div>
      {children}
    </div>
  );
}

/** 접기 chevron — 펼침=▼(클릭하면 접기), 접힘=▶. 폴더 관용구(VS Code·TradingView),
 *  좌측 배치와 세트. 유니코드 대신 SVG(폰트별 렌더 불일치 회피). */
function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  );
}

/**
 * 그룹 헤더 행 — 라벨/chevron 클릭 = 접기 토글, 호버 시 ⋯ 메뉴(이름 변경/삭제;
 * 실폴더만 — 미분류는 onRename/onDelete 미전달 → chevron만). FolderRow(편집 모달)
 * 처럼 button-in-button을 피해 div + 형제 버튼 구조이고, 메뉴 state/dismiss 훅을
 * 루프 밖에서 쓰기 위해 module-scope 컴포넌트로 분리했다(react-hooks 규칙).
 */
function GroupHeader(props: {
  label: string; count: number; collapsed: boolean;
  onToggle: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(menuOpen, menuRef, () => setMenuOpen(false));
  const itemClass =
    'w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    // sticky + bg-bg-card: 패널 배경과 동일색이라 평시엔 투명처럼 보이고, 스크롤
    // 시에만 불투명이 드러나 행을 가린다(스펙 §1). 각 그룹 div가 컨테이닝 블록이라
    // 헤더는 자기 그룹 범위에서만 고정된다. 메뉴가 열리면 z를 올려 다음 sticky
    // 헤더(z-10)가 이 헤더의 메뉴(z-30, 헤더 스태킹 컨텍스트 내부)를 덮지 않게 한다.
    <div className={`group sticky top-0 ${menuOpen ? 'z-20' : 'z-10'} flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-fg-dim bg-bg-card hover:bg-bg-input-hover`}>
      <button type="button" aria-label={`${props.label} ${props.collapsed ? '펼치기' : '접기'}`}
        onClick={props.onToggle} className="px-1 leading-none text-fg-dimmer hover:text-fg">
        <ChevronIcon collapsed={props.collapsed} />
      </button>
      {/* 개수를 라벨 버튼 안에 — 우측 정렬 mono 개수가 가격 컬럼과 같은 x에 떨어져
          종목 행처럼 읽히던 충돌을 해소하고(스펙 §문제 1), 클릭 타깃도 키운다. */}
      <button type="button" onClick={props.onToggle}
        className="flex-1 min-w-0 text-left flex items-baseline gap-1.5">
        <span className="truncate">{props.label}</span>
        {' '/* 접근성 이름 단어 분리 — 없으면 "스윙1"로 합성 */}
        <span className="flex-none text-xs font-normal text-fg-dimmer">{props.count}</span>
      </button>
      {props.onRename && (
        <div className="relative" ref={menuRef}>
          {/* opacity(레이아웃 유지)로 숨겨 Tab 포커스가 닿게 한다 — display:none이면
              키보드 사용자가 접근 불가. group-focus-within으로 헤더 내 포커스 시 노출,
              메뉴가 열려 있는 동안엔 계속 보여 앵커를 유지한다(마우스가 떠나도). */}
          <button type="button" aria-label={`${props.label} 그룹 메뉴`}
            aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className={`${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} px-1 leading-none hover:text-fg`}>
            ⋯
          </button>
          {menuOpen && (
            <AnchoredMenu label={props.label}>
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onRename?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center">✎</span> 그룹 이름 변경
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveUp}
                onClick={() => { setMenuOpen(false); props.onMoveUp?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center">▲</span> 위로 이동
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveDown}
                onClick={() => { setMenuOpen(false); props.onMoveDown?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center">▼</span> 아래로 이동
              </button>
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onDelete?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center"><TrashIcon className="w-[1em] h-[1em]" /></span> 그룹 삭제
              </button>
            </AnchoredMenu>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Watchlist Panel (CONTEXT.md), app-wide via the Right Rail (ADR-0052).
 * Folder-grouped read+navigate: rows show the KIS live quote overlay (ADR-0056)
 * and click → activeCode + /live jump. The 편집 control opens a small menu
 * (관심 편집 → WatchlistEditModal, 새 그룹 만들기 → GroupNameModal); group
 * headers carry a hover ⋯ menu (이름 변경/순서/삭제), and the row context menu
 * does quick-remove + 그룹으로 이동. Entry add/multi-delete/drag-reorder live
 * in the edit modal. Collapse state persists via localStorage.
 */
export function WatchlistDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const onPick = useJumpToLive();
  const { data, isLoading, error } = useWatchlist();
  const catchupAllM = useCatchupAll();
  const removeM = useRemoveFromWatchlist();
  const createM = useCreateFolder();
  const renameM = useRenameFolder();
  const deleteM = useDeleteFolder();
  const reorderFoldersM = useReorderFolders();
  const moveM = useMoveEntries();
  const { recentAction, setRecentAction } = useWatchlistFeedback();
  // 접기 상태는 localStorage 영속 — 패널을 닫았다 열어도(언마운트) 유지된다.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const saved = readJsonObject('watchlist.collapsed');
    const keys = Array.isArray(saved.keys) ? saved.keys.filter((k): k is string => typeof k === 'string') : [];
    return new Set(keys);
  });
  const [editOpen, setEditOpen] = useState(false);
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [editMenu, setEditMenu] = useState(false);
  const editMenuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(editMenu, editMenuRef, () => setEditMenu(false));
  const [menu, setMenu] =
    useState<{ x: number; y: number; code: string; name: string; folderId: string | null } | null>(null);

  const codes = useMemo(() => data?.entries.map((e) => e.code) ?? [], [data]);
  const quoteByCode = useQuoteByCode(codes);

  // 함수형 업데이터 — 같은 배치의 다중 toggle도 최신 Set 위에서 계산된다.
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  // 영속화는 상태 변화에 반응. 기록 시점에 실존 그룹 키만 남겨 삭제된 그룹의
  // 키가 localStorage에 누적되지 않게 한다(메모리의 inert 키는 다음 마운트에서 소멸).
  useEffect(() => {
    const valid = data ? new Set([...data.folders.map((f) => f.id), '__uncat__']) : null;
    persistJson('watchlist.collapsed', { keys: [...collapsed].filter((k) => !valid || valid.has(k)) });
  }, [collapsed, data]);
  const openMenu = (e: React.MouseEvent, code: string, name: string, folderId: string | null) => {
    e.preventDefault();                                   // 네이티브 우클릭 메뉴 억제
    setMenu({ x: e.clientX, y: e.clientY, code, name, folderId });  // raw 좌표 — 클램프는 메뉴가 실측
  };

  const groups = data ? groupByFolder(data.folders, data.entries) : [];
  const folderCount = data?.folders.length ?? 0;

  const moveFolder = (folderId: string, dir: -1 | 1) => {
    const ids = swapFolderOrder(data?.folders ?? [], folderId, dir);
    if (ids) reorderFoldersM.mutate(ids);
  };

  return (
    <div id="right-rail-watchlist-panel" data-testid="watchlist-panel"
      style={{ width: 'var(--watchlist-panel-w)', height: '100%', background: 'var(--bg-card)',
               borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
      {/* 헤더: 관심종목 라벨 + 편집 메뉴 (종목 추가는 편집 모달에서 — 빠른 추가 제거) */}
      <div style={{ borderBottom: '1px solid var(--border)' }}>
        <div style={{ padding: 'var(--space-sm) var(--space-md)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-dim)', fontFamily: 'monospace',
                         textTransform: 'uppercase', letterSpacing: '0.08em' }}>관심종목</span>
          {/* 편집 → 앵커드 메뉴 (이동 메뉴와 같은 relative+absolute+useDismissablePopover 패턴).
              패널이 뷰포트 우측 끝이라 right-0으로 안쪽으로 연다 — 클램프 불필요. */}
          <div className="relative" ref={editMenuRef}>
            <button type="button" aria-label="관심종목 편집 메뉴" aria-haspopup="menu" aria-expanded={editMenu}
                    onClick={() => setEditMenu((v) => !v)}
                    className="text-fg-dim hover:text-accent text-xs">편집</button>
            {editMenu && (
              <AnchoredMenu label="관심">
                <button type="button" role="menuitem"
                        onClick={() => { setEditMenu(false); setEditOpen(true); }}
                        className="block w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover">
                  관심 편집
                </button>
                <button type="button" role="menuitem"
                        onClick={() => { setEditMenu(false); setAddGroupOpen(true); }}
                        className="block w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover">
                  새 그룹 만들기
                </button>
              </AnchoredMenu>
            )}
          </div>
        </div>
      </div>

      <div data-testid="watchlist-scroll" style={{ flex: 1, overflow: 'auto' }}>
        {isLoading && <div className="p-3 text-fg-dimmer text-sm">불러오는 중</div>}
        {error && <div className="p-3 text-error text-sm">관심종목을 불러올 수 없습니다</div>}
        {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (data?.folders.length ?? 0) === 0 && (
          <div className="p-3 text-fg-dimmer text-sm">관심종목이 없습니다</div>
        )}
        {groups.map((g, gi) => {
          const key = g.folder?.id ?? '__uncat__';
          const label = g.folder?.name ?? '미분류';
          if (g.entries.length === 0 && g.folder === null) return null; // 빈 미분류는 숨김
          const isCollapsed = collapsed.has(key);
          const folder = g.folder;
          // groupByFolder는 실폴더를 order 순으로 앞에 두므로 gi == 폴더 인덱스.
          return (
            <div key={key}>
              <GroupHeader label={label} count={g.entries.length} collapsed={isCollapsed}
                onToggle={() => toggle(key)}
                onRename={folder ? () => setRenameTarget({ id: folder.id, name: folder.name }) : undefined}
                onDelete={folder ? () => deleteM.mutate(folder.id) : undefined}
                onMoveUp={folder ? () => moveFolder(folder.id, -1) : undefined}
                onMoveDown={folder ? () => moveFolder(folder.id, +1) : undefined}
                canMoveUp={gi > 0}
                canMoveDown={gi < folderCount - 1} />
              {!isCollapsed && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {g.entries.map((entry) => {
                    const q = quoteByCode.get(entry.code);
                    return (
                      <QuoteRow
                        key={entry.code}
                        name={entry.name}
                        price={q?.price ?? null}
                        pct={q?.change_pct ?? null}
                        changeWon={q?.change_won ?? null}
                        active={entry.code === activeCode}
                        ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
                        testId={`watchlist-row-${entry.code}`}
                        onClick={() => onPick(entry.code)}
                        onContextMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)}
                        onDelete={() => removeM.mutate(entry.code)}
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* 푸터: 전체수집 결과 배너 + 다음 수집 카운트다운 + 전체 수집 */}
      {recentAction?.kind === 'caught_up_all' && (() => {
        const s = summarizeCaughtUpAll(recentAction.summary);
        return (
          <div className="px-3 py-2 border-t border-border">
            <Banner kind={s.failed.length > 0 ? 'error' : 'success'}>
              <div>{formatCaughtUpAllHeader(s)}</div>
              {s.failed.length > 0 && (
                <ul className="mt-1 text-xs">
                  {s.failed.map((r) => (
                    <li key={r.code}>{r.code} {r.name}: {r.error?.code ?? 'failed'}</li>
                  ))}
                </ul>
              )}
            </Banner>
          </div>
        );
      })()}
      <div style={{ borderTop: '1px solid var(--border)', padding: 'var(--space-sm) var(--space-md)' }}
           className="text-xs text-fg-dim flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">다음 수집{' '}
          {data && <span className="text-accent"><Countdown targetMs={data.next_run_at_ms} /></span>}</span>
        <button type="button"
          onClick={() => catchupAllM.mutate(undefined, {
            onSuccess: (r) => setRecentAction({ kind: 'caught_up_all', summary: r.results }),
          })}
          disabled={catchupAllM.isPending || (data?.entries.length ?? 0) === 0}
          className="px-2 py-0.5 rounded border border-border hover:text-accent hover:border-accent disabled:opacity-40">
          {/* spin only the glyph, not the text label (DESIGN.md motion) */}
          <span className={`inline-block ${catchupAllM.isPending ? 'animate-spin' : ''}`}>↻</span> 전체 수집
        </button>
      </div>

      {menu && (
        <WatchlistRowMenu x={menu.x} y={menu.y} name={menu.name}
          folders={[...(data?.folders ?? [])].sort((a, b) => a.order - b.order)}
          currentFolderId={menu.folderId}
          onMove={(folderId) => moveM.mutate({ codes: [menu.code], folderId })}
          onRemove={() => removeM.mutate(menu.code)} onClose={() => setMenu(null)} />
      )}
      {editOpen && <WatchlistEditModal onClose={() => setEditOpen(false)} />}
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
    </div>
  );
}
