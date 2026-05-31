import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { PageContainer } from '../layout/PageContainer';
import { useLivePageStore } from '../state/livePage';
import { useScreener } from '../screener/useScreener';
import { useScreenerStatus } from '../screener/useScreenerStatus';
import { ConditionPanel } from '../screener/ConditionPanel';
import { ResultTable } from '../screener/ResultTable';
import { StalenessChip } from '../screener/StalenessChip';
import { triggerScreenerUpdate, type ScreenerFilters } from '../api/screener';
import { addToWatchlist } from '../api/watchlist';
import { addItems } from '../api/captures';

const DEFAULT_FILTERS: ScreenerFilters = {
  newHigh: { lookback: 200, period: 500 },
};

export function Screener() {
  const navigate = useNavigate();
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const [filters, setFilters] = useState<ScreenerFilters>(DEFAULT_FILTERS);

  const screener = useScreener();
  const { data: status } = useScreenerStatus();

  // Side-effect actions on a result row. Lazy — only fire on click, never at
  // render, so the screener API mock that omits these stays valid.
  const watch = useMutation({ mutationFn: (code: string) => addToWatchlist(code) });
  const capture = useMutation({
    mutationFn: (code: string) => addItems({ code, force_retry: false }),
  });
  const update = useMutation({ mutationFn: () => triggerScreenerUpdate() });

  const notSeeded = screener.data?.status === 'not_seeded' || status?.status === 'not_seeded';

  const openLive = (code: string) => {
    setActiveCode(code);
    navigate('/live');
  };

  return (
    <PageContainer
      className="grid gap-md min-h-0"
      style={{ gridTemplateColumns: 'var(--sidebar-w) 1fr', gridTemplateRows: 'auto 1fr' }}
    >
      {/* Title-less control bar spanning both panes (DESIGN.md page shell). */}
      <div className="col-span-2 flex items-center gap-md">
        <button
          type="button"
          onClick={() => screener.mutate(filters)}
          disabled={screener.isPending || notSeeded}
          className="px-lg py-sm rounded-lg bg-accent text-accent-fg font-semibold text-base hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {screener.isPending ? '조회 중…' : '조회'}
        </button>
        {!notSeeded && (
          <button
            type="button"
            aria-label="데이터 갱신"
            onClick={() => update.mutate()}
            disabled={update.isPending}
            className="px-3 py-[7px] rounded-lg bg-bg-input border text-fg-dim text-sm hover:bg-bg-input-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {update.isPending ? '갱신 중…' : '갱신'}
          </button>
        )}
        <div className="flex-1" />
        <StalenessChip status={status} />
      </div>

      {/* Left: conditions */}
      <ConditionPanel value={filters} onChange={setFilters} />

      {/* Right: results / status notices */}
      {notSeeded ? (
        <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm text-sm text-fg-dim">
          <span className="font-semibold text-warn" style={{ color: 'var(--warn)' }}>
            시드 필요
          </span>
          <span>
            스크리너 인덱스가 아직 시드되지 않았습니다. 운영자 CLI로 일회성 시드를 수행한 뒤
            다시 조회하세요.
          </span>
        </div>
      ) : (
        <ResultTable
          rows={screener.data?.rows ?? []}
          filters={filters}
          onActivate={openLive}
          onWatch={(code) => watch.mutate(code)}
          onCapture={(code) => capture.mutate(code)}
        />
      )}
    </PageContainer>
  );
}
