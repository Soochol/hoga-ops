import type { WatchlistFolder, WatchlistEntry } from '../api/watchlist';
import type { LiveQuote } from '../api/liveQuotes';
import { HeatmapRow } from './HeatmapRow';
import { sortEntries, avgPct, type SortMode } from './heat';
import { priceDirClass } from '../ui/priceDir';
import { FolderAddButton } from './FolderAddButton';

export interface HeatmapFolderProps {
  folder: WatchlistFolder;
  entries: WatchlistEntry[];
  quoteByCode: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string) => void;
}

/** 폴더 블록: 헤더(폴더명 + 평균 등락률) + 정렬된 행들. break-inside-avoid 로
 *  CSS multi-column 패킹 시 블록이 칼럼 경계에서 쪼개지지 않게 한다. */
export function HeatmapFolder({ folder, entries, quoteByCode, sortMode, onPick }: HeatmapFolderProps) {
  const pctOf = (code: string): number | null => quoteByCode.get(code)?.change_pct ?? null;
  const sorted = sortEntries(entries, sortMode, pctOf);
  const avg = avgPct(entries, pctOf);
  return (
    <div className="break-inside-avoid bg-bg-card border border-border rounded mb-2 overflow-hidden">
      <div className="flex justify-between items-center bg-bg-subtle px-2 py-1 border-b border-border-strong">
        <span className="text-sm font-semibold text-fg-dim truncate">{folder.name}</span>
        <span className="flex items-center gap-2">
          {avg !== null && (
            <span className={`text-xs font-mono tabular-nums ${priceDirClass(avg)}`}>
              {avg > 0 ? '+' : ''}{avg.toFixed(1)}%
            </span>
          )}
          <FolderAddButton folderId={folder.id} />
        </span>
      </div>
      {sorted.map((e) => {
        const q = quoteByCode.get(e.code);
        return (
          <HeatmapRow
            key={e.code}
            name={e.name}
            price={q?.price ?? null}
            pct={q?.change_pct ?? null}
            changeWon={q?.change_won ?? null}
            onClick={() => onPick(e.code)}
            ariaLabel={`${e.name} ${e.code} 차트 열기`}
            testId={`heatmap-row-${e.code}`}
          />
        );
      })}
    </div>
  );
}
