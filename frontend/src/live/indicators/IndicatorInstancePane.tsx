import { InvestorCumulativePane } from './InvestorCumulativePane';
import { InvestorHoldingsPane } from './InvestorHoldingsPane';
import { useMemo, type ComponentProps } from 'react';
import { IndicatorInstanceProvider } from './IndicatorInstanceProvider';
import RangeSeriesPane from '../../chart/RangeSeriesPane';
import { useLivePastInvestorNet, investorDailyFlowForScope } from '../../api/livePastInvestorNet';
import { useLiveDailyProgramTrade } from '../../api/liveDailyProgramTrade';
import { useWindowIndicator } from '../workspace/windowView';
import { InvestorNetLinePane } from './InvestorNetLinePane';
import { basePaneId } from '../../chart/paneOrder';

/** Daily sources are keyed by their requested trade side, so sibling modes never reuse the wrong response. */
export function IndicatorInstancePane({ code, ...props }: ComponentProps<typeof RangeSeriesPane> & { code: string | null }) {
  const pane = basePaneId(props.spec.name as import('../../chart/drawing/types').PaneId);
  const foreign = useWindowIndicator(s => s.foreignTradeSide);
  const institution = useWindowIndicator(s => s.institutionTradeSide);
  const program = useWindowIndicator(s => s.dailyProgramTradeSide);
  const investor = pane === 'investor-foreign' || pane === 'investor-institution';
  const stock = code && /^[0-9A-Z]{6}$/.test(code) ? code : null;
  const side = pane === 'investor-institution' ? institution : foreign;
  const scope = props.bundle.investorRequestScope ?? { code: stock ?? '', from: props.bundle.from_date, to: props.bundle.to_date };
  const query = useLivePastInvestorNet(investor ? stock : null, scope.from, scope.to, 'qty', side);
  const dailyProgram = useLiveDailyProgramTrade(pane === 'program-daily' ? stock : null, props.bundle.from_date, props.bundle.to_date);
  const bundle = useMemo(() => {
    if (pane === 'program-daily') return { ...props.bundle, dailyProgramTradeSide: program, dailyProgramPoints: dailyProgram.data?.points ?? props.bundle.dailyProgramPoints };
    if (!investor || !stock) return props.bundle;
    const response = query.data;
    const valid = response?.code === stock && response.from === scope.from && response.to === scope.to
      && (response.trade_side ?? 'net') === side && (response.unit === undefined || response.unit === 'qty_shares');
    const points = valid ? response.points : [];
    const investorDailyFlow = side === 'net' ? investorDailyFlowForScope(response, scope) : props.bundle.investorDailyFlow;
    return pane === 'investor-institution'
      ? { ...props.bundle, investorDailyFlow, institutionInvestorPoints: points, institutionInvestorTradeSide: side }
      : { ...props.bundle, investorDailyFlow, investorPoints: points, investorTradeSide: side };
  }, [pane, props.bundle, investor, stock, query.data, dailyProgram.data, side, program, scope.code, scope.from, scope.to]);
  if (pane === 'foreign-cumulative' || pane === 'institution-cumulative') return <InvestorCumulativePane subject={pane === 'institution-cumulative' ? 'institution' : 'foreign'} code={code} {...props} />;
  if (pane === 'investor-holdings') return <InvestorHoldingsPane code={code} {...props} />;
  return pane === 'investor-net-line' ? <InvestorNetLinePane code={code} {...props} /> : <RangeSeriesPane {...props} bundle={bundle} />;
}

/** One stable chart child for both the original and additional pane instances. */
export function ScopedIndicatorPane({ code, ...props }: ComponentProps<typeof RangeSeriesPane> & { code: string | null }) {
  const pane = basePaneId(props.spec.name as import('../../chart/drawing/types').PaneId);
  if ((pane === 'institution-cumulative' || pane === 'foreign-cumulative') && !props.spec.name.startsWith('indicator:')) return <InvestorCumulativePane subject={pane === 'institution-cumulative' ? 'institution' : 'foreign'} code={code} {...props} />;
  if (basePaneId(props.spec.name as import('../../chart/drawing/types').PaneId) === 'investor-holdings' && !props.spec.name.startsWith('indicator:')) return <InvestorHoldingsPane code={code} {...props} />;
  return props.spec.name.startsWith('indicator:')
    ? <IndicatorInstanceProvider id={props.spec.name.split(':')[1]}><IndicatorInstancePane code={code} {...props} /></IndicatorInstanceProvider>
    : basePaneId(props.spec.name as import('../../chart/drawing/types').PaneId) === 'investor-net-line'
      ? <InvestorNetLinePane code={code} {...props} /> : <RangeSeriesPane {...props} />;
}
