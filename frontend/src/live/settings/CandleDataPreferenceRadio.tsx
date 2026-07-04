import {
  getCandleDataPreferenceLabel,
  useCandleDataPreferenceStore,
  type CandleDataPreference,
} from '../../state/candleDataPreference';

export default function CandleDataPreferenceRadio({ value }: { value: CandleDataPreference }) {
  const current = useCandleDataPreferenceStore((s) => s.candleDataPreference);
  const setPref = useCandleDataPreferenceStore((s) => s.setCandleDataPreference);
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
      <input
        type="radio"
        name="candle-data-preference"
        value={value}
        checked={current === value}
        onChange={() => setPref(value)}
      />
      <span>{getCandleDataPreferenceLabel(value)}</span>
    </label>
  );
}
