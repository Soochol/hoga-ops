import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { WatchlistGroupPopover } from '../watchlist/WatchlistGroupPopover';
import { WatchlistGroupPickerContent } from '../watchlist/WatchlistGroupPickerContent';
import { HeatmapGroupPickerContent } from '../heatmap/HeatmapGroupPicker';
import { useWatchlist } from '../watchlist/useWatchlist';
import { useHeatmap } from '../heatmap/useHeatmap';
import { HeartIcon } from '../ui/HeartIcon';
import { HeatmapIcon } from '../ui/HeatmapIcon';
import { isNonDomesticStockCode } from '../live/liveInstrument';

type Target = 'watchlist' | 'heatmap';

/** Hearts and row menus share the same immediate, independent memberships. */
export function StockGroupPicker({ code, name, x, y, onClose, anchorRef }: {
  code: string; name?: string; x: number; y: number; onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  return <WatchlistGroupPopover x={x} y={y} role="dialog" label="종목 등록 그룹"
    testId="watchlist-group-picker" onClose={onClose} anchorRef={anchorRef}>
    <StockGroupPickerContent key={code} code={code} name={name} />
  </WatchlistGroupPopover>;
}

export function StockGroupPickerContent({ code, name, selectionRole = 'checkbox', children }: {
  code: string; name?: string; selectionRole?: 'checkbox' | 'menuitemcheckbox';
  children?: (target: Target) => ReactNode;
}) {
  const id = useId();
  const [target, setTarget] = useState<Target>('watchlist');
  const watchTab = useRef<HTMLButtonElement>(null);
  const heatTab = useRef<HTMLButtonElement>(null);
  const { data: watchlist } = useWatchlist();
  const { data: heatmap } = useHeatmap();
  const heatmapSupported = !isNonDomesticStockCode(code);
  const watchCount = watchlist ? new Set(watchlist.entries.filter(entry => entry.code === code).map(entry => entry.folder_id)).size : null;
  const heatCount = heatmap ? new Set(heatmap.entries.filter(entry => entry.code === code).map(entry => entry.folder_id)).size : null;

  return <>
    <div role="tablist" aria-label="등록할 목록" className="flex shrink-0 gap-1 border-b border-border px-1"
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !heatmapSupported) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'watchlist' : event.key === 'End' ? 'heatmap'
          : target === 'watchlist' ? 'heatmap' : 'watchlist';
        setTarget(next);
        (next === 'watchlist' ? watchTab : heatTab).current?.focus();
      }}>
      {(['watchlist', 'heatmap'] as const).map(kind => {
        const count = kind === 'watchlist' ? watchCount : heatCount;
        const label = kind === 'watchlist' ? '관심종목' : '히트맵';
        return <button key={kind} ref={kind === 'watchlist' ? watchTab : heatTab} type="button" role="tab"
          id={`${id}-${kind}-tab`} aria-controls={`${id}-${kind}-panel`} aria-selected={target === kind}
          aria-label={label} tabIndex={target === kind ? 0 : -1}
          disabled={kind === 'heatmap' && !heatmapSupported}
          data-tooltip={kind === 'heatmap' && !heatmapSupported ? '히트맵은 국내 종목만 지원합니다' : undefined}
          onClick={() => setTarget(kind)}
          className={`flex min-h-9 flex-1 items-center justify-center gap-1 border-b-2 px-2 py-2 text-sm focus-visible:outline-accent disabled:opacity-40 ${target === kind ? 'border-accent text-accent' : 'border-transparent text-fg-dim hover:bg-bg-input-hover hover:text-fg'}`}>
          {kind === 'watchlist' ? <HeartIcon filled={(count ?? 0) > 0} /> : <HeatmapIcon filled={(count ?? 0) > 0} />}
          {label}<span className="font-data text-xs" aria-hidden="true">{kind === 'heatmap' && !heatmapSupported ? '—' : count ?? '…'}</span>
        </button>;
      })}
    </div>
    {/* Preserve each list's pending writes, feedback and undo while switching tabs. */}
    <div id={`${id}-watchlist-panel`} role="tabpanel" aria-labelledby={`${id}-watchlist-tab`}
      hidden={target !== 'watchlist'}
      className={target === 'watchlist' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <WatchlistGroupPickerContent code={code} name={name} selectionRole={selectionRole} />
    </div>
    <div id={`${id}-heatmap-panel`} role="tabpanel" aria-labelledby={`${id}-heatmap-tab`}
      hidden={target !== 'heatmap'}
      className={target === 'heatmap' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {heatmapSupported && <HeatmapGroupPickerContent code={code} name={name ?? null} selectionRole={selectionRole} />}
    </div>
    {children?.(target)}
  </>;
}
