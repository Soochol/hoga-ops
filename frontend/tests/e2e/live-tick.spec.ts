// `/live` **실시간 틱**이 화면을 움직이는지 — e2e 가 처음으로 구동하는 층.
//
// SSE→WebSocket 이관(ADR-0053) 이후 틱은 `page.route` 로 못 잡아서, `liveMocks.ts` 에
// "TODO(ws-migration)" 만 남고 **실시간 흐름은 한 번도 검증된 적이 없었다**. 나머지 스펙은
// 전부 정적 화면(레이아웃·메뉴·드래그)만 봤다. 여기서 `page.routeWebSocket` 으로 그 구멍을
// 메운다 — 프레임 타이밍이 전적으로 스펙 손에 있으므로 시계에 의존하지 않는다.
//
// 검증 대상은 `liveTickOverlay` 다: 체결 프레임이 오면 리스트 행의 현재가·등락률이
// **폴링 없이** 갱신된다(ADR: 리스트 등락률 실시간 오버레이).
import { test, expect, type Route } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiPrefix } from './helpers/apiRoutes';
import { installLiveWs, tradeFrame } from './helpers/liveWs';

test.use({ channel: 'chrome' }); // 시스템 Chrome (live-smoke 와 동일 사유)

// liveMocks 의 WATCHLIST 가 담고 있는 유일한 종목.
const CODE = '098460';

/** REST 시세를 고정한다. 모킹하지 않으면 진짜 백엔드가 그때그때 다른 값을 준다
 *  (실측: 행에 26,100/+15.74% 가 떠 있었다) — 틱의 효과를 그 위에서 판별할 수 없다.
 *  30,000 / 0.00% 로 못박고, 틱이 이 값을 **덮는지**를 본다. */
async function pinQuotes(page: import('@playwright/test').Page) {
  await page.route(apiPrefix('live/quotes'), (r: Route) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        phase: 'open',
        quotes: [{ code: CODE, price: 30_000, change_pct: 0, change_won: 0 }],
      }),
    }));
}

test.describe('/live 실시간 틱', () => {
  test('체결 프레임이 관심종목 행의 현재가·등락률을 갱신한다', async ({ page }) => {
    const ws = await installLiveWs(page);   // goto 전에 등록해야 첫 연결을 잡는다
    await installLiveMocks(page);
    await pinQuotes(page);

    await page.goto('/live');
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();

    const row = page.getByTestId(`watchlist-row-${CODE}`);
    await expect(row).toBeVisible();
    // 틱 전에는 REST 값(폴링 스냅샷)이 보인다.
    await expect(row).toContainText('30,000');

    await ws.waitForSubscribe(CODE);
    // 전일종가 30,000 → 체결 36,000 = +20.00%
    ws.pushLive(CODE, tradeFrame({ price: 36_000, prevClose: 30_000 }));

    await expect(row).toContainText('36,000');
    await expect(row).toContainText('20.00%');
  });

  test('venue 가 안 맞는 프레임은 무시된다 (NXT 태그 + 정규장 시각)', async ({ page }) => {
    // `liveVenueAcceptsFrame` 의 게이트가 실제로 걸리는지 — 위 테스트가 "아무 프레임이나
    // 통과한다" 로 통과하는 게 아님을 보이는 **대조군**이다. 정규장 시각(고정)에 NXT 로
    // 태그된 프레임은 AUTO venue 에서 버려져야 한다.
    const ws = await installLiveWs(page);
    await installLiveMocks(page);
    await pinQuotes(page);

    await page.goto('/live');
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();

    const row = page.getByTestId(`watchlist-row-${CODE}`);
    await expect(row).toContainText('30,000');
    await ws.waitForSubscribe(CODE);

    ws.pushLive(CODE, tradeFrame({ price: 36_000, prevClose: 30_000, venue: 'NXT' }));

    // 버려져야 하므로 가격이 뜨면 안 된다. 부정형 단언이라 **관측 실패가 통과로 읽히는**
    // 위험이 있어(폴링 종료조건 함정), 뒤이어 KRX 프레임을 보내 화면이 실제로 반응하는
    // 상태였음을 증명한다 — 그래야 "안 떴다" 가 의미를 갖는다.
    await expect(row).not.toContainText('36,000');

    ws.pushLive(CODE, tradeFrame({ price: 33_000, prevClose: 30_000 }));
    await expect(row).toContainText('33,000');
  });
});
