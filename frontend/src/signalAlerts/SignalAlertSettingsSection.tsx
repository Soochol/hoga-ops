import { useState } from 'react';
import {
  usePatchSignalAlertSettings,
  useSignalAlertSettings,
  type SignalAlertSettings,
} from '../api/signalAlerts';
import { SettingsRow, ToggleSwitch } from '../live/settings/SettingsRow';

type SignalAlertRule = SignalAlertSettings['sell_total_renewal'];

const DEFAULT_SIGNAL_ALERT_RULE: SignalAlertRule = {
  enabled: true,
  start_hhmm: 1100,
  threshold_pct: 100,
  use_intra_minute_max: true,
};

export default function SignalAlertSettingsSection() {
  const { data } = useSignalAlertSettings();
  const serverRule = data?.sell_total_renewal ?? DEFAULT_SIGNAL_ALERT_RULE;
  const editorKey = [
    serverRule.enabled,
    serverRule.start_hhmm,
    serverRule.threshold_pct,
    serverRule.use_intra_minute_max,
  ].join(':');

  return <SignalAlertSettingsEditor key={editorKey} serverRule={serverRule} />;
}

function SignalAlertSettingsEditor({ serverRule }: { serverRule: SignalAlertRule }) {
  const patch = usePatchSignalAlertSettings();
  const [draftRule, setDraftRule] = useState(serverRule);
  const [startTime, setStartTime] = useState(() => formatHhmm(serverRule.start_hhmm));
  const [threshold, setThreshold] = useState(() => String(serverRule.threshold_pct));

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
    if (!trimmed || !Number.isFinite(next) || !Number.isInteger(next) || next < 50 || next > 150) {
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
          min="09:00"
          max="15:20"
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
          min={50}
          max={150}
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
  if (hours < 9 || hours > 15 || (hours === 15 && minutes > 20)) {
    return null;
  }
  return hours * 100 + minutes;
}
