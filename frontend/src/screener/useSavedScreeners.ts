import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listSaves, createSave, updateSave, deleteSave, type SaveWriteRequest } from '../api/savedScreeners';

const KEY = ['screener-saves'];

export const useSavedScreeners = () => useQuery({ queryKey: KEY, queryFn: listSaves });

export function useSaveMutations() {
  const qc = useQueryClient();
  const opts = { onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) };
  return {
    create: useMutation({ mutationFn: (b: SaveWriteRequest) => createSave(b), ...opts }),
    update: useMutation({ mutationFn: ({ id, body }: { id: string; body: SaveWriteRequest }) => updateSave(id, body), ...opts }),
    remove: useMutation({ mutationFn: (id: string) => deleteSave(id), ...opts }),
  };
}
