import { AppIcon } from '../ui/AppIcon';
import { useMemo, useState } from 'react';
import { useWatchlist, useAddMember, useRemoveMember, useCreateFolder } from './useWatchlist';
import { useWatchlistMembership } from './useWatchlistMembership';
import { CheckIcon } from '../ui/CheckIcon';
/** 관심 그룹 선택 내용을 공유해 컨텍스트 메뉴에서도 한 번에 등록한다. */
export function WatchlistGroupPickerContent({ code, name, selectionRole = 'checkbox' }: {
  code: string;
  name?: string;
  selectionRole?: 'checkbox' | 'menuitemcheckbox';
}) {
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
  const [undo, setUndo] = useState<{
    folderId: string; folderName: string; removing: boolean; order?: number;
  } | null>(null);

  const toggle = (folderId: string) => {
    if (busy) return;
    const removing = member.has(folderId);
    const folder = folders.find((f) => f.id === folderId);
    const order = data?.entries.find(entry => entry.code === code && entry.folder_id === folderId)?.order;
    const options = {
      onSuccess: () => {
        setFeedback(`${displayName} → ${folder?.name ?? ''} ${removing ? '해제됨' : '추가됨'}`);
        setUndo({ folderId, folderName: folder?.name ?? '', removing, order });
      },
      onError: () => setFeedback('저장하지 못했습니다. 다시 시도해 주세요.'),
    };
    if (removing) removeM.mutate({ folderId, code }, options);
    else addM.mutate({ folderId, code, name: displayName }, options);
  };
  const createAndAdd = async () => {
    const n = newName.trim();
    if (!n || busy || !data) return;
    try {
      const f = await createM.mutateAsync(n);
      setNewName('');
      await addM.mutateAsync({ folderId: f.id, code, name: displayName });
      setFeedback(`${displayName} → ${n} 추가됨`);
      setUndo({ folderId: f.id, folderName: n, removing: false });
    } catch {
      setFeedback('저장하지 못했습니다. 그룹 목록을 확인하고 다시 시도해 주세요.');
    }
  };

  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState('');
  const busy = addM.isPending || removeM.isPending || createM.isPending;
  const undoChange = () => {
    if (!undo || busy) return;
    const options = {
      onSuccess: () => {
        setFeedback(`${displayName} → ${undo.folderName} 변경 취소됨`);
        setUndo(null);
      },
      onError: () => setFeedback('변경을 취소하지 못했습니다. 다시 시도해 주세요.'),
    };
    if (undo.removing) addM.mutate({ folderId: undo.folderId, code, name: displayName, at: undo.order }, options);
    else removeM.mutate({ folderId: undo.folderId, code }, options);
  };
  const visibleFolders = folders.filter((f) => f.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return (
    <section aria-label="관심 그룹 선택" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2 text-sm font-medium text-fg">
          <span className="truncate" data-tooltip={displayName}>{displayName}</span>{' '}
          <span className="shrink-0 font-data text-xs font-normal text-fg-dim">{code}</span>
        </div>
        <p className="mt-1 text-xs text-fg-dim">여러 그룹 선택 · 즉시 반영</p>
      </div>
      {folders.length > 6 && <div className="shrink-0 px-3 pb-2">
        <input aria-label="관심 그룹 검색" placeholder="관심 그룹 검색"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="block w-full rounded-md bg-bg-input-hover px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus-visible:outline-accent" />
      </div>}
      {data ? <div className="min-h-0 max-h-52 overflow-y-auto overscroll-contain px-1 py-1">
        {visibleFolders.map((f) => {
          const checked = member.has(f.id);
          return <button key={f.id} type="button" role={selectionRole} aria-checked={checked}
            aria-label={f.name} disabled={busy} data-testid={`quote-menu-group-${f.id}`}
            onClick={() => toggle(f.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-accent disabled:opacity-50 ${checked ? 'bg-tint-selection text-fg' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'}`}>
            <span className="grid w-4 shrink-0 place-items-center"><CheckIcon filled={checked} size={16} /></span>
            <span className="min-w-0 truncate" data-tooltip={f.name}>{f.name}</span>
            {checked && <span className="ml-auto shrink-0 text-xs text-fg-dim" aria-hidden="true">등록됨</span>}
          </button>;
        })}
        {!visibleFolders.length && <p className="px-3 py-2 text-xs text-fg-dim">{folders.length ? '검색 결과가 없습니다' : '관심 그룹을 만들어 추가하세요'}</p>}
      </div> : <p className="px-3 py-2 text-xs text-fg-dim">{isError ? <button type="button" onClick={() => void refetch()}>불러오기 실패 · 다시 시도</button> : '관심 그룹을 불러오는 중…'}</p>}
      <form onSubmit={(e) => { e.preventDefault(); void createAndAdd(); }} className="mt-1 flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
        <AppIcon name="plus" className="text-fg-dim" />
        <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40}
          placeholder="새 그룹 만들기" aria-label="새 그룹 만들기" disabled={busy}
          onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}
          className="min-w-0 flex-1 rounded-sm bg-transparent py-1 text-sm text-fg placeholder:text-fg-dim focus-visible:outline-accent" />
        <button type="submit" disabled={!data || busy || !newName.trim()}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-tint-selection disabled:opacity-40">추가</button>
      </form>
      {(busy || feedback) && <div role="status" aria-live="polite" className="flex shrink-0 flex-wrap items-center gap-2 break-words border-t border-border px-3 py-2 text-xs text-fg-dim">
        <span>{busy ? '저장 중…' : feedback}</span>
        {undo && <button type="button" disabled={busy} onClick={undoChange}
          className="text-accent disabled:opacity-40">실행 취소</button>}
      </div>}
    </section>
  );
}
