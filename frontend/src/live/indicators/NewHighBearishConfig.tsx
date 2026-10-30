import { useState } from 'react';
import { useIndicatorActions, useWindowIndicators } from '../workspace/windowView';
import MAStylePicker from './MAStylePicker';
import { IndicatorExplanation } from './IndicatorExplanation';

export default function NewHighBearishConfig() {
  const s = useWindowIndicators();
  const { setNewHighBearishSettings } = useIndicatorActions();
  const [draft, setDraft] = useState<{ key: 'newHighBearishLookback' | 'newHighBearishDropPct' | 'newHighBearishMonths'; base: number; text: string; error?: string } | null>(null);
  const inputClass = 'w-24 text-right text-sm bg-bg-input border border-border rounded-md px-2 py-1 tabular-nums';
  return <div className="space-y-3">
    {([
      ['신고가 기준 N거래일', 'newHighBearishLookback', 1, 400, 1],
      ['우측 확장 기간 (개월)', 'newHighBearishMonths', 1, 120, 1],
      ['전일 종가 대비 저가 하락률 (%)', 'newHighBearishDropPct', 0.1, 100, 0.1],
    ] as const).map(([label, key, min, max, step]) => {
      const editing = draft?.key === key && draft.base === s[key];
      const value = editing ? draft.text : String(s[key]);
      const commit = () => {
        const n = Number(value);
        if (!value.trim() || !Number.isFinite(n) || n < min || n > max || (step === 1 && !Number.isInteger(n))) {
          setDraft({ key, base: s[key], text: value, error: `${min}~${max}${step === 1 ? ' 사이의 정수' : ' 사이의 숫자'}를 입력하세요` });
          return;
        }
        setNewHighBearishSettings({ [key]: n }); setDraft(null);
      };
      return <div key={key}>
        <label className="indicator-parameter-row flex items-center justify-between gap-2 text-sm text-fg">
          {label}<input aria-label={label} type="number" min={min} max={max} step={step} value={value}
            aria-invalid={editing && !!draft.error} aria-describedby={editing && draft.error ? `${key}-error` : undefined}
            onChange={e => setDraft({ key, base: s[key], text: e.target.value })} onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); } }} className={inputClass} />
        </label>
        {editing && draft.error && <p id={`${key}-error`} role="alert" className="text-xs text-error">{draft.error}</p>}
      </div>;
    })}
    <label className="indicator-parameter-row flex items-center justify-between gap-2 text-sm text-fg">
      신고가 이후 찾을 음봉 수
      <select aria-label="신고가 이후 찾을 음봉 수" value={s.newHighBearishMaxCount} className={inputClass}
        onChange={e => setNewHighBearishSettings({ newHighBearishMaxCount: Number(e.target.value) as 1 | 2 })}>
        <option value={1}>1개</option><option value={2}>2개</option>
      </select>
    </label>
    <div className="indicator-parameter-row flex items-center justify-between gap-2 text-sm text-fg">
      시가선<MAStylePicker label="신고가 음봉 시가선" color={s.newHighBearishColor} lineWidth={s.newHighBearishLineWidth}
        onChange={patch => setNewHighBearishSettings({ ...(patch.color ? { newHighBearishColor: patch.color } : {}), ...(patch.lineWidth ? { newHighBearishLineWidth: patch.lineWidth } : {}) })} />
    </div>
    <IndicatorExplanation summary="하락률은 양수로 입력합니다.">하락률은 양수로 입력합니다. 신고가 다음 거래일부터 음봉·저가 하락률·종가의 5일선 하회를 모두 만족한 봉을 찾습니다. 5일선에는 해당 봉의 종가를 포함합니다.</IndicatorExplanation>
    <IndicatorExplanation summary="마감된 국내 종목 일봉 전용 · N거래일 선행 자료가 있는 구간부터 계산합니다.">마감된 국내 종목 일봉만 판정합니다. 신고가 갱신 시 개수를 다시 세며 기존 선은 유지합니다. 선은 발생일부터 설정한 개월까지 확장하며, 현재 봉 이후 여백은 기존 그리기 좌표 규칙을 따릅니다. 불러온 일봉에 N거래일의 선행 자료가 있는 구간부터 계산합니다.</IndicatorExplanation>
  </div>;
}
