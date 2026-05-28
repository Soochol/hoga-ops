# 0048 — /live D-direct daily backfill: 별도 endpoint + 메모리 cache, ADR-0040과 병렬

**Status:** accepted (2026-05-28)

**Related:**
- ADR-0013 (RangeBundle single read-path)
- ADR-0020 (invariant catalog)
- ADR-0040 (Live Candle Backfill 별도 cache + 별도 wire)
- ADR-0045 (spec declares invariants)
- `docs/superpowers/specs/2026-05-28-live-daily-direct-backfill-design.md`

## Decision

`/live` 페이지의 일봉(D/W/M) backfill 은 신규 endpoint
`GET /api/live/past-daily-candles` 가 서비스한다. 분봉 endpoint
`GET /api/live/past-candles` 와 형제 구조:

1. **별도 endpoint + 별도 wire**. `LivePastDailyCandlesResponse` 모델,
   `cached_batches` / `fresh_batches` per-batch metadata.
2. **메모리 only cache** (디스크 안 둠). 일봉 데이터는 작아서 (~250 KB / code /
   20년) 디스크가 불필요. process restart 가 자연 invalidation.
3. **별도 KIS client method**. `fetch_past_daily_candles` (TR_ID `FHKST03010100`,
   period_div_code='D'). 반환 타입 `DailyCandleFetchResult` 가 invariant
   violation 을 caller 로 surface.
4. **Cap 없음**. 분봉의 250-day cap 과 달리 D-direct 는 무제한;
   rate-limit/api-error 는 partial response + data_warnings 로 처리.

본 ADR 은 ADR-0040 과 *병렬 supersede 아님*. 두 균열은 같은 `/live` 도메인 안에
갇혀 있다 — ADR-0013 의 spirit 과의 균열이 두 개로 늘어났지만 *지역성*은 보존.

## Why

분봉 250 일 캡의 본질은 *payload 보호*. 캡 없이 5년치 일봉을 1분봉 경유로 전송하면
N × ~96,000 bars JSON 으로 폭발. D-direct 는 같은 비용을 ~1/390 로 줄여 캡을 자연
무관하게 만든다.

W/M 는 별도 backend serving 하지 않는다 — D 는 한 종목 5년치 ~1,250 bars 로
client 의 `aggregateCalendar` 비용 무시 수준. cache 1개로 충분.

메모리 only 정당화: 분봉의 disk cache 는 *데이터 양* (~300 MB worst case) 때문에
필요. 일봉은 ~12 MB worst case → 메모리에 다 들어감. 디스크 file format / atomic
write / corrupt file handling / "operator deletes cache file to refresh" 같은
복잡도가 모두 사라짐. restart 시 cold start ~10-30 초는 단일 사용자 로컬 dev tool
에서 수용 가능 (사용자 동의).

## Trade-offs

- **(채택) 메모리 only.** restart = 자연 invalidation. dev workflow 의 `--reload
  --reload-dir hoga` 가 자주 restart 를 트리거하므로 dev iteration 비용 있음;
  견디기 어려우면 future spec 으로 optional disk persistence 추가.
- **(거부) disk persistence (분봉 패턴 답습).** 일봉의 작은 데이터 양에서 disk
  cache 의 *복잡도 비용 > 영속성 이득*. cache 가 stale 한 상태로 영속할 위험
  (KIS data 정정 시) 도 자동 제거.
- **(채택) 무제한 cap.** KIS 보유 기간 ~20-30 년이 자연 상한. rate-limit 은
  partial response 로 처리.
- **(거부) `bucket=D` query 분기.** 한 endpoint 가 두 응답 스키마를 갖는 비용 >
  두 endpoint 비용.
- **(채택) `DailyCandleFetchResult` 로 violation surface.** 분봉의 silently-skip
  패턴과 달리, 일봉은 violation 을 caller 로 명시 전달하여 wire `data_warnings`
  surface. KIS data 이상이 cache 안에 영구 묻히는 위험 회피 (grill Q3).

## Consequences

- ADR-0013 의 spirit 은 두 번째 균열을 흡수. read-path 단일성 정책은 이제
  *RangeBundle 도메인 한정* + *분봉 / 일봉 wire 는 별개 도메인* 으로 재독해.
- CONTEXT.md "Live Candle Backfill" entry 가 두 endpoint (분봉 + 일봉) 를 모두
  설명하도록 갱신. LiveTimeframe entry 의 "D/W/M is frontend-only" 도 함께 갱신.
- ADR-0040 의 Trigger Conditions 는 그대로 — 본 ADR 은 그 조건을 발동시키지 않음.
- `clampEngaged` 의미가 timeframe 별로 분기됨: 분봉은 250 d 한도 지표, 일봉은
  항상 false.
- 분봉 path 의 `PastCandlesCache` 도 본 spec 의 scope 안에서 tri-state today
  + negative caching 으로 확장 (wire/namespace zero diff). 두 cache 가 같은
  tri-state 패턴을 공유.

## Trigger Conditions

(미래에 본 ADR 을 supersede 할 조건)

- 메모리 cache 가 자주 cold start 되어 KIS 호출 양이 의미있는 비용이 되면 →
  optional disk persistence 추가 (본 ADR 의 trade-off 재평가).
- `/replay` 페이지가 KIS daily candle 을 필요로 함 → unified path 필요성 강화.
- per-batch overlap 이 메모리 사용량에서 의미있는 비중을 차지 (~10 MB 이상 / code).
