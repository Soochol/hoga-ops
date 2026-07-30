import { test, expect, request } from '@playwright/test';
import { selectSymbol, tradingDates } from './helpers/calendar';
import { resetQueue } from './helpers/queue';

// 여기의 호스트는 모킹이 아니라 **실제 e2e 백엔드**다(테스트 엔드포인트 직접 호출).
const API = 'http://127.0.0.1:8765';

// FakeHogaplayClient 의 실패 주입 카운터는 **프로세스 전역**이다. 다른 스펙이 동시에
// 캡처를 돌리면 그쪽 요청이 카운터를 소모해 "3번째" 가 엉뚱한 곳에서 터진다.
// 이 파일 안에서는 직렬로 두고, 파일 간 간섭은 날짜 오프셋으로 겹치지 않게 한다.
test.describe.configure({ mode: 'serial' });

// **알려진 공백 — range-capture 와 같은 원인.** 일시정지 배너까지는 실제로 도달하지만
// (그 부분 단언은 이제 실재하는 문구·버튼을 본다), 마지막 "5 of 5 done" 은 페이크
// 픽스처가 완결성 게이트를 못 넘어 도달할 수 없다.
test.fixme(true, '페이크 픽스처 커버리지 부족 — 재개 후 done 도달 불가');

test('cookie-pause: 3rd request → pause banner → Resume → completes', async ({ page }) => {
  // Configure the fake to raise on the 3rd capture request.
  const api = await request.newContext();
  await api.post(`${API}/api/test/cookie_expire_at`, { data: { index: 3 } });

  await selectSymbol(page);
  await resetQueue(page);
  // 5거래일 연속 — 날짜는 런타임에(근거는 helpers/calendar.ts).
  const days = await tradingDates(page, 5, 8);
  await page.getByTestId(`calendar-cell-${days[0]}`).click();
  await page.getByTestId(`calendar-cell-${days[4]}`).click();
  await page.getByRole('button', { name: /Start/i }).click();

  // After ~2 captures land, the 3rd triggers pause.
  // 배너 문구는 `CaptureQueue.tsx` 의 `queue.paused` 분기 그대로다. 이전 판은
  // `text=/PAUSED/` 를 봤는데 그런 문구는 앱에 없다 — 배너와 함께 뜨는 **재개 버튼**이
  // 일시정지 상태의 실제 표식이다.
  await expect(page.locator('text=/Cookie expired/i')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Refresh & Resume/i })).toBeVisible();

  // Disable the failure-injection and click Resume.
  await api.post(`${API}/api/test/cookie_expire_at`, { data: { index: -1 } });
  await page.getByRole('button', { name: /Refresh & Resume/i }).click();

  // Queue resumes; eventually all 5 done.
  await expect(page.locator('text=/5 of 5 done/')).toBeVisible({ timeout: 20_000 });
});
