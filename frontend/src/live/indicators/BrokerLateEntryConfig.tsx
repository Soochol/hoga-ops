import { useLivePageStore, type BrokerLateEntrySideMode } from '../../state/livePage';
import ColorSwatchPicker from './ColorSwatchPicker';
import TimeOfDayInput from '../settings/TimeOfDayInput';

const SIDE_OPTIONS: Array<{ value: BrokerLateEntrySideMode; label: string }> = [
  { value: 'both', label: '둘다' },
  { value: 'buy', label: '매수만' },
  { value: 'sell', label: '매도만' },
];

function ColorRow({
  label,
  color,
  onChange,
}: {
  label: string;
  color: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-sm text-fg">{label}</span>
      <ColorSwatchPicker label={label} color={color} onChange={onChange} />
    </div>
  );
}

export default function BrokerLateEntryConfig() {
  const start = useLivePageStore((s) => s.brokerLateEntryStartHHMM);
  const sideMode = useLivePageStore((s) => s.brokerLateEntrySideMode);
  const buyColor = useLivePageStore((s) => s.brokerLateEntryBuyColor);
  const sellColor = useLivePageStore((s) => s.brokerLateEntrySellColor);
  const setStart = useLivePageStore((s) => s.setBrokerLateEntryStartHHMM);
  const setSideMode = useLivePageStore((s) => s.setBrokerLateEntrySideMode);
  const setStyle = useLivePageStore((s) => s.setBrokerLateEntryStyle);

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">신규 거래원 등장</h3>
      <div className="mb-3">
        <label className="flex items-center justify-between gap-3 text-sm text-fg">
          <span>기준 시각</span>
          <TimeOfDayInput
            hhmm={start}
            onCommit={setStart}
            ariaLabel="신규 거래원 등장 기준 시각"
          />
        </label>
      </div>
      <div className="mb-3">
        <div className="mb-1.5 text-xs text-fg-dim">표시 방향</div>
        <div className="inline-flex rounded border border-border overflow-hidden">
          {SIDE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={sideMode === option.value}
              className={`px-3 py-1 text-sm ${sideMode === option.value ? 'bg-bg-input text-fg' : 'text-fg-dim hover:bg-bg-input'}`}
              onClick={() => setSideMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <ColorRow label="매수 색상" color={buyColor} onChange={(color) => setStyle({ buyColor: color })} />
        <ColorRow label="매도 색상" color={sellColor} onChange={(color) => setStyle({ sellColor: color })} />
      </div>
    </div>
  );
}
