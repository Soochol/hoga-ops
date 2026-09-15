import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWatchlist, useAddMember, useRemoveMember, useCreateFolder } from './useWatchlist';
import { useWatchlistMembership } from './useWatchlistMembership';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';

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
  // Register the portal as a nested layer so its clicks do not dismiss a
  // containing symbol search before the menu can handle them.
  useDismissablePopover(true, ref, onClose, ref);
  return createPortal((
    <div ref={ref} role="dialog" aria-label="내 관심 그룹"
      data-testid="watchlist-group-picker"
      className="bg-bg-card border border-border rounded shadow-lg z-[60] py-1 w-72 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto"
      style={{ position: 'fixed', left, top }}>
      <WatchlistGroupPickerContent code={code} name={name} />
    </div>
  ), document.body);
}

/** 관심 그룹 선택 내용을 공유해 컨텍스트 메뉴에서도 한 번에 등록한다. */
export function WatchlistGroupPickerContent({ code, name }: { code: string; name?: string }) {
  const { data, isError, refetch } = useWatchlist();
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
    const removing = member.has(folderId);
    const folder = folders.find((f) => f.id === folderId);
    const options = {
      onSuccess: () => setFeedback(`${displayName} → ${folder?.name ?? ''} ${removing ? '해제됨' : '추가됨'}`),
      onError: () => setFeedback('저장하지 못했습니다. 다시 시도해 주세요.'),
    };
    if (removing) removeM.mutate({ folderId, code }, options);
    else addM.mutate({ folderId, code, name: displayName }, options);
  };
  const createAndAdd = async () => {
    const n = newName.trim();
    if (!n || busy) return;
    try {
      const f = await createM.mutateAsync(n);
      setNewName('');
      await addM.mutateAsync({ folderId: f.id, code, name: displayName });
      setFeedback(`${displayName} → ${n} 추가됨`);
    } catch {
      setFeedback('저장하지 못했습니다. 그룹 목록을 확인하고 다시 시도해 주세요.');
    }
  };

  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState('');
  const busy = addM.isPending || removeM.isPending || createM.isPending;
  const visibleFolders = folders.filter((f) => f.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return (
    <section aria-label="관심 그룹 선택">
      <div className="px-3 py-2 border-b border-border">
        <div className="text-sm font-medium text-fg">{displayName} <span className="text-xs text-fg-dim">{code}</span></div>
        <div className="text-xs text-fg-dim mt-1">관심 그룹 · 선택 즉시 반영</div>
      </div>
      {folders.length > 6 && <input aria-label="관심 그룹 검색" placeholder="관심 그룹 검색"
        value={search} onChange={(e) => setSearch(e.target.value)}
        className="block w-full px-3 py-2 text-sm bg-transparent border-b border-border" />}
      {data ? <div className="max-h-52 overflow-y-auto overscroll-contain py-1">
        {visibleFolders.map((f) => (
          <label key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-bg-input-hover">
            <input type="checkbox" checked={member.has(f.id)} disabled={busy}
              onChange={() => toggle(f.id)} />
            <span className="truncate" title={f.name}>{f.name}</span>
          </label>
        ))}
        {!visibleFolders.length && <p className="px-3 py-2 text-xs text-fg-dim">{folders.length ? '검색 결과가 없습니다' : '관심 그룹을 만들어 추가하세요'}</p>}
      </div> : <p className="px-3 py-2 text-xs text-fg-dim">{isError ? <button type="button" onClick={() => void refetch()}>불러오기 실패 · 다시 시도</button> : '관심 그룹을 불러오는 중…'}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void createAndAdd(); }} className="border-t border-border px-3 py-2 flex gap-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40}
          placeholder="새 그룹 만들기" aria-label="새 그룹 만들기" disabled={busy}
          className="min-w-0 flex-1 bg-transparent text-sm" />
        <button type="submit" disabled={busy || !newName.trim()} className="text-sm text-accent disabled:opacity-40">추가</button>
      </form>
      <div role="status" aria-live="polite" className="px-3 text-xs text-fg-dim break-words">{busy ? '저장 중…' : feedback}</div>
    </section>
  );
}
