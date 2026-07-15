import { useMemo, useState } from 'react';
import { PageContainer } from '../layout/PageContainer';
import { useJumpToLive } from '../live/useJumpToLive';
import { useScreener } from '../screener/useScreener';
import { useScreenerStatus } from '../screener/useScreenerStatus';
import { useScreenerUpdate } from '../screener/useScreenerUpdate';
import { useScreenerUpdateFeedback } from '../screener/useScreenerUpdateSync';
import { ScreenerUpdateProgress } from '../screener/ScreenerUpdateProgress';
import { ConditionBuilder } from '../screener/ConditionBuilder';
import { SavedScreenerList } from '../screener/SavedScreenerList';
import { ResultTable } from '../screener/ResultTable';
import { StalenessChip } from '../screener/StalenessChip';
import { useSavedScreenerEditor } from '../screener/useSavedScreenerEditor';
import { useScreenerRowsLive } from '../screener/useScreenerRowsLive';
import { DataSection, InlineState } from '../ui/DataSurface';
import { ModalShell } from '../ui/ModalShell';
import { ControlBar, PanelCard, SegmentedControl, ToolbarButton } from '../ui/PageShell';
import { ScreenerResultSortControl } from '../screener/ScreenerResultSortControl';
import { DepthCoverageBanner } from '../screener/DepthCoverageBanner';
import { sortScreenerRows, type ScreenerResultSortMode } from '../screener/sortResults';
import { useLiveSettings } from '../api/liveSettings';
import type { ScanBasis } from '../api/screener';

type SaveDialogMode = 'save-new' | 'save-as';

const FEEDBACK_TONE_COLOR = {
  info: 'var(--fg-dim)',
  warn: 'var(--warn)',
  error: 'var(--error)',
} as const;

function SaveNameDialog({ initialName, onSubmit, onClose }: {
  initialName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  return (
    <ModalShell ariaLabel="조건검색 저장" title="조건검색 저장" width="w-[360px]" onClose={onClose}>
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

export function Screener() {
  const openLive = useJumpToLive();
  const editor = useSavedScreenerEditor();
  const [saveDialog, setSaveDialog] = useState<SaveDialogMode | null>(null);
  const [lastScanKey, setLastScanKey] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<ScreenerResultSortMode>('default');
  const [basis, setBasis] = useState<ScanBasis>('intraday');

  const screener = useScreener();
  const { data: liveSettings } = useLiveSettings();
  const { data: status } = useScreenerStatus();
  const update = useScreenerUpdate();
  const updateFeedback = useScreenerUpdateFeedback((s) => s.feedback);
  // 서버-소유 job 진행 여부 — 다른 탭/드로어/스케줄러가 시작한 갱신도 잡는다.
  const serverUpdating = status?.updating != null;

  // 결과 행에 Live Quote 오버레이(현재가·등락률)를 적용 — 드로어와 공유하는 단일
  // 머지 seam. rows 를 메모화해 훅 내부 polling 의 queryKey 가 매 렌더 흔들리지 않게
  // 하고, codes 가 비면(notSeeded/error/무결과) 훅이 폴링을 끈다.
  const rows = useMemo(() => screener.data?.rows ?? [], [screener.data]);
  const liveRows = useScreenerRowsLive(rows);
  const sortedLiveRows = useMemo(() => sortScreenerRows(liveRows, sortMode), [liveRows, sortMode]);

  const notSeeded = screener.data?.status === 'not_seeded' || status?.status === 'not_seeded';
  const scanBody = useMemo(
    () => ({ conditions: editor.conditions, universe: editor.universe, basis }),
    [editor.conditions, editor.universe, basis],
  );
  const scanKey = useMemo(() => JSON.stringify(scanBody), [scanBody]);
  const resultsStale = lastScanKey !== null && lastScanKey !== scanKey;
  const intradayFallback = basis === 'intraday' && (screener.data?.warnings ?? []).includes('intraday_fallback_eod');
  const runScan = () => screener.mutate(scanBody, {
    onSuccess: () => {
      setLastScanKey(scanKey);
      setSortMode('default');
    },
  });
  const currentTitle = editor.anchorName ?? '새 조건검색';
  const saveDialogInitial = saveDialog === 'save-as' && editor.anchorName ? `${editor.anchorName} 복사` : '새조건1';
  const submitSaveDialog = (name: string) => {
    if (saveDialog === 'save-new') editor.saveCurrent(name);
    else editor.saveAsNew(name);
    setSaveDialog(null);
  };
  const saveCurrent = () => {
    if (editor.anchorId) editor.saveCurrent();
    else setSaveDialog('save-new');
  };

  return (
    <PageContainer className="grid gap-md min-h-0"
      style={{ gridTemplateColumns: '236px 336px minmax(0, 1fr)' }}>
      <PanelCard data-testid="screener-saves-pane" className="min-h-0 overflow-hidden">
        <SavedScreenerList anchorId={editor.anchorId} dirty={editor.dirty}
          onLoad={editor.load} onNewDraft={editor.newDraft}
          onSaveAsNew={editor.saveAsNew} onDuplicate={editor.duplicate}
          onRename={editor.rename} onRemove={editor.remove} />
      </PanelCard>
      <PanelCard data-testid="screener-builder-pane" className="min-h-0 overflow-hidden">
        <ConditionBuilder conditions={editor.conditions} universe={editor.universe}
          onConditionsChange={editor.editConditions} onUniverseChange={editor.editUniverse} />
      </PanelCard>

      <PanelCard data-testid="screener-results-pane" className="flex min-h-0 flex-col overflow-hidden">
        <div className="border-b border-border p-md">
          <ControlBar className="flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-fg truncate">{currentTitle}</span>
                {editor.dirty && <span className="text-[10px] tracking-[0.04em] text-fg-dimmer">수정됨</span>}
                {resultsStale && <span className="text-[10px]" style={{ color: 'var(--warn)' }}>다시 조회 필요</span>}
              </div>
              {editor.saveError && <div className="text-xs" style={{ color: 'var(--error)' }}>저장 실패: {editor.saveError.message}</div>}
            </div>
            <ToolbarButton onClick={saveCurrent} disabled={editor.isSaving} className="text-fg">
              {editor.isSaving ? '저장 중…' : '저장'}
            </ToolbarButton>
            <ToolbarButton onClick={() => setSaveDialog('save-as')} disabled={editor.isSaving}>
              다른 이름으로 저장
            </ToolbarButton>
            <SegmentedControl aria-label="스크리너 기준">
              {(['intraday', 'eod'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setBasis(value)}
                  className={`px-3 py-[7px] text-sm ${basis === value ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
                >
                  {value === 'intraday' ? '오늘 장중' : '전일 확정'}
                </button>
              ))}
            </SegmentedControl>
            <ToolbarButton tone="primary" onClick={runScan} disabled={screener.isPending || notSeeded}
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
              <span className="text-sm" style={{ color: 'var(--error)' }}>갱신 실패</span>
            )}
            {updateFeedback && (
              <span className="text-sm" style={{ color: FEEDBACK_TONE_COLOR[updateFeedback.tone] }}>
                {updateFeedback.message}
              </span>
            )}
            <div className="min-w-0 flex-1" />
            {basis === 'intraday' && (
              <span
                className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums text-fg-dim"
                title="조건검색 실행 시 오늘 KIS quote를 일봉 위에 임시 반영합니다"
              >
                오늘 장중: KIS quote 반영
              </span>
            )}
            <ScreenerUpdateProgress updating={status?.updating} />
            <StalenessChip status={status} />
          </ControlBar>
        </div>

        <DataSection title="결과" className="flex flex-1 flex-col" contentClassName="flex min-h-0 flex-1 flex-col gap-sm p-md">
          {notSeeded ? (
            <InlineState tone="warn" className="text-sm">
              <span className="font-semibold">시드 필요</span> 스크리너 인덱스가 아직 시드되지 않았습니다. 운영자 CLI로 일회성 시드를 수행한 뒤 다시 조회하세요.
            </InlineState>
          ) : screener.isError ? (
            <InlineState tone="error" className="text-sm">
              <span className="font-semibold">조회 실패 — 조건을 확인하세요</span>
              {screener.error instanceof Error && screener.error.message && (
                <span className="ml-2 text-fg-dim">{screener.error.message}</span>
              )}
            </InlineState>
          ) : (
            <>
              {resultsStale && (
                <InlineState tone="warn">조건 변경됨 · 다시 조회 필요</InlineState>
              )}
              {intradayFallback && (
                <InlineState tone="warn">장중 조회 불가 · 전일 확정 데이터로 표시 중</InlineState>
              )}
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
              <div className="flex justify-end">
                <ScreenerResultSortControl mode={sortMode} onChange={setSortMode} disabled={rows.length === 0} />
              </div>
              <ResultTable
                rows={sortedLiveRows}
                onActivate={openLive}
                sortMode={sortMode}
                onSortChange={setSortMode}
                embedded
                depthValues={screener.data?.depth_values}
                depthSides={{
                  ask: editor.conditions.some((c) => c.type === 'ask_depth_new_high'),
                  bid: editor.conditions.some((c) => c.type === 'bid_depth_new_high'),
                }}
              />
            </>
          )}
        </DataSection>
      </PanelCard>
      {saveDialog && (
        <SaveNameDialog
          initialName={saveDialogInitial}
          onSubmit={submitSaveDialog}
          onClose={() => setSaveDialog(null)}
        />
      )}
    </PageContainer>
  );
}
