import { useEffect, useMemo } from 'react';
import { useJumpToLive } from '../live/useJumpToLive';
import { useLivePageStore } from '../state/livePage';
import { useScreenerPanelStore } from '../state/screenerPanel';
import { useSavedScreeners } from './useSavedScreeners';
import { useScreener } from './useScreener';
import { useScreenerStatus } from './useScreenerStatus';
import { useScreenerUpdate } from './useScreenerUpdate';
import { StalenessChip } from './StalenessChip';
import { QuoteRow } from '../rightrail/QuoteRow';
import { useScreenerRowsLive } from './useScreenerRowsLive';
import { WatchlistToggleButton } from '../watchlist/WatchlistToggleButton';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';

/**
 * Screener panel (ADR-0052) — app-wide sibling of the Watchlist Panel. Pick a
 * saved condition list, run 조회, click a result to switch the chart symbol via
 * the activeCode single-source-of-truth. Read-only w.r.t. saves (no create/
 * rename/delete — that lives on the /screener page). Results live in the
 * screenerPanel store so they survive close/reopen; cleared on full reload.
 */
export function ScreenerDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const openLive = useJumpToLive();
  const { isMember, toggle } = useWatchlistMembership();

  const selectedSavedId = useScreenerPanelStore((s) => s.selectedSavedId);
  const setSelectedSavedId = useScreenerPanelStore((s) => s.setSelectedSavedId);
  const lastScan = useScreenerPanelStore((s) => s.lastScan);
  const setLastScan = useScreenerPanelStore((s) => s.setLastScan);

  const { data: savesData, isSuccess: savesLoaded } = useSavedScreeners();
  const saves = useMemo(() => savesData?.saves ?? [], [savesData]);
  const { data: status } = useScreenerStatus();
  const screener = useScreener();
  const update = useScreenerUpdate();

  // Restore/repair selection once saves have loaded: keep the persisted id if it
  // still exists, else fall back to the first save, else none. Gate on
  // savesLoaded — before the query resolves, saves is [] and we must NOT clobber
  // a persisted (non-first) selection by writing null.
  useEffect(() => {
    if (!savesLoaded) return;
    if (saves.length === 0) {
      if (selectedSavedId !== null) setSelectedSavedId(null);
      return;
    }
    if (!saves.some((s) => s.id === selectedSavedId)) setSelectedSavedId(saves[0].id);
  }, [savesLoaded, saves, selectedSavedId, setSelectedSavedId]);

  const selected = saves.find((s) => s.id === selectedSavedId) ?? null;
  const notSeeded = status?.status === 'not_seeded' || lastScan?.scanStatus === 'not_seeded';

  const runScan = () => {
    if (!selected) return;
    screener.mutate(
      { conditions: selected.conditions, universe: selected.universe },
      {
        onSuccess: (res) =>
          setLastScan({
            savedId: selected.id, savedName: selected.name,
            rows: res.rows, scanStatus: res.status, warnings: res.warnings,
          }),
      },
    );
  };

  // 결과 전 종목에 Live Quote 오버레이(ADR-0056 개정 2026-06-03 — 상위 30 cap 제거).
  // 풀페이지 ResultTable 과 공유하는 단일 머지 seam(codes 추출·폴링·머지 캡슐화).
  const liveRows = useScreenerRowsLive(lastScan?.rows ?? []);

  return (
    <div
      id="right-rail-screener-panel"
      data-testid="screener-panel"
      style={{
        width: 'var(--watchlist-panel-w)', height: '100%', background: 'var(--bg-card)',
        borderLeft: '1px solid var(--border)', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Header: label + freshness chip */}
      <div
        style={{
          padding: 'var(--space-sm) var(--space-md)', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
        }}
      >
        <span style={{
          fontSize: 'var(--text-xs)', color: 'var(--fg-dim)', fontFamily: 'monospace',
          textTransform: 'uppercase', letterSpacing: '0.08em',
        }}>스크리너</span>
        <span style={{ flex: 1 }} />
        <StalenessChip status={status} />
      </div>

      {/* Controls: dropdown + 조회 + 갱신 */}
      <div className="flex flex-col gap-sm p-md border-b">
        {saves.length === 0 ? (
          <div className="text-fg-dimmer text-sm">저장된 조건이 없습니다 — Screener 페이지에서 만드세요</div>
        ) : (
          <select
            aria-label="저장한 조건검색 선택"
            value={selectedSavedId ?? ''}
            onChange={(e) => setSelectedSavedId(e.target.value)}
            className="w-full px-2 py-1.5 rounded-lg bg-bg-input border text-fg text-sm"
          >
            {saves.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
          </select>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button" onClick={runScan}
            disabled={screener.isPending || notSeeded || !selected}
            className="flex-1 px-3 py-1.5 rounded-lg bg-accent text-accent-fg font-semibold text-sm hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {screener.isPending ? '조회 중…' : '조회'}
          </button>
          <button
            type="button" aria-label="데이터 갱신" onClick={() => update.mutate()}
            disabled={update.isPending || notSeeded}
            className="px-2.5 py-1.5 rounded-lg bg-bg-input border text-fg-dim text-sm hover:bg-bg-input-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {update.isPending ? '갱신 중…' : '갱신'}
          </button>
        </div>
        {update.isError && (
          <div className="text-sm" style={{ color: 'var(--error)' }}>갱신 실패 — 잠시 후 다시 시도하세요</div>
        )}
        {notSeeded && (
          <div className="text-sm" style={{ color: 'var(--warn)' }}>시드 필요 — 운영자 CLI로 시드 후 조회하세요</div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-auto">
        {screener.isError ? (
          <div className="p-md text-sm">
            <div className="font-semibold" style={{ color: 'var(--error)' }}>조회 실패</div>
            {screener.error instanceof Error && screener.error.message && (
              <div className="text-fg-dim">{screener.error.message}</div>
            )}
          </div>
        ) : lastScan ? (
          <>
            <div className="px-md pt-sm pb-1 text-xs uppercase tracking-[0.08em] text-fg-dimmer">
              결과 {lastScan.rows.length} · {lastScan.savedName}
              {selectedSavedId !== lastScan.savedId && (
                <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--warn)' }}>
                  · 선택한 조건과 다름 — 조회로 갱신
                </span>
              )}
            </div>
            {lastScan.rows.length === 0 ? (
              <div className="p-md text-fg-dim text-sm">조건에 맞는 종목이 없습니다.</div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {liveRows.map((r) => {
                  const member = isMember(r.code);
                  return (
                    <QuoteRow
                      key={r.code}
                      name={r.name}
                      price={r.price}
                      pct={r.change_pct}
                      changeWon={r.change_won}
                      active={r.code === activeCode}
                      ariaLabel={`${r.name} ${r.code} 차트 열기`}
                      testId={`screener-row-${r.code}`}
                      onClick={() => openLive(r.code)}
                      trailingAction={<WatchlistToggleButton isMember={member} onToggle={() => toggle(r.code)} variant="row" />}
                    />
                  );
                })}
              </ul>
            )}
          </>
        ) : (
          <div className="p-md text-fg-dimmer text-sm">조건을 선택하고 조회하세요.</div>
        )}
      </div>
    </div>
  );
}

