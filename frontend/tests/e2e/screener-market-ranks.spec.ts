import { addCondition, openConditionSettings, closeConditionSettings } from './helpers/screenerEditor';
import { test, expect } from '@playwright/test';
import type { SavedScreener } from '../../src/api/savedScreeners';
import type { MarketRankKind, ScanRequest } from '../../src/api/screener';
import { apiExact } from './helpers/apiRoutes';
import { installLiveMocks } from './helpers/liveMocks';

const definitions = [
  ['volume_surge_rank', '거래량 급증 순위', 'surge', '거래량 급증'],
  ['volume_rank', '당일 거래량 순위', 'volume', '거래량'],
  ['program_net_buy_rank', '프로그램 순매수금액 순위', 'program', '프로그램'],
  ['institution_net_buy_rank', '기관 추정 순매수금액 순위', 'institution', '기관'],
  ['foreign_net_buy_rank', '외국인 추정 순매수금액 순위', 'foreign', '외국인'],
] as const;

test('add all five market ranks, enforce investor limit, save, reload and inspect recorded metrics', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  let saved: SavedScreener = { id: 'market-ranks', name: '순위 조합', conditions: [
    { id: 'price', type: 'price_range', params: { min: 1000 } },
  ], universe: {}, created_at_ms: 1, updated_at_ms: 1 };
  let request: ScanRequest | null = null;
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/market-ranks'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => {
    request = route.request().postDataJSON();
    return route.fulfill({ json: { status: 'ok', warnings: [],
      basis_at_ms: Date.parse('2026-10-30T10:20:30+09:00'),
      fallback_basis_at_ms: Date.parse('2026-10-30T10:20:00+09:00'),
      rows: [{ code: '005930', name: '삼성전자',
      market: 'KOSPI', price: 1000, trade_value_won: 1e9, change_pct: 0,
      occurrences: definitions.map(([type, , kind]) => ({
        condition_id: saved.conditions.find(leaf => leaf.type === type)!.id,
        condition_key: type, date: '2026-10-30', market_rank_match: {
          kind, rank: 12, market: 'all', venue: kind === 'institution' || kind === 'foreign' ? null : 'KRX',
          quote_venue: kind === 'institution' || kind === 'foreign' ? 'KRX' : null,
          fetched_at_ms: Date.parse('2026-10-30T10:20:00+09:00'), volume_surge_pct: 250.5,
          volume: 12345, net_buy_won: 5e9,
        },
      })),
    }] } });
  });
  await page.goto('/screener');
  for (const [, label] of definitions) {
    await addCondition(page, label);
    await openConditionSettings(page, label);
    await expect(page.getByRole('group', { name: `${label} 조건`, exact: true }).getByRole('textbox'))
      .toHaveValue(label.startsWith('프로그램') ? '50' : '100');
  }
  await openConditionSettings(page, '기관 추정 순매수금액 순위');
  const investor = page.getByRole('group', { name: '기관 추정 순매수금액 순위 조건', exact: true });
  const input = investor.getByRole('textbox');
  await input.fill('101');
  await input.press('Tab');
  await expect(investor.getByRole('alert')).toContainText('100 이하');
  await expect(page.getByRole('button', { name: '조회', exact: true })).toBeDisabled();
  await input.fill('100');
  await input.press('Tab');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saved.conditions.length).toBe(6);
  await page.reload();
  for (const [, label] of definitions) {
    await openConditionSettings(page, label);
    await expect(page.getByRole('group', { name: `${label} 조건`, exact: true })).toBeVisible();
  }
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await expect.poll(() => request?.conditions.length).toBe(6);
  await expect(page.getByTestId('screener-basis-time')).toHaveText('2026-10-30 10:20 기준 · 관측 시각 혼합');
  const expectedText: Record<MarketRankKind, string> = { surge: '1분 기준 급증률 250.5%', volume: '당일 거래량 12,345주',
    program: '순매수금액 50억', institution: '장중 추정 순매수금액 50억', foreign: '장중 추정 순매수금액 50억' };
  for (const [, , kind, label] of definitions) {
    await closeConditionSettings(page);
    await page.getByRole('button', { name: `삼성전자 ${label} 순위 근거`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `삼성전자 ${label} 순위 근거`, exact: true });
    await expect(dialog).toContainText(expectedText[kind]);
    if (kind === 'institution' || kind === 'foreign') await expect(dialog).toContainText('거래소 지정 미지원');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  await openConditionSettings(page, '기관 추정 순매수금액 순위');
  await investor.screenshot({ path: testInfo.outputPath('investor-rank-condition.png') });
});

test('an old upward rank can switch to downward, persist and display downward evidence', async ({ page }) => {
  await installLiveMocks(page);
  let saved: SavedScreener = { id: 'down-rank', name: '하락 순위', conditions: [
    { id: 'rank', type: 'change_pct_rank', params: { top_n: 100 } },
  ], universe: {}, created_at_ms: 1, updated_at_ms: 1 };
  await page.route(apiExact('screener/status'), route => route.fulfill({ json: { status: 'ok' } }));
  await page.route(apiExact('screener/saves'), route => route.fulfill({ json: { saves: [saved] } }));
  await page.route(apiExact('screener/saves/down-rank'), route => {
    saved = { ...saved, ...route.request().postDataJSON(), updated_at_ms: saved.updated_at_ms + 1 };
    return route.fulfill({ json: saved });
  });
  await page.route(apiExact('screener/scan'), route => route.fulfill({ json: {
    status: 'ok', warnings: [], rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 1000,
      trade_value_won: 1e9, change_pct: -20, occurrences: [{ condition_id: 'rank', condition_key: 'down',
        date: '2026-10-30', change_pct_rank_match: { direction: 'down', rank: 12, change_pct: -20,
          market: 'all', venue: 'KRX', fetched_at_ms: 1 } }],
    }],
  } }));
  await page.goto('/screener');
  await openConditionSettings(page, '당일 등락률 순위');
  const direction = page.getByRole('combobox', { name: '등락률 순위 방향', exact: true });
  await expect(direction).toHaveValue('up');
  await direction.selectOption('down');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => saved.conditions[0].params).toMatchObject({ top_n: 100, direction: 'down' });
  await page.reload();
  await openConditionSettings(page, '당일 등락률 순위');
  await expect(direction).toHaveValue('down');
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '조회', exact: true }).click();
  await closeConditionSettings(page);
  await page.getByRole('button', { name: '삼성전자 하락률 순위 근거', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('하락률 12위');
  await expect(page.getByRole('dialog')).toContainText('전일 종가 대비 -20%');
});
