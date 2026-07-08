# Session Tape + TotalQtyBar 토큰화 — Design

**Date:** 2026-07-08
**Branch:** `claude/signature-components-live`
**Follow-up to:** PR #473 (상업화 듀얼 테마)

## Context

PR #473이 Obsidian/Ledger 듀얼 테마를 도입했다. 승인된 목업의 "시그니처 컴포넌트" 3종(세션 테이프, 하단 상태 바, 호가 균형 게이지)을 후속으로 검토한 결과:

- **호가 균형 게이지** = 이미 존재 (`sidebar/TotalQtyBar.tsx`). 단 색이 하드코딩된 구 팔레트라 **Ledger 라이트 테마에서 깨진다**(신규 기능 아님, 실제 버그).
- **하단 상태 바** = 기존 `LiveStatusBar`와 상당 중복 → 이번 범위 제외.
- **세션 테이프** = 유일한 진짜 신규 시그니처 요소.

따라서 이 작업의 범위는 **① TotalQtyBar 색 토큰화(버그 수정) + ② 세션 테이프 간단형**이다. `/study` 리플레이 스크러버는 별도 후속(새 store + 클릭 인터랙션 필요).

## ① TotalQtyBar 색 토큰화

`sidebar/TotalQtyBar.tsx:25-27`의 하드코딩 3색을 토큰 기반으로 교체:

- `ASK_FILL 'rgba(37,99,235,0.55)'` → `color-mix(in srgb, var(--price-down) 55%, transparent)`
- `BID_FILL 'rgba(220,38,38,0.55)'` → `color-mix(in srgb, var(--price-up) 55%, transparent)`
- `HAIRLINE 'rgba(255,255,255,0.18)'` → `var(--border-strong)`

DOM inline style이라 `color-mix(var(--…))`로 즉시 테마 추종(canvas 아님 → 지연 해석 불필요). 구 팔레트 hex(2563EB/DC2626)를 새 팔레트(F04452/3485FA)로 자동 정합하는 부수 효과도 있다.

## ② 세션 테이프 (간단형)

### 위치
`/live` 전용. `LivePage` 그리드 최상단에 3px 행 추가(LiveHeader 위 — 목업의 "내비 아래" 의도 재현). `/study`는 과거 복기라 실시간 "지금" 플레이헤드가 무의미 → 제외(스크러버 후속과 일관).

### 표시
- 09:00→15:30 정규장을 트랙으로, `fillPct = clamp((now-open)/(close-open))` 채움.
- `--accent` 플레이헤드 점을 `headPct` 위치에.
- 동시호가 경계(09:10 open+10m, 15:20 close-10m) `--border-strong` 눈금 2개.

### 데이터
- `regularSessionOpenMs(yyyymmdd)` / `regularSessionCloseMs(yyyymmdd)` — `live/liveDateTime.ts` (기존).
- 오늘 KST 날짜 — `realMsToYyyymmdd` (기존).
- 장 단계 참고 — `live/liveVenuePolicy.ts` `isKrxRegularSessionNow` (기존).

### 실시간 틱
신규 `util/useNowMs.ts` — `useNowMs(intervalMs = 1000)`가 `setInterval`로 `Date.now()`를 state에 갱신, 언마운트 시 clear. 순수 훅, fake-timers로 테스트.

### 상태 처리 (`live/sessionProgress.ts`, 순수 함수)
`sessionProgress(nowMs, openMs, closeMs)` → `{ fillPct, headPct, phase }`:
- `phase: 'pre' | 'in' | 'post'` (openMs 전 / 사이 / closeMs 후).
- pre: fillPct 0, headPct 0. in: 0<x<1. post: fillPct 1, headPct 1.
- 주말/휴일(호출부가 세션 없음으로 판단 시)엔 컴포넌트가 트랙만 그리고 플레이헤드 숨김.

### 테마 · 모션
- 색 전부 토큰(`--accent`/`--border`/`--border-strong`) → Obsidian 브래스·Ledger 초록 자동.
- 플레이헤드 미세 pulse(2.4s), `@media (prefers-reduced-motion: reduce)` 존중.

## 파일

- 신규: `frontend/src/live/SessionTape.tsx`, `frontend/src/live/sessionProgress.ts` (+`.test.ts`), `frontend/src/util/useNowMs.ts` (+`.test.ts`)
- 수정: `frontend/src/live/LivePage.tsx` (그리드 행 추가 + SessionTape 마운트), `frontend/src/sidebar/TotalQtyBar.tsx` (색 토큰화)

## 테스트

1. `sessionProgress` — pre/in/post, 경계값(정확히 open·close), 동시호가 눈금 pct 산술.
2. `useNowMs` — fake timers로 tick 갱신 + 언마운트 clear.
3. `TotalQtyBar` — 색 회귀(토큰 문자열 포함), 비율 fill 유지.
4. `SessionTape` — 장중 fill 비율 렌더, reduced-motion, phase별 플레이헤드 가시성.

## 범위 제외 (후속)

- `/study` 리플레이 스크러버(클릭 이동) — 새 재생-위치 store + 인터랙션.
- 하단 운영 상태 바 — LiveStatusBar 중복 재검토 필요.
- 세션 테이프 앱-전역(nav-strip) 배치 — 현재 /live 전용.
