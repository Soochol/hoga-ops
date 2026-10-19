import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listSaves, createSave, updateSave, deleteSave, type SaveWriteRequest, type SavedScreenerListResponse } from '../api/savedScreeners';
import { SCREENER_SAVES_KEY as KEY } from './screenerKeys';
import { includeOpenBars } from './candlePolicy';

const withOpenBars = (data: SavedScreenerListResponse) => ({ ...data,
  saves: data.saves.map(save => ({ ...save, conditions: includeOpenBars(save.conditions) })),
});
export const useSavedScreeners = () => useQuery({ queryKey: KEY, queryFn: listSaves, select: withOpenBars });

export function useSaveMutations() {
  const qc = useQueryClient();
  const opts = { onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) };
  return {
    create: useMutation({ mutationFn: (b: SaveWriteRequest) => createSave(b), ...opts }),
    update: useMutation({ mutationFn: ({ id, body }: { id: string; body: SaveWriteRequest }) => updateSave(id, body), ...opts }),
    remove: useMutation({ mutationFn: (id: string) => deleteSave(id), ...opts }),
  };
}
