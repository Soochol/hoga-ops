import { useState } from 'react';
import LineVisibilityRow from './LineVisibilityRow';
import { MA_PERIOD_MIN, MA_PERIOD_MAX } from '../../state/livePage';
import { useWindowIndicators, useIndicatorActions } from '../workspace/windowView';
import MAStylePicker from './MAStylePicker';
import MASourceSelect from './MASourceSelect';
import { IndicatorExplanation } from './IndicatorExplanation';

export default function EnvelopeConfig() {
  const settings = useWindowIndicators();
  const { setEnvelopeSettings } = useIndicatorActions();
  const [periodDraft, setPeriodDraft] = useState<{ base: number; text: string } | null>(null);
  const [percentDraft, setPercentDraft] = useState<{ base: number; text: string } | null>(null);
  const period = periodDraft?.base === settings.envelopePeriod ? periodDraft.text : String(settings.envelopePeriod);
  const percent = percentDraft?.base === settings.envelopePercent ? percentDraft.text : String(settings.envelopePercent);
  const commit = () => {
    const p = Number(period), m = Number(percent);
    if (period.trim() && Number.isInteger(p) && p >= MA_PERIOD_MIN && p <= MA_PERIOD_MAX)
      setEnvelopeSettings({ envelopePeriod: p });
    if (percent.trim() && Number.isFinite(m) && m >= 0.1 && m <= 100)
      setEnvelopeSettings({ envelopePercent: m });
    setPeriodDraft(null);
    setPercentDraft(null);
  };
  const inputClass = 'w-24 text-right text-sm bg-bg-input border border-border rounded-md px-2 py-1 tabular-nums';
  return (
    <div className="space-y-3">
      <label className="indicator-parameter-row flex items-center justify-between gap-2 text-sm text-fg">
        기간 (봉 개수)
        <input aria-label="엔벨로프 기간" type="number" min={MA_PERIOD_MIN} max={MA_PERIOD_MAX} step={1}
          value={period} onChange={(e) => setPeriodDraft({ base: settings.envelopePeriod, text: e.target.value })} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} className={inputClass} />
      </label>
      <label className="indicator-parameter-row flex items-center justify-between gap-2 text-sm text-fg">
        이격률 (%)
        <input aria-label="엔벨로프 이격률 (%)" type="number" min={0.1} max={100} step={0.1}
          value={percent} onChange={(e) => setPercentDraft({ base: settings.envelopePercent, text: e.target.value })} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} className={inputClass} />
      </label>
      <label className="indicator-parameter-row flex items-center justify-between gap-2 text-sm text-fg">
        기준가
        <MASourceSelect aria-label="엔벨로프 기준가" value={settings.envelopeSource}
          onChange={(source) => setEnvelopeSettings({ envelopeSource: source })} />
      </label>
      {([
        ['상단선', 'envelopeUpperColor', 'envelopeUpper'],
        ['중심선', 'envelopeMiddleColor', 'envelopeMiddle'],
        ['하단선', 'envelopeLowerColor', 'envelopeLower'],
      ] as const).map(([label, key, lineKey]) => (
        <LineVisibilityRow key={key} lineKey={lineKey} label={label} toggleLabel={`엔벨로프 ${label} 표시`}>
          <MAStylePicker label={`엔벨로프 ${label}`} color={settings[key]} lineWidth={settings.envelopeLineWidth}
            onChange={(patch) => setEnvelopeSettings({
              ...(patch.color ? { [key]: patch.color } : {}),
              ...(patch.lineWidth ? { envelopeLineWidth: patch.lineWidth } : {}),
            })} />
        </LineVisibilityRow>
      ))}
      <IndicatorExplanation summary="세 선의 두께는 함께 적용됩니다.">중심선은 단순이동평균이며 상·하단선은 중심선에서 이격률(%)만큼 떨어져 있습니다. 설정한 봉 수가 쌓이면 표시되며, 세 선의 두께는 함께 적용됩니다.</IndicatorExplanation>
    </div>
  );
}
