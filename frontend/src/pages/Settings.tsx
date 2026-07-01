import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadConfig, type AppConfig } from '../config';
import { usePatchSignalAlertSettings, useSignalAlertSettings } from '../api/signalAlerts';
import { getSymbolMasterInfo, refreshSymbols } from '../api/symbols';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import { symbolMasterSettingsHints } from '../api/upstream-hints';
import { PageContainer } from '../layout/PageContainer';
import { DataSection } from '../ui/DataSurface';
import { DefinitionRow, PanelCard, ToolbarButton } from '../ui/PageShell';
import { SettingsRow, ToggleSwitch } from '../live/settings/SettingsRow';

const VERSION = 'v0.1.0';
const SYMBOLS_INFO_QUERY_KEY = ['symbols', 'info'] as const;
const DEFAULT_SIGNAL_ALERT_RULE = {
  enabled: true,
  start_hhmm: 1100,
  threshold_pct: 100,
  use_intra_minute_max: true,
} as const;

function formatRelative(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'Never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hour ago`;
  return `${Math.floor(delta / 86_400_000)} days ago`;
}

export default function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageContainer className="grid grid-cols-[minmax(0,42rem)] content-start">
      <PanelCard as="section" data-testid="settings-page-primary" className="flex flex-col overflow-hidden text-sm">
        <DataSection title="앱 정보" contentClassName="space-y-3 p-md">
          <DefinitionRow label="API URL" value={config?.api_url ?? '…'} />
          <DefinitionRow label="Version" value={VERSION} />
        </DataSection>
        <DataSection title="Symbol Master" contentClassName="space-y-3 p-md">
          <SymbolMasterSection />
        </DataSection>
        <DataSection title="시그널 알림" contentClassName="p-md">
          <SignalAlertSettingsSection />
        </DataSection>
        <DataSection title="로드맵" contentClassName="p-md">
          <p className="text-xs text-fg-dimmer">
            편집 가능한 설정은 v1+1에서 `/api/config` 라우트와 함께 제공 예정.
          </p>
        </DataSection>
      </PanelCard>
    </PageContainer>
  );
}

function SymbolMasterSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: SYMBOLS_INFO_QUERY_KEY,
    queryFn: getSymbolMasterInfo,
    refetchOnWindowFocus: false,
  });
  const [updating, setUpdating] = useState(false);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await refreshSymbols();
      await queryClient.invalidateQueries({ queryKey: SYMBOLS_INFO_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: SYMBOLS_QUERY_KEY });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section className="space-y-2">
      <DefinitionRow label="Items" value={data ? data.count.toLocaleString() : (isLoading ? '…' : '0')} />
      <DefinitionRow label="Last fetched" value={formatRelative(data?.fetched_at_ms)} />
      <DefinitionRow label="Status" value={data?.status ?? '…'} />
      {data?.reason && (
        <div className="text-xs text-error">{symbolMasterSettingsHints[data.reason]}</div>
      )}
      <ToolbarButton
        type="button"
        onClick={handleUpdate}
        disabled={updating || isLoading}
        className="mt-2"
      >
        {updating ? 'Updating… (~30-120s)' : 'Update Now'}
      </ToolbarButton>
    </section>
  );
}

function SignalAlertSettingsSection() {
  const { data } = useSignalAlertSettings();
  const patch = usePatchSignalAlertSettings();
  const serverRule = data?.sell_total_renewal ?? DEFAULT_SIGNAL_ALERT_RULE;
  const [draftRule, setDraftRule] = useState(serverRule);
  const [startTime, setStartTime] = useState(() => formatHhmm(serverRule.start_hhmm));
  const [threshold, setThreshold] = useState(() => String(serverRule.threshold_pct));

  useEffect(() => {
    setDraftRule(serverRule);
    setStartTime(formatHhmm(serverRule.start_hhmm));
    setThreshold(String(serverRule.threshold_pct));
  }, [serverRule]);

  const update = (next: typeof draftRule) => {
    setDraftRule(next);
    patch.mutate({ sell_total_renewal: next });
  };

  const commitStartTime = () => {
    const next = parseTimeInput(startTime);
    if (next === null) {
      setStartTime(formatHhmm(draftRule.start_hhmm));
      return;
    }
    setStartTime(formatHhmm(next));
    if (next !== draftRule.start_hhmm) update({ ...draftRule, start_hhmm: next });
  };

  const commitThreshold = () => {
    const trimmed = threshold.trim();
    const next = Number(trimmed);
    if (!trimmed || !Number.isFinite(next) || !Number.isInteger(next)) {
      setThreshold(String(draftRule.threshold_pct));
      return;
    }
    setThreshold(String(next));
    if (next !== draftRule.threshold_pct) update({ ...draftRule, threshold_pct: next });
  };

  return (
    <section>
      <SettingsRow label="알림 사용">
        <ToggleSwitch
          label="알림 사용"
          checked={draftRule.enabled}
          onClick={() => update({ ...draftRule, enabled: !draftRule.enabled })}
        />
      </SettingsRow>
      <SettingsRow label="기준 시각">
        <input
          type="time"
          step={60}
          aria-label="기준 시각"
          value={startTime}
          onChange={(event) => setStartTime(event.currentTarget.value)}
          onBlur={commitStartTime}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitStartTime();
            }
          }}
          className="w-[88px] rounded-md border border-border-strong bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-fg focus:border-accent focus:outline-none"
        />
      </SettingsRow>
      <SettingsRow label="기준 최대값 대비 문턱 (%)">
        <input
          type="number"
          inputMode="numeric"
          aria-label="기준 최대값 대비 문턱 (%)"
          value={threshold}
          onChange={(event) => setThreshold(event.currentTarget.value)}
          onBlur={commitThreshold}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitThreshold();
            }
          }}
          className="w-[72px] rounded-md border border-border-strong bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-fg focus:border-accent focus:outline-none"
        />
      </SettingsRow>
      <SettingsRow label="분봉 내 최대 매도 총잔량으로 판정">
        <ToggleSwitch
          label="분봉 내 최대 매도 총잔량으로 판정"
          checked={draftRule.use_intra_minute_max}
          onClick={() => update({ ...draftRule, use_intra_minute_max: !draftRule.use_intra_minute_max })}
        />
      </SettingsRow>
    </section>
  );
}

function formatHhmm(hhmm: number): string {
  const hours = String(Math.floor(hhmm / 100)).padStart(2, '0');
  const minutes = String(hhmm % 100).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function parseTimeInput(value: string): number | null {
  const [hoursRaw, minutesRaw] = value.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }
  return hours * 100 + minutes;
}
