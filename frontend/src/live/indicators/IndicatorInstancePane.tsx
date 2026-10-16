import { useMemo, type ComponentProps } from 'react';
import { IndicatorInstanceProvider } from './IndicatorInstanceProvider';
import RangeSeriesPane from '../../chart/RangeSeriesPane';
import { useLivePastInvestorNet } from '../../api/livePastInvestorNet';
import { useLiveDailyProgramTrade } from '../../api/liveDailyProgramTrade';
import { useWindowIndicator } from '../workspace/windowView';
import { basePaneId } from '../../chart/paneOrder';

/** Daily sources are keyed by their requested trade side, so sibling modes never reuse the wrong response. */
export function IndicatorInstancePane({ code, ...props }: ComponentProps<typeof RangeSeriesPane> & { code: string | null }) {
  const pane = basePaneId(props.spec.name as import('../../chart/drawing/types').PaneId);
  const foreign = useWindowIndicator(s => s.foreignTradeSide);
  const institution = useWindowIndicator(s => s.institutionTradeSide);
  const program = useWindowIndicator(s => s.dailyProgramTradeSide);
  const investor = pane === 'investor-foreign' || pane === 'investor-institution';
  const stock = code && /^\d{6}$/.test(code) ? code : null;
  const side = pane === 'investor-institution' ? institution : foreign;
  const query = useLivePastInvestorNet(investor ? stock : null, props.bundle.from_date, props.bundle.to_date, 'qty', side);
  const dailyProgram = useLiveDailyProgramTrade(pane === 'program-daily' ? stock : null, props.bundle.from_date, props.bundle.to_date);
  const bundle = useMemo(() => {
    if (pane === 'program-daily') return { ...props.bundle, dailyProgramTradeSide: program, dailyProgramPoints: dailyProgram.data?.points ?? props.bundle.dailyProgramPoints };
    if (!investor || !stock) return props.bundle;
    const points = query.data?.trade_side === side || (side === 'net' && query.data?.trade_side === undefined) ? query.data?.points ?? [] : [];
    return pane === 'investor-institution'
      ? { ...props.bundle, institutionInvestorPoints: points, institutionInvestorTradeSide: side }
      : { ...props.bundle, investorPoints: points, investorTradeSide: side };
  }, [pane, props.bundle, investor, stock, query.data, dailyProgram.data, side, program]);
  return <RangeSeriesPane {...props} bundle={bundle} />;
}

/** One stable chart child for both the original and additional pane instances. */
export function ScopedIndicatorPane({ code, ...props }: ComponentProps<typeof RangeSeriesPane> & { code: string | null }) {
  return props.spec.name.startsWith('indicator:')
    ? <IndicatorInstanceProvider id={props.spec.name.split(':')[1]}><IndicatorInstancePane code={code} {...props} /></IndicatorInstanceProvider>
    : <RangeSeriesPane {...props} />;
}
