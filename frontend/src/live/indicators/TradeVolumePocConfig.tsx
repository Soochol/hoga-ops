import { useLivePageStore } from '../../state/livePage';

const BAND_OPTIONS = [
  { label: '±0.5%', value: 0.005 },
  { label: '±1%', value: 0.01 },
] as const;

export default function TradeVolumePocConfig() {
  const bandPct = useLivePageStore((s) => s.tradeVolumePocBandPct);
  const setBandPct = useLivePageStore((s) => s.setTradeVolumePocBandPct);

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">당일 최다거래대</h3>
      <p className="text-fg-dim text-xs mb-3">
        정규장 연속매매 체결량을 가격별로 누적하고, 각 체결가의 자동 ±0.5% 또는 ±1% 호가 보정 범위 중 거래량이 가장 큰 구간을 캔들 위 밴드로 표시합니다. 동시호가 제외.
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
      <div className="text-xs text-fg-dim leading-5">
        <div>범위: 중심 체결가 기준 자동 {bandPct === 0.01 ? '±1%' : '±0.5%'}</div>
        <div>보정: KRX 호가 단위로 하단 내림, 상단 올림</div>
        <div>표시: 가격대 밴드, 중심선, 최초 집중 시점 점</div>
      </div>
    </div>
  );
}
