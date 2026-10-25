import { expect, test } from '@playwright/test';
import { setup, hoverCandle, DATE } from './helpers/tradeCursorMocks';

for (const timeframe of ['1m', '5m', '1s', '5s', '10s', '30s'] as const) {
  test(`${timeframe}: 실제 봉 커서가 같은 그룹 체결창에 날짜·봉 구간·hogaplay 설정을 전달한다`, async ({ page }) => {
    const { requests, errors } = await setup(page, timeframe);
    await hoverCandle(page, timeframe.endsWith('s'));
    const tape = page.locator('[data-win="cursor-trade"] [data-testid="trade-window"]');
    await expect(tape).toHaveAttribute('data-mode', 'spot');
    await expect(tape).toContainText('hogaplay · 원본 체결');
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    const p = requests.at(-1)!.searchParams;
    expect(p.get('date')).toBe(DATE);
    expect(p.get('venue')).toBe('KRX');
    expect(p.get('source_pref')).toBe('hogaplay');
    expect(Number(p.get('to_ms')) - Number(p.get('from_ms'))).toBe(Number(timeframe.slice(0, -1)) * (timeframe.endsWith('s') ? 1000 : 60000));
    await expect(page.locator('[data-win="other-trade"] [data-testid="trade-window"]')).toHaveAttribute('data-mode', 'latest');
    await page.mouse.move(0, 0);
    await expect(tape).toHaveAttribute('data-mode', 'latest');
    const link = page.locator('[data-win="cursor-chart"]').getByRole('button', { name: '호버 연동', exact: true });
    await link.click();
    await expect(link).toHaveAttribute('aria-pressed', 'false');
    await hoverCandle(page, timeframe.endsWith('s'));
    await expect(tape).toHaveAttribute('data-mode', 'latest');
    await link.click();
    await hoverCandle(page, timeframe.endsWith('s'));
    await expect(tape).toHaveAttribute('data-mode', 'spot');
    expect(errors).toEqual([]);
  });
}

test('상단 설정의 hogaplay 우선을 끄면 WS 1초 집계로 바뀌고 커서 연동 OFF는 최신으로 돌아간다', async ({ page }, testInfo) => {
  const { requests, errors } = await setup(page, '1m');
  await hoverCandle(page, false);
  const tape = page.locator('[data-win="cursor-trade"] [data-testid="trade-window"]');
  await expect(tape).toContainText('hogaplay · 원본 체결');
  await page.getByRole('button', { name: '설정', exact: true }).first().click();
  const editor = page.getByTestId('settings-shell');
  await editor.getByTestId('settings-nav-data-source').click();
  const toggle = editor.getByRole('switch', { name: 'KRX에서 hogaplay 우선', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await hoverCandle(page, false);
  await expect(tape).toContainText('WS · 1초 집계');
  await expect(tape.getByRole('columnheader', { name: '합산량(주)' })).toBeVisible();
  await expect(tape.getByText('3건')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('trade-spot-ws.png') });
  expect(requests.at(-1)!.searchParams.get('source_pref')).toBe('kiwoom_live');
  await page.locator('[data-win="cursor-chart"]').getByRole('button', { name: '호버 연동', exact: true }).click();
  await expect(tape).toHaveAttribute('data-mode', 'latest');
  await hoverCandle(page, false);
  await expect(tape).toHaveAttribute('data-mode', 'latest');
  expect(errors).toEqual([]);
});
