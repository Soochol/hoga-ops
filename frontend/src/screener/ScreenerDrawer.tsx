import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { useScreenerUpdateFeedback } from './useScreenerUpdateSync';
import { ScreenerUpdateProgress } from './ScreenerUpdateProgress';
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
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';

/**
 * 저장한 조건검색 선택 드롭다운 — 네이티브 <select> 대신 디자인 시스템 정합 팝오버.
 * TimeframeControl 과 동일 관용구(포털 + useDismissablePopover + 클램프 위치).
 * 옵션은 열렸을 때만 렌더(role=option/listbox), 트리거는 현재 선택명을 보여준다.
 */
function SavedConditionSelect({
  saves,
  selectedId,
  onSelect,
}: {
  saves: readonly { id: string; name: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  useDismissablePopover(open, wrapRef, () => setOpen(false));
  const { ref: posRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );
  const selected = saves.find((s) => s.id === selectedId) ?? saves[0];

  const menu = open && anchorRect ? (
    <div
      ref={posRef}
      role="listbox"
      aria-label="저장한 조건검색"
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', left, top, width: anchorRect.width }}
      className="z-50 max-h-64 overflow-auto rounded-lg border border-border bg-bg-card py-1 shadow-lg"
    >
      {saves.map((s) => (
        <button
          key={s.id}
          type="button"
          role="option"
          aria-selected={s.id === selectedId}
          onClick={() => { onSelect(s.id); setOpen(false); }}
          className={`block w-full truncate px-3 py-1.5 text-left text-sm ${
            s.id === selectedId ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
          }`}
        >
          {s.name}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-label="저장한 조건검색 선택"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setAnchorRect(btnRef.current?.getBoundingClientRect() ?? null);
          setOpen((o) => !o);
        }}
        className="flex w-full items-center justify-between gap-2 rounded-lg border bg-bg-input px-2 py-1.5 text-sm text-fg hover:bg-bg-input-hover"
        style={{ borderColor: open ? 'var(--accent)' : 'var(--border)' }}
      >
        <span className="truncate">{selected?.name ?? '조건 선택'}</span>
        <span aria-hidden className="shrink-0 text-fg-dim">⌄</span>
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

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
  const sortMode = useScreenerPanelStore((s) => s.sortMode);
  const setSortMode = useScreenerPanelStore((s) => s.setSortMode);
  const setUpdatePending = useScreenerPanelStore((s) => s.setUpdatePending);
  const setUpdateSuccess = useScreenerPanelStore((s) => s.setUpdateSuccess);
  const setUpdateError = useScreenerPanelStore((s) => s.setUpdateError);
  const updateFeedback = useScreenerUpdateFeedback((s) => s.feedback);
  const clearExpiredScan = useScreenerPanelStore((s) => s.clearExpiredScan);
  const updateState = useScreenerPanelStore((s) => s.updateState);

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

  useEffect(() => {
    clearExpiredScan();
    const timer = window.setInterval(() => clearExpiredScan(), 60_000);
    return () => window.clearInterval(timer);
  }, [clearExpiredScan]);

  const selected = saves.find((s) => s.id === selectedSavedId) ?? null;
  const notSeeded = status?.status === 'not_seeded' || lastScan?.scanStatus === 'not_seeded';
  const lastScanStaleReason = (() => {
    if (!lastScan) return null;
    if (selectedSavedId !== lastScan.savedId) return '선택한 조건과 다름';
    if (selected && selected.updated_at_ms !== lastScan.savedUpdatedAtMs) return '조건 저장본 변경됨';
    if (lastScan.dataStale) return '데이터 갱신됨';
    return null;
  })();

  const runScan = () => {
    if (!selected) return;
    screener.mutate(
      { conditions: selected.conditions, universe: selected.universe, basis: DRAWER_SCAN_BASIS },
      {
        onSuccess: (res) => {
          setLastScan({
            savedId: selected.id,
            savedName: selected.name,
            savedUpdatedAtMs: selected.updated_at_ms,
            rows: res.rows,
            scanStatus: res.status,
            warnings: res.warnings,
            scannedAtMs: Date.now(),
            basis: DRAWER_SCAN_BASIS,
            dataStale: false,
          });
          setSortMode('default');
        },
      },
    );
  };

  const handleSortChange = (mode: ScreenerResultSortMode) => {
    setSortMode(mode);
  };

  // 서버-소유 job 진행(status.updating)이 진실 — 다른 서피스/스케줄러발 갱신도 잡는다.
  const serverUpdating = status?.updating != null;
  const updatePending = updateState.status === 'pending' || update.isPending || serverUpdating;
  const updateErrorMessage = updateState.status === 'error' ? updateState.message : null;
  const runUpdate = () => {
    const startedAtMs = Date.now();
    setUpdatePending(startedAtMs);
    update.mutate(undefined, {
      onSuccess: (res) => {
        // no-op(skip reason)만 즉시 settle. running 은 pending 유지 —
        // screener_update_finished 이벤트가 sync 훅에서 앱 전역으로 settle 하고,
        // dataStale 도 실제 updated>0 일 때만 이벤트 주도로 마킹된다(무갭 갱신의
        // 거짓 '데이터 갱신됨' 힌트 제거).
        if (!res.running) setUpdateSuccess(Date.now());
      },
      onError: (error) => {
        setUpdateError(error instanceof Error && error.message ? error.message : '갱신 실패', Date.now());
      },
    });
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
          <SavedConditionSelect
            saves={saves}
            selectedId={selectedSavedId}
            onSelect={setSelectedSavedId}
          />
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
            aria-label={updatePending ? '갱신 중…' : '데이터 갱신'}
            onClick={runUpdate}
            disabled={updatePending || notSeeded}
            className="px-2.5 py-1.5"
          >
            {updatePending ? '갱신 중…' : '갱신'}
          </ToolbarButton>
        </div>
        {serverUpdating && (
          <div className="flex items-center">
            <ScreenerUpdateProgress updating={status?.updating} />
          </div>
        )}
        {updateErrorMessage && (
          <RailState tone="error" className="p-0">갱신 실패 — {updateErrorMessage}</RailState>
        )}
        {updateFeedback && (
          <RailState
            tone={updateFeedback.tone === 'info' ? undefined : updateFeedback.tone}
            className="p-0"
          >
            {updateFeedback.message}
          </RailState>
        )}
        {notSeeded && (
          <RailState tone="warn" className="p-0">시드 필요 — 운영자 CLI로 시드 후 조회하세요</RailState>
        )}
        {lastScan && !screener.isError && (
          <div className="flex items-center gap-2 border-t border-border pt-sm text-xs uppercase tracking-[0.08em] text-fg-dimmer">
            <div className="min-w-0 flex-1 truncate">
              결과 {lastScan.rows.length} · {lastScan.savedName}
              {lastScanStaleReason && (
                <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--warn)' }}>
                  · {lastScanStaleReason} — 조회로 갱신
                </span>
              )}
            </div>
            <ScreenerResultSortControl mode={sortMode} onChange={handleSortChange} disabled={lastScan.rows.length === 0} />
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
