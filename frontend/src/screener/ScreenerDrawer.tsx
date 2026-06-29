import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useJumpToLive } from '../live/useJumpToLive';
import { useEntryDragStore, isPointOnChart, dropPoint } from '../state/entryDrag';
import { useLivePageStore } from '../state/livePage';
import { useScreenerPanelStore } from '../state/screenerPanel';
import { useSavedScreeners } from './useSavedScreeners';
import { useScreener } from './useScreener';
import { useScreenerStatus } from './useScreenerStatus';
import { useScreenerUpdate } from './useScreenerUpdate';
import { StalenessChip } from './StalenessChip';
import type { LiveOpenDisposition } from '../live/liveActivation';
import { QuoteRow } from '../rightrail/QuoteRow';
import { useScreenerRowsLive } from './useScreenerRowsLive';
import type { ScreenerRowLive } from './useScreenerRowsLive';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import { ScreenerResultSortControl } from './ScreenerResultSortControl';
import { sortScreenerRows, type ScreenerResultSortMode } from './sortResults';
import type { ScanBasis } from '../api/screener';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailDrawerSection, RailState } from '../ui/RailShell';
import { ToolbarButton } from '../ui/PageShell';

const SCREENER_ENTRY_TYPE = 'screener-entry';
const SCREENER_DRAG_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };
const DRAWER_SCAN_BASIS: ScanBasis = 'intraday';

function screenerDraggableId(code: string): string {
  return `${SCREENER_ENTRY_TYPE}:${code}`;
}

function DraggableScreenerRow({
  row,
  active,
  onActivate,
}: {
  row: ScreenerRowLive;
  active: boolean;
  onActivate: (options?: { disposition?: LiveOpenDisposition }) => void;
}) {
  const { setNodeRef, listeners, attributes, transform, isDragging } = useDraggable({
    id: screenerDraggableId(row.code),
    data: { type: SCREENER_ENTRY_TYPE, code: row.code, name: row.name },
  });
  return (
    <QuoteRow
      name={row.name}
      price={row.price}
      pct={row.change_pct}
      changeWon={row.change_won}
      active={active}
      ariaLabel={`${row.name} ${row.code} 차트 열기`}
      testId={`screener-row-${row.code}`}
      onClick={onActivate}
      trailingAction={<WatchlistHeartButton code={row.code} name={row.name} variant="row" />}
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition: undefined }}
      dragListeners={listeners}
      dragAttributes={attributes}
      dragging={isDragging}
    />
  );
}

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

  const selectedSavedId = useScreenerPanelStore((s) => s.selectedSavedId);
  const setSelectedSavedId = useScreenerPanelStore((s) => s.setSelectedSavedId);
  const lastScan = useScreenerPanelStore((s) => s.lastScan);
  const setLastScan = useScreenerPanelStore((s) => s.setLastScan);
  const [sortMode, setSortMode] = useState<ScreenerResultSortMode>('default');

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
      { conditions: selected.conditions, universe: selected.universe, basis: DRAWER_SCAN_BASIS },
      {
        onSuccess: (res) => {
          setLastScan({
            savedId: selected.id, savedName: selected.name,
            rows: res.rows, scanStatus: res.status, warnings: res.warnings,
          });
          setSortMode('default');
        },
      },
    );
  };

  // 결과 전 종목에 Live Quote 오버레이(ADR-0056 개정 2026-06-03 — 상위 30 cap 제거).
  // 풀페이지 ResultTable 과 공유하는 단일 머지 seam(codes 추출·폴링·머지 캡슐화).
  // scanRows 메모화로 lastScan null 동안 매 렌더 새 [] 가 훅 내부 codes 메모를
  // 무효화하지 않게 한다(풀페이지 Screener.tsx 와 대칭).
  const scanRows = useMemo(() => lastScan?.rows ?? [], [lastScan]);
  const liveRows = useScreenerRowsLive(scanRows);
  const sortedLiveRows = useMemo(() => sortScreenerRows(liveRows, sortMode), [liveRows, sortMode]);
  const sensors = useSensors(useSensor(PointerSensor, SCREENER_DRAG_SENSOR_OPTIONS));
  const startEntryDrag = useEntryDragStore((s) => s.startDrag);
  const setOverChart = useEntryDragStore((s) => s.setOverChart);
  const endEntryDrag = useEntryDragStore((s) => s.endDrag);

  const onDragStart = (ev: DragStartEvent) => {
    if (ev.active.data.current?.type !== SCREENER_ENTRY_TYPE) return;
    const d = ev.active.data.current as { code?: string };
    if (d.code) startEntryDrag(d.code);
  };

  const onDragMove = (ev: DragMoveEvent) => {
    if (ev.active.data.current?.type !== SCREENER_ENTRY_TYPE) return;
    setOverChart(isPointOnChart(dropPoint(ev)));
  };

  const onDragCancel = () => {
    endEntryDrag();
  };

  const onDragEnd = (ev: DragEndEvent) => {
    const wasScreenerEntry = ev.active.data.current?.type === SCREENER_ENTRY_TYPE;
    endEntryDrag();
    if (!wasScreenerEntry || !isPointOnChart(dropPoint(ev))) return;
    const d = ev.active.data.current as { code?: string; name?: string } | undefined;
    if (d?.code) openLive(d.code, d.name);
  };

  return (
    <RailDrawer
      id="right-rail-screener-panel"
      testId="screener-panel"
    >
      {/* Header: label + freshness chip */}
      <RailDrawerHeader title="스크리너" actions={<StalenessChip status={status} />} />

      {/* Controls: dropdown + 조회 + 갱신 */}
      <RailDrawerSection className="flex flex-col gap-sm">
        {saves.length === 0 ? (
          <RailState className="p-0">저장된 조건이 없습니다 — Screener 페이지에서 만드세요</RailState>
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
          <ToolbarButton
            tone="primary"
            onClick={runScan}
            disabled={screener.isPending || notSeeded || !selected}
            className="flex-1 py-1.5"
          >
            {screener.isPending ? '조회 중…' : '조회'}
          </ToolbarButton>
          <ToolbarButton
            aria-label="데이터 갱신"
            onClick={() => update.mutate()}
            disabled={update.isPending || notSeeded}
            className="px-2.5 py-1.5"
          >
            {update.isPending ? '갱신 중…' : '갱신'}
          </ToolbarButton>
        </div>
        {update.isError && (
          <RailState tone="error" className="p-0">갱신 실패 — 잠시 후 다시 시도하세요</RailState>
        )}
        {notSeeded && (
          <RailState tone="warn" className="p-0">시드 필요 — 운영자 CLI로 시드 후 조회하세요</RailState>
        )}
        {lastScan && !screener.isError && (
          <div className="flex items-center gap-2 border-t border-border pt-sm text-xs uppercase tracking-[0.08em] text-fg-dimmer">
            <div className="min-w-0 flex-1 truncate">
              결과 {lastScan.rows.length} · {lastScan.savedName}
              {selectedSavedId !== lastScan.savedId && (
                <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--warn)' }}>
                  · 선택한 조건과 다름 — 조회로 갱신
                </span>
              )}
            </div>
            <ScreenerResultSortControl mode={sortMode} onChange={setSortMode} disabled={lastScan.rows.length === 0} />
          </div>
        )}
      </RailDrawerSection>

      {/* Results */}
      <RailDrawerBody testId="screener-scroll">
        {screener.isError ? (
          <RailState tone="error">
            <div className="font-semibold" style={{ color: 'var(--error)' }}>조회 실패</div>
            {screener.error instanceof Error && screener.error.message && (
              <div className="text-fg-dim">{screener.error.message}</div>
            )}
          </RailState>
        ) : lastScan ? (
          <>
            {(lastScan.warnings ?? []).includes('intraday_fallback_eod') && (
              <div className="mx-md mt-sm rounded-lg border px-3 py-2 text-sm" style={{ color: 'var(--warn)' }}>
                장중 조회 불가 · 전일 확정 데이터로 표시 중
              </div>
            )}
            {lastScan.rows.length === 0 ? (
              <RailState>조건에 맞는 종목이 없습니다.</RailState>
            ) : (
              <DndContext
                sensors={sensors}
                onDragStart={onDragStart}
                onDragMove={onDragMove}
                onDragEnd={onDragEnd}
                onDragCancel={onDragCancel}
              >
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {sortedLiveRows.map((r) => (
                    <DraggableScreenerRow
                      key={r.code}
                      row={r}
                      active={r.code === activeCode}
                      onActivate={(options) => openLive(r.code, r.name, options)}
                    />
                  ))}
                </ul>
              </DndContext>
            )}
          </>
        ) : (
          <RailState>조건을 선택하고 조회하세요.</RailState>
        )}
      </RailDrawerBody>
    </RailDrawer>
  );
}
