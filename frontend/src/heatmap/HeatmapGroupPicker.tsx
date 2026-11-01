import { useRef, useState } from 'react';
import { AppIcon } from '../ui/AppIcon';
import { CheckIcon } from '../ui/CheckIcon';
import { useHeatmap, useAddToHeatmapFolder, useRemoveFromHeatmap, useCreateHeatmapFolder } from './useHeatmap';

/** Folder-scoped membership only: another group's registration is never moved. */
export function HeatmapGroupPickerContent({ code, name, selectionRole = 'checkbox' }: {
  code: string; name: string | null; selectionRole?: 'checkbox' | 'menuitemcheckbox';
}) {
  const { data, isError, refetch } = useHeatmap();
  const add = useAddToHeatmapFolder();
  const remove = useRemoveFromHeatmap();
  const create = useCreateHeatmapFolder();
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [undo, setUndo] = useState<{ folderId: string; folderName: string; removing: boolean } | null>(null);
  const locked = useRef(false);
  const busy = saving || add.isPending || remove.isPending || create.isPending;
  const folders = [...(data?.folders ?? [])].sort((a, b) => a.order - b.order);
  const memberships = new Set(data?.entries.filter(entry => entry.code === code).map(entry => entry.folder_id));
  const visible = folders.filter(folder => folder.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const displayName = name ?? data?.entries.find(entry => entry.code === code)?.name ?? code;

  const save = async (operation: () => Promise<void>) => {
    if (locked.current || !data) return;
    locked.current = true;
    setSaving(true);
    setError('');
    setFeedback('');
    try { await operation(); }
    catch { setError('저장하지 못했습니다. 그룹을 확인하고 다시 시도해 주세요.'); }
    finally { locked.current = false; setSaving(false); }
  };
  const toggle = (folderId: string, folderName: string) => save(async () => {
    const removing = memberships.has(folderId);
    if (removing) await remove.mutateAsync({ code, folderId });
    else await add.mutateAsync({ code, folderId });
    setFeedback(`${displayName} → ${folderName} ${removing ? '해제됨' : '등록됨'}`);
    setUndo({ folderId, folderName, removing });
  });
  const undoChange = () => save(async () => {
    if (!undo) return;
    if (undo.removing) await add.mutateAsync({ code, folderId: undo.folderId });
    else await remove.mutateAsync({ code, folderId: undo.folderId });
    setFeedback(`${displayName} → ${undo.folderName} 변경 취소됨`);
    setUndo(null);
  });

  return <section aria-label="히트맵 그룹 선택" className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-2 text-sm font-medium text-fg">
        <span className="truncate" data-tooltip={displayName}>{displayName}</span>
        <span className="font-data text-xs font-normal text-fg-dim">{code}</span>
      </div>
      <p className="mt-1 text-xs text-fg-dim">히트맵 그룹 · 여러 그룹 선택 · 즉시 반영</p>
    </div>
    {folders.length > 6 && <div className="shrink-0 px-3 pb-2">
      <input aria-label="히트맵 그룹 검색" placeholder="그룹 검색" value={search}
        onChange={event => setSearch(event.target.value)}
        className="block w-full rounded-md bg-bg-input-hover px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus-visible:outline-accent" />
    </div>}
    {data ? <div className="min-h-0 max-h-52 overflow-y-auto overscroll-contain px-1 py-1">
      {visible.map(folder => <button key={folder.id} type="button" role={selectionRole}
        aria-checked={memberships.has(folder.id)} aria-label={folder.name} disabled={busy}
        onClick={() => void toggle(folder.id, folder.name)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:outline-accent disabled:opacity-50 ${memberships.has(folder.id) ? 'bg-tint-selection text-fg' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'}`}>
        <CheckIcon filled={memberships.has(folder.id)} size={16} />
        <span className="min-w-0 truncate" data-tooltip={folder.name}>{folder.name}</span>
        {memberships.has(folder.id) && <span className="ml-auto shrink-0 text-xs text-fg-dim" aria-hidden="true">등록됨</span>}
      </button>)}
      {!visible.length && <p className="px-3 py-2 text-xs text-fg-dim">{folders.length ? '검색 결과가 없습니다' : '새 그룹을 만들어 등록하세요'}</p>}
    </div> : <p className="px-3 py-2 text-xs text-fg-dim">{isError
      ? <button type="button" onClick={() => void refetch()}>불러오기 실패 · 다시 시도</button>
      : '히트맵 그룹을 불러오는 중…'}</p>}
    <form className="mt-1 flex shrink-0 items-center gap-2 border-t border-border px-3 py-2"
      onSubmit={event => {
        event.preventDefault();
        const trimmed = newName.trim();
        if (!trimmed) return;
        void save(async () => {
          const folder = await create.mutateAsync(trimmed);
          setNewName('');
          await add.mutateAsync({ code, folderId: folder.id });
          setFeedback(`${displayName} → ${folder.name} 등록됨`);
          setUndo({ folderId: folder.id, folderName: folder.name, removing: false });
        });
      }}>
      <AppIcon name="plus" className="text-fg-dim" />
      <input aria-label="새 히트맵 그룹" placeholder="새 그룹 만들기" maxLength={40}
        value={newName} disabled={busy || !data} onChange={event => setNewName(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}
        className="min-w-0 flex-1 rounded-sm bg-transparent py-1 text-sm text-fg placeholder:text-fg-dim focus-visible:outline-accent" />
      <button type="submit" disabled={busy || !data || !newName.trim()}
        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-tint-selection disabled:opacity-40">등록</button>
    </form>
    {(busy || feedback || error) && <div role={error ? 'alert' : 'status'}
      className={`flex shrink-0 flex-wrap items-center gap-2 break-words border-t border-border px-3 py-2 text-xs ${error ? 'text-error' : 'text-fg-dim'}`}>
      <span>{busy ? '저장 중…' : error || feedback}</span>
      {undo && <button type="button" disabled={busy} onClick={() => void undoChange()}
        className="text-accent disabled:opacity-40">실행 취소</button>}
    </div>}
  </section>;
}
