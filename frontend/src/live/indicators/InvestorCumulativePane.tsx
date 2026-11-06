import { useCallback, useMemo, type ComponentProps } from 'react';
import RangeSeriesPane from '../../chart/RangeSeriesPane';
import { useInvestorDailyFlow } from '../../api/investorDailyFlow';
import { CUMULATIVE_SPECS, investorCandleDates, type InvestorCumulativeContext } from '../../chart/projectors/investorCumulative';
import { useWindowIndicators } from '../workspace/windowView';
import { useInvestorCumulativeSnapshot } from './useInvestorCumulativeSnapshot';
export function InvestorCumulativePane({ code, subject, ...props }: ComponentProps<typeof RangeSeriesPane> & {
    code: string | null;
    subject: 'foreign' | 'institution';
}) {
    const settings = useWindowIndicators();
    const scope = useMemo(() => ({ code: code ?? '', from: props.bundle.from_date, to: props.bundle.to_date }), [code, props.bundle.from_date, props.bundle.to_date]);
    const query = useInvestorDailyFlow(code && /^[0-9A-Z]{6}$/.test(code) ? scope : null);
    const source = query.data;
    const candleDates = useMemo(() => investorCandleDates(props.bundle), [props.bundle]);
    const snapshot = useInvestorCumulativeSnapshot({ scope, subject, source, candleDates });
    const context: InvestorCumulativeContext = useMemo(() => ({ settings, snapshot }), [settings, snapshot]);
    const spec = useMemo(() => ({ ...CUMULATIVE_SPECS[subject], name: props.spec.name }), [props.spec.name, subject]);
    type Entries = Parameters<NonNullable<typeof props.onLegendReady>>[1];
    const publish = useCallback((name: string, entries: Entries) => {
        props.onLegendReady?.(name, entries.map(entry => ({ ...entry, meta: { ...entry.meta,
                color: () => (subject === 'institution' ? settings.institutionCumulativeColor : settings.foreignCumulativeColor),
            } })));
    }, [props.onLegendReady, (subject === 'institution' ? settings.institutionCumulativeColor : settings.foreignCumulativeColor)]);
    return <RangeSeriesPane {...props} spec={spec} contextOverride={context} onLegendReady={undefined} onDataCommitted={publish}/>;
}
