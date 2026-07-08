# 0092 — Dual-Horizon 캐시 프리미티브 (과거=불변 / 오늘=TTL)

**Status:** accepted (2026-07-08)

**Related:**
- ADR-0040 / ADR-0048 — /live 분봉·일봉 메모리 캐시 (과거 배치 + 오늘 TTL 이원 구조)
- ADR-0043 — Today Promotion: 오늘 지표는 영속 캐시 금지 (오늘 지평 short-TTL의 근거)
- ADR-0090 (today-indicator short-ttl) — 오늘 지표 15s TTL 메모 (같은 today 지평 패턴)
- ADR-0091 — /live 분봉 예산 + 청크 워크백 (past 지평 2단 LRU의 사이징 근거)
- PR-1 (캐시 관측 표준화) — 이 프리미티브가 재노출하는 `CacheStats` 도입

## Context

/live 캐시 하향식 설계 검토(2026-07-08)에서 데이터가 5개 정책 클래스로 접혔고, 그중
**"과거 = 불변(영구 저장) / 오늘 = 유동(TTL tri-state)"** 이원 패턴이 네 캐시에 손으로
반복 구현돼 있음이 드러났다:

- `PastCandlesCache` (분봉) — 과거 2단 LRU + 오늘 60s TTL tri-state
- `PastDailyCandlesCache` (일봉) — 과거 배치 LRU + 오늘 60s TTL tri-state
- `PastIndicatorsCache` (지표) — 과거 디스크 read-through + 메모리 LRU (오늘 지평 없음, ADR-0043)
- `IndexCandlesCache` / `IndexMinuteCandlesCache` (지수) — 과거 LRU

같은 "오늘 tri-state(hit/miss/negative) + TTL 만료 + LRU" 코드가 캐시마다 자구 수준으로
복제돼, 새 지표·데이터 타입을 추가할 때마다 "오늘 정책을 어떻게 하지?"를 매번 판단하고
승격 경계 버그를 각자 재발명할 여지가 있었다.

## Decision

`hoga/util/cache_primitives.py`에 이원 패턴의 두 반쪽을 추출한다:

- **`LruDict[K,V]`** — 유계 OrderedDict + 축출 시 `CacheStats` 계수. 자동 축출이 아니라
  `trim()` 명시 호출(기존 손코딩 `_trim_lru`와 동일 의미 → 동작 보존 이식).
- **`TtlTriStateCache[K,V]`** — 오늘 지평: `(fetched_at, value)` + TTL 만료(`elapsed >= ttl`
  포함 경계) + LRU + tri-state 접근자. `None` 저장 = "negative"(수집됐으나 무데이터). clock은
  기본 late-lookup `time.monotonic()`(테스트 패치 관측 가능).
- **`DualHorizonCache[P,T]`** — past(`PastStoreLike` Protocol) + today(`TtlTriStateCache`)
  조합 홀더. 도메인 캐시는 horizon 부기를 재구현하는 대신 `.past`/`.today` 위에 얇은
  파사드로 공개 API를 얹는다.

이번 PR에서는 **`PastDailyCandlesCache` 하나만** 이식(가장 단순한 캐시로 패턴 검증).
합격 기준은 골든 스위트 `tests/unit/live/test_past_daily_candles_cache.py` **무수정 green**
— 비공개 속성명(`_per_key`/`_today_mem`)을 유지하고, 오늘 clock을 모듈-로컬
`lambda: time.monotonic()`로 넘겨 `past_daily_candles_cache.time.monotonic` 패치 seam을
보존한다.

## 보류 (의도적 미구현)

- **`PastCandlesCache`의 2단 코드-지역성 LRU**(per-code 쿼터 + 전역 예산, ADR-0091) —
  `PastStoreLike` Protocol을 만족하는 `TwoTierLruStore`로 나중에 `DualHorizonCache.past`
  자리에 꽂는다. 오늘 지평은 이미 `TtlTriStateCache`와 자구 동일이라 즉시 치환 가능.
- **`PastIndicatorsCache`의 디스크 read-through** — 같은 `PastStoreLike`를 만족하는
  `ReadThroughStore(mem, load/persist)`로 수용. 오늘 지평 없음(ADR-0043)은 그대로.
- 추상 베이스 클래스, today 변종 통합은 과설계 회피 위해 하지 않는다.

`PastStoreLike`(`__contains__`/`__len__` 덕타이핑)가 이 확장들이 홀더 변경 없이 들어올
seam이다. 분봉 디스크 영속(하향식 검토의 최대 gap — 재시작 = KIS 쿼터 재지출)은 이
프리미티브의 past 슬롯에 디스크 read-through를 꽂는 방식으로 후속(관측 데이터 게이트)에서
다룬다.

## Consequences

- 신규 캐시가 이원 패턴을 재발명하지 않고 조합으로 표현 → 승격 경계 버그를 한 곳에서 수정.
- `CacheStats`(PR-1)가 프리미티브 축출/조회 지점에 자연 결합(선택적 `stats=` 인자).
- 일봉 캐시 동작·통계 shape 불변(골든 + 계측 테스트 green). 분봉·지표·지수 이식은 후속.
- 번호 주의: `docs/adr/`에 `0090`이 둘(warm/read-ahead, today-indicator-ttl) 존재 —
  이 ADR은 0092로 채번(중복 회피).
