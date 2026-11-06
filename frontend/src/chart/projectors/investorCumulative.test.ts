import { describe, expect, it } from 'vitest';
import cases from './fixtures/cumulative-oracle-cases.json';
import { buildInvestorCumulative, projectInvestorCumulative } from './investorCumulative';
import { parseInvestorDailyFlow, type InvestorDailyFlowResponse } from '../../api/investorDailyFlow';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { buildIndexBundle } from '../../live/buildIndexBundle';
import { createVirtualAxis } from '../../util/virtualAxis';
import { captureIndicatorSettings, makeIndicatorInstance, normalizeIndicatorInstances } from '../../state/indicatorInstances';
import { mergeLiveIndicatorPrefs } from '../../state/liveIndicatorsPersistence';
import { indicatorInstanceApplicable } from '../../live/indicators/indicatorInstancePanes';
import { DEFAULT_PREFS } from '../../state/chartPrefs';
const ms = (date: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`);
const grid = (dates: string[]) => dates.map(date => ({ date, t_ms: ms(date) }));
function source(dates: string[], values: (number | null)[]): InvestorDailyFlowResponse {
    return { code: '005930', from: dates[0], to: dates[dates.length - 1], source: 'kiwoom_ka10059', provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net',
        observations: grid(dates).map((point, i) => ({ ...point, institution_net_shares: values[i], foreign_net_shares: values[i] })),
        pagination: 'covered', unlocated_defect: false, pages_observed: 1, can_continue: false, data_warnings: [] };
}
const values = (input: ReturnType<typeof buildInvestorCumulative>) => input.points.map(point => point.kind === 'value' ? point.shares : null);
describe('dynamic loaded-first-day cumulative shares', () => {
    it.each(cases.cases)('matches independent oracle $name', fixture => {
        for (const subject of ['foreign', 'institution'] as const) {
            expect(values(buildInvestorCumulative({ subject, source: source(fixture.dates, fixture.observed), candleDates: grid(fixture.dates) }))).toEqual(fixture.expected);
        }
    });
    it('counts source-only days before clipping to candle/axis dates', () => {
        const dates = ['20260105', '20260106', '20260107'];
        const snapshot = buildInvestorCumulative({ subject: 'institution', source: source(dates, [8, 5, -2]), candleDates: grid([dates[0], dates[2]]) });
        const axis = createVirtualAxis(grid([dates[0], dates[2]]).map(point => ({ date: point.date, sessionOpenMs: point.t_ms, sessionCloseMs: point.t_ms + 23400000 })));
        const bundle = buildIndexBundle({ indexId: 'KOSPI', from: dates[0], to: dates[2], bucketMs: 86400000, candles: [dates[0], dates[2]].map(date => ({ t_ms: ms(date), open: 100, high: 110, low: 90, close: 105, volume: 10 })) });
        const output = projectInvestorCumulative(bundle, axis, { settings: FACTORY_INDICATOR_SETTINGS, snapshot });
        expect(output.map(point => 'value' in point ? point.value : null)).toEqual([0, 3]);
        expect(snapshot).toMatchObject({ kind: 'anchored', anchorDate: dates[0] });
    });
    it('missing candle-date row taints whole suffix and never restarts', () => {
        const dates = ['20260105', '20260106', '20260107', '20260108'];
        const data = source(dates, [10, 20, 30, 40]);
        data.observations.splice(1, 1);
        expect(values(buildInvestorCumulative({ subject: 'foreign', source: data, candleDates: grid(dates) }))).toEqual([0, null, null, null]);
    });
    it('incomplete or unlocated source keeps only anchor zero until coherent completion', () => {
        const dates = ['20260105', '20260106', '20260107'];
        for (const extra of [{ pagination: 'incomplete' as const }, { unlocated_defect: true }]) {
            expect(values(buildInvestorCumulative({ subject: 'institution', source: { ...source(dates, [10, 20, 30]), ...extra }, candleDates: grid(dates) }))).toEqual([0, null, null]);
        }
    });
    it('unsafe running sums and same-date conflicts cannot become visible values', () => {
        const dates = ['20260105', '20260106', '20260107'];
        expect(values(buildInvestorCumulative({ subject: 'institution', source: source(dates, [0, Number.MAX_SAFE_INTEGER, 1]), candleDates: grid(dates) }))).toEqual([0, Number.MAX_SAFE_INTEGER, null]);
        const data = source(dates, [0, 1, 2]);
        data.observations.push({ ...data.observations[1], institution_net_shares: 2 });
        expect(values(buildInvestorCumulative({ subject: 'institution', source: data, candleDates: grid(dates) }))).toEqual([0, null, null]);
    });
    it('subject-specific missing components do not taint the other actor and may choose different anchors', () => {
        const dates = ['20260105', '20260106', '20260107'];
        const data = source(dates, [10, 20, 30]);
        data.observations[0].foreign_net_shares = null;
        data.data_warnings = [{ reason: 'invalid_row', date: dates[0], subject: 'foreign', message: 'missing component' }];
        const institution = buildInvestorCumulative({ subject: 'institution', source: data, candleDates: grid(dates) });
        const foreign = buildInvestorCumulative({ subject: 'foreign', source: data, candleDates: grid(dates) });
        expect(institution).toMatchObject({ kind: 'anchored', anchorDate: dates[0], partial: false });
        expect(values(institution)).toEqual([0, 20, 50]);
        expect(foreign).toMatchObject({ kind: 'anchored', anchorDate: dates[1] });
        expect(values(foreign)).toEqual([null, 0, 30]);
    });
    it('breaks the outgoing segment and exact gap stays whitespace', () => {
        const dates = ['20260105', '20260106', '20260107'];
        const snapshot = buildInvestorCumulative({ subject: 'institution', source: source(dates, [10, null, 30]), candleDates: grid(dates) });
        const axis = createVirtualAxis(grid(dates).map(p => ({ date: p.date, sessionOpenMs: p.t_ms, sessionCloseMs: p.t_ms + 23400000 })));
        const bundle = buildIndexBundle({ indexId: 'KOSPI', from: dates[0], to: dates[2], bucketMs: 86400000, candles: dates.map(date => ({ t_ms: ms(date), open: 100, high: 110, low: 90, close: 105, volume: 10 })) });
        const out = projectInvestorCumulative(bundle, axis, { settings: FACTORY_INDICATOR_SETTINGS, snapshot });
        expect(out[0]).toMatchObject({ value: 0, color: 'rgba(0,0,0,0)' });
        expect(out[1]).not.toHaveProperty('value');
        expect(out[2]).not.toHaveProperty('value');
    });
    it.each(['foreign', 'institution'] as const)('%s settings persist independently, with no derived anchor or unsupported query demand', subject => {
        const category = subject === 'foreign' ? 'foreign-cumulative' : 'institution-cumulative';
        const settings = { ...FACTORY_INDICATOR_SETTINGS, foreignCumulativeEnabled: true, institutionCumulativeEnabled: true, foreignCumulativeWidth: 4 as const, institutionCumulativeWidth: 3 as const, indicatorLineVisibility: { foreignCumulative: false, institutionCumulative: false } };
        const captured = captureIndicatorSettings(category, settings);
        expect(Object.keys(captured).every(key => key.startsWith(`${subject}Cumulative`) || key === 'indicatorLineVisibility')).toBe(true);
        expect(captured).not.toHaveProperty('anchorDate');
        const restored = normalizeIndicatorInstances([makeIndicatorInstance(category, settings, DEFAULT_PREFS)], mergeLiveIndicatorPrefs);
        expect(restored[0].settings).toEqual(captured);
        for (const tf of ['1s', '1m', 'W', 'M'] as const)
            expect(indicatorInstanceApplicable(category, tf, true)).toBe(false);
        expect(indicatorInstanceApplicable(category, 'D', true)).toBe(true);
        expect(indicatorInstanceApplicable(category, 'D', false)).toBe(false);
    });
});
describe('strict daily-flow wire boundary', () => {
    const dates = ['20260105', '20260106'];
    const data = source(dates, [0, -1]);
    const scope = { code: data.code, from: data.from, to: data.to };
    it('preserves literal zero and nullable actors', () => expect(parseInvestorDailyFlow(data, scope)).toEqual(data));
    it.each([{ code: '000660' }, { from: '20260101' }, { unit: 'amount' }, { trade_side: 'buy' }, { provider_scope: 'UN' }, { source: 'holdings' },
        { observations: [{ ...data.observations[0], t_ms: ms(dates[0]) + 1 }] }, { observations: [{ ...data.observations[0], institution_net_shares: 1.5 }] },
        { observations: [{ ...data.observations[0], date: '20260230' }] }, { observations: [{ ...data.observations[0], foreign_net_shares: Number.MAX_SAFE_INTEGER + 1 }] }])('rejects wrong scope or invalid observation %j', extra => {
        expect(() => parseInvestorDailyFlow({ ...data, ...extra }, scope)).toThrow();
    });
});
