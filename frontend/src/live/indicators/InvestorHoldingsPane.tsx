import { useCallback, useEffect, useMemo, useRef, type ComponentProps } from 'react';
import RangeSeriesPane from '../../chart/RangeSeriesPane';
import { useInvestorHoldings } from '../../api/investorHoldings';
import { INVESTOR_HOLDINGS_SPEC, type HoldingsPaneContext } from '../../chart/projectors/investorHoldings';
import { useWindowIndicators } from '../workspace/windowView';

export function InvestorHoldingsPane({ code, ...props }: ComponentProps<typeof RangeSeriesPane> & { code: string | null }) {
  const settings = useWindowIndicators();
  const stock = code && /^[0-9A-Z]{6}$/.test(code) ? code : null;
  const query = useInvestorHoldings(stock, props.bundle.from_date, props.bundle.to_date);
  const response = query.data;
  const valid = response?.code === stock && response.from === props.bundle.from_date && response.to === props.bundle.to_date
    && response.source === 'kiwoom_ka10008' && response.provider_scope === 'KRX';
  const context: HoldingsPaneContext = useMemo(() => ({ settings, metric: settings.investorHoldingsMetric,
    points: valid && response ? response.observations : [] }), [settings, valid, response]);
  const spec = useMemo(() => ({ ...INVESTOR_HOLDINGS_SPEC, name: props.spec.name }), [props.spec.name]);
  const status = query.isError ? '조회 실패 · 다시 조회 필요'
    : !valid || !response ? '조회 중'
    : response.data_warnings.some(w => w.reason === 'unavailable') ? '공급자 사용 불가'
    : `${response.partial ? '일부 자료 · ' : ''}${response.observations.length ? `최근 자료 ${response.observations[response.observations.length - 1].date}` : response.partial ? '해당 구간 자료 미확인' : '해당 구간 자료 없음'}${response.data_warnings.length ? ` · ${response.data_warnings.map(w => w.message).join(' ')}` : ''}`;
  const notice = `키움 · KRX · ${status} · 기관 미지원`;
  type Entries = Parameters<NonNullable<typeof props.onLegendReady>>[1];
  const entriesRef = useRef<Entries>([]);
  const publishLegend = useCallback((name: string, entries: Entries) => {
    entriesRef.current = entries;
    props.onLegendReady?.(name, entries.map(entry => ({ ...entry, meta: { ...entry.meta, notice, label: settings.investorHoldingsMetric === 'quantity' ? '외국인(주)' : '외국인(%)',
      format: value => entry.series.priceFormatter().format(value), retry: query.isFetching ? undefined : () => { void query.refetch(); },
      color: () => { const options = entry.series.options(); return 'color' in options && typeof options.color === 'string' ? options.color : ''; },
    } })));
  }, [props.onLegendReady, notice, query.isFetching, query.refetch, settings.investorHoldingsMetric]);
  useEffect(() => {
    if (entriesRef.current.length) publishLegend(spec.name, entriesRef.current);
  }, [publishLegend, spec.name]);
  return <RangeSeriesPane {...props} spec={spec} contextOverride={context} onLegendReady={publishLegend} />;
}
