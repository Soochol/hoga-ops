import { useMemo, useState } from 'react';
import { useWatchlist } from '../watchlist/useWatchlist';
import { groupByFolder } from '../watchlist/grouping';
import { useQuotes, type LiveQuote } from '../api/liveQuotes';
import { useLiveStatus } from '../api/liveStatus';
import { deriveBannerState } from '../live/useLiveBannerState';
import { LiveStateBanner } from '../live/LiveStateBanner';
import { useJumpToLive } from '../live/useJumpToLive';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { HeatmapBoard, visibleFolderGroups } from '../heatmap/HeatmapBoard';
import { useCreateFolder } from '../watchlist/useWatchlist';
import { GroupNameModal } from '../watchlist/GroupNameModal';

const PHASE_LABEL: Record<string, string> = { pre_open: '장전', open: '● 장중', closed: '장마감' };

export function Heatmap() {
  const { data, isLoading, error } = useWatchlist();
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const folders = useMemo(() => data?.folders ?? [], [data]);
  const codes = useMemo(() => entries.map((e) => e.code), [entries]);

  const quotesQ = useQuotes(codes);
  const statusQ = useLiveStatus();
  const quoteByCode = useMemo(
    () => new Map<string, LiveQuote>((quotesQ.data?.quotes ?? []).map((q) => [q.code, q])),
    [quotesQ.data],
  );
  const groups = useMemo(() => groupByFolder(folders, entries), [folders, entries]);
  const onPick = useJumpToLive();
  const sortMode = useHeatmapPrefsStore((s) => s.sortMode);
  const setSortMode = useHeatmapPrefsStore((s) => s.setSortMode);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const createFolderM = useCreateFolder();

  const phase = quotesQ.data?.phase;
  const updated = quotesQ.dataUpdatedAt
    ? new Date(quotesQ.dataUpdatedAt).toLocaleTimeString('ko-KR') : '—';
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
      {showNewGroup && (
        <GroupNameModal
          title="새 그룹 만들기"
          submitLabel="만들기"
          busy={createFolderM.isPending}
          onSubmit={async (name) => { await createFolderM.mutateAsync(name); }}
          onClose={() => setShowNewGroup(false)}
        />
      )}
      <HeatmapBoard groups={groups} quoteByCode={quoteByCode} sortMode={sortMode} onPick={onPick} />
    </div>
  );
}
