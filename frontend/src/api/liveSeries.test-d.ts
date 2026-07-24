import type { LiveSeriesResponse, LiveTodayAskPeak, LiveTodayBidPeak } from './liveSeries';

const _todayAskPeakWithoutTradedPeak: LiveTodayAskPeak = {
  date: '20260616',
  coverage: 'partial',
  traded_prices: [],
  traded_price: null,
  traded_qty: null,
  traded_t_ms: null,
  all_price: 70000,
  all_qty: 1000,
  all_t_ms: 1781596800000,
};
void _todayAskPeakWithoutTradedPeak;

const _todayBidPeakWithoutTradedPeak: LiveTodayBidPeak = {
  ..._todayAskPeakWithoutTradedPeak,
};
void _todayBidPeakWithoutTradedPeak;

const _liveSeriesResponse: LiveSeriesResponse = {
  code: '005930',
  date: '20260616',
  session_open_ms: 1781568000000,
  session_close_ms: null,
  is_open: true,
  snapshots: [],
  trades: [],
  brokers: [],
  programs: [],
  ask_peak_today: _todayAskPeakWithoutTradedPeak,
  bid_peak_today: _todayBidPeakWithoutTradedPeak,
};
void _liveSeriesResponse;

const _legacyLiveSeriesResponseWithoutBidPeak: LiveSeriesResponse = {
  code: '005930',
  date: '20260616',
  session_open_ms: 1781568000000,
  session_close_ms: null,
  is_open: true,
  snapshots: [],
  trades: [],
  brokers: [],
  programs: [],
  ask_peak_today: _todayAskPeakWithoutTradedPeak,
};
void _legacyLiveSeriesResponseWithoutBidPeak;

// @ts-expect-error ask_peak_today is required on the live series response.
const _missingTodayAskPeak: LiveSeriesResponse = {
  code: '005930',
  date: '20260616',
  session_open_ms: 1781568000000,
  session_close_ms: null,
  is_open: true,
  snapshots: [],
  trades: [],
  brokers: [],
  programs: [],
  bid_peak_today: _todayBidPeakWithoutTradedPeak,
};
void _missingTodayAskPeak;
