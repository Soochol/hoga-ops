import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { addToHeatmapFolder, type HeatmapResponse } from '../api/heatmap';
import { useEntryDragStore } from '../state/entryDrag';
import { registerHeatmapDropTarget } from '../state/heatmapDrop';
import { HEATMAP_KEY, invalidateHeatmapDependents } from './heatmapKeys';
import { HeatmapPanelDropContext } from './HeatmapPanelDropContext';

/** Bridges independent panel/board dnd-kit contexts without changing their sensors.
 * Hit testing uses the topmost element, so clipped cards and covering dialogs
 * cannot receive drops. Read current DOM geometry again at commit and on scroll. */
export function HeatmapPanelDropTarget({ data, children }: { data?: HeatmapResponse; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const latestData = useRef(data);
  useLayoutEffect(() => { latestData.current = data; }, [data]);
  const qc = useQueryClient();
  const [over, setOver] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let mounted = true;
    const hit = (point: { x: number; y: number } | null) => {
      if (!point) return null;
      const element = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-heatmap-drop-folder]');
      if (!element || !root.current?.contains(element)) return null;
      return latestData.current?.folders.find((folder) => folder.id === element.dataset.heatmapDropFolder) ?? null;
    };
    const update = () => {
      const { draggingCode, dragPoint } = useEntryDragStore.getState();
      setOver(draggingCode ? hit(dragPoint)?.id ?? null : null);
    };
    const unsubscribe = useEntryDragStore.subscribe(update);
    window.addEventListener('scroll', update, true);
    const unregister = registerHeatmapDropTarget((point, entry) => {
      const folder = hit(point);
      if (!folder) return false;
      if (busy.current) return true;
      if (latestData.current?.entries.some((e) => e.folder_id === folder.id && e.code === entry.code)) {
        setMessage(`이미 ${folder.name} 그룹에 등록된 종목입니다`);
        return true;
      }
      busy.current = true;
      setMessage(`${folder.name} 그룹에 추가 중…`);
      void (async () => {
        try {
          await qc.cancelQueries({ queryKey: HEATMAP_KEY });
          const added = await addToHeatmapFolder(entry.code, folder.id);
          qc.setQueryData<HeatmapResponse>(HEATMAP_KEY, (old) => old ? {
            ...old,
            entries: [...old.entries.filter((e) => e.folder_id !== added.folder_id || e.code !== added.code), added],
          } : old);
          if (mounted) setMessage(`${entry.name ?? entry.code} · ${folder.name} 그룹에 추가했습니다`);
        } catch (error) {
          if (mounted) setMessage(`종목을 추가하지 못했습니다 · ${error instanceof Error ? error.message : '다시 시도하세요'}`);
        } finally {
          invalidateHeatmapDependents(qc);
          busy.current = false;
        }
      })();
      return true;
    });
    update();
    return () => {
      mounted = false;
      unsubscribe();
      unregister();
      window.removeEventListener('scroll', update, true);
    };
  }, [qc]);

  const folder = data?.folders.find((f) => f.id === over);
  return (
    <HeatmapPanelDropContext.Provider value={over}>
      <div ref={root} className="relative flex flex-1 min-h-0 flex-col">
        {children}
        {(folder || message) && <div role="status" className="pointer-events-none absolute bottom-2 left-2 right-2 border border-border-strong bg-bg-card px-3 py-2 text-sm text-fg">
          {folder ? `${folder.name} 그룹에 추가` : message}
        </div>}
      </div>
    </HeatmapPanelDropContext.Provider>
  );
}
