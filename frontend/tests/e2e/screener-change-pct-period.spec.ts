import { test, expect } from '@playwright/test';
import type { ConditionLeaf, ScanRequest, ScreenerExclusion } from '../../src/api/screener';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

test('period change supports save/reload, candle evidence, per-bar exclusions and date ranges', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved = { id: 'period-rate', name: '기간내 등락률 검색', conditions: [] as ConditionLeaf[], universe: {},
    created_at_ms: 1, updated_at_ms: 1 };
  const scans: ScanRequest[] = [];
  const excluded: ScreenerExclusion[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/period-rate'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiPrefix('screener/exclusions'), route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      const entry = { ...body, id: 'excluded', condition_key: 'period-key', created_at_ms: 1 };
      excluded.push(entry);
      return route.fulfill({ json: entry });
    }
    return route.fulfill({ json: { schema_version: 1, exclusions: excluded } });
  });
  await page.route(apiExact('screener/scan'), route => {
    const req: ScanRequest = route.request().postDataJSON();
    scans.push(req);
    const leaf = req.conditions.find(c => c.type === 'change_pct_period')!;
    const occurrences = [0, 1].map(i => ({ condition_id: leaf.id, condition_key: 'period-key', date: '2026-07-28',
      bar_start_ms: Date.parse(`2026-07-28T10:0${i * 5}:00+09:00`),
      bar_change_match: { timeframe: '5m', change_reference: 'previous_bar', change_pct: 10 + i * 5,
        close: 110 + i * 5, reference_close: 100, reference_start_ms: 1, is_open: false, fetched_at_ms: 1 } }))
      .filter(event => !excluded.some(e => e.bar_start_ms === event.bar_start_ms));
    return route.fulfill({ json: { status: 'ok', warnings: [],
      bar_coverage: { total: 1, complete: 1, incomplete: [] },
      rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 110,
        trade_value_won: 1e8, change_pct: 0, occurrences }] } });
  });
  await page.goto('/screener');
  await page.getByRole('button', { name: '조건 추가', exact: true }).click();
  await page.getByRole('menuitem', { name: '기간내 등락률', exact: true }).click();
  const card = page.getByRole('group', { name: '기간내 등락률 조건', exact: true });
  await card.getByRole('combobox', { name: '봉 주기', exact: true }).selectOption('5m');
  await card.getByLabel('등락률 최근 기간(봉)').fill('7');
  await card.getByLabel('등락률 비교 기준').selectOption('previous_bar');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saved.conditions[0]?.params).toMatchObject({ lookback: 7, timeframe: '5m',
    change_reference: 'previous_bar', op: 'gte', pct: 10 });
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(card.getByLabel('등락률 최근 기간(봉)')).toHaveValue('7');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await page.getByRole('button', { name: '삼성전자 기간내 등락률 발생 2건', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '삼성전자 발생 건', exact: true });
  await expect(dialog.getByText('2026-07-28 10:05', { exact: true })).toBeVisible();
  await expect(dialog.getByText('직전 봉 종가 대비 15% · 종가 115원 · 기준 100원 · 완료')).toBeVisible();
  await dialog.getByRole('button', { name: '삼성전자 2026-07-28 10:05 기간내 등락률 발생 건 제외', exact: true }).click();
  await expect.poll(() => excluded.length).toBe(1);
  await expect(dialog.getByText('발생 1건', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '삼성전자 기간내 등락률 발생 1건', exact: true })).toBeVisible();
  expect(excluded[0].bar_start_ms).toBe(Date.parse('2026-07-28T10:05:00+09:00'));
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await card.getByRole('combobox', { name: '등락률 검색 기간', exact: true }).selectOption('date_range');
  await card.getByLabel('등락률 발생 시작일').fill('2026-07-01');
  await card.getByLabel('등락률 발생 종료일').fill('2026-07-28');
  await card.getByRole('combobox', { name: '등락률 연산', exact: true }).selectOption('between');
  await card.getByLabel('등락률 하한(%)').fill('-10');
  await card.getByLabel('등락률 상한(%)').fill('20');
  await card.getByLabel('등락률 비교 기준').selectOption('bar_open');
  await card.getByRole('combobox', { name: '봉 주기', exact: true }).selectOption('W');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saved.conditions[0]?.params).toMatchObject({ mode: 'date_range', timeframe: 'W',
    start_date: '2026-07-01', end_date: '2026-07-28', change_reference: 'bar_open', op: 'between', lo: -10, hi: 20 });
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(card.getByLabel('등락률 발생 시작일')).toHaveValue('2026-07-01');
  await expect(card.getByLabel('등락률 하한(%)')).toHaveValue('-10');
  await expect(card.getByLabel('등락률 비교 기준')).toHaveValue('bar_open');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => scans.at(-1)?.conditions).toEqual(saved.conditions);
  await expect(page.getByRole('button', { name: '조회', exact: true })).toBeEnabled();
  await expect(page.getByText('조건 변경됨 · 다시 조회 필요', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('period-change-wide.png'), fullPage: true });
  await page.setViewportSize({ width: 768, height: 1000 });
  for (const input of [card.getByLabel('등락률 발생 시작일'), card.getByLabel('등락률 하한(%)')]) {
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    const parent = await card.boundingBox();
    const bounds = await input.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(parent!.x + parent!.width);
  }
  await page.screenshot({ path: testInfo.outputPath('period-change-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '스크리너 패널 토글', exact: true }).click();
  const panel = page.getByTestId('screener-panel');
  await panel.getByRole('button', { name: '삼성전자 기간내 등락률 발생 1건', exact: true }).click();
  await expect(dialog).toContainText('직전 봉 종가 대비 10%');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/screener$/);
  expect(errors).toEqual([]);
});
