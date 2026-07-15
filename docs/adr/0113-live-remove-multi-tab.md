# 0113 — `/live` 멀티 종목 탭 제거 (단일 뷰 복귀)

**Status:** accepted (2026-07-15) — **supersedes ADR-0069** (및 그 addendum 4건).

## Context — 왜 다시 ADR인가

ADR-0069(2026-06-11)로 `/live`에 멀티 종목 탭을 **재도입**했고, 이후 네 차례 addendum
(단일-탭 내비게이션 모델 2026-06-12, 무제한 탭+bounded 투영 2026-06-16, 오버플로 어포던스
2026-07-13 2차)으로 다듬었다. 그러나 실사용에서 탭 스트립은 밀도 대비 이득이 낮았고, 사용자
요청에 따라 `/live`에서 탭 UI와 멀티 종목 상태를 **전부 제거**하고 단일 뷰 모델로 되돌린다.

탭은 `/replay`→`/live` 통합(2026-05-29) 때 한 번 제거됐다가 ADR-0069로 부활한 이력이 있어,
이번 제거는 그 왕복의 세 번째 반전이다. 미래 독자가 "제거→부활→다시 제거"의 맥락을 잃지
않도록 이 ADR이 결정과 되돌리기 비용을 남긴다.

**Related:**
- ADR-0069 — 본 ADR이 supersede (멀티 탭 재도입 + addendum 4건)
- ADR-0052 — `activeCode`/`activeInstrument` = `/live` 렌더 SSOT (**유지** — writer만 교체)
- ADR-0067 — Live Set(관심종목 상위 N) WS 저장 (탭과 무관, **불변**)

## Decision

**1. 탭 스트립·탭 스토어·멀티 종목 상태를 제거한다.** `/live`는 한 번에 한 종목(또는 지수)만
보는 단일 뷰로 되돌아간다. 삭제 대상:

- `frontend/src/state/liveTabs.ts` (탭 스토어 + 영속화 `live.tabs.v2`/`v1`)
- `frontend/src/state/liveTabProjection.ts` (탭↔page 미러)
- `frontend/src/live/LiveTabBar.tsx` (live 탭바 래퍼)
- `frontend/src/live/liveViewLabel.ts` (탭 라벨 포매터)
- `frontend/src/api/liveTabMetrics.ts` (탭 라벨용 등락률 폴러)
- `frontend/src/live/liveActivation.ts` (`disposition` = Ctrl+클릭 새 탭 판정)

**2. `activeCode`/`activeInstrument`의 단일 writer = `useLivePageStore.projectActiveView` 자신.**
ADR-0069 D3는 "활성 탭이 유일 writer"였다. 탭이 사라졌으므로 writer를 page 스토어 직접 호출로
되돌린다. 읽기 15곳(차트·사이드바·지표·상태바)은 계약 무변경 — activeCode SSOT는 여전히
`useLivePageStore`에 있다(ADR-0052 불변). 공통 진입점은 `frontend/src/live/liveNavigate.ts`의
`activateLiveInstrument` / `activateLiveCode` — 종목을 제자리 교체하고, `timeframe`은 유지,
`historicalFromDate`(pan)·viewport는 새 종목 기본 뷰로 초기화한다(옛 `setActiveTabCode`의
제자리-교체 의미를 그대로 계승).

**3. `disposition`(Ctrl/Meta+클릭 = 새 탭) 배선을 전부 제거한다.** 탭이 없으면 "새 탭"은
의미가 없어 죽은 코드다. 히트맵·스크리너·관심종목 행의 `onClick`/`onPick`/`onActivate`에서
`options?: { disposition }` 파라미터를 걷어내고, `useJumpToLive`는 `(code, label?) => void`로
좁힌다. Ctrl+클릭은 일반 클릭과 동일하게 현재 뷰를 교체한다.

**4. 영속화·복원은 `live.page.v1`로 충분.** page 스토어가 이미 `activeCode`/`activeInstrument`/
`candleTimeframe`을 `live.page.v1`에 영속화하므로 새로고침 후 마지막 종목·타임프레임이 복원된다.
마운트 시 pan은 초기화(fresh view — 옛 탭 focus의 `historicalFromDate: null` 계승, `/live` 일봉
저장뷰 span 이슈 회피). `live.tabs.v2`/`v1`는 더 이상 읽지 않는다(사용자가 열어둔 탭 목록은 소실 —
단일 뷰 전환의 일회성 비용, 마지막 종목은 유지되므로 실질 손실 최소).

**5. 키보드 단축키에서 탭 순환 제거.** `useLiveKeyboard`의 `[`/`]`(이전/다음 탭)·`1~9`(탭 N)
콜백을 제거한다. 타임프레임 shift+숫자 단축키·`w`/`d`/`j`/`k`는 유지. (`/study`의
`useStudyKeyboard` `[`/`]` 탭 순환은 **불변** — 별도 스토어·별도 배선.)

## 보존 (삭제하지 않음)

- **`tabs/ChartTabBar.tsx` + `tabs/ChartTabOverflowMenu.tsx`**: `/study`(`StudyTabBar`)가
  공유하는 제네릭 탭바. `--h-tab` CSS 변수도 study가 계속 사용.
- **`live/viewportAnchor.ts` (`TabViewport` 타입 + 캡처 로직)**: 저장뷰(Study View Save)가
  현재 차트 뷰포트를 캡처하는 데 사용 — 탭이 아니라 뷰포트 프리미티브다. `onViewportCaptureReady`/
  `viewportCaptureRef` 배관은 저장뷰용으로 유지, 탭별 뷰포트 저장(`updateTabViewport`)만 제거.
- **`state/studyTabs.ts`·`useStudyKeyboard`·`StudyTabBar`**: `/study` 멀티 뷰 탭 — 본 ADR 범위 밖.

## Why

- **단일 뷰 = 밀도 적합**: `/live`는 한 종목의 호가·체결·지표를 고밀도로 본다. 탭 스트립은
  세로 공간(`--h-tab`)을 상시 점유하지만 멀티 종목 감시 이득은 실사용에서 낮았다.
- **writer 되돌리기 = 작은 blast radius**: ADR-0069가 "activeCode를 파생값으로 바꾸지 않고
  page 스토어에 유지"했기에, 읽기 15곳을 건드리지 않고 writer(탭→facade)만 교체하면 된다.
  "make the change easy, then make the easy change"의 역방향 회수.
- **disposition 제거 = 죽은 코드 청산**: 탭 없는 "새 탭으로 열기"는 무의미. 파라미터를 남기면
  "왜 클릭이 쓰지도 않는 disposition을 계산하나?"라는 리뷰 부채가 된다.

## 대안과 기각

- **탭 UI만 숨기고 스토어 존치**: 죽은 스토어·영속화·미러 구독이 남아 accidental complexity.
  단일 뷰가 목표면 스토어째 제거가 맞다. 기각.
- **`disposition` 파라미터를 no-op으로 유지**: 호출부 diff는 줄지만 Ctrl+클릭이 계산만 하고
  버려지는 배선이 7개 컴포넌트에 잔존. "전체 삭제" 취지와 배치. 기각.
- **`live.tabs.v2`→`live.page.v1` 마이그레이션**: page 스토어가 이미 마지막 종목을 독립
  영속화하므로 불필요. 열어둔 탭 목록 소실은 단일 뷰 전환의 일회성 비용으로 수용. 기각.

## Consequences

- **CONTEXT.md 정정**: `activeCode` 엔트리의 "활성 Live Tab이 단일 writer" → "page 스토어
  `projectActiveView`가 단일 writer(관심종목/검색/스크리너/히트맵 클릭·드롭이 현재 뷰 교체)".
  `Watchlist Panel`·`Document Title` 엔트리의 "Live Tab" 참조 정리. "Live Tab" 용어 폐기.
- **ADR-0069는 historical**: 파일을 지우지 않고 status만 superseded로 두어 왕복 이력을 보존.
- **되돌리기 비용**: 재도입 시 ADR-0069의 스토어·미러·영속화 스키마를 되살려야 한다(옛 코드가
  git 이력에 남아 Layer-1 레퍼런스). 세 번째 반전이므로 재재도입 전 실사용 근거를 요구할 것.
