# 관심종목 행 우클릭 컨텍스트 메뉴 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 우측 관심종목 패널 행을 우클릭하면 커서 위치에 popover 메뉴(관심 해제)가 뜨고, hover 트래시는 제거하며, 포커스된 행에서 `Delete` 키로도 해제할 수 있게 한다.

**Architecture:** 프론트엔드 전용. 공유 `QuoteRow`에 *선택적* `onContextMenu`·`onDelete` prop만 추가(ADR-0058 패턴 — 스크리너 무영향). 워치리스트 전용 `WatchlistRowMenu`가 커서에 떠 `useLayoutEffect`로 실측 클램프, 기존 `useDismissablePopover`로 외부클릭/Escape 닫기. `WatchlistDrawer`가 메뉴 상태를 소유하고 트래시 `trailingAction`을 제거한다. 삭제는 트리거(메뉴/Delete)와 무관하게 기존 `useRemoveFromWatchlist` 한 mutation으로 라우팅.

**Tech Stack:** React/TypeScript, @tanstack/react-query, vitest + @testing-library/react, (선택) Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-06-02-watchlist-row-context-menu-design.md`

---

## File Structure

| File | 책임 | 변경 |
|------|------|------|
| `frontend/src/rightrail/QuoteRow.tsx` | 공유 행. 선택적 `onContextMenu`·`onDelete` + Delete 합성 keydown | Modify |
| `frontend/src/rightrail/QuoteRow.test.tsx` | 우클릭/Delete prop 테스트 | Modify |
| `frontend/src/watchlist/WatchlistRowMenu.tsx` | 커서 앵커 메뉴(실측 클램프, items 배열) | Create |
| `frontend/src/watchlist/WatchlistRowMenu.test.tsx` | 메뉴 단위 테스트 | Create |
| `frontend/src/watchlist/WatchlistDrawer.tsx` | 메뉴 상태·배선, 트래시 제거 | Modify |
| `frontend/src/watchlist/WatchlistDrawer.test.tsx` | 트래시 테스트 제거 + 우클릭·Delete 테스트 | Modify |
| `frontend/tests/e2e/watchlist-context-menu.spec.ts` | (선택) 실 브라우저 우클릭→해제 | Create |

모든 frontend 명령은 `frontend/`에서 실행. **테스트는 `npx vitest`, 타입체크는 `npx tsc -b`** (CLI가 권위 — IDE squiggle 무시). 커밋은 워크트리 안전하게 `git add <정확한 경로> && git commit`(`--only` 금지, `-A`/`.` 금지), 커밋 전 `git status --porcelain` 확인.

---

## Task 1: `QuoteRow` — 선택적 `onContextMenu` + `onDelete`

순수 가산적(스크리너는 미전달 → 무영향). 기존 `QuoteRow.test.tsx`의 `row()` 헬퍼 재사용.

**Files:**
- Modify: `frontend/src/rightrail/QuoteRow.tsx`
- Test: `frontend/src/rightrail/QuoteRow.test.tsx`

- [ ] **Step 1: Write the failing tests** — `frontend/src/rightrail/QuoteRow.test.tsx`의 `describe('QuoteRow', ...)` 끝(마지막 `it` 뒤, `})` 앞)에 추가:

```tsx
  it('right-click calls onContextMenu', () => {
    const onContextMenu = vi.fn();
    row({ onContextMenu });
    fireEvent.contextMenu(screen.getByTestId('quote-row-005930'));
    expect(onContextMenu).toHaveBeenCalledOnce();
  });

  it('Delete key on the focused row calls onDelete (not onClick)', () => {
    const onDelete = vi.fn();
    const { onClick } = row({ onDelete });
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Enter still triggers onClick when onDelete is provided', () => {
    const onDelete = vi.fn();
    const { onClick } = row({ onDelete });
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/rightrail/QuoteRow.test.tsx -t "onContextMenu|onDelete|onClick when onDelete"`
Expected: FAIL — onContextMenu/onDelete not wired (handlers never called).

- [ ] **Step 3: Add the props + wire them** — `frontend/src/rightrail/QuoteRow.tsx`.

(3a) `QuoteRowProps` 인터페이스에 drag props 블록 바로 뒤(`dragging?: boolean;` 다음 줄)에 추가:

```ts
  // --- 관심종목 패널 전용 우클릭/Delete (미전달 시 무동작) ---
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
  onDelete?: () => void;
```

(3b) 함수 시그니처 구조분해에 추가 (`dragging,` 다음):

```ts
export function QuoteRow({
  name, price, pct, changeWon, active, ariaLabel, testId, onClick, trailingAction,
  sortableRef, sortableStyle, dragListeners, dragAttributes, dragging,
  onContextMenu, onDelete,
}: QuoteRowProps) {
```

(3c) 기존 `onKeyDown`에 Delete 분기를 *합성*(Enter/Space 위에):

```ts
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    // 중첩 버튼(trailingAction)에서 올라온 keydown 은 무시 — 행이 직접
    // 포커스됐을 때만 동작한다.
    if (e.target !== e.currentTarget) return;
    if (onDelete && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault(); onDelete(); return;
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };
```

(3d) `<li>`의 `onKeyDown={onKeyDown}` 바로 다음 줄에 추가:

```tsx
      onContextMenu={onContextMenu}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npx vitest run src/rightrail/QuoteRow.test.tsx`
Expected: PASS (기존 + 신규 3).

Run: `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/rightrail/QuoteRow.tsx frontend/src/rightrail/QuoteRow.test.tsx
git commit -m "feat(rightrail): QuoteRow 선택적 onContextMenu·onDelete prop"
```

---

## Task 2: `WatchlistRowMenu` — 커서 앵커 메뉴 (신규)

**Files:**
- Create: `frontend/src/watchlist/WatchlistRowMenu.tsx`
- Test: `frontend/src/watchlist/WatchlistRowMenu.test.tsx`

- [ ] **Step 1: Write the failing test** — `frontend/src/watchlist/WatchlistRowMenu.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WatchlistRowMenu } from './WatchlistRowMenu';

describe('WatchlistRowMenu', () => {
  it('renders a role=menu with the 관심 해제 item', () => {
    render(<WatchlistRowMenu x={10} y={20} name="삼성전자" onRemove={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('watchlist-row-menu').getAttribute('role')).toBe('menu');
    expect(screen.getByText('관심 해제')).toBeInTheDocument();
  });

  it('clicking 관심 해제 calls onRemove then onClose', () => {
    const onRemove = vi.fn();
    const onClose = vi.fn();
    render(<WatchlistRowMenu x={0} y={0} name="삼성전자" onRemove={onRemove} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('watchlist-menu-remove'));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run src/watchlist/WatchlistRowMenu.test.tsx`
Expected: FAIL — cannot find module `./WatchlistRowMenu`.

- [ ] **Step 3: Implement the menu** — `frontend/src/watchlist/WatchlistRowMenu.tsx`:

```tsx
import { useLayoutEffect, useRef, useState } from 'react';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { HeartIcon } from '../ui/HeartIcon';

interface Props {
  x: number;            // raw 커서 viewport 좌표
  y: number;
  name: string;         // 접근성 라벨용
  onRemove: () => void;
  onClose: () => void;
}

type MenuItem = { key: string; label: string; icon: React.ReactNode; onClick: () => void };

/**
 * 관심종목 행 우클릭 컨텍스트 메뉴 (워치리스트 전용). 커서 (x,y)에 fixed 로 뜨되,
 * 렌더 후 자기 rect 를 실측해 우/하단 오버플로를 보정한다(매직넘버 없음). 항목은
 * 배열을 순회 — 추후 '메모' 가 두 번째 항목으로 합류한다(그때 onMemo prop 추가).
 */
export function WatchlistRowMenu({ x, y, name, onRemove, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useDismissablePopover(true, menuRef, onClose);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width  > window.innerWidth  ? Math.max(0, window.innerWidth  - width)  : x;
    const top  = y + height > window.innerHeight ? Math.max(0, window.innerHeight - height) : y;
    setPos({ left, top });
  }, [x, y]);

  const items: MenuItem[] = [
    {
      key: 'remove',
      label: '관심 해제',
      icon: <HeartIcon filled className="w-[1em] h-[1em]" />,
      onClick: () => { onRemove(); onClose(); },
    },
  ];

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`${name} 컨텍스트 메뉴`}
      data-testid="watchlist-row-menu"
      onContextMenu={(e) => e.preventDefault()}
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1"
      style={{ position: 'fixed', left: pos.left, top: pos.top, minWidth: '8rem' }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-testid={`watchlist-menu-${item.key}`}
          onClick={item.onClick}
          className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
        >
          <span className="w-4 grid place-items-center">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npx vitest run src/watchlist/WatchlistRowMenu.test.tsx`
Expected: PASS (2). (jsdom 의 `getBoundingClientRect` 는 0 이라 클램프는 no-op — 메뉴는 raw 좌표로 렌더, 테스트는 위치를 단언하지 않음.)

Run: `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/watchlist/WatchlistRowMenu.tsx frontend/src/watchlist/WatchlistRowMenu.test.tsx
git commit -m "feat(watchlist): WatchlistRowMenu 커서 앵커 컨텍스트 메뉴"
```

---

## Task 3: `WatchlistDrawer` — 메뉴 배선 + 트래시 제거 + Delete

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Test: `frontend/src/watchlist/WatchlistDrawer.test.tsx`

- [ ] **Step 1: Update the tests** — `frontend/src/watchlist/WatchlistDrawer.test.tsx`.

(1a) 기존 트래시 테스트를 **삭제**한다 (트래시 affordance 가 사라짐). 이 `it` 블록 전체 제거:

```tsx
  it('clicking a row trash icon removes it from the watchlist', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const removeSpy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    const trash = within(screen.getByTestId('watchlist-row-005930')).getByRole('button', { name: '삼성전자 관심종목 해제' });
    fireEvent.click(trash);
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('005930'));
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });
```

(1b) 같은 위치(`describe('WatchlistDrawer', ...)` 의 마지막 `it` 자리)에 두 테스트 추가:

```tsx
  it('right-click opens the context menu; 관심 해제 removes the entry and closes', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const removeSpy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    // 네이티브 메뉴 억제: preventDefault → dispatchEvent 가 false
    const notCancelled = fireEvent.contextMenu(screen.getByTestId('watchlist-row-005930'));
    expect(notCancelled).toBe(false);
    fireEvent.click(screen.getByTestId('watchlist-menu-remove'));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('005930'));
    expect(screen.queryByTestId('watchlist-row-menu')).toBeNull();
  });

  it('Delete key on a focused row removes the entry', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const removeSpy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByTestId('watchlist-row-000660'), { key: 'Delete' });
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('000660'));
  });
```

> `within` 은 다른 테스트에서 더는 안 쓰이면 import 에서 빠질 수 있다 — Step 4 의 eslint 에서 잡히면 import 라인에서 `within` 제거.

- [ ] **Step 2: Run the new tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/watchlist/WatchlistDrawer.test.tsx -t "context menu|Delete key"`
Expected: FAIL — 드로어가 아직 우클릭/Delete/메뉴를 배선하지 않음(`watchlist-menu-remove` 없음, removeSpy 미호출).

- [ ] **Step 3: Wire the drawer** — `frontend/src/watchlist/WatchlistDrawer.tsx`.

(3a) import 수정:
- `import { useMemo } from 'react';` → `import { useMemo, useState } from 'react';`
- `import { TrashIcon } from '../ui/TrashIcon';` 줄 **삭제**.
- 다음 줄 추가(예: `SortableQuoteRow` import 근처): `import { WatchlistRowMenu } from './WatchlistRowMenu';`

(3b) 컴포넌트 본문, `onDragEnd` 정의 바로 아래에 메뉴 상태 추가:

```ts
  const [menu, setMenu] = useState<{ x: number; y: number; code: string; name: string } | null>(null);
  const openMenu = (e: React.MouseEvent, code: string, name: string) => {
    e.preventDefault();                                   // 네이티브 우클릭 메뉴 억제
    setMenu({ x: e.clientX, y: e.clientY, code, name });  // raw 좌표 — 클램프는 메뉴가 실측
  };
  const closeMenu = () => setMenu(null);
```

(3c) 행 렌더에서 `trailingAction={...}` (트래시 버튼) 블록 전체를 제거하고 `onContextMenu`·`onDelete` 로 교체. `<SortableQuoteRow ...>` 를 다음으로:

```tsx
                <SortableQuoteRow
                  key={entry.code}
                  code={entry.code}
                  name={entry.name}
                  price={q?.price ?? null}
                  pct={q?.change_pct ?? null}
                  changeWon={q?.change_won ?? null}
                  active={entry.code === activeCode}
                  ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
                  testId={`watchlist-row-${entry.code}`}
                  onClick={() => onPick(entry.code)}
                  onContextMenu={(e) => openMenu(e, entry.code, entry.name)}
                  onDelete={() => removeM.mutate(entry.code)}
                />
```

(3d) `</DndContext>` 바로 다음, 드로어 루트 `</div>` 직전에 메뉴 렌더 추가:

```tsx
      {menu && (
        <WatchlistRowMenu
          x={menu.x}
          y={menu.y}
          name={menu.name}
          onRemove={() => removeM.mutate(menu.code)}
          onClose={closeMenu}
        />
      )}
```

> `removeM`(`useRemoveFromWatchlist`)·`reorderM`·`onPick` 등 기존 훅/변수는 그대로. 헤더·로딩/에러/빈 분기·DndContext·SortableContext 는 변경하지 않는다.

- [ ] **Step 4: Run the whole drawer file (new pass + existing green)**

Run (from `frontend/`): `npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: PASS — 기존(렌더/클릭점프/하이라이트/시세/드래그 2) + 신규 2, 트래시 테스트는 제거됨.

Run: `npx tsc -b` → clean. (만약 `within` 미사용 경고가 eslint 에서 뜨면 import 에서 제거 후 재실행.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -m "feat(watchlist): WatchlistDrawer 우클릭 메뉴·Delete 배선, hover 트래시 제거"
```

---

## Task 4: 통합 게이트

**Files:** 없음 (검증 전용)

- [ ] **Step 1: Frontend type-check**

Run (from `frontend/`): `npx tsc -b`
Expected: PASS (0 errors).

- [ ] **Step 2: Scoped eslint (변경 파일만 — 레포 전체 lint 는 기존 부채로 실패)**

Run (from `frontend/`):
```bash
npx eslint \
  src/rightrail/QuoteRow.tsx src/rightrail/QuoteRow.test.tsx \
  src/watchlist/WatchlistRowMenu.tsx src/watchlist/WatchlistRowMenu.test.tsx \
  src/watchlist/WatchlistDrawer.tsx src/watchlist/WatchlistDrawer.test.tsx
```
Expected: 0 errors. (`within` 등 미사용 import 가 있으면 제거.)

- [ ] **Step 3: Full frontend test suite (회귀 없음)**

Run (from `frontend/`): `npx vitest run`
Expected: PASS (all) — 스크리너 등 `QuoteRow` 공유 사용처가 새 선택적 props 없이도 동일.

- [ ] **Step 4: Commit (검증 중 수정이 있었다면)**

```bash
git add -A 2>/dev/null; git status --porcelain   # 의도한 파일만 스테이지됐는지 확인 후
# (정확한 경로로) git add <paths> && git commit -m "chore(watchlist): 컨텍스트 메뉴 통합 게이트 정리"
```
> 수정이 없으면 이 단계는 생략.

---

## Task 5 (선택): 실 브라우저 e2e

jsdom 은 레이아웃/실 포인터를 못 다룬다(ADR-0057). 실제 우클릭 → 네이티브 메뉴 억제 → 메뉴 렌더 → 클릭 → DELETE 흐름을 검증하려면 Playwright e2e 를 추가한다. 백엔드 독립(`page.route` mock), 시스템 Chrome. **선택 사항** — 핵심 흐름은 Task 1~3 의 jsdom 테스트가 이미 커버한다.

**Files:**
- Create: `frontend/tests/e2e/watchlist-context-menu.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// frontend/tests/e2e/watchlist-context-menu.spec.ts
//
// 실 dnd-kit 없는 우클릭 컨텍스트 메뉴 e2e: 행 우클릭 → 네이티브 메뉴 억제 →
// WatchlistRowMenu 렌더 → '관심 해제' 클릭 → DELETE /api/watchlist/{code} →
// 행 사라짐. 백엔드 독립(page.route mock), GET 은 stateful(삭제 반영).

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';

test.use({ channel: 'chrome' });   // 시스템 Chrome (live-smoke 와 동일 사유)

const API = 'http://localhost:8000';

interface Entry { code: string; name: string; registered_at_kst_date: string; last_success_date: string | null }
const ENTRIES: Entry[] = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260527', last_success_date: null },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260527', last_success_date: null },
];

test.describe('Watchlist Panel context menu', () => {
  test('right-click → 관심 해제 deletes via DELETE and the row disappears', async ({ page }) => {
    await installLiveMocks(page);

    let codes = ENTRIES.map((e) => e.code);
    let deleted: string | null = null;
    const entriesIn = (cs: string[]) => cs.map((c) => ENTRIES.find((e) => e.code === c)!);
    const json = (route: import('@playwright/test').Route, body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    await page.route(`${API}/api/live/quotes*`, (r) => json(r, { phase: 'open', quotes: [] }));
    // DELETE /api/watchlist/{code} → 204, stateful 제거. 등록 순서가 길어 GET 보다 먼저.
    await page.route(`${API}/api/watchlist/*`, async (route) => {
      if (route.request().method() === 'DELETE') {
        const code = route.request().url().split('/').pop()!;
        deleted = code;
        codes = codes.filter((c) => c !== code);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fallback();
    });
    await page.route(`${API}/api/watchlist`, (r) => json(r, { entries: entriesIn(codes), next_run_at_ms: 0 }));

    await page.goto('/live');
    // 관심종목 패널 열기
    const row = page.getByTestId('watchlist-row-005930');
    if (!(await row.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    }
    await expect(row).toBeVisible();

    await row.click({ button: 'right' });                       // 우클릭
    const menu = page.getByTestId('watchlist-row-menu');
    await expect(menu).toBeVisible();
    await page.getByTestId('watchlist-menu-remove').click();    // 관심 해제

    await expect.poll(() => deleted).toBe('005930');            // DELETE 발사
    await expect(page.getByTestId('watchlist-row-005930')).toHaveCount(0);  // refetch 후 행 사라짐
    await expect(menu).toHaveCount(0);                          // 메뉴 닫힘
  });
});
```

- [ ] **Step 2: Run it**

준비: e2e 백엔드(`HOGA_ENABLE_TEST_ENDPOINTS=1 HOGA_DATA_DIR=/tmp/hoga-e2e-data uv run hoga serve --port 8765`)와 프론트(`npm run dev`)를 띄우고(또는 playwright webServer 의 `reuseExistingServer` 에 맡기고), `E2E_BASE_URL` 을 본인 프론트 포트로 지정해 실행:

Run (from `frontend/`): `E2E_BASE_URL=http://localhost:<my-port> npx playwright test watchlist-context-menu.spec.ts --project=chromium --reporter=line`
Expected: 1 passed.

> 참고: 프론트 `config.json` api_url 이 `:8000` 이라 미목킹 시 *실제* :8000 백엔드를 건드린다 — 그래서 모든 엔드포인트를 `page.route` 로 가로채야 한다(위 spec 이 그렇게 함). 워크트리 2번째 프론트는 CORS 로 :8000 직결이 막히므로 `page.route` 목킹이 필수다(`reference_backend_cors_5173_only`).

- [ ] **Step 3: Commit**

```bash
git add frontend/tests/e2e/watchlist-context-menu.spec.ts
git commit -m "test(e2e): 관심종목 우클릭 컨텍스트 메뉴 해제 (선택 e2e)"
```

---

## Notes for the implementer

- **공유 `QuoteRow` 무영향 보장**: 새 props 는 전부 선택적. 스크리너 드로어/`WatchlistToggleButton` 은 미전달 → 기존 동작 동일(Task 4 의 full vitest 가 회귀 가드).
- **트래시 제거 = 의도된 변경**: hover 트래시 버튼을 없애고 삭제를 우클릭+Delete 로 일원화한다(spec Goals). `WatchlistDrawer` 의 `TrashIcon` import 와 트래시 테스트도 함께 제거.
- **self-close 레이스 없음**: `useDismissablePopover` 리스너는 메뉴 open *후* `useEffect` 에서 부착되므로, 여는 우클릭의 mousedown 은 잡히지 않는다.
- **우클릭 ≠ 드래그**: dnd-kit PointerSensor 는 `button !== 0` 가드라 우클릭은 드래그를 시작하지 않는다(추가 처리 불필요).
- **IDE squiggle 무시**: 신규 파일/심볼은 에디터 인덱스가 늦다 — 권위는 `npx tsc -b`/`npx vitest`.
