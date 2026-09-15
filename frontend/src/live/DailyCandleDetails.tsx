import type { Candle } from '../api/types';
import { useLivePastInvestorNet } from '../api/livePastInvestorNet';
import { useLiveDailyProgramTrade } from '../api/liveDailyProgramTrade';
import { priceDirClass } from '../ui/priceDir';
import { formatKoreanInt } from '../util/koreanNumber';
import { realMsToYyyymmdd } from './liveDateTime';

/** The tooltip owns its demand. Pane visibility and buy/sell preferences must
 * never change this daily net-buy readout. Query keys share existing caches. */
export default function DailyCandleDetails({ code, candles, candle }: {
  code: string;
  candles: Candle[];
  candle: Candle;
}) {
  const from = candles.length ? realMsToYyyymmdd(candles[0].ts_ms) : null;
  const to = candles.length ? realMsToYyyymmdd(candles[candles.length - 1].ts_ms) : null;
  const investor = useLivePastInvestorNet(code, from, to, 'qty', 'net');
  const program = useLiveDailyProgramTrade(code, from, to);
  const date = realMsToYyyymmdd(candle.ts_ms);
  const investorData = investor.data;
  const net = investorData?.code === code
    && (investorData.trade_side ?? 'net') === 'net'
    && (investorData.unit ?? 'qty_shares') === 'qty_shares'
    ? investorData.points.find(p => realMsToYyyymmdd(p.t_ms) === date) : undefined;
  const programNet = program.data?.code === code
    ? program.data.points.find(p => realMsToYyyymmdd(p.t_ms) === date)?.net_qty : undefined;
  const rows = [
    { label: '기관 순매수', value: net?.institution_net, loading: investor.isLoading, error: investor.isError },
    { label: '외인 순매수', value: net?.foreign_net, loading: investor.isLoading, error: investor.isError },
    { label: '프로그램 순매수', value: programNet, loading: program.isLoading, error: program.isError },
  ];
  const turnover = candle.trade_value_won;
  return (
    <div data-testid="daily-candle-details">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <span style={{ color: 'var(--fg-dimmer)' }}>거래대금</span>
        <span>{turnover != null && Number.isFinite(turnover) && turnover >= 0
          ? `${(turnover / 100_000_000).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}억`
          : '—'}</span>
      </div>
      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
      {rows.map(({ label, value, loading, error }) => {
        const valid = value != null && Number.isFinite(value);
        return (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ color: 'var(--fg-dimmer)' }}>{label}</span>
            <span className={valid ? priceDirClass(value) : undefined}>
              {valid ? `${value > 0 ? '+' : ''}${formatKoreanInt(value)}주` : loading ? '불러오는 중' : error ? '조회 실패' : '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
