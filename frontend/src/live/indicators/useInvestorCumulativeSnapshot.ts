import { useEffect, useMemo, useRef } from 'react';
import type { DailyFlowRequestScope, DailyFlowSubject, InvestorDailyFlowResponse } from '../../api/investorDailyFlow';
import { buildInvestorCumulative, type InvestorCumulativeSnapshot } from '../../chart/projectors/investorCumulative';

type AcceptedHistory = {
  subject: DailyFlowSubject;
  source: InvestorDailyFlowResponse;
};

export function useInvestorCumulativeSnapshot({ scope, subject, source, candleDates }: {
  scope: DailyFlowRequestScope;
  subject: DailyFlowSubject;
  source: InvestorDailyFlowResponse | undefined;
  candleDates: Parameters<typeof buildInvestorCumulative>[0]['candleDates'];
}): InvestorCumulativeSnapshot {
  const accepted = useRef<AcceptedHistory | null>(null);
  const previous = accepted.current;
  const compatible = previous?.subject === subject && previous.source.code === scope.code
    && previous.source.to === scope.to && previous.source.from >= scope.from;
  const conflicts = useMemo(() => {
    if (!source || !previous || !compatible) return false;
    if (source.unlocated_defect) return true;
    const field = subject === 'institution' ? 'institution_net_shares' : 'foreign_net_shares';
    const known = new Map(previous.source.observations.map(point => [point.date, point[field]]));
    return source.observations.some(point => known.has(point.date) && known.get(point.date) !== point[field]);
  }, [source, previous, compatible, subject]);
  const selected = compatible && previous && source?.pagination !== 'covered' && !conflicts ? previous.source : source;
  const snapshot = useMemo<InvestorCumulativeSnapshot>(() => selected
    ? buildInvestorCumulative({ source: selected, subject, candleDates })
    : { kind: 'empty', scope, points: [] }, [selected, subject, candleDates, scope]);
  useEffect(() => {
    if (source?.pagination === 'covered') accepted.current = { subject, source };
    else if (!compatible || conflicts) accepted.current = null;
  }, [source, subject, compatible, conflicts]);
  return snapshot;
}
