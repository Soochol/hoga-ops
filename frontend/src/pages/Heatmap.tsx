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
import { SectorTempStrip } from '../heatmap/SectorTempStrip';
import { HeatmapRowMenu } from '../heatmap/HeatmapRowMenu';
import { visibleFolderGroups } from '../heatmap/visibleGroups';
import { avgPct, orderFolderGroups } from '../heatmap/heat';
import { GroupNameModal } from '../watchlist/GroupNameModal';

const PHASE_LABEL: Record<string, string> = { pre_open: '장전', open: '● 장중', closed: '장마감' };
const segBtn = (active: boolean) =>
  active ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim';

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
  const groupSort = useHeatmapPrefsStore((s) => s.groupSort);
  const setGroupSort = useHeatmapPrefsStore((s) => s.setGroupSort);
  // 그룹 순서 = orderFolderGroups(직교 축). groupSort≠manual 이면 quoteByCode 가 폴마다
  // 새 Map → 매 폴 라이브 재정렬. ⚠️ 이는 행 'change' 모드와 "동형"이 아니다(거짓 등가):
  // change 는 드래그를 끄지만 (manual행, desc그룹)은 드래그를 켠 채 그룹을 재배치한다
  // → 행 드래그 중 그룹 텔레포트 리스크(스펙 G1, 미검증 — 실측 후 동결 가드 조건부 추가).
  const orderedGroups = useMemo(() => {
    const pctOf = (code: string): number | null => quoteByCode.get(code)?.change_pct ?? null;
    return orderFolderGroups(groups, groupSort, (g) => avgPct(g.entries, pctOf));
  }, [groups, groupSort, quoteByCode]);
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

  const scrollToFolder = (folderId: string) => {
    document.getElementById(`heatmap-folder-${folderId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        {/* 행 정렬(그룹 내 종목 순서). 스코프어 '행'은 버튼 밖 span — 버튼 accessible name 보존. */}
        <span className="flex items-center gap-1 text-xs">
          <span className="text-fg-dim">행</span>
          <span className="flex border border-border rounded overflow-hidden">
            <button
              className={segBtn(sortMode === 'change')}
              onClick={() => setSortMode('change')}
            >등락률 ↓</button>
            <button
              className={segBtn(sortMode === 'manual')}
              onClick={() => setSortMode('manual')}
            >수동</button>
          </span>
        </span>
        {/* 그룹 정렬(폴더 순서) — 행 정렬과 직교. 버튼 의미는 aria-label(visible '등락률 ↓' 가 행과 겹침). */}
        <span className="flex items-center gap-1 text-xs">
          <span className="text-fg-dim">그룹</span>
          <span className="flex border border-border rounded overflow-hidden">
            <button
              aria-label="그룹을 평균 등락률 높은 순으로"
              className={segBtn(groupSort === 'desc')}
              onClick={() => setGroupSort('desc')}
            >등락률 ↓</button>
            <button
              aria-label="그룹을 평균 등락률 낮은 순으로"
              className={segBtn(groupSort === 'asc')}
              onClick={() => setGroupSort('asc')}
            >등락률 ↑</button>
            <button
              aria-label="그룹 수동 순서"
              className={segBtn(groupSort === 'manual')}
              onClick={() => setGroupSort('manual')}
            >수동</button>
          </span>
        </span>
      </header>
      <LiveStateBanner primary={banner.primary} stack={banner.stack} />
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
      <HeatmapBoard groups={orderedGroups} quoteByCode={quoteByCode}
        sortMode={sortMode} onPick={onPick} onReorder={onReorder} onRowMenu={onRowMenu} />
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
