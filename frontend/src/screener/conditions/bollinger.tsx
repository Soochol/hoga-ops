import type { BollingerBreakoutParams, BollingerBreakoutPeriodParams, MaSource } from '../../api/screener';
import { CandleSettings } from '../CandleSettings';
import { candleSummary } from '../candleLabels';
import { ConditionChoice, ConditionFields } from '../ConditionControls';
import { Num, Select } from '../paramForms';
import type { CatalogEntry } from './types';

const PRICES: [MaSource, string][] = [['open', '시가'], ['high', '고가'], ['low', '저가'], ['close', '종가']];
const PRICE_LABEL = { open: '시가', high: '고가', low: '저가', close: '종가' };
const DEFAULTS: BollingerBreakoutParams = { period: 20, multiplier: 2, source: 'close', band_source: 'close', band: 'upper' };

type BollingerMode = 'breakout' | 'position';

function summary(p: BollingerBreakoutParams, mode: BollingerMode = 'breakout') {
  if (mode === 'position') return `${PRICE_LABEL[p.source]} · ${p.band === 'upper' ? '상단 밴드 위' : '하단 밴드 아래'} · BB(${p.period}, ${p.multiplier}, ${PRICE_LABEL[p.band_source]})`;
  return `${PRICE_LABEL[p.source]} · ${p.band === 'upper' ? '상단 상향' : '하단 하향'}돌파 · BB(${p.period}, ${p.multiplier}, ${PRICE_LABEL[p.band_source]})`;
}

function BollingerFields({ params, onChange, mode }: {
  mode: BollingerMode;
  params: BollingerBreakoutParams; onChange: (patch: Partial<BollingerBreakoutParams>) => void;
}) {
  return <>
    <Select label={mode === 'position' ? '비교가격' : '돌파 비교가격'} caption="가격" value={params.source} onChange={source => onChange({ source })} options={PRICES} />
    <ConditionChoice label={mode === 'position' ? '위치' : '돌파 밴드'} caption={mode === 'position' ? '위치' : '밴드'} value={params.band} onChange={band => onChange({ band })}
      options={mode === 'position'
        ? [[ 'upper', '상단 밴드 위' ], [ 'lower', '하단 밴드 아래' ]]
        : [[ 'upper', '상단 상향돌파' ], [ 'lower', '하단 하향돌파' ]]} />
    <ConditionFields>
      <Num label="기간" ariaLabel="볼린저 기간" step={1} min={2} max={1000} suffix="봉" value={params.period}
        onChange={period => onChange({ period: period ?? 20 })} />
      <Num label="편차" ariaLabel="표준편차 배수" step={0.1} min={0.1} max={10} suffix="배" value={params.multiplier}
        onChange={multiplier => onChange({ multiplier: multiplier ?? 2 })} />
    </ConditionFields>
    <Select label="밴드 계산가격" caption="계산" value={params.band_source}
      onChange={band_source => onChange({ band_source })} options={PRICES} />
  </>;
}

function BollingerTodayForm({ params, onChange, mode = 'breakout' }: {
  mode?: BollingerMode;
  params: BollingerBreakoutParams; onChange: (p: BollingerBreakoutParams) => void;
}) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <BollingerFields mode={mode} params={params} onChange={patch => onChange({ ...params, ...patch })} />
  </CandleSettings>;
}

function BollingerPeriodForm({ params, onChange, mode = 'breakout' }: {
  mode?: BollingerMode;
  params: BollingerBreakoutPeriodParams; onChange: (p: BollingerBreakoutPeriodParams) => void;
}) {
  const daily = (params.timeframe ?? 'D') === 'D';
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <Num label="최근" ariaLabel="볼린저 최근 기간" suffix={daily ? '거래일 이내' : '봉 이내'}
      step={1} min={1} max={1000} value={params.lookback} onChange={lookback => onChange({ ...params, lookback: lookback ?? 1 })} />
    <BollingerFields mode={mode} params={params} onChange={patch => onChange({ ...params, ...patch })} />
  </CandleSettings>;
}

export const bollinger_breakout_today: CatalogEntry<'bollinger_breakout_today'> = {
  help: '최신 봉에서 발생한 돌파를 찾습니다. 직전 봉의 선택 가격이 밴드 안쪽·경계에 있다가 이번 봉에서 바깥으로 넘어간 경우만 충족하며 각 봉 시점의 밴드와 비교합니다.',
  label: '볼린저밴드 돌파', defaultParams: DEFAULTS, ParamForm: BollingerTodayForm,
  summarize: p => candleSummary(p, `최신 · ${summary(p)}`),
};

export const bollinger_breakout: CatalogEntry<'bollinger_breakout'> = {
  help: '최신 봉을 포함한 기간에 한 번 이상 발생한 돌파를 찾습니다. 직전 봉의 선택 가격이 밴드 안쪽·경계에 있다가 이번 봉에서 바깥으로 넘어간 경우만 충족하며 각 봉 시점의 밴드와 비교합니다.',
  label: '기간내 볼린저밴드 돌파', defaultParams: { ...DEFAULTS, lookback: 5 }, ParamForm: BollingerPeriodForm,
  summarize: p => candleSummary(p, `${p.lookback}봉내 · ${summary(p)}`),
};

export const bollinger_position_today: CatalogEntry<'bollinger_position_today'> = {
  help: '최신 봉의 선택 가격이 해당 봉의 상단 밴드를 초과하거나 하단 밴드 미만이면 충족합니다. 같은 값은 제외하며 직전 봉의 위치는 보지 않습니다.',
  label: '볼린저밴드 위·아래', defaultParams: DEFAULTS,
  ParamForm: props => <BollingerTodayForm {...props} mode="position" />,
  summarize: p => candleSummary(p, `최신 · ${summary(p, 'position')}`),
};

export const bollinger_position: CatalogEntry<'bollinger_position'> = {
  help: '최신 봉을 포함한 기간에 한 번 이상 선택 가격이 해당 봉의 상단 밴드를 초과하거나 하단 밴드 미만이면 충족합니다. 같은 값은 제외하며 직전 봉의 위치는 보지 않습니다.',
  label: '기간내 볼린저밴드 위·아래', defaultParams: { ...DEFAULTS, lookback: 5 },
  ParamForm: props => <BollingerPeriodForm {...props} mode="position" />,
  summarize: p => candleSummary(p, `${p.lookback}봉내 · ${summary(p, 'position')}`),
};
