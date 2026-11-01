import { addCondition, openConditionSettings, closeConditionSettings } from './helpers/screenerEditor';
import { test, expect } from '@playwright/test';
import type { ConditionLeaf, ScanRequest, ScreenerExclusion, ScreenerOccurrence } from '../../src/api/screener';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

test('price comparisons preserve independent OHLC operands, dates and per-bar evidence in page and drawer', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved = { id: 'compare', name: '주가 비교 검색', conditions: [] as ConditionLeaf[], universe: {},
    created_at_ms: 1, updated_at_ms: 1 };
  const scans: ScanRequest[] = [];
  const excluded: ScreenerExclusion[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/compare'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiPrefix('screener/exclusions'), route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      const entry = { ...body, id: 'excluded', condition_key: body.condition.id, created_at_ms: 1 };
      excluded.push(entry);
      return route.fulfill({ json: entry });
    }
    return route.fulfill({ json: { schema_version: 1, exclusions: excluded } });
  });
  await page.route(apiExact('screener/scan'), route => {
    const req: ScanRequest = route.request().postDataJSON();
    scans.push(req);
    const occurrences: ScreenerOccurrence[] = req.conditions.flatMap(leaf => {
      if (leaf.type !== 'price_compare' && leaf.type !== 'price_compare_period') return [];
      const p = leaf.params;
      return (leaf.type === 'price_compare_period' ? [0, 1] : [0]).map(i => {
        const start = Date.parse(`2026-07-28T10:0${i * 5}:00+09:00`);
        return { condition_id: leaf.id, condition_key: leaf.id, date: '2026-07-28', bar_start_ms: start,
          bar_price_compare_match: { timeframe: p.timeframe ?? 'D', relation: p.relation,
            left: { ...p.left, value: 120, bar_start_ms: start - p.left.offset * 300_000, is_open: false },
            right: { ...p.right, value: 100, bar_start_ms: start - p.right.offset * 300_000, is_open: false },
            is_open: false, fetched_at_ms: 1 } };
      });
    }).filter(event => !excluded.some(e => e.condition_key === event.condition_key && e.bar_start_ms === event.bar_start_ms));
    return route.fulfill({ json: { status: 'ok', warnings: [], bar_coverage: { total: 1, complete: 1, incomplete: [] },
      rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 120,
        trade_value_won: 1e8, change_pct: 0, occurrences }] } });
  });
  await page.goto('/screener');
  for (const name of ['주가 비교', '기간내 주가 비교']) {
    await addCondition(page, name);
  }
  const latest = page.getByRole('group', { name: '주가 비교 조건', exact: true });
  const period = page.getByRole('group', { name: '기간내 주가 비교 조건', exact: true });
  await openConditionSettings(page, '주가 비교');
  await latest.getByLabel('봉 주기', { exact: true }).selectOption('5m');
  await openConditionSettings(page, '주가 비교');
  await latest.getByLabel('가격 A 봉 위치').fill('2');
  await openConditionSettings(page, '주가 비교');
  await latest.getByLabel('가격 A 종류').selectOption('open');
  await openConditionSettings(page, '주가 비교');
  await latest.getByLabel('가격 B 봉 위치').fill('3');
  await openConditionSettings(page, '주가 비교');
  await latest.getByLabel('가격 B 종류').selectOption('low');
  await openConditionSettings(page, '주가 비교');
  await latest.getByLabel('주가 비교 관계').selectOption('gte');
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('봉 주기', { exact: true }).selectOption('5m');
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('주가 비교 최근 기간(봉)').fill('7');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await expect.poll(() => saved.conditions[0]?.params).toMatchObject({ left: { offset: 2, source: 'open' },
    right: { offset: 3, source: 'low' }, relation: 'gte', timeframe: '5m' });
  await page.reload();
  await openConditionSettings(page, '주가 비교');
  await expect(latest.getByLabel('가격 A 봉 위치')).toHaveValue('2');
  await openConditionSettings(page, '주가 비교');
  await expect(latest.getByLabel('가격 B 종류')).toHaveValue('low');
  await openConditionSettings(page, '기간내 주가 비교');
  await expect(period.getByLabel('주가 비교 최근 기간(봉)')).toHaveValue('7');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '삼성전자 주가 비교 발생 3건', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '삼성전자 발생 건', exact: true });
  await expect(dialog.getByText('2봉 전 시가 120원 ≥ 3봉 전 저가 100원', { exact: false })).toBeVisible();
  await expect(dialog.getByText('A 2026-07-28 09:50 · 완료 · B 2026-07-28 09:45 · 완료')).toBeVisible();
  await dialog.getByRole('button', { name: '삼성전자 2026-07-28 10:05 기간내 주가 비교 발생 건 제외', exact: true }).click();
  await expect.poll(() => excluded.length).toBe(1);
  await expect(dialog).toContainText('발생 2건');
  expect(excluded[0].bar_start_ms).toBe(Date.parse('2026-07-28T10:05:00+09:00'));
  await page.screenshot({ path: testInfo.outputPath('price-comparison-evidence.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('주가 비교 검색 기간').selectOption('date_range');
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('주가 비교 발생 시작일').fill('2026-07-01');
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('주가 비교 발생 종료일').fill('2026-07-28');
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('봉 주기', { exact: true }).selectOption('W');
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('가격 A 종류').selectOption('high');
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('가격 B 봉 위치').fill('2');
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('가격 B 종류').selectOption('close');
  await openConditionSettings(page, '기간내 주가 비교');
  await period.getByLabel('주가 비교 관계').selectOption('eq');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await page.reload();
  await openConditionSettings(page, '기간내 주가 비교');
  await expect(period.getByLabel('주가 비교 발생 시작일')).toHaveValue('2026-07-01');
  await openConditionSettings(page, '기간내 주가 비교');
  await expect(period.getByLabel('가격 B 봉 위치')).toHaveValue('2');
  await openConditionSettings(page, '기간내 주가 비교');
  await expect(period.getByLabel('주가 비교 관계')).toHaveValue('eq');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => scans.at(-1)?.conditions).toEqual(saved.conditions);
  await expect(page.getByRole('button', { name: '조회', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('price-comparison-wide.png'), fullPage: true });
  await page.setViewportSize({ width: 768, height: 1000 });
  for (const [name, label] of [['주가 비교', '가격 A 봉 위치'], ['기간내 주가 비교', '주가 비교 발생 시작일']]) {
    const card = await openConditionSettings(page, name);
    const input = card.getByLabel(label);
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    const boundary = await input.evaluate(el => el.closest('[role="group"]')!.getBoundingClientRect().right);
    const bounds = await input.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(boundary);
  }
  await page.screenshot({ path: testInfo.outputPath('price-comparison-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '스크리너 패널 토글', exact: true }).click();
  const panel = page.getByTestId('screener-panel');
  await panel.getByRole('button', { name: '삼성전자 주가 비교 발생 2건', exact: true }).click();
  await expect(dialog).toContainText('2봉 전 시가 120원 ≥ 3봉 전 저가 100원');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/screener$/);
  expect(errors).toEqual([]);
});
