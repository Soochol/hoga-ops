import { useLivePageStore, type BrokerLateEntrySideMode } from '../../state/livePage';
import { MA_COLOR_ROWS } from './MAStylePicker';

const SIDE_OPTIONS: Array<{ value: BrokerLateEntrySideMode; label: string }> = [
  { value: 'both', label: '둘다' },
  { value: 'buy', label: '매수만' },
  { value: 'sell', label: '매도만' },
];

function ColorGrid({
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
      <div
        aria-hidden="true"
        className="h-6 w-10 rounded border border-border-subtle"
        style={{ backgroundColor: color, borderColor: color }}
      />
      <div>
        <div className="mb-1 text-xs text-fg-dim">{label}</div>
        <div className="flex flex-col gap-1">
          {MA_COLOR_ROWS.map((row, rowIndex) => (
            <div key={`${label}-${rowIndex}`} className="grid grid-cols-8 gap-1">
              {row.map((candidate) => {
                const selected = candidate.toLowerCase() === color.toLowerCase();
                return (
                  <button
                    key={candidate}
                    type="button"
                    aria-label={`${label} ${candidate}`}
                    aria-pressed={selected}
                    className="h-5 w-5 rounded-full"
                    style={{
                      backgroundColor: candidate,
                      outline: selected ? '2px solid var(--fg)' : 'none',
                      outlineOffset: 2,
                      border: '1px solid var(--border-subtle)',
                    }}
                    onClick={() => onChange(candidate)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function BrokerLateEntryConfig() {
  const start = useLivePageStore((s) => s.brokerLateEntryStartHHMM);
  const windowMinutes = useLivePageStore((s) => s.brokerLateEntryWindowMinutes);
  const sideMode = useLivePageStore((s) => s.brokerLateEntrySideMode);
  const buyColor = useLivePageStore((s) => s.brokerLateEntryBuyColor);
  const sellColor = useLivePageStore((s) => s.brokerLateEntrySellColor);
  const setStart = useLivePageStore((s) => s.setBrokerLateEntryStartHHMM);
  const setWindowMinutes = useLivePageStore((s) => s.setBrokerLateEntryWindowMinutes);
  const setSideMode = useLivePageStore((s) => s.setBrokerLateEntrySideMode);
  const setStyle = useLivePageStore((s) => s.setBrokerLateEntryStyle);

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">신규 거래원 등장</h3>
      <div className="mb-3">
        <label className="flex items-center justify-between gap-3 text-sm text-fg">
          <span>기준 시각 (HHMM)</span>
          <input
            type="number"
            min={900}
            max={1520}
            step={1}
            aria-label="신규 거래원 등장 기준 시각"
            className="w-[84px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums"
            value={start}
            onChange={(event) => setStart(Number(event.currentTarget.value))}
          />
        </label>
      </div>
      <div className="mb-3">
        <label className="flex items-center justify-between gap-3 text-sm text-fg">
          <span>부재 시간 (분)</span>
          <input
            type="number"
            min={1}
            max={240}
            step={1}
            aria-label="신규 거래원 등장 부재 시간"
            className="w-[84px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums"
            value={windowMinutes}
            onChange={(event) => setWindowMinutes(Number(event.currentTarget.value))}
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
      <div className="flex flex-col gap-3">
        <ColorGrid label="매수 색상" color={buyColor} onChange={(color) => setStyle({ buyColor: color })} />
        <ColorGrid label="매도 색상" color={sellColor} onChange={(color) => setStyle({ sellColor: color })} />
      </div>
    </div>
  );
}
