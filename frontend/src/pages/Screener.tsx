import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { PageContainer } from '../layout/PageContainer';
import { useLivePageStore } from '../state/livePage';
import { useScreener } from '../screener/useScreener';
import { useScreenerStatus } from '../screener/useScreenerStatus';
import { ConditionBuilder } from '../screener/ConditionBuilder';
import { SavedScreenerList } from '../screener/SavedScreenerList';
import { ResultTable } from '../screener/ResultTable';
import { StalenessChip } from '../screener/StalenessChip';
import { triggerScreenerUpdate, type ConditionLeaf, type ScreenerUniverse } from '../api/screener';
import type { SavedScreener } from '../api/savedScreeners';
import { addToWatchlist } from '../api/watchlist';
import { addItems } from '../api/captures';

export function Screener() {
  const navigate = useNavigate();
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const [conditions, setConditions] = useState<ConditionLeaf[]>(() => []);
  const [universe, setUniverse] = useState<ScreenerUniverse>({});
  // anchorId = the saved screener the builder currently corresponds to (null when
  // the builder is unsaved or has been edited away from it). dirty = the builder
  // diverged from that anchor since the last load/save. A boolean FLAG, not a
  // deep-equal: server↔builder normalization gaps (Pydantic None→null, false→
  // omitted key) make naive comparison report false "dirty"/"clean". The flag is
  // biased toward a false "수정됨" (e.g. after a manual revert) over a false
  // "clean". Under normal single-threaded use it does not show a lying clean
  // highlight; the one known residual is changing the builder/anchor while a
  // create/overwrite is still in flight (the edit-during-flight case is closed by
  // the generation guard below; loading a *different* save mid-flight is not, and
  // self-corrects on the next edit). Full correctness here would need a second
  // anchor generation — deliberately not added for that near-zero, self-healing path.
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // editGen bumps on every builder edit. beginSave() snapshots it; settleAnchor()
  // (the save's onSuccess) marks the row clean ONLY if no edit landed while the
  // save was in flight — otherwise the builder diverged from what was actually
  // saved and must stay dirty. Refs (read at call time) dodge stale closures. This
  // guards the common false-clean (an edit landing during a slow save's in-flight
  // window). It does NOT guard a mid-flight load of a different save — see the
  // residual noted above; that path self-heals on the next edit.
  const editGen = useRef(0);
  const pendingSaveGen = useRef<number | null>(null);
  // Load routes through the RAW setters + dirty=false. User edits route through
  // the wrappers below (passed only to ConditionBuilder) + dirty=true. Keeping
  // these paths separate is what makes "clean on load, dirty on edit" hold.
  const loadSave = (s: SavedScreener) => { setConditions(s.conditions); setUniverse(s.universe); setAnchorId(s.id); setDirty(false); };
  const editConditions = (c: ConditionLeaf[]) => { editGen.current += 1; setConditions(c); setDirty(true); };
  const editUniverse = (u: ScreenerUniverse) => { editGen.current += 1; setUniverse(u); setDirty(true); };
  const beginSave = () => { pendingSaveGen.current = editGen.current; };
  const settleAnchor = (id: string | null) => {
    setAnchorId(id);
    // Clean only when nothing was edited since the save was dispatched (or when
    // clearing the anchor). A mutation failure never calls this → dirty is left
    // as-is, which is correct (the save didn't change, so the builder still differs).
    if (id === null || pendingSaveGen.current === editGen.current) setDirty(false);
    pendingSaveGen.current = null;
  };

  const screener = useScreener();
  const { data: status } = useScreenerStatus();
  // Side-effect actions on a result row. Lazy — only fire on click, never at
  // render, so the screener API mock that omits these stays valid.
  const watch = useMutation({ mutationFn: (code: string) => addToWatchlist(code) });
  const capture = useMutation({ mutationFn: (code: string) => addItems({ code, force_retry: false }) });
  const update = useMutation({ mutationFn: () => triggerScreenerUpdate() });

  const notSeeded = screener.data?.status === 'not_seeded' || status?.status === 'not_seeded';
  const openLive = (code: string) => { setActiveCode(code); navigate('/live'); };
  const runScan = () => screener.mutate({ conditions, universe });

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
        <div className="flex-1" />
        <StalenessChip status={status} />
      </div>

      <SavedScreenerList current={{ conditions, universe }} anchorId={anchorId} dirty={dirty}
        onLoad={loadSave} onBeginSave={beginSave} onAnchorChange={settleAnchor} />
      <ConditionBuilder conditions={conditions} universe={universe}
        onConditionsChange={editConditions} onUniverseChange={editUniverse} />

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
        <ResultTable rows={screener.data?.rows ?? []} onActivate={openLive}
          onWatch={(code) => watch.mutate(code)} onCapture={(code) => capture.mutate(code)} />
      )}
    </PageContainer>
  );
}
