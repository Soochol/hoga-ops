import { test, expect, request } from '@playwright/test';
import { selectSymbol, tradingDates } from './helpers/calendar';
import { resetQueue } from './helpers/queue';

// 여기의 호스트는 모킹이 아니라 **실제 e2e 백엔드**다(테스트 엔드포인트 직접 호출).
const API = 'http://127.0.0.1:8765';

// FakeHogaplayClient 의 실패 주입 카운터는 **프로세스 전역**이다. 다른 스펙이 동시에
// 캡처를 돌리면 그쪽 요청이 카운터를 소모해 "3번째" 가 엉뚱한 곳에서 터진다.
// 이 파일 안에서는 직렬로 두고, 파일 간 간섭은 날짜 오프셋으로 겹치지 않게 한다.
test.describe.configure({ mode: 'serial' });

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

  // **일시정지가 정착할 때까지 기다린 뒤 재개한다.** `resume_queue` 는 `_done` 에 있는
  // `pause_origin` 취소 항목만 되살리는데, 취소가 확정되기 전에 누르면 되살릴 대상이
  // 0건이라 아무 일도 안 일어난다(실측: resume 200 인데 4건이 cancelled 로 남았다).
  // 사람은 배너를 보고 누르므로 자연히 피해 가는 창이다 — 테스트도 같은 순서를 지킨다.
  await expect(page.getByRole('button', { name: /^Capture row .* cancelled/ }))
    .toHaveCount(4, { timeout: 15_000 });

  // Disable the failure-injection and click Resume.
  await api.post(`${API}/api/test/cookie_expire_at`, { data: { index: -1 } });
  await page.getByRole('button', { name: /Refresh & Resume/i }).click();

  // **"5 of 5 done" 은 설계상 도달 불가다.** 쿠키 오류를 맞은 항목은 terminal 이다
  // (`captures.py`: "the failing item is terminal and never sleeps awaiting a resume").
  // 재개가 되살리는 건 그 때문에 **취소된 나머지**(`pause_origin`)뿐이라 최대 4건이다.
  // 그래서 "재개 후 큐가 빠져나가고 실패는 1건뿐" 을 주장한다.
  await expect(page.locator('text=/4 of 5 done/')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('text=/1 failed/')).toBeVisible();
});
