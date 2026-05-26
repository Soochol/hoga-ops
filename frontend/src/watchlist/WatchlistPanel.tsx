import { useEffect, useState } from 'react';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import type { ManualCatchupAllResponse } from '../api/watchlist';
import { Countdown } from './Countdown';
import { WatchlistRow } from './WatchlistRow';
import {
  useWatchlist,
  useAddToWatchlist,
  useRemoveFromWatchlist,
} from './useWatchlist';

const JUST_ADDED_MS = 5000;

type RecentAction =
  | { kind: 'added';         code: string; name: string }
  | { kind: 'caught_up_one'; code: string; name: string;
                             enqueued: number; deduped: number;
                             error?: string }
  | { kind: 'caught_up_all'; summary: ManualCatchupAllResponse['results'] };

export function WatchlistPanel() {
  const { data, isLoading, error } = useWatchlist();
  const addM = useAddToWatchlist();
  const removeM = useRemoveFromWatchlist();
  const [picked, setPicked] = useState<SymbolHit | null>(null);
  const [recentAction, setRecentAction] = useState<RecentAction | null>(null);

  // 5-second timer for both the success banner and the row highlight.
  useEffect(() => {
    if (!recentAction) return;
    const id = setTimeout(() => setRecentAction(null), JUST_ADDED_MS);
    return () => clearTimeout(id);
  }, [recentAction]);

  if (isLoading) return <div className="p-6 text-fg-dim">로딩 중…</div>;
  if (error) return <div className="p-6 text-error">불러오기 실패: {(error as Error).message}</div>;
  if (!data) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked) return;
    try {
      await addM.mutateAsync(picked.code);
      setRecentAction({ kind: 'added', code: picked.code, name: picked.name });
      setPicked(null);
    } catch {
      /* error surfaces via addM.error */
    }
  };

  const isTradingHint = data.entries.length === 0 ? '추가된 종목 없음' : '거래일';

  return (
    <div className="flex flex-col h-full">
      <header className="px-6 py-4 border-b border-border">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Watchlist</h1>
          <span className="font-mono tabular-nums text-xs text-fg-dimmer px-2 py-0.5 rounded bg-bg-input">
            {data.entries.length}종목
          </span>
        </div>
        <p className="text-sm text-fg-dim mt-2 flex items-center gap-2">
          다음 자동 수집까지
          <span className="font-mono tabular-nums text-accent px-2 py-0.5 rounded"
                style={{ background: 'var(--selection-tint)' }}>
            <Countdown targetMs={data.next_run_at_ms} />
          </span>
          <span className="text-fg-dimmer text-xs">(오늘 KST 18:00 · {isTradingHint})</span>
        </p>
      </header>

      {recentAction?.kind === 'added' && (
        <div className="mx-6 mt-3 px-3 py-2 rounded border text-sm"
             style={{
               background: 'rgba(34,197,94,0.10)',
               borderColor: 'rgba(34,197,94,0.30)',
               color: 'var(--success)',
             }}>
          {`✓ ${recentAction.name} (${recentAction.code}) 추가됨. 내일 18:00부터 자동 수집됩니다.`}
        </div>
      )}

      {addM.error && (
        <div className="mx-6 mt-3 px-3 py-2 rounded border text-sm"
             style={{
               background: 'rgba(244,63,94,0.10)',
               borderColor: 'rgba(244,63,94,0.30)',
               color: 'var(--error)',
             }}>
          {(addM.error as Error).message}
        </div>
      )}

      <form onSubmit={submit} className="px-6 py-3 border-b border-border flex gap-2 items-center">
        <div className="flex-1">
          <SymbolSearch value={picked} onChange={setPicked} />
        </div>
        <button
          type="submit"
          disabled={addM.isPending || picked === null}
          className="px-3 py-1.5 rounded bg-accent text-bg text-sm font-medium disabled:opacity-40"
        >
          ＋ 추가
        </button>
      </form>

      <div className="flex-1 overflow-auto">
        {data.entries.length === 0 ? (
          <div className="p-12 text-center text-fg-dim text-sm leading-relaxed">
            자동 수집할 종목이 아직 없습니다.<br/>
            위에서 검색해서 추가하면 매일{' '}
            <span className="text-accent font-medium">KST 18:00</span>에 자동으로 캡쳐됩니다.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[6ch_1fr_8ch_8ch_3ch] gap-3 px-6 py-1.5 border-b border-border bg-bg-subtle text-xs font-semibold uppercase tracking-wider text-fg-dimmer">
              <span>Code</span>
              <span>종목명</span>
              <span>등록</span>
              <span>마지막 성공</span>
              <span></span>
            </div>
            {data.entries.map((e) => (
              <WatchlistRow
                key={e.code}
                entry={e}
                onRemove={(c) => removeM.mutate(c)}
                removing={removeM.isPending && removeM.variables === e.code}
                justAdded={
                  (recentAction?.kind === 'added' && recentAction.code === e.code) ||
                  (recentAction?.kind === 'caught_up_one' && recentAction.code === e.code) ||
                  recentAction?.kind === 'caught_up_all'
                }
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
