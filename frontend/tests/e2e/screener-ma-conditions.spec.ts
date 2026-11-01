import { addCondition, openConditionSettings, closeConditionSettings } from './helpers/screenerEditor';
import { test, expect } from '@playwright/test';
import type { ConditionLeaf, MaOperand, ScanRequest, ScreenerExclusion, ScreenerOccurrence } from '../../src/api/screener';
import { apiExact, apiPrefix } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

test('SMA comparison, cross, gap and slope retain inputs and expose historical evidence in page and drawer', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved = { id: 'ma-conditions', name: '이동평균 조건 모음', conditions: [] as ConditionLeaf[], universe: {},
    created_at_ms: 1, updated_at_ms: 1 };
  const scans: ScanRequest[] = [];
  const excluded: ScreenerExclusion[] = [];
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok', warnings: [] } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/ma-conditions'), route => {
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
      if (leaf.type !== 'ma_compare' && leaf.type !== 'ma_compare_period' && leaf.type !== 'ma_cross' && leaf.type !== 'ma_cross_period'
          && leaf.type !== 'ma_gap' && leaf.type !== 'ma_gap_period' && leaf.type !== 'ma_slope' && leaf.type !== 'ma_slope_period') return [];
      const p = leaf.params;
      if (!('left' in p || 'average' in p)) return [];
      const kind = leaf.type.includes('cross') ? 'cross' : leaf.type.includes('gap') ? 'gap' : leaf.type.includes('slope') ? 'slope' : 'compare';
      const start = Date.parse('2026-07-28T10:00:00+09:00');
      const value = (operand: MaOperand, number: number) => ({ ...operand,
        period: operand.kind === 'sma' ? operand.period : null, value: number,
        bar_start_ms: start - operand.offset * 300_000, window_start_ms: start - 100 * 300_000, is_open: false });
      const a = 'average' in p ? p.average : p.left;
      const b: MaOperand = 'average' in p ? { ...p.average, offset: p.average.offset + p.lag } : p.right;
      const down = 'direction' in p && p.direction === 'down';
      const event: ScreenerOccurrence = { condition_id: leaf.id, condition_key: leaf.id, date: '2026-07-28', bar_start_ms: start,
        bar_ma_match: { kind, timeframe: p.timeframe ?? 'D', left: value(a, kind === 'gap' ? 101 : kind === 'slope' ? 102 : down ? 90 : 110), right: value(b, 100),
          previous_left: kind === 'cross' ? value(a, down ? 110 : 90) : null,
          previous_right: kind === 'cross' ? value(b, 100) : null,
          relation: 'relation' in p ? p.relation : null, direction: 'direction' in p ? p.direction : null,
          value_pct: kind === 'gap' ? 1 : kind === 'slope' ? 2 : null, is_open: false, fetched_at_ms: 1 } };
      return leaf.type === 'ma_compare_period' ? [event, { ...event, bar_start_ms: start + 300_000,
        bar_ma_match: { ...event.bar_ma_match!,
          left: { ...event.bar_ma_match!.left, bar_start_ms: event.bar_ma_match!.left.bar_start_ms + 300_000,
            window_start_ms: event.bar_ma_match!.left.window_start_ms + 300_000 },
          right: { ...event.bar_ma_match!.right, bar_start_ms: event.bar_ma_match!.right.bar_start_ms + 300_000,
            window_start_ms: event.bar_ma_match!.right.window_start_ms + 300_000 } } }] : [event];
    }).filter(e => !excluded.some(x => x.condition_key === e.condition_key && x.bar_start_ms === e.bar_start_ms));
    return route.fulfill({ json: { status: 'ok', warnings: [], bar_coverage: { total: 1, complete: 1, incomplete: [] },
      rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 110, trade_value_won: 1e8,
        change_pct: 0, occurrences }] } });
  });
  await page.goto('/screener');
  const names = ['이동평균 비교', '기간내 이동평균 비교', '이동평균 돌파·교차', '기간내 이동평균 돌파·교차',
    '이동평균 이격률', '기간내 이동평균 이격률', '이동평균 기울기', '기간내 이동평균 기울기'];
  for (const name of names) {
    await addCondition(page, name);
  }
  const card = (name: string) => page.getByRole('group', { name: `${name} 조건`, exact: true });
  await openConditionSettings(page, names[0]);
  await card(names[0]).getByLabel('대상 A 대상').selectOption('sma');
  await openConditionSettings(page, names[0]);
  await card(names[0]).getByLabel('대상 A 이동평균 기간').fill('5');
  await openConditionSettings(page, names[0]);
  await card(names[0]).getByLabel('대상 B 이동평균 기간').fill('60');
  await openConditionSettings(page, names[1]);
  await card(names[1]).getByLabel('봉 주기', { exact: true }).selectOption('5m');
  await openConditionSettings(page, names[1]);
  await card(names[1]).getByLabel('이동평균 최근 기간(봉)').fill('7');
  await openConditionSettings(page, names[2]);
  await card(names[2]).getByLabel('봉 주기', { exact: true }).selectOption('5m');
  await openConditionSettings(page, names[2]);
  await card(names[2]).getByLabel('대상 A 계산가격').selectOption('high');
  await openConditionSettings(page, names[3]);
  await card(names[3]).getByLabel('돌파·교차 방향').selectOption('down');
  await openConditionSettings(page, names[5]);
  await card(names[5]).getByLabel('봉 주기', { exact: true }).selectOption('W');
  await openConditionSettings(page, names[4]);
  await card(names[4]).getByLabel('변화율 하한(%)').fill('-3');
  await openConditionSettings(page, names[4]);
  await card(names[4]).getByLabel('변화율 상한(%)').fill('3');
  await openConditionSettings(page, names[6]);
  await card(names[6]).getByLabel('대상 이동평균 기간').fill('30');
  await openConditionSettings(page, names[6]);
  await card(names[6]).getByLabel('대상 계산가격').selectOption('open');
  await openConditionSettings(page, names[6]);
  await card(names[6]).getByLabel('기울기 비교 간격(봉)').fill('7');
  await openConditionSettings(page, names[7]);
  await card(names[7]).getByLabel('봉 주기', { exact: true }).selectOption('M');
  await openConditionSettings(page, names[7]);
  await expect(card(names[7]).getByLabel('봉 주기', { exact: true })).toHaveValue('M');
  await openConditionSettings(page, names[7]);
  await card(names[7]).getByLabel('이동평균 검색 기간').selectOption('date_range');
  await openConditionSettings(page, names[7]);
  await expect(card(names[7]).getByLabel('봉 주기', { exact: true })).toHaveValue('M');
  await openConditionSettings(page, names[7]);
  await card(names[7]).getByLabel('이동평균 발생 시작일').fill('2026-07-01');
  await openConditionSettings(page, names[7]);
  await card(names[7]).getByLabel('이동평균 발생 종료일').fill('2026-07-28');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '저장본으로 되돌리기', exact: true })).toHaveCount(0);
  await expect.poll(() => saved.conditions.length).toBe(8);
  await page.reload();
  await openConditionSettings(page, names[0]);
  await expect(card(names[0]).getByLabel('대상 A 이동평균 기간')).toHaveValue('5');
  await openConditionSettings(page, names[1]);
  await expect(card(names[1]).getByLabel('이동평균 최근 기간(봉)')).toHaveValue('7');
  await openConditionSettings(page, names[6]);
  await expect(card(names[6]).getByLabel('대상 계산가격')).toHaveValue('open');
  await openConditionSettings(page, names[6]);
  await expect(card(names[6]).getByLabel('기울기 비교 간격(봉)')).toHaveValue('7');
  await openConditionSettings(page, names[7]);
  await expect(card(names[7]).getByLabel('이동평균 발생 시작일')).toHaveValue('2026-07-01');
  await openConditionSettings(page, names[7]);
  await expect(card(names[7]).getByLabel('봉 주기', { exact: true })).toHaveValue('M');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await openConditionSettings(page, names[7]);
  await expect(card(names[7]).getByLabel('봉 주기', { exact: true })).toHaveValue('M');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '삼성전자 이동평균 발생 9건', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '삼성전자 발생 건', exact: true });
  await expect(dialog).toContainText('SMA5(종가) 110원 ≥ 0봉 전 SMA60(종가) 100원');
  await expect(dialog).toContainText('직전 A 90원 · B 100원 → 상향 돌파·교차');
  await expect(dialog).toContainText('이격률 1%');
  await expect(dialog).toContainText('기울기 2%');
  await page.screenshot({ path: testInfo.outputPath('ma-evidence-wide.png'), fullPage: true });
  await dialog.getByRole('button', { name: '삼성전자 2026-07-28 10:05 기간내 이동평균 비교 발생 건 제외', exact: true }).click();
  await expect.poll(() => excluded.length).toBe(1);
  await expect(dialog).toContainText('발생 8건');
  expect(excluded[0].bar_start_ms).toBe(Date.parse('2026-07-28T10:05:00+09:00'));
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await openConditionSettings(page, names[7]);
  await expect(card(names[7]).getByLabel('봉 주기', { exact: true })).toHaveValue('M');
  expect(scans.at(-1)?.conditions).toEqual(saved.conditions);
  await page.setViewportSize({ width: 768, height: 1000 });
  for (const name of names) {
    await openConditionSettings(page, name);
    const input = card(name).getByRole('combobox', { name: '봉 주기', exact: true });
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    if (name === names[7]) await expect(input).toHaveValue('M');
    await openConditionSettings(page, name);
    const parent = await card(name).boundingBox();
    const bounds = await input.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(parent!.x + parent!.width);
  }
  await page.screenshot({ path: testInfo.outputPath('ma-editor-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '스크리너 패널 토글', exact: true }).click();
  await page.getByTestId('screener-panel').getByRole('button', { name: '삼성전자 이동평균 발생 8건', exact: true }).click();
  await expect(dialog).toContainText('기울기 2%');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/screener$/);
  expect(errors).toEqual([]);
});
