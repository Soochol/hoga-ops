// frontend/src/live/settings/NumericPrefRow.tsx
import { useEffect, useState } from 'react';
import {
  useChartPrefsStore,
  type NumericPrefDef,
  type NumericPrefKey,
} from '../../state/chartPrefs';
import { SettingsRow } from './SettingsRow';

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
        className="w-[72px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums disabled:cursor-not-allowed"
      />
    </SettingsRow>
  );
}
