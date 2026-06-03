# 관심종목 행 우클릭 컨텍스트 메뉴 — Design

**Date**: 2026-06-02 (via `/superpowers:brainstorming`)
**Status**: Draft
**Scope**: frontend only — `rightrail/QuoteRow.tsx`(선택적 `onContextMenu`·`onDelete` prop), `watchlist/WatchlistRowMenu.tsx`(신규), `watchlist/WatchlistDrawer.tsx`(hover 트래시 제거 + 우클릭 메뉴·Delete 키 배선), 관련 테스트. **백엔드 무변경.**

## Problem

사용자 표현:

> "관심종목 (우측 패널)에서, 마우스 오른쪽 버튼 누르고 popover 나오게 해서 관심종목에서 삭제하도록 하고 싶어."

현재 **Watchlist Panel**(`WatchlistDrawer`)에서 종목을 해제하려면 행에 hover 해서 나타나는 휴지통 버튼을 눌러야 한다. 우클릭으로 빠르게 해제하는 경로가 없다. (사용자 mockup 이미지엔 `메모`·`관심 해제` 두 항목이 있었으나, **메모는 범위 밖** — 별도 사이클; 이번엔 우클릭 → popover → `관심 해제`만.)

## Invariants

- **`QuoteRow` 공유 static 행**: 관심종목 드로어·스크리너 드로어·워치리스트 토글이 공유하는 행. 워치리스트 전용 동작은 *선택적 prop*으로 주입하고 `QuoteRow`는 mode를 키우지 않는다. 근거: [ADR-0058](../../adr/0058-right-rail-row-composition.md), [QuoteRow.tsx](../../../frontend/src/rightrail/QuoteRow.tsx).
- **popover 닫힘 계약 단일화**: 떠 있는 affordance는 외부 `mousedown` 또는 Escape에 닫히고, 앵커 내부 mousedown엔 닫히지 않는다. 리스너는 `isOpen` 동안만 부착. 근거: [useDismissablePopover.ts](../../../frontend/src/util/useDismissablePopover.ts).
- **행 삭제 단일 경로**: 트리거(우클릭 메뉴 / `Delete`·`Backspace` 키)가 무엇이든 관심 해제는 `useRemoveFromWatchlist`(→ `DELETE /api/watchlist/{code}` → `['watchlist']` invalidate) 한 mutation으로만 라우팅된다. 근거: [useWatchlist.ts](../../../frontend/src/watchlist/useWatchlist.ts).
- **행 좌클릭 = 차트 점프**: `onClick` → `useJumpToLive`(activeCode SSOT). 우클릭은 이와 별개 버튼(좌/우)이라 충돌하지 않는다. 근거: [QuoteRow.tsx:21-26](../../../frontend/src/rightrail/QuoteRow.tsx#L21-L26).
- **행 드래그 재정렬**: PointerSensor(8px). 우클릭(button 2)은 드래그를 시작하지 않는다 — dnd-kit activator가 `button !== 0`을 가드. 근거: `@dnd-kit/core` PointerSensor.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| `QuoteRow` 공유 static 행 | preserves | `onContextMenu?`·`onDelete?`를 **선택적**으로 추가. 스크리너는 미전달 → 무영향. drag props와 동일한 ADR-0058 패턴. |
| popover 닫힘 계약 | preserves | 동일 `useDismissablePopover` 재사용. 리스너가 open *후* 부착돼, 여는 우클릭의 mousedown은 잡히지 않음(self-close 회피). |
| 행 삭제 단일 경로 | preserves | 우클릭 메뉴·`Delete` 키 둘 다 동일 `useRemoveFromWatchlist`로 라우팅(트리거만 늘고 mutation은 하나). |
| 좌클릭 = 점프 | preserves | 우클릭(메뉴)·`Delete`(삭제)는 좌클릭/Enter/Space(점프)와 별개 버튼·키. |
| 드래그 재정렬 | preserves | 우클릭은 드래그 미시작(`button!==0` 가드). |

**의도적 변경 1건**: hover 트래시 버튼을 제거하고 삭제 트리거를 우클릭 메뉴 + `Delete` 키로 일원화한다. 키보드 삭제 경로는 `Delete`로 보존되므로 a11y 회귀가 아니다. 그 외 불변량은 모두 보존.

## Goals

- **Watchlist Panel** 행을 우클릭 → 커서 위치에 popover 메뉴 → **관심 해제**.
- 기존 hover 트래시 버튼은 **제거** — 관심 해제를 우클릭(마우스)으로 일원화하고 행을 깔끔하게 한다.
- **키보드 안전망**: 포커스된 행에서 `Delete`/`Backspace` → 즉시 관심 해제(우클릭은 마우스 전용이라 키보드 동등 경로를 둬 a11y 회귀 방지). 메모가 붙으면 키보드 경로를 "Menu 키 → 메뉴 열기"로 승격(추후).
- 우측 끝 패널이라 메뉴가 화면 밖으로 넘치지 않게 (렌더 후 실측) 클램프.
- 네이티브 우클릭 메뉴 억제, 외부클릭/Escape 닫기.

## Non-Goals (YAGNI)

- **메모(note)** — 종목별 메모 저장/편집. 백엔드 `WatchlistEntry.note` + GET/PUT + 편집 UI가 필요한 별도 기능. 이번 메뉴는 항목 추가가 쉬운 구조로만 둔다(메모 배선은 안 함).
- **제네릭 ContextMenu 추상화** — 소비자가 `WatchlistDrawer` 하나뿐(ADR-0058 "어댑터 1개 = 가설 seam"). 워치리스트 전용 메뉴 컴포넌트 하나만.
- **확인 다이얼로그** — 삭제는 즉시(되돌리려면 재추가). 단일 사용자 도구라 마찰 최소화.
- **키보드 메뉴 전체 탐색**(arrow-nav / roving tabindex) — 항목 1개라 불필요. 키보드 삭제는 `Delete` 직접 경로로 충분(메모 추가 시 Menu 키로 메뉴 열기 승격).
- 스크리너 드로어 우클릭 메뉴 — 이번 범위 아님.

## Design

### 1. `QuoteRow` — 선택적 `onContextMenu` + `onDelete` prop

`frontend/src/rightrail/QuoteRow.tsx`의 `QuoteRowProps`에 추가(전부 선택적, drag props와 동일 ADR-0058 패턴):

```ts
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
  onDelete?: () => void;   // Delete/Backspace on the focused row → 호출(워치리스트 전용)
```

`<li>`에 `onContextMenu={onContextMenu}` 연결. 기존 내부 `onKeyDown`(Enter/Space → onClick)에 Delete 분기를 *합성*한다 — 의도-드러내는 `onDelete` prop으로만 노출(키 핸들링 내부는 안 샘):

```ts
const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
  if (e.target !== e.currentTarget) return;          // 중첩 요소 keydown 무시(기존 가드)
  if (onDelete && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault(); onDelete(); return;
  }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
};
```

`SortableQuoteRow`는 `{...rowProps}`를 그대로 전달하므로 **래퍼 변경 불필요** — `onContextMenu`·`onDelete`가 자동 전달된다. 스크리너는 둘 다 미전달 → 네이티브 메뉴 그대로 + Delete 무동작(무영향).

### 2. `WatchlistRowMenu` — 커서 앵커 메뉴 (신규)

`frontend/src/watchlist/WatchlistRowMenu.tsx`. props:

```ts
interface Props {
  x: number;          // 클램프된 뷰포트 좌표
  y: number;
  name: string;       // 접근성 라벨용
  onRemove: () => void;
  onClose: () => void;
}
```

- **렌더 후 실측 위치 보정**(매직넘버 없음): props의 raw 커서 `(x,y)`로 일단 렌더하되, `useLayoutEffect`에서 자기 `getBoundingClientRect()`를 읽어 우/하단 오버플로를 보정한 `pos`로 재배치(paint 전 동기 → 깜빡임 없음, 항목 수 무관).

  ```ts
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = menuRef.current; if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width  > window.innerWidth  ? Math.max(0, window.innerWidth  - width)  : x;
    const top  = y + height > window.innerHeight ? Math.max(0, window.innerHeight - height) : y;
    setPos({ left, top });
  }, [x, y]);
  ```
- 루트 `<div ref={menuRef} role="menu" onContextMenu={(e) => e.preventDefault()} style={{ position: 'fixed', left: pos.left, top: pos.top }}>` + 기존 메뉴 스타일(`bg-bg-card border border-border rounded shadow-lg z-30 py-1`, LiveDrawingMenu 참고). (메뉴 위 우클릭 → 네이티브 메뉴 억제.)
- `useDismissablePopover(true, menuRef, onClose)` — 외부 mousedown/Escape 닫기.
- **항목은 배열을 순회**(메모는 mockup에 이미 있는 *확정된 2번째 항목*이라 list 구조를 선반영). 내부에서 빌드:

  ```ts
  type MenuItem = { key: string; label: string; icon: React.ReactNode; onClick: () => void };
  const items: MenuItem[] = [
    { key: 'remove', label: '관심 해제', icon: <HeartIcon filled className="w-[1em] h-[1em]" />,
      onClick: () => { onRemove(); onClose(); } },
    // 추후: { key: 'memo', label: '메모', icon: <NoteIcon/>, onClick: () => { onMemo!(); onClose(); } }  (onMemo prop 추가 시 한 줄)
  ];
  ```

  각 항목은 `role="menuitem"` 버튼으로 렌더(`HeartIcon` — mockup과 일치). 지금 prop은 `{x,y,name,onRemove,onClose}`만 — 메모가 실제로 올 때 `onMemo?`를 추가한다(미사용 prop 선반영 안 함). 즉 *렌더 루프*만 일반화하고 *prop 표면*은 현재 항목에 맞춘다.
- `data-testid="watchlist-row-menu"`, 항목 `data-testid={`watchlist-menu-${item.key}`}` (예: `watchlist-menu-remove`).

### 3. `WatchlistDrawer` — 메뉴 상태 & 배선

```ts
const [menu, setMenu] = useState<{ x: number; y: number; code: string; name: string } | null>(null);

const openMenu = (e: React.MouseEvent, code: string, name: string) => {
  e.preventDefault();                                  // 네이티브 메뉴 억제
  setMenu({ x: e.clientX, y: e.clientY, code, name }); // raw 커서 좌표 — 클램프는 메뉴가 실측 후 자체 처리
};
const closeMenu = () => setMenu(null);
```

각 행 — **기존 `trailingAction`(hover 트래시 버튼)을 제거**하고 우클릭+Delete를 추가:

```tsx
<SortableQuoteRow
  key={entry.code} code={entry.code}
  name={entry.name} price={...} pct={...} changeWon={...}
  active={entry.code === activeCode}
  ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
  testId={`watchlist-row-${entry.code}`}
  onClick={() => onPick(entry.code)}
  onContextMenu={(e) => openMenu(e, entry.code, entry.name)}
  onDelete={() => removeM.mutate(entry.code)}
  /* trailingAction 없음 — 트래시 제거 */
/>
```

`TrashIcon` import도 제거(WatchlistDrawer에서 다른 사용처 없음). 행에 trailing 요소가 없어 더 깔끔해진다.

메뉴 렌더(드로어 루트 내, 행 루프 밖):

```tsx
{menu && (
  <WatchlistRowMenu
    x={menu.x} y={menu.y} name={menu.name}
    onRemove={() => removeM.mutate(menu.code)}
    onClose={closeMenu}
  />
)}
```

`removeM`은 기존 `useRemoveFromWatchlist`(hover 트래시와 동일). 삭제 성공 시 `['watchlist']` invalidate → 행 사라짐. 메뉴는 `onRemove` 직후 `onClose`로 닫는다.

## Edge cases

| 상황 | 처리 |
|------|------|
| 네이티브 우클릭 메뉴 | `e.preventDefault()` |
| 우클릭이 드래그 시작? | PointerSensor `button!==0` 가드 → 무시 |
| 여는 우클릭이 메뉴 self-close? | `useDismissablePopover` 리스너가 open 후 부착 → 회피 |
| 우측/하단 끝 오버플로 | `WatchlistRowMenu`가 `useLayoutEffect` 실측으로 클램프(매직넘버 없음, 항목 수 무관) |
| 메뉴 열린 채 다른 행 우클릭 | 외부 mousedown으로 기존 메뉴 닫힘 → 새 contextmenu가 해당 행에 다시 염(메뉴 이동) |
| 관심 해제 직후 | 행이 refetch로 사라짐, 메뉴 닫힘 |
| 포커스 행에서 Delete/Backspace | `onDelete` → `removeM`로 즉시 해제(메뉴 없이) |
| 메뉴 위 우클릭 | 메뉴 루트 `onContextMenu preventDefault`로 네이티브 메뉴 억제 |
| Escape | 닫힘(훅) |
| 빈/로딩/에러 상태 | 행이 없으니 우클릭 대상 없음 — 메뉴 상태 변화 없음 |

## Testing

- **`WatchlistRowMenu`** 단위 (`npx vitest`): ① 지정 x/y·`role=menu`로 렌더 ② "관심 해제"(`watchlist-menu-remove`) 클릭 → `onRemove`+`onClose` 호출.
- **`WatchlistDrawer`** (기존 `WatchlistDrawer.test.tsx` 하니스 재사용 — MemoryRouter+QueryClient, `getWatchlist`/`apiCall` mock):
  - `fireEvent.contextMenu(row)` → `watchlist-row-menu` 등장 + `preventDefault` 호출 검증.
  - 메뉴의 `관심 해제` 클릭 → `removeFromWatchlist`가 해당 code로 호출 + 메뉴 닫힘.
  - 포커스된 행에서 `Delete` keydown → `removeFromWatchlist`가 해당 code로 호출(메뉴 없이).
  - 좌클릭(점프)·드래그 재정렬 기존 테스트 회귀 없음.
  - **기존 `'clicking a row trash icon removes it'` 테스트 제거** — 트래시 affordance가 사라졌으므로. 위 우클릭/Delete 테스트가 삭제 경로를 대체 검증한다.
- **실 포인터/레이아웃 한계**: jsdom은 `getBoundingClientRect`가 0이라 `useLayoutEffect` 클램프를 실측하지 못한다(메뉴는 raw 좌표로 렌더). 우클릭 위치 보정은 e2e/수동 영역(ADR-0057과 동일한 분리).
- **게이트**: `npx tsc -b` + 변경파일 scoped eslint(0 에러) + `npx vitest run`.

## Open questions

없음.
