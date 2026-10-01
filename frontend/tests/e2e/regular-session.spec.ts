import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test('정규장 필터는 분봉 원천 주기·초봉 경계·새로고침과 캘린더 비활성에 적용된다', async ({ page }) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const today = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
  const date = today.replaceAll('-', '');
  const at = (time: string) => Date.parse(`${today}T${time}+09:00`);
  const all = ['08:59:50', '09:00:00', '15:29:50', '15:30:00', '16:00:00'].map((time, i) => ({ t_ms: at(time), open: 100+i, high: 110+i, low: 90+i, close: 105+i, volume: 10, count: 1, trade_value: 1000 }));
  await page.route('**/api/live/second-trade-dates?**', r => r.fulfill({ json: { dates: [date] } }));
  await page.route('**/api/live/second-aggregates?**', r => {
    const url = new URL(r.request().url());
    const regular = url.searchParams.get('regular_session_only') === 'true';
    const observed = url.searchParams.get('date') === date ? all.filter(b => !regular || b.t_ms >= at('09:00:00') && b.t_ms <= at('15:30:00')) : [];
    const from = Number(url.searchParams.get('from_ms') ?? 0), to = Number(url.searchParams.get('to_ms') ?? Infinity);
    return r.fulfill({ json: { code: '098460', venue: 'KRX', date: url.searchParams.get('date'), seconds: Number(url.searchParams.get('seconds')), source: 'second_trades',
      status: observed.length ? 'observed' : 'unavailable', coverage: 'unverified', storage_error: null, first_observed_ms: observed[0]?.t_ms ?? null,
      last_observed_ms: observed.at(-1)?.t_ms ?? null, bars: observed.filter(b => b.t_ms >= from && b.t_ms < to), prices: [] } });
  });
  await page.goto('/live?code=098460');
  await page.getByRole('button', { name: '분봉 선택 열기: 1분', exact: true }).first().click();
  await page.getByRole('menuitemradio', { name: '60분', exact: true }).click();
  await page.getByRole('button', { name: '차트 더보기' }).first().click();
  await page.getByRole('checkbox', { name: '정규장만 보기', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: '정규장만 보기', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '분봉 선택 열기: 60분', exact: true }).first().click();
  await page.getByRole('menuitemradio', { name: '10초', exact: true }).click();
  const chart = page.getByTestId('second-chart');
  await expect(chart).toHaveAttribute('data-bar-count', '3');
  await chart.getByRole('button', { name: '차트 더보기' }).click();
  await page.getByRole('checkbox', { name: '정규장만 보기', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await expect(chart).toHaveAttribute('data-bar-count', '5');
  await chart.getByRole('button', { name: '차트 더보기' }).click();
  await page.getByRole('checkbox', { name: '정규장만 보기', exact: true }).check();
  await page.reload();
  await expect(chart).toHaveAttribute('data-bar-count', '3');
  await chart.getByRole('button', { name: '차트 더보기' }).click();
  await expect(page.getByRole('checkbox', { name: '정규장만 보기', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await chart.getByRole('button', { name: '일', exact: true }).click();
  await page.getByRole('button', { name: '차트 더보기' }).first().click();
  await expect(page.getByRole('checkbox', { name: '정규장만 보기', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});
