import { useEffect, useMemo, useRef, useState } from 'react';
import { useWatchlist, useCreateFolder, useReorderEntries } from '../watchlist/useWatchlist';
import { groupByFolder } from '../watchlist/grouping';
import { useLiveQuoteOverlay } from '../api/liveQuotes';
import { useLiveStatus } from '../api/liveStatus';
import { deriveBannerState } from '../live/useLiveBannerState';
import { LiveStateBanner } from '../live/LiveStateBanner';
import { useJumpToLive } from '../live/useJumpToLive';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { HeatmapBoard } from '../heatmap/HeatmapBoard';
import { SectorTempStrip } from '../heatmap/SectorTempStrip';
import { useSparklineStore } from '../state/sparklineStore';
import { useSparklineSeries } from '../heatmap/useSparklineSeries';
import { visibleFolderGroups } from '../heatmap/visibleGroups';
import { HEAT_SAT } from '../heatmap/heat';
import { GroupNameModal } from '../watchlist/GroupNameModal';

const PHASE_LABEL: Record<string, string> = { pre_open: '장전', open: '● 장중', closed: '장마감' };

export function Heatmap() {
  const { data, isLoading, error } = useWatchlist();
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const folders = useMemo(() => data?.folders ?? [], [data]);
  const codes = useMemo(() => entries.map((e) => e.code), [entries]);

  const { quoteByCode, phase, dataUpdatedAt } = useLiveQuoteOverlay(codes);
  const statusQ = useLiveStatus();
  const groups = useMemo(() => groupByFolder(folders, entries), [folders, entries]);
  const onPick = useJumpToLive();
  const sortMode = useHeatmapPrefsStore((s) => s.sortMode);
  const setSortMode = useHeatmapPrefsStore((s) => s.setSortMode);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const createFolderM = useCreateFolder();
  const reorderEntriesM = useReorderEntries();
  const onReorder = (folderId: string, orderedCodes: string[]) =>
    reorderEntriesM.mutate({ folderId, orderedCodes });

  const appendBatch = useSparklineStore((s) => s.appendBatch);
  const seriesByCode = useSparklineSeries();

  // 폴마다 전 종목 등락률을 누적 — phase==='open'에만. closed는 600s 하트비트로 동일
  // non-null change_pct를 재서빙하므로 null 필터로 못 막아 평탄점이 쌓인다
  // (spec §4 "closed: 신규 점 없음"). 결측(null)은 store가 carry-forward로 보존.
  // deps에 codes도 둬, watchlist가 quote보다 늦게 로드되는 갭(첫 폴 후 codes 도착)을 잡는다.
  // ref 가드로 같은 폴(dataUpdatedAt 불변) 중복 append 방지 → "폴당 1점" 유지(codes만 바뀐
  // 종목 추가는 다음 폴에 첫 점). filter 없이 전 codes를 넘겨 watchlist 잔존=보존·이탈=prune.
  const lastAppendedRef = useRef(0);
  useEffect(() => {
    if (phase !== 'open' || !dataUpdatedAt || codes.length === 0) return;
    if (dataUpdatedAt === lastAppendedRef.current) return;
    lastAppendedRef.current = dataUpdatedAt;
    const points = codes.map((code) => ({ code, value: quoteByCode.get(code)?.change_pct ?? null }));
    appendBatch(points, dataUpdatedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt, codes]);

  const scrollToFolder = (folderId: string) => {
    document.getElementById(`heatmap-folder-${folderId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const updated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('ko-KR') : '—';
  const visibleCount = visibleFolderGroups(groups)
    .reduce((n, g) => n + g.entries.length, 0);
  // eng-review Q4: 자격증명 없음/오프라인 배너는 /live 와 동일 신호 재사용(DRY).
  // watchlist_empty 는 아래 빈-상태가 처리하므로 여기선 kis_credentials_missing 만 뜬다.
  const banner = deriveBannerState({ status: statusQ.data ?? null, watchlistSize: entries.length });

  if (isLoading) return <div className="p-4 text-fg-dim">관심종목 불러오는 중…</div>;
  if (error) return <div className="p-4 text-error">관심종목을 불러오지 못했습니다.</div>;
  if (entries.length === 0) return <div className="p-4 text-fg-dim">관심종목이 없습니다.</div>;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="flex items-center gap-3 px-3 py-2 bg-bg-subtle border-b border-border-strong flex-none">
        <span className="text-md font-semibold text-fg">관심맵</span>
        {phase && <span className="text-xs font-mono text-fg-dim">{PHASE_LABEL[phase] ?? phase}</span>}
        <span className="text-xs font-mono text-fg-dimmer">{updated} 갱신 · {visibleCount}종목</span>
        <div className="flex-1" />
        <button className="text-xs px-2 py-1 rounded border border-border text-fg-dim hover:text-accent"
          onClick={() => setShowNewGroup(true)}>＋ 새 그룹</button>
        {/* 색 범례 (spec §8): 등락률 히트 농도 키. 라벨은 HEAT_SAT(포화점)에서 파생돼
            heat.ts 와 절대 어긋나지 않는다. 색은 --price-down(파랑·하락)↔--price-up(빨강·상승). */}
        <div className="flex items-center gap-1.5 text-xs font-mono text-fg-dimmer"
             aria-label={`색 범례 -${HEAT_SAT}% ~ +${HEAT_SAT}%`}>
          <span>-{HEAT_SAT}%</span>
          <span className="h-2 w-20 rounded-sm" style={{
            background: 'linear-gradient(90deg, rgba(37,99,235,0.42), rgba(37,99,235,0.10), transparent, rgba(220,38,38,0.10), rgba(220,38,38,0.42))',
          }} />
          <span>+{HEAT_SAT}%</span>
        </div>
        <div className="flex border border-border rounded overflow-hidden text-xs">
          <button
            className={sortMode === 'change' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
            onClick={() => setSortMode('change')}
          >등락률 ↓</button>
          <button
            className={sortMode === 'manual' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
            onClick={() => setSortMode('manual')}
          >수동</button>
        </div>
      </header>
      <LiveStateBanner primary={banner.primary} stack={banner.stack} />
      <div className="px-3 py-1 text-xs text-fg-dim flex-none">스파크라인 = 장중 추세</div>
      <SectorTempStrip groups={groups} quoteByCode={quoteByCode} onJump={scrollToFolder} />
      {showNewGroup && (
        <GroupNameModal
          title="새 그룹 만들기"
          submitLabel="만들기"
          busy={createFolderM.isPending}
          onSubmit={async (name) => { await createFolderM.mutateAsync(name); }}
          onClose={() => setShowNewGroup(false)}
        />
      )}
      <HeatmapBoard groups={groups} quoteByCode={quoteByCode} seriesByCode={seriesByCode}
        sortMode={sortMode} onPick={onPick} onReorder={onReorder} />
    </div>
  );
}
