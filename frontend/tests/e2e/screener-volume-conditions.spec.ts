import { test, expect } from '@playwright/test';
import type { ConditionLeaf, ScanRequest, ScreenerExclusion, ScreenerOccurrence } from '../../src/api/screener';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

test('volume range, comparison and prior average retain settings and expose per-bar evidence in page and drawer', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved = { id: 'volume-conditions', name: '거래량 조건 모음', calculation_policy: 'separate_bases_v2' as const,
    conditions: [] as ConditionLeaf[], universe: {}, created_at_ms: 1, updated_at_ms: 1 };
  const excluded: ScreenerExclusion[] = [];
  const scans: ScanRequest[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/volume-conditions'), route => {
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
      if (leaf.type !== 'volume_range' && leaf.type !== 'volume_range_period' && leaf.type !== 'volume_compare'
          && leaf.type !== 'volume_compare_period' && leaf.type !== 'volume_ratio' && leaf.type !== 'volume_ratio_period') return [];
      const p = leaf.params;
      const kind = 'left_offset' in p ? 'compare' : 'op' in p ? 'ratio' : 'range';
      const offset = 'left_offset' in p ? p.left_offset : p.offset;
      const start = Date.parse('2026-07-28T10:00:00+09:00');
      const value = (position: number, quantity: string, at: number) => ({ offset: position, value: quantity,
        bar_start_ms: at - position * 300000, is_open: false });
      const event = (at: number): ScreenerOccurrence => ({ condition_id: leaf.id, condition_key: leaf.id,
        date: '2026-07-28', bar_start_ms: at, bar_volume_condition_match: {
          kind, timeframe: p.timeframe ?? 'D', basis: p.timeframe?.endsWith('m') ? 'raw' : p.volume_basis ?? 'share_adjusted',
          left: value(offset, '5000000', at), right: 'right_offset' in p ? value(p.right_offset, '3000000', at) : null,
          relation: 'relation' in p ? p.relation : null, average: kind === 'ratio' ? '2000000' : null,
          period: 'period' in p ? p.period : null, window_start_ms: kind === 'ratio' ? at - 6000000 : null,
          window_end_ms: kind === 'ratio' ? at - 300000 : null, ratio_pct: kind === 'ratio' ? 250 : null,
          is_open: false, fetched_at_ms: 1 } });
      return leaf.type === 'volume_range_period' ? [event(start), event(start + 300000)] : [event(start)];
    }).filter(event => !excluded.some(x => x.condition_key === event.condition_key && x.bar_start_ms === event.bar_start_ms));
    return route.fulfill({ json: { status: 'ok', warnings: [], bar_coverage: { total: 1, complete: 1, incomplete: [] },
      rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 110, trade_value_won: 1e8,
        change_pct: 0, occurrences }] } });
  });
  await page.goto('/screener');
  const names = ['거래량 범위', '기간내 거래량 범위', '거래량 비교', '기간내 거래량 비교', '평균 대비 거래량', '기간내 평균 대비 거래량'];
  for (const name of names) {
    await page.getByRole('button', { name: '조건 추가', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
  const card = (name: string) => page.getByRole('group', { name: `${name} 조건`, exact: true });
  await card(names[0]).getByLabel('거래량 하한(주)').fill('1000000');
  await card(names[0]).getByLabel('거래량 상한(주)').fill('9000000');
  await card(names[0]).getByLabel('거래량 기준').selectOption('raw');
  await card(names[1]).getByLabel('봉 주기', { exact: true }).selectOption('5m');
  await card(names[1]).getByLabel('거래량 최근 기간(봉)').fill('7');
  await card(names[2]).getByLabel('거래량 A 봉 위치').fill('2');
  await card(names[2]).getByLabel('거래량 B 봉 위치').fill('5');
  await card(names[3]).getByLabel('거래량 비교 관계').selectOption('gte');
  await card(names[4]).getByLabel('거래량 평균 기간(봉)').fill('60');
  await card(names[4]).getByLabel('평균 대비 거래량 관계').selectOption('between');
  await card(names[4]).getByLabel('거래량 비율 하한(%)').fill('200');
  await card(names[4]).getByLabel('거래량 비율 상한(%)').fill('300');
  await card(names[5]).getByLabel('봉 주기', { exact: true }).selectOption('M');
  await card(names[5]).getByLabel('거래량 검색 기간').selectOption('date_range');
  await expect(card(names[5]).getByLabel('봉 주기', { exact: true })).toHaveValue('M');
  await card(names[5]).getByLabel('거래량 발생 시작일').fill('2026-07-01');
  await card(names[5]).getByLabel('거래량 발생 종료일').fill('2026-07-28');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await expect.poll(() => saved.conditions.length).toBe(6);
  await page.reload();
  await expect(card(names[0]).getByLabel('거래량 하한(주)')).toHaveValue('1000000');
  await expect(card(names[0]).getByLabel('거래량 기준')).toHaveValue('raw');
  await expect(card(names[1]).getByLabel('거래량 최근 기간(봉)')).toHaveValue('7');
  await expect(card(names[2]).getByLabel('거래량 A 봉 위치')).toHaveValue('2');
  await expect(card(names[4]).getByLabel('거래량 평균 기간(봉)')).toHaveValue('60');
  await expect(card(names[4]).getByLabel('거래량 비율 상한(%)')).toHaveValue('300');
  await expect(card(names[5]).getByLabel('거래량 발생 시작일')).toHaveValue('2026-07-01');
  await expect(card(names[5]).getByLabel('봉 주기', { exact: true })).toHaveValue('M');
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await page.getByRole('button', { name: '삼성전자 거래량 발생 7건', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '삼성전자 발생 건', exact: true });
  await expect(dialog).toContainText('2봉 전 거래량 5,000,000주 > 5봉 전 거래량 3,000,000주');
  await expect(dialog).toContainText('직전 60봉 평균 2,000,000주 · 평균의 250%');
  await expect(dialog).toContainText('평균 구간');
  await expect(dialog).toContainText('실제 거래량');
  await page.screenshot({ path: testInfo.outputPath('volume-evidence-wide.png'), fullPage: true });
  await dialog.getByRole('button', { name: '삼성전자 2026-07-28 10:05 기간내 거래량 범위 발생 건 제외', exact: true }).click();
  await expect.poll(() => excluded.length).toBe(1);
  await expect(dialog).toContainText('발생 6건');
  expect(excluded[0].bar_start_ms).toBe(Date.parse('2026-07-28T10:05:00+09:00'));
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(scans.at(-1)?.conditions).toEqual(saved.conditions);
  await page.setViewportSize({ width: 768, height: 1000 });
  for (const name of names) {
    const input = card(name).getByLabel('봉 주기', { exact: true });
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    const parent = await card(name).boundingBox();
    const bounds = await input.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(parent!.x + parent!.width);
  }
  await page.screenshot({ path: testInfo.outputPath('volume-editor-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '스크리너 패널 토글', exact: true }).click();
  await page.getByTestId('screener-panel').getByRole('button', { name: '삼성전자 거래량 발생 6건', exact: true }).click();
  await expect(dialog).toContainText('평균의 250%');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/screener$/);
  expect(errors).toEqual([]);
});
