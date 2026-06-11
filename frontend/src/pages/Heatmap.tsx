import { useMemo, useState } from 'react';
import {
  useHeatmap, useCreateHeatmapFolder, useReorderHeatmapEntries,
  useRemoveFromHeatmap, useMoveHeatmapEntries,
} from '../heatmap/useHeatmap';
import { groupByFolder } from '../watchlist/grouping';
import { useLiveQuoteOverlay } from '../api/liveQuotes';
import { useLiveStatus } from '../api/liveStatus';
import { deriveBannerState } from '../live/useLiveBannerState';
import { LiveStateBanner } from '../live/LiveStateBanner';
import { useJumpToLive } from '../live/useJumpToLive';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { HeatmapBoard } from '../heatmap/HeatmapBoard';
import { HeatmapRowMenu } from '../heatmap/HeatmapRowMenu';
import { visibleFolderGroups } from '../heatmap/visibleGroups';
import { HEAT_SAT } from '../heatmap/heat';
import { GroupNameModal } from '../watchlist/GroupNameModal';

const PHASE_LABEL: Record<string, string> = { pre_open: '장전', open: '● 장중', closed: '장마감' };

type RowMenu = { x: number; y: number; code: string; name: string; folderId: string | null };

export function Heatmap() {
  // 독립 스토어(ADR-0068): useHeatmap(['heatmap']) — 관심종목(['watchlist'])과 분리.
  const { data, isLoading, error } = useHeatmap();
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
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const createFolderM = useCreateHeatmapFolder();
  const reorderEntriesM = useReorderHeatmapEntries();
  const removeM = useRemoveFromHeatmap();
  const moveM = useMoveHeatmapEntries();
  const onReorder = (folderId: string | null, orderedCodes: string[]) =>
    reorderEntriesM.mutate({ folderId, orderedCodes });
  // 행 우클릭 → 컨텍스트 메뉴(삭제·폴더이동, ADR-0068 G3). 분리 후 히트맵 편집의 단독 표면.
  const onRowMenu = (e: React.MouseEvent, code: string, name: string, folderId: string | null) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, code, name, folderId });
  };

  const updated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('ko-KR') : '—';
  const visibleCount = visibleFolderGroups(groups)
    .reduce((n, g) => n + g.entries.length, 0);
  // eng-review Q4: 자격증명 없음/오프라인 배너는 /live 와 동일 신호 재사용(DRY).
  // 빈 히트맵은 아래 빈-상태가 처리하므로 여기선 kis_credentials_missing 만 뜬다.
  const banner = deriveBannerState({ status: statusQ.data ?? null, watchlistSize: entries.length });

  if (isLoading) return <div className="p-4 text-fg-dim">히트맵 불러오는 중…</div>;
  if (error) return <div className="p-4 text-error">히트맵을 불러오지 못했습니다.</div>;
  if (entries.length === 0) return <div className="p-4 text-fg-dim">히트맵이 비어 있습니다.</div>;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="flex items-center gap-3 px-3 py-2 bg-bg-subtle border-b border-border-strong flex-none">
        <span className="text-md font-semibold text-fg">히트맵</span>
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
      {showNewGroup && (
        <GroupNameModal
          title="새 그룹 만들기"
          submitLabel="만들기"
          busy={createFolderM.isPending}
          onSubmit={async (name) => { await createFolderM.mutateAsync(name); }}
          onClose={() => setShowNewGroup(false)}
        />
      )}
      <HeatmapBoard groups={groups} quoteByCode={quoteByCode} sortMode={sortMode}
        onPick={onPick} onReorder={onReorder} onRowMenu={onRowMenu} />
      {menu && (
        <HeatmapRowMenu
          x={menu.x} y={menu.y} name={menu.name}
          folders={folders}
          currentFolderId={menu.folderId}
          onRemove={() => removeM.mutate(menu.code)}
          onMove={(folderId) => moveM.mutate({ codes: [menu.code], folderId })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
