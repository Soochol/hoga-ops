// frontend/src/live/settings/NumericPrefRow.tsx
import { useEffect, useState } from 'react';
import {
  useChartPrefsStore,
  type NumericPrefDef,
  type NumericPrefKey,
} from '../../state/chartPrefs';

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
    <div
      className={
        gateEnabled
          ? 'flex items-center justify-between py-2'
          : 'flex items-center justify-between py-2 opacity-50'
      }
    >
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">{def.label}</div>
        <div className="text-fg-dim text-xs mt-0.5">
          {def.description} ({def.min.toLocaleString()}–{def.max.toLocaleString()})
        </div>
      </div>
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
    </div>
  );
}
