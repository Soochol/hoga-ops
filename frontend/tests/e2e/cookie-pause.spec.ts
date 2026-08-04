import { test, expect, request } from '@playwright/test';
import { selectSymbol, tradingDates } from './helpers/calendar';
import { observeCaptureQueue } from './helpers/captureEvents';
import { resetQueue } from './helpers/queue';

// 여기의 호스트는 모킹이 아니라 **실제 e2e 백엔드**다(테스트 엔드포인트 직접 호출).
const API = 'http://127.0.0.1:8765';

// **기본 30초로는 안 된다.** 재개 후 되살아난 4건이 각각 1,523 페이지를 돈다(실측 3.9초/건,
// 32코어). 2026-08-03 CI 에서 정확히 이 지점이 30초를 넘겨 죽었고, 실패 시점 DOM 은
// `1 capturing … 324/2916 27%` 였다 — 시간이 모자랐지 멈춘 게 아니다. 아래 대기는 벽시계가
// 아니라 WS 프레임으로 깨어나므로 이 값은 교착 백스톱이지 성능 예산이 아니다.
test.setTimeout(120_000);

// FakeHogaplayClient 의 실패 주입 카운터는 **프로세스 전역**이다. 다른 스펙이 동시에
// 캡처를 돌리면 그쪽 요청이 카운터를 소모해 "3번째" 가 엉뚱한 곳에서 터진다.
// 이 파일 안에서는 직렬로 두고, 파일 간 간섭은 날짜 오프셋으로 겹치지 않게 한다.
test.describe.configure({ mode: 'serial' });

test('cookie-pause: 3rd request → pause banner → Resume → completes', async ({ page }) => {
  const api = await request.newContext();
  // 네비게이션 **전에** 붙인다 — 앱이 첫 로드에서 /api/ws 를 연다.
  const queueEvents = observeCaptureQueue(page);

  await selectSymbol(page);
  await resetQueue(page);

  // **주입 설정은 큐를 비운 *뒤*에 한다.** `configure_fake_to_raise_on` 은 전역 호출
  // 카운터를 0 으로 되돌리는데(captures_fake.py), 이걸 `resetQueue` 앞에서 하면 아직
  // 살아 있는 인플라이트 캡처가 1·2·3 번째 호출을 대신 소모해 **남의 항목에서** 쿠키
  // 오류가 터진다. 그러면 이 스펙의 캡처는 끝까지 성공하고 배너는 영영 안 뜬다.
  // 2026-08-03 CI 에서 실제로 그랬다 — 1차가 시간 초과로 캡처를 남긴 채 죽자
  // retry1·retry2 가 **이 줄** 때문에 배너를 못 보고 연달아 죽었다(잡당 백엔드는 하나다).
  await api.post(`${API}/api/test/cookie_expire_at`, { data: { index: 3 } });

  // 5거래일 연속 — 날짜는 런타임에(근거는 helpers/calendar.ts).
  const days = await tradingDates(page, 5, 8);
  await page.getByTestId(`calendar-cell-${days[0]}`).click();
  await page.getByTestId(`calendar-cell-${days[4]}`).click();
  // 일시정지 프레임은 **클릭 전에** 예약한다.
  const paused = queueEvents.nextPaused();
  await page.getByRole('button', { name: /캡처 시작/ }).click();

  // After ~2 captures land, the 3rd triggers pause.
  // 배너 문구는 `CaptureQueue.tsx` 의 `queue.paused` 분기 그대로다. 이전 판은
  // `text=/PAUSED/` 를 봤는데 그런 문구는 앱에 없다 — 배너와 함께 뜨는 **재개 버튼**이
  // 일시정지 상태의 실제 표식이다.
  //
  // 백엔드가 멈췄다는 사실은 `capture_queue_paused` 프레임으로 받고(벽시계 아님),
  // 그 다음 배너 렌더만 짧게 단언한다.
  await paused;
  await expect(page.locator('text=/쿠키 만료/')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: /새로고침 후 재개/ })).toBeVisible();

  // **일시정지가 정착할 때까지 기다린 뒤 재개한다.** `resume_queue` 는 `_done` 에 있는
  // `pause_origin` 취소 항목만 되살리는데, 취소가 확정되기 전에 누르면 되살릴 대상이
  // 0건이라 아무 일도 안 일어난다(실측: resume 200 인데 4건이 cancelled 로 남았다).
  // 사람은 배너를 보고 누르므로 자연히 피해 가는 창이다 — 테스트도 같은 순서를 지킨다.
  // **개수를 못 박지 않는다** — 일시정지 순간 몇 건이 활성이었느냐는 워커 동시성
  // (코어 수)에 좌우된다. 로컬 32코어에서는 4건, CI 에서는 2건이 취소됐다.
  // 필요한 건 "정지가 정착했다" 뿐이므로 진행 중인 행이 없어질 때까지만 기다린다.
  await expect(page.getByRole('button', { name: /^캡처 항목 .* 수집 중/ }))
    .toHaveCount(0, { timeout: 15_000 });

  // Disable the failure-injection and click Resume.
  await api.post(`${API}/api/test/cookie_expire_at`, { data: { index: -1 } });
  // `allowFailed` — 쿠키 오류를 맞은 1건은 **설계상** failed 로 남는다(아래 주석 참고).
  // 여기서만 실패 오라클을 끈다; 다른 스펙에서는 failed 가 곧 결함이다.
  const drained = queueEvents.nextDrained({ allowFailed: true });
  await page.getByRole('button', { name: /새로고침 후 재개/ }).click();

  // **"5 of 5 done" 은 설계상 도달 불가다.** 쿠키 오류를 맞은 항목은 terminal 이다
  // (`captures.py`: "the failing item is terminal and never sleeps awaiting a resume").
  // 재개가 되살리는 건 그 때문에 **취소된 나머지**(`pause_origin`)뿐이라 최대 4건이다.
  // 그래서 "재개 후 큐가 빠져나가고 실패는 1건뿐" 을 주장한다.
  //
  // **CI 가 실제로 죽던 자리다.** 되살아난 4건이 각각 1,523 페이지를 도는 동안 30초
  // 예산이 먼저 끝났다. 이제 큐가 바닥났다는 사실을 프레임으로 받고, UI 는 렌더만 본다.
  await drained;
  await expect(page.locator('text=/완료 4\\/5/')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=/실패 1/')).toBeVisible();
});
