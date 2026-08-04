import { useMemo, useRef, useState } from 'react';
import { PageContainer } from '../layout/PageContainer';
import { useJumpToLive } from '../live/useJumpToLive';
import { useScreener } from '../screener/useScreener';
import { useScreenerStatus } from '../screener/useScreenerStatus';
import { useScreenerUpdate } from '../screener/useScreenerUpdate';
import { useScreenerUpdateFeedback } from '../screener/useScreenerUpdateSync';
import { ScreenerUpdateProgress } from '../screener/ScreenerUpdateProgress';
import { ConditionBuilder } from '../screener/ConditionBuilder';
import { ResultTable } from '../screener/ResultTable';
import { StalenessChip } from '../screener/StalenessChip';
import { useSavedScreenerEditor } from '../screener/useSavedScreenerEditor';
import { useSavedScreeners } from '../screener/useSavedScreeners';
import { useScreenerRowsLive } from '../screener/useScreenerRowsLive';
import { useScreenerPanelStore, useExpireScreenerScan } from '../state/screenerPanel';
import { DataSection, EmptyState, InlineState } from '../ui/DataSurface';
import { ConfirmModal } from '../ui/ConfirmModal';
import { ModalShell } from '../ui/ModalShell';
import { ControlBar, PanelCard, SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { ScreenerResultSortControl } from '../screener/ScreenerResultSortControl';
import { DepthCoverageBanner } from '../screener/DepthCoverageBanner';
import { sortScreenerRows } from '../screener/sortResults';
import { intradayDegradationText } from '../screener/intradayDegradation';
import { suggestSaveName } from '../screener/suggestName';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useLiveSettings } from '../api/liveSettings';
import type { ScanBasis } from '../api/screener';
import type { SavedScreener } from '../api/savedScreeners';

type NameDialogMode = 'save-new' | 'save-as' | 'rename';

const FEEDBACK_TONE_COLOR = {
  info: 'var(--fg-dim)',
  warn: 'var(--warn)',
  error: 'var(--error)',
} as const;

function SaveNameDialog({ title, initialName, onSubmit, onClose }: {
  title: string;
  initialName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  return (
    <ModalShell ariaLabel={title} title={title} width="w-[360px]" onClose={onClose}>
      <div className="px-4 py-4">
        <label className="flex flex-col gap-1.5 text-sm text-fg">
          <span className="text-fg-dim">이름</span>
          <input autoFocus aria-label="조건검색 이름" value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed) { e.preventDefault(); onSubmit(trimmed); }
            }}
            className="bg-bg-input border border-border rounded-md px-2 py-1.5 text-fg" />
        </label>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <ToolbarButton type="button" onClick={onClose}>취소</ToolbarButton>
        <ToolbarButton type="button" tone="primary" disabled={!trimmed} onClick={() => onSubmit(trimmed)}>
          저장
        </ToolbarButton>
      </div>
    </ModalShell>
  );
}

/** 선택된 저장본에 대한 관리 메뉴(이름변경/복제/삭제) — 구 SavedScreenerList 행
 *  메뉴의 후계. 셀렉터 기반 레이아웃에는 행이 없으므로 앵커 저장본 하나에만 건다. */
function SavedActionsMenu({ save, onRename, onDuplicate, onDelete }: {
  save: SavedScreener;
  onRename: () => void;
  onDuplicate: (s: SavedScreener) => void;
  onDelete: (s: SavedScreener) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useDismissablePopover(open, wrapRef, () => setOpen(false));
  const { ref: menuRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect ? anchorRect.right - 104 : 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );
  const toggle = () => {
    const next = !open;
    if (next && btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
    setOpen(next);
  };
  const item = (label: string, run: () => void, style?: React.CSSProperties) => (
    <button type="button" role="menuitem" style={style}
      onClick={() => { setOpen(false); run(); }}
      className="block w-full px-3 py-2 text-left text-sm text-fg hover:bg-bg-input-hover">
      {label}
    </button>
  );
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button ref={btnRef} type="button" aria-label="저장 조건 메뉴" aria-expanded={open} onClick={toggle}
        className="px-1.5 py-1 rounded-md text-fg-dim hover:text-fg hover:bg-bg-input-hover">⋯</button>
      {open && anchorRect && (
        <div ref={menuRef} role="menu"
          className="z-50 min-w-[104px] overflow-hidden rounded-md border border-border-strong bg-bg-card shadow-overlay"
          style={{ position: 'fixed', left, top }}>
          {item('이름변경', onRename)}
          {item('복제', () => onDuplicate(save))}
          {item('삭제', () => onDelete(save), { color: 'var(--error)' })}
        </div>
      )}
    </div>
  );
}

/** 경고의 배너/칩 분리 — 행동이 필요한 최우선 1개만 배너로 올리고 나머지는
 *  결과 메타 줄의 칩으로 강등한다(배너 스택이 테이블을 밀어내지 않게). */
interface StatusFlag { key: string; text: string }

export function Screener() {
  const openLive = useJumpToLive();
  const editor = useSavedScreenerEditor();
  const [nameDialog, setNameDialog] = useState<NameDialogMode | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SavedScreener | null>(null);

  // 조회 결과·정렬은 screenerPanel 스토어(localStorage + 30분 TTL)에 산다 — 라우트
  // 이탈/복귀·새로고침 후에도 유지되고 드로어와 마지막 스캔을 공유한다.
  const lastScan = useScreenerPanelStore((s) => s.lastScan);
  const setLastScan = useScreenerPanelStore((s) => s.setLastScan);
  const sortMode = useScreenerPanelStore((s) => s.sortMode);
  const setSortMode = useScreenerPanelStore((s) => s.setSortMode);
  const [basis, setBasis] = useState<ScanBasis>(() => lastScan?.basis ?? 'intraday');
  useExpireScreenerScan();

  const screener = useScreener();
  const { data: liveSettings } = useLiveSettings();
  const { data: savesData } = useSavedScreeners();
  const { data: status } = useScreenerStatus();
  const update = useScreenerUpdate();
  const updateFeedback = useScreenerUpdateFeedback((s) => s.feedback);
  // 서버-소유 job 진행 여부 — 다른 탭/드로어/스케줄러가 시작한 갱신도 잡는다.
  const serverUpdating = status?.updating != null;

  const saves = savesData?.saves ?? [];
  const anchorSave = editor.anchorId != null
    ? saves.find((s) => s.id === editor.anchorId) ?? null
    : null;

  // 결과 행에 Live Quote 오버레이(현재가·등락률)를 적용 — 드로어와 공유하는 단일
  // 머지 seam. rows 를 메모화해 훅 내부 polling 의 queryKey 가 매 렌더 흔들리지 않게
  // 하고, codes 가 비면(notSeeded/error/무결과) 훅이 폴링을 끈다.
  const rows = useMemo(() => lastScan?.rows ?? [], [lastScan]);
  const liveRows = useScreenerRowsLive(rows);
  const sortedLiveRows = useMemo(() => sortScreenerRows(liveRows, sortMode), [liveRows, sortMode]);

  const notSeeded = lastScan?.scanStatus === 'not_seeded' || status?.status === 'not_seeded';
  // 빈 빌더 조회 차단: 조건 0개로 조회하면 백엔드 JOIN 필터가 하나도 붙지 않아
  // "KOSPI·KOSDAQ 전종목 거래대금 상위 1000행"이 나온다. 진입 시 저장 조건이
  // 자동 로드되므로(useSavedScreenerEditor) 평상시엔 걸리지 않는 가드.
  const hasConditions = editor.conditions.length > 0;
  const scanBody = useMemo(
    () => ({ conditions: editor.conditions, universe: editor.universe, basis }),
    [editor.conditions, editor.universe, basis],
  );
  const scanKey = useMemo(() => JSON.stringify(scanBody), [scanBody]);
  // 내용 기반 staleness: 저장된 scanKey 와 현재 빌더 key 가 다르면 "다시 조회 필요".
  // 드로어 스캔은 scanKey null → 비교 불가 시 stale 판정하지 않는다.
  const resultsStale = lastScan?.scanKey != null && lastScan.scanKey !== scanKey;
  // 강등 사유별 문구 — 유량 초과·자격증명 부재·파싱 오류의 처방이 각각 다르다(ADR-0137).
  const intradayDegradation =
    lastScan?.basis === 'intraday' ? intradayDegradationText(lastScan?.warnings) : null;
  const scopeUniverseEmpty = (lastScan?.warnings ?? []).includes('scope_universe_empty');
  // 심볼 마스터 미로드 → ETF 판정이 stocks.parquet(수동 시드, 낡을 수 있음)으로 강등.
  const etfFilterStale = (lastScan?.warnings ?? []).includes('etf_filter_stale_master_unavailable');
  // 기준시각 돌파는 당일 전용 — eod 로 조회하면 0행이 된다. 이유를 안 보여주면
  // "조건에 맞는 종목이 없음"과 구분되지 않는다.
  const renewalNeedsIntraday = (lastScan?.warnings ?? []).includes('depth_renewal_requires_intraday');
  const runScan = () => screener.mutate(scanBody, {
    onSuccess: (res) => {
      // 저장본을 로드해 수정 없이 조회한 경우에만 저장본 신원을 붙인다 — dirty/미저장이면
      // null(임시 조건). 드로어의 신원 기반 staleness 를 오염시키지 않기 위함.
      const anchored = !editor.dirty && editor.anchorId != null;
      const saved = anchored ? savesData?.saves.find((s) => s.id === editor.anchorId) ?? null : null;
      setLastScan({
        savedId: anchored ? editor.anchorId : null,
        savedName: anchored ? editor.anchorName : null,
        savedUpdatedAtMs: saved?.updated_at_ms ?? null,
        scanKey,
        rows: res.rows,
        scanStatus: res.status,
        warnings: res.warnings,
        depthValues: res.depth_values ?? null,
        scannedAtMs: Date.now(),
        basis,
        dataStale: false,
      });
      setSortMode('default');
    },
  });
  const submitNameDialog = (name: string) => {
    if (nameDialog === 'save-new') editor.saveCurrent(name);
    else if (nameDialog === 'save-as') editor.saveAsNew(name);
    else if (nameDialog === 'rename' && anchorSave) editor.rename(anchorSave, name);
    setNameDialog(null);
  };
  const nameDialogTitle = nameDialog === 'rename' ? '이름변경' : '조건검색 저장';
  const nameDialogInitial = nameDialog === 'rename'
    ? anchorSave?.name ?? ''
    : nameDialog === 'save-as' && editor.anchorName
      ? `${editor.anchorName} 복사`
      : suggestSaveName(saves.map((s) => s.name));
  const saveCurrent = () => {
    if (editor.anchorId) editor.saveCurrent();
    else setNameDialog('save-new');
  };
  const depthSides = {
    ask: editor.conditions.some((c) => c.type === 'ask_depth_new_high'),
    bid: editor.conditions.some((c) => c.type === 'bid_depth_new_high'),
    askRenewal: editor.conditions.some((c) => c.type === 'ask_depth_renewal'),
    bidRenewal: editor.conditions.some((c) => c.type === 'bid_depth_renewal'),
  };

  // 우선순위 순 — 첫 번째가 배너, 나머지는 칩. 문구는 종전 배너 문구를 그대로 쓴다
  // (표시 계약: 문구를 바꾸면 e2e 셀렉터·사용자 학습이 함께 깨진다).
  const statusFlags: StatusFlag[] = [];
  if (!hasConditions) {
    statusFlags.push({ key: 'no-conditions', text: '조건이 없습니다 · 저장된 조건검색을 선택하거나 조건을 추가하면 조회할 수 있습니다' });
  }
  if (resultsStale) statusFlags.push({ key: 'stale', text: '조건 변경됨 · 다시 조회 필요' });
  if (renewalNeedsIntraday) {
    statusFlags.push({ key: 'renewal-intraday', text: '매도 총잔량 기준시각 돌파는 당일 전용 · 장중 기준으로 조회하세요' });
  }
  if (scopeUniverseEmpty) {
    statusFlags.push({ key: 'scope-empty', text: '종목 범위가 비어 있음 · 관심종목·히트맵에 종목을 추가하세요' });
  }
  if (intradayDegradation) statusFlags.push({ key: 'degraded', text: intradayDegradation });
  if (etfFilterStale) {
    statusFlags.push({ key: 'etf-stale', text: '종목 마스터 없음 · ETF 제외가 오래된 목록 기준입니다' });
  }
  const [bannerFlag, ...chipFlags] = statusFlags;

  const scannedAtLabel = lastScan
    ? new Date(lastScan.scannedAtMs).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
    : null;

  return (
    <PageContainer className="grid gap-md min-h-0 !pb-0"
      style={{ gridTemplateColumns: '23rem minmax(0, 1fr)' }}>
      <PanelCard borderless flat data-testid="screener-builder-pane" className="flex min-h-0 flex-col overflow-hidden">
        <div className="flex flex-col gap-sm p-md pb-0">
          <div className="flex items-center gap-1.5">
            <span className="text-2xs font-semibold uppercase text-fg-dim">조건검색</span>
            <button type="button" aria-label="새 조건검색" title="새 조건검색"
              onClick={() => editor.newDraft()}
              className="ml-auto w-[22px] h-[22px] rounded-md bg-bg-input border text-fg-dim hover:text-fg">＋</button>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              aria-label="저장한 조건검색 선택"
              value={editor.anchorId ?? ''}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) { editor.newDraft(); return; }
                const s = saves.find((x) => x.id === id);
                if (s) editor.load(s);
              }}
              className="min-w-0 flex-1 rounded-md border border-border bg-bg-input px-2 py-1.5 text-sm text-fg"
            >
              <option value="">새 조건검색</option>
              {saves.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {editor.dirty && <span className="shrink-0 text-2xs text-fg-dim">수정됨</span>}
            {anchorSave && (
              <SavedActionsMenu save={anchorSave}
                onRename={() => setNameDialog('rename')}
                onDuplicate={editor.duplicate}
                onDelete={setConfirmDelete} />
            )}
          </div>
          <div className="flex items-center gap-1">
            <ToolbarButton onClick={saveCurrent} disabled={editor.isSaving} className="text-fg">
              {editor.isSaving ? '저장 중…' : '저장'}
            </ToolbarButton>
            <ToolbarButton onClick={() => setNameDialog('save-as')} disabled={editor.isSaving}>
              다른 이름으로 저장
            </ToolbarButton>
          </div>
          {editor.saveError && (
            <div className="text-xs" style={{ color: 'var(--error)' }}>저장 실패: {editor.saveError.message}</div>
          )}
          <div className="border-t border-border" />
        </div>
        <div className="min-h-0 flex-1">
          <ConditionBuilder conditions={editor.conditions} universe={editor.universe}
            onConditionsChange={editor.editConditions} onUniverseChange={editor.editUniverse} />
        </div>
      </PanelCard>

      <PanelCard borderless flat data-testid="screener-results-pane" className="flex min-h-0 flex-col overflow-hidden">
        <div className="p-md">
          <ControlBar className="flex-wrap">
            <div className="min-w-0 flex-1" />
            <SegmentedControl aria-label="스크리너 기준">
              {(['intraday', 'eod'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setBasis(value)}
                  title={value === 'intraday' ? '조건검색 실행 시 오늘 KIS quote를 일봉 위에 임시 반영합니다' : undefined}
                  className={`px-3 py-[7px] text-sm ${basis === value ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
                >
                  {value === 'intraday' ? '오늘 장중' : '전일 확정'}
                </button>
              ))}
            </SegmentedControl>
            <ToolbarButton tone="primary" onClick={runScan}
              disabled={screener.isPending || notSeeded || !hasConditions}
              title={!hasConditions ? '조건이 없습니다 — 저장된 조건검색을 선택하거나 조건을 추가하세요' : undefined}
              className="px-lg py-sm text-base">
              {screener.isPending ? '조회 중…' : '조회'}
            </ToolbarButton>
            {!notSeeded && (
              <ToolbarButton aria-label="데이터 갱신" onClick={() => update.mutate()}
                disabled={update.isPending || serverUpdating}>
                {update.isPending || serverUpdating ? '갱신 중…' : '갱신'}
              </ToolbarButton>
            )}
            {update.isError && (
              <span role="alert" className="text-sm" style={{ color: 'var(--error)' }}>갱신 실패</span>
            )}
            {updateFeedback && (
              <span role="status" className="text-sm" style={{ color: FEEDBACK_TONE_COLOR[updateFeedback.tone] }}>
                {updateFeedback.message}
              </span>
            )}
          </ControlBar>
        </div>

        {/* `min-h-0` 이 빠져 있었다 — flex 자식의 기본 `min-height:auto` 때문에 결과가
            길면 섹션이 콘텐츠 높이(1,000행 = 28,000px)로 자라고, 부모(`overflow:hidden`,
            644px)가 그걸 **잘라낸다**. 즉 아래쪽 행은 스크롤로도 도달할 수 없었다.
            이걸 넣어야 셸(`overflow-auto`)이 유계 높이를 받아 내부 스크롤이 산다. */}
        <DataSection title="결과" flushHeader className="flex min-h-0 flex-1 flex-col" contentClassName="flex min-h-0 flex-1 flex-col gap-sm p-md">
          {/* 결과 메타 줄: 개수·기준·조회 시각 + 강등된 경고 칩 + 정렬·갱신 상태.
              개수가 없으면 "결과"라는 제목만으로는 조회가 됐는지조차 알 수 없다. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {/* role=status: 조회 시작·완료(결과 N건)가 스크린리더에 공지된다 — 종전엔
                스크리너 전역에 라이브 리전이 0건이라 조회 결과가 무음이었다. */}
            <span role="status">
              {screener.isPending ? (
                <span className="text-sm text-fg-dim">조회 중…</span>
              ) : lastScan ? (
                <span data-testid="screener-result-meta" className="font-data text-sm tabular-nums text-fg">
                  결과 <span className="font-semibold">{rows.length.toLocaleString('ko-KR')}</span>건
                  <span className="text-fg-dim">
                    {' '}· {lastScan.basis === 'intraday' ? '오늘 장중' : '전일 확정'}
                    {scannedAtLabel && ` · ${scannedAtLabel} 조회`}
                  </span>
                </span>
              ) : (
                <span className="text-sm text-fg-dim">조회 전</span>
              )}
            </span>
            {chipFlags.map((f) => (
              <span key={f.key} title={f.text}
                className="max-w-[16rem] truncate rounded-md bg-bg-subtle px-1.5 py-0.5 text-2xs"
                style={{ color: 'var(--warn)' }}>
                {f.text}
              </span>
            ))}
            <span className="min-w-0 flex-1" />
            {basis === 'intraday' && (
              <span
                className="inline-flex items-center gap-1.5 font-data text-xs tabular-nums text-fg-dim"
                title="조건검색 실행 시 오늘 KIS quote를 일봉 위에 임시 반영합니다"
              >
                오늘 장중: KIS quote 반영
              </span>
            )}
            <ScreenerResultSortControl mode={sortMode} onChange={setSortMode} disabled={rows.length === 0} />
            <ScreenerUpdateProgress updating={status?.updating} />
            <StalenessChip status={status} />
          </div>

          {notSeeded ? (
            <InlineState tone="warn" className="text-sm">
              <span className="font-semibold">시드 필요</span> 스크리너 인덱스가 아직 시드되지 않았습니다. 운영자 CLI로 일회성 시드를 수행한 뒤 다시 조회하세요
            </InlineState>
          ) : screener.isError ? (
            <InlineState tone="error" role="alert" className="text-sm">
              <span className="font-semibold">조회 실패 — 조건을 확인하세요</span>
              {screener.error instanceof Error && screener.error.message && (
                <span className="ml-2 text-fg-dim">{screener.error.message}</span>
              )}
            </InlineState>
          ) : (
            <>
              {bannerFlag && <InlineState tone="warn">{bannerFlag.text}</InlineState>}
              {screener.data?.depth_coverage && (
                // key = 결측 코드 집합. 재조회로 집합이 바뀌면 배너를 새 인스턴스로
                // 리마운트해 stale "수집 중 N건"/사라진 버튼 상태를 리셋한다(같은 집합이면
                // 인스턴스 유지 → 진행 안내·자동수집 가드 보존).
                <DepthCoverageBanner
                  key={screener.data.depth_coverage.excluded.map((c) => c.code).join(',')}
                  coverage={screener.data.depth_coverage}
                  autoCollect={liveSettings?.screener_depth_autocollect ?? false}
                />
              )}
              {lastScan == null ? (
                // "조회 전"과 "조건에 맞는 종목 없음"은 다른 상태다 — 30분 TTL 로 결과가
                // 만료된 직후를 0건으로 오독하면 사용자는 조건이 틀렸다고 착각한다.
                <EmptyState className="flex-1" title="아직 조회하지 않았습니다">
                  조건을 확인하고 조회를 누르면 결과가 여기 표시됩니다 · 결과는 30분 뒤 만료됩니다
                </EmptyState>
              ) : (
                <div className={`flex min-h-0 flex-1 flex-col ${screener.isPending ? 'opacity-60' : ''}`}>
                  <ResultTable
                    rows={sortedLiveRows}
                    onActivate={openLive}
                    sortMode={sortMode}
                    onSortChange={setSortMode}
                    embedded
                    depthValues={lastScan?.depthValues ?? undefined}
                    depthSides={depthSides}
                  />
                </div>
              )}
            </>
          )}
        </DataSection>
      </PanelCard>
      {nameDialog && (
        <SaveNameDialog
          title={nameDialogTitle}
          initialName={nameDialogInitial}
          onSubmit={submitNameDialog}
          onClose={() => setNameDialog(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          message={`"${confirmDelete.name}" 삭제?`}
          confirmLabel="삭제"
          tone="destructive"
          onConfirm={() => { editor.remove(confirmDelete); setConfirmDelete(null); }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </PageContainer>
  );
}
