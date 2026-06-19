import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { HeatmapEntry, HeatmapFolder as HeatmapFolderModel } from '../api/heatmap';
import type { LiveQuote } from '../api/liveQuotes';
import { HeatmapRow } from './HeatmapRow';
import { sortEntries, avgPct, heatHeaderBg, makePctOf, type SortMode } from './heat';
import { resolveDrag } from '../watchlist/dragHandlers';
import { FolderAddButton } from './FolderAddButton';

/** 행 우클릭 메뉴 열기 — (이벤트, 코드, 이름, 이 행이 속한 폴더 id|null). */
export type RowMenuOpener = (
  e: React.MouseEvent, code: string, name: string, folderId: string | null,
) => void;

export interface HeatmapFolderProps {
  /** null = 미분류 그룹(ADR-0068 G3). 합성 폴더 객체가 아니라 render-only 그룹이다. */
  folder: HeatmapFolderModel | null;
  entries: HeatmapEntry[];
  quoteByCode: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string, name?: string) => void;
  /** 그룹 내 드래그 재정렬을 커밋한다(manual 모드 전용). folderId=null 이면 미분류 그룹.
   *  페이지가 useReorderHeatmapEntries 로 주입 — 컴포넌트는 QueryClient 비의존(순수). */
  onReorder?: (folderId: string | null, orderedCodes: string[]) => void;
  /** 행 우클릭 메뉴(삭제·폴더이동) 오프너. 미전달이면 메뉴 비활성. */
  onRowMenu?: RowMenuOpener;
  /** 행 드래그 시작/끝을 페이지로 전파(그룹순서 동결용, G1). manual 모드에서만 발화. */
  onRowDragState?: (dragging: boolean) => void;
}

/** 그룹 블록: 헤더(폴더명 또는 '미분류' + 평균 등락률 칩) + 정렬된 행들. break-inside-avoid
 *  로 CSS multi-column 패킹 시 블록이 칼럼 경계에서 쪼개지지 않게 한다.
 *  manual(수동) 정렬 모드에선 행을 드래그해 그룹 내 순서를 바꾼다(폴더마다 독립
 *  DndContext — multicol 칼럼이 다른 폴더 간 cross-talk 을 구조적으로 차단하고,
 *  드래그가 "그룹 내"로 한정된다). change 모드는 매 폴링 라이브 재정렬이라 드래그가
 *  즉시 덮어쓰이므로 정적 행으로 렌더(드래그 비활성).
 *  미분류 그룹(folder=null)은 폴더명 대신 '미분류'를 보이고 ＋종목(폴더 지정 추가)을
 *  숨긴다 — 미분류엔 지정할 폴더가 없기 때문(드로어와 동일 패턴). 삭제·다른 폴더로 이동은
 *  행 우클릭 메뉴로 가능. */
export function HeatmapFolder({ folder, entries, quoteByCode, sortMode, onPick, onReorder, onRowMenu, onRowDragState }: HeatmapFolderProps) {
  // distance:5 — 클릭(차트 이동)과 드래그(재정렬)를 가르는 임계. drawer 와 동일 계약.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const pctOf = makePctOf(quoteByCode);
  const sorted = sortEntries(entries, sortMode, pctOf);
  const avg = avgPct(entries, pctOf);
  const draggable = sortMode === 'manual' && !!onReorder;
  const folderId = folder?.id ?? null;

  const onDragEnd = (ev: DragEndEvent) => {
    if (!ev.over) return;
    const r = resolveDrag(sorted, folderId, String(ev.active.id), String(ev.over.id));
    if (r.kind === 'reorder') onReorder?.(r.folderId, r.orderedCodes);
  };

  const ctxFor = onRowMenu
    ? (code: string, name: string) => (e: React.MouseEvent) => onRowMenu(e, code, name, folderId)
    : undefined;

  const rows = sorted.map((e) => {
    const q = quoteByCode.get(e.code);
    return draggable ? (
      <SortableHeatmapRow key={e.code} code={e.code} name={e.name}
        price={q?.price ?? null} pct={q?.change_pct ?? null}
        open={q?.open ?? null} high={q?.high ?? null} low={q?.low ?? null}
        onPick={() => onPick(e.code, e.name)} onContextMenu={ctxFor?.(e.code, e.name)} />
    ) : (
      <HeatmapRow key={e.code} name={e.name} price={q?.price ?? null} pct={q?.change_pct ?? null}
        open={q?.open ?? null} high={q?.high ?? null} low={q?.low ?? null}
        onClick={() => onPick(e.code, e.name)} ariaLabel={`${e.name} ${e.code} 차트 열기`}
        testId={`heatmap-row-${e.code}`} onContextMenu={ctxFor?.(e.code, e.name)} />
    );
  });

  return (
    <div id={folderId ? `heatmap-folder-${folderId}` : undefined} className="break-inside-avoid border-l-2 border-border-strong mb-2 overflow-hidden">
      {/* 그룹 헤더 밴드 = heatHeaderBg(avg) — 평균 등락 비례 히트 틴트(섹터 온도). 미분류 포함
          무분기(가드 없음, G8): 미분류 avg 채색은 칩→밴드 정보 이동(회귀 아님). 폴더 본문은
          투명·평면이고 좌측 border-strong 스파인 + 이 틴트 밴드로 그룹을 구분한다. 평균 % 는
          평면 text-fg-dim 텍스트(색=밴드가 짊어짐, 숫자=보조; G4). */}
      <div className="flex justify-between items-center gap-2 px-2 py-1 border-b border-border-strong"
        style={{ background: heatHeaderBg(avg) }}>
        {/* 폴더(섹터)명 = 보드의 1차 앵커. 글자 크기 text-xs(가독성, origin/main).
            실폴더는 text-fg(밝게), 미분류는 한 단계 낮춰(text-fg-dim) 구분. */}
        <span className={`text-xs font-semibold truncate ${folder ? 'text-fg' : 'text-fg-dim'}`}>
          {folder?.name ?? '미분류'}
        </span>
        <span className="flex items-center gap-2 flex-none">
          {avg !== null && (
            <span className="text-xs font-mono tabular-nums text-fg-dim">
              {avg > 0 ? '+' : ''}{avg.toFixed(1)}%
            </span>
          )}
          {/* ＋종목(폴더 지정 추가)은 실폴더에만 — 미분류엔 지정할 폴더가 없다. */}
          {folder && <FolderAddButton folderId={folder.id} />}
        </span>
      </div>
      {draggable ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => onRowDragState?.(true)}
          onDragEnd={(ev) => { onDragEnd(ev); onRowDragState?.(false); }}
        >
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
  code: string; name: string; price: number | null; pct: number | null;
  open?: number | null; high?: number | null; low?: number | null; onPick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: props.code });
  return (
    <HeatmapRow
      name={props.name}
      price={props.price}
      pct={props.pct}
      open={props.open}
      high={props.high}
      low={props.low}
      onClick={props.onPick}
      ariaLabel={`${props.name} ${props.code} 차트 열기`}
      testId={`heatmap-row-${props.code}`}
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition }}
      dragListeners={listeners}
      dragging={isDragging}
      onContextMenu={props.onContextMenu}
    />
  );
}
