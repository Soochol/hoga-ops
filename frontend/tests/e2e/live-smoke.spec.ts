import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

// Run against the system-installed Chrome rather than Playwright's bundled
// Chromium. This worktree's OS (ubuntu 26.04) is outside Playwright's current
// browser-support matrix, so `npx playwright install chromium` refuses.
// `/opt/google/chrome` is present and works for these smoke tests; switching
// channels is scoped to this file so other specs are unaffected.
test.use({ channel: 'chrome' });

/**
 * /live page e2e smoke. Backend-independent — every endpoint LivePage
 * touches is mocked via `installLiveMocks`. See
 * `tests/e2e/helpers/liveMocks.ts` for the contract.
 *
 * Coverage:
 *   - S1: empty state → symbol select → header + chart root mount
 *   - S2: defect-banner regression for f63ed15 (excluded_dates → alert,
 *         data_warnings → status). The banner copy is the user-facing
 *         signal that the invariant-outcomes path is wired end-to-end.
 */
test.describe('/live smoke', () => {
  test('S1: empty state → select symbol → chart root mounts with kis_live header', async ({
    page,
  }) => {
    await installLiveMocks(page);
    await page.goto('/live');

    // **빈 상태 문구가 바뀌었다.** /live 는 워크스페이스(창) 모델이라 "관심종목을
    // 선택해주세요" 라는 전면 안내가 없고, 창마다 "종목 없음 · <그룹>" 을 보여준다.
    await expect(page.getByText(/종목 없음/).first()).toBeVisible();

    // Open the watchlist panel and pick the only symbol.
    // **행은 코드가 아니라 이름(고영)을 보여준다** — 코드 텍스트로는 못 찾는다.
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    await page.getByTestId('watchlist-row-098460').click();

    // Header surfaces the selected code (창 제목이 "고영(098460)").
    await expect(page.getByText('098460').first()).toBeVisible();
    // **소스 배지 단언을 걷어냈다.** 배지를 얹던 상태바가 #865
    // ("종목 식별 라벨을 상태바→차트 창 헤더로 이관, 상태바 폐지")에서 없어졌다.
    // 남아 있던 `SourceChip`(사용처 0, 자기 테스트만 참조)은 2026-07-31 에 삭제했다.

    // Chart root mounts (containerRef parent — present whenever the LivePage
    // selected-symbol branch renders).
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();
  });

  // S2 (excluded_dates + data_warnings 결함 배너) 는 **삭제했다.** 그 배너는
  // `d5c2adc1 chore(live): remove excluded-dates banner from /live` 에서 의도적으로
  // 제거됐다 — 문구(`데이터 결함으로 제외된 날짜` · `신뢰도 낮은 날짜`)가 소스에 한 곳도
  // 없다. 제거된 기능을 지키는 테스트는 fixme 로 남겨도 소음이라 지운다(#968 이
  // `/replay` 박제 스펙 8개를 같은 이유로 삭제한 선례).

  test('S3: timeframe D unmounts hoga panes without console errors (ADR-0041)', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await installLiveMocks(page);
    await page.goto('/live');

    // Select the only watchlist symbol.
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    await page.getByTestId('watchlist-row-098460').click();
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();

    // Toggle to D and re-assert chart root mounts. No assertion on pane DOM
    // (lightweight-charts canvases don't carry stable selectors); the
    // chart-root presence + clean console is the regression guard for
    // RangeSeriesPane's dynamic unmount cleanup.
    // **버튼 라벨이 'D' → '일' 이다** (`TimeframeControl.CALENDAR_LABELS`:
    // D:'일' · W:'주' · M:'월'). 창이 여럿이라 첫 번째 차트 창의 것을 집는다.
    await page.getByRole('button', { name: '일', exact: true }).first().click();
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();

    // Round-trip back to 1m to exercise the dynamic *remount* path of the
    // hoga panes (RangeSeriesPane mount-after-unmount) — that's the actual
    // regression class for ADR-0041's pane-set switching, and the riskier
    // branch the unmount-only case doesn't cover.
    // 분봉 버튼의 접근성 이름은 상태에 따라 달라진다
    // (`TimeframeControl`: 현재가 분봉이면 "분봉 선택 열기: 1분", 아니면 "분봉으로 전환: 1분").
    // 지금은 일봉이므로 후자다 — 라벨 문구에 결합하지 않도록 정규식으로 받는다.
    await page.getByRole('button', { name: /분봉으로 전환/ }).first().click();
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();

    // No "data must be asc ordered by time" and no React boundary catch —
    // the upstream noise we'd see if the pane mount race went wrong.
    // (RangeSeriesPane's removeSeries is wrapped in try/catch and never
    // reaches console, so we don't filter for that string.)
    expect(
      consoleErrors.filter(
        (e) =>
          e.includes('asc ordered by time') ||
          e.includes('The above error occurred'),
      ),
    ).toEqual([]);
  });
});
