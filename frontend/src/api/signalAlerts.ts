import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';

export type SignalAlertSource = 'ws' | 'rest';
export type SignalAlertName = 'sell_total_renewal';

export interface SignalAlertEvent {
  type: 'signal_alert';
  id: string;
  signal: SignalAlertName;
  seq: number;
  code: string;
  name: string;
  t_ms: number;
  date: string;
  source: SignalAlertSource;
  value: number;
  baseline: number;
  ratio_pct: number;
  use_intra_minute_max: boolean;
}

export interface SignalAlertSettings {
  schema_version: number;
  sell_total_renewal: {
    enabled: boolean;
    start_hhmm: number;
    threshold_pct: number;
    use_intra_minute_max: boolean;
  };
}

export type SignalAlertSettingsPatch = Pick<SignalAlertSettings, 'sell_total_renewal'>;

export interface SignalAlertRecentResponse {
  date: string;
  scope: 'inbox' | 'all';
  cleared_through_seq: number;
  alerts: SignalAlertEvent[];
}

export interface SignalAlertClearResponse {
  date: string;
  cleared_through_seq: number;
}

export const SIGNAL_ALERT_SETTINGS_KEY = ['signal-alerts', 'settings'] as const;
export const signalAlertRecentKey = (date: string) => ['signal-alerts', 'recent', date, 'inbox'] as const;

export function getSignalAlertSettings(): Promise<SignalAlertSettings> {
  return apiCall<SignalAlertSettings>('/api/signal-alerts/settings');
}

export function patchSignalAlertSettings(patch: SignalAlertSettingsPatch): Promise<SignalAlertSettings> {
  return apiCall<SignalAlertSettings>('/api/signal-alerts/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function getSignalAlertRecent(date: string): Promise<SignalAlertRecentResponse> {
  return apiCall<SignalAlertRecentResponse>(`/api/signal-alerts/recent?date=${date}&limit=100&scope=inbox`);
}

export function clearTodaySignalAlerts(date: string): Promise<SignalAlertClearResponse> {
  return apiCall<SignalAlertClearResponse>(`/api/signal-alerts/clear-today?date=${date}`, {
    method: 'POST',
  });
}

export function useSignalAlertSettings() {
  return useQuery({
    queryKey: SIGNAL_ALERT_SETTINGS_KEY,
    queryFn: getSignalAlertSettings,
  });
}

export function usePatchSignalAlertSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: patchSignalAlertSettings,
    onSuccess: (settings) => {
      qc.setQueryData(SIGNAL_ALERT_SETTINGS_KEY, settings);
    },
  });
}

export function useSignalAlertRecent(date: string) {
  return useQuery({
    queryKey: signalAlertRecentKey(date),
    queryFn: () => getSignalAlertRecent(date),
  });
}

export function useClearSignalAlertToday(date: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => clearTodaySignalAlerts(date),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: signalAlertRecentKey(date) });
    },
  });
}
