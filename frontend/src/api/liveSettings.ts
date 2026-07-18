import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';

// storage_policy·heatmap_capture_enabled는 제거됨(2026-07-17 정책: 호가·체결은
// KIS REST로 받지 않는다 — 관심종목=KIS WS, 히트맵=키움 WS).
// kiwoom_enabled(키움 활성화 스위치)는 폐지됨(ADR-0118) — 실시간=키움 WS 유일 소스라
// 선택지가 아니고, 활성화는 백엔드에서 자격증명(앱키) 존재만으로 게이트된다.
export interface LiveSettings {
  schema_version: number;
  program_trade_storage_enabled: boolean;
  kis_rest_bypass_enabled: boolean;
  screener_depth_autocollect: boolean;
}

export type LiveSettingsPatch = {
  program_trade_storage_enabled?: boolean;
  kis_rest_bypass_enabled?: boolean;
  screener_depth_autocollect?: boolean;
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
    // field the patch can't predict.
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
