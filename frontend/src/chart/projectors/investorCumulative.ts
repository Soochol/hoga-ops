import { LineSeries, type LineData, type WhitespaceData, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { DailyFlowSubject, InvestorDailyFlowResponse, DailyFlowRequestScope } from '../../api/investorDailyFlow';
import type { RangeBundle } from '../../api/types';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import { lineVisible } from '../../state/indicatorLineVisibility';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { BoundPaneSpec } from '../paneSpecs';
import { LINE_HIDDEN_COLOR } from '../util/auctionHide';
import { addZeroBaselineGuide, includeZeroAutoscale } from '../util/zeroBaseline';
import { resolveTokensThemed } from '../../util/tokens';
import { formatKoreanInt } from '../../util/koreanNumber';
export type InvestorCumulativePoint = {
    date: string;
    t_ms: number;
} & ({
    kind: 'value';
    shares: number;
} | {
    kind: 'gap';
});
export type InvestorCumulativeSnapshot = {
    kind: 'empty';
    scope: DailyFlowRequestScope;
    points: readonly InvestorCumulativePoint[];
} | {
    kind: 'anchored';
    scope: DailyFlowRequestScope;
    anchorDate: string;
    partial: boolean;
    points: readonly InvestorCumulativePoint[];
};
export function investorCandleDates(bundle: RangeBundle): {
    date: string;
    t_ms: number;
}[] {
    return bundle.candles.map(candle => ({ date: new Date(candle.ts_ms + 9 * 3600000).toISOString().slice(0, 10).replaceAll('-', ''), t_ms: candle.ts_ms }));
}
export function buildInvestorCumulative({ source, candleDates, subject }: {
    source: InvestorDailyFlowResponse;
    subject: DailyFlowSubject;
    candleDates: readonly {
        date: string;
        t_ms: number;
    }[];
}): InvestorCumulativeSnapshot {
    const scope = { code: source.code, from: source.from, to: source.to };
    const byDate = new Map<string, {
        date: string;
        t_ms: number;
        net_shares: number | null;
    }>();
    for (const observation of source.observations) {
        const point = { date: observation.date, t_ms: observation.t_ms, net_shares: subject === 'institution' ? observation.institution_net_shares : observation.foreign_net_shares };
        if (point.date < source.from || point.date > source.to)
            continue;
        const previous = byDate.get(point.date);
        byDate.set(point.date, previous && previous.net_shares !== point.net_shares ? { ...point, net_shares: null } : point);
    }
    const anchor = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).find(point => point.net_shares !== null && Number.isSafeInteger(point.net_shares));
    if (!anchor)
        return { kind: 'empty', scope, points: [] };
    const grid = new Map(candleDates.filter(point => point.date >= source.from && point.date <= source.to).map(point => [point.date, point]));
    for (const point of byDate.values())
        if (!grid.has(point.date))
            grid.set(point.date, point);
    let shares = 0;
    let tainted = source.unlocated_defect || source.pagination !== 'covered';
    let partial = tainted || source.data_warnings.some(issue => issue.subject === null || issue.subject === subject);
    const points: InvestorCumulativePoint[] = [];
    for (const point of [...grid.values()].sort((a, b) => a.date.localeCompare(b.date))) {
        if (point.date < anchor.date) {
            points.push({ ...point, kind: 'gap' });
            continue;
        }
        if (point.date === anchor.date) {
            points.push({ date: point.date, t_ms: point.t_ms, kind: 'value', shares: 0 });
            continue;
        }
        const value = byDate.get(point.date)?.net_shares;
        if (value === undefined || value === null || !Number.isSafeInteger(value) || !Number.isSafeInteger(shares + value))
            tainted = true;
        if (tainted) {
            partial = true;
            points.push({ date: point.date, t_ms: point.t_ms, kind: 'gap' });
        }
        else {
            shares += value ?? 0;
            points.push({ date: point.date, t_ms: point.t_ms, kind: 'value', shares });
        }
    }
    return { kind: 'anchored', scope, anchorDate: anchor.date, partial, points };
}
export interface InvestorCumulativeContext {
    settings: IndicatorSettings;
    snapshot: InvestorCumulativeSnapshot;
}
export function projectInvestorCumulative(bundle: RangeBundle, axis: VirtualAxis, context: InvestorCumulativeContext): (LineData<Time> | WhitespaceData<Time>)[] {
    const byTime = new Map(context.snapshot.points.map(point => [point.t_ms, point]));
    const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
    let previous: number | null = null;
    for (const candle of bundle.candles) {
        if (!axis.contains(candle.ts_ms))
            continue;
        const time = axis.toVirtual(candle.ts_ms) / 1000 as UTCTimestamp;
        const point = byTime.get(candle.ts_ms);
        if (!point || point.kind === 'gap') {
            if (previous !== null)
                out[previous] = { ...out[previous], ...LINE_HIDDEN_COLOR };
            out.push({ time });
            previous = null;
        }
        else {
            out.push({ time, value: point.shares });
            previous = out.length - 1;
        }
    }
    return out;
}
export const formatCumulativeShares = (value: number) => `${formatKoreanInt(value)}주`;
export const CUMULATIVE_SPECS = {
    institution: cumulativeSpec('institution'),
    foreign: cumulativeSpec('foreign'),
};
function cumulativeSpec(subject: DailyFlowSubject): BoundPaneSpec<InvestorCumulativeContext> {
    const label = subject === 'institution' ? '기관 누적 순매수' : '외국인 누적 순매수';
    const colorKey = subject === 'institution' ? 'institutionCumulativeColor' : 'foreignCumulativeColor';
    const widthKey = subject === 'institution' ? 'institutionCumulativeWidth' : 'foreignCumulativeWidth';
    const visibility = subject === 'institution' ? 'institutionCumulative' : 'foreignCumulative';
    return {
        name: subject === 'institution' ? 'institution-cumulative' : 'foreign-cumulative', bundleKind: 'candle', stretch: 0.5,
        legendTitle: label, legendToggleKey: subject === 'institution' ? 'institutionCumulativeEnabled' : 'foreignCumulativeEnabled',
        series: [{ type: LineSeries, options: { priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false, autoscaleInfoProvider: includeZeroAutoscale },
                renderOptions: ({ settings }) => ({ color: settings[colorKey],
                    crosshairMarkerBackgroundColor: settings[colorKey], lineWidth: settings[widthKey],
                    visible: lineVisible(settings.indicatorLineVisibility, visibility),
                    priceFormat: { type: 'custom', formatter: formatCumulativeShares, minMove: 1 } }),
                afterAdd: series => addZeroBaselineGuide(series, resolveTokensThemed({ baseline: ['--fg-dimmer', '#64748B'] }).baseline),
                data: projectInvestorCumulative, legend: { labelRole: 'pane', label: `${label}(주)`, format: formatCumulativeShares } }],
    };
}
