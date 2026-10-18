import { test, expect, type Page } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

const symbols = [
  { code: '005930', name: '삼성전자', market: 'KOSPI' },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI' },
];

async function choose(page: Page, name: string) {
  await page.getByRole('button', { name: '종목 검색 열기' }).click();
  const dialog = page.getByRole('dialog', { name: '종목 검색' });
  await dialog.getByRole('combobox', { name: '종목 검색' }).fill(name);
  await dialog.getByRole('option').first().click();
  await expect(dialog).toHaveCount(0);
}

test('독립 뉴스 창의 새 기사·날짜 조회·종목 고정과 그룹 변경', async ({ page }, testInfo) => {
  await installLiveMocks(page);
  await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, (route) => route.fulfill({
    json: { symbols, status: 'fresh', fetched_at_ms: Date.now(), reason: null },
  }));
  let version = 0;
  await page.route(/^https?:\/\/[^/]+\/api\/news\/stock\?/, (route) => {
    const params = new URL(route.request().url()).searchParams;
    const code = params.get('code');
    const name = symbols.find((symbol) => symbol.code === code)?.name ?? '고영';
    const items = [
      { id: 'base', title: `${name} 테스트 기사`, source: '테스트신문', published_at_ms: 1791464402000, related_codes: [code] },
      { id: 'other', title: '다른 종목 테스트 기사', source: '테스트신문', published_at_ms: null, related_codes: ['000810'] },
    ];
    if (version > 0) items.unshift({ ...items[0], id: 'new', title: `${name} 새 기사` });
    return route.fulfill({ json: {
      code, date: params.get('date'), status: 'ok', items: params.has('date') ? [] : items,
      fetched_at_ms: Date.now(), limit: 40,
    } });
  });
  await page.goto('/live');
  await choose(page, '삼성전자');
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-news').click();
  const news = page.getByTestId('stock-news-window');
  const frame = page.locator('[data-win]').filter({ has: news });
  await expect(news.getByText('삼성전자 테스트 기사')).toBeVisible();
  await expect(news.getByText('조회 결과', { exact: true })).toBeVisible();
  await expect(news.getByRole('link')).toHaveCount(0);
  version = 1;
  const settings = news.getByRole('button', { name: '뉴스 설정', exact: true });
  const controls = page.getByRole('dialog', { name: '뉴스 설정', exact: true });
  await settings.click();
  await controls.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(news.getByRole('button', { name: /새 뉴스 1건/ })).toBeVisible();
  await expect(news.getByText('삼성전자 새 기사')).toHaveCount(0);
  await news.getByRole('button', { name: /새 뉴스 1건/ }).click();
  await expect(news.getByText('삼성전자 새 기사')).toBeVisible();
  await settings.click();
  await controls.getByRole('checkbox', { name: /종목 연결만/ }).check();
  await page.keyboard.press('Escape');
  await expect(news.getByText('다른 종목 테스트 기사')).toHaveCount(0);
  await news.getByLabel('뉴스 날짜').fill('2026-10-07');
  await expect(news.getByText(/선택일 기사 없음/)).toBeVisible();
  await news.getByRole('button', { name: '최신', exact: true }).click();
  await expect(news.getByText('삼성전자 새 기사')).toBeVisible();
  await frame.getByRole('button', { name: '종목 고정', exact: true }).click();
  await expect(frame.getByRole('button', { name: '종목 고정', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await choose(page, 'SK하이닉스');
  await expect(news.getByText('삼성전자 새 기사')).toBeVisible();
  await frame.getByRole('button', { name: '종목 고정', exact: true }).click();
  await expect(news.getByText('SK하이닉스 새 기사')).toBeVisible();
  await expect(news.getByText('삼성전자 새 기사')).toHaveCount(0);
  await frame.screenshot({ path: testInfo.outputPath('news-window.png') });
});

for (const theme of ['toss-light', 'toss-dark', 'obsidian-pro', 'ledger-studio']) {
  test(`${theme}: 좁은 뉴스 창에서도 제목과 조회 제어가 잘리지 않는다`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 480, height: 720 });
    await page.addInitScript((theme) => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: theme })), theme);
    await installLiveMocks(page);
    await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, (route) => route.fulfill({
      json: { symbols, status: 'fresh', fetched_at_ms: Date.now(), reason: null },
    }));
    await page.route(/^https?:\/\/[^/]+\/api\/news\/stock\?/, (route) => route.fulfill({ json: {
      code: '005930', date: null, status: 'ok', fetched_at_ms: Date.now(), limit: 40,
      items: [{ id: 'long', title: '삼성전자 테스트 기사: 긴 제목과 여러 종목의 소식을 창의 너비에 맞춰 읽을 수 있습니다.',
        source: '테스트신문', published_at_ms: 1791464402000, related_codes: ['005930'] }],
    } }));
    await page.goto('/live');
    await choose(page, '삼성전자');
    await page.getByTestId('workspace-add-menu-button').click();
    await page.getByTestId('workspace-add-news').click();
    const news = page.getByTestId('stock-news-window');
    await expect(news).toHaveCSS('color-scheme', ['toss-dark', 'obsidian-pro'].includes(theme) ? 'dark' : 'light');
    await expect(news.getByText(/삼성전자 테스트 기사:/)).toBeVisible();
    await expect(news.getByLabel('뉴스 날짜')).toBeVisible();
    const settings = news.getByRole('button', { name: '뉴스 설정', exact: true });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: '뉴스 설정', exact: true });
    await expect(dialog.getByRole('button', { name: '새로고침', exact: true })).toBeVisible();
    await dialog.getByRole('checkbox', { name: /종목 연결만/ }).check();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    await news.getByRole('button', { name: '뉴스 제공 안내', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '뉴스 제공 안내', exact: true })).toContainText('전체 기사 아님 · 원문 링크 미제공');
    await page.keyboard.press('Escape');
    expect(await news.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await news.screenshot({ path: testInfo.outputPath(`news-${theme}.png`) });
  });
}
