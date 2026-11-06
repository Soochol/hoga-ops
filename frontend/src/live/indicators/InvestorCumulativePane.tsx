import { useCallback, useMemo, type ComponentProps } from 'react';
import RangeSeriesPane from '../../chart/RangeSeriesPane';
import { useInvestorDailyFlow } from '../../api/investorDailyFlow';
import { CUMULATIVE_SPECS, buildInvestorCumulative, investorCandleDates, type InvestorCumulativeContext } from '../../chart/projectors/investorCumulative';
import { useWindowIndicators } from '../workspace/windowView';
export function InvestorCumulativePane({ code, subject, ...props }: ComponentProps<typeof RangeSeriesPane> & {
    code: string | null;
    subject: 'foreign' | 'institution';
}) {
    const settings = useWindowIndicators();
    const scope = useMemo(() => ({ code: code ?? '', from: props.bundle.from_date, to: props.bundle.to_date }), [code, props.bundle.from_date, props.bundle.to_date]);
    const query = useInvestorDailyFlow(code && /^[0-9A-Z]{6}$/.test(code) ? scope : null);
    const source = query.data;
    const context: InvestorCumulativeContext = useMemo(() => ({ settings,
        snapshot: source ? buildInvestorCumulative({ source, subject, candleDates: investorCandleDates(props.bundle) }) : { kind: 'empty', scope, points: [] },
    }), [settings, source, props.bundle, scope, subject]);
    const snapshot = context.snapshot;
    const failureStatus = source ? '조회 실패 · 마지막 조회자료 유지' : '조회 실패 · 재시도 필요';
    const status = query.isError ? failureStatus : query.isFetching ? '조회 중'
        : !source ? '자료 미확인' : source.data_warnings.some(issue => issue.reason === 'unavailable') ? '공급자 사용 불가'
            : source.pagination === 'incomplete' ? `일부 자료 · ${source.pages_observed}페이지 확인 · 기준일 이후 합계 미확인`
                : snapshot.kind === 'empty' ? '해당 구간 자료 없음' : snapshot.partial ? '일부 자료 · 누락 이후 합계 미확인' : '조회 완료';
    const spec = useMemo(() => ({ ...CUMULATIVE_SPECS[subject], name: props.spec.name }), [props.spec.name, subject]);
    type Entries = Parameters<NonNullable<typeof props.onLegendReady>>[1];
    const publish = useCallback((name: string, entries: Entries) => {
        props.onLegendReady?.(name, entries.map(entry => ({ ...entry, meta: { ...entry.meta, notice: status,
                retry: query.isFetching ? undefined : () => { void query.refetch(); },
                color: () => (subject === 'institution' ? settings.institutionCumulativeColor : settings.foreignCumulativeColor),
            } })));
    }, [props.onLegendReady, status, query.isFetching, query.refetch, (subject === 'institution' ? settings.institutionCumulativeColor : settings.foreignCumulativeColor)]);
    return <RangeSeriesPane {...props} spec={spec} contextOverride={context} onLegendReady={undefined} onDataCommitted={publish}/>;
}
