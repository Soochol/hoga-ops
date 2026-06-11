import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WatchlistFolder, WatchlistEntry } from '../api/watchlist';
import type { LiveQuote } from '../api/liveQuotes';
import { HeatmapRow } from './HeatmapRow';
import { sortEntries, avgPct, heatBg, HEAT_CHIP_MAX_ALPHA, HEAT_HEADER_MAX_ALPHA, type SortMode } from './heat';
import { resolveDrag } from '../watchlist/dragHandlers';
import { FolderAddButton } from './FolderAddButton';

export interface HeatmapFolderProps {
  folder: WatchlistFolder;
  entries: WatchlistEntry[];
  quoteByCode: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string) => void;
  /** 그룹 내 드래그 재정렬을 커밋한다(manual 모드 전용). 페이지가 useReorderEntries 로
   *  주입 — 컴포넌트는 QueryClient 비의존(순수)으로 남는다. 미전달이면 드래그는 noop. */
  onReorder?: (folderId: string, orderedCodes: string[]) => void;
}

/** 폴더 블록: 헤더(폴더명 + 평균 등락률 칩) + 정렬된 행들. break-inside-avoid 로
 *  CSS multi-column 패킹 시 블록이 칼럼 경계에서 쪼개지지 않게 한다.
 *  manual(수동) 정렬 모드에선 행을 드래그해 그룹 내 순서를 바꾼다(폴더마다 독립
 *  DndContext — multicol 칼럼이 다른 폴더 간 cross-talk 을 구조적으로 차단하고,
 *  드래그가 "그룹 내"로 한정된다). change 모드는 매 폴링 라이브 재정렬이라 드래그가
 *  즉시 덮어쓰이므로 정적 행으로 렌더(드래그 비활성). */
export function HeatmapFolder({ folder, entries, quoteByCode, sortMode, onPick, onReorder }: HeatmapFolderProps) {
  // distance:5 — 클릭(차트 이동)과 드래그(재정렬)를 가르는 임계. drawer 와 동일 계약.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pctOf = (code: string): number | null => quoteByCode.get(code)?.change_pct ?? null;
  const sorted = sortEntries(entries, sortMode, pctOf);
  const avg = avgPct(entries, pctOf);
  const draggable = sortMode === 'manual' && !!onReorder;

  const onDragEnd = (ev: DragEndEvent) => {
    if (!ev.over) return;
    const r = resolveDrag(sorted, folder.id, String(ev.active.id), String(ev.over.id));
    if (r.kind === 'reorder') onReorder?.(r.folderId ?? folder.id, r.orderedCodes);
  };

  const rows = sorted.map((e) => {
    const q = quoteByCode.get(e.code);
    return draggable ? (
      <SortableHeatmapRow key={e.code} code={e.code} name={e.name}
        price={q?.price ?? null} pct={q?.change_pct ?? null} onPick={() => onPick(e.code)} />
    ) : (
      <HeatmapRow key={e.code} name={e.name} price={q?.price ?? null} pct={q?.change_pct ?? null}
        onClick={() => onPick(e.code)} ariaLabel={`${e.name} ${e.code} 차트 열기`}
        testId={`heatmap-row-${e.code}`} />
    );
  });

  return (
    <div className="break-inside-avoid bg-bg-card border border-border rounded mb-2 overflow-hidden">
      {/* 그룹 헤더 밴드 = bg-bg-subtle 위에 섹터 평균 등락률 기반 아주 옅은 히트 틴트를
          inset box-shadow 로 레이어(배경색을 약하게 더한다 — 카드 본문 대비 밴드를
          구분하고 섹터 온도를 일별). 결측/0% 면 틴트 없이 bg-bg-subtle 그대로. */}
      <div className="flex justify-between items-center gap-2 bg-bg-subtle px-2 py-1 border-b border-border-strong"
        style={avg !== null && avg !== 0
          ? { boxShadow: `inset 0 0 0 9999px ${heatBg(avg, HEAT_HEADER_MAX_ALPHA)}` }
          : undefined}>
        {/* 폴더(섹터)명 = 보드의 1차 앵커라 text-fg(밝게) — 기존 text-fg-dim 은 섹터명이
            뒤로 물러나 스캔이 어려웠다(가독성 개선). */}
        <span className="text-sm font-semibold text-fg truncate">{folder.name}</span>
        <span className="flex items-center gap-2 flex-none">
          {/* 평균 등락률을 행과 같은 히트 칩으로(흰 글자 + heatBg) — 섹터 온도를 일별하게
              하면서 "히트색은 칩에만" 설계를 그대로 따른다(헤더 배경 워시 아님). */}
          {avg !== null && (
            <span className="text-xs font-mono tabular-nums font-semibold text-white rounded px-1"
              style={{ background: heatBg(avg, HEAT_CHIP_MAX_ALPHA) }}>
              {avg > 0 ? '+' : ''}{avg.toFixed(1)}%
            </span>
          )}
          <FolderAddButton folderId={folder.id} />
        </span>
      </div>
      {draggable ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sorted.map((e) => e.code)} strategy={verticalListSortingStrategy}>
            {rows}
          </SortableContext>
        </DndContext>
      ) : rows}
    </div>
  );
}

/** manual 모드 행 래퍼 — useSortable 의 ref/transform/listeners 를 HeatmapRow 에 전달한다.
 *  drawer SortableQuoteRow 와 동일 패턴(행 전체가 드래그 표면, 핸들 없음). */
function SortableHeatmapRow(props: {
  code: string; name: string; price: number | null; pct: number | null; onPick: () => void;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: props.code });
  return (
    <HeatmapRow
      name={props.name}
      price={props.price}
      pct={props.pct}
      onClick={props.onPick}
      ariaLabel={`${props.name} ${props.code} 차트 열기`}
      testId={`heatmap-row-${props.code}`}
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition }}
      dragListeners={listeners}
      dragging={isDragging}
    />
  );
}
