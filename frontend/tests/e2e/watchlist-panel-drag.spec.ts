// 관심종목 패널 실 포인터 드래그 e2e — 행(그룹 내 재정렬) + 그룹(폴더 재정렬).
// 단위/통합(jsdom)이 의도적으로 모킹으로 비껴가는 실제 dnd-kit PointerSensor(5px
// activation) + closestCenter 층을 시스템 Chrome에서 구동한다. GET /api/watchlist mock은
// STATEFUL — PUT이 갱신한 순서를 echo해 invalidate-refetch가 스냅백하지 않는다.

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact, apiPrefix } from './helpers/apiRoutes';

test.use({ channel: 'chrome' });

// 호스트를 박지 않는다 — 'http://localhost:8080' 은 API 주소가 아니라
// config.ts 의 DEFAULT_CONFIG **폴백**이었다. /config.json 이 정상 제공되면
// 앱은 진짜 백엔드로 가고 이 모킹은 한 건도 안 걸린다(2026-07-30 실측).

interface Entry {
  code: string; name: string; registered_at_kst_date: string;
  last_success_date: string | null; folder_id: string | null; order: number;
}
const NAMES: Record<string, string> = { '005930': '삼성전자', '000660': 'SK하이닉스' };

const json = (route: import('@playwright/test').Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function openPanel(page: import('@playwright/test').Page) {
  await page.goto('/live');
  const editMenuBtn = page.getByRole('button', { name: '관심종목 편집' });
  if (!(await editMenuBtn.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
  }
  await expect(editMenuBtn).toBeVisible();
}

test.describe('Watchlist panel drag', () => {
  test('그룹 내 행 드래그가 reorder를 PUT하고 낙관적으로 재배치된다', async ({ page }) => {
    await installLiveMocks(page);
    // 스윙(f_a)에 005930, 000660 — 그룹 내 2행.
    let order = ['005930', '000660'];
    // v4: 패널 dnd 는 `ordered_items`(코드+메모 한 리스트)를 보낸다 — 메모를 종목
    // 사이로 끌 수 있어야 하기 때문이다. 편집 모달은 여전히 `ordered_codes`(메모는
    // 제자리)를 쓰고, 그쪽은 watchlist-edit-reorder.spec.ts 가 잰다.
    type ItemRef = { kind: 'code'; code: string } | { kind: 'memo'; id: string };
    let lastPut: { ordered_items: ItemRef[] } | null = null;
    const entries = (): Entry[] => [
      ...order.map((code, i) => ({
        code, name: NAMES[code], registered_at_kst_date: '20260527',
        last_success_date: null, folder_id: 'f_a', order: i,
      })),
    ];
    await page.route(apiPrefix('live/quotes'), (r) => json(r, { phase: 'open', quotes: [] }));
    await page.route(apiExact('watchlist/folders/f_a/items/order'), async (route) => {
      lastPut = JSON.parse(route.request().postData() || '{}');
      order = lastPut!.ordered_items
        .filter((i): i is { kind: 'code'; code: string } => i.kind === 'code')
        .map((i) => i.code);
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(apiExact('watchlist'), (r) =>
      json(r, { folders: [{ id: 'f_a', name: '스윙', order: 0 }], entries: entries(), memos: [], next_run_at_ms: 0 }));

    await openPanel(page);
    const codesInDom = () =>
      page.locator('[data-testid^="watchlist-row-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('watchlist-row-', '')));
    await expect.poll(codesInDom).toEqual(['005930', '000660']);

    // 첫 행(005930)을 둘째 행(000660) 위로 — 행 전체가 드래그 표면(핸들 없음).
    const from = await page.getByTestId('watchlist-row-005930').boundingBox();
    const to = await page.getByTestId('watchlist-row-000660').boundingBox();
    if (!from || !to) throw new Error('row has no bounding box');
    const fx = from.x + from.width / 2;
    const fy = from.y + from.height / 2;
    const ty = to.y + to.height / 2;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 8, { steps: 4 });   // 5px activation 통과
    await page.mouse.move(fx, ty, { steps: 15 });
    await page.mouse.move(fx, ty + 2, { steps: 2 });
    await page.mouse.up();

    await expect.poll(() => lastPut?.ordered_items ?? null).toEqual([
      { kind: 'code', code: '000660' },
      { kind: 'code', code: '005930' },
    ]);
    await expect.poll(codesInDom).toEqual(['000660', '005930']);
  });

  test('행을 드래그 없이 클릭하면 차트가 열리고 reorder를 PUT하지 않는다', async ({ page }) => {
    // 행 전체가 드래그 표면(listeners on <li>)이라도, distance:5 임계 미만의 단순 클릭은
    // 드래그로 변질되지 않고 onPick(차트 이동)으로 흘러야 한다 — 헤드라인 불변식.
    await installLiveMocks(page);
    let reorderCalled = false;
    const entries: Entry[] = [
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_a', order: 0 },
      { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_a', order: 1 },
    ];
    await page.route(apiPrefix('live/quotes'), (r) => json(r, { phase: 'open', quotes: [] }));
    // ⚠ 부정 단언이므로 **감시 대상이 정확해야** 한다 — 패널 dnd 는 v4 부터
    // `items/order` 를 부른다. 옛 `watchlist/reorder` 를 감시하면 아무도 안 부르는
    // 라우트를 지켜보는 셈이라 이 테스트가 조용히 위양성으로 통과한다.
    await page.route(apiExact('watchlist/folders/f_a/items/order'), async (route) => {
      reorderCalled = true;
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(apiExact('watchlist'), (r) =>
      json(r, { folders: [{ id: 'f_a', name: '스윙', order: 0 }], entries, memos: [], next_run_at_ms: 0 }));

    await openPanel(page);
    const row = page.getByTestId('watchlist-row-000660');
    await expect(row).toBeVisible();
    await row.click();                                   // 이동 없는 단순 클릭

    // 클릭 행이 활성(aria-current)으로 표시되고, reorder PUT은 발사되지 않는다.
    await expect(row).toHaveAttribute('aria-current', 'true');
    // 드래그로 오인됐다면 5px 임계를 넘지 않았으니 reorder는 어차피 안 떴겠지만,
    // 클릭이 드래그 시작으로 먹혀 onPick이 죽는 회귀를 함께 잡는다.
    await page.waitForTimeout(200);
    expect(reorderCalled).toBe(false);
  });

  test('빈 폴더 그룹으로 행을 끌면 그 폴더로 이동한다 (추가 후 출처 제거)', async ({ page }) => {
    // 사용자가 보고한 시나리오 그 자체: **새로 만든(=비어 있는) 그룹**으로 종목을 끌기.
    // 행이 하나도 없으니 "행 위에 놓는다"는 겨냥이 불가능하고, 그룹 블록 droppable
    // (GroupDropZone)만이 유일한 히트 영역이다 — 실제 closestCenter 를 통과해야
    // 의미가 있어 jsdom 이 아니라 여기서 잰다.
    await installLiveMocks(page);
    let ownerByCode: Record<string, string> = { '005930': 'f_a', '000660': 'f_a' };
    const posted: string[] = [];
    const deleted: string[] = [];
    const entries = (): Entry[] => Object.entries(ownerByCode).map(([code, folderId], i) => ({
      code, name: NAMES[code], registered_at_kst_date: '20260527',
      last_success_date: null, folder_id: folderId, order: i,
    }));
    await page.route(apiPrefix('live/quotes'), (r) => json(r, { phase: 'open', quotes: [] }));
    await page.route(apiExact('watchlist/folders/f_b/members'), async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      posted.push(String(body.code));
      ownerByCode = { ...ownerByCode, [String(body.code)]: 'f_b' };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        code: body.code, name: NAMES[String(body.code)], registered_at_kst_date: '20260527',
        last_success_date: null, folder_id: 'f_b', order: 0,
      }) });
    });
    await page.route(apiExact('watchlist/folders/f_a/members/005930'), async (route) => {
      deleted.push('f_a:005930');
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(apiExact('watchlist'), (r) => json(r, {
      folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '새 그룹', order: 1 }],
      entries: entries(), memos: [], next_run_at_ms: 0,
    }));

    await openPanel(page);
    await expect(page.getByTestId('watchlist-row-005930')).toBeVisible();
    // 빈 그룹이라 자기 헤더 높이만큼의 블록이다 — 그 중심을 겨냥한다.
    const zone = await page.getByTestId('watchlist-dropzone-f_b').boundingBox();
    const from = await page.getByTestId('watchlist-row-005930').boundingBox();
    if (!from || !zone) throw new Error('no bounding box');
    const fx = from.x + from.width / 2;
    const fy = from.y + from.height / 2;
    const ty = zone.y + zone.height / 2;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 8, { steps: 4 });   // 5px activation 통과
    await page.mouse.move(fx, ty, { steps: 15 });
    await page.mouse.up();

    // 이동 = 대상 폴더에 추가 후 출처 폴더에서 제거(v3 다중 소속, ADR-0070).
    await expect.poll(() => posted).toEqual(['005930']);
    await expect.poll(() => deleted).toEqual(['f_a:005930']);
    // 화면에서도 새 그룹 아래로 옮겨 붙는다 — 그룹 블록이 그 행을 품는지로 잰다.
    await expect(page.getByTestId('watchlist-group-f_b')
      .getByTestId('watchlist-row-005930')).toBeVisible();
  });

  test('그룹 헤더 드래그가 전 그룹을 접고, folders/order를 PUT하고 그룹을 재배치한다', async ({ page }) => {
    await installLiveMocks(page);
    let folderOrder = ['f_a', 'f_b'];
    const FNAMES: Record<string, string> = { f_a: '스윙', f_b: '장기' };
    let lastPut: { ordered_ids: string[] } | null = null;
    const folders = () => folderOrder.map((id, i) => ({ id, name: FNAMES[id], order: i }));
    const entries: Entry[] = [
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_a', order: 0 },
      { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260527', last_success_date: null, folder_id: 'f_b', order: 0 },
    ];
    await page.route(apiPrefix('live/quotes'), (r) => json(r, { phase: 'open', quotes: [] }));
    await page.route(apiExact('watchlist/folders/order'), async (route) => {
      lastPut = JSON.parse(route.request().postData() || '{}');
      folderOrder = lastPut!.ordered_ids;
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route(apiExact('watchlist'), (r) =>
      json(r, { folders: folders(), entries, memos: [], next_run_at_ms: 0 }));

    await openPanel(page);
    // **접두사 충돌 주의.** `watchlist-group-` 로 시작하는 testid 는 그룹 컨테이너 말고도
    // `watchlist-group-header` · `-picker` · `-add-popover` 가 있어서, 그대로 세면
    // ['f_a','header','f_b','header'] 가 나온다(실측). 폴더 id 만 남긴다.
    const NON_GROUP = new Set(['header', 'picker', 'add-popover']);
    const groupsInDom = () =>
      page.locator('[data-testid^="watchlist-group-"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')!.replace('watchlist-group-', '')))
        .then((ids) => ids.filter((id) => !NON_GROUP.has(id)));
    await expect.poll(groupsInDom).toEqual(['f_a', 'f_b']);

    // 스윙(f_a) 그룹을 장기(f_b) 그룹 위로 드래그.
    // **별도 ⠿ 핸들 요소가 없다** — dnd-kit 리스너가 그룹 **헤더 전체**에 붙어 있어
    // (`watchlist-group-header`, `setActivatorNodeRef` + `{...listeners}`) 헤더를 5px 이상
    // 끌면 그룹 드래그가 시작된다. `group-drag-handle` 은 앱에 존재한 적 없는 testid 다.
    const handle = await page.getByTestId('watchlist-group-f_a')
      .getByTestId('watchlist-group-header').boundingBox();
    if (!handle) throw new Error('handle has no bounding box');
    const fx = handle.x + handle.width / 2;
    const fy = handle.y + handle.height / 2;
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx, fy + 8, { steps: 4 });   // 5px 임계 넘김 = 드래그 활성화

    // 드래그가 붙은 **뒤에** 재는 것이 중요하다. 활성화되면 전 그룹이 헤더만 남게
    // 접히면서 대상 그룹의 상자가 그 자리에서 줄어든다 — 시작 전 좌표로 겨냥하면
    // 엉뚱한 곳을 노린다(블록이 클수록 더 크게 어긋난다).
    await expect(page.getByTestId('watchlist-row-005930')).toBeHidden();
    await expect(page.getByTestId('watchlist-row-000660')).toBeHidden();
    // 손에는 그룹명 + 개수 칩이 들려 있다. 빈 오버레이 카드가 아니다.
    await expect(page.getByTestId('watchlist-drag-ghost')).toContainText('스윙');

    const target = await page.getByTestId('watchlist-group-f_b').boundingBox();
    if (!target) throw new Error('target has no bounding box');
    const ty = target.y + target.height / 2;
    await page.mouse.move(fx, ty, { steps: 15 });
    await page.mouse.move(fx, ty + 2, { steps: 2 });
    await page.mouse.up();

    // 드롭이 끝나면 행이 돌아온다 — 접힘은 드래그 동안의 렌더 오버라이드일 뿐이다.
    await expect(page.getByTestId('watchlist-row-005930')).toBeVisible();

    await expect.poll(() => lastPut?.ordered_ids ?? null).toEqual(['f_b', 'f_a']);
    await expect.poll(groupsInDom).toEqual(['f_b', 'f_a']);
  });
});
