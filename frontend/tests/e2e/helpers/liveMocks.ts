import type { Page, Route } from '@playwright/test';

// 폴더 도입(spec 2026-05-31) 이후 GET /api/watchlist 응답 형태: folders +
// entry.folder_id/order 필수 — 빠지면 groupByFolder가 throw해 패널이 통째로 죽는다.
const WATCHLIST = {
  folders: [],
  entries: [
    {
      code: '098460',
      name: '고영',
      registered_at_kst_date: '20260527',
      last_success_date: '20260522',
      folder_id: null,
      order: 0,
    },
  ],
  next_run_at_ms: 0,
};

const LIVE_STATUS_OK = {
  running: true,
  started_at_ms: 1779927808562,
  last_tick_ms: 1779931872690,
  cycle_lag_ms: 0,
  watchlist_count: 1,
  kis_calls_today: 1,
  kis_rate_limit_remaining: null,
};

const PAST_CANDLES_NORMAL = {
  code: '098460',
  from: '20260527',
  to: '20260528',
  candles: [
    { t_ms: 1779840000000, open: 35000, high: 35100, low: 34900, close: 35050, volume: 100 },
    { t_ms: 1779840060000, open: 35050, high: 35200, low: 35000, close: 35150, volume: 120 },
    { t_ms: 1779840120000, open: 35150, high: 35250, low: 35100, close: 35200, volume: 80 },
    { t_ms: 1779926400000, open: 35200, high: 35300, low: 35150, close: 35250, volume: 200 },
  ],
  cached_dates: ['20260527'],
  fresh_dates: ['20260528'],
  data_warnings: [],
};

const EMPTY_VOLUME_PROFILE = {
  bin_count: 0,
  price_min: 0,
  price_max: 0,
  bin_width: 0,
  bins: [],
};

const RANGE_NO_DEFECTS = {
  code: '098460',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60000,
  segments: [
    {
      date: '20260527',
      session_open_ms: 1779840000000,
      session_close_ms: 1779863400000,
      source: 'hogaplay',
    },
  ],
  candles: [],
  quote_ratio: { bucket_ms: 60000, points: [] },
  fill_strength: { bucket_ms: 60000, points: [] },
  volume_profile_range: EMPTY_VOLUME_PROFILE,
  volume_profile_by_day: [],
  excluded_dates: [],
  data_warnings: [],
};

const RANGE_WITH_DEFECTS = {
  code: '098460',
  from_date: '20260518',
  to_date: '20260527',
  bucket_ms: 60000,
  segments: [
    {
      date: '20260519',
      session_open_ms: 1779148800000,
      session_close_ms: 1779172200000,
      source: 'hogaplay',
    },
    {
      date: '20260527',
      session_open_ms: 1779840000000,
      session_close_ms: 1779863400000,
      source: 'hogaplay',
    },
  ],
  candles: [],
  quote_ratio: { bucket_ms: 60000, points: [] },
  fill_strength: { bucket_ms: 60000, points: [] },
  volume_profile_range: EMPTY_VOLUME_PROFILE,
  volume_profile_by_day: [],
  excluded_dates: [
    {
      date: '20260518',
      violations: [
        {
          invariant_id: 'meta.close_after_open',
          severity: 'error',
          message: 'session close must be strictly greater than open',
          ctx: { open_ms: 90000000, close_ms: 0 },
        },
      ],
    },
  ],
  data_warnings: [
    {
      date: '20260527',
      warnings: [
        {
          invariant_id: 'collection.finished',
          severity: 'warn',
          message: 'capture aborted before completion (likely partial data)',
          ctx: { complete: false },
        },
      ],
    },
  ],
};

const EMPTY_SERIES = {
  code: '098460',
  snapshots: [],
  trades: [],
  brokers: [],
  date: '20260528',
  session_open_ms: 1779926400000,
  session_close_ms: null,
  is_open: true,
};

export interface InstallLiveMocksOpts {
  /** Which `/api/range` fixture to serve. Defaults to "normal" (no defects). */
  range?: 'normal' | 'with-defects';
}

/**
 * Install Playwright route mocks for every backend endpoint LivePage touches
 * during a normal session. Backend-independent: the spec controls what the
 * frontend sees, so tick timing, KIS credentials, market hours, etc. cannot
 * destabilize the test.
 */
export async function installLiveMocks(
  page: Page,
  opts: InstallLiveMocksOpts = {},
): Promise<void> {
  const rangeBody = opts.range === 'with-defects' ? RANGE_WITH_DEFECTS : RANGE_NO_DEFECTS;

  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('http://localhost:8000/api/watchlist*', (r) => json(r, WATCHLIST));
  await page.route('http://localhost:8000/api/live/status*', (r) => json(r, LIVE_STATUS_OK));
  await page.route('http://localhost:8000/api/live/past-candles*', (r) => json(r, PAST_CANDLES_NORMAL));
  await page.route('http://localhost:8000/api/live/series*', (r) => json(r, EMPTY_SERIES));
  await page.route('http://localhost:8000/api/range*', (r) => json(r, rangeBody));
  await page.route('http://localhost:8000/api/captures/queue*', (r) =>
    json(r, { active: [], queued: [], done: [] }),
  );
  await page.route('http://localhost:8000/api/calendar*', (r) => json(r, { holidays: [] }));
  await page.route('http://localhost:8000/api/symbols*', (r) => json(r, { symbols: [] }));
  await page.route('http://localhost:8000/api/upstream-hints*', (r) => json(r, { hints: [] }));
  // TODO(ws-migration): the /live tick channel is no longer mockable via page.route.
  // The app now opens ONE WebSocket at ws://<host>/api/ws (ADR-0053) carrying
  // {ch:'event'|'live'|'subscribed'|'heartbeat'} frames; the client sends
  // {action:'subscribe'|'unsubscribe', code} to drive subscription.
  // To restore controllable e2e ticks inject frames like this:
  //
  //   await page.routeWebSocket('**/api/ws', ws => {
  //     ws.onMessage(msg => {
  //       const parsed = JSON.parse(msg as string);
  //       if (parsed.action === 'subscribe') {
  //         ws.send(JSON.stringify({ ch: 'subscribed', code: parsed.code }));
  //       }
  //       // push live-tick frames on demand:
  //       // ws.send(JSON.stringify({ ch: 'live', code: '098460', data: { t_ms, kind, ... } }));
  //     });
  //   });
  //
  // NOTE: page.routeWebSocket requires Playwright ≥ 1.48. The removed
  // /api/events and /api/live/stream SSE route mocks were dead after the
  // SSE→WebSocket migration (ADR-0053) and have been dropped.
  // Tracked as a follow-up; requires a Playwright run to validate (not in the
  // vitest+build gate).
}
