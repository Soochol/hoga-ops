# Global right rail — watchlist 

**Date:** 2026-05-30
**Status:** Draft
**Scope:** frontend

## Problem

관심종목(watchlist) 목록은 현재 두 곳에서만 닿을 수 있다:

- `/watchlist` 풀 페이지 ([frontend/src/watchlist/WatchlistPanel.tsx](../../../frontend/src/watchlist/WatchlistPanel.tsx)) — 검색/추가/삭제/즉시수집까지 갖춘 관리 화면.
- `/live` 전용 우측 드로어 ([frontend/src/live/WatchlistPanel.tsx](../../../frontend/src/live/WatchlistPanel.tsx)) — `LiveHeader`의 `★/☆` 버튼으로만 토글되는 **읽기 전용** 목록. 행을 클릭하면 `useLivePageStore.activeCode`를 세팅해 라이브 차트를 그 종목으로 바꾼다.

그래서 `/inventory`, `/capture`, `/settings` 같은 다른 페이지에서는 등록한 관심종목을 빠르게 훑어보거나 그 종목의 라이브 차트로 점프할 방법이 없다. 사용자 표현: *"전체 페이지에 대해서 우측에 사이드 패널 같은거 하나 만들고 싶어 … 옵션은 관심종목 1개만 추가."*

첨부된 참조 이미지는 우측 끝에 붙는 세로 아이콘 네비게이션 레일(내 투자 / 관심 / 최근 본 / 실시간)이지만, 이번 범위는 그 중 **관심 1개 항목**만 둔다.

## Invariants

이 spec이 건드리거나 이관하는 시스템이 **현재 보존하고 있는** 속성들:

- **Live activeCode-driven chart switch**: `/live`에서 관심종목 행을 클릭하면 `useLivePageStore.setActiveCode(code)`가 호출되어 라이브 차트가 그 Code로 전환된다. 근거: [frontend/src/live/WatchlistPanel.tsx:67](../../../frontend/src/live/WatchlistPanel.tsx) (`onClick={() => setActiveCode(entry.code)}`).
- **Watchlist panel open-state persistence**: 관심종목 패널의 열림 여부가 새로고침을 넘어 보존된다. 근거: [frontend/src/state/livePage.ts](../../../frontend/src/state/livePage.ts) — `watchlistPanelOpen`이 `Persisted`에 포함되어 localStorage에 기록된다.
- **Single watchlist data source**: 모든 관심종목 UI는 TanStack Query 키 `['watchlist']` 하나로 같은 데이터를 읽는다 (`getWatchlist`). 근거: [frontend/src/live/WatchlistPanel.tsx:15-19](../../../frontend/src/live/WatchlistPanel.tsx), [frontend/src/watchlist/useWatchlist.ts](../../../frontend/src/watchlist/useWatchlist.ts).
- **App shell flex-main**: App 셸은 좌측 고정폭 nav + `1fr` main 으로, 메인 콘텐츠가 남는 가로 공간을 모두 차지한다. 근거: [frontend/src/App.tsx:10](../../../frontend/src/App.tsx) (`grid-cols-[var(--nav-w)_1fr]`).
- **Panel-open ⟹ rail-expanded** (이 spec 신설): `panelOpen === true`이면 `railCollapsed === false`. 레일이 접히면 관심 토글이 보이지 않으므로, 패널이 열려 있는데 레일만 접힌 "고아 패널" 상태를 금지한다. 근거: 신규 `rightRail` 스토어가 양방향으로 강제 (아래 Design의 State store 절 참조).

## Invariant impact

| Invariant | 영향 | 비고 |
|---|---|---|
| Live activeCode-driven chart switch | preserves | 승격된 패널의 행 클릭이 `setActiveCode`를 그대로 호출한다. `/live`에서의 차트 전환 동작은 회귀 테스트로 고정한다. |
| Watchlist panel open-state persistence | preserves (이관) | 열림 상태 소유권이 `livePage` 스토어에서 신규 전역 `rightRail` 스토어로 옮겨가되, localStorage 영속화 자체는 유지된다. |
| Single watchlist data source | preserves | 승격된 패널도 `['watchlist']` 쿼리를 그대로 쓴다. 새 fetch 경로를 만들지 않는다. |
| App shell flex-main | preserves | 우측에 고정폭 레일(`--rail-w`) 컬럼을 추가해도 main은 여전히 `1fr`. 패널이 열리면 고정폭 패널 컬럼이 하나 더 끼지만 main은 `1fr`로 남는다. |
| Panel-open ⟹ rail-expanded | new (의도) | `rightRail` 스토어가 양방향 강제: 레일을 접으면 `panelOpen=false`, 패널을 열면 `railCollapsed=false`. 고아 패널 방지. |

의도적 변경(invariant 아님): `/live`의 `★/☆` 토글 버튼은 제거된다. 이는 동일한 "관심종목 패널 열기" 진입점을 전역 레일로 옮기는 것이며, 그 아래의 activeCode 동작(invariant)은 보존된다.

## Goals

- 모든 라우트(`/live`, `/inventory`, `/capture`, `/watchlist`, `/settings`) 공통으로 우측 끝에 세로 아이콘 레일이 보인다.
- 레일의 단일 항목 **관심(♥)** 클릭 시 좌측으로 읽기 전용 관심종목 패널이 열린다.
- 패널의 행 클릭은 어느 페이지에서든 해당 Code의 라이브 차트로 점프한다 (`/live`로 이동 + `activeCode` 세팅).
- 레일 접기/펴기 + 패널 열림 상태가 새로고침을 넘어 보존된다.
- 기존 `/live` 전용 드로어와 `★` 토글은 제거되고 전역 패널로 통합된다 — `/live`에서 관심종목 패널이 둘 보이지 않는다.

## Non-Goals

- `/watchlist` 풀 페이지(검색/추가/삭제/즉시수집)는 변경하지 않는다. 그대로 유지.
- 전역 패널 안에서의 추가/삭제/수집 — 읽기 전용 목록이다.
- 레일의 다항목화(내 투자 / 최근 본 / 실시간) — 관심 1개만.
- 아이콘 라이브러리 도입 — 인라인 SVG로 처리한다 (현 코드베이스에 아이콘 의존성 없음).
- 백엔드 변경 — 순수 프론트엔드.
- 모바일/반응형 레이아웃 — 데스크톱 전용 앱 기조 유지.

## Design

### Architecture

App 셸이 우측 레일 + 패널을 소유한다. 레일과 패널은 라우트와 무관하게 항상 마운트되며, 상태는 신규 전역 zustand 스토어 `rightRail`이 가진다. 패널 본문은 기존 `/live` 드로어 컴포넌트를 공용 위치로 **승격(promote)** 해 재사용한다 — 새 패널을 만들지 않는다.

```
App (shell)
 ├─ LeftNav                       (기존)
 ├─ <main><Outlet/></main>        (기존, 1fr)
 ├─ WatchlistDrawer  ← panelOpen일 때만, 고정폭 --watchlist-panel-w   (승격된 기존 컴포넌트)
 └─ RightRail        ← 항상, 고정폭 --rail-w (접히면 얇은 핸들)        (신규 chrome)

rightRail store: { panelOpen, railCollapsed, togglePanel, setPanelOpen, toggleRailCollapsed }
livePage store : activeCode (그대로 — live 도메인 개념)
```

설계 근거:

- **새 패널을 만들지 않는다.** 관심종목 패널 본문이 셋(`/watchlist` 풀 + live 드로어 + 신규)으로 갈라지면 곧 어긋난다. 전역 레일은 "새 shell 요소 + 새 진입점"이지 "새 패널 구현"이 아니다.
- **상태는 전역 스토어로.** 패널이 모든 페이지에 살므로 열림/접힘 상태는 live 페이지에 묶일 수 없다. `livePage`에서 `rightRail`로 이관한다. `activeCode`는 라이브 차트가 무엇을 그리는지를 뜻하는 live 도메인 상태이므로 `livePage`에 남긴다.
- **행 클릭은 단일 의도, 경로 가드 하나.** 항상 `setActiveCode(code)`를 호출하고, **현재 경로가 `/live`가 아닐 때만** `navigate('/live')`를 더한다. `/live`에서는 차트만 바뀌고(기존 동작과 동일), 다른 페이지에서는 라이브로 점프한다. 동일 경로 navigate를 아예 하지 않아 리렌더 위험이 없다.

### Layout (App shell grid)

[frontend/src/App.tsx](../../../frontend/src/App.tsx)의 그리드를 확장한다:

- 레일 펼침 · 패널 닫힘: `grid-template-columns: var(--nav-w) 1fr var(--rail-w)`
- 레일 펼침 · 패널 열림: `var(--nav-w) 1fr var(--watchlist-panel-w) var(--rail-w)`
- 레일 접힘 (패널은 강제 닫힘): `var(--nav-w) 1fr var(--rail-handle-w)`

`overflow-hidden h-screen` 등 기존 셸 속성은 유지한다. 패널은 레일의 **왼쪽**(메인과 레일 사이)에 끼며, 레일은 항상 가장 우측이다. **JSX 렌더 순서는 그리드 컬럼 순서와 일치**시킨다: `<LeftNav/>`, `<main>`, `<WatchlistDrawer/>`(panelOpen일 때만), `<RightRail/>`(항상). 어느 구성에서도 main 컬럼은 `1fr`로 유지되어 콘텐츠가 우측 chrome에 눌리지 않는다.

### RightRail (신규 `frontend/src/rightrail/RightRail.tsx`)

- 항상 보이는 얇은 세로 컬럼, 폭 `--rail-w`. 배경 `--bg-subtle`, 좌측 1px `--border` (LeftNav와 대칭).
- **상단 접기 셰브론**: 펼침 상태에서 `»`, 접힘 상태에서 `«`. 같은 버튼이며 클릭 시 `toggleRailCollapsed()`로 **양방향 토글**(접힘↔펼침)한다. 접히면 컬럼이 `--rail-handle-w`(≈12px) 핸들로 줄고, 그 핸들이 곧 `«` 셰브론이라 클릭하면 다시 펼쳐진다.
- **단일 항목 관심**: 인라인 SVG 하트 아이콘(위) + `관심` 라벨(아래) 세로 스택. 클릭 → `togglePanel()`.
  - active(=panelOpen) 시 `bg-tint-selection` + `text-fg`/`text-accent`, 비활성 시 `text-fg-dim` + hover `bg-bg-input-hover` — [frontend/src/nav/NavItem.tsx](../../../frontend/src/nav/NavItem.tsx) active 스타일 관례 재사용.
  - 접근성: `aria-pressed={panelOpen}`, `aria-controls`로 패널 id, `aria-label="관심종목 패널 토글"`.
- 접힘 상태에서는 관심 항목을 **렌더하지 않고**(미렌더 → 탭 순서에서도 제외) 핸들만 보인다. 따라서 "관심 토글이 안 보이는데 패널만 열림" 상태가 UI로는 발생할 수 없다. 키보드 단축키 등 비-UI 경로로 `setPanelOpen(true)`가 불릴 때는 스토어가 `railCollapsed=false`로 자동 펼쳐 불변식을 지킨다 (State store 참조).

### WatchlistDrawer (승격된 기존 컴포넌트)

[frontend/src/live/WatchlistPanel.tsx](../../../frontend/src/live/WatchlistPanel.tsx)를 `frontend/src/watchlist/WatchlistDrawer.tsx`로 이동하고 일반화한다 (이름은 풀 페이지 `watchlist/WatchlistPanel.tsx`와의 충돌을 피하려 `WatchlistDrawer`로 변경):

- 헤더 "관심종목" + 코드/종목명 행 목록 + 로딩/에러/빈 상태 — 현 구현 유지.
- 폭 `--watchlist-panel-w`(350px), 배경 `--bg-card`, 좌측 1px `--border` — 현 토큰 유지.
- 데이터: `useQuery({ queryKey: ['watchlist'], queryFn: getWatchlist })` 유지.
- **행 클릭 일반화**: 현재 `setActiveCode(entry.code)`만 호출 → `setActiveCode(entry.code)` 후, **현재 경로가 `/live`가 아닐 때만** `navigate('/live')` 호출. `useNavigate`+`useLocation`(react-router) 사용. `/live`에서는 navigate를 아예 건너뛰므로 동일 경로 재진입에 따른 리렌더/리셋 위험이 원천 차단되고, 기존 live 동작과 동일하다.
- **active 행 하이라이트**: `entry.code === activeCode` 기준. WatchlistDrawer는 **경로와 무관하게 항상** `useLivePageStore.activeCode`를 읽어 매칭 행을 강조한다(pathname 분기 없음). 비-live 페이지에서는 "마지막으로 라이브에서 본 종목"이 강조되며, 이는 single-source 불변식을 깨지 않는 의도된 동작이다.
- 패널 컨테이너에 `id`(예: `right-rail-watchlist-panel`)를 두어 레일 버튼의 `aria-controls`와 연결.

### State store (신규 `frontend/src/state/rightRail.ts`)

[frontend/src/state/livePage.ts](../../../frontend/src/state/livePage.ts)의 persist 패턴을 그대로 따른 작은 zustand 스토어:

```
Persisted = { panelOpen: boolean; railCollapsed: boolean }
DEFAULTS  = { panelOpen: false, railCollapsed: false }

togglePanel()              : panelOpen 토글. true가 되면 railCollapsed=false도 함께 set 후 persist.
setPanelOpen(open)         : 설정. open=true면 railCollapsed=false도 함께 set 후 persist.
toggleRailCollapsed()      : railCollapsed 토글. true가 되면 panelOpen=false도 함께 set 후 persist.
setRailCollapsed(collapsed): 설정. collapsed=true면 panelOpen=false도 함께 set 후 persist.
```

위 네 메서드의 동반 set이 *Panel-open ⟹ rail-expanded* 불변식을 양방향으로 강제한다. toggle+set 쌍을 둘 다 제공하는 것은 [livePage.ts](../../../frontend/src/state/livePage.ts)의 persisted boolean 관례(`toggleWatchlistPanel`+`setWatchlistPanelOpen`)와 일치한다.

localStorage 키는 `livePage`와 충돌하지 않는 별도 키(예: `rightRail.layout`).

### /live 통합 (대체)

다음을 제거/이관한다:

- [frontend/src/live/LiveHeader.tsx](../../../frontend/src/live/LiveHeader.tsx): `★/☆` 토글 버튼과 관련 store 구독 제거. 헤더는 제목만 남긴다.
- [frontend/src/live/LiveWorkarea.tsx](../../../frontend/src/live/LiveWorkarea.tsx): `WatchlistPanel` import 및 **두 군데**의 `{watchlistOpen && <WatchlistPanel/>}` 마운트(라인 46, 85)와 `watchlistOpen` 구독 제거. LiveSidebar는 그대로.
- [frontend/src/state/livePage.ts](../../../frontend/src/state/livePage.ts): `watchlistPanelOpen` / `toggleWatchlistPanel` / `setWatchlistPanelOpen`와 `DEFAULTS.watchlistPanelOpen`, `Persisted` 항목 제거 → `rightRail` 스토어로 이관.
- [frontend/src/live/useLiveKeyboard.ts](../../../frontend/src/live/useLiveKeyboard.ts): `store.toggleWatchlistPanel()` / `setWatchlistPanelOpen(false)` 호출을 `rightRail` 스토어의 `togglePanel()` / `setPanelOpen(false)`로 리포인트. **단축키 활성 범위는 변경 없음** — `useLiveKeyboard`는 `/live`에서만 동작하므로 패널 토글 단축키도 `/live` 한정이다(전역 토글 단축키는 backlog). `activeCode` 관련 키 동작은 livePage 그대로.
- 기존 `frontend/src/live/WatchlistPanel.tsx`와 `WatchlistPanel.test.tsx`는 `watchlist/WatchlistDrawer.tsx`(+`.test.tsx`)로 이동.

### 불변식 노트

이 절의 양방향 동반 set이 위 [Invariants](#invariants)의 *Panel-open ⟹ rail-expanded*를 구현한다. 별도 신설 불변식은 그곳과 Invariant impact 표에 정식 기재돼 있다.

### Design tokens

[frontend/src/styles/tokens.css](../../../frontend/src/styles/tokens.css)에 추가:

- `--rail-w`: 3rem (60px @ default 1.25× / 48px base intent) — 아이콘 레일 폭.
- `--rail-handle-w`: 0.6rem (12px @ default / 9.6px base) — 접힘 핸들 폭. (정확한 값은 design-review에서 조정 가능.)
- `--watchlist-panel-w`(350px)는 기존 값 재사용. DESIGN.md 주석을 "Live page" 한정에서 "전역 우측 패널"로 일반화.

DESIGN.md의 Layout/토큰 섹션과 Decisions Log에 우측 레일을 한 줄로 기록한다 (grill 단계에서 ADR 필요 여부 판단).

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 관심 토글 → 패널 열림 | RightRail 렌더, panelOpen=false | 관심 클릭 시 `togglePanel` 호출, 패널(`right-rail-watchlist-panel`) 표시 |
| 관심 토글 → 패널 닫힘 | panelOpen=true | 관심 재클릭 시 패널 숨김, 버튼 `aria-pressed=false` |
| 셰브론 → 레일 접힘 | railCollapsed=false | 셰브론 클릭 시 `railCollapsed=true`, 핸들만 표시 |
| 접힘이 패널을 닫음 (불변식) | panelOpen=true, railCollapsed=false | `toggleRailCollapsed()` 후 panelOpen=false |
| 패널 열기 시 레일 자동 펼침 (불변식) | railCollapsed=true | `setPanelOpen(true)` 후 railCollapsed=false + 패널 표시 |
| Grid main 1fr 유지 | railCollapsed=false, panelOpen=true | App `grid-template-columns`의 가운데 트랙이 `1fr` |
| 상태 영속화 | togglePanel / toggleRailCollapsed 호출 | localStorage(`rightRail.layout`)에 기록, 재마운트 시 복원 |
| 행 클릭(비-live) | `/inventory`에서 패널 렌더, 행 클릭 | `setActiveCode(code)` 호출 + `navigate('/live')` 호출 |
| 행 클릭(/live) | `/live`에서 행 클릭 | `setActiveCode(code)` 호출, `navigate` 미호출(경로 동일) |
| active 행 하이라이트(/live) | activeCode='005930' | 005930 행에 `aria-current`/selection tint |
| active 행 하이라이트(비-live) | `/inventory`, activeCode='005930' | 005930 행이 경로와 무관하게 강조됨 |
| 빈/로딩/에러 상태 | 쿼리 상태 모킹 | 기존 메시지 그대로 표시 |

**Invariant 회귀 테스트**:
- *Live activeCode-driven chart switch*: `/live`에서 WatchlistDrawer 행 클릭 → `setActiveCode`가 호출되는지 (`★` 토글 제거 후에도 차트 전환 경로 유지).
- *Watchlist panel open-state persistence*: `togglePanel` 후 localStorage에 반영 + 재마운트 복원.
- *Single watchlist data source*: 드로어가 `['watchlist']` 쿼리를 사용하는지 (별도 fetch 경로 부재).
- *App shell flex-main*: RightRail + WatchlistDrawer 마운트 후에도 App의 main 컬럼이 `1fr`인지 (`grid-template-columns`의 가운데 트랙 유지).
- *Panel-open ⟹ rail-expanded*: `setPanelOpen(true)`가 `railCollapsed`를 false로, `toggleRailCollapsed()`가 접을 때 `panelOpen`을 false로 만드는지 (양방향).

### Manual verification

- `/inventory`(또는 `/capture`, `/settings`)에서 우측 레일 관심 클릭 → 패널 열림 → 행 클릭 시 `/live`로 이동하며 해당 종목 차트가 뜬다.
- `/live`에서 헤더에 `★` 버튼이 없고, 우측 레일 패널의 행 클릭으로 차트가 바뀐다 (패널은 하나만).
- 레일 셰브론으로 접기/펴기, 새로고침 후 상태(접힘/열림) 유지.
- 기존 `useLiveKeyboard` 단축키로 패널이 토글된다.

## Risks / Open questions

- **state 소유권 이관 vs 유지**: 리뷰에서 "`watchlistPanelOpen`을 `livePage`에 그대로 두고 App에서 마운트만"하는 대안(파일 변경 수 감소)이 제기됐다. 그러나 전역 패널의 열림 상태를 *페이지 전용* 스토어에 두는 것은 도메인 경계 위반이라, 전용 `rightRail` 스토어로의 이관을 택한다. 이관 시 localStorage 키 충돌·hydrate 순서만 주의한다 (별도 키 `rightRail.layout`).
- **`navigate('/live')`**: 동일 경로 재진입 위험은 Design의 "경로가 `/live`가 아닐 때만 navigate" 조건으로 이미 차단했다. 구현 시 `useLocation().pathname` 비교만 정확히 두면 된다.
- **레일 폭/핸들 정확 수치**: `--rail-w`, `--rail-handle-w` 값은 design-review에서 시각 조정.
- **하트 아이콘 vs 별 아이콘**: 참조 이미지는 하트(관심), 기존 live 토글은 `★`. 하트로 통일 제안하되 design-review에서 확정.
- **단축키 충돌**: `useLiveKeyboard`는 `/live`에서만 활성인데 패널은 전역이다. 전역 토글 단축키가 필요한지(다른 페이지에서도)는 backlog.

## Out of Scope (Backlog)

- 레일 다항목화(내 투자 / 최근 본 / 실시간).
- 전역 패널에서의 관심종목 추가/삭제(읽기 전용 → 편집 가능 승격).
- `/watchlist` 풀 페이지와 드로어의 완전 통합(공통 행 컴포넌트 추출 등).
- 전역(비-live 포함) 패널 토글 단축키.
- 반응형/모바일 레이아웃.
