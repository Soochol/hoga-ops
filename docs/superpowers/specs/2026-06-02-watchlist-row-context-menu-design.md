# 관심종목 행 우클릭 컨텍스트 메뉴 — Design

**Date**: 2026-06-02 (via `/superpowers:brainstorming`)
**Status**: Draft
**Scope**: frontend only — `rightrail/QuoteRow.tsx`(선택적 `onContextMenu` prop), `watchlist/WatchlistRowMenu.tsx`(신규), `watchlist/WatchlistDrawer.tsx`(메뉴 상태·배선), 관련 테스트. **백엔드 무변경.**

## Problem

사용자 표현:

> "관심종목 (우측 패널)에서, 마우스 오른쪽 버튼 누르고 popover 나오게 해서 관심종목에서 삭제하도록 하고 싶어."

현재 **Watchlist Panel**(`WatchlistDrawer`)에서 종목을 해제하려면 행에 hover 해서 나타나는 휴지통 버튼을 눌러야 한다. 우클릭으로 빠르게 해제하는 경로가 없다. (사용자 mockup 이미지엔 `메모`·`관심 해제` 두 항목이 있었으나, **메모는 범위 밖** — 별도 사이클; 이번엔 우클릭 → popover → `관심 해제`만.)

## Invariants

- **`QuoteRow` 공유 static 행**: 관심종목 드로어·스크리너 드로어·워치리스트 토글이 공유하는 행. 워치리스트 전용 동작은 *선택적 prop*으로 주입하고 `QuoteRow`는 mode를 키우지 않는다. 근거: [ADR-0058](../../adr/0058-right-rail-row-composition.md), [QuoteRow.tsx](../../../frontend/src/rightrail/QuoteRow.tsx).
- **popover 닫힘 계약 단일화**: 떠 있는 affordance는 외부 `mousedown` 또는 Escape에 닫히고, 앵커 내부 mousedown엔 닫히지 않는다. 리스너는 `isOpen` 동안만 부착. 근거: [useDismissablePopover.ts](../../../frontend/src/util/useDismissablePopover.ts).
- **행 삭제 단일 경로**: 관심 해제는 `useRemoveFromWatchlist`(→ `DELETE /api/watchlist/{code}` → `['watchlist']` invalidate) 한 곳으로만 라우팅된다. 근거: [useWatchlist.ts](../../../frontend/src/watchlist/useWatchlist.ts), [WatchlistDrawer.tsx:99-107](../../../frontend/src/watchlist/WatchlistDrawer.tsx#L99-L107).
- **행 좌클릭 = 차트 점프**: `onClick` → `useJumpToLive`(activeCode SSOT). 우클릭은 이와 별개 버튼(좌/우)이라 충돌하지 않는다. 근거: [QuoteRow.tsx:21-26](../../../frontend/src/rightrail/QuoteRow.tsx#L21-L26).
- **행 드래그 재정렬**: PointerSensor(8px). 우클릭(button 2)은 드래그를 시작하지 않는다 — dnd-kit activator가 `button !== 0`을 가드. 근거: `@dnd-kit/core` PointerSensor.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| `QuoteRow` 공유 static 행 | preserves | `onContextMenu?`를 **선택적**으로 추가. 스크리너는 미전달 → 무영향. drag props와 동일한 ADR-0058 패턴. |
| popover 닫힘 계약 | preserves | 동일 `useDismissablePopover` 재사용. 리스너가 open *후* 부착돼, 여는 우클릭의 mousedown은 잡히지 않음(self-close 회피). |
| 행 삭제 단일 경로 | preserves | 메뉴의 `관심 해제`도 동일 `useRemoveFromWatchlist`(hover 트래시와 같은 mutation). |
| 좌클릭 = 점프 | preserves | 우클릭은 좌클릭과 별개. hover 트래시·키보드 점프 그대로. |
| 드래그 재정렬 | preserves | 우클릭은 드래그 미시작(`button!==0` 가드). |

*"intentionally breaks" 없음.* 순수 가산적 변경.

## Goals

- **Watchlist Panel** 행을 우클릭 → 커서 위치에 popover 메뉴 → **관심 해제**.
- 기존 hover 트래시(키보드/포커스 접근 삭제 경로)는 **유지** — 우클릭은 마우스 보조 경로로 *추가*만.
- 우측 끝 패널이라 메뉴가 화면 밖으로 넘치지 않게 뷰포트 클램프.
- 네이티브 우클릭 메뉴 억제, 외부클릭/Escape 닫기.

## Non-Goals (YAGNI)

- **메모(note)** — 종목별 메모 저장/편집. 백엔드 `WatchlistEntry.note` + GET/PUT + 편집 UI가 필요한 별도 기능. 이번 메뉴는 항목 추가가 쉬운 구조로만 둔다(메모 배선은 안 함).
- **제네릭 ContextMenu 추상화** — 소비자가 `WatchlistDrawer` 하나뿐(ADR-0058 "어댑터 1개 = 가설 seam"). 워치리스트 전용 메뉴 컴포넌트 하나만.
- **확인 다이얼로그** — 삭제는 hover 트래시처럼 즉시(되돌리려면 재추가). 일관성 유지.
- **hover 트래시 대체** — 키보드 접근 경로라 유지.
- 스크리너 드로어 우클릭 메뉴 — 이번 범위 아님.

## Design

### 1. `QuoteRow` — 선택적 `onContextMenu` prop

`frontend/src/rightrail/QuoteRow.tsx`의 `QuoteRowProps`에 추가(전부 선택적, drag props와 동일 패턴):

```ts
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
```

`<li>`에 `onContextMenu={onContextMenu}` 연결(나머지 본문·drag·onClick 불변). `SortableQuoteRow`는 `{...rowProps}`를 그대로 전달하므로 **래퍼 변경 불필요** — `onContextMenu`가 자동 전달된다. 스크리너는 미전달 → `undefined` → 네이티브 메뉴 그대로(무영향).

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

- 루트 `<div ref={menuRef} role="menu" style={{ position: 'fixed', left: x, top: y }}>` + 기존 메뉴 스타일(`bg-bg-card border border-border rounded shadow-lg z-30 py-1`, LiveDrawingMenu 참고).
- `useDismissablePopover(true, menuRef, onClose)` — 외부 mousedown/Escape 닫기.
- 항목 1개: `role="menuitem"` 버튼 **관심 해제**(`HeartIcon` — mockup과 일치) → `onRemove(); onClose();`. 항목을 배열/매핑 형태로 두어 추후 메모 추가가 한 줄이 되게 한다(단, 지금은 1개).
- `data-testid="watchlist-row-menu"`, 항목 `data-testid="watchlist-menu-remove"`.

### 3. `WatchlistDrawer` — 메뉴 상태 & 배선

```ts
const MENU_W = 160;   // 메뉴 추정 폭(px) — 클램프용
const MENU_H = 44;    // 1-항목 추정 높이(px)
const [menu, setMenu] = useState<{ x: number; y: number; code: string; name: string } | null>(null);

const openMenu = (e: React.MouseEvent, code: string, name: string) => {
  e.preventDefault();                                  // 네이티브 메뉴 억제
  const x = Math.min(e.clientX, window.innerWidth - MENU_W);
  const y = Math.min(e.clientY, window.innerHeight - MENU_H);
  setMenu({ x: Math.max(0, x), y: Math.max(0, y), code, name });
};
const closeMenu = () => setMenu(null);
```

각 행:

```tsx
<SortableQuoteRow
  /* ...기존 props... */
  onContextMenu={(e) => openMenu(e, entry.code, entry.name)}
/>
```

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
| 우측/하단 끝 오버플로 | `Math.min(clientX, innerWidth-MENU_W)` / y 동일, `Math.max(0,…)` |
| 메뉴 열린 채 다른 행 우클릭 | 외부 mousedown으로 기존 메뉴 닫힘 → 새 contextmenu가 해당 행에 다시 염(메뉴 이동) |
| 관심 해제 직후 | 행이 refetch로 사라짐, 메뉴 닫힘 |
| Escape | 닫힘(훅) |
| 빈/로딩/에러 상태 | 행이 없으니 우클릭 대상 없음 — 메뉴 상태 변화 없음 |

## Testing

- **`WatchlistRowMenu`** 단위 (`npx vitest`): ① 지정 x/y·`role=menu`로 렌더 ② "관심 해제" 클릭 → `onRemove`+`onClose` 호출.
- **`WatchlistDrawer`** (기존 `WatchlistDrawer.test.tsx` 하니스 재사용 — MemoryRouter+QueryClient, `getWatchlist`/`apiCall` mock):
  - `fireEvent.contextMenu(row)` → `watchlist-row-menu` 등장 + `preventDefault` 호출 검증.
  - 메뉴의 `관심 해제` 클릭 → `removeFromWatchlist`가 해당 code로 호출 + 메뉴 닫힘.
  - 기존 좌클릭(점프)·hover 트래시 테스트 회귀 없음(우클릭은 가산적).
- **게이트**: `npx tsc -b` + 변경파일 scoped eslint(0 에러) + `npx vitest run`.

## Open questions

없음.
