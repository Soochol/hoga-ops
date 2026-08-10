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

  // **호스트를 박지 않는다.** 여기 원래 'http://localhost:8080' 이 하드코딩돼
  // 있었는데, 그건 API 주소가 아니라 config.ts 의 DEFAULT_CONFIG **폴백**이다 —
  // `/config.json` 을 못 읽었을 때만 쓰이는 값이다. 즉 이 모킹은 "설정 로드가
  // 실패한다" 는 사고에 기대어 동작하고 있었다.
  //
  // 2026-07-30 에 e2e 가 실제로 실행되기 시작하면서 `/config.json` 이 e2e 백엔드를
  // 정상 제공하자, 앱은 진짜 백엔드로 가고 **모킹이 한 건도 안 걸렸다**. 스펙
  // 8개가 그래서 실패했다. 절대 URL 은 애초에 깨지기 쉬운 결합이었고, 포트가
  // 바뀔 때마다 조용히 무력화된다.
  // …그런데 `'**/api/…'` 로 완화하면 **자기 소스 파일까지 가로챈다**. Playwright 의
  // `**` 는 `/` 를 포함해 매칭하므로 `**/api/symbols*` 가 vite 가 서빙하는
  // `/src/api/symbols.ts` 에도 걸린다 — 그 모듈이 JSON 으로 대체되면서
  // "Failed to load module script: … MIME type of application/json" 으로 앱이 통째로
  // 빈 화면이 됐다(실측). 이 저장소는 프론트 소스에 `src/api/` 가 있어서 API 경로와
  // 소스 경로가 문자열로 겹친다 — 실제 충돌 5건: watchlist · symbols · calendar ·
  // range · captures.
  //
  // 그래서 **호스트 루트에 앵커한 정규식**을 쓴다. `/api/…` 가 경로 맨 앞일 때만
  // 걸리므로 `/src/api/…` 는 절대 매칭되지 않고, 포트가 바뀌어도 그대로 동작한다.
  const api = (path: string) => new RegExp(`^https?://[^/]+/api/${path}`);

  await page.route(api('watchlist'), (r) => json(r, WATCHLIST));
  await page.route(api('live/status'), (r) => json(r, LIVE_STATUS_OK));
  await page.route(api('live/past-candles'), (r) => json(r, PAST_CANDLES_NORMAL));
  await page.route(api('live/series'), (r) => json(r, EMPTY_SERIES));
  await page.route(api('range'), (r) => json(r, rangeBody));
  await page.route(api('captures/queue'), (r) =>
    json(r, { active: [], queued: [], done: [] }),
  );
  await page.route(api('calendar'), (r) => json(r, { holidays: [] }));
  await page.route(api('symbols'), (r) => json(r, { symbols: [] }));
  await page.route(api('upstream-hints'), (r) => json(r, { hints: [] }));
  // **틱 채널은 `helpers/liveWs.ts` 가 맡는다**(2026-07-31 해소). SSE→WebSocket 이관
  // (ADR-0053) 이후 앱은 `/api/ws` 하나만 열고 `{ch}` 로 다중화하므로 `page.route` 로는
  // 못 잡는다 — `page.routeWebSocket` 을 쓴다(Playwright ≥ 1.48; 이 저장소는 1.60).
  // 사용 예는 `live-tick.spec.ts`.
  //
  // 여기서 SSE 라우트 모킹(`/api/events` · `/api/live/stream`)은 이관 후 죽은 코드라
  // 삭제됐다. 이 헬퍼는 **REST 만** 담당한다 — 틱이 필요하면 `installLiveWs` 를 함께 부른다.
}
