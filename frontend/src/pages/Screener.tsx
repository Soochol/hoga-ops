import { useMemo, useState } from 'react';
import { PageContainer } from '../layout/PageContainer';
import { useJumpToLive } from '../live/useJumpToLive';
import { useScreener } from '../screener/useScreener';
import { useScreenerStatus } from '../screener/useScreenerStatus';
import { useScreenerUpdate } from '../screener/useScreenerUpdate';
import { ConditionBuilder } from '../screener/ConditionBuilder';
import { SavedScreenerList } from '../screener/SavedScreenerList';
import { ResultTable } from '../screener/ResultTable';
import { StalenessChip } from '../screener/StalenessChip';
import { useSavedScreenerEditor } from '../screener/useSavedScreenerEditor';
import { useScreenerRowsLive } from '../screener/useScreenerRowsLive';
import { ModalShell } from '../ui/ModalShell';
import { ScreenerResultSortControl } from '../screener/ScreenerResultSortControl';
import { sortScreenerRows, type ScreenerResultSortMode } from '../screener/sortResults';
import type { ScanBasis } from '../api/screener';

type SaveDialogMode = 'save-new' | 'save-as';

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
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
        <button type="button" onClick={onClose}
          className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">취소</button>
        <button type="button" disabled={!trimmed} onClick={() => onSubmit(trimmed)}
          className="px-3 py-1.5 text-sm rounded font-semibold disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}>
          저장
        </button>
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
  const { data: status } = useScreenerStatus();
  const update = useScreenerUpdate();

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
      style={{ gridTemplateColumns: '236px 336px minmax(0, 1fr)', gridTemplateRows: 'auto 1fr' }}>
      {/* Title-less control bar spanning all panes (DESIGN.md page shell). */}
      <div className="col-span-3 min-w-0 flex items-center gap-md bg-bg-card border rounded-lg px-md py-sm">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-fg truncate">{currentTitle}</span>
            {editor.dirty && <span className="text-[10px] tracking-[0.04em] text-fg-dimmer">수정됨</span>}
            {resultsStale && <span className="text-[10px]" style={{ color: 'var(--warn)' }}>다시 조회 필요</span>}
          </div>
          {editor.saveError && <div className="text-xs" style={{ color: 'var(--error)' }}>저장 실패: {editor.saveError.message}</div>}
        </div>
        <button type="button" onClick={saveCurrent} disabled={editor.isSaving}
          className="px-3 py-[7px] rounded-lg bg-bg-input border text-fg text-sm hover:bg-bg-input-hover disabled:opacity-50 disabled:cursor-not-allowed">
          {editor.isSaving ? '저장 중…' : '저장'}
        </button>
        <button type="button" onClick={() => setSaveDialog('save-as')} disabled={editor.isSaving}
          className="px-3 py-[7px] rounded-lg bg-bg-input border text-fg-dim text-sm hover:bg-bg-input-hover disabled:opacity-50 disabled:cursor-not-allowed">
          다른 이름으로 저장
        </button>
        <div className="inline-flex rounded-lg border border-border bg-bg-input overflow-hidden" role="group" aria-label="스크리너 기준">
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
        </div>
        <button type="button" onClick={runScan} disabled={screener.isPending || notSeeded}
          className="px-lg py-sm rounded-lg bg-accent text-accent-fg font-semibold text-base hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed">
          {screener.isPending ? '조회 중…' : '조회'}
        </button>
        {!notSeeded && (
          <button type="button" aria-label="데이터 갱신" onClick={() => update.mutate()} disabled={update.isPending}
            className="px-3 py-[7px] rounded-lg bg-bg-input border text-fg-dim text-sm hover:bg-bg-input-hover disabled:opacity-50 disabled:cursor-not-allowed">
            {update.isPending ? '갱신 중…' : '갱신'}
          </button>
        )}
        {update.isError && (
          <span className="text-sm" style={{ color: 'var(--error)' }}>갱신 실패</span>
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
        <StalenessChip status={status} />
      </div>

      <div className="min-w-0 min-h-0">
        <SavedScreenerList anchorId={editor.anchorId} dirty={editor.dirty}
        onLoad={editor.load} onNewDraft={editor.newDraft}
        onSaveAsNew={editor.saveAsNew} onDuplicate={editor.duplicate}
        onRename={editor.rename} onRemove={editor.remove} />
      </div>
      <div className="min-w-0 min-h-0">
        <ConditionBuilder conditions={editor.conditions} universe={editor.universe}
          onConditionsChange={editor.editConditions} onUniverseChange={editor.editUniverse} />
      </div>

      {notSeeded ? (
        <div className="min-w-0 bg-bg-card border rounded-lg p-md flex flex-col gap-sm text-sm text-fg-dim">
          <span className="font-semibold" style={{ color: 'var(--warn)' }}>시드 필요</span>
          <span>스크리너 인덱스가 아직 시드되지 않았습니다. 운영자 CLI로 일회성 시드를 수행한 뒤 다시 조회하세요.</span>
        </div>
      ) : screener.isError ? (
        <div className="min-w-0 bg-bg-card border rounded-lg p-md flex flex-col gap-sm text-sm">
          <span className="font-semibold" style={{ color: 'var(--error)' }}>조회 실패 — 조건을 확인하세요</span>
          {screener.error instanceof Error && screener.error.message && (
            <span className="text-fg-dim">{screener.error.message}</span>
          )}
        </div>
      ) : (
        <div className="min-w-0 min-h-0 flex flex-col gap-sm">
          {resultsStale && (
            <div className="bg-bg-card border rounded-lg px-md py-sm text-sm" style={{ color: 'var(--warn)' }}>
              조건 변경됨 · 다시 조회 필요
            </div>
          )}
          {intradayFallback && (
            <div className="bg-bg-card border rounded-lg px-md py-sm text-sm" style={{ color: 'var(--warn)' }}>
              장중 조회 불가 · 전일 확정 데이터로 표시 중
            </div>
          )}
          <div className="flex justify-end">
            <ScreenerResultSortControl mode={sortMode} onChange={setSortMode} disabled={rows.length === 0} />
          </div>
          <ResultTable rows={sortedLiveRows} onActivate={openLive} sortMode={sortMode} onSortChange={setSortMode} />
        </div>
      )}
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
