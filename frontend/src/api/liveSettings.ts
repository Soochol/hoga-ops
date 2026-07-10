import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';

export type LiveStoragePolicy = 'ws_only' | 'ws_plus_rest' | 'rest_only';

export interface LiveSettings {
  schema_version: number;
  storage_policy: LiveStoragePolicy;
  program_trade_storage_enabled: boolean;
  kis_rest_bypass_enabled: boolean;
  heatmap_capture_enabled: boolean;
}

export type LiveSettingsPatch = {
  storage_policy?: LiveStoragePolicy;
  program_trade_storage_enabled?: boolean;
  kis_rest_bypass_enabled?: boolean;
  heatmap_capture_enabled?: boolean;
};

export const LIVE_SETTINGS_KEY = ['live', 'settings'] as const;

export function getLiveSettings(): Promise<LiveSettings> {
  return apiCall<LiveSettings>('/api/live/settings');
}

export function patchLiveSettings(patch: LiveSettingsPatch): Promise<LiveSettings> {
  return apiCall<LiveSettings>('/api/live/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function useLiveSettings() {
  return useQuery({
    queryKey: LIVE_SETTINGS_KEY,
    queryFn: getLiveSettings,
  });
}

export function usePatchLiveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: patchLiveSettings,
    // Optimistic shallow-merge so toggles flip instantly. onSuccess overwrites
    // with the authoritative server value, which corrects any server-derived
    // field the patch can't predict (e.g. program_trade forced off under ws_only).
    // No cancelQueries: this settings query has no background refetch to race,
    // and cancelling it races the mount-time auto-PATCH in KisRestUnavailableToastHost.
    onMutate: (patch): { previous: LiveSettings | undefined } => {
      const previous = qc.getQueryData<LiveSettings>(LIVE_SETTINGS_KEY);
      if (previous) qc.setQueryData<LiveSettings>(LIVE_SETTINGS_KEY, { ...previous, ...patch });
      return { previous };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx) qc.setQueryData(LIVE_SETTINGS_KEY, ctx.previous);
    },
    onSuccess: (settings) => {
      qc.setQueryData(LIVE_SETTINGS_KEY, settings);
      void qc.invalidateQueries({ queryKey: ['live', 'status'] });
    },
  });
}
