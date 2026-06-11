import { useState } from 'react';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useAddMember } from './useWatchlist';
import { Banner } from './Banner';

/** Shared add-form (v3): SymbolSearch + submit → 선택된 폴더의 멤버로 추가(ADR-0069).
 *  onAdded fires after a successful add (caller drives feedback/highlight). */
export function WatchlistAddForm({ folderId, onAdded }: {
  folderId: string;
  onAdded: (hit: { code: string; name: string }) => void;
}) {
  const addM = useAddMember();
  const [picked, setPicked] = useState<SymbolHit | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) return;
    try {
      await addM.mutateAsync({ folderId, code: picked.code, name: picked.name });
      onAdded({ code: picked.code, name: picked.name });
      setPicked(null);
    } catch {
      /* surfaces via addM.error */
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} className="flex gap-2 items-center">
        <div className="flex-1"><SymbolSearch value={picked} onChange={setPicked} /></div>
        <button type="submit" disabled={addM.isPending || picked === null}
                className="px-3 py-1.5 rounded bg-accent text-bg text-sm font-medium disabled:opacity-40">
          ＋ 종목 추가
        </button>
      </form>
      {addM.error && <Banner kind="error">{(addM.error as Error).message}</Banner>}
    </div>
  );
}
