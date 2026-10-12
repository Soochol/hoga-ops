import { useRef, useState } from 'react';
import { HeartIcon } from '../../ui/HeartIcon';
import { WatchlistGroupPicker } from '../../watchlist/WatchlistGroupPicker';

/** Window-local stock action. The parent keys this by code, so a symbol switch
 * closes the picker instead of changing the target of an already open dialog. */
export function TitleBarWatchlistButton({ code, name, groups, ready }: {
  code: string;
  name: string | null;
  groups: readonly string[];
  ready: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const label = name ?? code;
  const member = groups.length > 0;
  const action = !ready ? '관심 그룹 확인' : member ? `관심 그룹 관리 · ${groups.length}개 그룹` : '관심종목 추가';
  const close = () => {
    setPicker(null);
    anchor.current?.focus();
  };

  return <>
    <button ref={anchor} type="button" data-testid="titlebar-watchlist-button"
      aria-label={`${label} ${action}`} aria-haspopup="dialog" aria-expanded={picker !== null}
      aria-busy={!ready}
      title={!ready ? `${label} 관심 그룹 확인` : member
        ? `${label} 관심 등록됨 · ${groups.join(', ')} — 그룹 관리`
        : `${label} 관심종목에 추가`}
      className={`live-watchlist-heart inline-flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-sm px-1 hover:bg-tint-selection ${member ? 'text-fg' : 'text-fg-dim hover:text-fg'}`}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setPicker(picker ? null : { x: rect.left, y: rect.bottom + 4 });
      }}>
      <HeartIcon filled={member} className="h-3 w-3" />
      {member && <span className="live-watchlist-group-count font-data text-xs" aria-hidden="true">{groups.length}</span>}
    </button>
    {picker && <WatchlistGroupPicker code={code} name={name ?? undefined}
      x={picker.x} y={picker.y} anchorRef={anchor} onClose={close} />}
  </>;
}
