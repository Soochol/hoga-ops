import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createLiveLayoutPreset,
  deleteLiveLayoutPreset,
  listLiveLayoutPresets,
  updateLiveLayoutPreset,
  type LiveLayoutPresetWriteRequest,
} from '../../api/liveLayoutPresets';
import { LIVE_LAYOUT_PRESETS_QUERY } from './liveLayoutPresetKeys';

export { LIVE_LAYOUT_PRESETS_QUERY };

export function useLiveLayoutPresets() {
  return useQuery({ queryKey: LIVE_LAYOUT_PRESETS_QUERY, queryFn: listLiveLayoutPresets });
}

export function useLiveLayoutPresetMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: LIVE_LAYOUT_PRESETS_QUERY });
  return {
    create: useMutation({
      mutationFn: (body: LiveLayoutPresetWriteRequest) => createLiveLayoutPreset(body),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: LiveLayoutPresetWriteRequest }) =>
        updateLiveLayoutPreset(id, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: deleteLiveLayoutPreset,
      onSuccess: invalidate,
    }),
  };
}
