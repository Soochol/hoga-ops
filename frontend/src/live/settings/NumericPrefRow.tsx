// frontend/src/live/settings/NumericPrefRow.tsx
import { useEffect, useState } from 'react';
import {
  useChartPrefsStore,
  type NumericPrefDef,
  type NumericPrefKey,
} from '../../state/chartPrefs';
import { SettingsRow } from './SettingsRow';
import TimeOfDayInput from './TimeOfDayInput';
import { formatHhmm } from '../../util/tradingTime';

export default function NumericPrefRow({ def }: { def: NumericPrefDef }) {
  const value = useChartPrefsStore((s) => s[def.key as NumericPrefKey]);
  const gateEnabled = useChartPrefsStore((s) =>
    def.enabledBy === undefined ? true : s[def.enabledBy],
  );
  const setNumericPref = useChartPrefsStore((s) => s.setNumericPref);
  const [inputValue, setInputValue] = useState<string>(String(value));

  useEffect(() => {
    setInputValue(String(value));
  }, [value]);

  // 시각 종류는 HH:MM 입력(TimeOfDayInput)으로 통일. 값은 HHMM 정수 그대로 저장.
  // 범위 접미어는 숫자 대신 포맷된 시각(09:00–15:20)으로 표시한다.
  if (def.kind === 'time') {
    return (
      <SettingsRow
        label={def.label}
        description={`${def.description} (${formatHhmm(def.min)}–${formatHhmm(def.max)})`}
        disabled={!gateEnabled}
      >
        <TimeOfDayInput
          hhmm={value}
          onCommit={(hhmm) => setNumericPref(def.key as NumericPrefKey, hhmm)}
          ariaLabel={def.label}
          disabled={!gateEnabled}
        />
      </SettingsRow>
    );
  }

  const commit = () => {
    const trimmed = inputValue.trim();
    const n = Number(trimmed);
    if (
      trimmed !== '' &&
      Number.isFinite(n) &&
      Number.isInteger(n) &&
      n >= def.min &&
      n <= def.max &&
      n !== value
    ) {
      setNumericPref(def.key as NumericPrefKey, n);
    } else {
      setInputValue(String(value));
    }
  };

  return (
    <SettingsRow
      label={def.label}
      description={`${def.description} (${def.min.toLocaleString()}–${def.max.toLocaleString()})`}
      disabled={!gateEnabled}
    >
      <input
        type="number"
        min={def.min}
        max={def.max}
        step={1}
        disabled={!gateEnabled}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        aria-label={def.label}
        data-testid={`settings-numeric-${def.key}`}
        className="w-[72px] rounded-md border border-border-strong bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-fg focus:border-accent focus:outline-none disabled:cursor-not-allowed"
      />
    </SettingsRow>
  );
}
