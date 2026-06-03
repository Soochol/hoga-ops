# Live 분봉 좌측 팬: 고정 3거래일 스텝 점진 채우기 (42일 1-shot 청크 폐기, prefetch 미채택)

**Status:** accepted (2026-06-03)

**Related:**
- ADR-0040 — Live Candle Backfill은 별도 cache namespace + 별도 wire
- ADR-0050 — KIS rate-limit(`EGW00201`) 지수 backoff + `data_warnings` surface
- `docs/superpowers/specs/2026-06-03-live-minute-dynamic-chunk-fetch-design.md`

## Decision

`/live` 분봉 차트의 좌측 팬(과거 backfill)을 **고정 42일 1-shot 청크**에서
**고정 3거래일 스텝 점진 루프**로 바꾼다: 한 번의 좌측 팬에서 3거래일분씩
`nextHistoricalFrom`을 반복 호출·prepend하며 **viewport가 캔들로 찰 때까지
(visible logical `from ≥ 0`)** 자가 전진하고, 250일 clamp / 데이터 끝에서
종료한다. 동시에 **백그라운드 prefetch는 채택하지 않는다**(모든 KIS 호출은
사용자 드래그로만 발생).

효과: 어떤 줌/뷰 폭에서도 **첫 그림이 ~3.4초 안에**(3거래일 × 측정 1.14초/거래일)
보장되고(latency cap), 기존의 "줌 무관 42일을 한 번에 cold로 긁어 32초 stall"이
사라진다. 넓은 구간은 3거래일씩 점진적으로 채워진다(진행 표시).

## Why — 42일 holiday-clearing 근거는 obsolete

`liveDateTime.ts:107-114`의 주석은 42일 청크를 쓴 이유를 명시한다: *"짧은 청크는
비거래일(주말/단일 휴일)에 떨어져 livePage store의 monotonic-decrease guard를
동결시켰다 → 그래서 21일×2≈42일로 키웠다."* 본 결정은 그 근거를 뒤집으므로,
미래 독자가 3거래일 스텝을 보고 "동결 버그를 되살린 것 아닌가" 오해해 42일로
되돌리지 않도록 명문화한다.

동결이 더 이상 문제가 아닌 이유:

1. **cur-base `nextHistoricalFrom`** (`liveDateTime.ts:152-162`)이 동결을 처리한다.
   한 스텝이 거래일 0개(연휴)를 반환해 axis가 안 움직여도, 다음 스텝은
   `historicalFromDate − stepDays`로 또 과거로 내려간다(axis-base가 아니라
   cur-base). 즉 "작은 청크가 비거래일에서 동결"되던 실패 모드 자체가 이미
   별도로 막혀 있다.
2. **viewport 채움은 스텝 크기가 아니라 루프가 한다.** 42일이 컸던 또 다른 암묵
   목적("한 팬에 화면을 다 채운다")은 이제 "viewport 찰 때까지 스텝 반복"이
   대신한다. 따라서 스텝은 클 필요가 없고, 작을수록 첫 그림이 빠르다.

3거래일(≈5 캘린더일)은 주말 1회를 한 스텝에 덮어 빈 결과 재드래그를 막는
**최소 안전값**이며, `MIN_TRADING_DAYS` 단일 상수라 실측 후 조정 가능하다.

## Why — prefetch 미채택

원안은 settle 후 다음 청크를 1-ahead로 백그라운드 워밍하려 했으나 거부했다:
연속 드래그는 1-ahead가 못 따라잡고(스텝 ~1.5화면폭을 1~3초에 소진 vs cold
~3.4초), 간헐 팬은 스텝 점진 채우기만으로 이미 ~3.4초라 prefetch의 추가 이득
(2번째 peek instant)이 배선 + KIS 백그라운드 호출 + 캐시 증가(ADR-0040의 50MB
trigger, ADR-0050의 rate-limit) 비용을 정당화하지 못한다. 연속 드래그 near-zero가
필요하면 "clamp까지 점진 백그라운드 워밍"이 별도 follow-up이다.

## Considered options

- **(채택) 고정 3거래일 스텝 점진 루프, prefetch 없음.** latency cap 보장 +
  최소 변경(트리거 방식 교체, prepend/clamp/viewport-shift 기존 코드 재사용).
- **(거부) viewport 폭 동적 청크 1-shot.** 원안. 줌아웃 시 한 청크가 커져 다시
  단일 긴 stall(예 15거래일 ≈17초)을 만든다 — latency cap 없음.
- **(거부) 캔들-개수 전송으로 백엔드 재설계.** KIS 분봉 API가 앵커+개수 기반이라
  가능하지만, 날짜별 디스크 캐시(`<YYYYMMDD>.json`, 재방문 0.01초 warm의 근거,
  ADR-0040)를 잃는다 — 측정된 이득의 회귀라 거부.
- **(거부) 1-ahead 백그라운드 prefetch.** 위 "prefetch 미채택" 사유.

## Consequences

- `prefetchChunkCandlesFor`/`prefetchChunkDaysFor`(고정 42일)는 삭제 또는 3거래일
  스텝 헬퍼로 대체. `nextHistoricalFrom`은 `tf` 대신 `stepDays` 주입형으로 변경.
- 점진 루프는 한 팬에서 prepend를 **N회** 수행하므로, atomic-prepend·viewport-
  preservation invariant가 **매 스텝** 성립해야 한다. 특히 프로그램적 스텝 2..N의
  `viewportShiftRef` 캡처는 기존 드래그-핸들러 동기 캡처를 우회하므로, spec의
  Open Question(기본: settle-effect 명시 캡처)을 구현 첫 태스크에서 확정한다 —
  미해소 시 스텝마다 viewport 점프로 퇴화.
- 연휴 첫 통과 시 `_date_iter`(api.py:50)가 휴장일도 1회씩 헛호출(빈 결과 캐시).
  근본 해결(백엔드 주말/휴일 사전 스킵 + `FID_PW_DATA_INCU_YN=Y`)은 §1과 직교한
  **별도 후속**, 본 ADR 범위 밖.
- 착지 시 CONTEXT.md **Live Candle Backfill** 항목에 "분봉 좌측 팬은 3거래일
  스텝 점진 채움" 한 줄 추가.
