# 0062 — Closing-auction boundary is detected by orderbook structure, not the 15:20 clock

**Status:** accepted (2026-06-03)

## Decision

The closing **Auction Window** boundary that gates 호가비·**Quote Totals** bucket
representative selection is detected from **orderbook structure**, not a
`session_close − 10min` wall-clock threshold. A snapshot is *continuous-trading*
iff its book shows depth beyond level 3 (any of `ask_q4..ask_q10` /
`bid_q4..bid_q10` is nonzero); the closing auction collapses every book to exactly
3 levels. The boundary
is `last_continuous_ms` — the last continuous snapshot at/before the session close
— and any snapshot after it is the closing auction.

Applies to both read paths: `build_quote_ratio_slice` (past Stock-Dates) — whose
bucketing SQL lives in `snapshots_tbl.query_bucketed_ratio` per ADR-0001 — computes
`last_continuous_ms` from `snapshots.parquet`; `bucketHogaSeries` (today live)
computes it from the SSE ob buffer's `asks`/`bids`. The representative-selection
machinery (backend 2-tier `ORDER BY (pre_auction) DESC, ts DESC`; frontend
`seenPre` fallback) is unchanged — only the definition of "pre-auction" moved from
time to structure.

The `<= session_close` upper bound on the `last_continuous_ms` search is
load-bearing: every captured stock shows a post-cross book re-expansion (~15:30:14)
that, unbounded, would pull the threshold past the auction window and leak the
auction back in.

Scope (v1): closing auction only, calculation layer only. Intraday **VI**
single-price runs sit before the threshold and are retained. The display Auction
Mask stays time-based; the wire contract is unchanged.

## Why

The prior boundary (`session_close − 10min` = 15:20:00.000, ADR-0029 amendment
2026-06-03) assumed the continuous→auction transition happens exactly at 15:20.
It does not: across the captured corpus the transition lands at 15:20:01.xx and
drifts ±seconds per Stock-Date/code. A fixed-time boundary therefore mis-slices
the tail bucket in both directions — a 3-level snapshot timestamped 15:19:55 was
treated as continuous (contaminating the bucket), and a continuous snapshot at
15:20:03 was treated as auction (dropping real data). This was the user-reported
"1분봉에서도 안 됨 / 동시호가가 새어들어옴".

The orderbook structure marks the transition exactly and time-independently. Cross-
stock verification: the continuous→auction transition is a clean monotonic step
(0/368 stocks show a continuous book re-appearing inside the auction after it
starts), and every intraday 3-level run is a sustained VI single-price period
(all runs length ≥10, zero singleton flickers) — never a thin continuous book —
so structure never misclassifies genuine continuous trading. See the
**Single-Price Book Signature** entry in CONTEXT.md.

## Alternatives considered

**Keep the time boundary, widen the window.** Rejected — any fixed offset still
mis-slices when the real transition drifts, and a wider window drops legitimate
late-continuous data.

**Pure structural (mask every 3-level snapshot, incl. intraday VI).** Deferred,
not rejected — it is simpler (no threshold, no `session_close` bound) and matches
"any single-price = no indicator", but masking intraday VI buckets requires a
structural marker to reach the projector (a wire field) and a mid-session
line-gap rendering decision (ADR-0029's transparent-color trick assumes the
day-end). Tracked as the v2 "모든 단일가 제외" follow-up in the spec.

**Carry `is_auction` on the wire now.** Deferred — v1's contamination fix needs
only calculation-layer changes; the closing auction is already time-bounded for
the existing display mask. The wire field is required only for the v2 VI work.

## Consequences

- `_CLOSING_AUCTION_WINDOW_MS` removed from `hoga/tables/snapshots.py` (its ADR-0001
  home), replaced by `_AUCTION_BOOK_DEPTH` + derived deep-level sums;
  `AUCTION_WINDOW_LENGTH_MS` no longer used by `buildLiveBundle` (still used by
  `sessionTime`/overlays).
- `query_bucketed_ratio` runs one extra aggregate scan to derive the threshold.
- Half-day (12:30 close) past Stock-Dates are handled with no `−10min` offset.
  The frontend today-live half-day tail remains uncleaned (15:30 fallback close_ms
  loosens the load-bearing bound) — an inherited limitation, root-fixed when the
  backend sends today's real `close_ms`.
- The display Auction Mask boundary stays time-based in v1, so calc and the cosmetic
  band can disagree by the boundary minute — re-anchoring the band to the structural
  boundary is the deferred display task.

## Amendment (2026-06-05) — fully-auction buckets, 10호가 sidebar, crosshair marker

Three follow-ups landed after the v1 boundary, all keyed to the same structural
boundary:

- **Fully-auction buckets emit 0, not the auction fallback.** A bucket whose
  representative row is *not* pre-auction (no continuous member at all — e.g. the
  closing `15:21–15:30` buckets) previously fell back to the last auction 3-level
  book. Now both read paths exclude it: `query_bucketed_ratio` selects
  `CASE WHEN is_pre THEN total ELSE 0`, and `bucketHogaSeries` emits
  `{ask_total:0, bid_total:0}`. The point is kept (at 0), not dropped, so the
  display mask / overlay band / day-boundary connector handling stay intact. The
  호가비 pane renders these flat at 0 for free via `quoteImbalance`'s degenerate
  (≤0 → 0) contract — no projector-level NaN guard (an earlier guard was dead code;
  removed).
- **10호가 sidebar matches the indicator representative.** `/api/orderbook` with
  `bucket_ms` now routes through `query_bucket_representative`, which mirrors the
  same structural `pre_auction DESC, ts DESC` selection. A straddle bucket no
  longer shows the 15:20+ auction book in the sidebar while the indicator shows
  the last continuous book.
- **총잔량 crosshair marker survives the connector-break.** The Auction Mask
  transparents the last pre-auction point's per-point `color` to break the
  outgoing connector; for a `LineSeries` that color also drives the crosshair
  marker, so the marker vanished on hover (1분봉 15:19). `crosshairMarkerBackgroundColor`
  pins it to a solid series color, matching the `BaselineSeries` 호가비 pane (whose
  marker color is series-level, not per-point).

**Known limitation (v1).** The structural `(0,0)` exclusion is boundary-by-structure,
but the display Auction Mask is still clock-based (`[close−10min, close]`). A
**sustained single-price run (intraday VI / halt) that abuts the close with no
continuous resumption** pushes `last_continuous_ms` minutes before 15:20, so buckets
like `[15:18,15:19)` emit `(0,0)` yet fall *outside* the clock mask — rendering as a
plotted multi-minute drop to 0 in the unmasked region (most visible in 총잔량; 호가비
returns to the neutral 0 baseline). No corruption/crash. This extends the
"calc and the cosmetic band can disagree by the boundary minute" consequence above
to multi-minute under a VI-to-close, and is resolved by the same deferred work:
re-anchor the display band to the structural boundary (or carry `is_auction` on the
wire, per the v2 "모든 단일가 제외" follow-up).

Reference: `docs/superpowers/specs/2026-06-03-auction-structural-boundary-design.md`.

## Amendment — v2 (2026-07-09): 장중 VI를 계산·표시에서 통일 제외

**Status:** accepted (2026-07-09)

v1의 "closing-only" 범위를 넓혀 **장중 VI(단일가 붕괴) 붕괴책을 모든 호가 참조
지표에서 제외**한다 — 피크·spot 대표(`query_bucket_representatives`)가 이미 쓰던
per-row `_DEEP_BOOK_SQL`(4호가 이상 잔량) 술어로 호가비·총잔량·히트맵 대표선정을
통일한다.

### Layer 1 — 계산

`pre_auction_pred`를 시간-only(`ts <= last_continuous_ms`)에서 **`_DEEP_BOOK_SQL AND
ts <= last_continuous_ms`**로 바꾼다. 시간 경계는 마감 후 호가창 재확장(~15:30:14)
유입을 계속 막고, per-row 구조 술어가 마감 이전의 VI 붕괴책까지 배제한다. 세션 바운드
없음(`last_continuous_ms is None`, 집계 단위테스트/퇴화)은 기존 `TRUE` 폴백 유지.

- 백엔드: `query_bucketed_ratio`, `query_bucketed_depth_heatmap` (`hoga/tables/snapshots.py`).
- 프론트(3개 병렬 구현 모두 미러 — parity 계약): `bucketHogaSeries`,
  `buildHogaSeries`/`bucketDepthHeatmap`, `createIncrementalHogaSeriesBuilder`
  (`bucketHogaSeries.ts`, `buildLiveBundle.ts`). 대표 게이트에 `&& isContinuousBook(s)`.

VI-only 버킷은 마감 동시호가와 동일하게 `(0,0)` 센티넬(호가비/총잔량) 또는 last-in-bucket
raw(히트맵, 프론트 정규화)로 방출된다.

### Layer 2 — 표시 (구조 마스크)

v1 한계("clock mask가 VI (0,0)을 못 가림")를 해소한다. 표시 마스크를 시간-only에서
**시간 OR 구조 센티넬**로 확장: 연속거래 책은 항상 양측 잔량 > 0이라 `(bid_total,
ask_total) == (0,0)`이 배제 버킷을 유일 식별한다. `isExcludedQuoteBucket(mask, bid, ask)`
를 호가비(`ratio.ts`)·총잔량(`quoteTotals.ts`) 프로젝터의 마스크 술어에 OR로 더해,
마감 동시호가와 VI를 한 규칙으로 가린다(마스크 토글 OFF면 기존처럼 `(0,0)` 노출).
체결강도는 체결 파생이라 VI 구간이 자연히 비어 별도 처리 불요.

**두 계층은 함께 배포**해야 한다 — Layer 1만 있으면 VI `(0,0)`이 clock mask 밖에서
평지로 노출되는 회귀(v1 한계와 동일)가 남는다.

## Amendment — v3 (2026-07-11): 동시호가 배제를 **공용 술어 SSOT**로 통일 + 개장 동시호가·히트맵 정합

**Status:** accepted (2026-07-11)

v2 시점에도 지표별로 배제 범위가 어긋나 있었다: 히트맵은 완전-동시호가 버킷을 raw로
방출(드롭 안 함)했고, 호가비·총잔량은 **개장 동시호가**(<09:00)를 배제하지 않았다
(매도벽·매물대만 개장 하한을 가짐). 사용자 제보("히트맵만 동시호가 구간에 그려진다")를
계기로 **모든 호가 파생 지표가 하나의 술어·하나의 코드로** 동시호가를 배제하도록 통일한다.

### 공용 술어 (SSOT)

```
유효 스냅샷 = isContinuousBook(3호가 붕괴 아님) AND session_open ≤ t ≤ session_close
```

- 백엔드: `_book_indicator_eligible_sql(intra, session_open_ms, session_close_ms)`
  (`hoga/tables/snapshots.py`) — `query_bucketed_ratio`·`query_bucketed_depth_heatmap`·
  `query_day_ask_peak`/`query_day_bid_peak`/`query_day_ask_bid_peak_dual`가 전부 이 한
  함수로 WHERE/pred를 조립한다.
- 프론트: `isIndicatorEligibleBook(s) = isContinuousBook(s) && isAfterRegularOpen(s.t_ms)`
  (`bucketHogaSeries.ts`) — `bucketHogaSeries`·`bucketDepthHeatmap`·
  `IncrementalHogaBucketer`·peak 래칫 4종(`computeDayAskPeak`/`computeDayBidPeak`/
  `incrementalPeakWallSource`/`peakWallEventClassifier`)이 공유. 마감 상한(미래 틱 의존)만
  버킷 경계에서 `sessionClose`/`lastContinuousMs`로 따로 적용.

### 동시호가 3경로 (전부 이 한 술어로 배제)

- **마감 동시호가·장중 VI**: 3호가 붕괴 → `_DEEP_BOOK_SQL` 구조 배제 (v1·v2 그대로).
- **개장 동시호가**(08:50~09:00): `session_open` 하한 신설. hogaplay 실측(2026-07-11,
  무작위 40파일 개장 전 36,371행 전수)상 개장 동시호가 **역시 3호가 붕괴책**이라
  `_DEEP_BOOK_SQL`이 이미 배제하지만, 라이브 KIS WS가 개장 전 10레벨을 밀어줄 가능성
  (PR #96 제보 정황, 장중 미실측)에 대한 안전망으로 open 하한을 둔다. → **PR #96의
  "개장 동시호가는 10레벨 누적" 가정을 실측으로 정정**(당시 합성 테스트 기반이었음).
- **마감 교차 후 재확장**(~15:30:14): `session_close` 상한 배제 (v2 그대로).

### last_continuous 간접층 정리

`query_bucketed_ratio`/`query_bucketed_depth_heatmap`의 `<= last_continuous_ms`는
`{deep 행 중 close 이하} = {deep 행 중 last_continuous 이하}`로 `<= session_close`와
수학적 동치다. deep book이 존재하는 정상 경로는 공용 술어의 직접 close 상한으로 통일했다.
단 "세션 내 deep book 전무"(퇴화/깨진 캡처) 감지를 위한 `_last_continuous_intra_ms` None
체크는 유지 — 이 경우만 `TRUE` 폴백(last-in-bucket, 시리즈를 통째로 비우지 않음).

### 히트맵: (0,0) 센티넬이 아니라 **버킷 드롭**

히트맵은 v2까지 완전-동시호가 버킷을 last-in-bucket raw로 방출했으나, v3에서 **매도벽과
같은 "WHERE 사전 필터 → 자연 탈락"**으로 전환한다(빈 컬럼 = 표시 없음). 근거:

- ADR-0029가 라인 시리즈에 드롭을 금지한 두 이유(bar-index 타임스케일 축소·라인 보간)는
  캔들 시리즈에 부착된 **캔버스 프리미티브**에 미적용 — 셀 폭은 전역 `barSpacing`, 셀 부재가
  곧 자연스러운 숨김.
- 프론트 라이브 빌더는 원래부터 드롭이라, 이 전환으로 **백↔프론트 파리티 불일치가 해소**된다.
- 따라서 히트맵은 Layer 2(표시 마스크) 없이 **계산-레벨 제외 계열**(매물대·peak wall)로
  분류 — `auctionWindowMask` 토글과 무관. 호가비·총잔량만 v2의 (0,0) 센티넬+표시 마스크 유지.

### 부수

- `PastIndicatorsCache.SCHEMA_VERSION 5→6` — 구 히트맵(붕괴책 포함)·구 호가비(개장 미배제)
  캐시를 버전 미스로 무효화(read-through 1회 재계산).
- 개장 전 버킷이 `virtualAxis`에서 09:00 컬럼으로 스냅되며 알파가 중첩되던 시각 아티팩트 해소.

### 미해결 (후속)

라이브 KIS WS의 개장 동시호가(08:50~09:00) 호가창이 실제로 10레벨인지 3레벨인지는
장중에만 검증 가능. 10레벨이면 open 하한이 load-bearing, 3레벨이면 구조 술어와 중복(무해).
다음 장중에 실측해 이 문서에 기록할 것.
