# Closing Auction Window — 호가비·총잔량 걸침 버킷 정화 (Straddle-Bucket Decontamination) — Design

**Date**: 2026-06-03
**Status**: Approved
**Scope**: `hoga/api/bundle.py` (`build_quote_ratio_slice`, `build_range_bundle`), `frontend/src/live/bucketHogaSeries.ts`

> 새 분기가 아니라 **기존 버킷 집계 규칙의 정제**다. 캔들·거래량·체결강도·표시
> 마스크·`auctionWindowMask` 토글은 건드리지 않는다.

## Problem

`/live` 차트에서, **15:20이 버킷 경계가 아닌 타임프레임**(3m·15m·30m)일 때
**호가비(Quote-Ratio Imbalance)·총잔량(Quote Totals)** 지표가 종가 동시호가
구간(15:20–15:30)의 호가창을 계산에 끌어들인다.

사용자 표현 그대로:

> "예를들어 3분봉으로 보고 있는데, 15:18 데이터에 15:18,19,20분 데이터가
> 들어가다 보니 보조지표가 15:20 데이터를 계산하고 있는 문제가 있어서 그래."

**근본 원인 (코드로 확정):**

- 호가비·총잔량은 둘 다 `quote_ratio.points`를 소스로 쓰고, 버킷 대표값은
  **"버킷 내 마지막 스냅샷이 이김"(last-in-bucket, 캔들 종가와 같은 state 개념)**.
  - 프론트(today live): `frontend/src/live/bucketHogaSeries.ts:33,46-52` —
    `quoteByBucket.set(t, …)`를 시간 오름차순으로 덮어써 마지막 스냅샷이 남음.
  - 백엔드(과거 날짜): `hoga/api/bundle.py:143-148` —
    `ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY ts_ms DESC) … WHERE rn = 1`
    = 버킷 내 가장 늦은 ts_ms.
- 3m 버킷 `[15:18, 15:21)`은 시작이 15:18 < 15:20이라 **표시 마스크
  (`auctionWindowMask`, `inClosingAuctionWindow`은 버킷 *시작* 시각만 검사)를
  빠져나간다**. 그런데 이 버킷의 "마지막 스냅샷"은 15:20:xx 동시호가 호가창
  (한쪽으로 쏠려 누적되는 비연속 상태)이라, 호가비·총잔량 대표값이 오염된다.
  (버킷 *timestamp*은 그대로 15:18:00 — 백엔드 `bundle.py:147`이
  `bucket * bucket_ms`를 반환하고, 프론트도 `set(t=floor…, …)`로 라벨링한다.
  오염되는 건 그 버킷의 *값* `bid_total/ask_total`뿐이고 x축 위치는 불변.)

**영향 타임프레임:** 15:20(= epoch 기준 자정 이후 380분)이 버킷 경계가 아닌
**3m·15m·30m**. 1m·5m·10m은 15:20이 정확히 버킷 경계라 걸침이 없다(영향 없음).

**영향 지표:** **호가비·총잔량 2개만**. 체결강도(FillStrength)는 양쪽 경로 모두
매수/매도 합산이 `side = ±1`만 집계한다 — 프론트 `bucketHogaSeries.ts:65-66`
(`if (side===1)` / `else if (side===-1)`), 백엔드 `bundle.py:321-322`
(`SUM(CASE WHEN side=1 …)` / `SUM(CASE WHEN side=-1 …)`). 동시호가 체결
(`side=2`)은 어느 합에도 **0으로** 들어가므로 **값이 오염되지 않는다 — 면역**.
(주의: 백엔드 `WHERE side != 0`은 side=2 *행*을 거르지 않지만, 그 행은 두 SUM에
0을 더할 뿐 값에 영향이 없다. side=2-only 버킷이 `(0,0)` 포인트로 남는 건
완전-동시호가 버킷이라 표시 마스크가 가린다 — Out of Scope의 선택적 정리 참조.)

## Invariants

이 spec이 건드리는 quote_ratio 버킷 집계가 **현재 보존하고 있는** 속성들:

- **Quote bucket = bucket-start 정렬 + state 대표값**: 호가비·총잔량 버킷은
  `floor(t / bucket_ms) * bucket_ms`로 라벨링되고, 버킷 값은 그 구간의 *상태*
  (마지막 호가창 스냅샷)다(flow가 아님). 근거: `bucketHogaSeries.ts:30-52`,
  `bundle.py:114-163`.
- **X축 정렬**: 호가 버킷 경계가 캔들·거래량 버킷 경계와 동일하게 떨어져
  같은 `UTCTimestamp` 격자에 정렬된다. 근거: `bucketHogaSeries.ts:30`
  ("Matches aggregateCandles.ts convention so candle/volume/호가 align").
- **연속체결-only 메트릭 (체결강도)**: 체결강도는 동시호가 체결을 집계에서
  제외한다. 근거: `bucketHogaSeries.ts:37,65-66`, CONTEXT.md "FillStrength".
- **Auction Mask 토글 의미 (ADR-0029)**: `auctionWindowMask` ON이면 시작이
  `[15:20, 15:30]`에 든 indicator 점을 *표시상* 숨기고, OFF면 드러낸다.
  근거: `chart/util/auctionHide.ts`, `chart/projectors/ratio.ts`,
  `chart/projectors/quoteTotals.ts`, `docs/adr/0029-auction-mask-hide-not-zero.md`.
- **Wire 계약 (`RangeBundle.quote_ratio.points`)**: `{t, bid_total, ask_total}`
  배열 형태와 버킷 timestamp 격자가 고정. 근거: `api/types.ts`, ADR-0004.
- **Half-Day 안전성**: 동시호가 윈도우는 `session_close − 10분`으로 *길이*
  앵커(고정 오프셋 아님)라 12:30 마감일도 12:20–12:30으로 따라간다. 근거:
  `util/sessionTime.ts:46,62-69`, `hoga/api/disk_state.py:261,312`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Quote bucket = bucket-start + state 대표값 | **intentionally breaks (걸침 버킷 한정)** | 대표값 선택을 "마지막 스냅샷"→"마지막 *15:20 이전* 스냅샷 우선"으로 정제. 버킷 라벨·경계는 불변. |
| X축 정렬 | preserves | 버킷 경계를 안 바꾸고 *어느 스냅샷을 대표로 쓰는지*만 바꿈. |
| 연속체결-only (체결강도) | preserves | 체결강도 코드 미변경. 본 변경으로 호가비·총잔량이 *걸침 버킷에 한해* 같은 철학에 합류. |
| Auction Mask 토글 의미 | preserves | 완전-동시호가 버킷(시작 ≥ 15:20)은 대표값 그대로 → 토글이 계속 표시/숨김 제어. |
| Wire 계약 | preserves | 배열 형태·버킷 timestamp 격자 동일. 걸침 버킷의 *값*만 정화됨(의도). |
| Half-Day 안전성 | preserves (백엔드) / **breaks conditionally (프론트 live)** | 백엔드는 per-date meta로 정확. 프론트 live는 오늘 `session_close`를 15:30 폴백으로 잡아 반장일 오늘분만 미정화 — Risks 참조. |

**"intentionally breaks" 정당화 (Quote bucket 대표값):** 걸침 버킷은
*연속거래 시간대에서 시작하는* 버킷이다("3분봉 15:18"은 연속거래 봉이다).
그 대표 상태를 비연속 동시호가 호가창으로 잡는 것은 사용자가 지적한 대로
오해를 부른다. 대표를 "마지막 연속거래(15:20 이전) 스냅샷"으로 잡으면 봉의
정체성과 값이 일치한다. 이는 백엔드가 이미 채택한 규칙과 일관된다 —
`has_meaningful_gaps`(`disk_state.py:279-316`)는 분석 윈도우를
`[09:00, session_close − 10min)`으로 잡아 "동시호가 윈도우 스냅샷은 제외:
연속 매칭이 없으니 churn 부재는 정상"이라 명시한다.

## Goals

- 호가비·총잔량 버킷 대표값이 **15:20 이후 호가창 스냅샷을 절대 쓰지 않는다**
  (단, 버킷 전체가 동시호가인 경우는 예외 — 아래 Design 참조).
- 걸침 버킷(3m 15:18 등)은 **정화된 값으로 계속 표시**된다(B안: 숨김이 아니라
  정화). 15:00–15:20 같은 합법 연속거래 데이터는 보존된다.
- 백엔드(과거 날짜)·프론트(오늘 live) **양쪽 경로** 모두 적용.
- 회귀 테스트로 "걸침 버킷 정화"와 "깨끗한 타임프레임(5m) 무회귀"를 모두 못박는다.

## Non-Goals

- **체결강도(FillStrength)·누적 순체결강도** 미변경 — 양쪽 경로에서 이미
  연속체결만 집계해 면역. projector·합산 로직·zero-baseline 손대지 않음.
- **표시 마스크(`auctionWindowMask`)·토글·`AuctionWindowOverlay`·ADR-0029의
  hide 동작** 미변경. 완전-동시호가 버킷은 여전히 토글이 제어.
- **캔들·거래량** 미변경(이미 15:20 이후 mute/표시 규칙 보유, ADR-0018).
- **이동평균선(MA)** 미변경(사용자 확정: 대상 아님).
- **버킷 경계 재정렬**(15:20을 hard boundary로 쪼개는 방식) 안 함 — X축 정렬을
  깨고 캔들과 어긋날 위험. 대표값 선택만 바꾼다.
- **프론트 live half-day 정화** 안 함(Risks의 known limitation).

## Design

### 핵심 규칙 (양쪽 경로 공통)

버킷 대표 스냅샷 선택을 다음으로 정제한다:

> **버킷 내 마지막 *15:20 이전(`< auction_start`)* 스냅샷을 대표로 쓴다.
> 그런 스냅샷이 하나도 없으면(= 버킷 전체가 동시호가) 마지막 전체 스냅샷을
> 쓴다(기존 동작 유지).**

- `auction_start` = 그 Stock-Date의 `session_close_ms − AUCTION_WINDOW_LENGTH_MS`
  (10분). 경계는 **strict `<`** — `inClosingAuctionWindow`의 inclusive `≥ 15:20`과
  정확히 상보적이고, `has_meaningful_gaps`(`disk_state.py:315`)의 `< auction_start_linear`와
  동일.
- 결과:
  - **걸침 버킷**(시작 `< auction_start`, 일부가 동시호가): 15:20 이전 마지막
    스냅샷으로 정화 → 표시 유지.
  - **완전-동시호가 버킷**(시작 `≥ auction_start`): 대표값 불변 → 표시 마스크가
    계속 제어(ON이면 숨김, OFF면 동시호가 호가창 드러냄). 토글 의미 보존.
  - **15:20 이전 일반 버킷**: 영향 없음.

### 백엔드 — `build_quote_ratio_slice` (과거 날짜)

`hoga/api/bundle.py:114-163`. 윈도우 정렬을 2-tier로:

```sql
ROW_NUMBER() OVER (
  PARTITION BY ({intra_ms_expr} // {bucket_ms})
  ORDER BY ({intra_ms_expr} < {auction_start_linear}) DESC, ts_ms DESC
) AS rn
```

- `({intra_ms_expr} < {auction_start_linear})` boolean을 `DESC`로 정렬 → DuckDB는
  TRUE를 앞에 둠 → 15:20 이전 행이 우선, 그 안에서 `ts_ms DESC`로 마지막 것 선택.
  버킷에 15:20 이전 행이 없으면 모두 FALSE → `ts_ms DESC`로 마지막 전체 선택.
  `WHERE rn = 1` / `SELECT` 절은 그대로.
- `auction_start_linear` = `_hhmmssms_to_intra_ms(session_close_ms) − _AUCTION_WINDOW_DURATION_MS`
  (선형 ms-from-midnight). `intra_ms_expr`(`hhmmssms_to_intra_ms_sql`, `timeenc.py:47`)와
  같은 좌표계라 비교가 안전.
- **시그니처 변경:** `build_quote_ratio_slice(…, session_close_ms: HogaMs)`를 추가
  인자로 받는다. 호출부 `build_range_bundle`(`bundle.py:445`)는 루프 안에서
  이미 `meta["regular_session_close_ms"]`를 사용하므로(같은 iteration의 `:451-452`),
  그 값을 그대로 넘긴다. `_AUCTION_WINDOW_DURATION_MS`·`_hhmmssms_to_intra_ms`는
  `disk_state.py`의 기존 것을 재사용하거나 공용 위치로 승격(구현 판단).

### 프론트 — `bucketHogaSeries` (오늘 live)

`frontend/src/live/bucketHogaSeries.ts:38-52`. quote 루프만 변경. **버킷별
`seenPre` 플래그가 필요하다.** `!quoteByBucket.has(t)`만으로 auction을 채우는
순진한 2줄 버전은 완전-동시호가 버킷에서 *첫* auction 스냅샷이 남고(이후 auction이
`has(t)` true라 skip) → 백엔드(`ts_ms DESC` = 마지막)·기존 prod 동작(무조건
`set` = 마지막)·아래 단위테스트와 **어긋난다**(first vs last). auction 분기는
*다른 auction은 덮어쓰되 pre-auction은 절대 안 덮어써야* 하므로 "이 버킷에
pre-auction이 들어왔는지"를 추적한다:

```ts
const seenPre = new Set<number>();
for (const s of obSorted) {
  const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
  const val = { t, ask_total: s.total_ask_qty, bid_total: s.total_bid_qty };
  if (s.t_ms < auctionStartMs) {
    quoteByBucket.set(t, val);          // pre-auction: 마지막이 덮어씀
    seenPre.add(t);
  } else if (!seenPre.has(t)) {
    quoteByBucket.set(t, val);          // auction: pre-auction 없을 때만, 마지막 auction이 덮어씀
  }
}
```

- 걸침 버킷 `{15:18, 15:19, 15:20:30}` → **15:19**(마지막 pre)로 정화.
- 완전-동시호가 버킷 `{15:21, 15:22}` → **15:22**(마지막 auction) — 백엔드·기존
  동작과 일치(invariant "Auction Mask 토글 의미" 보존).
- `auctionStartMs` = `todaySession.close_ms − AUCTION_WINDOW_LENGTH_MS`(Unix ms).
  `bucketHogaSeries(ob, trade, bucketMs, auctionStartMs)`로 인자 추가.
- 호출부 `buildLiveBundle`(`frontend/src/live/buildLiveBundle.ts:78`)는 이미
  `todaySession.close_ms`를 보유 → 거기서 계산해 전달.
- fill 루프(`:55-69`)는 미변경.

### 데이터 흐름 요약

```
과거 날짜:  parquet snapshots ─► build_quote_ratio_slice(2-tier ORDER BY) ─► quote_ratio.points
오늘 live:  SSE ob snapshots ─► bucketHogaSeries(pre-auction 우선) ─► incrementalQR ─► merge
            둘 다 같은 RangeBundle.quote_ratio.points → ratio.ts / quoteTotals.ts projector(미변경)
```

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 백엔드 걸침 버킷 정화 | `build_quote_ratio_slice`, bucket_ms=180000(3m), 한 버킷에 15:18·15:19·15:20:30 스냅샷(서로 다른 bid/ask) | 대표 `bid_total/ask_total` == **15:19** 스냅샷 값 (≠ 15:20:30) |
| 백엔드 완전-동시호가 버킷 불변 | 버킷에 15:21·15:22 스냅샷만(15:20 이전 없음) | 대표값 == 마지막(15:22) — 기존 동작 유지 |
| 백엔드 깨끗한 타임프레임 무회귀 | bucket_ms=300000(5m), 15:15·15:18·15:19 스냅샷 (15:20이 5m 경계) | 대표값 == 15:19, 변경 전과 동일 |
| 백엔드 half-day 앵커 (invariant 회귀) | `session_close_ms`=123000000(12:30 마감), bucket_ms=180000(3m), 12:18·12:19·12:20:30 스냅샷 | 대표값 == **12:19** (≠12:20:30) — `auction_start`가 per-date 12:20으로 따라감을 증명 |
| 프론트 걸침 버킷 정화 | `bucketHogaSeries`, bucketMs=180000, ob에 15:18·15:19·15:20:30 | quoteRatioPoints의 15:18 버킷 == 15:19 totals |
| 프론트 완전-동시호가 버킷 불변 | ob에 15:21·15:22만(같은 3m 버킷, pre 없음) | 버킷 == 15:22 totals(`seenPre` 비어 있어 마지막 auction이 남음) |
| 프론트 fill 무회귀 | 동일 입력 | fillStrengthPoints 변경 없음 |

**Invariant 회귀 테스트**: "X축 정렬"·"Wire 계약" 보존을 위해 위 테스트들이
버킷 *timestamp 격자*가 변경 전과 동일함을 함께 단언한다(값만 바뀌고
key 집합은 동일). "Auction Mask 토글 의미" 보존은 "완전-동시호가 버킷 불변"
케이스가 증명한다.

### Manual verification

`/live`에서 호가 데이터가 있는 종목을 3m으로 보고, 마감 부근으로 스크롤:

- 토글 ON(기본): 호가비·총잔량이 15:18 버킷까지 표시되고, 그 값이 15:20
  동시호가가 아니라 15:19 직전 호가창을 반영(이전엔 15:20으로 튀던 값).
- 5m으로 바꿔 동일 구간 확인 → 변화 없음(무회귀).
- 토글 OFF → 완전-동시호가 버킷(15:21 등)이 다시 보임(토글 정상 작동).
- 체결강도 pane은 ON/OFF·타임프레임 모두에서 변화 없음.

## Risks / Open questions

- **프론트 live half-day 미정화 (known limitation, 고치지 않음):**
  `useLiveBundle.ts:151`에서 오늘 `session_close_ms`는 백엔드 `/api/live/series`가
  `None`을 보내 `regularSessionCloseMs`(15:30 하드코딩) 폴백을 탄다
  (`hoga/live/api.py:248`). 따라서 반장일(12:30 마감)의 **오늘분 live** 걸침
  버킷은 `auction_start`가 15:20으로 잘못 잡혀 정화되지 않는다. 과거 날짜는
  백엔드가 per-date meta로 정확히 처리하므로, 반장일 *다음날* 이후엔 정상.
  반장일은 연 수 회 + 그 날 마감 직전 호가비만 영향이라 v1 scope-out. 후속으로
  백엔드가 `session_close_ms`를 실제로 채워 보내면 자동 해소.
- **`auction_start` 헬퍼 위치:** `disk_state.py`의 `_hhmmssms_to_intra_ms` /
  `_AUCTION_WINDOW_DURATION_MS`를 `build_quote_ratio_slice`(같은 `hoga/api`)에서
  재사용할지, 공용 모듈로 승격할지는 구현 단계 판단. 동작엔 영향 없음.

## ADR impact

- **ADR-0029 (auction-mask-hide-not-zero)** 개정 메모 추가: 호가비·총잔량의
  *버킷 대표값 선택*이 "마지막 연속거래(15:20 이전) 스냅샷 우선"으로 정제됨.
  표시 마스크의 hide 동작·토글 의미는 불변 — 본 변경은 *데이터 레이어*의
  걸침 버킷 정화이고, 마스크는 *표시 레이어*로 직교한다. 토글 OFF 시 완전-
  동시호가 버킷은 여전히 드러난다(계약 유지).
- 새 ADR을 별도로 팔지(예: `0058-quote-bucket-continuous-trading-representative.md`)
  ADR-0029 개정으로 둘지는 구현 단계 판단 — `docs/agents/domain.md` 규칙 따름.

## Out of Scope (Backlog)

- 백엔드 `/api/live/series`가 today `session_close_ms`를 실제 값으로 채워 보내
  프론트 half-day 폴백 제거 (위 known limitation의 근본 해소).
- 표시 마스크가 데이터 레이어 정화와 중복되는 부분(완전-동시호가 호가비·총잔량
  버킷이 토글로만 가려지는 vs 데이터에서 빠지는) 정합성 재검토 — 지금은 토글
  보존을 우선해 의도적으로 양립.
- 백엔드 `build_fill_strength_slice`의 `WHERE side != 0`(`bundle.py:324`)을
  `WHERE side IN (1, -1)`로 조여 프론트(±1만 집계)와 명시적 정합 + side=2-only
  버킷이 `(0,0)` 포인트로 남는 것 제거. **값 오염은 없으므로**(side=2는 두 SUM에
  0을 더할 뿐) 본 straddle 정화와 독립한 선택적 클린업 — 별도 처리.
