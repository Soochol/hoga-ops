# 0149 — `/study` 저장뷰 탭 제거 (단일 활성 뷰 복귀)

**Status:** accepted (2026-08-17) — **ADR-0123 을 부분 supersede.**

## 무엇을 뒤집고 무엇을 남기는가

ADR-0123 은 창 워크스페이스 전환을 결정하면서 **"/study 는 탭을 유지한다"** 를 본문에
못박았다. 이 ADR 은 **그 부분만** 뒤집는다.

**무효가 되는 것** (ADR-0123 안에서):

- §배경의 "`/study` 는 `/live` 와 달리 **탭을 유지한다** … 탭 = 무엇을 볼까, 창 = 어떻게
  배치할까" 문단
- §결정 방안 A 의 "탭 = 콘텐츠 선택자" 라는 표현
- §구현 형태 PR-3 의 "탭바 … 무변경", "`[`/`]`=탭 순환 유지"

**그대로 남는 것** (같은 강도로 못박는다 — 0123 의 `Status` 를 `accepted` 로 두는 이유다.
`superseded` 로 바꾸면 창 워크스페이스 결정까지 죽은 것으로 읽힌다):

- 방안 A 의 **레이아웃 공유 골격** — 창 배치는 워크스페이스 하나를 공유하고, 콘텐츠
  선택자가 모든 창의 데이터 소스를 통째로 바꾼다. 그 선택자가 탭에서 **단일 활성 뷰
  스토어**로 바뀌었을 뿐이다.
- 비율 좌표계(ADR-0122), `study.workspace.v1` 스키마
- §갱신(2026-08-10, #801 단계 1)의 **N개 차트 창** — 전 창이 활성 저장뷰 하나에 묶인다는
  성질 포함
- `canCloseStudyWindow`(차트 창이 0개가 되지 않는다) 불변식
- 봉·지표의 창 소유(#902/#904/#906/#1326)

## Context — 왜 직교성 논거가 무너졌나

ADR-0123 의 근거는 직교성이었다: `/live` 탭은 **종목** 단위라 창이 대체재였지만
`/study` 탭은 **저장뷰**(어느 날·어느 종목·어느 봉) 단위라 창과 축이 다르다.

그 직교성은 **탭이 실제로 여럿일 때만** 값을 낸다. 실사용에서 저장뷰는 한 번에 하나를
파고드는 대상이었고, 대가는 계속 쌓였다 — 봉 소유권의 왕복(#902 → #1326), 비활성 탭
프리페치 훅(`useWarmStudyReferenceTabQueries`), 캐시 축출의 탭 축, 뷰포트 캡처 등록소,
그리고 라우트 sync 가드 셋. ADR-0113 이 `/live` 에서 내린 판정("탭 스트립은 세로 공간을
상시 점유하지만 이득이 실사용에서 낮았다")이 같은 근거로 여기에도 성립한다.

`/live` 는 탭을 제거(2026-05-29) → ADR-0069 재도입 → ADR-0113 재제거의 왕복을 거쳤다.
`/study` 는 이번이 첫 제거다.

## Decision

**1. 탭 UI·탭 스토어·멀티 뷰 상태를 제거한다.** 삭제 대상:

- `frontend/src/state/studyTabs.ts` (+ 테스트) — 영속 `study.tabs.v1`
- `frontend/src/studyViews/StudyTabBar.tsx`
- `frontend/src/tabs/` **디렉터리 전체** — `ChartTabBar.tsx`·`ChartTabOverflowMenu.tsx`
  (+ 각 테스트). ADR-0113 §보존이 **"`/study` 가 공유하니까"** 라는 이유만으로 남긴
  것들이고, 그 이유가 사라졌다.
- `frontend/src/studyViews/useStudyKeyboard.ts` (+ 테스트) — 훅 전체가 탭 전용
- `frontend/src/studyViews/useWarmStudyReferenceTabQueries.ts` (+ 테스트) — §3 참조
- `formatStudyTabLabel`(탭 칩 전용 라벨 포맷) · `mergeTabViewportCapture`(탭 뷰포트 병합)
  · `@keyframes tab-pulse`(탭 상태점 애니메이션)

**2. 활성 저장뷰의 새 집은 `state/studyActiveView.ts`, 영속 키 `study.activeView.v1`.**
필드는 `{ viewId, code, label, name }` 넷이다.

- **`code` 는 필수다.** `studyWindowWorkspace.getWorkareaCode()` 가 `getState()` 로 동기
  fresh 읽기를 하고, 새로고침 직후 저장뷰 목록 쿼리가 뜨기 전에도 답해야 한다. 못 답하면
  `useWindowViewGuard` 를 타는 디바운스/타이머 콜백이 조용히 버려진다.
- **`timeframe` 은 담지 않는다.** 봉의 소유자는 차트 창이고(#1326) `ChartWindowConfig` 가
  `study.workspace.v1` 로 영속한다. 여기 남기면 **두 번째 진실**이 생겨 #902↔#1326 의
  왕복이 재발한다.
- **`viewport` 도 담지 않는다.** §4 참조.

**3. `study.tabs.v1` 에서 활성 탭 하나를 승계한다** — ADR-0113 §4 와 **갈리는 지점이고
이 ADR 에서 가장 중요한 비대칭이다.** 저기서 옛 탭 키를 그냥 버릴 수 있었던 것은
`live.page.v1` 이 마지막 종목을 **독립적으로 이미 영속**하고 있었기 때문이다. `/study` 에는
그 이중화가 없다 — `study.tabs.v1` 이 마지막 뷰 id 의 유일한 집이라, 버리면 기존 사용자의
첫 진입이 빈 화면이 된다. 새 키가 비었을 때만 1회, `activeIndex`(범위 밖이면 clamp)가
가리키는 탭에서 네 필드를 가져온다. 옛 키는 **지우지 않는다**(되돌리기 비용 최소화).

**4. 뷰포트 캡처·복원 배선을 제거한다.** 뷰 슬롯이 하나뿐이면 "이탈 시 캡처 → 복귀 시
복원" 이 성립하지 않는다 — 캡처한 뷰와 복원 대상이 같다는 보장이 없다. 복원 사슬은
`tabViewport ?? bandViewport ?? savedViewport` 에서 **`bandViewport ?? savedViewport`** 로
줄어든다. 복기뷰에서는 이쪽이 오히려 옳다: 저장 뷰포트는 사용자가 명시적으로 정한 값이다.

**5. Ctrl/⌘+클릭 "새 탭으로 열기" 배선을 전부 제거한다** (ADR-0113 §3 의 `disposition`
제거와 동형). 저장뷰 행·그룹 헤더·드롭 경로·행 메뉴 항목이 전부 일반 클릭과 같아진다.
계산만 하고 버려지는 배선을 남기지 않는다.

**6. 키보드 단축키에서 뷰 순환을 제거한다** — `[`/`]`·`1~4`. ADR-0113 §5 의 미러다.
(`/live` 의 `[`/`]`=창 포커스 순환은 무관하며 불변.)

**7. 저장뷰 전환은 두 경로로 수렴한다** — 우측 레일 **저장뷰 드로어** 클릭과 **`?view=`
딥링크**. 드로어의 `activePanel` 은 영속되므로 열어 두면 클릭 1회로 탭과 동등하다.

## 보존 (삭제하지 않음)

- **`live/viewportAnchor.ts` 의 `TabViewport` 타입과 캡처 배관** — 이름만 탭이다. 저장뷰를
  **만드는** 경로(`LiveChartRoot.onViewportCaptureReady` → `ChartWindow.viewportCaptureRef`
  → `studySaveCommand`)가 쓰며, 그 버튼은 `/live` 차트 창에만 있다. `/study` 는 저장뷰를
  *보는* 곳이라 자기 캡처 등록소는 탭 전용이었고 함께 죽었다.
- **`state/persist.ts` 의 `'tab'` 스코프 · `crossTabSync.ts` · `workspace.tabScope.test.ts`
  · `StudyChartWindow.test.tsx` 의 "다른 탭이 바꾼 전역 설정"** — 전부 **브라우저 탭**이다
  (ADR-0072). 이름이 같을 뿐 무관하니 grep 청소에 쓸어 넣지 말 것.
- **`ui/sortableDragVisuals.ts`** — 관심종목·히트맵이 공유한다.
- **라우트 sync 가드 셋**(`initialQueryViewIdRef`/`handledQueryViewIdRef`/
  `routeSyncPendingRef`) — §Consequences 참조.

## Why

- **단일 뷰 = 복기 워크플로에 적합**: 저장뷰는 한 번에 하나를 파고드는 대상이다. 탭
  스트립은 세로 공간을 상시 점유했고, 그 자리는 이제 차트가 쓴다.
- **탭이 혼자 쥔 영속 상태가 없었다** — 제거 비용이 낮았던 이유다. 봉은 창이
  (`study.workspace.v1`), 뷰별 봉 기억은 `StudyPage` 의 맵이, 저장 봉은 저장뷰 엔티티가
  들고 있었고, 뷰포트는 애초에 스냅샷에서 빠지는 세션 한정 값이었다.
- **죽은 코드 청산**: `/live` 가 탭을 놓은 뒤 `tabs/` 디렉터리의 유일 소비자는
  `StudyTabBar` 하나였다. 제네릭 탭바를 "언젠가 쓸지 모른다" 로 남기면 유지비만 남는다.

## 대안과 기각

- **탭 UI 만 숨기고 스토어 존치** — ADR-0113 이 이미 기각한 것과 동형. 죽은 영속·미러가
  남아 accidental complexity 가 된다. 기각.
- **워밍 훅을 활성 뷰용으로 축소** — 워밍과 활성이 `studyReferenceQuerySettings` →
  `studyReferenceQueryOptions` → `studyDailyContextWindow` 를 같은 순서로 부르고, 워밍 봉이
  포커스 창 봉이라 **단일 뷰에서 두 세트가 같은 키**다. 관찰자만 두 벌 붙고 fetch 는 0건
  추가 — 흡수할 잔여 가치가 없다. 기각(훅째 삭제).
- **뷰포트를 `Map<viewId, TabViewport>` 로 보존** — 멀티 뷰 상태의 재도입이다. 기각.
- **`study.tabs.v1` 폐기(ADR-0113 §4 방식)** — 대체 영속처가 없어 "마지막 뷰 복원" 요구를
  위반한다. 기각(§3 참조).
- **저장뷰 삭제 시 남은 뷰 중 최근 것으로 자동 이동** — 사용자가 지운 직후 뜻밖의 뷰가
  뜬다. 빈 상태에는 이미 "저장뷰 열기" 버튼이 있다. 기각.

## Consequences

- **일회성 손실**: 열어둔 탭 목록, 핀 고정, 탭 순서. 탭별 뷰포트(원래 세션 한정).
- **진행 중 요청 취소 계약이 반전된다.** 워밍 훅이 못박고 있던 "뷰를 바꿔도 직전 요청을
  살려 둔다" 가 사라져, 뷰 전환 시 이전 번들이 abort 된다. 같은 파일의
  `WARM_INACTIVE_TAB_CONCURRENCY` 주석이 "백엔드가 사실상 직렬이라 동시 요청은 서로를
  늦출 뿐" 을 실측으로 논증하므로, 버려질 요청을 끊는 것은 새 뷰에게 유일한 슬롯을
  넘기는 것이다.
- **range 캐시 축출이 공격적이 된다.** 보존 집합이 "열린 탭 어느 하나라도 든 종목" 에서
  **활성 종목 하나**로 좁아졌다. 뷰 A↔B 왕복이 매번 재fetch(JSON ~23MB)다. 메모리와
  재요청을 맞바꾼 것이고, 체감이 나쁘면 "직전 종목 1개 유예" 가 다음 수다.
  - 이 축소에서 **구멍이 하나 드러났다**: 보존 봉 집합에 탭 봉이 함께 들어가던 시절에는
    창이 아직 없어도 최소 한 벌이 지켜졌다. 탭이 사라지자 `openTimeframes` 가 빈 순간
    (하이드레이션 직전) 활성 종목 캐시가 통째로 날아간다. 빈 배열은 "보존할 봉이 없다"
    가 아니라 **"창이 아직 없다"** 이므로 그때는 봉 축을 끈다.
- **라우트 sync 가드 셋은 모델 독립이다 — 접지 말 것.** 단일 뷰가 됐다고 단순화하면
  `navigate(replace)` ↔ effect 핑퐁이 돌거나 **딥링크가 영속된 마지막 뷰에 덮인다**.
  실제로 이 PR 에서 그 회귀가 한 번 났다: 첫 커밋에서 `openSave` 를 부른 effect 의 상태가
  아직 반영되기 전에 되감기 effect 가 옛 뷰로 URL 을 바꿨다. 그래서 "쿼리가 가리키는
  저장뷰가 아직 활성이 아니면 되감지 않는다" 술어를 추가했고, 신규 테스트
  「`?view=` 가 영속된 마지막 뷰를 이긴다」가 그 방향을 못박는다.
- **CONTEXT.md 정정**: `저장 학습뷰` 엔트리에 단일 활성 뷰 성질을 추가한다(`activeCode`
  엔트리가 `/live` 를 기술하는 어투와 같은 구조).
- **되돌리기 비용**: `study.tabs.v1` 스냅샷 스키마, `ChartTabBar` 제네릭(렌더 윈도잉·
  오버플로 3중 처리·핀 경계 DnD), 워밍 슬롯 알고리즘(`WARM_INACTIVE_TAB_CONCURRENCY` 의
  실측 근거 주석 포함)이 git 이력에만 남는다. `/live` 가 세 번 반전한 전례가 있으므로,
  **재도입 전 실사용 근거를 요구할 것.**
