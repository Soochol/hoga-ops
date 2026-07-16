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
import { useScreenerPanelStore, useExpireScreenerScan, MONITOR_PERIOD_CHOICES_MS } from '../state/screenerPanel';
import { useSavedScreeners } from './useSavedScreeners';
import { useScreener } from './useScreener';
import { useScreenerStatus } from './useScreenerStatus';
import { useScreenerUpdateFeedback } from './useScreenerUpdateSync';
import { ScreenerUpdateProgress } from './ScreenerUpdateProgress';
import { StalenessChip } from './StalenessChip';
import { QuoteRow } from '../rightrail/QuoteRow';
import { useScreenerRowsLive } from './useScreenerRowsLive';
import type { ScreenerRowLive } from './useScreenerRowsLive';
import { useScreenerMonitor, MONITOR_PERIOD_SCOPED_MS, MONITOR_PERIOD_FULL_MS } from './useScreenerMonitor';
import { useNewEntryFlash } from './useNewEntryFlash';
import { WatchlistHeartButton } from '../watchlist/WatchlistHeartButton';
import { ScreenerResultSortControl } from './ScreenerResultSortControl';
import { sortScreenerRows, type ScreenerResultSortMode } from './sortResults';
import type { ScanBasis, ScreenerRow } from '../api/screener';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailDrawerSection, RailState } from '../ui/RailShell';
import { ToolbarButton, SegmentedControl } from '../ui/PageShell';
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

/** 멤버십(코드 집합) 동일 여부. 실시간 모니터링의 동일 결과 skip 판정용 — 같으면
 *  결과 리스트 재렌더·localStorage 재직렬화를 건너뛴다(가격은 라이브 오버레이 몫이라
 *  멤버십만 바뀌지 않으면 리스트를 새로 그릴 이유가 없다). */
function sameCodeSet(a: readonly ScreenerRow[], b: readonly ScreenerRow[]): boolean {
  if (a.length !== b.length) return false;
  const codes = new Set(a.map((r) => r.code));
  return b.every((r) => codes.has(r.code));
}

function screenerDraggableId(code: string): string {
  return `${SCREENER_ENTRY_TYPE}:${code}`;
}

function DraggableScreenerRow({
  row,
  active,
  flash,
  onActivate,
}: {
  row: ScreenerRowLive;
  active: boolean;
  flash: boolean;
  onActivate: () => void;
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
      flash={flash}
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
  const monitoringActive = useScreenerPanelStore((s) => s.monitoringActive);
  const setMonitoringActive = useScreenerPanelStore((s) => s.setMonitoringActive);
  const updateFeedback = useScreenerUpdateFeedback((s) => s.feedback);

  const { data: savesData, isSuccess: savesLoaded } = useSavedScreeners();
  const saves = useMemo(() => savesData?.saves ?? [], [savesData]);
  const { data: status } = useScreenerStatus();
  const screener = useScreener();

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

  useExpireScreenerScan();

  const selected = saves.find((s) => s.id === selectedSavedId) ?? null;
  const notSeeded = status?.status === 'not_seeded' || lastScan?.scanStatus === 'not_seeded';
  const lastScanStaleReason = (() => {
    if (!lastScan) return null;
    // 풀페이지 Screener 에서 임시 조건으로 조회한 결과 — 드로어의 저장본 선택과 신원이
    // 다르므로 재조회를 유도한다(savedId null 이면 신원 비교 자체가 성립 안 함).
    if (lastScan.savedId === null) return '페이지에서 조회한 결과';
    if (selectedSavedId !== lastScan.savedId) return '선택한 조건과 다름';
    if (selected && lastScan.savedUpdatedAtMs !== null && selected.updated_at_ms !== lastScan.savedUpdatedAtMs) return '조건 저장본 변경됨';
    if (lastScan.dataStale) return '데이터 갱신됨';
    return null;
  })();

  // 1회 조회 + 결과 처리. 수동 버튼과 실시간 모니터링 루프가 공유하는 단일 seam(두
  // 경로의 결과 처리 드리프트 방지). 성공 시 true. 동일 멤버십(코드 집합)이고 총잔량
  // 값이 없으면 setLastScan 을 건너뛰어 리렌더·localStorage 재직렬화를 막는다 — 단
  // 총잔량 조건이 있으면(depthValues 존재) 값이 매 조회 변하므로 항상 갱신한다.
  const scanOnce = async (): Promise<boolean> => {
    const sel = selected;
    if (!sel) return false;
    try {
      const res = await screener.mutateAsync({
        conditions: sel.conditions, universe: sel.universe, basis: DRAWER_SCAN_BASIS,
      });
      const prev = useScreenerPanelStore.getState().lastScan;
      const canSkip = prev != null && prev.savedId === sel.id
        && res.depth_values == null && prev.depthValues == null
        && sameCodeSet(prev.rows, res.rows);
      if (canSkip) return true;
      setLastScan({
        savedId: sel.id,
        savedName: sel.name,
        savedUpdatedAtMs: sel.updated_at_ms,
        // 드로어는 신원 기반 staleness 라 scanKey 불필요(null).
        scanKey: null,
        rows: res.rows,
        scanStatus: res.status,
        warnings: res.warnings,
        depthValues: res.depth_values ?? null,
        scannedAtMs: Date.now(),
        basis: DRAWER_SCAN_BASIS,
        dataStale: false,
      });
      setSortMode('default');
      return true;
    } catch {
      return false;
    }
  };

  // 결과 전 종목에 Live Quote 오버레이(ADR-0056). scanRows 메모화로 lastScan null 동안
  // 매 렌더 새 [] 가 훅 내부 codes 메모를 무효화하지 않게 한다(풀페이지 Screener.tsx 와
  // 대칭). resultCodes 는 모니터 훅의 phase 조회 키(드로어 내부 useQuotes 와 동일).
  const scanRows = useMemo(() => lastScan?.rows ?? [], [lastScan]);
  const resultCodes = useMemo(() => scanRows.map((r) => r.code), [scanRows]);
  // 재조회 주기: 사용자 override(monitorPeriodMs) ?? 자동(스코프15/전체30초).
  const scoped = (selected?.universe.scopes?.length ?? 0) > 0;
  const monitorPeriodMs = useScreenerPanelStore((s) => s.monitorPeriodMs);
  const setMonitorPeriodMs = useScreenerPanelStore((s) => s.setMonitorPeriodMs);
  const effectivePeriodMs = monitorPeriodMs ?? (scoped ? MONITOR_PERIOD_SCOPED_MS : MONITOR_PERIOD_FULL_MS);
  const monitor = useScreenerMonitor({
    active: monitoringActive,
    selectedId: selectedSavedId,
    periodMs: effectivePeriodMs,
    disabled: notSeeded || !selected,
    resultCodes,
    scanOnce,
    onAutoStop: (message) => {
      setMonitoringActive(false);
      useScreenerUpdateFeedback.getState().setFeedback({ tone: 'error', message, atMs: Date.now() });
    },
  });

  // 모니터링 중 시드 없음·선택 해제 등으로 조회 불가가 되면 자동 종료(유령 활성 방지).
  useEffect(() => {
    if (monitoringActive && (notSeeded || !selected)) setMonitoringActive(false);
  }, [monitoringActive, notSeeded, selected, setMonitoringActive]);

  const handleSortChange = (mode: ScreenerResultSortMode) => {
    setSortMode(mode);
  };

  // 서버-소유 job 진행(status.updating)이 진실 — 갱신 트리거는 풀페이지 Screener/
  // 스케줄러 몫이고(드로어의 수동 갱신 버튼은 2026-07-12 제거), 드로어는 진행
  // 칩·피드백 표시만 담당한다.
  const serverUpdating = status?.updating != null;

  // 결과 전 종목에 Live Quote 오버레이(ADR-0056 개정 2026-06-03 — 상위 30 cap 제거).
  // 풀페이지 ResultTable 과 공유하는 단일 머지 seam(codes 추출·폴링·머지 캡슐화).
  // scanRows 는 위에서 정의(모니터 phase 조회와 공유).
  const liveRows = useScreenerRowsLive(scanRows);
  const sortedLiveRows = useMemo(() => sortScreenerRows(liveRows, sortMode), [liveRows, sortMode]);
  // 재조회로 새로 편입된 종목을 잠시 플래시. 훅은 항상 resultCodes 를 추적해 이전
  // 집합을 정확히 유지하고(토글 시 전체 플래시 방지), 표시만 모니터링 중으로 게이트한다.
  const flashCodes = useNewEntryFlash(resultCodes);
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

      {/* Controls: dropdown + 조회 */}
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
        {/* 대기 = 시작(즉시 1회 조회 + 실시간 유지)만. 별도의 수동 조회 버튼은 두지
            않는다 — 시작이 즉시 조회를 겸한다. */}
        {!monitoringActive ? (
          <ToolbarButton
            tone="primary"
            onClick={() => setMonitoringActive(true)}
            disabled={notSeeded || !selected}
            className="w-full py-1.5"
            aria-pressed={false}
            data-testid="screener-monitor-toggle"
          >
            ▶ 시작
          </ToolbarButton>
        ) : (
          // 활성 = '켜짐'을 accent-tint 배경으로 표현하는 단일 패널. 상태·종료를 한
          // 줄에, 주기 선택은 그 안 하단에 — 하나의 라이브 단위로 읽힘.
          <div
            data-testid="screener-monitor-status"
            className="flex flex-col gap-2 rounded-lg bg-tint-selection px-2.5 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg">
                {monitor.paused === 'closed' ? (
                  <span className="truncate text-fg-dim">장마감 — 대기 중</span>
                ) : (
                  <>
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                      style={{ backgroundColor: 'var(--accent)' }}
                    />
                    <span className="truncate">실시간 · {Math.round(effectivePeriodMs / 1000)}초</span>
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={() => setMonitoringActive(false)}
                aria-pressed
                data-testid="screener-monitor-toggle"
                className="shrink-0 rounded-md border border-border px-3 py-[3px] text-xs text-fg transition-colors hover:border-transparent hover:bg-bg-input-hover"
              >
                종료
              </button>
            </div>
            <SegmentedControl aria-label="갱신 주기" className="self-start">
              {MONITOR_PERIOD_CHOICES_MS.map((choice) => {
                const on = monitorPeriodMs === choice;
                const label = choice === null ? '자동' : `${choice / 1000}초`;
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setMonitorPeriodMs(choice)}
                    className={`px-2 py-[3px] text-xs ${on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </SegmentedControl>
          </div>
        )}
        {serverUpdating && (
          <div className="flex items-center">
            <ScreenerUpdateProgress updating={status?.updating} />
          </div>
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
          <RailState tone="warn" className="p-0">시드 필요 — 운영자 CLI로 시드 후 시작하세요</RailState>
        )}
        {lastScan && !screener.isError && (
          <div className="flex items-center gap-2 border-t border-border pt-sm text-xs uppercase tracking-[0.08em] text-fg-dimmer">
            <div className="min-w-0 flex-1 truncate">
              결과 {lastScan.rows.length} · {lastScan.savedName ?? '임시 조건'}
              {lastScanStaleReason && (
                <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--warn)' }}>
                  · {lastScanStaleReason} — 시작으로 갱신
                </span>
              )}
            </div>
            <ScreenerResultSortControl mode={sortMode} onChange={handleSortChange} disabled={lastScan.rows.length === 0} />
          </div>
        )}
      </RailDrawerSection>

      {/* Results */}
      <RailDrawerBody testId="screener-scroll" quoteNav>
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
            {(lastScan.warnings ?? []).includes('scope_universe_empty') && (
              <div className="mx-md mt-sm rounded-lg border px-3 py-2 text-sm" style={{ color: 'var(--warn)' }}>
                종목 범위가 비어 있음 · 관심종목·히트맵에 종목을 추가하세요
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
                      flash={monitoringActive && flashCodes.has(r.code)}
                      onActivate={() => openLive(r.code, r.name)}
                    />
                  ))}
                </ul>
              </DndContext>
            )}
          </>
        ) : (
          <RailState>조건을 선택하고 시작하세요.</RailState>
        )}
      </RailDrawerBody>
    </RailDrawer>
  );
}
