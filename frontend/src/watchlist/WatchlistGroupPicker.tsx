import { useMemo, useState } from 'react';
import { useWatchlist, useAddMember, useRemoveMember, useCreateFolder } from './useWatchlist';
import { useWatchlistMembership } from './useWatchlistMembership';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { CheckIcon } from '../ui/CheckIcon';

/**
 * 단일 멤버십 primitive (v3, ADR-0070). code의 그룹 소속을 체크박스로 토글 + 새 그룹
 * 생성. "미분류" 단일 추가 대상이 없어진 v3에서 모든 하트(스크리너 페이지·패널·라이브
 * 상태바·라이브 검색·편집모달)와 드로어 행 메뉴 "그룹 편집"이 이 컴포넌트를 연다. 호출처는
 * 앵커 (x,y)만 넘기고, 위치 클램프·디스미스·멤버십 토글은 이 컴포넌트가 책임진다.
 */
export function WatchlistGroupPicker({ code, name, x, y, onClose }: {
  code: string;
  name?: string;            // 스크리너 등 watchlist 밖 종목의 이름(낙관적 entry 시드용)
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
  const [newName, setNewName] = useState('');
  const folders = useMemo(
    () => [...(data?.folders ?? [])].sort((a, b) => a.order - b.order), [data]);
  const member = folderIdsOf(code);
  // 종목명: 호출처가 준 name > view에서 첫 등장 행 > code 폴백.
  const displayName = name ?? data?.entries.find((e) => e.code === code)?.name ?? code;

  const toggle = (folderId: string) => {
    if (member.has(folderId)) removeM.mutate({ folderId, code });
    else addM.mutate({ folderId, code, name: displayName });
  };
  const createAndAdd = async () => {
    const n = newName.trim();
    if (!n) return;
    const f = await createM.mutateAsync(n);
    addM.mutate({ folderId: f.id, code, name: displayName });
    setNewName('');
  };

  return (
    <div ref={ref} role="menu" aria-label="내 관심 그룹"
      data-testid="watchlist-group-picker"
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1 min-w-[200px]"
      style={{ position: 'fixed', left, top }}>
      <div className="px-3 py-1 text-xs text-fg-dimmer">내 관심 그룹</div>
      {folders.map((f) => {
        const checked = member.has(f.id);
        return (
          <button key={f.id} type="button" role="menuitemcheckbox" aria-checked={checked}
            onClick={() => toggle(f.id)}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2">
            <span className="w-4 grid place-items-center"><CheckIcon filled={checked} size={16} /></span>
            <span className="truncate">{f.name}</span>
          </button>
        );
      })}
      <div className="mt-1 border-t border-border px-3 py-1.5 flex items-center gap-1">
        <span className="text-accent leading-none">＋</span>
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') createAndAdd(); }}
          maxLength={40} placeholder="새 그룹 만들기" aria-label="새 그룹 만들기"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-fg-dimmer" />
      </div>
    </div>
  );
}
