# 0146 — 지표 세트는 페이지별(`/live` ↔ `/study`)이고, 페이지 안에서는 공유한다

**Status:** accepted (2026-08-15) · **amended by**
[ADR-0152](0152-per-window-indicator-sets.md) (2026-08-21) — 아래 재검토 트리거("한
페이지 안에서 창마다 다른 지표")가 실제로 와서 이 축 **위에** 창 축을 얹었다.
페이지 축은 그대로 유효하다.

**Supersedes:** [ADR-0145](0145-per-window-indicator-scope.md) (창별 분리 opt-in — 구현되어
#1327 로 머지됐다가 같은 날 제거).
**Amends:** #712 의 "지표는 앱 전역 1세트" 결정 — 전역 1세트를 **페이지당 1세트**로 쪼갠다.

**Related:**
- ADR-0072 — 한 지표의 prefs 가 `livePage`·`chartPrefs` 두 store 에 나뉜다.
- ADR-0114 §3 — pane 순서·크기는 전역 1세트(이 ADR 이 바꾸지 않는다).
- `frontend/src/state/indicatorSettingsV2.ts`, `frontend/src/live/workspace/windowView.ts`.

## Decision

1. **`/live` 와 `/study` 는 각각 자기 지표 세트를 갖고 서로 동기화하지 않는다.**
2. **한 페이지 안에서는 모든 창이 그 세트를 공유한다.** 창별 분리도, 연동 스위치도 없다.
   창이 정하는 것은 종전대로 **어느 봉 버킷인가** 뿐이다(스코프는 페이지 × 봉).
3. 저장 모델은 `live.indicators.v2` 안에서 **비대칭**으로 확장한다:

```
{ paneOrder, paneStretch,
  byTimeframe:      { minute|D|W|M: sparse diff },  // /live — 종전 그대로
  studyByTimeframe: { minute|D|W|M: sparse diff } } // /study — 없으면 로드 시 시드
```

4. **`/study` 세트는 로드 시 즉시 시드된다**(`/live` 세트의 깊은 사본). 게으른 폴백이
   아니다 — 아래 Context 참조.
5. 페이지 판정은 **워크스페이스 어댑터의 `scopePrefix`** 에서 렌더 동기적으로 나온다.
   전역 "현재 페이지" 슬롯은 두지 않는다.
6. `chartPrefs` 의 indicator-modal 키도 같은 페이지 축으로 갈린다(ADR-0072 의 두 store 가
   한 드로어에 함께 뜨므로).

## Context

### 왜 대칭(`byPage.{live,study}`)이 아니라 비대칭인가

대칭이 더 깔끔해 보이지만, 그러면 `byTimeframe` 이 **아무도 안 쓰는 키**가 된다. 이 리포는
그 실패를 이미 겪었다 — 스테일해진 `live.indicators.v2` 를 되살리려고
`indicatorsWindowMigration` 이라는 1회성 사다리를 써야 했다. `/live` 저장 형태를 그대로
두면 마이그레이션도, 스테일 키도, 롤백 시 읽기 불능도 없다.

### 왜 게으른 폴백이 아니라 즉시 시드인가

`studyByTimeframe ?? byTimeframe` 로 읽고 첫 쓰기에 복사하는 모델은 **인수 조건을
통과하지 못한다**. 사용자의 검수는 "`/live` 에서 지표를 바꾸고 `/study` 가 따라오는지"
보는 것인데, 폴백이면 `/study` 는 자기 첫 편집 전까지 계속 `/live` 를 가리킨다 — 즉
"분리했다는데 여전히 같이 바뀐다" 로 보인다.

그래서 정규화가 **키의 부재**를 시드 신호로 쓴다. 값이 `{}` 인 것은 부재가 아니다(공장값
사용자는 복사할 diff 가 없어 `{}` 가 정상) — 빈 것을 부재로 취급하면 그 사용자의 `/study`
가 매 로드 `/live` 값으로 덮인다.

### 왜 전역 페이지 슬롯이 아니라 어댑터인가

`indicatorPage` 같은 스토어 슬롯은 라우팅·마운트보다 한 커밋 늦게 갱신되고, 그 한 틱 동안
엉뚱한 페이지의 버킷이 적용된다. `chartPrefs.windowScope.test.tsx` 가 남아 있는 결함이
정확히 그 모양이었다(포커스를 따라다니는 전역 슬롯). 어댑터는 모듈 상수 2개라 렌더
동기적이고 참조도 안정적이다.

## Alternatives considered

### A. 창별 분리 opt-in (ADR-0145) — 철회
"창마다 따로" 로 요구를 읽었으나, 실제 요구는 "`/live` 와 `/study` 가 서로 안 따라오게"
였다. 창 축은 페이지 축을 포함하지 못한다 — 창별 분리를 켜도 **기본이 연동**이라 두
페이지는 여전히 같은 세트를 봤다. 남은 자산은 스코프 절단면 자체다(`bucketsForPage` 가
`bucketsForScope` 의 자리를 그대로 물려받았고, 소비자 39개 파일은 이번에도 무변경).

### B. 창별 항상 독립 — 기각
새 창을 열 때마다 지표를 처음부터 켜야 한다. 요구에도 없었다.

### C. 명명 프로파일 — 유예
페이지 축 위에 얹을 수 있다(ADR-0145 대안 B 참조). 관리 UI 비용이 요구를 넘어선다.

## Consequences

**Positive:** 소비자 39개 파일 무변경. ADR-0145 가 필요로 하던 기계 장치가 통째로
사라진다 — 분리 멤버십·두 store 동반 호출·창 소멸 GC·드로어 스위치·창 id 네임스페이스가
전부 없다. 페이지는 창처럼 사라지지 않으므로 회수 문제 자체가 생기지 않는다.

**Negative / watch:**

- **`/live` 와 `/study` 를 같은 구성으로 쓰던 사용자는 이제 두 번 설정해야 한다.** 시드가
  그 순간을 무통증으로 만들지만, 그 뒤로는 두 곳을 따로 관리한다. 이것이 요구된 동작이다.
- **번들 요청은 두 페이지가 서로 다른 지표를 켰을 때만 는다.** 쿼리 키에 실리는 것은
  `studyReferenceQuerySettings` 의 8개 필드뿐이라(askPeak·bidPeak·brokerLateEntry·
  tradeVolumePoc·depthHeatmap·volumeDistribution 계열), 나머지를 아무리 달리해도 요청은
  그대로다. 이 목록에 필드를 추가하면 그때 페이지별 요청 분기가 넓어진다.
- **`/study` 의 창 밖 소비자 3곳이 `'study'` 를 하드코딩한다**(`useStudyChartIndicators`·
  StudyPage 번들 스펙·탭 워밍). 그 훅들은 `/study` 에서만 도는 것이 전제이므로 맞지만,
  재사용 대상이 되면 그 전제가 깨진다.
- **재검토 트리거**: 한 페이지 안에서 창마다 다른 지표를 보고 싶어질 때. 그때는 이 축
  **위에** 창 축을 얹는다(ADR-0145 의 코드가 그 모양이었다).
