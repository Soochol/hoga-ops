import { useState } from 'react';
import { useWindowIndicators, useIndicatorActions } from '../workspace/windowView';
import MAStylePicker from './MAStylePicker';

export default function SupertrendConfig() {
  const settings = useWindowIndicators();
  const { setSupertrendSettings } = useIndicatorActions();
  const [periodDraft, setPeriodDraft] = useState<{ base: number; text: string } | null>(null);
  const [multiplierDraft, setMultiplierDraft] = useState<{ base: number; text: string } | null>(null);
  const period = periodDraft?.base === settings.supertrendPeriod ? periodDraft.text : String(settings.supertrendPeriod);
  const multiplier = multiplierDraft?.base === settings.supertrendMultiplier ? multiplierDraft.text : String(settings.supertrendMultiplier);
  const commit = () => {
    const p = Number(period), m = Number(multiplier);
    if (period.trim() && Number.isInteger(p) && p >= 1 && p <= 400)
      setSupertrendSettings({ supertrendPeriod: p });
    if (multiplier.trim() && Number.isFinite(m) && m >= 0.1 && m <= 10)
      setSupertrendSettings({ supertrendMultiplier: m });
    setPeriodDraft(null);
    setMultiplierDraft(null);
  };
  const inputClass = 'w-24 text-right text-sm bg-bg-input border border-border rounded-md px-2 py-1 tabular-nums';
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between gap-2 text-sm text-fg">
        ATR 기간 (봉 개수)
        <input aria-label="슈퍼트렌드 기간" type="number" min={1} max={400} step={1}
          value={period} onChange={(e) => setPeriodDraft({ base: settings.supertrendPeriod, text: e.target.value })} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} className={inputClass} />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm text-fg">
        ATR 배수
        <input aria-label="슈퍼트렌드 ATR 배수" type="number" min={0.1} max={10} step={0.1}
          value={multiplier} onChange={(e) => setMultiplierDraft({ base: settings.supertrendMultiplier, text: e.target.value })} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} className={inputClass} />
      </label>
      {([
        ['상승 추세', 'supertrendUpColor'],
        ['하락 추세', 'supertrendDownColor'],
      ] as const).map(([label, key]) => (
        <div key={key} className="flex items-center justify-between gap-2 text-sm text-fg">
          <span>{label}</span>
          <MAStylePicker label={`슈퍼트렌드 ${label}`} color={settings[key]} lineWidth={settings.supertrendLineWidth}
            onChange={(patch) => setSupertrendSettings({
              ...(patch.color ? { [key]: patch.color } : {}),
              ...(patch.lineWidth ? { supertrendLineWidth: patch.lineWidth } : {}),
            })} />
        </div>
      ))}
      <p className="text-xs text-fg-dim">설정한 봉 수가 쌓이면 표시됩니다. 진행 중인 봉의 추세는 바뀔 수 있으며, 두 선의 두께는 함께 적용됩니다.</p>
    </div>
  );
}
