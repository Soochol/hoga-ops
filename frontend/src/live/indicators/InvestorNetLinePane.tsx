import { useMemo, useCallback, type ComponentProps } from 'react';
import RangeSeriesPane from '../../chart/RangeSeriesPane';
import { useLivePastInvestorNet, investorDailyFlowForScope } from '../../api/livePastInvestorNet';

export function InvestorNetLinePane({ code, ...props }: ComponentProps<typeof RangeSeriesPane> & { code: string | null }) {
  const stock = code && /^[0-9A-Z]{6}$/.test(code) ? code : null;
  const scope = props.bundle.investorRequestScope ?? { code: stock ?? '', from: props.bundle.from_date, to: props.bundle.to_date };
  const query = useLivePastInvestorNet(stock, scope.from, scope.to, 'qty', 'net');
  const bundle = useMemo(() => {
    return { ...props.bundle, investorDailyFlow: stock ? investorDailyFlowForScope(query.data, scope) : props.bundle.investorDailyFlow,
      investorTradeSide: 'net' as const, institutionInvestorTradeSide: 'net' as const };
  }, [props.bundle, stock, query.data, scope.code, scope.from, scope.to]);
  const onLegendReady = useCallback<NonNullable<typeof props.onLegendReady>>((name, entries) => {
    props.onLegendReady?.(name, entries.map(entry => ({ ...entry, meta: { ...entry.meta, color: () => {
      const options = entry.series.options();
      return 'color' in options && typeof options.color === 'string' ? options.color : '';
    } } })));
  }, [props.onLegendReady]);
  return <RangeSeriesPane {...props} bundle={bundle} onLegendReady={onLegendReady} />;
}
