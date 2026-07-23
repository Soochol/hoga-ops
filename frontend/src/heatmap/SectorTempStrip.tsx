import type { LiveQuote } from '../api/liveQuotes';
import type { HeatmapFolder } from '../api/heatmap';
import { avgPct, heatBg, makePctOf, type HeatmapGroup } from './heat';
import { visibleFolderGroups } from './visibleGroups';

/** 스트립 칩 배경 농도(작은 칩이라 행 칩보다 옅게, 헤더 밴드보단 진하게). */
const STRIP_ALPHA = 0.55;

export interface SectorTempStripProps {
  groups: HeatmapGroup[];
  quoteByCode: Map<string, LiveQuote>;
  /** 칩 클릭 시 호출(해당 섹터 카드로 스크롤). */
  onJump: (folderId: string) => void;
}

/** 가시 섹터의 평균 등락칩을 한 줄(wrap)로 — 시장 온도 한눈 스캔.
 *  정렬은 **뜨거운 순(avg 내림차순) · 표시 전용**이며 카드 본문 sortMode/order를
 *  바꾸지 않는다(spec invariant: 정렬 계약 보존). 빈 폴더·avg 결측 섹터는 제외. */
export function SectorTempStrip({ groups, quoteByCode, onJump }: SectorTempStripProps) {
  const pctOf = makePctOf(quoteByCode);
  const chips = visibleFolderGroups(groups)
    .map((g) => ({ folder: g.folder, avg: avgPct(g.entries, pctOf) }))
    .filter((c): c is { folder: HeatmapFolder; avg: number } => c.avg !== null)
    .sort((a, b) => b.avg - a.avg);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-2 py-1.5 bg-bg flex-none"
      aria-label="섹터 온도">
      {/* 칩 = 점프 버튼. role="list/listitem"을 button에 얹지 않는다(role 충돌) —
          접근성은 각 버튼의 aria-label(섹터명+평균)로 충분하고, 테스트는 role 'button'으로 쿼리. */}
      {chips.map(({ folder, avg }) => (
        <button
          key={folder.id}
          type="button"
          onClick={() => onJump(folder.id)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-dim hover:text-fg outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
          style={{ background: heatBg(avg, STRIP_ALPHA) }}
          aria-label={`${folder.name} 평균 ${avg > 0 ? '+' : ''}${avg.toFixed(1)}% — 카드로 이동`}
        >
          <span className="truncate max-w-[7rem]">{folder.name}</span>
          <span className="font-data tabular-nums">{avg > 0 ? '+' : ''}{avg.toFixed(1)}%</span>
        </button>
      ))}
    </div>
  );
}
