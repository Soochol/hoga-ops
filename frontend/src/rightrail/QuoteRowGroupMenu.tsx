import { useRemoveFromWatchlist } from '../watchlist/useWatchlist';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
import { WatchlistGroupPickerContent } from '../watchlist/WatchlistGroupPicker';
import { WatchlistGroupPopover } from '../watchlist/WatchlistGroupPopover';
import { HeartIcon } from '../ui/HeartIcon';

/** 우측 패널 종목 행의 관심 그룹 메뉴. 그룹 선택은 차트 하트와 공유하고,
 *  삽입·수집 등 호출처별 작업과 전체 관심 해제는 메뉴 하단에 조립한다. */
export function QuoteRowGroupMenu({ code, name, x, y, onClose, children, beforeRemove, testId = 'quote-row-group-menu' }: {
  code: string;
  name: string;
  x: number;
  y: number;
  onClose: () => void;
  children?: React.ReactNode;
  beforeRemove?: React.ReactNode;
  testId?: string;
}) {
  const { folderIdsOf } = useWatchlistMembership();
  const removeAllM = useRemoveFromWatchlist();
  const isMember = folderIdsOf(code).size > 0;

  return (
    <WatchlistGroupPopover x={x} y={y} role="menu" label={`${name} 관심 그룹`}
      testId={testId} onClose={onClose}>
      <WatchlistGroupPickerContent key={code} code={code} name={name} selectionRole="menuitemcheckbox" />
      {beforeRemove}
      {isMember && (
        <button type="button" role="menuitem" data-testid="quote-menu-remove-all"
          disabled={removeAllM.isPending}
          onClick={() => { removeAllM.mutate(code); onClose(); }}
          className="mt-1 flex w-full shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg disabled:opacity-50">
          <span className="grid w-4 shrink-0 place-items-center"><HeartIcon filled className="h-[1em] w-[1em]" /></span>
          관심 해제
        </button>
      )}
      {children}
    </WatchlistGroupPopover>
  );
}
