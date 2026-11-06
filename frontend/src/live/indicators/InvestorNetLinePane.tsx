import { useMemo, useCallback, type ComponentProps } from 'react';
import RangeSeriesPane from '../../chart/RangeSeriesPane';
import { useLivePastInvestorNet } from '../../api/livePastInvestorNet';

export function InvestorNetLinePane({ code, ...props }: ComponentProps<typeof RangeSeriesPane> & { code: string | null }) {
  const stock = code && /^[0-9A-Z]{6}$/.test(code) ? code : null;
  const query = useLivePastInvestorNet(stock, props.bundle.from_date, props.bundle.to_date, 'qty', 'net');
  const bundle = useMemo(() => {
    const response = query.data;
    const valid = response && response.code === stock && response.from === props.bundle.from_date && response.to === props.bundle.to_date
      && (response.trade_side ?? 'net') === 'net' && (response.unit === undefined || response.unit === 'qty_shares');
    return { ...props.bundle, investorPoints: valid ? response.points : [], investorTradeSide: 'net' as const };
  }, [props.bundle, stock, query.data]);
  const onLegendReady = useCallback<NonNullable<typeof props.onLegendReady>>((name, entries) => {
    props.onLegendReady?.(name, entries.map(entry => ({ ...entry, meta: { ...entry.meta, color: () => {
      const options = entry.series.options();
      return 'color' in options && typeof options.color === 'string' ? options.color : '';
    } } })));
  }, [props.onLegendReady]);
  return <RangeSeriesPane {...props} bundle={bundle} onLegendReady={onLegendReady} />;
}
