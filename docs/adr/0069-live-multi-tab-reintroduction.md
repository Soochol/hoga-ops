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
