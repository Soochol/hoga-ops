import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';

export type LiveStoragePolicy = 'ws_only' | 'ws_plus_rest' | 'rest_only';

export interface LiveSettings {
  schema_version: number;
  storage_policy: LiveStoragePolicy;
  program_trade_storage_enabled: boolean;
}

export type LiveSettingsPatch = {
  storage_policy: LiveStoragePolicy;
  program_trade_storage_enabled?: boolean;
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
    onSuccess: (settings) => {
      qc.setQueryData(LIVE_SETTINGS_KEY, settings);
      void qc.invalidateQueries({ queryKey: ['live', 'status'] });
    },
  });
}
