# 0148 — 영속 정책은 기본에서 벗어난 키만 선언한다

**Status:** accepted (2026-08-17)

## Decision

프론트엔드의 storage 키 정책을 `frontend/src/state/persistencePolicy.ts` 에 선언한다.
단, **전수 레지스트리를 만들지 않는다** — 기본 관례에서 벗어난 키만 담는다(현재 10개).

기본 관례는 **"localStorage 에 쓰고, 런타임은 탭마다 자기 메모리를 그리고, 저장소는
다음 로드의 시드"** 다. 43개 키 중 **33개(77%)** 가 이것이고, 그것이 기본이므로 선언하지
않는다. 선언 대상은 넷:

| 정책 | 뜻 | 키 수 |
|---|---|---|
| `shared-synced` | localStorage + `storage` 이벤트 — 열린 탭이 리로드 없이 따라온다 | 5 |
| `tab` | sessionStorage — "이 탭에서 지금 무엇을 보는가" | 2 |
| `tab-authoritative-shared-seed` | tab 권위 + shared write-through(다음 새 탭의 시드) | 2 |
| `signal` | 값을 안 나른다. 진실이 서버라 "다시 읽어라"만 알린다 | 1 |

`hydrate*FromStorage` 를 정의했지만 **의도적으로 배선하지 않은** 것은 사유와 함께
`INTENTIONALLY_UNSYNCED` 에 넣는다.

`persistencePolicy.test.ts` 가 양방향으로 잠근다. 선언→소스(키·모듈이 사라지면 빨강),
소스→선언(`window.addEventListener('storage'` 발생 수 ≠ 선언 수면 빨강,
`hydrate*FromStorage` 구현체가 선언에도 예외에도 없으면 빨강).

## Why

리뷰가 지목한 문제는 "34개 module 이 매체 × 스코프 × 크로스탭 × 시드 **네 축을 각자
결정한다**" 였고, 처방은 43항목 중앙 레지스트리였다. 조사가 그 전제를 세 번 반증했다.

**① "34개가 각자 결정" 은 중복 합산이다.** 세 부류(persist.ts 경유 18 · 원시 16 ·
`attachPersistence` 2)가 **서로소가 아니다** — `attachPersistence` 2개는 쓰기만 그것이고
읽기는 원시(`chartPrefsPersistence.ts:139` · `studyTabs.ts:88`), `indicatorsWindowMigration`
은 쓰기가 `persistJson` 이고 읽기가 원시다. 실제 결정 모듈은 32 이고 나머지 2는 커널이다.

**② 네 축이 아니라 최대 셋이고, 실질 자유도는 둘이다.** `persist.ts:7-9` 가
`scope === 'tab' ? sessionStorage : localStorage` 로 강제해 **매체와 스코프는 같은 축**이다
(`localStorage + tab` 도 `sessionStorage + shared` 도 코드상 표현할 수 없다). 16가지 가능
조합 중 실측 **5개**, 그중 하나가 77% 를 덮는다. 축들은 서로 독립이 아니다 — 크로스탭은
`shared` 와만, write-through 시드는 `tab` 과만 짝지어지고, **둘은 한 번도 같이 나타나지
않는다**.

**③ "이름 없는 네 번째 스코프" 는 관찰은 맞고 판정이 틀렸다.** 그런 실체는 실재한다
(공유 저장소 · 탭 로컬 런타임 · 저장소는 다음 로드의 시드). 그러나 33키 중 실제 증상이
나는 것은 **1건**뿐이었다. 나머지는 탭별로 남는 게 옳거나, 런타임 드리프트가 화면에
나타나지 않거나, **코드가 명시적으로 판단한 것**이다 — `liveLayout.ts:6-12` 는 공유
스냅샷의 클로버 기전을 정확히 서술한 뒤 `lastAppliedPresetId` **한 필드만** 탭 키로 뺐다.
누락이 아니라 판단이다.

남은 실질은 **결함 1건**이었다. `live.investorEstimateUnit.v1` 은 `hydrateFromStorage` 가
정의돼 있는데 **아무도 부르지 않아** 저장은 공유인데 읽는 시점이 모듈 로드 한 번뿐이었다.
`liveVenue.ts:98-100` 이 2026-08-07 에 거래소에서 고친 것과 같은 기전이고, 그 도크스트링이
증상을 이미 적어 놓았다("먼저 띄워 둔 탭만 옛 거래소로 남았다"). 화면은 정상으로 보이므로
사용자는 자기가 잘못 눌렀다고 생각한다.

**그 버그를 실제로 잡은 것은 레지스트리가 아니라 판별식이었다 — 「기계는 정의됐는데
배선이 없다」.** 그래서 처방을 레지스트리가 아니라 **그 판별식의 요구화**로 잡았다.

## 왜 전수 레지스트리가 아닌가

**강제할 수 없다.** 키 상수의 다수가 비-export 이고, 인라인 리터럴이 2건
(`watchlist.collapsed` · `hoga.perf.debug`), 동적 키가 1건
(`replay.drawings.v2.<code>|<slot>`)이다. 키 리터럴을 파싱하는 가드는 조용히 틀린다 —
#1340~#1342 에서 문자열 스캔 가드의 파서가 이미 두 번 그랬다. **한 번도 빨개진 적 없는
가드는 아무것도 증명하지 못하고, 항상 빨간 가드는 무시되기 시작해 메커니즘 전체를 죽인다.**

**ADR-0027 이 이미 같은 것을 기각했다.** "Full polymorphic pref registry" 는 값의 종류가
섞이면 TypeScript 가 discriminated union 을 파생에 실어나르지 못한다는 이유로 기각됐고,
영속은 정확히 그 상황이다(동적 키 · 읽기가 없는 신호 채널 · JSON 이 아닌 맨 숫자 4건).
규모도 다르다 — `CHART_TOGGLES` 는 **43항목이 한 개 storage 키 뒤에** 있고, 영속은
**43개 키가 18개 모듈에 흩어져** 있다. 모으면 소유권이 정의 파일에서 떨어져 나간다.

**그리고 순환을 재생산한다.** `state/workspaceKeys.ts:1-9` 는 규칙을 모으려고 생긴 파일이
아니라 **순환을 끊으려고 강제 추출된 leaf** 이고 그 docstring 이 직접 그렇게 적고 있다.
"crossTabSync 의 호출 목록을 레지스트리에서 파생시킨다" 는 처방은 레지스트리가 구독
함수(전부 스토어 모듈 안에 산다)를 참조하게 만들어 그 순환을 43배로 되살린다. 그래서
`persistencePolicy.ts` 는 **아무것도 import 하지 않는 leaf** 이고, `crossTabSync.ts` 는
지금처럼 구독 함수를 직접 import 하며, **둘을 잇는 것은 런타임 파생이 아니라 테스트**다.

## Consequences

- 새 키가 기본과 다르면 `NON_DEFAULT_PERSISTENCE` 에 한 줄. 기본이면 아무것도 안 한다.
- `hydrate*FromStorage` 를 새로 만들면 배선하거나 사유와 함께 예외로 선언해야 한다 —
  안 하면 가드가 빨개진다. **규율이 아니라 요구다.**
- 가드는 **키 리터럴을 파싱하지 않는다.** `window.addEventListener('storage'` 발생 수와
  `hydrate*FromStorage` 구현체 집합 — grep 한 줄로 재는 사실 — 에만 앵커를 건다.
- **선언 파일 자신은 스캔에서 제외한다.** 넣으면 "선언된 키가 소스에 실재한다" 가
  자기 자신을 읽어 **항상 통과**하고(키를 오타 내도 초록), 리스너 계수도 docstring 안의
  예시 문자열을 함께 세어 실제로 한 번 틀렸다.
- **이 가드가 못 보는 것**: 이름 규칙(`hydrate*FromStorage`)을 벗어난 새 하이드레이션.
  이름 매칭을 전수 발견으로 확장하지 않는 것은 의도적이다(#1199 — 오탐과 누락이 둘 다
  조용하다). 기본 관례를 쓰는 33키도 세지 않는다. 표에 없다는 것은 "검토됐다"가 아니라
  "기본이다" 라는 뜻이다.

## 미해결로 남긴 것

**`study.tabs.v1`** 은 모든 `/study` 탭이 탭 목록 스냅샷 전체를 공유 localStorage 에
쓴다 — `workspace.ts:32-39` 가 이름 붙여 고친 파괴 기전과 구조적으로 같다. 보류로
결정했다(2026-08-17): 코드 전체에서 `window.open` 은 `/live` 한 곳뿐이라 `/study` 를 두
탭에 띄우려면 사용자가 탭을 수동 복제해야 하고, 순수 sessionStorage 이동은 **브라우저
재시작 간 영속을 잃는다**(workspace 는 dual-write 라 비용이 달랐다). 저장 경로 테스트만
세워 현재 동작을 못박았다.

> **갱신 (2026-08-17, ADR-0149): 이 항목은 보류가 아니라 소멸했다.** `/study` 저장뷰 탭이
> 제거되면서 `study.tabs.v1` 을 **쓰는 코드가 없어졌다** — 새 `study.activeView.v1` 이
> 부팅 때 한 번 읽어 승계할 뿐이고(승계 직후 새 키를 굳혀 그 의존도 끊는다), 옛 키는
> 롤백 여지로 지우지 않고 둔다. 스냅샷 전체를 공유 localStorage 에 쓰는 파괴 기전도
> 함께 사라졌다: 새 키가 담는 것은 **뷰 하나**(`{viewId, code, label, name}`)라 두 탭이
> 서로를 덮어써도 잃는 것이 "다음에 그 탭에서 뭐가 먼저 뜨나" 뿐이다. 여기서 세운 저장
> 경로 테스트의 **계약은 `studyActiveView.test.ts` 의 「저장 배선」 describe 가 승계**했다.

> **갱신 (2026-08-21, ADR-0155): 이 항목의 결말이 한 번 더 바뀌었고, 이번엔 좋은 쪽이다.**
> 활성 저장뷰가 링크 그룹의 것이 되면서 `study.activeView.v1` 스토어가 삭제되고 값이
> `study.workspace.v1` 의 `groupViews` 로 옮겨갔다 — 그 키는 `tab-authoritative-shared-seed`
> 라 **위에서 보류했던 "두 탭이 서로를 덮어쓴다" 가 구조적으로 사라졌다**(공유
> localStorage 는 새 탭의 시드 전용). 옛 키 둘(`study.tabs.v1` · `study.activeView.v1`)은
> 이제 **부팅 승계 전용**이고 여전히 지우지 않는다. 저장 경로 테스트의 계약은
> `state/studyWorkspace.test.ts` 의 「링크 그룹」·「그룹 1 저장뷰 승계」 describe 가 승계했다.

**`readJsonObject` 가 키 부재를 지운다**(`persist.ts:27` — `if (!raw) return {}`). 이것이
"원시 localStorage 를 직접 쓰는" 사례 중 4건의 실제 이유다 — `chartPrefsPersistence` ·
`indicatorSettingsV2` · `indicatorsWindowMigration` · `chart/drawing/persistence` 가 전부
**"이 키가 쓰인 적 있는가"로 시드·마이그레이션을 게이트**한다. `hasKey` 를 3줄로 더할 수
있지만 소비처 전환 없이 추가하면 죽은 export 이고, 전환은 넷 다 회귀가 조용한 자리라
별건으로 남긴다.

## Relation to other ADRs

- **ADR-0027** (chart prefs registry) — 선언적 필드에서 저장 레이아웃을 파생시키는
  선례(`INDICATOR_MODAL_TOGGLE_KEYS`). 그 ADR 의 기각 논거가 여기서 그대로 적용된다.
- **ADR-0147** (RangeBundle slice registry) — 같은 "선언 + 양방향 가드" 형태. 거기서
  문자열 스캔 파서가 두 번 틀린 경험이 여기 가드의 앵커 선택을 결정했다.
