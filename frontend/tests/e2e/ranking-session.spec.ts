import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

const observed = Date.parse('2026-10-30T14:03:12+09:00');
const basis = { session: 'holiday', source: 'stored', trading_date: '2026-10-30',
  observed_at_ms: observed, message: '최근 거래일의 저장된 순위를 사용합니다.' };

for (const surface of ['page', 'panel'] as const) {
  test(`holiday screener ${surface} shows last provider ranks with a separate completed-day basis`, async ({ page }, testInfo) => {
    await installLiveMocks(page);
    await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
    await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [{
      id: 'weekend', name: '주말 순위', conditions: [
        { id: 'rank', type: 'change_pct_rank', params: { top_n: 100 } },
        { id: 'price', type: 'price_range', params: { min: 1000 } },
      ], universe: {}, created_at_ms: 1, updated_at_ms: 1,
    }] } }));
    const provider = { source: 'provider', session: 'holiday', trading_date: null, observed_at_ms: null,
      message: '순위 거래일 미확인 · 다른 조건은 2026-10-30 완료 데이터 기준입니다. 순위와 같은 시각의 관측을 뜻하지 않습니다.' };
    await page.route(apiExact('screener/scan'), route => route.fulfill({ json: {
      status: 'ok', warnings: [], rank_basis: provider,
      basis_at_ms: Date.parse('2026-10-30T23:59:59.999+09:00'),
      rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 10000,
        price_date: '2026-10-30', trade_value_won: 1e9, change_pct: 10, occurrences: [{
          condition_id: 'rank', condition_key: 'rank', date: '2026-10-30',
          change_pct_rank_match: { direction: 'up', rank: 12, change_pct: 10, market: 'all', venue: 'KRX',
            fetched_at_ms: Date.parse('2026-11-01T12:00:00+09:00'), basis: provider },
        }],
      }],
    } }));
    await page.goto(surface === 'page' ? '/screener' : '/live');
    if (surface === 'panel') await page.getByRole('button', { name: '스크리너 패널 토글', exact: true }).click();
    const scope = surface === 'panel' ? page.getByTestId('screener-panel') : page.locator('main');
    await scope.getByRole('button', { name: surface === 'panel' ? '실시간 감시 시작' : '조회', exact: true }).click();
    await expect(scope.getByText('공급자 마지막 순위 · 거래일 미제공', { exact: true })).toBeVisible();
    await expect(scope.getByText(/다른 조건은 2026-10-30 완료 데이터 기준입니다/)).toBeVisible();
    await scope.getByRole('button', { name: '삼성전자 등락률 순위 근거', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '삼성전자 등락률 순위 근거', exact: true });
    await expect(dialog).toContainText('평가 기준일 2026-10-30');
    await expect(dialog).toContainText('순위 거래일 미확인');
    await expect(dialog).toContainText('12:00:00 조회');
    await expect(dialog).not.toContainText('12:00:00 관측');
    await page.screenshot({ path: testInfo.outputPath(`holiday-screener-provider-${surface}.png`) });
  });
}

test('holiday without a stored snapshot displays and expands the last provider ranking', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  await page.route(apiExact('live/rankings'), route => {
    const params = new URL(route.request().url()).searchParams;
    const limit = Number(params.get('limit') ?? 100);
    return route.fulfill({ json: {
      kind: params.get('kind'), market: 'all', direction: 'up', venue: 'KRX',
      market_open: false, fetched_at_ms: Date.now(), queried_count: limit, has_more: limit < 200,
      basis: { session: 'holiday', source: 'provider', trading_date: null, observed_at_ms: null,
        message: '최근 거래일은 2026-10-30입니다. 공급자 마지막 순위의 거래일·관측 시각은 제공되지 않습니다.' },
      rows: Array.from({ length: limit }, (_, i) => ({ rank: i + 1,
        code: String(100000 + i), name: `마지막순위${i + 1}`, price: 10000, change_pct: 1 })),
    } });
  });
  await page.goto('/live');
  await page.getByRole('button', { name: '순위 패널 토글', exact: true }).click();
  const panel = page.getByTestId('ranking-panel');
  await expect(panel.getByText('휴장', { exact: true })).toBeVisible();
  await expect(panel.getByText('공급자 마지막 순위 · 거래일 미제공', { exact: true })).toBeVisible();
  await expect(panel.getByText(/최근 거래일은 2026-10-30입니다/)).toBeVisible();
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(100);
  await panel.getByRole('button', { name: '101~200위 더 보기', exact: true }).click();
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(200);
  await expect(panel.getByText('추가 조회 실패', { exact: false })).toHaveCount(0);
  await panel.screenshot({ path: testInfo.outputPath('holiday-provider-ranking.png') });
});

test('holiday ranks retain their date and keep existing rows when the stored range is insufficient', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  await page.route(apiExact('live/rankings'), route => {
    const params = new URL(route.request().url()).searchParams;
    const limit = Number(params.get('limit') ?? 100);
    return route.fulfill({ json: {
      kind: params.get('kind'), market: 'all', direction: 'up', venue: 'KRX',
      market_open: false, fetched_at_ms: observed, queried_count: limit === 100 ? 100 : 0,
      has_more: limit === 100,
      basis: limit === 100 ? basis : { ...basis, source: 'unavailable', observed_at_ms: null,
        message: '요청한 범위의 저장된 순위가 없습니다.' },
      rows: limit === 100 ? Array.from({ length: 100 }, (_, i) => ({ rank: i + 1,
        code: String(100000 + i), name: `순위종목${i + 1}`, price: 10000, change_pct: 1 })) : [],
    } });
  });
  await page.goto('/live');
  await page.getByRole('button', { name: '순위 패널 토글', exact: true }).click();
  const panel = page.getByTestId('ranking-panel');
  await expect(panel.getByText('휴장', { exact: true })).toBeVisible();
  await expect(panel.getByText('2026-10-30 14:03:12 관측 · 저장된 순위')).toBeVisible();
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(100);
  await panel.getByRole('button', { name: '101~200위 더 보기', exact: true }).click();
  await expect(panel.getByText('추가 조회 실패', { exact: false })).toBeVisible();
  await expect(panel.getByText('요청한 범위의 저장된 순위가 없습니다.', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: /차트 열기/ })).toHaveCount(100);
  await panel.screenshot({ path: testInfo.outputPath('holiday-ranking.png') });
});

test('screener distinguishes missing minute history and unavailable ranks from a complete zero', async ({ page }) => {
  await installLiveMocks(page);
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: {
    status: 'ok', last_raw_date: '20261030', universe_size: 2,
  } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { schema_version: 1, saves: [{
    id: 'afternoon', name: '오후장 공략', calculation_policy: 'separate_bases_v2',
    conditions: [
      { id: 'rank', type: 'change_pct_rank', params: { top_n: 200 } },
      { id: 'volume', type: 'new_high_vol', params: { timeframe: '3m', lookback: 3, period: 40, volume_basis: 'raw' } },
    ], universe: {}, expression: 'A AND B', created_at_ms: 1, updated_at_ms: 1,
  }] } }));
  let requests = 0;
  await page.route(apiExact('screener/scan'), route => {
    requests += 1;
    return requests === 1 ? route.fulfill({ json: {
      status: 'ok', rows: [], warnings: ['bar_volume_partial'], rank_basis: basis,
      basis_at_ms: observed, scanned_at_ms: Date.now(),
      bar_coverage: { total: 2, complete: 0, incomplete: [
        { code: '005930', condition_id: 'a', reason: 'minute_date_mismatch' },
        { code: '000660', condition_id: 'a', reason: 'historical_open_bar_unavailable' },
      ] },
    } }) : route.fulfill({ status: 409, json: { detail: {
      code: 'screener_rank_history_unavailable', message: '최근 거래일의 저장된 순위가 없습니다.',
    } } });
  });
  await page.goto('/screener');
  const run = page.getByRole('button', { name: '조회', exact: true });
  await run.click();
  await expect(page.getByText('데이터 부족으로 조건을 평가할 수 없습니다', { exact: true })).toBeVisible();
  await expect(page.getByText('순위 기준일의 분봉 없음: 1종목', { exact: true })).toBeVisible();
  await expect(page.getByText('조건에 맞는 종목이 없습니다', { exact: true })).toHaveCount(0);
  await run.click();
  await expect(page.getByText('조회할 수 없습니다', { exact: true })).toBeVisible();
  await expect(page.getByText('최근 거래일의 저장된 순위가 없습니다.', { exact: true })).toBeVisible();
  await expect(page.getByText('조건에 맞는 종목이 없습니다', { exact: true })).toHaveCount(0);
});
