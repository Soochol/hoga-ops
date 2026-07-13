# 0069 — `/live` 멀티 종목 탭 재도입 (보는상태 탭별 / 분석설정 전역)

**Status:** proposed (2026-06-11) — spec `docs/superpowers/specs/2026-06-11-live-tabs-design.md` (v2, eng-review 반영). 미구현.

**Context — 왜 ADR인가:**
`/live`에 멀티 종목 탭을 **재도입**한다. 탭은 2026-05-29 `/replay`→`/live` 통합 때 페이지째 삭제됐던
기능이다(삭제 커밋 `7193684`/`1f6643f`/`50749f5`; 옛 자산 `state/tabs.ts`·`tabsPersistence.ts`·spec
`2026-05-24-replay-tab-persistence-design.md`). 따라서 미래 독자는 "제거됐다던 탭이 왜 `/live`에 있나?"라고
물을 수밖에 없다 — 이 ADR이 그 답이다. 되돌리기 비용도 크다(store 분리·activeCode 계약·영속화 스키마).

**Related:**
- ADR-0052 — activeCode = `/live` 렌더 SSOT (본 ADR이 "활성 탭의 투영"으로 의미 확장, 저장 위치는 유지)
- ADR-0067 — Live Set(관심종목 상위 N) WS 저장 / 보는종목 REST 표시 (탭은 이 위 순수 뷰어 — 캡처 한도와 분리)
- ADR-0053 — Live push 단일 WebSocket (탭은 추가 구독 없음 — cold-swap)
- spec `docs/superpowers/specs/2026-06-11-live-tabs-design.md`
- 옛 prior art: `2026-05-24-replay-tab-persistence-design.md`, 삭제된 `frontend/src/state/tabs.ts`
- CONTEXT.md "activeCode", "ChartViewPrefs", "Live Set"

## Decision

**1. 탭 = cold-swap 뷰어.** 활성 탭만 프론트가 구독한다. 백그라운드 warm·디스크 캡처는 기존 **Live Set**이
자동 책임(ADR-0067) — 탭은 KIS 구독 한도와 무관. 탭은 디스크(`/api/range`)+라이브 위에 얹힌 순수 뷰어로,
종목코드만 갈아끼운다. (과거 호가는 `build_range_bundle`이 멤버십 무관·`path.exists()`만 보므로 캡처된 날짜는 자동 표시.)

**2. 보는상태는 탭별, 분석설정은 전역.**
- **탭별**: `code`, `timeframe`, `historicalFromDate`(팬 위치). `candleTimeframe`을 `useLivePageStore`→Tab으로 이동(옛 `TabSelection` 복원).
- **전역 유지**: `ChartViewPrefs`(`auctionWindowMask`·`ratioOutlierFilter`·`fillStrengthCumulative` 등)·MA·거래량·Source Preference.
  통합 때 삭제한 `prefs: Map<tabId, ChartViewPrefs>` + `ChartPrefsContext` 인디렉션을 **되살리지 않는다**.

**3. `activeCode`는 `useLivePageStore`에 유지** (파생값 아님). 새 `useLiveTabsStore`의 활성 탭이 `setActiveCode`로
쓰는 **단일 writer**. 읽기 15곳 무수정, ADR-0052 저장 위치·SSOT 계약 유지. 글로서리 의미만 "활성 Live Tab의 code 투영"으로 확장.

**4. 영속화는 옛 `replay.tabs.v1` 패턴 복원** → `live.tabs.v1`. 버전 키 + 디바운스 250ms + load→validate→fallback.
저장: code·timeframe·historicalFromDate·label + `activeIndex`. 미저장: id(nanoid 재발급)·bundles·status·cursor.
기존 `live.page.v1` → 탭 1개로 마이그레이션.

**5. UI는 DESIGN.md §Tabs + 승인 목업 그대로.** 소프트캡 8(초과 시 토스트, 침묵 축출 금지). 닫기 = × + 미들클릭,
활성 탭 닫으면 오른쪽 이웃 focus. 마지막 탭 = 기존 `LiveEmptyState`. 키보드는 **비수정자만**(`[`/`]`·평키 1-9) —
`Ctrl+W/T/Tab`은 브라우저 예약이라 폐기(`useLiveKeyboard`가 이미 ctrl/meta/alt를 early-return).

## Why

- **탭별 timeframe**: 멀티 종목 감시의 핵심 가치(삼성=1분봉 스캘핑, 지수=일봉 맥락). timeframe은 옛 모델에서
  `code` 옆 **선택 상태**였지 분석 pref가 아니다 → 탭별이 자연스럽고 prefs 인디렉션을 건드리지 않는다(필드 1개).
- **분석설정 전역**: 탭별 ChartViewPrefs는 삭제한 `Map<tabId>` 인디렉션 부활 = accidental complexity, 모든
  projector에 blast radius. 지표는 보통 한 번 맞춰 어디서나 같게 쓴다. 필요 시 나중에 탭별 승격은 reversible.
- **activeCode 유지**: 파생 셀렉터로 바꾸면 읽기 15곳 + ADR-0052 불변식 변경(blast radius 큼). 유지+동기화는
  "make the change easy, then make the easy change" — 읽기 인터페이스 불변, 탭이 writer.
- **Ctrl 단축키 폐기**: 앱이 브라우저에서 돈다 — `Ctrl+W`=브라우저 탭 닫힘(3am 참사). 기존 비수정자 패턴 준수.

## 대안과 기각

- **옛 모델대로 전부 탭별(ChartViewPrefs 포함)**: 깔끔하지만 삭제한 인디렉션 부활 + projector blast radius. 기각.
- **전부 전역(timeframe도)**: 가장 작은 diff지만 멀티 종목 감시의 timeframe 가치 상실. 기각.
- **activeCode 파생값화**: 읽기 15곳 + 글로서리 불변식 변경. blast radius 대비 이득 없음. 기각.
- **소프트캡 초과 시 oldest 축출**: opened 탭 침묵 손실. 옛 모델도 `confirmEvictOldest`(확인 후)였음. 토스트 무시 채택.
- **warm 멀티구독(배경 탭도 실시간)**: KIS 등록 한도(계좌당 ~10종목) 충돌 + lifecycle 복잡. Live Set이 상위 N을 이미 warm. 기각.

## Consequences

- **CONTEXT.md 정정 필요**: (a) `activeCode` 엔트리 — "활성 Live Tab의 투영" 추가, (b) **신규 "Live Tab" 용어**,
  (c) `auctionWindowMask`·`ratioOutlierFilter`·`fillStrengthCumulative`의 stale **"per-tab" → "global"**
  (멀티탭 제거 후 안 치워진 잔재 — ChartViewPrefs는 이미 "global"로 정의됨; 이번에 탭이 돌아와도 전역 유지라 정정이 맞다).
  L301 `_Avoid_ "per-tab prefs"`는 **유효**(탭이 돌아와도 prefs는 전역) — 본 ADR 포인터 추가.
- 글로서리 용어 추가/정정은 **구현 PR에서** 반영(CONTEXT.md는 현재 상태를 기술하므로 탭 구현 전 선반영 금지). 본 ADR의 L301 포인터·stale 정정만 선행.
- 옛 `state/tabs.ts`/`replay.tabs.v1` spec이 Layer-1 레퍼런스 — 구현은 재발명이 아니라 복원.

## Addendum — 단일-탭 내비게이션 모델 (2026-06-12)

원안의 클릭 동작 `openOrFocusTab`("같은 Code 탭 있으면 포커스, 없으면 새 탭 생성, 소프트캡 도달 시 무시")을
**`setActiveTabCode`("활성 탭의 Code를 제자리 교체, 활성 탭 없으면 첫 탭 생성")**로 개정한다. 사용자 피드백:
관심종목 클릭마다 탭이 늘고 캡 도달 시 침묵 무시되는 것보다, **브라우저 탭처럼 "링크 클릭=현재 탭 이동,
새 탭은 `+`로만"** 모델이 직관적이다.

- **클릭/검색/드롭 = 현재 탭 교체**: 관심종목·스크리너·히트맵 행 클릭, 헤더 검색 선택, **관심종목 행을 차트로
  드래그-드롭** — 모두 `setActiveTabCode`로 활성 탭의 Code를 바꾼다(공용 `useJumpToLive`). 같은 Code가 다른
  탭에 있어도 포커스하지 않고 현재 탭을 교체한다(**중복 허용**). 새 탭은 만들지 않는다.
- **새 탭 = `+`만**: 탭바 `+`는 `addBlankTab`으로 빈 탭(`code=''`, 빈 상태 = 검색 안내)을 만들고 검색창에
  포커스를 준다. 소프트캡(8)은 `+`(수동 추가)에만 적용. 마운트 시 복원된 탭이 없으면 기본 빈 탭 1개를 시드해
  항상 "현재 탭"이 존재하게 한다(클릭이 교체할 대상 보장).
- **activeCode 단일 writer(D4) 불변**: 여전히 활성 탭이 `applyTabToPage`로 `useLivePageStore.activeCode`를
  쓰는 유일 writer. 종목 교체 시 `timeframe`은 유지, `historicalFromDate`(pan)는 새 종목 기본 뷰로 초기화.
- **드래그-드롭 구현**: 관심종목 행의 dnd-kit 재정렬 제스처를 **그대로 재사용**한다(별도 네이티브 draggable을
  얹으면 pointermove 충돌로 재정렬이 깨짐). `onDragEnd`에서 드롭 좌표(`activatorEvent`+`delta`)가 차트 위인지를
  **LiveWorkarea가 `entryDrag`에 등록한 히트테스트 술어**로 판정해(패널은 차트 DOM·rect를 모른다 — DndContext가
  다른 트리라 useDroppable 등록 불가) 현재 탭 교체, 밖이면 기존 재정렬. 드래그 중 워크에어리어에 "여기에 놓아
  종목 변경" 오버레이(드래그 고스트는 패널 overflow에서 잘리므로 워크에어리어 자체가 어포던스). `state/entryDrag.ts`가
  차트-드롭 seam의 단일 소유자(드래그 상태 + 차트 히트테스트 등록 + `isPointOnChart`).
- **제거**: `openOrFocusTab`(스토어·콜러·테스트 전부 `setActiveTabCode`/`addBlankTab`로 대체).

## Addendum — 무제한 탭 + bounded UI 투영 (2026-06-16)

초기 소프트캡 8 정책은 `/live` 사용자가 여러 종목을 길게 열어두는 실제 워크플로와 맞지 않아 폐기한다.
탭 생성은 논리적으로 무제한이며, 초과 탭을 조용히 버리거나 `+`를 막지 않는다. 대신 한 줄 탭바 오른쪽에
`+`와 전체 탭 목록 버튼을 고정하고, 많은 탭은 검색 가능한 overflow dialog에서 찾는다.

리소스 정책은 "무제한 데이터 구조를 전부 DOM/localStorage에 투영하지 않는다"이다.

- **구독/차트 인스턴스는 여전히 active tab only**: D1의 cold-swap 결정은 유지한다. 백그라운드 탭은 KIS
  구독이나 차트 DOM을 추가로 만들지 않는다.
- **탭바 렌더링은 active-centered bounded window**: 실제 탭 배열은 보존하되, 한 줄 탭바는 활성 탭 주변
  일부와 ellipsis marker만 렌더한다. `+`와 목록 버튼은 탭 수와 무관하게 고정 위치를 유지한다.
- **overflow 목록도 bounded render + search**: 목록 dialog는 검색 결과를 제한된 수만 렌더한다. 검색은 전체
  탭 배열에 대해 수행하므로 렌더 window 밖의 오래된 탭도 찾아갈 수 있다.
- **영속화는 bounded snapshot**: 복원 가능한 탭 수를 실무적으로 충분히 큰 active-centered window로 제한해
  localStorage quota와 reload freeze를 피한다. 이는 사용자-visible 탭 생성 제한이 아니라 browser storage
  안전장치다.

## Addendum — 오버플로 어포던스 배선 + 탭 목록 메뉴 공용화 (2026-07-13)

2026-06-16 addendum의 "한 줄 + bounded window + 검색형 overflow dialog" 모델은 메커니즘만 있고
어포던스가 없었다. 스크롤바를 숨긴 채(`scrollbarWidth: 'none'`) 대체 단서가 없어 "탭이 넘쳤다"는
사실 자체가 발견 불가능했고, ellipsis 마커는 24개 초과 시에만 등장하는 비인터랙티브 장식이었으며,
`/study`에는 overflow dialog가 아예 없었다. 이를 `ChartTabBar` 한 곳에서 채운다.

- **가장자리 페이드 마스크**: 스크롤 여지가 있는 쪽에 28px `mask-image` 그라디언트. 좌/우 독립,
  scroll 이벤트 + ResizeObserver + 탭 배열 변경 시 재측정.
- **세로 휠 → 가로 스크롤**: 탭바 위에서 `deltaY`를 `scrollLeft`로 변환. `preventDefault`가 필요해
  non-passive 네이티브 리스너를 쓰고, `deltaX` 우세(트랙패드 가로 제스처)면 기본 동작에 맡긴다.
- **`+N` 가려짐 칩**: 가려진 탭 수 = 렌더 윈도우 밖으로 잘린 탭 + 뷰포트 밖으로 스크롤된 탭
  (탭 중심점 기준). 0 초과일 때만 탭바 우측 고정 영역에 나타나고, 클릭하면 탭 목록 dialog를 연다.
- **탭 목록 메뉴 공용화**: `LiveTabOverflowMenu`를 제네릭 `tabs/ChartTabOverflowMenu`(controlled
  open)로 이관해 `ChartTabBar`에 내장. `/live`·`/study` 모두 목록 버튼과 칩 경로를 얻는다.
  라벨은 탭바와 동일 렌더러(`renderLabelParts.full ?? renderLabel`)를 주입받아 검색도 표시 라벨
  기준으로 동작한다.

기각: Chrome식 탭 폭 압축. `/live` 탭 라벨은 종목명 + 실시간 등락 metric을 담고 있어 폭을 줄이면
정보가 먼저 죽는다. 폭 고정 + 스크롤 + 목록이 이 앱의 정보 밀도에 맞다.

### 후속 (2026-07-13, 2차): 도달 수단 마무리

- **`…` 마커 인터랙티브화**: 렌더 윈도우 밖 개수를 aria-label로 노출(`이전/다음 탭 N개 목록 열기`)하고
  클릭하면 탭 목록 dialog를 연다. 비인터랙티브 장식이던 것을 발견 경로로 편입.
- **스크롤 화살표 `‹ ›`**: 스크롤 여지가 있는 쪽에만 표시, 클릭당 뷰포트의 ~60%(최소 120px)를
  smooth 스크롤. 마스크된 tablist 밖(고정 영역)에 배치해 스크롤과 무관하게 유지.
- **`/study` 키보드 탭 순환**: `[`/`]` 랩어라운드 순환을 `useStudyKeyboard`에 추가해 `/live`
  (`useLiveKeyboard`, 기존 구현)와 동일한 모델로 정렬. 배선은 각 페이지가 소유(탭 스토어가 달라서).
