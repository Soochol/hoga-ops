import { useState } from 'react';
import { MA_PERIOD_MIN, MA_PERIOD_MAX } from '../../state/livePage';
import { useWindowIndicators, useIndicatorActions } from '../workspace/windowView';
import MAStylePicker from './MAStylePicker';
import MASourceSelect from './MASourceSelect';

export default function BollingerConfig() {
  const settings = useWindowIndicators();
  const { setBollingerSettings } = useIndicatorActions();
  const [periodDraft, setPeriodDraft] = useState<{ base: number; text: string } | null>(null);
  const [multiplierDraft, setMultiplierDraft] = useState<{ base: number; text: string } | null>(null);
  const period = periodDraft?.base === settings.bollingerPeriod ? periodDraft.text : String(settings.bollingerPeriod);
  const multiplier = multiplierDraft?.base === settings.bollingerMultiplier ? multiplierDraft.text : String(settings.bollingerMultiplier);
  const commit = () => {
    const p = Number(period), m = Number(multiplier);
    if (period.trim() && Number.isInteger(p) && p >= MA_PERIOD_MIN && p <= MA_PERIOD_MAX)
      setBollingerSettings({ bollingerPeriod: p });
    if (multiplier.trim() && Number.isFinite(m) && m >= 0.1 && m <= 10)
      setBollingerSettings({ bollingerMultiplier: m });
    setPeriodDraft(null);
    setMultiplierDraft(null);
  };
  const inputClass = 'w-24 text-right text-sm bg-bg-input border border-border rounded-md px-2 py-1 tabular-nums';
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between gap-2 text-sm text-fg">
        기간 (봉 개수)
        <input aria-label="볼린저 기간" type="number" min={MA_PERIOD_MIN} max={MA_PERIOD_MAX} step={1}
          value={period} onChange={(e) => setPeriodDraft({ base: settings.bollingerPeriod, text: e.target.value })} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} className={inputClass} />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm text-fg">
        표준편차 배수
        <input aria-label="볼린저 표준편차 배수" type="number" min={0.1} max={10} step={0.1}
          value={multiplier} onChange={(e) => setMultiplierDraft({ base: settings.bollingerMultiplier, text: e.target.value })} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} className={inputClass} />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm text-fg">
        기준가
        <MASourceSelect aria-label="볼린저 기준가" value={settings.bollingerSource}
          onChange={(source) => setBollingerSettings({ bollingerSource: source })} />
      </label>
      {([
        ['상단선', 'bollingerUpperColor'],
        ['중심선', 'bollingerMiddleColor'],
        ['하단선', 'bollingerLowerColor'],
      ] as const).map(([label, key]) => (
        <div key={key} className="flex items-center justify-between gap-2 text-sm text-fg">
          <span>{label}</span>
          <MAStylePicker label={`볼린저 ${label}`} color={settings[key]} lineWidth={settings.bollingerLineWidth}
            onChange={(patch) => setBollingerSettings({
              ...(patch.color ? { [key]: patch.color } : {}),
              ...(patch.lineWidth ? { bollingerLineWidth: patch.lineWidth } : {}),
            })} />
        </div>
      ))}
      <p className="text-xs text-fg-dim">중심선은 단순이동평균입니다. 설정한 봉 수가 쌓이면 표시되며, 세 선의 두께는 함께 적용됩니다.</p>
    </div>
  );
}
