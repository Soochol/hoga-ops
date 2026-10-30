import { useLiveIndexCandles } from '../../api/liveIndices';
import { useMarketIndexQuotes } from '../../api/marketIndexQuotes';
import { isWarningFailure } from '../../api/dataWarnings';
import { useMinuteClock } from '../useMinuteClock';
import { realMsToYyyymmdd, regularSessionCloseMs, subtractDaysKst } from '../liveDateTime';
import { buildMajorIndexSeries, latestIndexDate, MAJOR_INDICES } from './majorIndicesModel';
import { DEFAULT_MAJOR_INDICES_SETTINGS, type MajorIndexId } from '../../state/majorIndicesSettings';

/** Same query keys as the market page and index chart windows. The immutable daily
 * range ends yesterday: today's daily backend cache is not refreshed intraday.
 * Query today's minutes first; only fetch a previous session when today is empty.
 */
export function useMajorIndices(indices: readonly MajorIndexId[] = DEFAULT_MAJOR_INDICES_SETTINGS.indices) {
  const now = useMinuteClock();
  const today = realMsToYyyymmdd(now);
  const from = subtractDaysKst(today, 35), yesterday = subtractDaysKst(today, 1);
  const quotes = useMarketIndexQuotes();
  const k = indices.includes('KOSPI') ? 'KOSPI' : null;
  const q = indices.includes('KOSDAQ') ? 'KOSDAQ' : null;
  const k200 = indices.includes('KOSPI200') ? 'KOSPI200' : null;
  // Keep hook order fixed; disabled queries can still contain cached data and
  // remain pending. Only selected queries participate in date/status decisions.
  const dailyK = useLiveIndexCandles(k, 'D', from, yesterday);
  const dailyQ = useLiveIndexCandles(q, 'D', from, yesterday);
  const daily200 = useLiveIndexCandles(k200, 'D', from, yesterday);
  const todayK = useLiveIndexCandles(k, '1m', today, today);
  const todayQ = useLiveIndexCandles(q, '1m', today, today);
  const today200 = useLiveIndexCandles(k200, '1m', today, today);
  const allDaily = [dailyK, dailyQ, daily200];
  const allToday = [todayK, todayQ, today200];
  const selected = (_: unknown, i: number) => indices.includes(MAJOR_INDICES[i].id);
  const dailyQueries = allDaily.filter(selected);
  const todayQueries = allToday.filter(selected);
  const hasToday = todayQueries.some(q => latestIndexDate(q.data?.candles ?? [], today) === today);
  const settledToday = todayQueries.every(q => !q.isPending);
  const previousDates = dailyQueries.map(q => latestIndexDate(q.data?.candles ?? [], yesterday))
    .filter((date): date is string => date !== null).sort();
  const date = hasToday || !settledToday ? today : previousDates.at(-1) ?? today;
  const past = date !== today ? date : null;
  const pastK = useLiveIndexCandles(k, '1m', past, past);
  const pastQ = useLiveIndexCandles(q, '1m', past, past);
  const past200 = useLiveIndexCandles(k200, '1m', past, past);
  const allMinutes = past ? [pastK, pastQ, past200] : allToday;
  const minuteQueries = allMinutes.filter(selected);
  const series = MAJOR_INDICES.flatMap((index, i) => indices.includes(index.id) ? [{
    ...index,
    ...buildMajorIndexSeries(date, now, allMinutes[i].data?.candles ?? [], allDaily[i].data?.candles ?? [],
      quotes.data?.find(q => q.id === index.id)),
  }] : []);
  const loading = todayQueries.some(q => q.isPending) || minuteQueries.some(q => q.isPending) || dailyQueries.some(q => q.isPending);
  const failed = quotes.isError || [...todayQueries, ...minuteQueries, ...dailyQueries].some(q => q.isError
    || q.data?.data_warnings.some(isWarningFailure));
  const missing = series.some(s => s.value === null || s.percent === null);
  const delayed = series.some(s => s.delayed);
  const status = loading && series.every(s => s.value === null) ? '로딩'
    : failed ? '조회 지연' : delayed ? '지연' : missing ? '일부 누락'
      : series.every(s => s.closed) ? '종가' : now >= regularSessionCloseMs(date) ? '마지막' : '장중';
  const dateLabel = `${date.slice(4, 6)}/${date.slice(6, 8)}`;
  return { series, date, now, status, loading, label: date !== today ? `${dateLabel} ${status}` : status };
}
