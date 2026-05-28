import type { MASource } from '../../chart/projectors/movingAverage';

type Props = {
  value: MASource;
  onChange: (next: MASource) => void;
  'aria-label'?: string;
};

const OPTIONS: ReadonlyArray<[MASource, string]> = [
  ['close', '종가'],
  ['open',  '시가'],
  ['high',  '고가'],
  ['low',   '저가'],
  ['hl2',   'HL2'],
  ['hlc3',  'HLC3'],
  ['ohlc4', 'OHLC4'],
];

export default function MASourceSelect({ value, onChange, ...rest }: Props) {
  return (
    <select
      role="combobox"
      aria-label={rest['aria-label'] ?? 'MA 소스'}
      value={value}
      onChange={(e) => onChange(e.target.value as MASource)}
      className="text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1"
    >
      {OPTIONS.map(([v, label]) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  );
}
