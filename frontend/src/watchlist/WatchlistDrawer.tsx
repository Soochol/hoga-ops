import { useMemo, useState } from 'react';
import { useJumpToLive } from '../live/useJumpToLive';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLivePageStore } from '../state/livePage';
import { useWatchlist, useCatchupAll, useRemoveFromWatchlist } from './useWatchlist';
import { useWatchlistFeedback } from './useWatchlistFeedback';
import { groupByFolder } from './grouping';
import { Countdown } from './Countdown';
import { Banner } from './Banner';
import { WatchlistAddForm } from './WatchlistAddForm';
import { WatchlistEditModal } from './WatchlistEditModal';
import { WatchlistRowMenu } from './WatchlistRowMenu';
import { QuoteRow } from '../rightrail/QuoteRow';
import { symbolLabel, summarizeCaughtUpAll, formatCaughtUpAllHeader } from './banners';

/**
 * Watchlist Panel (CONTEXT.md), app-wide via the Right Rail (ADR-0052).
 * Folder-grouped read+navigate: rows show the KIS live quote overlay (ADR-0056)
 * and click → activeCode + /live jump. All mutation (add/delete/folder CRUD/
 * move/reorder) lives in the WatchlistEditModal opened from the 편집 control;
 * the only in-drawer edit affordance is the right-click quick-remove menu.
 */
export function WatchlistDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const onPick = useJumpToLive();
  const { data, isLoading, error } = useWatchlist();
  const catchupAllM = useCatchupAll();
  const removeM = useRemoveFromWatchlist();
  const { recentAction, setRecentAction } = useWatchlistFeedback();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editOpen, setEditOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; code: string; name: string } | null>(null);

  const codes = useMemo(() => data?.entries.map((e) => e.code) ?? [], [data]);
  const quoteByCode = useQuoteByCode(codes);

  const toggle = (key: string) =>
    setCollapsed((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const openMenu = (e: React.MouseEvent, code: string, name: string) => {
    e.preventDefault();                                   // 네이티브 우클릭 메뉴 억제
    setMenu({ x: e.clientX, y: e.clientY, code, name });  // raw 좌표 — 클램프는 메뉴가 실측
  };

  const groups = data ? groupByFolder(data.folders, data.entries) : [];

  return (
    <div id="right-rail-watchlist-panel" data-testid="watchlist-panel"
      style={{ width: 'var(--watchlist-panel-w)', height: '100%', background: 'var(--bg-card)',
               borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
      {/* 헤더: 관심종목 라벨 + 편집 + 공용 WatchlistAddForm 빠른 추가 (spec:111 / grill:166) */}
      <div style={{ borderBottom: '1px solid var(--border)' }}>
        <div style={{ padding: 'var(--space-sm) var(--space-md)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-dim)', fontFamily: 'monospace',
                         textTransform: 'uppercase', letterSpacing: '0.08em' }}>관심종목</span>
          <button type="button" aria-label="관심종목 편집 열기" onClick={() => setEditOpen(true)}
                  className="text-fg-dim hover:text-accent text-xs">편집</button>
        </div>
        <div style={{ padding: '0 var(--space-md) var(--space-sm)' }}>
          <WatchlistAddForm onAdded={(hit) => setRecentAction({ kind: 'added', code: hit.code, name: hit.name })} />
        </div>
        {recentAction?.kind === 'added' && (
          <div className="mx-3 mb-2"><Banner kind="success">{`✓ ${symbolLabel(recentAction)} 추가됨`}</Banner></div>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {isLoading && <div className="p-3 text-fg-dimmer text-sm">불러오는 중</div>}
        {error && <div className="p-3 text-error text-sm">관심종목을 불러올 수 없습니다</div>}
        {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (data?.folders.length ?? 0) === 0 && (
          <div className="p-3 text-fg-dimmer text-sm">관심종목이 없습니다</div>
        )}
        {groups.map((g) => {
          const key = g.folder?.id ?? '__uncat__';
          const label = g.folder?.name ?? '미분류';
          if (g.entries.length === 0 && g.folder === null) return null; // 빈 미분류는 숨김
          const isCollapsed = collapsed.has(key);
          return (
            <div key={key}>
              <button type="button" onClick={() => toggle(key)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-fg-dim hover:bg-bg-input-hover">
                <span>{isCollapsed ? '▸' : '▾'} {label}</span>
                <span className="font-mono tabular-nums text-fg-dimmer">{g.entries.length}</span>
              </button>
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
                        onContextMenu={(e) => openMenu(e, entry.code, entry.name)}
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
          onRemove={() => removeM.mutate(menu.code)} onClose={() => setMenu(null)} />
      )}
      {editOpen && <WatchlistEditModal onClose={() => setEditOpen(false)} />}
    </div>
  );
}
