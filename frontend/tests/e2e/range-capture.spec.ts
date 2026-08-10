import { test, expect, request } from '@playwright/test';
import { selectSymbol, tradingDates } from './helpers/calendar';
import { observeCaptureQueue } from './helpers/captureEvents';
import { resetQueue } from './helpers/queue';

// 파일 전체 예산은 `test.describe.configure` 로 준다 — 그룹·파일 단위 타임아웃의
// **문서화된 형태**다(`test.setTimeout` 타입 문서가 그룹 용례로 이걸 가리킨다).
// 파일 스코프 `test.setTimeout()` 도 실제로 동작한다(1.60.0↔1.62.1 `_setTimeout` 구현
// 동일 — 로딩 중이면 `suite._timeout` 에 넣고 반환). 참고로 "1.62 가 이걸 수집 단계에서
// 거부한다"는 보고는 **재현되지 않았다**: 그 에러는 **리포 루트에서 config 없이
// `npx playwright`** 를 돌렸을 때 나오고, 같은 실행에서 live-tick 의 `test.use()` 도
// 함께 죽는다 — 버전이 아니라 cwd 문제이므로 이 폼으로 바꿔도 그 실행은 여전히 깨진다.
//
// **기본 30초로는 안 된다 — 이 스펙은 백엔드에서 진짜 작업을 시킨다.**
// 캡처 6건 × 1,523 페이지이고, 실측(32코어 개발기)이 건당 2.8~3.9초 · 스펙 전체 9.0초다.
// 2코어 공유 러너에서는 GIL 경합으로 몇 배가 되므로 기본 예산이 곧바로 구속조건이 된다
// (2026-08-03 CI: `Test timeout of 30000ms exceeded`). 여유를 실측의 ~13배로 잡는다.
// 아래 대기들은 벽시계가 아니라 WS 프레임으로 깨어나므로, 이 값은 교착 백스톱이지
// 성능 예산이 아니다.
test.describe.configure({ timeout: 120_000 });

test('range-capture: search → pick 3 trading days → Start → queue progresses to done × 3', async ({ page }) => {
  // 날짜는 런타임에 고른다 — 이전 판의 20260518/20 은 작성 시점(2026-05)에만 존재했다.
  // 근거와 오프셋 배분은 helpers/calendar.ts.
  // 실패 주입은 **프로세스 전역**이다. cookie-pause 가 중간에 죽으면 index 를 -1 로
  // 되돌리지 못한 채 끝나고, 그 뒤 모든 캡처가 CookieExpiredError 로 실패한다(실측:
  // 이 스펙의 3행이 전부 failed). 시작할 때 확실히 끈다.
  const api = await request.newContext();
  await api.post('http://127.0.0.1:8765/api/test/cookie_expire_at', { data: { index: -1 } });

  // 네비게이션 **전에** 붙인다 — 앱이 첫 로드에서 /api/ws 를 연다.
  const queueEvents = observeCaptureQueue(page);
  await selectSymbol(page);
  // 큐는 전역이라 앞선 스펙의 행이 남아 있다 — 개수를 세기 전에 비운다.
  await resetQueue(page);
  const days = await tradingDates(page, 3, 5);

  // 2. 연속 거래일 3일 = 양 끝 클릭.
  await page.getByTestId(`calendar-cell-${days[0]}`).click();
  await page.getByTestId(`calendar-cell-${days[2]}`).click();

  // 3. Start. 드레인 프레임은 **클릭 전에** 예약한다(클릭 후면 놓칠 수 있다).
  const drained1 = queueEvents.nextDrained();
  await page.getByRole('button', { name: /캡처 시작/ }).click();

  // 4. capture_queued WebSocket event (ch:'event'): 3 rows appear.
  // **행만** 센다 — `/^queue-row-/` 는 행 내부의 `queue-row-full-capture-count`·
  // `queue-row-throttled` 같은 배지까지 잡아 3행이 6으로 세어졌다.
  const rows = page.getByRole('button', { name: /^캡처 항목 / });
  await expect(rows).toHaveCount(3, { timeout: 5_000 });

  // 5. Phase transitions visible — wait for header summary to read "완료 3/3".
  //    업스트림 없이도 도달한다 — HOGA_ENABLE_TEST_ENDPOINTS=1 이면 FakeHogaplayClient 가
  //    결정론적 페이지를 내준다(날짜 무관).
  //
  //    **캡처 작업이 끝나는 것과 UI 가 그걸 그리는 것을 분리한다.** 앞의 대기는 백엔드
  //    프레임(`capture_queue_drained`)으로 깨어나므로 러너 속도에 좌우되지 않고, 캡처가
  //    실패하면 15초를 기다리는 대신 즉시 그 에러로 죽는다. 뒤의 단언은 이제 렌더 반영만
  //    본다 — UI 회귀는 그대로 잡히면서 바운드는 짧아도 된다.
  await drained1;
  await expect(page.locator('text=/완료 3\\/3/')).toBeVisible({ timeout: 10_000 });

  // 6. Append a second symbol's range — multi-symbol queue test.
  // **이름이 아니라 코드로 찾는다.** 'SK' 로 검색하면 20건이 돌아오고 SK하이닉스 는
  // 그 안에 없다(SK · SKC · SK우 · SK증권 · SK가스 …). 코드는 1건으로 결정적이다.
  // 종목을 이미 고른 뒤라 `fill()` 만으로는 드롭다운이 다시 안 열린다(실측: 입력창은
  // active 인데 값도 옵션도 없다). 클릭 → 비우기 → **한 글자씩 입력**으로 실제 타이핑을
  // 흉내 낸다.
  const symbolInput = page.getByPlaceholder(/종목/);
  await symbolInput.click();
  await symbolInput.fill('');
  await symbolInput.pressSequentially('000660', { delay: 30 });
  await page.getByText(/SK하이닉스/, { exact: false }).first().click();
  // 종목을 바꾸면 달력이 이번 달로 돌아오므로 다시 전월로 넘어가 같은 날짜를 고른다.
  const days2 = await tradingDates(page, 3, 5);
  await page.getByTestId(`calendar-cell-${days2[0]}`).click();
  await page.getByTestId(`calendar-cell-${days2[2]}`).click();
  const drained2 = queueEvents.nextDrained();
  await page.getByRole('button', { name: /캡처 시작/ }).click();
  await drained2;
  await expect(page.locator('text=/완료 6\\/6/')).toBeVisible({ timeout: 10_000 });

  // 7. 전체 취소 — drains any leftover queued; verify it does not crash.
  await page.getByRole('button', { name: /전체 취소/ }).click();
  // Second click confirms (two-step destructive guard).
  await page.getByRole('button', { name: /한 번 더 누르면 전체 취소/ }).click();

  // 8. 완료 지우기 — table empties.
  // **취소가 반영될 때까지 기다린 뒤에 누른다.** 전체 취소 는 비동기라, 진행/대기 행이
  // terminal 로 내려앉기 전에 완료 지우기 를 누르면 그 행들이 그대로 남는다(CI 에서 2건
  // 잔존). 로컬은 이미 전부 done 이라 우연히 통과했다.
  //
  // **여기는 `nextDrained()` 로 바꾸면 안 된다.** 위에서 "완료 6/6" 을 확인한 뒤라
  // 큐도 활성도 이미 비어 있고, 그러면 `_finalize_item` 이 돌지 않아 드레인 프레임이
  // **아예 나오지 않는다**(captures.py: 드레인은 마지막 항목의 finalize 안에서만 발행).
  // 예약해 두면 백스톱까지 매달린다. 반대로 여기서 기다리는 일(취소 반영)은 캡처 작업이
  // 아니라 UI 정착이라 부하에 민감하지도 않다 — 벽시계 바운드가 맞는 자리다.
  await expect(page.getByRole('button', { name: /^캡처 항목 .* (수집 중|대기)/ }))
    .toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: /완료 지우기/ }).click();
  await expect(rows).toHaveCount(0, { timeout: 10_000 });
});
