import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { transactWatchlistItems, type WatchlistResponse, type WatchlistFolderItemsChange } from '../api/watchlist';
import { WATCHLIST_KEY } from './watchlistKeys';
import { applyTransfer, inverseTransfer } from './transferItems';

export function useWatchlistTransfer() {
  const qc = useQueryClient();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [undo, setUndo] = useState<{ changes: WatchlistFolderItemsChange[]; label: string } | null>(null);
  const run = async (changes: WatchlistFolderItemsChange[], label: string, undoing = false) => {
    if (!changes.length || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    if (!undoing) setUndo(null);
    setMessage(undoing ? '되돌리는 중…' : '이동 중…');
    try {
      await qc.cancelQueries({ queryKey: WATCHLIST_KEY });
      await transactWatchlistItems({ changes });
      qc.setQueryData<WatchlistResponse>(WATCHLIST_KEY, (old) => old ? applyTransfer(old, changes) : old);
      setUndo(undoing ? null : { changes: inverseTransfer(changes), label });
      setMessage(undoing ? '이동을 되돌렸습니다' : label);
      return true;
    } catch (error) {
      setMessage(`${undoing ? '되돌리기를' : '이동을'} 완료하지 못했습니다 · ${error instanceof Error ? error.message : '최신 목록에서 다시 시도하세요'}`);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
      void qc.invalidateQueries({ queryKey: WATCHLIST_KEY });
    }
  };
  return { busy, message, canUndo: !!undo && !busy, run,
    undo: () => undo ? run(undo.changes, undo.label, true) : Promise.resolve(false),
    dismiss: () => { setMessage(''); setUndo(null); },
  };
}
