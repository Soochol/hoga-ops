import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { transactHeatmapEntries, type HeatmapResponse, type HeatmapFolderEntriesChange } from '../api/heatmap';
import { HEATMAP_KEY, invalidateHeatmapDependents } from './heatmapKeys';
import { applyHeatmapTransfer, inverseHeatmapTransfer } from './transferEntries';

export function useHeatmapTransfer() {
  const qc = useQueryClient();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [undo, setUndo] = useState<{ changes: HeatmapFolderEntriesChange[]; label: string } | null>(null);
  const run = async (changes: HeatmapFolderEntriesChange[], label: string, undoing = false) => {
    if (!changes.length || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    if (!undoing) setUndo(null);
    setMessage(undoing ? '되돌리는 중…' : '저장 중…');
    try {
      await qc.cancelQueries({ queryKey: HEATMAP_KEY });
      await transactHeatmapEntries({ changes });
      qc.setQueryData<HeatmapResponse>(HEATMAP_KEY, (old) => old ? applyHeatmapTransfer(old, changes) : old);
      setUndo(undoing ? null : { changes: inverseHeatmapTransfer(changes), label });
      setMessage(undoing ? '변경을 되돌렸습니다' : label);
      return true;
    } catch (error) {
      setMessage(`${undoing ? '되돌리기를' : '변경을'} 완료하지 못했습니다 · ${error instanceof Error ? error.message : '최신 목록에서 다시 시도하세요'}`);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
      void invalidateHeatmapDependents(qc);
    }
  };
  return { busy, message, canUndo: !!undo && !busy, run,
    undo: () => undo ? run(undo.changes, undo.label, true) : Promise.resolve(false),
    dismiss: () => { setMessage(''); setUndo(null); },
  };
}
