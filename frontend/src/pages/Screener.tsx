import { useMemo } from 'react';
import { useNavigate } from 'react-router';
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

export function Screener() {
  const navigate = useNavigate();   // 캡처 deep-link(/capture?code=…)용
  const openLive = useJumpToLive();
  const editor = useSavedScreenerEditor();

  const screener = useScreener();
  const { data: status } = useScreenerStatus();
  const update = useScreenerUpdate();

  // 결과 행에 Live Quote 오버레이(현재가·등락률)를 적용 — 드로어와 공유하는 단일
  // 머지 seam. rows 를 메모화해 훅 내부 polling 의 queryKey 가 매 렌더 흔들리지 않게
  // 하고, codes 가 비면(notSeeded/error/무결과) 훅이 폴링을 끈다.
  const rows = useMemo(() => screener.data?.rows ?? [], [screener.data]);
  const liveRows = useScreenerRowsLive(rows);

  const notSeeded = screener.data?.status === 'not_seeded' || status?.status === 'not_seeded';
  const runScan = () => screener.mutate({ conditions: editor.conditions, universe: editor.universe });

  return (
    <PageContainer className="grid gap-md min-h-0"
      style={{ gridTemplateColumns: '236px 336px 1fr', gridTemplateRows: 'auto 1fr' }}>
      {/* Title-less control bar spanning all panes (DESIGN.md page shell). */}
      <div className="col-span-3 flex items-center gap-md">
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
        <div className="flex-1" />
        <StalenessChip status={status} />
      </div>

      <SavedScreenerList anchorId={editor.anchorId} dirty={editor.dirty}
        onLoad={editor.load} onNewDraft={editor.newDraft}
        onSaveAsNew={editor.saveAsNew} onOverwrite={editor.overwrite}
        onRename={editor.rename} onRemove={editor.remove} />
      <ConditionBuilder conditions={editor.conditions} universe={editor.universe}
        onConditionsChange={editor.editConditions} onUniverseChange={editor.editUniverse} />

      {notSeeded ? (
        <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm text-sm text-fg-dim">
          <span className="font-semibold" style={{ color: 'var(--warn)' }}>시드 필요</span>
          <span>스크리너 인덱스가 아직 시드되지 않았습니다. 운영자 CLI로 일회성 시드를 수행한 뒤 다시 조회하세요.</span>
        </div>
      ) : screener.isError ? (
        <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm text-sm">
          <span className="font-semibold" style={{ color: 'var(--error)' }}>조회 실패 — 조건을 확인하세요</span>
          {screener.error instanceof Error && screener.error.message && (
            <span className="text-fg-dim">{screener.error.message}</span>
          )}
        </div>
      ) : (
        <ResultTable rows={liveRows} onActivate={openLive}
          onCapture={(code) => navigate(`/capture?code=${encodeURIComponent(code)}`)} />
      )}
    </PageContainer>
  );
}
