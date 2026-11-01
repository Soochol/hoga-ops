import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.beforeEach(async ({ page }) => {
  await installLiveMocks(page);
  await page.goto('/etfs');
  await expect(page.getByRole('heading', { name: 'ETF 탐색', exact: true })).toBeVisible();
});

test('native route searches active funds and constituents without hiding unavailable scores', async ({ page }) => {
  await expect(page.getByRole('link', { name: 'ETF 탐색', exact: true })).toHaveAttribute('href', '/etfs');
  await page.getByRole('button', { name: '액티브 81', exact: true }).click();
  const library = page.getByRole('region', { name: 'ETF 목록' });
  await expect(library.getByText('81개 ETF', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'KODEX 로봇액티브 선택', exact: true }).click();
  const summary = page.getByRole('region', { name: 'ETF 요약' });
  await expect(summary).toContainText('확정 입력 검증 대기');
  await expect(page.getByRole('heading', { name: '구성종목 32개' })).toBeVisible();
  await page.getByRole('button', { name: '전체 119', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'ETF 또는 구성종목 검색' });
  await search.fill('삼성전자');
  await expect(library.getByText('46개 ETF', { exact: true })).toBeVisible();
  await search.fill('0221z0');
  await page.getByRole('button', { name: 'ACE K바이오코스닥액티브 선택', exact: true }).click();
  await expect(summary).toContainText('18.52 / 100');
  await search.fill('없는ETF이름');
  await expect(library.getByText('검색 결과가 없습니다.')).toBeVisible();
});

test('stock reverse lookup follows the selected fund and lists original constituent weights', async ({ page }) => {
  await page.getByRole('button', { name: '삼성전자 포함 ETF 조회', exact: true }).click();
  await expect(page.getByRole('heading', { name: '삼성전자를 담은 ETF' })).toBeVisible();
  await expect(page.getByText('005930 · 조사한 119개 중 46개 · 액티브 43개', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '포함 ETF 더 보기 (6 / 46)', exact: true }).click();
  await page.getByRole('button', { name: 'KODEX 200액티브 구성 보기', exact: true }).click();
  await expect(page.getByRole('region', { name: 'ETF 요약' })).toContainText('KODEX 200액티브');
  await expect(page.getByRole('region', { name: 'ETF 요약' })).toContainText('상장 이력 부족');
  await expect(page.getByRole('heading', { name: '구성종목 190개' })).toBeVisible();
  const stocks = page.getByRole('region', { name: '구성종목 탐색' });
  await stocks.getByRole('searchbox', { name: '구성종목 검색' }).fill('005930');
  await expect(stocks.getByRole('row', { name: /삼성전자/ })).toContainText('34.54%');
});

test('exact ETF searches open details immediately while stock searches retain the inclusion list', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'ETF 또는 구성종목 검색' });
  const library = page.getByRole('region', { name: 'ETF 목록' });
  const summary = page.getByRole('region', { name: 'ETF 요약' });
  await search.fill('ace k바이오코스닥액티브');
  await expect(library.getByText('1개 ETF', { exact: true })).toBeVisible();
  await expect(summary.getByRole('heading', { name: 'ACE K바이오코스닥액티브', exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  await expect(page.getByRole('heading', { name: '구성종목 18개' })).toBeVisible();
  await search.fill('091160');
  await expect(summary.getByRole('heading', { name: 'KODEX 반도체', exact: true })).toBeVisible();
  // IME composition must not select a result or consume the Enter used to commit it.
  await search.dispatchEvent('compositionstart');
  await search.fill(' ACE K 바이오 코스닥 액티브 ');
  await search.press('Enter');
  await expect(summary.getByRole('heading', { name: 'KODEX 반도체', exact: true })).toBeVisible();
  await search.dispatchEvent('compositionend');
  await expect(summary.getByRole('heading', { name: 'ACE K바이오코스닥액티브', exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  await search.fill('삼성전자');
  await expect(library.getByText('46개 ETF', { exact: true })).toBeVisible();
  await expect(summary.getByRole('heading', { name: 'ACE K바이오코스닥액티브', exact: true })).toBeVisible();
  await page.reload();
  await expect(search).toHaveValue('삼성전자');
  await expect(library.getByText('46개 ETF', { exact: true })).toBeVisible();
  await expect(summary.getByRole('heading', { name: 'ACE K바이오코스닥액티브', exact: true })).toBeVisible();
});

test('keyboard result selection crosses pagination and reveals/focuses the chosen details', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'ETF 또는 구성종목 검색' });
  const library = page.getByRole('region', { name: 'ETF 목록' });
  await search.fill('ace');
  await search.press('ArrowDown');
  await expect(library.getByRole('button', { name: 'ACE K바이오코스닥액티브 선택' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const second = library.getByRole('button', { name: 'ACE 2차전지&친환경차액티브 선택' });
  await expect(second).toBeFocused();
  await second.press('Enter');
  const heading = page.getByRole('heading', { name: 'ACE 2차전지&친환경차액티브', exact: true });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await expect(heading).toHaveClass('etf-revealed-name');
  await search.fill('');
  await search.press('ArrowDown');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  await expect(library.getByText('2 / 15', { exact: true })).toBeVisible();
  await expect(library.locator('.etf-fund').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(library.getByText('15 / 15', { exact: true })).toBeVisible();
  await expect(library.locator('.etf-fund').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(library.getByText('1 / 15', { exact: true })).toBeVisible();
  await expect(library.getByRole('button', { name: 'SOL 코리아메가테크액티브 선택' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  await search.fill('0221z0');
  await search.press('Enter');
  await expect(page.getByRole('heading', { name: 'ACE K바이오코스닥액티브', exact: true })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('etf-search-selected.png') });
});

test('no results explain filters and resetting filters preserves the query then opens the exact ETF', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'ETF 또는 구성종목 검색' });
  const library = page.getByRole('region', { name: 'ETF 목록' });
  await library.getByRole('button', { name: '패시브 38', exact: true }).click();
  await search.fill('0221z0');
  await expect(library.getByRole('status')).toContainText('패시브 · 전체 운용사');
  await expect(page.getByRole('region', { name: 'ETF 요약' })).toContainText('SOL 코리아메가테크액티브');
  await library.getByRole('button', { name: '필터 초기화', exact: true }).click();
  await expect(search).toHaveValue('0221z0');
  await expect(library.getByRole('button', { name: '전체 119' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'ETF 요약' })).toContainText('ACE K바이오코스닥액티브');
  await library.getByRole('combobox', { name: '운용사', exact: true }).selectOption('삼성자산운용');
  await expect(library.getByRole('status')).toContainText('삼성자산운용');
  await library.getByRole('button', { name: '필터 초기화' }).click();
  await expect(library.getByText('1개 ETF', { exact: true })).toBeVisible();
  await search.fill('없는ETF이름');
  await expect(library.getByRole('status')).toContainText('조사한 119개 ETF');
  await expect(library.getByRole('button', { name: '필터 초기화' })).toHaveCount(0);
});

test('pairwise overlap uses disclosed weights, supports six pairs, and preserves clear-all', async ({ page }) => {
  const comparison = page.getByRole('region', { name: 'ETF 겹침 비교' });
  const pairs = comparison.getByRole('group', { name: 'ETF 조합 선택' });
  await expect(pairs).toContainText('37.20%');
  await expect(pairs).toContainText('공통 3종목');
  await comparison.getByRole('button', { name: 'A에만 29종목', exact: true }).click();
  await expect(comparison.getByRole('row', { name: /삼성전자/ })).toHaveCount(0);
  for (const name of ['KODEX 로봇액티브', 'ACE K바이오코스닥액티브']) {
    await page.getByRole('button', { name: `${name} 선택`, exact: true }).click();
    await page.getByRole('button', { name: '비교에 추가 ＋', exact: true }).click();
  }
  await expect(pairs.getByRole('button')).toHaveCount(6);
  await page.getByRole('button', { name: 'RISE 2차전지액티브 선택', exact: true }).click();
  await page.getByRole('button', { name: '비교에 추가 ＋', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('최대 4개');
  await page.reload();
  await expect(pairs.getByRole('button')).toHaveCount(6);
  await comparison.getByRole('button', { name: '비교 비우기', exact: true }).click();
  await expect(comparison).toContainText('2개 이상 담으세요');
  await page.reload();
  await expect(comparison).toContainText('2개 이상 담으세요');
  await expect(pairs).toHaveCount(0);
});

test('failed snapshot has an explicit retry and never displays a fabricated score', async ({ page }) => {
  await page.route('**/etf-explorer/snapshot.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('ETF 구성 자료를 불러오지 못했습니다');
  await expect(page.getByRole('region', { name: 'ETF 요약' })).toHaveCount(0);
  await page.unroute('**/etf-explorer/snapshot.json');
  await page.getByRole('button', { name: '다시 불러오기' }).click();
  await expect(page.getByRole('heading', { name: 'ETF 탐색', exact: true })).toBeVisible();
});

test('dark and light themes fit the content area and keep charts and comparison accessible', async ({ page }) => {
  for (const theme of ['trading-desk', 'ledger']) {
    await page.evaluate(value => localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: value })), theme);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'ETF 탐색', exact: true })).toBeVisible();
    for (const width of [1440, 960, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      const content = page.getByTestId('etf-explorer-page');
      await expect.poll(() => content.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await expect(page.getByRole('progressbar', { name: '삼성전자 편입 비중' })).toHaveAttribute('aria-valuenow', '26.96');
      if (theme === 'trading-desk' && width === 1440) {
        await page.screenshot({ path: test.info().outputPath('etf-explorer-native.png') });
      }
    }
  }
});
