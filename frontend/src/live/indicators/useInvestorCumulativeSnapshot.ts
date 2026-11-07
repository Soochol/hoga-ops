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
  const selected = compatible && previous && !source ? previous.source : source;
  const snapshot = useMemo<InvestorCumulativeSnapshot>(() => selected
    ? buildInvestorCumulative({ source: selected, subject, candleDates })
    : { kind: 'empty', scope, points: [] }, [selected, subject, candleDates, scope]);
  useEffect(() => {
    if (source) accepted.current = { subject, source };
    else if (!compatible) accepted.current = null;
  }, [source, subject, compatible]);
  return snapshot;
}
