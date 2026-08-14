import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWatchlist, useAddMember, useRemoveMember, useCreateFolder } from './useWatchlist';
import { useWatchlistMembership } from './useWatchlistMembership';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { CheckIcon } from '../ui/CheckIcon';

/**
 * 단일 멤버십 primitive (v3, ADR-0070). code의 그룹 소속을 체크박스로 토글 + 새 그룹
 * 생성. "미분류" 단일 추가 대상이 없어진 v3에서 모든 하트(스크리너 페이지·패널·라이브
 * 상태바·라이브 검색·편집모달·`/live` 차트 창 헤더)와 드로어 행 메뉴 "그룹 편집"이 이
 * 컴포넌트를 연다. 호출처는
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

  // `document.body` 로 portal — 호출처가 `contain` 을 건 조상 안에 있어도 좌표계가
  // 뷰포트로 유지된다. `/live` 차트 창 카드가 `contain: layout paint` + `overflow-hidden`
  // 이라 그 안에서 직접 렌더하면 **카드가 fixed 의 containing block 이 되어** 위치가
  // 창 기준으로 어긋나고, 카드 밖으로 나가는 부분은 잘린다(피커 min-w 200px vs 창
  // MIN_W 160px → 확정적). 같은 카드 안의 DrawingMenu·TimeframeControl 이 먼저 쓰던
  // 처방이다. React 트리는 그대로라 이벤트 버블링 의미는 변하지 않는다 —
  // useDismissablePopover 의 `ref.contains` 판정도 실제 DOM 노드를 보므로 그대로 산다.
  return createPortal((
    <div ref={ref} role="menu" aria-label="내 관심 그룹"
      data-testid="watchlist-group-picker"
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1 min-w-[200px]"
      style={{ position: 'fixed', left, top }}>
      <div className="px-3 py-1 text-xs text-fg-dim">내 관심 그룹</div>
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
          className="flex-1 bg-transparent text-sm outline-none focus-visible:outline-none placeholder:text-fg-dimmer" />
      </div>
    </div>
  ), document.body);
}
