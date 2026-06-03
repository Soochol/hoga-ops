# 동시호가 경계 — 시간 임계값 → 구조 검출 (Structural Auction Boundary) — Design

**Date**: 2026-06-03
**Status**: Proposed
**Scope (v1)**: `hoga/api/bundle.py` (`build_quote_ratio_slice`), `frontend/src/live/bucketHogaSeries.ts`, `frontend/src/live/buildLiveBundle.ts` — **계산(데이터 레이어) 정화만**.
**Scope (후속, 별도 태스크)**: 표시 경계 구조 재앵커(`frontend/src/util/sessionTime.ts` / `virtualAxis.ts` / `chart/util/auctionHide.ts` / `AuctionWindowOverlay.tsx` + Wire `RangeSegment.auction_start_ms`) — Out of Scope 참조.

> 새 분기가 아니라 **직전 걸침-버킷 정화(5b44bba, 2026-06-03)의 후속 정제**다.
> 대표-스냅샷 선택 기계(2-tier `ORDER BY` / `seenPre` 폴백)는 **그대로 두고**,
> "무엇이 동시호가인가"를 판정하는 **경계 정의만 시간(`session_close − 10분`) →
> 구조(`마지막 연속매매 호가창 스냅샷`)로 교체**한다. 체결강도·캔들·거래량·
> `auctionWindowMask` 토글의 *의미*는 건드리지 않는다.

## Problem

호가비·총잔량 보조지표가 종가 동시호가(15:20–15:30) 호가창을 계산에 끌어들이는
오염이, 직전 정화(걸침-버킷)에도 불구하고 **경계 시각의 부정확성** 때문에 남는다.

사용자 표현 그대로:

> "15:20:05 초에 즉 동시호가에 들어가는 시간이 정확히 15:20이 아니라 더 넘거나
> 좀 15:19:55 이때 들어갈 수도 있고 해. 1분봉 차트에서도 원하는 대로 동작하지
> 않아. 보조지표 계산에 동시호가 데이터는 모두 빼고 싶어."

**근본 원인 (실데이터로 확정):** 현재 동시호가 경계는 `session_close_ms − 10분`
= **15:20:00.000 시각 고정**이다(`build_quote_ratio_slice`의 `pre_auction_pred`,
`bucketHogaSeries`의 `auctionStartMs`, 표시의 `isClosingAuction`). 그러나 실제
연속매매 → 동시호가 전환은 **15:20 정각이 아니다**. 실측(20260507/329180):

```
15:19:59.908  ask 10레벨 / bid 10레벨   (연속매매)
15:20:01.410  ask 3레벨  / bid 3레벨    (동시호가 — 4~10호가 전부 0)  ← 실제 전환점
```

전환은 매일·매 종목 ±수 초로 흔들린다. 경계를 15:20 고정으로 잡으면:

- **전환이 15:19:55면 (경계보다 이름):** 15:19:55–59의 3호가 동시호가 스냅샷이
  `intra_ms < 15:20`이라 **연속매매로 오분류** → 15:19 버킷 대표값으로 뽑혀 오염.
- **전환이 15:20:05면 (경계보다 늦음):** 15:20:00–04의 연속매매 스냅샷이
  동시호가로 오분류 → 멀쩡한 데이터가 빠짐.

1분봉도 마찬가지다 — 15:20이 정확히 버킷 경계여도, *경계 시각 자체가 실제
전환과 어긋나기* 때문에 15:19/15:20 버킷이 오염되거나 과잉 마스킹된다. 사용자가
확인한 증상은 **오염(새어들어옴)** 쪽이다.

**구조 신호로 해결:** 동시호가의 *불변 특징*은 시각이 아니라 **호가창 구조**다 —
연속매매는 10호가, 동시호가는 **매수·매도 각 3호가만** 노출되고 4~10호가는 0이
된다. 이 구조 전환점은 시각과 무관하게 동시호가의 시작을 **정확히** 가리킨다.

**검증 (전 종목 데이터, grilling):**

- **3호가 시그니처(양쪽 4~10호가 잔량 모두 0)는 장중 진짜 연속호가창과 절대
  안 겹친다.** 전 종목 장중(09:05–15:15) 3호가 *런* 37개 — 길이 1(깜빡임) 0개,
  길이 2~9 0개, 전부 길이 10~수백의 **지속된 VI 단일가**. 즉 장중 3호가는 예외 없이
  단일가 상태이지, 얇은 연속호가창이 아니다.
- **동시호가 뒤에 연속이 재등장하는 인터리빙 = 0/368.** 전환이 깔끔하게 단조라,
  `last_continuous_ms`(세션 상한 내)는 항상 장마감 동시호가 *직전*에 떨어진다 —
  장마감 동시호가가 임계값 이전으로 새는 일이 없다.
- **장마감 종가 단일가 대량체결은 `side = 0`**(실측 15:30:14, 55,837주) → 체결강도
  면역(아래 영향 지표).
- **라이브 OB 페이로드는 asks/bids 10레벨을 보존**(`hoga/live/buffer.py::_strip_t_only`가
  payload를 그대로 전달) → 프론트 구조 검출 가능, 와이어 변경 불필요.

구조 신호는 *모든* 단일가(장전·장중 VI·장마감)를 잡지만, **본 spec(v1)은 장마감
동시호가만 선별**한다 — VI 단일가는 `last_continuous_ms` 임계값보다 앞이라 자동
유지(제외 안 함). VI까지 제외하는 완전-구조 설계는 후속(Out of Scope 참조).

**영향 지표:** **호가비·총잔량 2개만**. 체결강도(FillStrength)는 양쪽 경로 모두
`side = ±1`만 집계한다 — 장마감 종가 동시호가 대량체결은 `side = 0`(실측
15:30:14, 55,837주). 두 SUM에 0을 더할 뿐이라 **값 오염 없음 — 면역**(미변경).

## 핵심 설계 결정 — "마지막 연속매매 스냅샷" 임계값

순수 구조 검출(3호가면 무조건 동시호가)은 장중 VI·장전 단일가까지 잡는다.
사용자 선택은 **장마감만**이므로, 구조 신호를 **장마감 구간에 한정**해야 한다.
임의 시간상수(`15:15` 등) 없이 이를 달성하는 데이터-파생 임계값:

> **`last_continuous_ms`** = 그 Stock-Date의 Regular Session 안에서 **연속매매
> 호가창(= 4호가 이상에 잔량이 있는 스냅샷)** 중 **가장 늦은** intra-ms.
> 어떤 스냅샷이 동시호가인지는 `intra_ms > last_continuous_ms`로 판정한다.

이 한 줄이 두 제약을 동시에 만족한다:

- **시각 무관 정확성:** `last_continuous_ms`는 가정이 아니라 *측정값*이다. 실제
  전환이 15:20:01이든 15:19:55든, 마지막 연속 스냅샷이 정확히 그 직전을 가리킨다.
- **장마감만:** 장마감 동시호가는 *세션 마지막까지 이어지는* 유일한 단일가
  구간이다. 장중 VI는 3호가 구간이지만 **뒤에 연속매매(10호가)가 다시 등장**하므로,
  그 VI 스냅샷들은 `intra_ms < last_continuous_ms`(임계값은 ~15:20 직전) → 동시호가로
  분류되지 **않는다**(= 유지). 장전 동시호가는 이미 `isRegularSession`이 떨군다.
- **반장(Half-Day):** 마감 오프셋(`−10분`)을 안 쓰므로, **정확한 `session_close_ms`만
  주어지면** 12:30 마감일도 임계값이 ~12:20 직전 연속 스냅샷으로 따라간다. 백엔드
  (과거 날짜)는 per-date meta로 정확 → OK. **단 프론트 라이브 오늘분은 `close_ms`를
  15:30으로 하드코딩 폴백하므로 반장일에 미정화 — 상속된 한계**(아래 상한 설명·Risks).

**`last_continuous_ms` 산출은 Regular Session 상한(`≤ session_close_ms`)으로 한정한다.
이 상한은 "방어용"이 아니라 100% 케이스에서 load-bearing이다(검증: 전 368종목에서
post-cross 마감+14초경 호가창이 다시 10호가로 재확장 — 368/368).** 상한이 없으면
임계값이 그 post-cross 재확장으로 밀려, 15:20–15:30 동시호가 전체가 임계값 *이전*이
되어 제외에 실패한다. 따라서 정확한 `session_close_ms`가 본 설계의 필수 입력이며,
프론트 라이브 반장 한계(15:30 폴백 상한)의 직접 원인이다(Risks 참조).

## Invariants

본 변경이 **현재 보존하고 있는** 속성들(직전 걸침-버킷 spec과 동일 집합):

- **Quote bucket = bucket-start 정렬 + state 대표값**: 버킷은
  `floor(t / bucket_ms) * bucket_ms` 라벨, 값은 *마지막 (연속매매) 호가창 스냅샷*.
  근거: `bucketHogaSeries.ts`, `bundle.py` `build_quote_ratio_slice`.
- **X축 정렬**: 호가 버킷 경계가 캔들·거래량과 동일 격자에 정렬. 근거: 위 동일.
- **연속체결-only 메트릭(체결강도)**: 동시호가 체결 제외. 근거: `bucketHogaSeries.ts`
  `side===1`/`side===-1`, `bundle.py` `build_fill_strength_slice`.
- **Auction Mask 토글 의미 (ADR-0029)**: `auctionWindowMask` ON이면 동시호가 구간
  indicator 점을 *표시상* 숨기고 OFF면 드러냄. 근거: `chart/util/auctionHide.ts`,
  `chart/projectors/ratio.ts`·`quoteTotals.ts`, ADR-0029.
- **Wire 계약 (`RangeBundle.quote_ratio.points`)**: `{t, bid_total, ask_total}`
  배열 형태·버킷 timestamp 격자 고정. 근거: `api/types.ts`, ADR-0004.
- **Half-Day 안전성**: 동시호가 경계가 per-Stock-Date로 따라감.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Quote bucket = bucket-start + state 대표값 | **intentionally refines** | 대표 선택의 "연속매매 우선" 판정 기준만 *시간* → *구조*로 교체. 버킷 라벨·경계 불변. |
| X축 정렬 | preserves | 버킷 경계 불변. 어느 스냅샷을 대표로 쓰는지만 바뀜. |
| 연속체결-only (체결강도) | preserves | 체결강도 코드 미변경. |
| Auction Mask 토글 의미 | preserves | 완전-동시호가 버킷은 대표값 그대로 → 토글이 계속 표시/숨김 제어. 표시 밴드 경계만 구조로 재앵커(아래). |
| Wire 계약 | preserves | 배열 형태·timestamp 격자 동일. 버킷 *값*만 정화(의도). |
| Half-Day 안전성 | **백엔드 preserves / 프론트 live 상속된 한계** | 백엔드(과거 날짜)는 per-date 정확 마감 → OK. **프론트 라이브 오늘분은 `close_ms` 15:30 폴백 + load-bearing 상한 때문에 반장일 미정화 — 직전 spec과 동일한 한계(자동 해소 아님)**. Risks 참조. |

**"intentionally refines" 정당화:** 직전 spec(걸침-버킷)이 채택한 "마지막 연속거래
스냅샷 우선" 규칙은 옳았으나, "연속거래"의 경계를 `< 15:20` *시각*으로 근사했다.
본 변경은 같은 규칙의 경계를 **호가창 구조로 정확히** 다시 그릴 뿐이다 —
대표 선택 알고리즘(2-tier `ORDER BY` / `seenPre`)도, 버킷 격자도 불변.

## Goals

- 호가비·총잔량 버킷 대표값이 **장마감 동시호가 호가창 스냅샷을 절대 쓰지 않는다** —
  경계를 **시각이 아니라 호가창 구조**로 판정해, 15:19:55/15:20:05 지터에 무관하게
  정확히 분리한다(단, 버킷 전체가 동시호가면 예외 — Design 참조).
- 장중 VI 단일가·장전 동시호가는 **건드리지 않는다**(사용자 "장마감만").
  `last_continuous_ms` 임계값의 *trailing* 성질이 이를 자동 보장.
- 백엔드(과거 날짜)·프론트(오늘 live) **양쪽 경로** 모두 적용.
- **(v1 범위)** 계산(데이터 레이어) 정화가 v1 필수 목표. 표시 밴드
  (`AuctionWindowOverlay`)·`isClosingAuction` 마스크 경계의 구조 재앵커는 계산↔표시
  완전 정합을 위한 **후속 목표로 분리**한다(세그먼트별 동시호가 시작 시각을 Wire에
  실어야 하므로 — Out of Scope 참조). v1에서도 *오염 자체는 제거*되며, 경계분 표시
  불일치만 후속으로 남는다(사용자 증상은 오염이므로 v1로 해결).
- 회귀 테스트로 지터 분리·VI 유지·반장·동시호가 미포착 폴백·깨끗한 TF 무회귀를 못박는다.

## Non-Goals

- **장중 VI 단일가·장전 동시호가 제외** 안 함. 순수 구조 검출로 전환하면 1줄로
  가능하나, 사용자 확정은 장마감만(VI 3호가 데이터는 유지 — Risks의 trade-off).
- **체결강도(FillStrength)·누적 순체결강도** 미변경(이미 면역).
- **캔들·거래량** 미변경(ADR-0018 mute 규칙 별개).
- **이동평균선(MA)** 미변경.
- **버킷 경계 재정렬**(전환 시각으로 버킷을 쪼개는 방식) 안 함 — X축 정렬 깸.
  대표값 선택과 표시 경계만 바꾼다.
- **Wire 모델 변경 안 함.** `QuoteRatioPoint`에 `is_auction` 같은 플래그를
  추가하지 않는다 — 경계는 양쪽 경로가 각자 보유한 per-level 데이터로 *로컬*
  산출(백엔드 `ask_q*`, 프론트 `ObSnapshot.asks/bids`)하므로 와이어 확장 불필요.

## Design

### 핵심 술어 (양쪽 경로 공통, 도메인 언어)

- **연속매매 호가창(Continuous-Trading Book)**: `ask_q4..ask_q10` 또는
  `bid_q4..bid_q10` 중 **하나라도 잔량 > 0**인 스냅샷. (동시호가는 양쪽 다 3호가로
  붕괴 → 4호가 이상 전부 0. 한쪽만 얕은 박한 호가창은 다른 쪽 깊이로 연속매매 판정 —
  거짓 동시호가 방지.)
- **`last_continuous_ms`**: Regular Session(`intra_ms ≤ session_close`) 안에서
  연속매매 호가창인 스냅샷의 **최대 intra-ms**. 연속매매 스냅샷이 하나도 없으면
  **`+∞`로 폴백**(= 아무것도 동시호가로 보지 않음 → 시리즈 통째 비우기 방지).
- **동시호가 판정**: `intra_ms > last_continuous_ms`.

### 백엔드 — `build_quote_ratio_slice` (과거 날짜)

`hoga/api/bundle.py`. 현재 시간식 `pre_auction_pred = (intra_ms < auction_start)`를
**구조 임계값**으로 교체. 대표 선택의 2-tier `ROW_NUMBER` 구조는 불변:

```sql
WITH deep AS (   -- per-row 깊은-레벨 유무 + bid/ask total
  SELECT ts_ms,
         (ask_q1+...+ask_q10) AS ask_total,
         (bid_q1+...+bid_q10) AS bid_total,
         {intra_ms_expr} AS intra_ms,
         ((ask_q4+ask_q5+ask_q6+ask_q7+ask_q8+ask_q9+ask_q10) > 0
          OR (bid_q4+bid_q5+bid_q6+bid_q7+bid_q8+bid_q9+bid_q10) > 0) AS is_continuous
  FROM read_parquet(?)
),
thr AS (         -- 마지막 연속매매 스냅샷의 intra-ms (세션 상한 한정)
  SELECT max(intra_ms) AS last_continuous_ms
  FROM deep WHERE is_continuous AND intra_ms <= {session_close_intra}
),
bucketed AS (
  SELECT intra_ms, bid_total, ask_total,
         (intra_ms // {bucket_ms}) AS bucket,
         ROW_NUMBER() OVER (
           PARTITION BY (intra_ms // {bucket_ms})
           -- pre-auction(연속매매) 우선: intra_ms <= last_continuous_ms.
           -- thr이 NULL(연속 스냅샷 전무)이면 COALESCE로 TRUE → 전량 pre-auction(폴백).
           ORDER BY (intra_ms <= COALESCE((SELECT last_continuous_ms FROM thr), intra_ms)) DESC,
                    intra_ms DESC
         ) AS rn
  FROM deep
)
SELECT bucket * {bucket_ms}, bid_total, ask_total
FROM bucketed WHERE rn = 1 ORDER BY bucket
```

- 변경 핵심: `ORDER BY (시간식) DESC, ts_ms DESC` → `ORDER BY (구조-임계 비교)
  DESC, intra_ms DESC`. `WHERE rn = 1` / `SELECT`는 그대로.
- 위 CTE는 *예시*다. `last_continuous_ms`를 **별도 선행 쿼리 1개**로 스칼라 산출해
  파이썬에서 리터럴로 주입하는 2-쿼리 방식도 동등하다(윈도우 `ORDER BY` 안의 상관
  서브쿼리를 피해 SQL이 단순). 어느 쪽이든 동작·테스트 동일 — 구현 단계 판단.
- `is_continuous` predicate가 "연속매매 = 4호가 이상 잔량 존재"를 인코딩.
- `session_close_intra` = `hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))`
  (기존 헬퍼 재사용, `bundle.py`). `session_close_ms is None`이면 상한 없이
  `max(intra_ms)` → 기존 호출자 무영향(직전 spec과 동일한 호환 처리).
- 시그니처는 직전 spec이 이미 추가한 `session_close_ms: int | None`을 **그대로
  재사용**(의미만 "auction_start 오프셋 기준" → "연속 검색 상한"으로 변경). 호출부
  `build_range_bundle`은 변경 불필요(이미 `meta["regular_session_close_ms"]` 전달).
- `_CLOSING_AUCTION_WINDOW_MS` 상수는 백엔드에서 **불필요해짐**(시각 오프셋 제거).

### 프론트 — `bucketHogaSeries` (오늘 live)

`frontend/src/live/bucketHogaSeries.ts`. `auctionStartMs` 파라미터를
**`lastContinuousMs`**로 교체하고, 그 값을 ob 스냅샷의 per-level 구조로 산출:

```ts
// ObSnapshot.asks/bids: OrderbookLevel[] (10레벨, qty=0 패딩). 둘 중 하나라도
// index>=3 에 qty>0 이면 연속매매 호가창. (asks/bids 부재 시 — 분봉-only 경로 —
// 보수적으로 연속 취급: lastContinuousMs=+Infinity → 무컷오프, 기존 동작.)
function isContinuousBook(s: ObSnapshot): boolean {
  const deep = (lv?: OrderbookLevel[]) =>
    !!lv && lv.slice(3).some((l) => l.qty > 0);
  // asks/bids 둘 다 없으면 판정 불가 → 연속(보수적)
  if (!s.asks && !s.bids) return true;
  return deep(s.asks) || deep(s.bids);
}

// sessionCloseMs 상한 안에서 마지막 연속매매 스냅샷 t_ms. 없으면 +Infinity.
let lastContinuousMs = Number.POSITIVE_INFINITY;
let found = false;
for (const s of obSorted) {
  if (s.t_ms <= sessionCloseMs && isContinuousBook(s)) {
    lastContinuousMs = s.t_ms;  // obSorted 오름차순 → 마지막이 남음
    found = true;
  }
}
if (!found) lastContinuousMs = Number.POSITIVE_INFINITY;
```

- 이후 quote 루프는 **불변** — `s.t_ms < auctionStartMs` 판정을
  `s.t_ms <= lastContinuousMs`로 바꾸기만 한다(`seenPre` 폴백 로직 그대로):
  - `s.t_ms <= lastContinuousMs` → pre-auction(연속): `set` + `seenPre.add`.
  - else (`> lastContinuousMs`, 동시호가) → `seenPre` 없을 때만 `set`(마지막 auction).
- 시그니처: `bucketHogaSeries(ob, trade, bucketMs, sessionCloseMs)`. `auctionStartMs`
  (Unix ms 시각) → `sessionCloseMs`(Unix ms, 연속 검색 상한)로 의미 교체.
- fill 루프 미변경.

### 프론트 — `buildLiveBundle` 배선

`frontend/src/live/buildLiveBundle.ts`. 현재
`auctionStartMs = todaySession.close_ms − AUCTION_WINDOW_LENGTH_MS` 계산을 제거하고
`todaySession.close_ms`를 `sessionCloseMs`로 직접 전달:

```ts
const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs, todaySession.close_ms);
```

- **반장 라이브는 상속된 한계(자동 해소 아님):** `sessionCloseMs`는 *연속 검색의
  상한*인데, 이 상한은 100% load-bearing이다(전 종목 post-cross 재확장 — 핵심 설계
  결정 참조). 프론트는 오늘 `close_ms`를 **15:30으로 하드코딩 폴백**하므로, 반장일
  (실제 마감 12:30)엔 상한이 15:30으로 *너무 느슨*해 12:30:14 post-cross 연속이
  상한 안에 들어와 `lastContinuousMs`를 뒤로 밀고 → 12:20~12:30 동시호가가
  미정화로 남는다. **직전 spec과 동일한 한계**이며 본 변경으로 새로 생기는 회귀가
  아니다. 영향: 연 3~4회 반장 × 마지막 10분 × 라이브 화면만. 백엔드(과거 날짜)는
  per-date 정확 마감으로 정상. 근본 해소 = 백엔드가 오늘 `close_ms`를 실제값으로
  전송(Out of Scope). v1은 scope-out(사용자 확정).

### 표시 경로 — 구조 경계 재앵커 (계산↔표시 정합)

계산이 구조 경계를 쓰는데 표시 마스크가 `session_close − 10분` 시각 경계를 그대로
쓰면, 경계분에서 "계산은 깨끗 / 표시는 가림"이 어긋난다. 표시도 같은 구조 임계값을
쓰도록 재앵커한다. **mask-not-drop은 유지**(ADR-0029의 LWC 제약: 점을 실제 드롭하면
visible range 붕괴 + 일자 경계 대각선 — 변경 없음). 바뀌는 건 *경계 시각*뿐:

- `frontend/src/util/sessionTime.ts` `isClosingAuction` / `virtualAxis.ts`
  `inClosingAuctionWindow`가 동시호가 시작을 `session_close − 10분` 대신
  **구조 임계값(첫 동시호가 스냅샷 시각 = `last_continuous_ms` 직후)**으로 판정.
- `AuctionWindowOverlay`의 밴드 시작도 동일 임계값으로.
- 구조 임계값을 표시 경로가 어떻게 받는지(세그먼트별 `auction_start_ms`를
  계산해 `VirtualAxis`/세그먼트 메타에 싣기)는 **구현 단계 판단** — 후보:
  (a) 백엔드 `RangeSegment`에 `auction_start_ms` 추가(데이터 파생 1필드), 또는
  (b) 프론트가 `quote_ratio.points`의 마지막 비-마스크 점에서 역산. (a)가 정합성·
  단순성 우위지만 Wire 변경이라 Non-Goals와 충돌 — **표시 재앵커는 별도 태스크로
  분리**하고, v1은 계산 정화(백엔드+프론트 데이터 레이어)를 먼저 못박는다.

> **단계 분리:** 사용자 증상은 *오염(계산)*이다. 따라서 **데이터 레이어(계산)
> 정화가 v1의 필수**이고, 표시 경계 재앵커는 정합성 개선(secondary)이다. v1에서
> 표시 마스크는 기존 시각 경계를 유지해도 *오염은 이미 제거*되며(걸침/완전-동시호가
> 버킷 모두 구조로 대표 선택), 경계분 표시 불일치만 남는다. 표시 재앵커는
> Wire에 `auction_start_ms`를 싣는 방식으로 후속 처리(아래 Plan 분할 참조).

### 데이터 흐름 요약

```
과거 날짜:  parquet snapshots ─► build_quote_ratio_slice
                                  (deep CTE → last_continuous_ms → 2-tier ORDER BY) ─► quote_ratio.points
오늘 live:  SSE ob snapshots(asks/bids 10레벨) ─► bucketHogaSeries
                                  (isContinuousBook → lastContinuousMs → seenPre) ─► incrementalQR ─► merge
            둘 다 같은 RangeBundle.quote_ratio.points → ratio.ts / quoteTotals.ts projector(미변경)
```

## Testing

### Unit tests (TDD)

| Case | Setup | Expected |
|------|-------|----------|
| 백엔드: 지터(이른 전환) 분리 | 3m 버킷 `[15:18,15:21)`에 15:18·15:19(10호가)·**15:19:55(3호가)** 스냅샷 | 대표 == 15:19(마지막 연속) — 15:19:55 3호가는 동시호가로 분류·배제 |
| 백엔드: 지터(늦은 전환) 보존 | 버킷에 15:19·**15:20:03(10호가)**·15:20:05(3호가) | 대표 == 15:20:03 — 15:20:00–04 연속이 시각 경계에 안 잘림 |
| 백엔드: 완전-동시호가 버킷 불변 | 15:21·15:22(둘 다 3호가)만 | 대표 == 15:22(마지막 auction) — 기존 동작 유지 |
| 백엔드: VI 유지 (장마감만) | 11:39–11:49 3호가 구간 + 15:20 후 장마감 3호가, 마지막 연속 15:20:00 | VI 버킷 대표는 그 구간 스냅샷(`< last_continuous_ms` → 연속 분류, 미배제) |
| 백엔드: 반장 앵커 | `session_close_ms`=12:30, 12:18·12:19(10호가)·12:20:30(3호가) | 대표 == 12:19 — 마감 오프셋 없이 12:20 전환 검출 |
| 백엔드: 동시호가 미포착 폴백 | 마지막 스냅샷이 10호가(캡처가 15:19에 끝남) | `last_continuous_ms`=마지막 → 아무것도 배제 안 함 |
| 백엔드: 연속 전무 폴백 | 모든 스냅샷이 3호가(비정상) | `+∞` 폴백 → 전량 유지(시리즈 안 비움) |
| 백엔드: 깨끗한 5m 무회귀 | 5m, 15:15·15:18·15:19(전부 10호가) | 대표 == 15:19, 변경 전과 동일 |
| 백엔드: After-Hours 상한 | 15:20–15:30 3호가 + 15:40 시간외 10호가 | `last_continuous_ms`=~15:20(상한 15:30) — 15:40이 임계값을 안 밀어냄 |
| 프론트: lastContinuous 산출 | `bucketHogaSeries`, ob에 10호가→3호가 전환 | `lastContinuousMs`=마지막 10호가 t_ms |
| 프론트: 걸침 버킷 정화 | 3m, ob 15:18·15:19(10호가)·15:20:30(3호가) | 15:18 버킷 == 15:19 totals |
| 프론트: asks/bids 부재 폴백 | ob에 totals만(asks/bids undefined) | 전량 연속 취급 → 무컷오프(기존 동작) |
| 프론트: fill 무회귀 | 동일 입력 | fillStrengthPoints 변경 없음 |

**실데이터 회귀:** 20260507/329180(전환 15:20:01.410)을 fixture로 잠가
"마지막 연속 = 15:20:00.x, 그 이후 배제"를 못박는다.

**Invariant 회귀:** 위 케이스들이 버킷 *timestamp 격자*가 변경 전과 동일함을
함께 단언(값만 바뀌고 key 집합 동일 — X축 정렬·Wire 계약 보존).

### Manual verification

`/live`에서 호가 데이터 있는 종목, 3m으로 마감 부근 스크롤:

- 토글 ON(기본): 호가비·총잔량이 15:18 버킷까지, 값이 15:20 동시호가가 아니라
  실제 마지막 연속(15:20:00.x 직전) 호가창 반영. 이전엔 경계 지터로 튀던 값.
- 1m으로 바꿔 15:19/15:20 버킷이 오염 없이 깨끗.
- 5m 무회귀.
- 체결강도 pane ON/OFF·전 TF 변화 없음.

## Risks / Open questions

- **프론트 라이브 반장 미정화 (상속된 한계, v1 scope-out — 사용자 확정):**
  `sessionCloseMs` 상한이 100% load-bearing인데(전 종목 post-cross 재확장 — 핵심
  설계 결정), 프론트는 오늘 `close_ms`를 15:30으로 하드코딩 폴백한다. 따라서 반장일
  (실제 마감 12:30) 오늘분 라이브는 상한이 15:30으로 느슨해 12:30:14 post-cross
  연속이 임계값을 밀어 12:20~12:30 동시호가가 미정화로 남는다. **직전 spec과 동일,
  회귀 아님.** 영향: 연 3~4회 × 마지막 10분 × 라이브만. 백엔드(과거 날짜)는 정상.
  근본 해소 = 백엔드가 오늘 `close_ms`를 실제값으로 전송(Out of Scope).
- **VI 단일가 데이터 유지의 trade-off (의도, v1):** "장마감만"이므로 장중 VI(예:
  11:39–11:49 3호가)는 계산에 *유지*된다 — `last_continuous_ms`(~15:20) 이전이라
  threshold가 안 건드림. VI 구간 호가비·총잔량은 3호가 부분-호가창 합이라
  아티팩트(편향 스파이크)가 남을 수 있다. **데이터 확인:** 장중 3호가는 예외 없이
  지속된 VI 단일가다(전 종목 런 37개 전부 길이 ≥10, 깜빡임 0개) — 즉 VI를 빼더라도
  진짜 연속 데이터를 떨굴 위험은 없다. 따라서 "모든 단일가 제외"(VI 포함)는 안전한
  후속이며, 그 설계는 Out of Scope에 구체화.
- **`is_continuous` 임계 정의(4호가 이상 잔량):** 동시호가는 정확히 3호가로 붕괴함을
  실측 확인. 단, 미래에 KRX/업스트림이 동시호가 노출 레벨 수를 바꾸면(예: 5호가)
  이 상수(`q4` 시작)를 조정해야 한다. 도메인 상수로 한 곳에 둔다(`ORDERBOOK_LEVELS`
  옆 또는 `sessionTime` 도메인). 동작 영향은 회귀 fixture가 잡는다.
- **표시 경계 재앵커 분리:** 위 Design대로 v1은 계산만 구조화하고 표시 마스크는
  시각 경계 유지(오염은 제거되나 경계분 표시 불일치 잔존). 완전 정합은 Wire에
  `RangeSegment.auction_start_ms`를 더하는 후속 태스크 — Plan에서 분할.
- **프론트 asks/bids 페이로드 가정:** 라이브 OB 페이로드는 `ob.model_dump()`라
  asks/bids 10레벨을 싣음(`hoga/live/snapshot.py from_orderbook`). 만약 어떤 경로가
  totals만 싣으면 `isContinuousBook`가 보수적 "연속" 폴백 → 무컷오프(안전, 오염
  미제거). 구현 시 라이브 페이로드에 asks/bids 존재를 테스트로 확인.

## ADR impact

- **ADR-0029 (auction-mask-hide-not-zero)** 개정 메모 추가: 호가비·총잔량의 *버킷
  대표 선택* 동시호가 경계가 "시각(`session_close − 10분`)" → "구조(`마지막 연속매매
  호가창 스냅샷`)"로 정제됨. 표시 마스크의 hide 동작·토글 의미는 불변(v1). 표시
  경계 재앵커는 후속.
- **새 ADR 후보:** `0062-structural-auction-boundary.md` — "동시호가 경계는 시각이
  아니라 호가창 구조(4호가 이상 잔량 소멸)로 판정한다"는 결정을 직전 5b44bba
  amendment 위에 기록. ADR-0029 개정으로 둘지 새로 팔지는 `docs/agents/domain.md`
  규칙 따라 구현 단계 판단.
- **CONTEXT.md** "Auction Window"·"호가비"·"Quote Totals" 항목에 "경계는 구조 검출
  (마지막 연속매매 호가창)으로 판정" 메모 반영. 직전 spec이 추가한 시각-경계 서술
  갱신.

## Out of Scope (Backlog)

- **표시 경계 구조 재앵커** — `RangeSegment.auction_start_ms`(데이터 파생 1필드)를
  Wire에 추가하고 `isClosingAuction`/`AuctionWindowOverlay`가 소비. 계산↔표시
  경계분 완전 정합. (v1은 계산만.)
- **모든 단일가 제외 (VI 포함) — 완전-구조 설계 (grilling에서 도출, v2 후보):**
  사용자 의도는 "3호가(단일가)에서는 보조지표 계산 안 함"이고, VI도 결국 포함되어야
  한다(우선순위만 장마감 뒤). v1 threshold를 v2로 올리는 형태:
  - **검출:** per-snapshot 구조 판정(`is_continuous`)만 — `last_continuous_ms`
    임계값·`session_close` 상한 **모두 제거**(반장 load-bearing 의존성도 같이 사라짐).
    대표 = 버킷 내 마지막 연속 스냅샷(2-tier `ORDER BY` 그대로, predicate=`is_continuous`).
  - **완전-동시호가 버킷(연속 스냅샷 없음 = VI 또는 장마감)을 가리려면** projector가
    "이 점은 단일가"임을 구조로 알아야 한다(시간 마스크는 장중 VI를 못 덮음). →
    **Wire `QuoteRatioPoint.is_auction: bool` 1필드 추가**(백엔드·프론트가 산출,
    projector가 소비). 시간 기반 `isClosingAuction` 마스크를 구조 `is_auction`으로 대체.
  - **VI 갭 렌더링 주의:** ADR-0029의 transparent-color는 장마감(일자 끝) 전제로
    설계됨. 장중 VI 갭은 마지막 pre-VI 연속점의 *나가는 세그먼트*가 VI를 가로지르는
    대각선을 그릴 수 있어, 경계 처리(직전점도 투명 처리 또는 whitespace 삽입)가 추가로
    필요. 별도 grill/설계 필요.
  - 데이터 안전성 확인됨: 장중 3호가는 전부 VI 단일가(런 37/37 길이 ≥10) → 순수 구조가
    진짜 연속을 오분류할 위험 0.
- **`build_fill_strength_slice`의 `WHERE side != 0` → `side IN (1,-1)`** 명시 정합
  (직전 spec Out-of-Scope 승계, 값 오염 없으므로 독립 클린업).
