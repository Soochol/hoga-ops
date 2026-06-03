import { useState } from 'react';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useAddToWatchlist } from './useWatchlist';
import { Banner } from './Banner';

/** Shared add-form: SymbolSearch + submit + 409 already_in_watchlist banner.
 *  onAdded fires after a successful add (caller drives feedback/highlight). */
export function WatchlistAddForm({ onAdded }: { onAdded: (hit: { code: string; name: string }) => void }) {
  const addM = useAddToWatchlist();
  const [picked, setPicked] = useState<SymbolHit | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) return;
    try {
      await addM.mutateAsync(picked.code);
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
