# 0046 — `/live` 이동평균선은 `/replay`의 `MOVING_AVERAGE_SPEC`과 분리된 자체 overlay로 구현한다

**Status:** accepted (2026-05-28)

**Related:**
- `docs/superpowers/specs/2026-05-28-live-moving-average-indicator-design.md` — 이 결정을 적용하는 spec
- ADR-0027 — chart numeric prefs registry (`movingAverages: MAConfig[]`은 structured pref로 explicit field)
- `frontend/src/chart/projectors/movingAverage.ts` — `/replay`의 5슬롯 고정 `MOVING_AVERAGE_SPEC`
- `frontend/src/state/livePage.ts` — `/live`의 자체 store

## Context

`/live` 페이지에 이동평균선 보조지표를 추가하려는 시점에 두 가지 접근이
가능했다:

1. **Unify**: `/replay`의 기존 `MOVING_AVERAGE_SPEC`(5슬롯 고정,
   `useActivePrefs` → `useTabsStore` 하드코딩)을 매개변수화해서 prefs
   source를 주입 가능하게 만들고, `MA_SLOT_COUNT`를 5 → 8로 bump한 다음
   `/live`도 같은 spec을 mount. `enabled: false` 슬롯이 "기간 추가"
   placeholder 역할.

2. **Fork**: `/replay`의 `MOVING_AVERAGE_SPEC`는 그대로 두고, `/live` 전용
   `MovingAverageOverlay`(가변 슬롯 배열, 자체 series 라이프사이클 관리)를
   새로 만든다. SMA 계산 함수(`computeSMA`)만 공유, mount 코드와 UI는 별개.

mockup은 가변 슬롯 + 슬롯당 색상 swatch · 선 굵기 · 소스 dropdown을
요구했고, `/live`는 `useTabsStore`(per-tab 컨텍스트)를 전혀 쓰지 않는다 —
자체 `useLivePageStore`만 사용.

## Decision

**Fork.** `/live`는 `useLivePageStore`에 자체 `movingAverages` 슬라이스를
가지고, `frontend/src/live/indicators/MovingAverageOverlay.tsx`라는 새
컴포넌트가 series 라이프사이클을 직접 관리한다. `/replay`의
`MOVING_AVERAGE_SPEC`은 변경하지 않는다.

두 모델은 다음에서 다르다:

| 측면 | /replay | /live |
|------|---------|-------|
| Spec 형상 | 정적 `PaneSpec<MAContext>` (`MOVING_AVERAGE_SPEC`) | 컴포넌트 (`MovingAverageOverlay`) |
| 슬롯 카디널리티 | 고정 5 | 가변 (1..8) |
| 슬롯 식별 | array index `MAIndex = 0..4` | 문자열 `id` |
| Prefs 형상 | `MAConfig = { period; enabled }` | `LiveMAConfig = { id; enabled; period; color; lineWidth; source }` |
| Prefs source | `useActivePrefs` → `useTabsStore` (per-tab) | `useLivePageStore` (페이지 전역) |
| Mount 경로 | `RangeSeriesPane` + `ChartStage` | 자체 컴포넌트 + `LiveChartRoot` |
| 공유 | `computeSMA`, `selectSource`, `--ma-N` palette |

## Consequences

**얻는 것:**
- `/replay` 회귀 위험 0 — 기존 동작과 모든 테스트가 손대지 않은 채로 보존된다.
- `/live`는 mockup에 보이는 모든 픽커(가변 슬롯, 색/굵기/소스)를 추가 추상화
  없이 자연스럽게 구현한다.
- `useTabsStore`의 "active tab id" 간접 호출을 `/live`가 우회 — `/live`는
  "탭"이라는 개념을 갖지 않으며 그 추상이 `/live` 의미와 맞지 않는다.
- ChartViewPrefs(/replay 한정)와 `/live` indicator prefs의 라이프사이클
  분리가 도메인 모델에 명시적으로 드러난다 (CONTEXT.md "Replay Tab" 정의 수정).

**잃는 것 / 위험:**
- 두 모델이 일시적으로 병행 존재. SMA의 동작·시각이 정확히 같음을
  보장하려면 양쪽에 동일한 회귀 테스트(사전 동시호가 제외, period clamp,
  enabled=false 처리)가 필요하다.
- 두 번째 indicator(예: 볼린저밴드)가 `/live`에 추가되는 시점에 통합 압력이
  생긴다 — 그때 새 ADR로 두 모델을 합치는 마이그레이션 경로를 결정한다.
- "기간 추가" UX가 `/replay`에는 없고 `/live`에는 있어, 두 페이지를 오가는
  사용자에게 mental model 차이가 생길 수 있다. 의도된 trade-off:
  `/replay`는 정밀 분석용으로 5슬롯이 일반적, `/live`는 실시간 모니터링용으로
  가변성이 더 가치 있다.

## Why not unify

Unify가 더 깔끔한 architecture로 보이지만 다음 비용이 있다:

- `MOVING_AVERAGE_SPEC`의 `useContext` 형 매개변수화는 `PaneSpec<Ctx>`의
  `useContext: () => Ctx` 시그니처와 자연스럽게 맞지만, 그 ctx를 어디서
  주입하는지(prop drilling? React context?)가 새로운 결합점이 된다.
- `MA_SLOT_COUNT`를 8로 bump하면 `RangeSeriesPane`은 항상 8개 LineSeries를
  mount하고 비활성 슬롯은 빈 데이터로 둔다. 합리적이지만 `/replay` 사용자에게
  "보이지 않는 3개 series가 mount되어 있다"는 invisible state가 생긴다.
- `LiveMAConfig`의 `color`/`lineWidth`/`source` 필드는 `/replay` 사용자가
  요청한 적 없는 기능이다. unify는 그 모든 UI를 `/replay`에도 자동으로
  드러내는데, 사용자 동의 없이 `/replay`의 보조지표 UI를 확장하는 것은
  본 spec scope를 벗어난다.
- 통합 마이그레이션은 `localStorage("replay.tabs.v1")`의 기존 `MAConfig`
  형상을 새 형상으로 마이그레이션해야 한다 — 위험과 책임이 추가된다.

따라서 fork는 *지금 이 변경의 범위*를 좁히고, 통합은 두 번째 `/live`
indicator가 등장하는 자연스러운 시점으로 미룬다.
