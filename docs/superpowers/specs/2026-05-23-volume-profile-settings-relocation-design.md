# Volume Profile 모드 토글을 Settings 모달로 이전

**Date:** 2026-05-23
**Status:** Design approved, ready for implementation plan
**Scope:** Frontend UI — `frontend/src/sidebar/CursorSidebar.tsx`, `frontend/src/replay/SettingsModal.tsx`, and related component tests.

## Problem

오늘 Volume Profile 범위 선택(`전체`/`일별`)은 사이드바 우측 상단 `header` 슬롯에 별도 세그먼트로 떠 있다 (`CursorSidebar.tsx:42-71`의 `VolumeProfileModeToggle`). 다른 차트 표시 옵션은 모두 Settings 모달의 "차트" 카테고리(`SettingsModal.tsx`)에 모여 있어 일관성이 깨진다.

이 spec은 토글을 Settings → "차트" 카테고리로 옮기고, 사이드바에서는 header 슬롯 자체를 제거해 10호가/거래원/체결 3-카드 레이아웃만 남기는 변경을 정의한다.

## Goal

- Volume Profile 범위 선택의 단일 진입점을 Settings 모달로 옮긴다.
- 사이드바의 시각 잡음을 줄이고 3-카드 그리드로 단순화한다.
- 스토어/오버레이/액션은 건드리지 않는다. UI 표면만 이동한다.

## Non-Goals

- `useTabsStore.setVolumeProfileMode` 액션 또는 `ChartViewPrefs.volumeProfileMode` 필드 변경.
- `VolumeProfileOverlay` 동작 또는 `ChartPrefsContext` 변경.
- 키보드 단축키 추가.
- "오버레이" 같은 새 Settings 카테고리 신설.

## Architecture (변경 없음)

데이터 흐름은 그대로 유지된다.

```
prefs.volumeProfileMode  ←──  setVolumeProfileMode(tabId, mode)
        │
        ├──→ VolumeProfileOverlay (ChartPrefsContext 통해)
        └──→ Settings UI 컨트롤 (직접 store 읽기)
```

이전에는 두 번째 화살표가 `CursorSidebar`의 `VolumeProfileModeToggle`을 가리켰다. 이 spec 이후로는 `SettingsModal`의 차트 카테고리 본문 안에 위치한 세그먼트 컨트롤을 가리킨다.

## Component Changes

### `frontend/src/sidebar/CursorSidebar.tsx` — 삭제 위주

1. `VolumeProfileModeToggle` 함수 컴포넌트(L42-71) 통째로 삭제.
2. `CursorSidebarConnected`에서 `header={<VolumeProfileModeToggle />}` prop 제거 (L34).
3. dumb `CursorSidebar`의 props에서 `header?: ReactNode` 필드 제거. JSX의 `{header}` 슬롯 제거.
4. 조건부 grid를 단일 분기로 단순화: 항상 `grid-rows-[2fr_1fr_1fr]` 사용.
5. 미사용 임포트 정리 (`useTabsStore`가 다른 곳에서 쓰이지 않으면 제거).

### `frontend/src/replay/SettingsModal.tsx` — 추가

1. "차트" 카테고리 본문(L132-150 `CHART_TOGGLES.map` 블록 직후)에 세그먼트 컨트롤 행 한 개 추가.
2. 새 작은 컴포넌트 `VolumeProfileModeRow` (같은 파일 안)를 도입하고 `ToggleRow`와 동일한 좌-라벨 / 우-컨트롤 레이아웃을 따른다.
   - 좌측: 라벨 "Volume Profile" + 부제 "전체 기간 합산 / 날짜별 분리"
   - 우측: `[전체 | 일별]` 세그먼트 버튼 (기존 사이드바 토글의 시각 토큰 재사용 — 활성 `bg-accent text-accent-fg`, 비활성 `text-fg-dim hover:text-fg`).
   - **카피 결정 근거 (grilling Q1):** "범위"라는 단어는 `CONTEXT.md`의 _Avoid_ 목록 — **Stock-Date Range** / Data Window range / capture loop range와 충돌. 토글 버튼이 이미 "전체"/"일별"로 의미를 드러내므로 라벨은 무엇(What)만, 부제는 두 모드의 차이를 한 줄로 — 모두 "범위" 단어 회피.
3. `aria-pressed`로 현재 모드 반영, `aria-label="Volume Profile"` (그룹) + 버튼별 `aria-label`은 "전체"/"일별".
4. 컨트롤 그룹에 `data-testid="settings-volume-profile-mode"` 부여 (이전 사이드바의 `volume-profile-mode-toggle`은 사라진다 — 의도된 ID 교체). **명명 근거 (grilling Q3):** Settings 컨텍스트를 prefix로 명시해 미래 충돌 회피, 컨트롤 형태(segment/toggle/select)는 ID에 박지 않음 (형태 변경 시 testid 재이주 회피).
5. 컴포넌트 내부에서 `useTabsStore`로 `activeTabId`, `getPrefs(activeTabId).volumeProfileMode`, `setVolumeProfileMode`를 구독한다 — `SettingsModal`의 기존 패턴(`prefs`, `setToggle`)과 동일.

### 시각 배치 (Settings → 차트)

```
┌──────────────────────────────────────┐
│ 차트                                  │  ← h3
├──────────────────────────────────────┤
│ [기존 CHART_TOGGLES 행들…]            │
│                                      │
│ Volume Profile 범위                   │  ← 라벨
│ 누적 기준 선택                         │  ← 부제
│                          [전체|일별]  │  ← 우측 정렬 세그먼트
└──────────────────────────────────────┘
```

## Tests

### 변경 없음
- `frontend/src/state/tabs.test.ts` — 스토어 표면 유지.
- `frontend/tests/component/VolumeProfileOverlay.test.tsx` — `ChartPrefsProvider`로 prefs 주입 중.
- `frontend/tests/e2e/*` — `volume-profile-mode-toggle` testid 무참조.

### 신규 케이스

**`frontend/src/replay/SettingsModal.test.tsx`** — Settings 안의 세그먼트 동작 검증:
1. "Volume Profile 세그먼트가 현재 `prefs.volumeProfileMode`를 `aria-pressed`로 반영한다" — 초기값 `range`에서 "전체" 버튼만 pressed.
2. "세그먼트 클릭이 `setVolumeProfileMode(activeTabId, 'per-day')`를 호출하고 후속 렌더가 `aria-pressed`를 갱신한다."

**`frontend/tests/component/CursorSidebar.test.tsx`** — 사이드바 회귀 보호 (grilling Q2):
3. "renders without a header row — 3-row grid only, no `volume-profile-mode-toggle` testid present" — 사이드바가 우발적으로 옛 토글을 다시 마운트하지 않도록 잠금.

이 회귀 케이스는 `CursorSidebar.test.tsx`에 둬야 의미가 있다 — `Workarea.test.tsx`는 `CursorSidebar`를 mock하므로 헤더 부재를 검증할 수 없다.

### 무관 (변경 없음 확인)
`frontend/tests/e2e/`와 `frontend/tests/component/Workarea.test.tsx` 둘 다 `volume-profile-mode-toggle` testid를 어설션하지 않음 (사전 grep 결과). 추가 정리 불필요.

## Risks & Mitigation

- **사이드바 grid 변경 시 카드 비율 변경 위험** — 항상 `2fr 1fr 1fr`이 되도록 단일 분기로 정리하면 `header` 슬롯이 있을 때의 `auto_2fr_1fr_1fr`와 동일한 본문 비율이 유지된다.
- **사용자 발견성 저하** — 사이드바에서 한 클릭에 닿던 컨트롤이 Settings 모달 안으로 들어간다. 이는 의도된 트레이드오프(일관성 우선). 모드를 자주 바꾸는 작업은 추후 단축키로 보완 가능 (별도 작업).
- **testid 교체로 인한 외부 의존 깨짐** — repo 내부 grep으로 무참조 확인됨. 외부 자동화가 있다면 PR 메시지에서 알린다.

## Rollout

단일 PR. spec 승인 후 `superpowers:writing-plans`로 구현 계획을 작성하고, 같은 worktree에서 실행한다.

## Out of Scope (별도 작업)

- 10호가/거래원/체결 카드에 데이터가 표시되지 않는 이슈 — `superpowers:systematic-debugging`으로 별도 세션에서 처리.
