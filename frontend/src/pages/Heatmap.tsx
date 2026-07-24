import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { shouldIgnoreEvent } from '../util/keyboard';
import {
  useHeatmap, useCreateHeatmapFolder, useReorderHeatmapEntries,
  useRemoveFromHeatmap, useMoveHeatmapEntries,
} from '../heatmap/useHeatmap';
import { useLiveQuoteOverlay } from '../api/liveQuotes';
import { useJumpToLive } from '../live/useJumpToLive';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { useLiveVenueStore } from '../state/liveVenue';
import { HeatmapBoard } from '../heatmap/HeatmapBoard';
import { SectorTempStrip } from '../heatmap/SectorTempStrip';
import { HeatmapRowMenu } from '../heatmap/HeatmapRowMenu';
import { SortCycleButton } from '../heatmap/SortCycleButton';
import { HeatmapSearchInput } from '../heatmap/HeatmapSearchInput';
import { CollectDialog, SingleCodeCollectDialog } from '../heatmap/CollectDialog';
import { filterGroups, entryMatchesQuery } from '../heatmap/filterGroups';
import { avgPct, groupHeatmapEntries, orderFolderGroups, makePctOf, nextSort } from '../heatmap/heat';
import { useFrozenWhileDragging } from '../heatmap/useFrozenWhileDragging';
import { GroupNameModal } from '../watchlist/GroupNameModal';
import { PageContainer } from '../layout/PageContainer';
import { ControlBar, PageState, PanelCard, ToolbarButton } from '../ui/PageShell';

const PHASE_LABEL: Record<string, string> = { pre_open: '장전', open: '● 장중', closed: '장마감' };

type RowMenu = { x: number; y: number; code: string; name: string; folderId: string };

export function Heatmap() {
  // 독립 스토어(ADR-0068): useHeatmap(['heatmap']) — 관심종목(['watchlist'])과 분리.
  const { data, isLoading, error } = useHeatmap();
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const folders = useMemo(() => data?.folders ?? [], [data]);
  const codes = useMemo(() => entries.map((e) => e.code), [entries]);
  const venue = useLiveVenueStore((s) => s.venue);

  const { quoteByCode, phase, dataUpdatedAt } = useLiveQuoteOverlay(codes, venue);
  const groups = useMemo(() => groupHeatmapEntries(folders, entries), [folders, entries]);
  const onPick = useJumpToLive();
  const sortMode = useHeatmapPrefsStore((s) => s.sortMode);
  const setSortMode = useHeatmapPrefsStore((s) => s.setSortMode);
  const groupSort = useHeatmapPrefsStore((s) => s.groupSort);
  const setGroupSort = useHeatmapPrefsStore((s) => s.setGroupSort);
  // 그룹 순서 = orderFolderGroups(직교 축). groupSort≠manual 이면 quoteByCode 가 폴마다
  // 새 Map → 매 폴 라이브 재정렬. ⚠️ 이는 행 'change' 모드와 "동형"이 아니다(거짓 등가):
  // change 는 드래그를 끄지만 (manual행, desc그룹)은 드래그를 켠 채 그룹을 재배치한다
  // → 행 드래그 중 그룹 텔레포트 리스크(스펙 G1, 미검증 — 실측 후 동결 가드 조건부 추가).
  const liveOrderedGroups = useMemo(() => {
    const pctOf = makePctOf(quoteByCode);
    return orderFolderGroups(groups, groupSort, (g) => avgPct(g.entries, pctOf));
  }, [groups, groupSort, quoteByCode]);
  const [isRowDragging, setIsRowDragging] = useState(false);
  // G1: 행 드래그 중 그룹 순서 동결(텔레포트 방지), drag-end 에 최신 적용.
  const orderedGroups = useFrozenWhileDragging(liveOrderedGroups, isRowDragging);
  // 검색 필터(그룹간 정렬과 그룹내 정렬 사이 — 드로어와 동일 파이프라인). 동결된 orderedGroups
  // 뒤에 적용해 G1 텔레포트 가드를 보존. 빈 쿼리면 filterGroups 가 입력 참조 그대로 반환.
  const [query, setQuery] = useState('');
  const visibleGroups = useMemo(() => filterGroups(orderedGroups, query), [orderedGroups, query]);
  const isSearching = query.trim() !== '';
  // "/" 로 검색창에 바로 포커스 — /live 의 LiveSymbolSearch 와 같은 관례. 공유
  // shouldIgnoreEvent 가드가 이미 입력 필드(다른 input 포함)에 포커스가 있으면
  // 건너뛰므로, 검색 중에는 "/" 가 리터럴로 타이핑된다. 리스너는 이 페이지
  // 마운트 동안만 활성이라 다른 라우트에 영향이 없다.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || shouldIgnoreEvent(e.target)) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showCollect, setShowCollect] = useState(false);
  // 단일 종목 수집 스코프(행 메뉴 '지난 N일 수집'). null 이면 전체/그룹 다이얼로그.
  const [collectOne, setCollectOne] = useState<{ code: string; name: string } | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  // 수집 다이얼로그 스코프 — 각 그룹(폴더)의 코드 목록. 전체 히트맵/그룹 단위 선택.
  const collectScopes = useMemo(
    () => groups.map((g) => ({ id: g.folder.id, name: g.folder.name, codes: g.entries.map((e) => e.code) })),
    [groups],
  );
  const createFolderM = useCreateHeatmapFolder();
  const reorderEntriesM = useReorderHeatmapEntries();
  const removeM = useRemoveFromHeatmap();
  const moveM = useMoveHeatmapEntries();
  const onReorder = (folderId: string, orderedCodes: string[]) =>
    reorderEntriesM.mutate({ folderId, orderedCodes });
  // 행 우클릭 → 컨텍스트 메뉴(삭제·폴더이동, ADR-0068 G3). 분리 후 히트맵 편집의 단독 표면.
  const onRowMenu = (e: React.MouseEvent, code: string, name: string, folderId: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, code, name, folderId });
  };

  const scrollToFolder = (folderId: string) => {
    document.getElementById(`heatmap-folder-${folderId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const updated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('ko-KR') : '—';
  // 헤더 "N종목" 은 표시된 종목 수(검색 중엔 매칭 그룹의 전체 종목). 빈 실폴더는 0 기여.
  const visibleCount = visibleGroups.reduce((n, g) => n + g.entries.length, 0);
  // 검색 중 실제 매칭(하이라이트) 종목 수 — visibleCount(그룹 전체)와 구분해 헤더에
  // "N종목 중 M 매칭"으로 알린다. 그룹명만 매칭된 경우는 0(개별 종목 매칭 아님).
  const matchCount = useMemo(
    () => (isSearching
      ? visibleGroups.reduce(
          (n, g) => n + g.entries.filter((e) => entryMatchesQuery(e, query)).length, 0)
      : 0),
    [visibleGroups, query, isSearching],
  );
  if (isLoading) return <HeatmapStateShell>히트맵 불러오는 중…</HeatmapStateShell>;
  if (error) return <HeatmapStateShell tone="error">히트맵을 불러오지 못했습니다.</HeatmapStateShell>;
  // 그룹이 하나라도 있으면 일반 페이지를 렌더 — v3 는 그룹이 있어야 종목을 추가할 수
  // 있으므로(ADR-0112), "그룹만 있고 종목 0" 상태에서 ＋새 그룹·툴바가 막히면 안 된다.
  if (entries.length === 0 && folders.length === 0) {
    return <HeatmapStateShell>히트맵이 비어 있습니다.</HeatmapStateShell>;
  }

  return (
    <PageContainer className="min-h-0 !pb-0">
      <PanelCard borderless flat data-testid="heatmap-page-primary" className="flex h-full min-h-0 flex-col overflow-hidden">
        {/* 헤더·섹터 스트립 배경은 카드 본문과 동일한 --bg(회색 바닥색) — flat 통일
            (2026-07-23). 이전 bg-card(흰 밴드)를 걷어내 상단이 바닥에 녹아든다.
            구분선 없음(border-b 제거): 분리는 간격이 담당. */}
        <header className="flex items-center gap-3 px-3 py-2 bg-bg flex-none">
          <span className="text-md font-semibold text-fg">히트맵</span>
          {phase && <span className="text-xs font-data text-fg-dim">{PHASE_LABEL[phase] ?? phase}</span>}
          <span className="text-xs font-data text-fg-dimmer">
            {updated} 갱신 · {isSearching && matchCount > 0
              ? `${visibleCount}종목 중 ${matchCount} 매칭`
              : `${visibleCount}종목`}
          </span>
          <div className="flex-1" />
          <ControlBar className="gap-sm">
            <ToolbarButton className="text-xs px-2 py-1 rounded" onClick={() => setShowNewGroup(true)}>
              ＋ 새 그룹
            </ToolbarButton>
            <ToolbarButton className="text-xs px-2 py-1 rounded" onClick={() => setShowCollect(true)}
              disabled={collectScopes.length === 0}>
              ⬇ 데이터 수집
            </ToolbarButton>
            <HeatmapSearchInput query={query} onQuery={setQuery} inputRef={searchRef} testId="heatmap-search" className="w-44" />
            {/* 정렬 = 우측 레일 드로어와 공유하는 아이콘 순환 버튼(manual→desc→asc). 종목=그룹 내
                순서, 그룹=폴더 순서(직교 축). 라벨이 정렬 키(등락률)의 축을 알린다. */}
            <SortCycleButton label="종목" mode={sortMode} onCycle={() => setSortMode(nextSort(sortMode))} />
            <SortCycleButton label="그룹" mode={groupSort} onCycle={() => setGroupSort(nextSort(groupSort))} />
          </ControlBar>
        </header>
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
        {showCollect && (
          <CollectDialog groups={collectScopes} onClose={() => setShowCollect(false)} />
        )}
        {collectOne && (
          <SingleCodeCollectDialog
            code={collectOne.code}
            name={collectOne.name}
            onClose={() => setCollectOne(null)}
          />
        )}
        {/* 검색 중엔 재정렬 비활성(onReorder=undefined): 그룹 전체를 보여줘도 검색 중
            드래그 재정렬은 매칭 탐색 흐름을 방해하고, 그룹 간 정렬(orderedGroups)이
            검색 결과를 추종해 순서 기준이 흔들린다. query 는 매칭 행 하이라이트용. */}
        <HeatmapBoard groups={visibleGroups} quoteByCode={quoteByCode}
          sortMode={sortMode} onPick={onPick}
          onReorder={isSearching ? undefined : onReorder} onRowMenu={onRowMenu}
          onRowDragState={setIsRowDragging} query={query} />
        {menu && (
          <HeatmapRowMenu
            x={menu.x} y={menu.y} name={menu.name}
            folders={folders}
            currentFolderId={menu.folderId}
            onRemove={() => removeM.mutate(menu.code)}
            onMove={(folderId) => moveM.mutate({ codes: [menu.code], folderId })}
            onCollect={() => setCollectOne({ code: menu.code, name: menu.name })}
            onClose={() => setMenu(null)}
          />
        )}
      </PanelCard>
    </PageContainer>
  );
}

function HeatmapStateShell({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'error' }) {
  return (
    <PageContainer className="min-h-0 !pb-0">
      <PanelCard borderless flat data-testid="heatmap-page-primary">
        <PageState tone={tone}>{children}</PageState>
      </PanelCard>
    </PageContainer>
  );
}
