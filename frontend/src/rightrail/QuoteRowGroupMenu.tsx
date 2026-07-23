import { useMemo, useState } from 'react';
import {
  useWatchlist,
  useAddMember,
  useRemoveMember,
  useCreateFolder,
  useRemoveFromWatchlist,
} from '../watchlist/useWatchlist';
import { useWatchlistMembership } from '../watchlist/useWatchlistMembership';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { CheckIcon } from '../ui/CheckIcon';
import { HeartIcon } from '../ui/HeartIcon';

/**
 * QuoteRow(우측 레일 공용 행) 우클릭 컨텍스트 메뉴 — 스크리너·순위 패널이 공유한다.
 * 행 우측 하트 버튼(스크리너에서 제거됨)을 대체하는 관심 그룹 편집 진입점으로,
 * HeatmapRowMenu 와 같은 메뉴 항목 리스트 관용구(role="menu", 커서 좌표 fixed +
 * 클램프/디스미스 유틸)를 따른다. 관심종목은 다중 소속(v3, ADR-0070)이라 각 그룹을
 * menuitemcheckbox 로 나열해 이미 속한 그룹은 체크, 클릭으로 토글한다. 멤버십 토글
 * 로직은 WatchlistGroupPicker 와 동일 훅(useAddMember/useRemoveMember/
 * useWatchlistMembership)을 재사용한다. 하단은 새 그룹 생성 + 전체 관심 해제.
 */
export function QuoteRowGroupMenu({ code, name, x, y, onClose }: {
  code: string;
  name: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);
  const { data } = useWatchlist();
  const { folderIdsOf } = useWatchlistMembership();
  const addM = useAddMember();
  const removeM = useRemoveMember();
  const createM = useCreateFolder();
  const removeAllM = useRemoveFromWatchlist();
  const [newName, setNewName] = useState('');
  const folders = useMemo(
    () => [...(data?.folders ?? [])].sort((a, b) => a.order - b.order), [data]);
  const member = folderIdsOf(code);
  const isMember = member.size > 0;

  const toggle = (folderId: string) => {
    if (member.has(folderId)) removeM.mutate({ folderId, code });
    else addM.mutate({ folderId, code, name });
  };
  const createAndAdd = async () => {
    const n = newName.trim();
    if (!n) return;
    const f = await createM.mutateAsync(n);
    addM.mutate({ folderId: f.id, code, name });
    setNewName('');
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${name} 관심 그룹`}
      data-testid="quote-row-group-menu"
      onContextMenu={(e) => e.preventDefault()}
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1 min-w-[200px]"
      style={{ position: 'fixed', left, top }}
    >
      <div className="px-3 py-1 text-xs text-fg-dimmer">관심 그룹에 추가</div>
      {folders.length === 0 && (
        <div className="px-3 py-1.5 text-sm text-fg-dimmer">그룹이 없습니다 — 아래에서 만드세요</div>
      )}
      {folders.map((f) => {
        const checked = member.has(f.id);
        return (
          <button
            key={f.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={checked}
            data-testid={`quote-menu-group-${f.id}`}
            onClick={() => toggle(f.id)}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
          >
            <span className="w-4 grid place-items-center"><CheckIcon filled={checked} size={16} /></span>
            <span className="truncate">{f.name}</span>
          </button>
        );
      })}
      <div className="mt-1 border-t border-border px-3 py-1.5 flex items-center gap-1">
        <span className="text-accent leading-none">＋</span>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') createAndAdd(); }}
          maxLength={40}
          placeholder="새 그룹 만들기"
          aria-label="새 그룹 만들기"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-fg-dimmer"
        />
      </div>
      {isMember && (
        <button
          type="button"
          role="menuitem"
          data-testid="quote-menu-remove-all"
          onClick={() => { removeAllM.mutate(code); onClose(); }}
          className="mt-1 w-full border-t border-border text-left px-3 py-1.5 pt-2 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
        >
          <span className="w-4 grid place-items-center"><HeartIcon filled className="w-[1em] h-[1em]" /></span>
          관심 해제
        </button>
      )}
    </div>
  );
}
