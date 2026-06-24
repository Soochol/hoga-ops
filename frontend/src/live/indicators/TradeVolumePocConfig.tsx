import { useLivePageStore } from '../../state/livePage';
import { MA_COLOR_ROWS } from './MAStylePicker';

const BAND_OPTIONS = [
  { label: '±0.25%', value: 0.0025 },
  { label: '±0.5%', value: 0.005 },
  { label: '±1%', value: 0.01 },
] as const;

function hexToRgba(hex: string, opacity: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return `rgba(168, 85, 247, ${Math.max(0, Math.min(1, opacity))})`;
  const raw = match[1];
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  const alpha = Math.max(0, Math.min(1, opacity));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function TradeVolumePocConfig() {
  const bandPct = useLivePageStore((s) => s.tradeVolumePocBandPct);
  const color = useLivePageStore((s) => s.tradeVolumePocColor);
  const opacity = useLivePageStore((s) => s.tradeVolumePocOpacity);
  const setBandPct = useLivePageStore((s) => s.setTradeVolumePocBandPct);
  const setStyle = useLivePageStore((s) => s.setTradeVolumePocStyle);
  const opacityPct = Math.round(opacity * 100);
  const selectedBandLabel = BAND_OPTIONS.find((option) => option.value === bandPct)?.label ?? '±0.5%';

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">당일 최대 매물대</h3>
      <p className="text-fg-dim text-xs mb-3">
        정규장 연속매매 체결량을 가격별로 누적하고, 각 체결가의 자동 ±0.25%, ±0.5%, ±1% 호가 보정 범위 중 거래량이 가장 큰 구간을 캔들 위 밴드로 표시합니다. 동시호가 제외.
      </p>
      <div className="mb-3">
        <div className="text-xs text-fg-dim mb-1.5">자동 범위</div>
        <div className="inline-flex rounded-md border border-border-subtle bg-bg-elevated p-0.5">
          {BAND_OPTIONS.map((option) => {
            const selected = bandPct === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                className={[
                  'px-2.5 py-1 text-xs rounded transition-colors',
                  selected
                    ? 'bg-accent text-accent-fg'
                    : 'text-fg-dim hover:text-fg hover:bg-bg-muted',
                ].join(' ')}
                onClick={() => setBandPct(option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mb-3">
        <div className="text-xs text-fg-dim mb-1.5">색상</div>
        <div className="flex items-center gap-2">
          <div
            aria-hidden="true"
            className="h-6 w-10 rounded border border-border-subtle"
            style={{ backgroundColor: hexToRgba(color, opacity), borderColor: color }}
          />
          <div className="flex flex-col gap-1">
            {MA_COLOR_ROWS.map((row, rowIndex) => (
              <div key={rowIndex} className="grid grid-cols-8 gap-1">
                {row.map((candidate) => {
                  const selected = candidate.toLowerCase() === color.toLowerCase();
                  return (
                    <button
                      key={candidate}
                      type="button"
                      aria-label={`당일 최대 매물대 색상 ${candidate}`}
                      aria-pressed={selected}
                      className="h-5 w-5 rounded-full"
                      style={{
                        backgroundColor: candidate,
                        outline: selected ? '2px solid var(--fg)' : 'none',
                        outlineOffset: 2,
                        border: '1px solid var(--border-subtle)',
                      }}
                      onClick={() => setStyle({ color: candidate })}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mb-3">
        <div className="flex items-center justify-between text-xs text-fg-dim mb-1.5">
          <span>투명도</span>
          <span>{opacityPct}%</span>
        </div>
        <input
          type="range"
          min={5}
          max={40}
          step={1}
          value={opacityPct}
          aria-label="당일 최대 매물대 투명도"
          className="w-full"
          onChange={(event) => setStyle({ opacity: Number(event.currentTarget.value) / 100 })}
        />
      </div>
      <div className="text-xs text-fg-dim leading-5">
        <div>범위: 중심 체결가 기준 자동 {selectedBandLabel}</div>
        <div>보정: KRX 호가 단위로 하단 내림, 상단 올림</div>
        <div>표시: 가격대 범위 밴드</div>
      </div>
    </div>
  );
}
