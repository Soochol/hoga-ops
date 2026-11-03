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
  await expect(news.getByRole('button', { name: /삼성전자 테스트 기사/ })).toHaveCount(0);
  const title = news.getByText('삼성전자 테스트 기사', { exact: true });
  const titleBox = (await title.boundingBox())!;
  await page.mouse.move(titleBox.x + 1, titleBox.y + titleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBox.x + titleBox.width - 1, titleBox.y + titleBox.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('테스트 기사');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(news.getByText('조회 결과', { exact: true })).toHaveCount(0);
  await expect(news.getByText('다른 종목 테스트 기사')).toHaveCount(0);
  await expect(news.getByRole('link')).toHaveCount(0);
  version = 1;
  const settings = news.getByRole('button', { name: '뉴스 설정', exact: true });
  const controls = page.getByRole('dialog', { name: '뉴스 설정', exact: true });
  await settings.click();
  await expect(controls.getByRole('checkbox', { name: /종목 연결만/ })).toBeChecked();
  await controls.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(news.getByRole('button', { name: /새 뉴스 1건/ })).toBeVisible();
  await expect(news.getByText('삼성전자 새 기사')).toHaveCount(0);
  await news.getByRole('button', { name: /새 뉴스 1건/ }).click();
  await expect(news.getByText('삼성전자 새 기사')).toBeVisible();
  await settings.click();
  await controls.getByRole('checkbox', { name: /종목 연결만/ }).uncheck();
  await page.keyboard.press('Escape');
  await expect(news.getByText('다른 종목 테스트 기사')).toBeVisible();
  for (const label of ['종목코드 연결', '제목에 종목명', '조회 결과']) {
    await expect(news.getByText(label, { exact: true })).toHaveCount(0);
  }
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
  await settings.click();
  await controls.getByRole('checkbox', { name: /종목 연결만/ }).uncheck();
  await page.keyboard.press('Escape');
  await news.getByLabel('뉴스 날짜').fill('2026-10-07');
  await settings.click();
  await expect(controls.getByRole('checkbox', { name: /종목 연결만/ })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await choose(page, '삼성전자');
  await expect(news.getByText('다른 종목 테스트 기사')).toBeVisible();
  await frame.getByRole('button', { name: /창 닫기$/ }).click();
  await page.reload();
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-news').click();
  await expect(news.getByRole('button', { name: '최신', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()));
  await expect(news.getByLabel('뉴스 날짜')).toHaveValue(today);
  await expect(news.getByText('다른 종목 테스트 기사')).toBeVisible();
});

test('제목 검색은 종목 필터와 결합하고 새 뉴스 수용에도 검색어를 유지한다', async ({ page }) => {
  await installLiveMocks(page);
  await page.route(/^https?:\/\/[^/]+\/api\/symbols\/all$/, (route) => route.fulfill({ json: {
    symbols, status: 'fresh', fetched_at_ms: Date.now(), reason: null,
  } }));
  let fresh = false;
  await page.route(/^https?:\/\/[^/]+\/api\/news\/stock\?/, (route) => route.fulfill({ json: {
    code: '005930', date: null, status: 'ok', fetched_at_ms: Date.now(), limit: 40,
    items: [
      ...(fresh ? [{ id: 'new', title: '삼성전자 새 AI 기사', source: '테스트신문', published_at_ms: null, related_codes: ['005930'] }] : []),
      { id: 'linked', title: '삼성전자 AI 투자', source: '테스트신문', published_at_ms: null, related_codes: ['005930'] },
      { id: 'title', title: '삼성전자 실적 전망', source: '테스트신문', published_at_ms: null, related_codes: [] },
      { id: 'other', title: '다른 회사 ai 투자', source: '테스트신문', published_at_ms: null, related_codes: ['000810'] },
    ],
  } }));
  await page.goto('/live');
  await choose(page, '삼성전자');
  await page.getByTestId('workspace-add-menu-button').click();
  await page.getByTestId('workspace-add-news').click();
  const news = page.getByTestId('stock-news-window');
  const search = news.getByRole('searchbox', { name: '뉴스 제목 검색' });
  await search.fill(' aI ');
  await expect(news.getByText('삼성전자 AI 투자', { exact: true })).toBeVisible();
  await expect(news.getByText('삼성전자 실적 전망', { exact: true })).toHaveCount(0);
  await expect(news.getByText('다른 회사 ai 투자', { exact: true })).toHaveCount(0);
  await news.getByRole('button', { name: '뉴스 설정', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '뉴스 설정', exact: true });
  await expect(settings.getByRole('checkbox', { name: /종목 연결만\s*1건/ })).toBeChecked();
  await settings.getByRole('checkbox', { name: /종목 연결만/ }).uncheck();
  await page.keyboard.press('Escape');
  await expect(news.getByText('다른 회사 ai 투자', { exact: true })).toBeVisible();
  fresh = true;
  await news.getByRole('button', { name: '뉴스 설정', exact: true }).click();
  await settings.getByRole('button', { name: '새로고침', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(news.getByText('삼성전자 새 AI 기사', { exact: true })).toHaveCount(0);
  await news.getByRole('button', { name: /새 뉴스 1건/ }).click();
  await expect(search).toHaveValue(' aI ');
  await expect(news.getByText('삼성전자 새 AI 기사', { exact: true })).toBeVisible();
  await search.fill('없는 제목');
  await expect(news.getByText('검색어와 일치하는 제목이 없습니다.')).toBeVisible();
  await news.getByRole('button', { name: '뉴스 제목 검색 지우기' }).click();
  await expect(search).toHaveValue('');
  await expect(news.getByRole('article')).toHaveCount(4);
  await search.fill('   ');
  await expect(news.getByRole('article')).toHaveCount(4);
});

for (const theme of ['trading-desk', 'obsidian', 'toss-light', 'toss-dark', 'obsidian-pro', 'ledger-studio']) {
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
    await expect(news).toHaveCSS('color-scheme', ['trading-desk', 'obsidian', 'toss-dark', 'obsidian-pro'].includes(theme) ? 'dark' : 'light');
    await expect(news.getByText(/삼성전자 테스트 기사:/)).toBeVisible();
    await expect(news.getByLabel('뉴스 날짜')).toBeVisible();
    const search = news.getByRole('searchbox', { name: '뉴스 제목 검색' });
    await expect(search).toBeVisible();
    await expect(search).toHaveCSS('font-size', '13px');
    await expect(news.getByLabel('뉴스 날짜')).toHaveCSS('font-size', '13px');
    const headline = news.locator('article > p').first();
    await expect(headline).toHaveCSS('font-size', '14px');
    await expect(headline).toHaveCSS('line-height', '21px');
    await expect(headline).toHaveCSS('font-weight', '500');
    const metadata = news.locator('article > div').first();
    await expect(metadata).toHaveCSS('font-size', '13px');
    await expect(metadata).toHaveCSS('line-height', '18.85px');
    await expect(metadata).toHaveCSS('font-weight', '400');
    await expect(news.locator('div.border-t > span')).toHaveCSS('font-size', '11.5px');
    await expect(news.getByRole('button', { name: '뉴스 제공 안내', exact: true })).toHaveCSS('font-size', '13px');
    const frame = page.locator('[data-win]').filter({ has: news });
    await expect(frame.locator('.live-data-title-kind')).toHaveCSS('font-size', '13px');
    await expect(frame.locator('.live-symbol-name')).toHaveCSS('font-size', '13px');
    await expect(frame.locator('.live-symbol-name')).toHaveCSS('font-weight', theme === 'trading-desk' ? '400' : '600');
    await search.fill('없는 제목');
    await expect(news.getByText('검색어와 일치하는 제목이 없습니다.')).toBeVisible();
    await expect(news.getByText('검색어와 일치하는 제목이 없습니다.')).toHaveCSS('font-size', '13px');
    await news.getByRole('button', { name: '뉴스 제목 검색 지우기' }).click();
    await expect(news.getByText(/삼성전자 테스트 기사:/)).toBeVisible();
    const settings = news.getByRole('button', { name: '뉴스 설정', exact: true });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: '뉴스 설정', exact: true });
    await expect(dialog).toHaveCSS('font-size', '13px');
    await expect(dialog.getByRole('button', { name: '새로고침', exact: true })).toBeVisible();
    await dialog.getByRole('checkbox', { name: /종목 연결만/ }).check();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    await news.getByRole('button', { name: '뉴스 제공 안내', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '뉴스 제공 안내', exact: true })).toContainText('전체 기사 아님 · 원문 링크 미제공');
    await expect(page.getByRole('dialog', { name: '뉴스 제공 안내', exact: true })).toHaveCSS('font-size', '13px');
    await expect(page.getByRole('dialog', { name: '뉴스 제공 안내', exact: true }).locator('p').first()).toHaveCSS('font-size', '11.5px');
    await page.keyboard.press('Escape');
    expect(await news.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await news.screenshot({ path: testInfo.outputPath(`news-${theme}.png`) });
    for (const width of [280, 180]) {
      const box = (await frame.boundingBox())!;
      const handle = (await frame.locator('[data-handle="e"]').boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + width - box.width, handle.y + handle.height / 2, { steps: 5 });
      await page.mouse.up();
      await search.fill('삼성전자');
      await expect(search).toBeVisible();
      await expect(news.getByRole('button', { name: '뉴스 제목 검색 지우기' })).toBeVisible();
      expect((await search.boundingBox())!.width).toBeGreaterThanOrEqual(48);
      expect(await news.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(headline).toHaveCSS('font-size', '14px');
      await expect(metadata).toHaveCSS('font-size', '13px');
      await news.screenshot({ path: testInfo.outputPath(`news-${theme}-${width}.png`) });
      await news.getByRole('button', { name: '뉴스 제목 검색 지우기' }).click();
    }
  });
}
