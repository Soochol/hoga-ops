import { useLivePageStore } from '../../state/livePage';
import { MA_COLOR_ROWS } from './MAStylePicker';

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
  const color = useLivePageStore((s) => s.tradeVolumePocColor);
  const opacity = useLivePageStore((s) => s.tradeVolumePocOpacity);
  const rangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const setStyle = useLivePageStore((s) => s.setTradeVolumePocStyle);
  const opacityPct = Math.round(opacity * 100);

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">당일 최대 매물대</h3>
      <p className="text-fg-dim text-xs mb-3">
        정규장 연속매매 체결량을 연속체결 매물대 분포와 동일한 가격 구간에 누적하고, 거래량이 가장 큰 구간을 캔들 위 밴드로 표시합니다. 동시호가 제외.
      </p>
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
                        outline: selected ? '2px solid var(--fg)' : undefined,
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
        <div>범위: 연속체결 매물대 분포와 동일한 {rangeCount}개 가격 구간</div>
        <div>선택: 체결량이 가장 큰 max bar 구간</div>
        <div>표시: 가격대 범위 밴드</div>
      </div>
    </div>
  );
}
