import { QuickAddSymbolForm } from '../capture/QuickAddSymbolForm';
import { useAddMember, useRemoveMember, useWatchlist } from './useWatchlist';

/** Search selection adds immediately. Insertion indices are resolved at the
 * moment of each request so a polling refresh cannot leave a stale position. */
export function WatchlistAddForm({ folderId, resolveAt, onAdded, onDuplicate, onMoveHere }: {
  folderId: string;
  resolveAt?: () => number | undefined;
  onAdded?: (hit: { code: string; name: string }) => void;
  onDuplicate?: (code: string) => void;
  onMoveHere?: (code: string) => void;
}) {
  const add = useAddMember();
  const remove = useRemoveMember();
  const { data } = useWatchlist();
  return <QuickAddSymbolForm key={folderId}
    isAdded={code => (data?.entries ?? []).some(entry => entry.folder_id === folderId && entry.code === code)}
    onAdd={hit => add.mutateAsync({ folderId, code: hit.code, name: hit.name, at: resolveAt?.() })}
    onAdded={hit => onAdded?.({ code: hit.code, name: hit.name })}
    onUndo={hit => remove.mutateAsync({ folderId, code: hit.code })}
    onDuplicate={onDuplicate}
    duplicateAction={onMoveHere ? hit => <div className="mt-1.5 flex justify-end">
      <button type="button" onClick={() => onMoveHere(hit.code)}
        className="px-2 py-0.5 rounded border border-current text-xs font-medium hover:bg-tint-error">
        그 행을 여기로 이동
      </button>
    </div> : undefined} />;
}
