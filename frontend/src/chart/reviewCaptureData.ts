import { apiCall } from '../api/client';
import type { LiveIndexCandlesResponse } from '../api/liveIndices';
import type { LivePastDailyCandlesResponse } from '../api/livePastDailyCandles';
import type { LiveSettings } from '../api/liveSettings';
import type { InvestorFlowResponse } from '../api/market';
import { realMsToYyyymmdd, subtractDaysKst, todayKstYyyymmdd } from '../live/liveDateTime';
import { unixMsToKSTClock } from '../util/time';
import type { ReviewCandle, ReviewCandleSection, ReviewCaptureContext, ReviewCaptureData, ReviewFlowMarket } from './reviewCaptureTypes';

/** Reject malformed/foreign-date rows instead of giving a snapshot a misleading label. */
export function reviewCandles(rows: ReviewCandle[], from: string, to: string): ReviewCandle[] {
  const byTime = new Map<number, ReviewCandle>();
  for (const row of rows) {
    if (![row.t_ms, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
      || row.low <= 0 || row.volume < 0 || row.high < Math.max(row.open, row.close)
      || row.low > Math.min(row.open, row.close) || row.high < row.low) continue;
    const date = realMsToYyyymmdd(row.t_ms);
    if (date >= from && date <= to) byTime.set(row.t_ms, row);
  }
  return [...byTime.values()].sort((a, b) => a.t_ms - b.t_ms);
}

export function reviewFlow(data: InvestorFlowResponse, date: string): ReviewCaptureData['flow'] {
  const markets = {} as Record<'KOSPI' | 'KOSDAQ', ReviewFlowMarket>;
  const daily = data.daily.find(row => row.date === date);
  for (const key of ['KOSPI', 'KOSDAQ'] as const) {
    // A confirmed row has no observation timestamp. Its virtual chart anchor is not a receipt time.
    const confirmed = daily?.markets[key];
    const points = data.date === date ? data.markets[key] ?? [] : [];
    const latest = points.filter(point => Number.isFinite(point.t_ms) && realMsToYyyymmdd(point.t_ms) === date)
      .sort((a, b) => a.t_ms - b.t_ms).at(-1);
    const values = confirmed ?? latest;
    const validUnit = data.unit === 'amt_eok';
    const number = (value: number | null | undefined) => validUnit && typeof value === 'number' && Number.isFinite(value) ? value : null;
    markets[key] = {
      foreign: number(values?.foreign), institution: number(values?.institution), individual: number(values?.individual),
      basis: !validUnit ? '단위 미확인' : confirmed || (data.date === date && data.confirmed && latest) ? '확정치'
        : latest ? `잠정 · ${unixMsToKSTClock(latest.t_ms).slice(0, 5)} KST` : '자료 없음',
    };
  }
  return { markets, message: data.unit === 'amt_eok' ? '' : '순매수 금액 단위를 확인하지 못했습니다' };
}

export async function loadReviewCaptureData(code: string, context: ReviewCaptureContext): Promise<ReviewCaptureData> {
  const dates = [...new Set(context.dates)].sort();
  const date = dates.at(-1);
  if (!date || !/^\d{8}$/.test(date)) throw new Error('보이는 분봉의 거래일을 확인하지 못했습니다');
  const signal = AbortSignal.timeout(25_000);
  async function index(id: 'KOSPI' | 'KOSDAQ'): Promise<ReviewCandleSection> {
    try {
      const data = await apiCall<LiveIndexCandlesResponse>(
        `/api/live/index-candles?index_id=${id}&timeframe=5m&from=${date}&to=${date}`, { signal });
      if (data.index_id !== id || data.timeframe !== '5m') throw new Error('다른 지수 응답');
      const candles = reviewCandles(data.candles, date!, date!);
      return { candles, message: !candles.length ? '자료 없음' : data.data_warnings.length ? '일부 자료 · 조회 경고 있음' : '' };
    } catch { return { candles: [], message: '조회 실패 · 차트에서 다시 추가하여 재시도해 주세요' }; }
  }
  async function daily(): Promise<ReviewCandleSection> {
    try {
      const settings = await apiCall<LiveSettings>('/api/live/settings', { signal });
      const from = subtractDaysKst(date!, 365);
      // Respect the existing REST bypass policy, including its KRX-only disk price basis.
      if (settings.rest_bypass_enabled && context.venue !== 'KRX') {
        return { candles: [], message: 'REST 우회 중에는 이 시장의 일봉을 조회할 수 없습니다' };
      }
      const path = settings.rest_bypass_enabled ? 'screener-daily-candles' : 'past-daily-candles';
      const data = await apiCall<LivePastDailyCandlesResponse>(
        `/api/live/${path}?code=${encodeURIComponent(code)}&from=${from}&to=${date}&venue=${context.venue}`, { signal });
      if (data.code !== code || (data.venue && data.venue !== context.venue)) throw new Error('다른 종목/시장 응답');
      const all = reviewCandles(data.candles, from, date!);
      // Keep 60 actual bars; extend left if the visible minute window spans more dates.
      const firstSelected = all.findIndex(row => realMsToYyyymmdd(row.t_ms) >= dates[0]);
      const start = Math.min(Math.max(0, all.length - 60), firstSelected < 0 ? all.length : firstSelected);
      const candles = all.slice(start);
      const missing = dates.filter(day => !candles.some(row => realMsToYyyymmdd(row.t_ms) === day));
      const messages = [!candles.length ? '자료 없음' : '', data.data_warnings.length ? '일부 자료 · 조회 경고 있음' : '',
        candles.length && missing.length ? '분봉에 대응하는 일부 날짜의 일봉 없음' : '',
        candles.length && date === todayKstYyyymmdd() && Date.now() < new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}T${context.venue === 'KRX' ? '15:30' : '20:00'}:00+09:00`).getTime() ? '진행 중' : ''];
      return { candles, message: messages.filter(Boolean).join(' · ') };
    } catch { return { candles: [], message: '조회 실패 · 차트에서 다시 추가하여 재시도해 주세요' }; }
  }
  async function flow(): Promise<ReviewCaptureData['flow']> {
    try { return reviewFlow(await apiCall<InvestorFlowResponse>('/api/market/investor-flow', { signal }), date!); }
    catch { return { markets: { KOSPI: { foreign: null, institution: null, individual: null, basis: '조회 실패' },
      KOSDAQ: { foreign: null, institution: null, individual: null, basis: '조회 실패' } }, message: '조회 실패' }; }
  }
  const [kospi, kosdaq, dailyData, flowData] = await Promise.all([index('KOSPI'), index('KOSDAQ'), daily(), flow()]);
  return { date, kospi, kosdaq, daily: dailyData, flow: flowData };
}
