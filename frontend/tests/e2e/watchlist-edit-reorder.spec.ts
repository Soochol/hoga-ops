// frontend/tests/e2e/watchlist-edit-reorder.spec.ts
//
// 편집 모달 드래그 정렬 e2e — 구 watchlist-reorder.spec.ts(패널 행 드래그)의 포팅.
// 패널 행 드래그는 v0.5.5.0에서 제거되고 구조 편집이 편집 모달로 일원화됐다:
// 이제 진짜 dnd-kit PointerSensor 드래그(5px activation distance)는 편집 모달의
// ⠿ 핸들에서 일어난다 — jsdom 단위 테스트가 의도적으로 모킹으로 비껴가는 그 층.
// PUT /api/watchlist/reorder mock 은 STATEFUL: invalidate-refetch 가 스냅백하지
// 않고 유지된 순서를 관측한다.

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test.use({ channel: 'chrome' }); // 시스템 Chrome (live-smoke 와 동일 사유)

// 호스트를 박지 않는다 — 'http://localhost:8080' 은 API 주소가 아니라
// config.ts 의 DEFAULT_CONFIG **폴백**이었다. /config.json 이 정상 제공되면
// 앱은 진짜 백엔드로 가고 이 모킹은 한 건도 안 걸린다(2026-07-30 실측).

interface Entry {
  code: string; name: string; registered_at_kst_date: string;
  last_success_date: string | null; folder_id: string; order: number;
}
const NAMES: Record<string, string> = {
  '005930': '삼성전자', '000660': 'SK하이닉스', '035720': '카카오',
};
const FOLDER_ID = 'f_a';
const entriesIn = (codes: string[]): Entry[] =>
  codes.map((code, i) => ({
    code, name: NAMES[code], registered_at_kst_date: '20260527',
    last_success_date: null, folder_id: FOLDER_ID, order: i,
  }));

test.describe('Watchlist edit modal drag-reorder', () => {
  test('⠿ drag past 5px reorders, PUTs ordered_codes, and sticks after refetch', async ({ page }) => {
    await installLiveMocks(page);

    let order = ['005930', '000660', '035720'];
    let lastPut: { folder_id: string; ordered_codes: string[] } | null = null;
    const json = (route: import('@playwright/test').Route, body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    await page.route(apiPrefix('live/quotes'), (r) => json(r, { phase: 'open', quotes: [] }));
    // PUT /reorder — 새 순서를 캡처하고 서버 상태를 갱신해 echo.
    await page.route(apiExact('watchlist/reorder'), async (route) => {
      lastPut = JSON.parse(route.request().postData() || '{}');
      order = lastPut!.ordered_codes;
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(apiExact('watchlist'), (r) => {
      if (r.request().method() !== 'GET') return r.fallback();
      return json(r, {
        folders: [{ id: FOLDER_ID, name: '테스트 그룹', order: 0 }],
        entries: entriesIn(order),
        next_run_at_ms: 0,
      });
    });

    await page.goto('/live');
    // 패널 열기(영속 상태로 이미 열려 있으면 생략) → 편집 메뉴 → 관심 편집
    const editMenuBtn = page.getByRole('button', { name: '관심종목 편집' });
    if (!(await editMenuBtn.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    }
    // 드로어에서 **메뉴가 제거**됐다 — "편집" 버튼이 모달을 바로 연다
    // (`WatchlistDrawer.tsx`: "메뉴를 없애고 '편집'이 관심 편집 모달을 바로 연다").
    await editMenuBtn.click();
    await expect(page.getByRole('dialog', { name: '관심종목 편집' })).toBeVisible();
    const editDialog = page.getByRole('dialog', { name: '관심종목 편집' });
    // **행 래퍼도 role="button" 이다**(dnd-kit sortable) — 이름이 같아 strict 위반이
    // 난다. 선택을 담당하는 건 행 **안쪽** 버튼(`onSelect`)이고, 바깥 div 는 드래그용
    // 래퍼다. 행 testid 로 범위를 좁혀 어느 쪽을 누르는지 코드에 드러낸다.
    await editDialog.getByTestId(`folder-row-${FOLDER_ID}`).getByRole('button', { name: '테스트 그룹 3' }).click();

    const codesInDom = () =>
      page.locator('[data-testid^="edit-row-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('edit-row-', '')));
    expect(await codesInDom()).toEqual(['005930', '000660', '035720']);

    // 첫 행(005930)을 셋째 행(035720) 위로 드래그 ⇒ [000660, 035720, 005930].
    // **핸들이 따로 없다** — dnd-kit 의 `{...listeners}` 가 행 자체에 붙어 있어
    // 행 어디를 잡아도 드래그가 시작된다(`WatchlistEntryPane.tsx`). 예전엔 `.cursor-grab`
    // 이라는 **CSS 클래스**를 잡았는데, 그건 스타일에 결합된 셀렉터라 클래스가 바뀌면
    // 조용히 깨진다 — 행 testid 로 잡는다.
    const handle = await page.getByTestId('edit-row-005930').boundingBox();
    const target = await page.getByTestId('edit-row-035720').boundingBox();
    if (!handle || !target) throw new Error('drag handle/target has no bounding box');
    const fx = handle.x + handle.width / 2;
    const fy = handle.y + handle.height / 2;
    const ty = target.y + target.height / 2;

    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 8, { steps: 4 });   // 5px activation distance 통과
    await page.mouse.move(fx, ty, { steps: 15 });      // 타겟 위로 이동 → closestCenter over
    await page.mouse.move(fx, ty + 2, { steps: 2 });
    await page.mouse.up();

    // PUT 이 기대 순서로 발사되고…
    await expect.poll(() => lastPut?.ordered_codes ?? null).toEqual(['000660', '035720', '005930']);
    expect(lastPut!.folder_id).toBe(FOLDER_ID);        // 그룹 내 정렬
    // …낙관적 캐시가 즉시 행을 재배열한다.
    await expect.poll(codesInDom).toEqual(['000660', '035720', '005930']);
  });
});
