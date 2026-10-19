import { test, expect, type Page } from '@playwright/test';
import type { OptionSentiment } from '../../src/api/optionSentiment';
import { PAD_L, PAD_R } from '../../src/sentiment/strikeScale';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

const NOW = Date.parse('2026-10-19T14:30:00+09:00');
function fixture(now = NOW, shift = 0): OptionSentiment {
  const strikes = [700, 950, 975, 1000, 1025, 1050, 1075, 1100, 1125, 1150, 1200, 1597.5];
  const oi = strikes.map((k, i) => ({ strike: k + shift, call_oi: i === 11 ? 14444 : 400 + i * 210, put_oi: 2000 - i * 70 }));
  const gex = strikes.filter(k => k !== 1100).map(k => ({ strike: k + shift, gex: (k - 1000) * 1e8 }));
  const callOi = oi.reduce((n, r) => n + r.call_oi, 0), putOi = oi.reduce((n, r) => n + r.put_oi, 0);
  return {
    unavailable: null, expiry: shift ? '202612' : '202611', chain_size: 682,
    underlying: 1007.83 + shift, full_as_of_ms: now - 5 * 60_000, atm_as_of_ms: now - 10_000,
    put_call: { volume_ratio: 14413 / 23235, oi_ratio: putOi / callOi, call_volume: 23235, put_volume: 14413, call_oi: callOi, put_oi: putOi },
    put_call_series: Array.from({ length: 16 }, (_, i) => ({ t_ms: now - (16 - i) * 300_000, volume_ratio: .7 - i * .005, oi_ratio: .9 + i * .001 })),
    oi_distribution: { strikes: oi, max_pain: 1100 + shift },
    gamma_exposure: { points: gex, total: gex.reduce((n, r) => n + r.gex, 0), flip_strike: 702.5 + shift },
    iv_skew: { points: strikes.filter(k => k >= 950 && k <= 1200).map((k, i) => ({ strike: k + shift, call_iv: 32 + i, put_iv: k === 1100 ? null : 38 + i, oi: 400 + i * 200 })), atm_iv: 36.5, risk_reversal_25d: 8.46 },
  };
}

async function setup(page: Page, getResponse: () => OptionSentiment = fixture) {
  await installLiveMocks(page);
  let calls = 0;
  await page.route(apiExact('sentiment/option'), route => { calls++; return route.fulfill({ json: getResponse() }); });
  await page.goto('/sentiment');
  return () => calls;
}

for (const width of [1920, 1440, 800, 600]) {
  test(`structure and side panels fit at ${width}px in both themes and enlarged text`, async ({ page }, info) => {
    await page.clock.install({ time: NOW });
    await page.setViewportSize({ width, height: 1400 });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await setup(page);
    await expect(page.getByRole('heading', { name: '행사가 구조', exact: true })).toBeVisible();
    for (const [theme, fontSize] of [['trading-desk', 16], ['ledger-studio', 20]] as const) {
      await page.evaluate(([theme, fontSize]) => { document.documentElement.dataset.theme = String(theme); document.documentElement.style.fontSize = `${fontSize}px`; }, [theme, fontSize] as const);
      const metrics = await page.locator('.sentiment-page').evaluate(root => ({
        right: root.getBoundingClientRect().right,
        overflow: [...root.querySelectorAll<HTMLElement>('.sentiment-desk,.sentiment-overview,.sentiment-structure,.market-card')].map(el => el.scrollWidth - el.clientWidth),
      }));
      expect(metrics.right).toBeLessThanOrEqual(width);
      expect(metrics.overflow.every(n => n <= 1)).toBe(true);
      await expect.poll(() => page.locator('.sentiment-strike-chart').evaluateAll(nodes => nodes.every(node => Math.abs(node.getBoundingClientRect().width - (node as SVGSVGElement).viewBox.baseVal.width) <= 1))).toBe(true);
      const aligned = await page.locator('.sentiment-strike-chart').evaluateAll(nodes => nodes.map(node => node.querySelector('[data-strike-guide]')!.getBoundingClientRect().x));
      expect(Math.max(...aligned) - Math.min(...aligned)).toBeLessThan(1);
      const ivAlignment = await page.getByRole('img', { name: '행사가별 내재변동성 스마일' }).evaluate(svg => {
        const path = svg.querySelector('path[stroke="var(--price-up)"]')!;
        const firstPoint = (path.getAttribute('d')!.match(/^M([\d.-]+),([\d.-]+)/) ?? []).slice(1).map(Number);
        const dot = svg.querySelector('circle[fill="var(--price-up)"]')!;
        return [Math.abs(firstPoint[0] - Number(dot.getAttribute('cx'))), Math.abs(firstPoint[1] - Number(dot.getAttribute('cy')))];
      });
      expect(ivAlignment.every(delta => delta <= .1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`sentiment-${width}-${theme}.png`) });
    }
    expect(errors).toEqual([]);
  });
}

test('pointer, keyboard and contributor selection share one exact strike without extra requests', async ({ page }) => {
  await page.clock.install({ time: NOW });
  await page.setViewportSize({ width: 1440, height: 1400 });
  const calls = await setup(page);
  const chart = page.getByRole('img', { name: '행사가별 미결제약정 분포' });
  const bounds = (await chart.boundingBox())!;
  // ATM domain stays defined by the underlying ±15%, as before the redesign.
  const lo = 1007.83 * .85, hi = 1007.83 * 1.15;
  await chart.hover({ position: { x: PAD_L + (1100 - lo) / (hi - lo) * (bounds.width - PAD_L - PAD_R), y: 50 } });
  const slider = page.getByRole('slider', { name: '비교할 행사가' });
  await expect(slider).toHaveAttribute('aria-valuetext', '1,100');
  const detail = page.getByLabel('선택 행사가 상세');
  await expect(detail.locator('dd').nth(1)).toHaveText('—');
  await expect(detail.locator('dd').nth(2)).toHaveText('38.00 / —');
  await expect(page.locator('[data-strike-guide="1100"]')).toHaveCount(3);
  await slider.focus(); await slider.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', '950');
  await slider.press('End'); await expect(slider).toHaveAttribute('aria-valuetext', '1,150');
  await expect(slider).toBeFocused();
  const outlier = page.getByRole('button', { name: '1597.5', exact: true });
  await outlier.click();
  await expect(outlier).toBeFocused();
  await expect(page.getByRole('button', { name: '전체', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(slider).toHaveAttribute('aria-valuetext', '1,597.5');
  await expect(page.locator('[data-strike-guide="1597.5"]')).toHaveCount(3);
  await expect(detail).toContainText('14,444');
  expect(calls()).toBe(1);
});

test('thirty-second polling and expiry changes keep data and observation ages separate', async ({ page }) => {
  await page.clock.install({ time: NOW });
  let response = fixture();
  const calls = await setup(page, () => response);
  await page.getByRole('button', { name: '1597.5', exact: true }).click();
  response = fixture(NOW + 30_000, 300);
  await page.clock.fastForward(30_000);
  await expect(page.getByText('정규 옵션 · 근월물 202612', { exact: true })).toBeVisible();
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuetext', '1,300');
  expect(calls()).toBe(2);
  await page.clock.fastForward(13 * 60_000);
  await expect(page.locator('.sentiment-context')).toContainText('전수 18분 전 · 지연');
  await expect(page.locator('.sentiment-context')).toContainText('ATM 13분 전 · 지연');
  await expect(page.locator('.sentiment-strike-values')).toContainText('1,030');
});

for (const [state, text] of [
  ['warming', '체인을 수집하는 중입니다'],
  ['credentials_missing', 'KIS 자격증명이 설정되지 않았습니다'],
  ['collector_failed', '수집이 중단됐습니다'],
  ['option_master_unavailable', '옵션 종목 마스터를 받지 못했습니다'],
] as const) {
  test(`keeps the ${state} state distinct from metric values`, async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 900 });
    await setup(page, () => ({ ...fixture(), unavailable: state }));
    await expect(page.getByRole('main').getByRole('status')).toContainText(text);
    await expect(page.getByRole('heading', { name: '행사가 구조', exact: true })).toHaveCount(0);
    if (state === 'warming') await expect(page.getByText(/근월물 682종목/)).toBeVisible();
  });
}
