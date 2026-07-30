import { test, expect, request } from '@playwright/test';
import { selectSymbol, tradingDates } from './helpers/calendar';
import { resetQueue } from './helpers/queue';

// **알려진 공백 — 픽스처가 완결성 게이트를 못 넘는다.**
// 배선·날짜·큐 오염은 전부 해소돼 큐에 정확히 3행이 들어가고 캡처도 실제로 돈다. 그런데
// `FakeHogaplayClient` 는 5페이지만 내주므로 행이 `failed 5 100 17%`(커버리지 17%)로
// 끝나 "3 of 3 done" 에 도달할 수 없다. 통과시키려면 완결로 판정될 만큼 큰 페이크
// 픽스처가 필요하다(ADR-0115 per-source 완결성 게이트). 단언만 느슨하게 바꾸면 "캡처가
// 끝까지 간다" 는 이 스펙의 요지가 사라지므로 그렇게 하지 않았다.
test.fixme(true, '페이크 픽스처 커버리지 17% — 완결성 게이트를 못 넘어 done 에 도달 불가');

test('range-capture: search → pick 3 trading days → Start → queue progresses to done × 3', async ({ page }) => {
  // 날짜는 런타임에 고른다 — 이전 판의 20260518/20 은 작성 시점(2026-05)에만 존재했다.
  // 근거와 오프셋 배분은 helpers/calendar.ts.
  // 실패 주입은 **프로세스 전역**이다. cookie-pause 가 중간에 죽으면 index 를 -1 로
  // 되돌리지 못한 채 끝나고, 그 뒤 모든 캡처가 CookieExpiredError 로 실패한다(실측:
  // 이 스펙의 3행이 전부 failed). 시작할 때 확실히 끈다.
  const api = await request.newContext();
  await api.post('http://127.0.0.1:8765/api/test/cookie_expire_at', { data: { index: -1 } });

  await selectSymbol(page);
  // 큐는 전역이라 앞선 스펙의 행이 남아 있다 — 개수를 세기 전에 비운다.
  await resetQueue(page);
  const days = await tradingDates(page, 3, 5);

  // 2. 연속 거래일 3일 = 양 끝 클릭.
  await page.getByTestId(`calendar-cell-${days[0]}`).click();
  await page.getByTestId(`calendar-cell-${days[2]}`).click();

  // 3. Start.
  await page.getByRole('button', { name: /Start/i }).click();

  // 4. capture_queued WebSocket event (ch:'event'): 3 rows appear.
  // **행만** 센다 — `/^queue-row-/` 는 행 내부의 `queue-row-full-capture-count`·
  // `queue-row-throttled` 같은 배지까지 잡아 3행이 6으로 세어졌다.
  const rows = page.getByRole('button', { name: /^Capture row / });
  await expect(rows).toHaveCount(3, { timeout: 5_000 });

  // 5. Phase transitions visible — wait for header summary to read "3 of 3 done".
  //    업스트림 없이도 도달한다 — HOGA_ENABLE_TEST_ENDPOINTS=1 이면 FakeHogaplayClient 가
  //    결정론적 페이지를 내준다(날짜 무관).
  await expect(page.locator('text=/3 of 3 done/')).toBeVisible({ timeout: 15_000 });

  // 6. Append a second symbol's range — multi-symbol queue test.
  await page.getByPlaceholder(/종목/).fill('SK');
  await page.getByText(/SK하이닉스/, { exact: false }).first().click();
  // 종목을 바꾸면 달력이 이번 달로 돌아오므로 다시 전월로 넘어가 같은 날짜를 고른다.
  const days2 = await tradingDates(page, 3, 5);
  await page.getByTestId(`calendar-cell-${days2[0]}`).click();
  await page.getByTestId(`calendar-cell-${days2[2]}`).click();
  await page.getByRole('button', { name: /Start/i }).click();
  await expect(page.locator('text=/6 of 6 done/')).toBeVisible({ timeout: 15_000 });

  // 7. Cancel All — drains any leftover queued; verify it does not crash.
  await page.getByRole('button', { name: /Cancel All/i }).click();
  // Second click confirms (two-step destructive guard).
  await page.getByRole('button', { name: /Click again to confirm/i }).click();

  // 8. Dismiss Done — table empties.
  await page.getByRole('button', { name: /Dismiss Done/i }).click();
  await expect(rows).toHaveCount(0, { timeout: 5_000 });
});
