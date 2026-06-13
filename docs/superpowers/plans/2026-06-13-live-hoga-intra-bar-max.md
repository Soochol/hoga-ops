# 호가 지표 분봉 내 최댓값(Intra-Bar Max) 기준 옵션 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /live 「지표」 호가 그룹의 상태형 3종(총잔량·호가비·당일 매도 최대벽)에 분봉 대표값을 종가(close)→분봉 내 최댓값(Intra-Bar Max)으로 바꾸는 per-indicator opt-in 토글을 추가한다(기본 종가).

**Architecture:** 백엔드·SSE 버킷터가 종가 필드 옆에 **Intra-Bar Max 필드를 항상 함께** 실어 보내고(`QuoteRatioPoint` += `bid_max/ask_max/imb_max_bid/imb_max_ask`, `AskPeak` += `max_price/max_qty/max_t_ms`), 토글은 projector가 어느 필드를 그릴지 고르는 **순수 클라이언트 렌더 스위치**다(재요청 없음, Past/Today Split Cache 보존, `mode=` 쿼리 파라미터 미사용). 총잔량 급증 감지는 종가 필드(`ask_total`/`bid_total`)를 하드코딩하므로 토글과 무관(표시 전용); 마커 높이만 보이는 라인을 따른다. 설계 근거·트레이드오프: `docs/superpowers/specs/2026-06-13-live-hoga-peak-basis-design.md`, ADR-0075.

**Tech Stack:** 백엔드 Python(DuckDB SQL, pydantic, pytest), 프론트 TypeScript/React(lightweight-charts, zustand, vitest, @testing-library/react).

---

## 단계 순서 및 교차 의존 (먼저 읽을 것)

**실행 순서: Phase 1 → 2 → 3 → 4 → 5 (위에서 아래로).** 각 Task는 TDD(실패테스트→실패확인→구현→통과→커밋). Task 번호는 **단계 내에서** 매겨졌다(예: "Task 2에서 추가됨"은 같은 Phase의 Task 2를 가리킴).

핵심 교차 계약(전 단계 공통 — 이름·시그니처 고정):
- **토글 pref 키**(`chartPrefs.CHART_TOGGLES`, `category:'indicator-modal'`, default false): `quoteTotalsIntraMax` / `ratioIntraMax` / `askPeakIntraMax`. 라벨 모두 "분봉 내 최댓값 기준". UI는 「지표」 모달의 각 호가 Config(보조지표 설정 UI)이며 ⚙️ 설정 모달이 아니다.
- **`QuoteRatioPoint`**(`types.ts`·`models.py`) += `bid_max, ask_max, imb_max_bid, imb_max_ask` (**필수**). **`AskPeak`** += `max_price, max_qty, max_t_ms`.
- **렌더 스위치 시그니처**(P3에서 확정, P5가 의존): 총잔량 `projectBidPoints/projectAskPoints(pts, axis, mask: boolean, intraMax = false)` — 값 `intraMax ? p.bid_max : p.bid_total`; 모듈 캐시는 `(mask?1:0)|(intraMax?2:0)` number 비트플래그 캐시키. 호가비 `RatioPaneContext.intraMax?`(선택적) — `projectRatioPoints`가 `quoteImbalance(imb_max_*)` ↔ `quoteImbalance(bid_total,ask_total)` 선택, **Outlier Mask는 선택값에 직교 적용**.
- **급증 격리**: `detectSurgeSide`는 `FIELD={ask:'ask_total',bid:'bid_total'}` 하드코딩 → 발사 시점 불변. 마커 높이만 intraMax 시 그 버킷 `ask_max/bid_max`.
- **호가비 부호/수식**(불변): `quoteImbalance(bid,ask)=(bid<=0||ask<=0)?0:(ask>=bid?ask/bid-1:-(bid/ask-1))`. 양수=매도우위, 음수=매수우위. `(bid-ask)/(bid+ask)` 아님.

알려진 영향/주의:
- **픽스처 churn**: `QuoteRatioPoint`의 4필드가 **필수**가 되면 손으로 만든 기존 `QuoteRatioPoint` 픽스처가 tsc에서 깨진다. P2가 producers·`detectSurges.test` 등을, P5가 `pastCachedProjector.test`를, P3 신규 테스트가 각자 4필드를 채운다. **Phase 2 직후 `cd frontend && npx tsc -p tsconfig.app.json --noEmit`를 돌려 남은 픽스처(예: `ratio.test.ts`/`quoteTotals.test.ts`)에 4필드를 추가**(max를 안 쓰는 테스트는 종가값 미러: `bid_max:bid_total` 등).
- **ask_peak 캐시**는 in-memory 전용(`_mem_ask_peak`)이라 `AskPeak` 신규 필드를 투명하게 운반 — 캐시 코드 변경 불요. **`SCHEMA_VERSION` 1→2 범프(Phase 1)는 `QuoteRatioRow` 디스크 캐시 전용**(ask_peak 무관).
- **오늘 봉 ask-peak 토글은 시각적으로 무효**(라이브 ratchet=running max라 close==max). 토글은 과거 거래일에서만 close↔Intra-Bar Max를 가른다(ADR-0075, 사용자 동의된 "오늘=근사").
- 커밋 스텝은 `git add`와 `git commit -m`을 **별도 스텝**으로 둔다(repo의 block-no-verify 훅 오탐 회피 — && 체이닝과 검증 우회 플래그를 쓰지 말 것).

---


## Phase 1 — 백엔드 QuoteRatio Intra-Bar Max 데이터 (총잔량·호가비 wire + SQL/캐시/재집계)

### Task 1: QuoteRatioRow += bid_max/ask_max/imb_max_bid/imb_max_ask + query_bucketed_ratio SQL 증강

**Files:**
- Modify: `hoga/tables/snapshots.py:294-309` (QuoteRatioRow dataclass), `hoga/tables/snapshots.py:382-413` (query_bucketed_ratio SQL + 행 매핑)
- Test: `tests/test_tables_snapshots.py`

- [ ] **Step 1: 실패 테스트 작성** — `tests/test_tables_snapshots.py`의 `query_bucketed_ratio` 테스트 블록(line 255 이후, `test_query_bucketed_ratio_empty_parquet_returns_no_rows` 다음)에 아래 3개 테스트를 추가. 기존 `_ob` 헬퍼(line 178)와 `write_parquet`/`duckdb.connect` 패턴을 그대로 사용.

```python
def test_query_bucketed_ratio_intra_max_independent_sides(tmp_path: Path) -> None:
    """한 버킷 내 bid 최댓값과 ask 최댓값이 서로 다른 시점이어도 각각 독립 포착
    (캔들 고가가 시·종가와 무관하듯). 종가는 마지막 스냅샷 값으로 유지."""
    from hoga.tables.snapshots import query_bucketed_ratio

    # 모두 같은 1000ms 버킷. bid max@t1(seq1, bid=900), ask max@t2(seq2, ask=800),
    # 종가=마지막(seq3, bid=10 ask=20).
    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(1,), bid_q=(900,)),
        _ob(ts_ms=90_000_500, seq=2, ask_q=(800,), bid_q=(1,)),
        _ob(ts_ms=90_000_900, seq=3, ask_q=(20,), bid_q=(10,)),  # 종가
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_ratio(con, path=out, bucket_ms=1000)
    assert len(rows) == 1
    r = rows[0]
    assert (r.bid_total, r.ask_total) == (10, 20)   # 종가 = 마지막 스냅샷
    assert r.bid_max == 900                          # bid 독립 최댓값
    assert r.ask_max == 800                          # ask 독립 최댓값
    assert r.bid_max >= r.bid_total and r.ask_max >= r.ask_total  # 상계 invariant


def test_query_bucketed_ratio_imb_max_picks_extreme_imbalance_snapshot(tmp_path: Path) -> None:
    """호가비 Intra-Bar Max는 |imbalance| 최대 스냅샷의 (bid,ask) 쌍. max끼리 결합과
    부호가 뒤집힌다(스펙 예시): A(bid100,ask2)=매수우위, B(bid10,ask300)=매도우위.
    |imbalance| 극값 = A → imb_max_bid/ask = (100,2). (bid_max=100, ask_max=300 결합 아님.)"""
    from hoga.tables.snapshots import query_bucketed_ratio
    from hoga.api.timeenc import hhmmssms_to_unix_ms  # noqa: F401 (의도 명시용)

    obs = [
        _ob(ts_ms=90_000_100, seq=1, ask_q=(2,), bid_q=(100,)),   # A: |imb| = 100/2-1 = 49 (매수우위)
        _ob(ts_ms=90_000_500, seq=2, ask_q=(300,), bid_q=(10,)),  # B: |imb| = 300/10-1 = 29 (매도우위)
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()
    rows = query_bucketed_ratio(con, path=out, bucket_ms=1000)
    assert len(rows) == 1
    r = rows[0]
    assert (r.imb_max_bid, r.imb_max_ask) == (100, 2)  # A — 더 큰 |imbalance|
    assert (r.bid_max, r.ask_max) == (100, 300)        # 독립 최댓값은 max끼리(부호 뒤집힘 증거)


def test_query_bucketed_ratio_auction_bucket_zeroes_max_fields(tmp_path: Path) -> None:
    """완전 동시호가 버킷(연속거래 스냅샷 없음)은 종가뿐 아니라 max 필드도 0 센티넬."""
    from hoga.tables.snapshots import query_bucketed_ratio

    # 3-레벨 붕괴 호가창(레벨4+ = 0) 2건이 한 버킷 → is_pre 없음 → 전부 0.
    z = tuple([0] * 10)
    collapsed1 = Orderbook(
        ts_ms=152_058_000, seq=1,
        ask_p=(101, 102, 103) + (0,) * 7, ask_q=(99, 98, 97) + (0,) * 7, ask_d=z,
        bid_p=(100, 99, 98) + (0,) * 7, bid_q=(7, 7, 7) + (0,) * 7, bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    collapsed2 = Orderbook(
        ts_ms=152_058_500, seq=2,
        ask_p=(101, 102, 103) + (0,) * 7, ask_q=(50, 40, 30) + (0,) * 7, ask_d=z,
        bid_p=(100, 99, 98) + (0,) * 7, bid_q=(5, 5, 5) + (0,) * 7, bid_d=z,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )
    out = tmp_path / "snapshots.parquet"
    write_parquet([collapsed1, collapsed2], out)
    con = duckdb.connect()
    # session_close_ms로 마감 동시호가 구간 진입을 명시(15:30:00 이전 연속거래 없음 → fully-auction).
    rows = query_bucketed_ratio(con, path=out, bucket_ms=1000, session_close_ms=153000000)
    assert len(rows) == 1
    r = rows[0]
    assert (r.bid_total, r.ask_total) == (0, 0)
    assert (r.bid_max, r.ask_max) == (0, 0)
    assert (r.imb_max_bid, r.imb_max_ask) == (0, 0)
```

- [ ] **Step 2: 실패 확인** — `uv run pytest tests/test_tables_snapshots.py -k "intra_max or imb_max or auction_bucket_zeroes" -v`
  예상 실패: `AttributeError: 'QuoteRatioRow' object has no attribute 'bid_max'` (또는 `__init__()` 인자 불일치) — 신규 필드·SQL 미존재.

- [ ] **Step 3: 최소 구현** — `hoga/tables/snapshots.py`.

  (a) `QuoteRatioRow` dataclass(line 294-309)에 4필드 가산:

```python
@dataclass(frozen=True)
class QuoteRatioRow:
    """One bucketed bid/ask depth-total row from :func:`query_bucketed_ratio`.

    ``bucket_intra_ms`` is bucket-aligned LINEAR ms-from-midnight (NOT raw
    HHMMSSmmm and NOT Unix ms). The caller converts via
    ``hoga.api.timeenc.ms_from_midnight_to_unix_ms(date, bucket_intra_ms)`` —
    the conversion needs the Stock-Date, which this table-level query does not
    take. ``ask_total`` / ``bid_total`` are the SUM of the 10 ask_q / bid_q
    level columns at the last snapshot in the bucket.

    Intra-Bar Max 필드(ADR-0075): ``bid_max`` / ``ask_max`` = 버킷 내 연속거래
    스냅샷의 bid_total / ask_total 독립 최댓값. ``imb_max_bid`` / ``imb_max_ask``
    = 버킷 내 |imbalance|(= GREATEST/LEAST ratio 단조 대용)가 가장 컸던 연속거래
    스냅샷의 (bid_total, ask_total) 쌍. 동시호가/완전-auction 버킷은 4필드 모두 0.
    """

    bucket_intra_ms: int
    bid_total: int
    ask_total: int
    bid_max: int
    ask_max: int
    imb_max_bid: int
    imb_max_ask: int
```

  (b) `query_bucketed_ratio`의 SQL(line 382-409)을 교체. `bucketed` CTE에 버킷별 윈도우 MAX(is_pre 게이트)와 FIRST_VALUE(|imb| mag DESC, ts ASC)를 추가하고, rn=1 행에서 읽되 최종 SELECT에서 `CASE WHEN is_pre`로 fully-auction 버킷을 0으로:

```python
    rows = con.execute(
        f"""
        WITH bucketed AS (
          SELECT ts_ms,
                 ({_ASK_Q_SUM}) AS ask_total,
                 ({_BID_Q_SUM}) AS bid_total,
                 ({pre_auction_pred}) AS is_pre,
                 ({intra_ms_expr} // {bucket_ms}) AS bucket,
                 ROW_NUMBER() OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                   ORDER BY ({pre_auction_pred}) DESC, ts_ms DESC
                 ) AS rn,
                 -- Intra-Bar Max (ADR-0075): is_pre 게이트로 동시호가 스냅샷 배제.
                 MAX(CASE WHEN ({pre_auction_pred}) THEN ({_BID_Q_SUM}) ELSE 0 END) OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                 ) AS bid_max,
                 MAX(CASE WHEN ({pre_auction_pred}) THEN ({_ASK_Q_SUM}) ELSE 0 END) OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                 ) AS ask_max,
                 -- |imbalance| 최대 스냅샷의 (bid,ask) 쌍 — GREATEST/LEAST ratio는
                 -- |imbalance|+1 의 단조 대용. degenerate(한쪽 0)·동시호가는 0으로
                 -- 밀려 후순위. 동률은 가장 이른 ts_ms.
                 FIRST_VALUE(CASE WHEN ({pre_auction_pred}) THEN ({_BID_Q_SUM}) ELSE 0 END) OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                   ORDER BY (CASE WHEN ({pre_auction_pred}) AND ({_BID_Q_SUM}) > 0 AND ({_ASK_Q_SUM}) > 0
                               THEN GREATEST(({_ASK_Q_SUM}), ({_BID_Q_SUM})) * 1.0
                                    / LEAST(({_ASK_Q_SUM}), ({_BID_Q_SUM}))
                               ELSE 0 END) DESC, ts_ms ASC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                 ) AS imb_max_bid,
                 FIRST_VALUE(CASE WHEN ({pre_auction_pred}) THEN ({_ASK_Q_SUM}) ELSE 0 END) OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                   ORDER BY (CASE WHEN ({pre_auction_pred}) AND ({_BID_Q_SUM}) > 0 AND ({_ASK_Q_SUM}) > 0
                               THEN GREATEST(({_ASK_Q_SUM}), ({_BID_Q_SUM})) * 1.0
                                    / LEAST(({_ASK_Q_SUM}), ({_BID_Q_SUM}))
                               ELSE 0 END) DESC, ts_ms ASC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                 ) AS imb_max_ask
          FROM read_parquet(?)
        )
        -- A fully-auction bucket (rn=1 row is NOT pre-auction = it had no
        -- continuous-trading book, e.g. the closing 15:21-15:30 buckets) emits 0
        -- instead of the auction fallback, so the closing-auction 3-level book
        -- never enters the 호가비·총잔량 calculation regardless of the display
        -- Auction Mask toggle (ADR-0062). Straddle buckets keep their last
        -- continuous representative; intraday VI sits before the threshold
        -- (is_pre TRUE) and is retained. Intra-Bar Max fields are likewise zeroed
        -- on a fully-auction bucket so bid_max >= bid_total holds at the (0,0) sentinel.
        SELECT bucket * {bucket_ms},
               CASE WHEN is_pre THEN bid_total ELSE 0 END,
               CASE WHEN is_pre THEN ask_total ELSE 0 END,
               CASE WHEN is_pre THEN bid_max ELSE 0 END,
               CASE WHEN is_pre THEN ask_max ELSE 0 END,
               CASE WHEN is_pre THEN imb_max_bid ELSE 0 END,
               CASE WHEN is_pre THEN imb_max_ask ELSE 0 END
        FROM bucketed WHERE rn = 1 ORDER BY bucket
        """,
        [str(path)],
    ).fetchall()
    return [
        QuoteRatioRow(
            bucket_intra_ms=int(r[0]), bid_total=int(r[1]), ask_total=int(r[2]),
            bid_max=int(r[3]), ask_max=int(r[4]),
            imb_max_bid=int(r[5]), imb_max_ask=int(r[6]),
        )
        for r in rows
    ]
```

- [ ] **Step 4: 통과 확인** — `uv run pytest tests/test_tables_snapshots.py -v`
  예상 PASS: 신규 3개 + 기존 `query_bucketed_ratio` 테스트(`_sums_all_ten_levels`, `_takes_last_snapshot_in_bucket`, `_buckets_on_linear_minute_boundary`, `_empty_parquet_returns_no_rows`) 전부 그린.

- [ ] **Step 5: 커밋**
  - `git add hoga/tables/snapshots.py tests/test_tables_snapshots.py`
  - `git commit -m "feat(snapshots): QuoteRatioRow Intra-Bar Max 필드 + query_bucketed_ratio 윈도우 집계 (ADR-0075)"`

---

### Task 2: reaggregate_ratio가 Intra-Bar Max 필드 전파

**Files:**
- Modify: `hoga/api/indicator_reaggregate.py:42-64` (reaggregate_ratio)
- Test: `tests/unit/api/test_indicator_reaggregate.py`

- [ ] **Step 1: 실패 테스트 작성** — `tests/unit/api/test_indicator_reaggregate.py`. 먼저 기존 `_qr` 헬퍼(line 38-39)를 4필드 인자를 받도록 확장한다. 기존 호출(`_qr(0,10,20)`)이 깨지지 않게 max 필드는 기본값으로:

```python
def _qr(
    intra: int, bid: int, ask: int,
    bid_max: int | None = None, ask_max: int | None = None,
    imb_max_bid: int | None = None, imb_max_ask: int | None = None,
) -> QuoteRatioRow:
    return QuoteRatioRow(
        bucket_intra_ms=intra, bid_total=bid, ask_total=ask,
        bid_max=bid if bid_max is None else bid_max,
        ask_max=ask if ask_max is None else ask_max,
        imb_max_bid=bid if imb_max_bid is None else imb_max_bid,
        imb_max_ask=ask if imb_max_ask is None else imb_max_ask,
    )
```

  그리고 max 전파 테스트 2개를 (pure-logic 섹션, `test_reaggregate_identity_at_one_minute` 다음에) 추가:

```python
def test_reaggregate_ratio_propagates_max_as_window_max(tmp_path: Path) -> None:
    """bid_max/ask_max = 구성 1m들의 max(종가의 last-in-window와 독립)."""
    rows = [
        _qr(0, 10, 20, bid_max=900, ask_max=100),
        _qr(60_000, 11, 21, bid_max=50, ask_max=800),
        _qr(120_000, 12, 22, bid_max=70, ask_max=70),  # 종가는 이 분
    ]
    out = reaggregate_ratio(rows, 180_000)
    assert len(out) == 1
    r = out[0]
    assert (r.bid_total, r.ask_total) == (12, 22)  # last-in-window 불변
    assert r.bid_max == 900 and r.ask_max == 800   # 구성 1m max


def test_reaggregate_ratio_imb_max_from_strongest_constituent(tmp_path: Path) -> None:
    """imb_max = 구성 1m 중 mag(imb_max_bid, imb_max_ask)가 최대인 1m의 쌍.
    mag(b,a) = max(a,b)/min(a,b) (b>0 && a>0), degenerate=1."""
    rows = [
        # 1m#0: imb 쌍 (100, 2) → mag = 50
        _qr(0, 10, 20, imb_max_bid=100, imb_max_ask=2),
        # 1m#1: imb 쌍 (10, 300) → mag = 30 (더 약함)
        _qr(60_000, 11, 21, imb_max_bid=10, imb_max_ask=300),
        # 1m#2: degenerate (5, 0) → mag = 1 (최약)
        _qr(120_000, 12, 22, imb_max_bid=5, imb_max_ask=0),
    ]
    out = reaggregate_ratio(rows, 180_000)
    assert len(out) == 1
    assert (out[0].imb_max_bid, out[0].imb_max_ask) == (100, 2)  # mag 최대 1m
```

- [ ] **Step 2: 실패 확인** — `uv run pytest tests/unit/api/test_indicator_reaggregate.py -k "propagates_max or imb_max_from_strongest" -v`
  예상 실패: `AssertionError` — `reaggregate_ratio`가 max 필드를 버리고 종가 동일값으로 채워 `bid_max == 900`이 깨짐.

- [ ] **Step 3: 최소 구현** — `hoga/api/indicator_reaggregate.py`의 `reaggregate_ratio`(line 42-64) 전체 교체. mag 헬퍼를 모듈 상단(import 다음)에 추가:

```python
def _imb_mag(bid: int, ask: int) -> float:
    """|imbalance| 단조 대용(랭킹용). max(a,b)/min(a,b) (b>0 && a>0), degenerate=1.
    snapshots.query_bucketed_ratio의 SQL mag와 동일 정의 — 큰 mag = 큰 |imbalance|."""
    if bid > 0 and ask > 0:
        return max(ask, bid) / min(ask, bid)
    return 1.0


def reaggregate_ratio(rows_1m: list[QuoteRatioRow], bucket_ms: int) -> list[QuoteRatioRow]:
    """Re-aggregate 1-minute quote_ratio rows to ``bucket_ms`` (a multiple of 1m).

    Per target bucket: the depth totals of the LAST non-``(0, 0)`` 1-minute row,
    falling back to the last row overall (which is ``(0, 0)`` for a fully-auction
    window). ``rows_1m`` must be ascending by ``bucket_intra_ms`` (the query
    contract); the output is ascending too.

    Intra-Bar Max (ADR-0075): ``bid_max`` / ``ask_max`` = the max across the
    constituent 1m rows. ``imb_max_*`` = the (bid,ask) pair of the constituent 1m
    with the largest ``_imb_mag(imb_max_bid, imb_max_ask)`` — direct-query
    equivalence holds because the N-minute |imbalance| extreme is the max over the
    constituent 1-minute extremes.
    """
    last_nonzero: dict[int, tuple[int, int]] = {}
    last_any: dict[int, tuple[int, int]] = {}
    bid_max: dict[int, int] = {}
    ask_max: dict[int, int] = {}
    imb_best: dict[int, tuple[float, int, int]] = {}  # (mag, imb_max_bid, imb_max_ask)
    order: list[int] = []
    for r in rows_1m:
        tb = (r.bucket_intra_ms // bucket_ms) * bucket_ms
        if tb not in last_any:
            order.append(tb)
            bid_max[tb] = 0
            ask_max[tb] = 0
            imb_best[tb] = (0.0, 0, 0)
        last_any[tb] = (r.bid_total, r.ask_total)
        if r.bid_total != 0 or r.ask_total != 0:
            last_nonzero[tb] = (r.bid_total, r.ask_total)
        if r.bid_max > bid_max[tb]:
            bid_max[tb] = r.bid_max
        if r.ask_max > ask_max[tb]:
            ask_max[tb] = r.ask_max
        mag = _imb_mag(r.imb_max_bid, r.imb_max_ask)
        if mag > imb_best[tb][0]:
            imb_best[tb] = (mag, r.imb_max_bid, r.imb_max_ask)
    out: list[QuoteRatioRow] = []
    for tb in order:
        bid, ask = last_nonzero.get(tb, last_any[tb])
        _, imb_b, imb_a = imb_best[tb]
        out.append(QuoteRatioRow(
            bucket_intra_ms=tb, bid_total=bid, ask_total=ask,
            bid_max=bid_max[tb], ask_max=ask_max[tb],
            imb_max_bid=imb_b, imb_max_ask=imb_a,
        ))
    return out
```

- [ ] **Step 4: 통과 확인** — `uv run pytest tests/unit/api/test_indicator_reaggregate.py -v`
  예상 PASS: 신규 2개 + 기존 등가성 테스트(`test_ratio_reaggregation_equals_direct_query_auction_day` 포함) 전부 그린. 등가성 테스트는 `_write_snaps`가 연속거래 스냅샷을 분당 2건 쓰므로 `query_bucketed_ratio`(1m)와 `reaggregate_ratio`(Nm)의 max 필드가 일치해야 통과 — Task 1 SQL과 Task 2 Python이 같은 mag 정의를 쓰므로 성립.

- [ ] **Step 5: 커밋**
  - `git add hoga/api/indicator_reaggregate.py tests/unit/api/test_indicator_reaggregate.py`
  - `git commit -m "feat(reaggregate): quote_ratio Intra-Bar Max 필드 재집계 전파 (bid/ask max + imb mag-최대 쌍)"`

---

### Task 3: PastIndicatorsCache 7-tuple 직렬화 + SCHEMA_VERSION 1→2

**Files:**
- Modify: `hoga/api/past_indicators_cache.py:44` (SCHEMA_VERSION), `:68-85` (get_ratio/store_ratio)
- Test: `tests/unit/api/test_past_indicators_cache.py`

- [ ] **Step 1: 실패 테스트 작성** — `tests/unit/api/test_past_indicators_cache.py`. 모듈 상단 `RATIO` 픽스처(line 15-16)를 7필드로 교체하고 신규 round-trip·구버전 무효 테스트를 추가. 기존 테스트(`test_ratio_roundtrip_in_memory`, `test_persists_to_disk_across_instances` 등)는 교체된 `RATIO`를 그대로 비교하므로 자동 커버.

  먼저 `RATIO` 정의 교체:

```python
RATIO = [QuoteRatioRow(bucket_intra_ms=0, bid_total=10, ask_total=20,
                       bid_max=900, ask_max=800, imb_max_bid=100, imb_max_ask=2),
         QuoteRatioRow(bucket_intra_ms=60_000, bid_total=0, ask_total=0,
                       bid_max=0, ask_max=0, imb_max_bid=0, imb_max_ask=0)]
```

  그리고 파일 끝에 추가:

```python
def test_ratio_disk_payload_is_seven_tuples(tmp_path: Path) -> None:
    """디스크 직렬화는 [bucket_intra_ms, bid_total, ask_total, bid_max, ask_max,
    imb_max_bid, imb_max_ask] 7-tuple — Intra-Bar Max 필드를 보존(ADR-0075)."""
    PastIndicatorsCache(tmp_path).store_ratio(CODE, DATE, SRC, RATIO)
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json"
    body = json.loads(p.read_text())
    assert body["rows"][0] == [0, 10, 20, 900, 800, 100, 2]
    assert body["rows"][1] == [60_000, 0, 0, 0, 0, 0, 0]
    # 콜드 인스턴스가 7-tuple을 동일 QuoteRatioRow로 복원.
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) == RATIO


def test_schema_version_bumped_to_2_invalidates_old_three_tuple(tmp_path: Path) -> None:
    """SCHEMA_VERSION 1→2: max 필드 없는 구(舊) 3-tuple 캐시는 버전 미스로 무효."""
    from hoga.api import past_indicators_cache as mod
    assert mod.SCHEMA_VERSION == 2
    p = tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"version": 1, "rows": [[0, 10, 20]], "fetched_at_ms": 0}),
                 encoding="utf-8")
    assert PastIndicatorsCache(tmp_path).get_ratio(CODE, DATE, SRC) is None
```

- [ ] **Step 2: 실패 확인** — `uv run pytest tests/unit/api/test_past_indicators_cache.py -v`
  예상 실패: `test_ratio_roundtrip_in_memory`/`test_ratio_disk_payload_is_seven_tuples`가 `body["rows"][0] == [0,10,20]`(3-tuple)이라 `[0,10,20,900,800,100,2]`와 불일치; `test_schema_version_bumped_to_2...`가 `SCHEMA_VERSION == 1`이라 실패.

- [ ] **Step 3: 최소 구현** — `hoga/api/past_indicators_cache.py`.

  (a) line 44:

```python
SCHEMA_VERSION = 2
```

  (b) `get_ratio`(line 68-80)의 행 복원을 7-tuple로:

```python
    def get_ratio(self, code: str, date: str, source: str) -> list[QuoteRatioRow] | None:
        key = (code, date, source)
        hit = self._mem_ratio.get(key)
        if hit is not None:
            return hit
        tuples = self._read(code, date, source, "ratio")
        if tuples is None:
            return None
        rows = [
            QuoteRatioRow(
                bucket_intra_ms=t[0], bid_total=t[1], ask_total=t[2],
                bid_max=t[3], ask_max=t[4], imb_max_bid=t[5], imb_max_ask=t[6],
            )
            for t in tuples
        ]
        self._mem_ratio[key] = rows
        return rows
```

  (c) `store_ratio`(line 82-85)의 직렬화를 7-tuple로:

```python
    def store_ratio(self, code: str, date: str, source: str, rows: list[QuoteRatioRow]) -> None:
        tuples = [
            [r.bucket_intra_ms, r.bid_total, r.ask_total,
             r.bid_max, r.ask_max, r.imb_max_bid, r.imb_max_ask]
            for r in rows
        ]
        self._write(code, date, source, "ratio", tuples)
        self._mem_ratio[(code, date, source)] = rows
```

- [ ] **Step 4: 통과 확인** — `uv run pytest tests/unit/api/test_past_indicators_cache.py -v`
  예상 PASS: 신규 2개 + 기존 8개(roundtrip·persist·corrupt·version_mismatch·empty 등) 전부 그린.

- [ ] **Step 5: 커밋**
  - `git add hoga/api/past_indicators_cache.py tests/unit/api/test_past_indicators_cache.py`
  - `git commit -m "feat(past-indicators-cache): quote_ratio 7-tuple 직렬화 + SCHEMA_VERSION 1->2 (Intra-Bar Max)"`

---

### Task 4: models.py QuoteRatioPoint += 4필드 + bundle.py build_quote_ratio_slice 배선

**Files:**
- Modify: `hoga/api/models.py:105-108` (QuoteRatioPoint), `hoga/api/bundle.py:205-217` (build_quote_ratio_slice의 QuoteRatioPoint 변환)
- Test: `tests/unit/api/test_quote_ratio_auction_decontam.py`

- [ ] **Step 1: 실패 테스트 작성** — `tests/unit/api/test_quote_ratio_auction_decontam.py`에 추가. 이 파일의 기존 `_write_snaps`(line 38-67)는 `is_cont`일 때 `bid_q1=total-1, bid_q4=1`로 단일 스냅샷만 쓴다 — 한 버킷 안 max를 시험하려면 분당 여러 스냅샷이 필요하므로, 신규 테스트는 별도 fixture writer를 정의해 한 분 안에 2 스냅샷을 직접 쓴다(기존 `_write_snaps`/`_engine`은 불변).

```python
def _write_multi(path: Path, snaps: list[tuple[int, int, int]]) -> None:
    """snaps: (unix_ms, bid_total, ask_total) — 전부 연속거래(10-레벨) 스냅샷.
    bid_q1=total-1, bid_q4=1 로 deep level>0 (연속거래 구조)."""
    rows = []
    for unix_ms, bid_total, ask_total in snaps:
        row: dict = {"ts_ms": unix_ms_to_hhmmssms(DATE, unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"ask_p{i}"] = 101
            row[f"bid_q{i}"] = 0
            row[f"ask_q{i}"] = 0
        row["bid_q1"] = bid_total - 1
        row["bid_q4"] = 1
        row["ask_q1"] = ask_total - 1
        row["ask_q4"] = 1
        row["total_bid_qty"] = bid_total
        row["total_ask_qty"] = ask_total
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _engine_multi(tmp_path: Path, snaps: list[tuple[int, int, int]], close_ms: int) -> QueryEngine:
    code_dir = tmp_path / "parquet" / DATE / CODE / "kis_live"
    code_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "source": "kis_live", "code": CODE, "date": DATE,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": close_ms,
        "collection_complete": True, "is_partial": False,
    }
    (code_dir / "meta.json").write_text(json.dumps(meta))
    _write_multi(code_dir / "snapshots.parquet", snaps)
    return QueryEngine(tmp_path)


def test_quote_ratio_slice_carries_intra_max_fields(tmp_path: Path) -> None:
    """슬라이스 QuoteRatioPoint가 종가 옆에 Intra-Bar Max 4필드를 싣는다(직접 쿼리 경로).
    한 3m 버킷 안 bid max@t1, ask max@t2, 종가=마지막."""
    snaps = [
        (_hms_unix(9, 0, 10), 900, 100),  # bid max
        (_hms_unix(9, 1, 10), 50, 800),   # ask max
        (_hms_unix(9, 2, 10), 11, 21),    # 종가
    ]
    qr = _slice(_engine_multi(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    p = qr.points[0]
    assert (p.bid_total, p.ask_total) == (11, 21)  # 종가
    assert p.bid_max == 900 and p.ask_max == 800   # 독립 max
    # |imb| 극값 스냅샷: (900,100) mag=9, (50,800) mag=16, (11,21) mag≈1.9 → (50,800).
    assert (p.imb_max_bid, p.imb_max_ask) == (50, 800)


def test_quote_ratio_slice_intra_max_via_cache_reaggregation(tmp_path: Path) -> None:
    """과거일 캐시 재집계 경로(today_kst != date)도 max 필드를 배선한다.
    1m 캐시 → reaggregate_ratio → QuoteRatioPoint."""
    from hoga.api.past_indicators_cache import PastIndicatorsCache
    snaps = [
        (_hms_unix(9, 0, 10), 900, 100),
        (_hms_unix(9, 1, 10), 50, 800),
        (_hms_unix(9, 2, 10), 11, 21),
    ]
    engine = _engine_multi(tmp_path, snaps, CLOSE_FULL)
    cache = PastIndicatorsCache(tmp_path / "cache")
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=BUCKET_3M,
        source="kis_live", session_close_ms=CLOSE_FULL,
        cache=cache, today_kst="20260530",  # date != today → cacheable 재집계 경로
    )
    assert len(qr.points) == 1
    p = qr.points[0]
    assert p.bid_max == 900 and p.ask_max == 800
    assert (p.imb_max_bid, p.imb_max_ask) == (50, 800)
```

- [ ] **Step 2: 실패 확인** — `uv run pytest tests/unit/api/test_quote_ratio_auction_decontam.py -k "intra_max" -v`
  예상 실패: `AttributeError: 'QuoteRatioPoint' object has no attribute 'bid_max'` — models.py 미가산 + bundle.py 미배선.

- [ ] **Step 3: 최소 구현**

  (a) `hoga/api/models.py`의 `QuoteRatioPoint`(line 105-108) 가산:

```python
class QuoteRatioPoint(BaseModel):
    t: int          # Unix ms
    bid_total: int
    ask_total: int
    # Intra-Bar Max (ADR-0075) — 종가 옆에 항상 동봉(순수 렌더 스위치; mode= 파라미터 없음).
    bid_max: int        # 버킷 내 매수 총잔량 독립 최댓값
    ask_max: int        # 버킷 내 매도 총잔량 독립 최댓값
    imb_max_bid: int    # |imbalance| 최대 스냅샷의 bid_total
    imb_max_ask: int    # |imbalance| 최대 스냅샷의 ask_total
```

  (b) `hoga/api/bundle.py`의 `build_quote_ratio_slice` 반환부(line 205-217)에서 QuoteRatioPoint에 max 필드 배선. 직접 쿼리·캐시 재집계 두 경로 모두 `rows`(QuoteRatioRow 리스트)를 거쳐 이 변환에 들어오므로 한 곳만 고치면 둘 다 커버:

```python
    return QuoteRatio(
        bucket_ms=bucket_ms,
        points=[
            QuoteRatioPoint(
                # r.bucket_intra_ms is bucket-aligned ms-from-midnight, not
                # HHMMSSmmm — so convert via ms_from_midnight_to_unix_ms.
                t=ms_from_midnight_to_unix_ms(date, r.bucket_intra_ms),
                bid_total=r.bid_total,
                ask_total=r.ask_total,
                bid_max=r.bid_max,
                ask_max=r.ask_max,
                imb_max_bid=r.imb_max_bid,
                imb_max_ask=r.imb_max_ask,
            )
            for r in rows
        ],
    )
```

- [ ] **Step 4: 통과 확인** — `uv run pytest tests/unit/api/test_quote_ratio_auction_decontam.py -v`
  예상 PASS: 신규 2개 + 기존 decontam 테스트(`test_straddle_bucket_uses_last_continuous_snapshot` 등) 전부 그린.

- [ ] **Step 5: 커밋**
  - `git add hoga/api/models.py hoga/api/bundle.py tests/unit/api/test_quote_ratio_auction_decontam.py`
  - `git commit -m "feat(bundle): QuoteRatioPoint Intra-Bar Max 4필드 + build_quote_ratio_slice 배선(직접+캐시 경로)"`


## Phase 2 — 프론트 QuoteRatio 데이터 (types.ts 미러 + bucketHogaSeries 산출)

### Task 1: `QuoteRatioPoint` Intra-Bar Max 4필드 미러 + producer/픽스처 tsc 정합

**Files:**
- Modify: `frontend/src/api/types.ts:31` (QuoteRatioPoint)
- Modify: `frontend/src/live/bucketHogaSeries.ts:82-94` (producer — 0 placeholder로 tsc 통과)
- Modify: `frontend/src/chart/surge/detectSurges.test.ts:5` (P 헬퍼 — close 미러)
- Modify: `frontend/src/live/buildLiveBundle.test.ts` (qp 헬퍼 도입 + 깨지는 literal 7곳)
- Test (gate): tsc 타입체크 (`tsconfig.app.json`)

> 배경: 4필드를 required로 추가하면 타입 변경만으로 tsc가 3파일에서 깨진다(실측 TS2739/TS2345/TS2322). "타입만 → green"은 불가능하므로 이 태스크가 타입 + producer placeholder + 깨지는 픽스처까지 함께 처리해 독립 green(tsc)을 만든다. 실제 Intra-Bar Max 계산은 Task 2.

- [ ] **Step 1: 실패 테스트 작성(=gate 명령 준비, tsc가 곧 red).** 이 태스크의 "실패 테스트"는 별도 vitest가 아니라 **타입체크**다. 먼저 `frontend/src/api/types.ts:31`을 아래로 교체해 red를 만든다:

```typescript
export type QuoteRatioPoint = {
  t: number;
  bid_total: number;
  ask_total: number;
  bid_max: number;
  ask_max: number;
  imb_max_bid: number;
  imb_max_ask: number;
};
```

- [ ] **Step 2: 실패 확인** — 명령:

```bash
cd frontend && npx tsc -p tsconfig.app.json --noEmit
```

예상 실패(정확히 3파일 10에러):
```
src/chart/surge/detectSurges.test.ts:5 - error TS2739: Type '{ t: number; ask_total: number; bid_total: number; }' is missing the following properties from type 'QuoteRatioPoint': bid_max, ask_max, imb_max_bid, imb_max_ask
src/live/bucketHogaSeries.ts:88 - error TS2345: ... is not assignable to parameter of type 'QuoteRatioPoint'.
src/live/bucketHogaSeries.ts:92 - error TS2345: ...
src/live/buildLiveBundle.test.ts:81 - error TS2739: ...
src/live/buildLiveBundle.test.ts:241 - error TS2322: Type '{ t; bid_total; ask_total; }[]' is not assignable to type 'QuoteRatioPoint[]'.
src/live/buildLiveBundle.test.ts:397,398,437,472,473 - error TS2739: ...
Found 10 errors in 3 files.
```

- [ ] **Step 3: 최소 구현** — 깨진 4파일을 0/미러 값으로 채워 tsc를 통과시킨다(실제 max 계산은 Task 2).

(3a) `frontend/src/live/bucketHogaSeries.ts` — line 82-94의 quote 버킷 루프를 아래로 교체. **이 태스크에서는 max 필드를 0 placeholder로** 둔다(Task 2가 교체):

```typescript
  const quoteByBucket = new Map<number, QuoteRatioPoint>();
  const seenPre = new Set<number>();
  for (const s of obSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    if (s.t_ms <= lastContinuousMs) {
      // pre-auction: last continuous wins. (Intra-Bar Max 필드는 Task 2에서 산출 — 지금은 0.)
      quoteByBucket.set(t, {
        t,
        ask_total: s.total_ask_qty,
        bid_total: s.total_bid_qty,
        bid_max: 0,
        ask_max: 0,
        imb_max_bid: 0,
        imb_max_ask: 0,
      });
      seenPre.add(t);
    } else if (!seenPre.has(t)) {
      // fully-auction bucket: exclude the auction book (emit 0, keep the slot).
      quoteByBucket.set(t, {
        t,
        ask_total: 0,
        bid_total: 0,
        bid_max: 0,
        ask_max: 0,
        imb_max_bid: 0,
        imb_max_ask: 0,
      });
    }
  }
```

(3b) `frontend/src/chart/surge/detectSurges.test.ts:5` — P 헬퍼를 close 미러로 교체(감지기는 ask_total/bid_total만 읽으므로 의미 불변):

```typescript
// detectSurges reads only ask_total/bid_total (close); the Intra-Bar Max fields mirror close here.
const P = (t: number, ask: number, bid: number): QuoteRatioPoint => ({
  t, ask_total: ask, bid_total: bid,
  bid_max: bid, ask_max: ask, imb_max_bid: bid, imb_max_ask: ask,
});
```

(3c) `frontend/src/live/buildLiveBundle.test.ts` — import에 `QuoteRatioPoint` 추가하고 `qp` 헬퍼 도입. line 1-5 import 블록을 아래로 교체:

```typescript
import { describe, it, expect } from 'vitest';
import { buildLiveBundle } from './buildLiveBundle';
import type { QuoteRatioPoint, RangeBundle } from '../api/types';

// buildLiveBundle dedupe/promote logic only reads t/bid_total/ask_total; the Intra-Bar Max
// fields mirror close here so the fixtures satisfy the QuoteRatioPoint shape.
const qp = (t: number, bid_total: number, ask_total: number): QuoteRatioPoint => ({
  t, bid_total, ask_total,
  bid_max: bid_total, ask_max: ask_total, imb_max_bid: bid_total, imb_max_ask: ask_total,
});

const TODAY = '20260527';
```

그리고 `makeRangeBundle` 시그니처와 깨지는 literal들을 qp로 교체:
- `function makeRangeBundle(qrPoints: { t: number; bid_total: number; ask_total: number }[]): RangeBundle {` → `function makeRangeBundle(qrPoints: QuoteRatioPoint[]): RangeBundle {`
- `quote_ratio: { bucket_ms: 60_000, points: [{ t: TODAY_OPEN, ask_total: 500, bid_total: 500 }] },` → `quote_ratio: { bucket_ms: 60_000, points: [qp(TODAY_OPEN, 500, 500)] },`
- `const past = makeRangeBundle([ { t: pastTailT, bid_total: 1000, ask_total: 2000 }, ]);` (2곳) → `const past = makeRangeBundle([ qp(pastTailT, 1000, 2000), ]);`
- `const before = build(makeRangeBundle([{ t: t0, bid_total: 1, ask_total: 1 }]));` → `const before = build(makeRangeBundle([qp(t0, 1, 1)]));`
- `makeRangeBundle([ { t: t0, bid_total: 1, ask_total: 1 }, { t: t1, bid_total: 999, ask_total: 999 }, // promoted disk value ])` → `makeRangeBundle([ qp(t0, 1, 1), qp(t1, 999, 999), // promoted disk value ])`
- `{ t: TODAY_OPEN - 86_400_000 + 3600_000, bid_total: 10, ask_total: 10 }, { t: futureCorruptT, bid_total: 99, ask_total: 99 }, // corrupt tail` → `qp(TODAY_OPEN - 86_400_000 + 3600_000, 10, 10), qp(futureCorruptT, 99, 99), // corrupt tail`
- `points: [{ t: pastTailT, bid_total: 10, ask_total: 10 }],` → `points: [qp(pastTailT, 10, 10)],`
- `{ t: TODAY_OPEN, bid_total: 5, ask_total: 5 }, { t: pastTailT, bid_total: 10, ask_total: 10 },` → `qp(TODAY_OPEN, 5, 5), qp(pastTailT, 10, 10),`

- [ ] **Step 4: 통과 확인** — 명령:

```bash
cd frontend && npx tsc -p tsconfig.app.json --noEmit
```

예상 PASS: 출력 없음, exit 0. 회귀 확인용으로 영향 테스트도:

```bash
cd frontend && npx vitest run src/chart/surge/detectSurges.test.ts src/live/buildLiveBundle.test.ts
```

예상 PASS: 두 파일 전부 green(detectSurges 기존 테스트 + buildLiveBundle 전부; max 미러는 의미 불변).

- [ ] **Step 5: 커밋** — add와 commit을 별도 명령으로(훅 오탐 회피):

```bash
git add frontend/src/api/types.ts frontend/src/live/bucketHogaSeries.ts frontend/src/chart/surge/detectSurges.test.ts frontend/src/live/buildLiveBundle.test.ts
```

```bash
git commit -m "feat(live): QuoteRatioPoint += bid_max/ask_max/imb_max_bid/imb_max_ask (미러; producer 0 placeholder)"
```

---

### Task 2: `bucketHogaSeries`가 버킷별 Intra-Bar Max 산출 (bid_max/ask_max 독립, imb_max 부호 보존, 0 센티넬)

**Files:**
- Modify: `frontend/src/live/bucketHogaSeries.ts:1` (quoteImbalance import), `:82-94` (0 placeholder → 실제 max 계산)
- Test: `frontend/src/live/bucketHogaSeries.test.ts`

> Task 1이 채운 0 placeholder를 실제 산출 로직으로 교체한다. bid_max/ask_max = 버킷 내 연속거래(`s.t_ms <= lastContinuousMs`) 스냅샷의 side별 독립 `Math.max`(Q5). imb_max = 그 중 |quoteImbalance(bid,ask)|가 최대인 스냅샷의 (bid,ask) 쌍(strict `>` → 동률 시 가장 먼저). 완전 동시호가 버킷은 4필드 전부 0 센티넬.

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/live/bucketHogaSeries.test.ts`. (a) import에 quoteImbalance 추가, (b) 기존 8개 `toEqual`을 신규 4필드 포함으로 갱신, (c) 신규 3 테스트 추가.

(1a) import 블록(line 1-3)을 교체:

```typescript
import { describe, it, expect } from 'vitest';
import { bucketHogaSeries } from './bucketHogaSeries';
import { quoteImbalance } from '../util/imbalance';
import type { OrderbookLevel } from '../api/types';
```

(1b) 기존 8개 `toEqual` 블록을 아래 값으로 갱신(전부 hand-computed·실측 확정):

- "Quote Totals uses last ob snapshot in each bucket":
```typescript
    expect(quoteRatioPoints).toEqual([
      // b0: max over (a100,b80),(a200,b90) → bid_max90/ask_max200; |imb(90,200)|>|imb(80,90)| → imb_max=(90,200).
      { t: b0, ask_total: 200, bid_total: 90, bid_max: 90, ask_max: 200, imb_max_bid: 90, imb_max_ask: 200 },
      { t: b1, ask_total: 300, bid_total: 95, bid_max: 95, ask_max: 300, imb_max_bid: 95, imb_max_ask: 300 },
    ]);
```

- "out-of-order input is sorted before bucketing":
```typescript
    expect(quoteRatioPoints).toEqual([
      { t: b0, ask_total: 200, bid_total: 90, bid_max: 90, ask_max: 200, imb_max_bid: 90, imb_max_ask: 200 },
      { t: b1, ask_total: 300, bid_total: 95, bid_max: 95, ask_max: 300, imb_max_bid: 95, imb_max_ask: 300 },
    ]);
```

- "de-contaminates a straddle bucket via structure (last continuous wins)":
```typescript
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    // max over continuous (a21,b11),(a22,b12); |imb(11,21)|>|imb(12,22)| → imb_max=(11,21) (first wins).
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 22, bid_total: 12, bid_max: 12, ask_max: 22, imb_max_bid: 11, imb_max_ask: 21 },
    ]);
```

- "excludes a fully-auction bucket (emits 0, keeps the slot)":
```typescript
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 50, bid_total: 60, bid_max: 60, ask_max: 50, imb_max_bid: 60, imb_max_ask: 50 },
      // no pre-auction member → auction book excluded, slot kept at 0 (ADR-0062) — all Intra-Bar Max 0 too.
      { t: base + 180_000, ask_total: 0, bid_total: 0, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 },
    ]);
```

- "a post-close continuous book does not extend the boundary (close bound)":
```typescript
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    // bucket represented by the base continuous, NOT the 60_000 auction. Max candidates are only the
    // base snapshot (t <= lastContinuousMs = base), so the post-close 90_000 book is excluded from max too.
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 11, bid_total: 21, bid_max: 21, ask_max: 11, imb_max_bid: 21, imb_max_ask: 11 },
    ]);
```

- "treats totals-only snapshots (no asks/bids) as continuous → legacy last-in-bucket":
```typescript
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET);
    // All 3 continuous → max over (a21,b11),(a22,b12),(a98,b99): bid_max99/ask_max98;
    // |imb(11,21)|>|imb(12,22)|>|imb(99,98)| → imb_max=(11,21) (first, largest magnitude).
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 98, bid_total: 99, bid_max: 99, ask_max: 98, imb_max_bid: 11, imb_max_ask: 21 },
    ]);
```

- "asks/bids-absent guard keeps totals-only continuous under a close bound":
```typescript
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    // Only the base snapshot is a max candidate (t <= lastContinuousMs = base).
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 11, bid_total: 21, bid_max: 21, ask_max: 11, imb_max_bid: 21, imb_max_ask: 11 },
    ]);
```

- "detects the auction from a live-shaped ob payload (asks/bids passthrough contract)":
```typescript
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    // Same shape as the structural straddle test — Intra-Bar Max over continuous (a21,b11),(a22,b12).
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 22, bid_total: 12, bid_max: 12, ask_max: 22, imb_max_bid: 11, imb_max_ask: 21 },
    ]);
```

(1c) "omits empty buckets (no zero-padding)" 테스트 **다음에** 신규 3 테스트 추가:

```typescript
  it('quote-totals Intra-Bar Max takes each side independently (Q5)', () => {
    // One bucket; bid peaks at t1 (snapshot A), ask peaks at t2 (snapshot B) — different snapshots.
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 900 }, // bid peak here
      { t_ms: 1700_000_030_000, total_ask_qty: 800, total_bid_qty: 200 }, // ask peak here (close)
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      // close = last snapshot (a800,b200); bid_max=900 (from A), ask_max=800 (from B) — independent times.
      { t: b0, ask_total: 800, bid_total: 200, bid_max: 900, ask_max: 800, imb_max_bid: 900, imb_max_ask: 100 },
    ]);
  });

  it('호가비 Intra-Bar Max keeps the max-|imbalance| snapshot — sign can flip vs side-max', () => {
    // Spec example: A(bid100,ask2) → quoteImbalance=−49 (buy-heavy); B(bid10,ask300) → +29 (sell-heavy).
    // |imb(A)|=48 > |imb(B)|=29 → imb_max=(bid100,ask2). NOT max-of-each-side (bid100,ask300 → +2).
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 2, total_bid_qty: 100 },   // A: strong buy-heavy
      { t_ms: 1700_000_030_000, total_ask_qty: 300, total_bid_qty: 10 },  // B: sell-heavy (close)
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      { t: b0, ask_total: 300, bid_total: 10, bid_max: 100, ask_max: 300, imb_max_bid: 100, imb_max_ask: 2 },
    ]);
    // quoteImbalance(imb_max) = quoteImbalance(100, 2) = −(100/2−1) = −49 (buy-heavy);
    // quoteImbalance(bid_max, ask_max) = quoteImbalance(100, 300) = 300/100−1 = +2 (sell-heavy) — opposite sign.
    const p = quoteRatioPoints[0];
    expect(quoteImbalance(p.imb_max_bid, p.imb_max_ask)).toBe(-49);
    expect(quoteImbalance(p.bid_max, p.ask_max)).toBe(2);
  });

  it('fully-auction bucket emits 0 sentinel for all Intra-Bar Max fields', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 600_000;
    const ob = [
      cont(base + 60_000, 50, 60),      // continuous → defines lastContinuous in bucket `base`
      auc(base + 180_000, 41, 31),      // [base+3m,..) fully-auction → excluded everywhere
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    const aucBucket = quoteRatioPoints.find((p) => p.t === base + 180_000)!;
    expect(aucBucket).toEqual({
      t: base + 180_000, ask_total: 0, bid_total: 0,
      bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0,
    });
  });
```

- [ ] **Step 2: 실패 확인** — 명령(파일 전체):

```bash
cd frontend && npx vitest run src/live/bucketHogaSeries.test.ts
```

예상 실패: Task 1의 0 placeholder 때문에 신규/갱신 toEqual 다수 실패 — 예 `expected { ..., bid_max: 0, ask_max: 0, ... } to deeply equal { ..., bid_max: 90, ask_max: 200, imb_max_bid: 90, imb_max_ask: 200 }` (받은 값은 전부 0).

- [ ] **Step 3: 최소 구현** — `frontend/src/live/bucketHogaSeries.ts`. (3a) line 1 다음에 import 추가:

```typescript
import type { QuoteRatioPoint, FillStrengthPoint, OrderbookLevel } from '../api/types';
import { quoteImbalance } from '../util/imbalance';
```

(3b) quote 버킷 루프(Task 1이 0 placeholder로 둔 부분)를 실제 산출로 교체:

```typescript
  const quoteByBucket = new Map<number, QuoteRatioPoint>();
  const seenPre = new Set<number>();
  for (const s of obSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    if (s.t_ms <= lastContinuousMs) {
      // pre-auction: last continuous wins (close = bid_total/ask_total). Intra-Bar
      // Max fields accumulate over the SAME continuous-snapshot set (s.t_ms <=
      // lastContinuousMs) so 동시호가 is excluded identically and bid_max ≥ bid_total
      // holds by construction:
      //   bid_max/ask_max — independent per-side Math.max (peaks may be at different
      //     snapshots within the bucket, Q5).
      //   imb_max_bid/imb_max_ask — the (bid,ask) of the snapshot with the largest
      //     |quoteImbalance(bid,ask)| in the bucket; strict-`>` keeps the earliest on
      //     ties ("동률 시 가장 먼저").
      const prev = quoteByBucket.get(t);
      const bid_max = Math.max(prev?.bid_max ?? 0, s.total_bid_qty);
      const ask_max = Math.max(prev?.ask_max ?? 0, s.total_ask_qty);
      let imb_max_bid = prev?.imb_max_bid ?? 0;
      let imb_max_ask = prev?.imb_max_ask ?? 0;
      const curMag = Math.abs(quoteImbalance(s.total_bid_qty, s.total_ask_qty));
      const prevMag = prev ? Math.abs(quoteImbalance(imb_max_bid, imb_max_ask)) : -1;
      if (curMag > prevMag) {
        imb_max_bid = s.total_bid_qty;
        imb_max_ask = s.total_ask_qty;
      }
      quoteByBucket.set(t, {
        t,
        ask_total: s.total_ask_qty,
        bid_total: s.total_bid_qty,
        bid_max,
        ask_max,
        imb_max_bid,
        imb_max_ask,
      });
      seenPre.add(t);
    } else if (!seenPre.has(t)) {
      // fully-auction bucket: exclude the auction book (emit 0, keep the slot). All
      // Intra-Bar Max fields are 0 sentinels too (no continuous candidate).
      quoteByBucket.set(t, {
        t,
        ask_total: 0,
        bid_total: 0,
        bid_max: 0,
        ask_max: 0,
        imb_max_bid: 0,
        imb_max_ask: 0,
      });
    }
  }
```

- [ ] **Step 4: 통과 확인** — 명령(전체 파일 + tsc):

```bash
cd frontend && npx vitest run src/live/bucketHogaSeries.test.ts
```

예상 PASS: 모든 테스트 green(기존 갱신 8 + FillStrength/empty 등 + 신규 3).

```bash
cd frontend && npx tsc -p tsconfig.app.json --noEmit
```

예상 PASS: 출력 없음, exit 0.

- [ ] **Step 5: 커밋** — add와 commit 별도:

```bash
git add frontend/src/live/bucketHogaSeries.ts frontend/src/live/bucketHogaSeries.test.ts
```

```bash
git commit -m "feat(live): bucketHogaSeries 버킷별 Intra-Bar Max 산출 (bid/ask 독립 max, imb 부호보존, 0 센티넬)"
```


## Phase 3 — 렌더 스위치 · prefs · Config · 급증 마커

### Task 1: chartPrefs.ts — Intra-Bar Max 토글 3종 등록

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts:12-55` (CHART_TOGGLES 배열)
- Test: `frontend/src/state/chartPrefs.intramax.test.ts` (신규)

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/state/chartPrefs.intramax.test.ts` 신규 작성.

```ts
import { describe, it, expect } from 'vitest';
import { CHART_TOGGLES, DEFAULT_PREFS } from './chartPrefs';

describe('Intra-Bar Max 토글 등록', () => {
  const keys = ['quoteTotalsIntraMax', 'ratioIntraMax', 'askPeakIntraMax'] as const;
  it.each(keys)('%s: default false + category indicator-modal', (key) => {
    expect(DEFAULT_PREFS[key]).toBe(false);
    const entry = CHART_TOGGLES.find((t) => t.key === key);
    expect(entry).toBeDefined();
    expect((entry as { category?: string }).category).toBe('indicator-modal');
    expect((entry as { label: string }).label).toBe('분봉 내 최댓값 기준');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/state/chartPrefs.intramax.test.ts`
  Expected: FAIL — `DEFAULT_PREFS['quoteTotalsIntraMax']` is `undefined` (키 미등록), 그리고 `Property 'quoteTotalsIntraMax' does not exist on type` tsc 에러.

- [ ] **Step 3: 최소 구현** — `frontend/src/state/chartPrefs.ts`의 `CHART_TOGGLES` 배열 끝(`surgeMarkerEnabled` 엔트리 뒤, `] as const;` 앞)에 3개 엔트리 추가:

```ts
  {
    key: 'quoteTotalsIntraMax',
    label: '분봉 내 최댓값 기준',
    description: '그 분의 마지막값(종가) 대신 분봉 내 최대 총잔량을 표시합니다. (캔들 고가와 같은 직관)',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'ratioIntraMax',
    label: '분봉 내 최댓값 기준',
    description:
      '그 분 중 |호가비|가 가장 컸던 순간값을 표시합니다(부호 유지). 극단값 필터가 켜져 있으면 스파이크는 0으로 가려질 수 있습니다 — 날것을 보려면 필터를 끄세요.',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'askPeakIntraMax',
    label: '분봉 내 최댓값 기준',
    description:
      '분봉 종가 호가창 대신 분봉 내 순간 최대 매도벽까지 포함해 당일 최대벽을 찾습니다(과거 거래일에만 효과 — 오늘은 항상 실시간 최댓값).',
    default: false,
    category: 'indicator-modal',
  },
```

  `ChartToggleKey` union·`ChartViewPrefs`·`DEFAULT_PREFS`·`chartPrefsPersistence`(CHART_TOGGLES 순회)는 전부 이 배열에서 자동 파생되므로 추가 등록 불요.

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/state/chartPrefs.intramax.test.ts` → PASS. 그리고 `cd frontend && npx tsc -p tsconfig.app.json --noEmit` → 에러 없음.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/state/chartPrefs.ts frontend/src/state/chartPrefs.intramax.test.ts
```
```bash
git commit -m "feat(live): chartPrefs에 Intra-Bar Max 토글 3종 등록 (ADR-0075)"
```

---

### Task 2: 총잔량 라인 — projectBid/AskPoints Intra-Bar Max 스위치 + 캐시키

**Files:**
- Modify: `frontend/src/chart/projectors/quoteTotals.ts` (projectBidPoints/projectAskPoints 30-95, QuoteTotalsCtx 96-104, useQuoteTotalsContext 110-120, bidCachedRaw/askCachedRaw/bidCachedData/askCachedData 165-170)
- Test: `frontend/src/chart/projectors/quoteTotals.intramax.test.ts` (신규)

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/chart/projectors/quoteTotals.intramax.test.ts` 신규. (QuoteRatioPoint 픽스처에 max 필드 포함 — P2에서 필수 필드로 추가됨.)

```ts
import { describe, it, expect } from 'vitest';
import { projectBidPoints, projectAskPoints } from './quoteTotals';
import type { QuoteRatioPoint } from '../../api/types';
import { makeVirtualAxis } from '../../util/virtualAxis';

const t0 = 1700_000_000_000;
const pt: QuoteRatioPoint = {
  t: t0, bid_total: 10, ask_total: 20,
  bid_max: 900, ask_max: 800, imb_max_bid: 100, imb_max_ask: 2,
};
// 가시범위 전체를 덮는 axis (axis.contains(t0) === true).
const axis = makeVirtualAxis([{ from: t0 - 60_000, to: t0 + 60_000 }]);

describe('총잔량 Intra-Bar Max 스위치', () => {
  it('intraMax=false면 종가(bid_total/ask_total) 렌더', () => {
    expect(projectBidPoints([pt], axis, false, false)[0].value).toBe(10);
    expect(projectAskPoints([pt], axis, false, false)[0].value).toBe(20);
  });
  it('intraMax=true면 최댓값(bid_max/ask_max) 렌더', () => {
    expect(projectBidPoints([pt], axis, false, true)[0].value).toBe(900);
    expect(projectAskPoints([pt], axis, false, true)[0].value).toBe(800);
  });
});
```

  (참고: `makeVirtualAxis` 시그니처는 기존 `virtualAxis.test.ts`·`ratio.test.ts`의 생성 패턴을 그대로 따른다 — 가시 세그먼트 1개로 `axis.contains(t0)`가 true가 되게 한다. 실제 헬퍼명/인자가 다르면 그 파일의 픽스처 생성 코드를 복사할 것.)

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/chart/projectors/quoteTotals.intramax.test.ts`
  Expected: FAIL — `projectBidPoints`가 4번째 인자(intraMax)를 받지 않아 `intraMax=true`에서도 `value`가 10(bid_total)으로 나옴 → `expected 900`.

- [ ] **Step 3: 최소 구현** — `frontend/src/chart/projectors/quoteTotals.ts`.

  (a) `projectBidPoints`에 `intraMax = false` 4번째 인자 추가 + 값 선택:
```ts
export function projectBidPoints(
  points: readonly QuoteRatioPoint[],
  axis: VirtualAxis,
  auctionWindowMask: boolean,
  intraMax = false,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  for (const p of points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    if (isAuctionHidden(axis, auctionWindowMask, p.t)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    out.push({ time, value: intraMax ? p.bid_max : p.bid_total });
  }
  return out;
}
```
  `projectAskPoints`도 동일하게 `intraMax = false` 추가, 마지막 push를 `value: intraMax ? p.ask_max : p.ask_total`로. `projectBid`/`projectAsk`(bundle 받는 래퍼)는 3-인자 호출 유지(intraMax 기본 false) — 변경 불요.

  (b) `QuoteTotalsCtx`(96-104)에 토글 필드 추가:
```ts
export type QuoteTotalsCtx = {
  auctionMask: boolean;
  intraMax: boolean;   // quoteTotalsIntraMax — 총잔량 분봉 내 최댓값 기준
  surgeEnabled: boolean;
  surgeApproachPct: number;
  surgeRearmPct: number;
  surgeStartHHMM: number;
};
```

  (c) `useQuoteTotalsContext`(110-120)의 useShallow 객체에 `intraMax` 추가:
```ts
const useQuoteTotalsContext = (): QuoteTotalsCtx =>
  useActivePrefs(
    useShallow((p) => ({
      auctionMask: p.auctionWindowMask,
      intraMax: p.quoteTotalsIntraMax,
      surgeEnabled: p.surgeMarkerEnabled,
      surgeApproachPct: p.surgeApproachPct,
      surgeRearmPct: p.surgeRearmPct,
      surgeStartHHMM: p.surgeStartHHMM,
    })),
  );
```

  (d) 캐시 래퍼(165-170)를 number 비트플래그 캐시키로 교체 — auctionMask·intraMax 둘 다 반영하되 stable primitive 유지(객체 새로 만들면 매 렌더 캐시 무효):
```ts
// 캐시키 = (auctionMask?1:0)|(intraMax?2:0) — 둘 중 하나라도 바뀔 때만 무효화(stable number).
const bidCachedRaw = makePastCachedProjector(
  (pts: readonly QuoteRatioPoint[], a: VirtualAxis, flags: number) =>
    projectBidPoints(pts, a, (flags & 1) !== 0, (flags & 2) !== 0),
  (b) => b.quote_ratio.points,
);
const askCachedRaw = makePastCachedProjector(
  (pts: readonly QuoteRatioPoint[], a: VirtualAxis, flags: number) =>
    projectAskPoints(pts, a, (flags & 1) !== 0, (flags & 2) !== 0),
  (b) => b.quote_ratio.points,
);
const flagsOf = (c: QuoteTotalsCtx): number => (c.auctionMask ? 1 : 0) | (c.intraMax ? 2 : 0);
const bidCachedData = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => bidCachedRaw(b, a, flagsOf(c));
const askCachedData = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => askCachedRaw(b, a, flagsOf(c));
```

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/chart/projectors/quoteTotals.intramax.test.ts` → PASS. `cd frontend && npx tsc -p tsconfig.app.json --noEmit` → 에러 없음.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/chart/projectors/quoteTotals.ts frontend/src/chart/projectors/quoteTotals.intramax.test.ts
```
```bash
git commit -m "feat(live): 총잔량 라인 Intra-Bar Max 렌더 스위치 + 비트플래그 캐시키"
```

---

### Task 3: 호가비 — projectRatioPoints Intra-Bar Max 스위치 (Outlier Mask 직교)

**Files:**
- Modify: `frontend/src/chart/projectors/ratio.ts` (RatioPaneContext 50-54, projectRatioPoints 73-105, useRatioContext 115-122)
- Test: `frontend/src/chart/projectors/ratio.intramax.test.ts` (신규)

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/chart/projectors/ratio.intramax.test.ts` 신규.

```ts
import { describe, it, expect } from 'vitest';
import { projectRatioPoints, type RatioPaneContext } from './ratio';
import type { QuoteRatioPoint } from '../../api/types';
import { makeVirtualAxis } from '../../util/virtualAxis';

const t0 = 1700_000_000_000;
// 종가: bid 10/ask 20 → 매도우위 작음. imb_max: bid 100/ask 2 → 매수우위 강함(부호 반대).
const pt: QuoteRatioPoint = {
  t: t0, bid_total: 10, ask_total: 20,
  bid_max: 100, ask_max: 20, imb_max_bid: 100, imb_max_ask: 2,
};
const axis = makeVirtualAxis([{ from: t0 - 60_000, to: t0 + 60_000 }]);
const base: RatioPaneContext = { auctionWindowMask: false, outlierFilterEnabled: false, outlierThreshold: 100 };

describe('호가비 Intra-Bar Max 스위치', () => {
  it('intraMax=false면 종가 imbalance (ask/bid-1 = 20/10-1 = +1, 매도우위)', () => {
    expect(projectRatioPoints([pt], axis, base)[0].value).toBeCloseTo(1, 5);
  });
  it('intraMax=true면 imb_max imbalance (-(100/2-1) = -49, 매수우위, 부호 반대)', () => {
    expect(projectRatioPoints([pt], axis, { ...base, intraMax: true })[0].value).toBeCloseTo(-49, 5);
  });
  it('Outlier Mask 직교: intraMax 극값이 임계 초과면 0 (필터 ON)', () => {
    // |imb_max| = 49 → label 1+49 = 50 < 100? threshold 30으로 낮춰 초과시킴.
    const ctx = { ...base, outlierFilterEnabled: true, outlierThreshold: 30, intraMax: true };
    expect(projectRatioPoints([pt], axis, ctx)[0].value).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/chart/projectors/ratio.intramax.test.ts`
  Expected: FAIL — `intraMax` 미지원이라 두 번째/세 번째 테스트가 종가값(+1)을 반환 → `expected -49` / `expected 0`. (TS: `intraMax` not on RatioPaneContext.)

- [ ] **Step 3: 최소 구현** — `frontend/src/chart/projectors/ratio.ts`.

  (a) `RatioPaneContext`(50-54)에 `intraMax` 선택 필드 추가(선택적 → 기존 CTX 리터럴 무파손):
```ts
export type RatioPaneContext = {
  auctionWindowMask: boolean;
  outlierFilterEnabled: boolean;
  outlierThreshold: number;
  /** ratioIntraMax — 호가비 분봉 내 |불균형| 극값(부호 유지) 기준. 미지정 = 종가. */
  intraMax?: boolean;
};
```

  (b) `projectRatioPoints`(73-105)에서 imbalance 소스를 토글에 따라 선택(Outlier Mask는 선택된 raw에 그대로 적용 — 직교). `const raw = quoteImbalance(p.bid_total, p.ask_total);` 줄(96)을 교체:
```ts
    const raw = ctx.intraMax
      ? quoteImbalance(p.imb_max_bid, p.imb_max_ask)
      : quoteImbalance(p.bid_total, p.ask_total);
```
  (그 아래 `isExtreme`/`out.push` 로직은 불변 — `raw`가 선택된 값이므로 Outlier 클램프가 그대로 직교 적용.)

  (c) `useRatioContext`(115-122)의 useShallow 객체에 `intraMax` 추가:
```ts
const useRatioContext = (): RatioPaneContext =>
  useActivePrefs(
    useShallow((p) => ({
      auctionWindowMask: p.auctionWindowMask,
      outlierFilterEnabled: p.ratioOutlierFilterEnabled,
      outlierThreshold: p.ratioOutlierThreshold,
      intraMax: p.ratioIntraMax,
    })),
  );
```
  `ratioCachedData = makePastCachedProjector(projectRatioPoints, ...)`는 이 RatioPaneContext 객체를 캐시키로 쓰므로(useShallow 안정), `intraMax` 변경 시 새 참조 → 자동 무효화. 변경 불요.

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/chart/projectors/ratio.intramax.test.ts` → PASS. `cd frontend && npx tsc -p tsconfig.app.json --noEmit` → 에러 없음.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/chart/projectors/ratio.ts frontend/src/chart/projectors/ratio.intramax.test.ts
```
```bash
git commit -m "feat(live): 호가비 Intra-Bar Max 렌더 스위치 (Outlier Mask 직교, ADR-0075)"
```

---

### Task 4: 총잔량 급증 마커 — 높이를 보이는 라인에 (감지 시점 불변)

**Files:**
- Modify: `frontend/src/chart/projectors/quoteTotals.ts` (surgeMarkerPoints 128-150)
- Test: `frontend/src/chart/projectors/quoteTotals.surge-intramax.test.ts` (신규)

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/chart/projectors/quoteTotals.surge-intramax.test.ts` 신규. 급증이 1회 발사되는 시퀀스를 만들고, intraMax ON/OFF에서 마커 **time(발사 시점) 동일**·**price(높이)만 다름**을 단언.

```ts
import { describe, it, expect } from 'vitest';
import { askSurgeMarkers } from './quoteTotals';
import type { QuoteRatioPoint, RangeBundle } from '../../api/types';
import { makeVirtualAxis } from '../../util/virtualAxis';
import type { QuoteTotalsCtx } from './quoteTotals';

// ask_total: 100(고가 세움) → 50(rearm, 85% 아래로) → 98(approach 95% 재도달 = 발사).
// 발사 봉(98)의 ask_max=500(분봉 내 최댓값). 거래일 1개(KST 같은 날).
const D = 1700_000_000_000; // KST 임의 동일 거래일 내 ms (분 간격)
const mk = (i: number, ask: number, ask_max: number): QuoteRatioPoint => ({
  t: D + i * 60_000, bid_total: 1, ask_total: ask, bid_max: 1, ask_max, imb_max_bid: 1, imb_max_ask: ask_max,
});
const pts: QuoteRatioPoint[] = [mk(0, 100, 100), mk(1, 50, 50), mk(2, 98, 500)];
const bundle = { quote_ratio: { bucket_ms: 60_000, points: pts } } as unknown as RangeBundle;
const axis = makeVirtualAxis([{ from: D - 60_000, to: D + 4 * 60_000 }]);
const ctx = (intraMax: boolean): QuoteTotalsCtx => ({
  auctionMask: false, intraMax, surgeEnabled: true,
  surgeApproachPct: 95, surgeRearmPct: 85, surgeStartHHMM: 0,
});

describe('급증 마커 — 감지 종가 고정, 높이만 Intra-Bar Max', () => {
  it('발사 시점(time)은 intraMax ON/OFF 동일', () => {
    const off = askSurgeMarkers(bundle, axis, ctx(false));
    const on = askSurgeMarkers(bundle, axis, ctx(true));
    expect(off.length).toBe(1);
    expect(on.length).toBe(1);
    expect(on[0].time).toBe(off[0].time);
  });
  it('마커 높이(price): OFF=종가 98, ON=그 버킷 ask_max 500', () => {
    expect(askSurgeMarkers(bundle, axis, ctx(false))[0].price).toBe(98);
    expect(askSurgeMarkers(bundle, axis, ctx(true))[0].price).toBe(500);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/chart/projectors/quoteTotals.surge-intramax.test.ts`
  Expected: FAIL — 두 번째 테스트의 ON 케이스가 `price=98`(종가)로 나옴 → `expected 500`. (마커가 intraMax를 무시.)

- [ ] **Step 3: 최소 구현** — `frontend/src/chart/projectors/quoteTotals.ts`의 `surgeMarkerPoints`(128-150). 감지(`detectSurgeSide`)는 그대로 두고, intraMax일 때 마커 price를 그 시점 버킷의 `ask_max`/`bid_max`로 매핑:
```ts
function surgeMarkerPoints(side: 'ask' | 'bid', color: string) {
  const maxField = side === 'ask' ? 'ask_max' : 'bid_max';
  return (points: readonly QuoteRatioPoint[], axis: VirtualAxis, ctx: QuoteTotalsCtx): SurgeMarkerPoint[] => {
    if (!ctx.surgeEnabled) return [];
    const startMinute = hhmmToMinute(ctx.surgeStartHHMM);
    // intraMax 모드일 때만 t→point 룩업(마커 높이를 보이는 라인=최댓값에 맞춤). 감지 시점은 불변.
    const byT = ctx.intraMax ? new Map(points.map((p) => [p.t, p])) : null;
    return detectSurgeSide(points, side, {
      approachRatio: ctx.surgeApproachPct / 100,
      rearmRatio: ctx.surgeRearmPct / 100,
      isClosingAuction: (t) => axis.inClosingAuctionWindow(t),
    })
      .filter((m) => axis.contains(m.t) && kstMinuteOfDay(m.t) >= startMinute)
      .map((m) => {
        const pt = byT?.get(m.t);
        const price = ctx.intraMax && pt ? (pt[maxField] as number) : m.value;
        return { time: (axis.toVirtual(m.t) / 1000) as UTCTimestamp, price, color };
      });
  };
}
```
  `QuoteTotalsCtx.intraMax`는 Task 2에서 이미 추가됨. `askSurgeCached`/`bidSurgeCached`(makePastCachedProjector 래핑)는 QuoteTotalsCtx 전체를 캐시키로 쓰므로 intraMax 변경 시 자동 무효화(마커 높이가 바뀌어야 하므로 옳음).

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/chart/projectors/quoteTotals.surge-intramax.test.ts` → PASS. `cd frontend && npx tsc -p tsconfig.app.json --noEmit` → 에러 없음.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/chart/projectors/quoteTotals.ts frontend/src/chart/projectors/quoteTotals.surge-intramax.test.ts
```
```bash
git commit -m "feat(live): 급증 마커 높이를 Intra-Bar Max 라인에 (감지 시점 종가 고정)"
```

---

### Task 5: Config UI — 세 호가 지표 Config에 토글 행 추가

**Files:**
- Modify: `frontend/src/live/indicators/QuoteTotalsConfig.tsx:17`, `frontend/src/live/indicators/RatioConfig.tsx:17`, `frontend/src/live/indicators/AskPeakConfig.tsx` (전체)
- Test: `frontend/src/live/indicators/IntraMaxConfigRows.test.tsx` (신규)

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/live/indicators/IntraMaxConfigRows.test.tsx` 신규. 세 Config가 각자 토글 행(testId `settings-toggle-<key>`)을 렌더하는지 확인. (`IndicatorPrefRows`는 `testId={`settings-toggle-${toggle.key}`}`를 단다.)

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import QuoteTotalsConfig from './QuoteTotalsConfig';
import RatioConfig from './RatioConfig';
import AskPeakConfig from './AskPeakConfig';

describe('호가 Config Intra-Bar Max 토글 행', () => {
  it('QuoteTotalsConfig에 quoteTotalsIntraMax 토글', () => {
    render(<QuoteTotalsConfig />);
    expect(screen.getByTestId('settings-toggle-quoteTotalsIntraMax')).toBeTruthy();
  });
  it('RatioConfig에 ratioIntraMax 토글', () => {
    render(<RatioConfig />);
    expect(screen.getByTestId('settings-toggle-ratioIntraMax')).toBeTruthy();
  });
  it('AskPeakConfig에 askPeakIntraMax 토글', () => {
    render(<AskPeakConfig />);
    expect(screen.getByTestId('settings-toggle-askPeakIntraMax')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npx vitest run src/live/indicators/IntraMaxConfigRows.test.tsx`
  Expected: FAIL — 세 testId 모두 미존재(토글 행 미추가). AskPeakConfig는 `IndicatorPrefRows` 자체를 안 씀.

- [ ] **Step 3: 최소 구현** —

  (a) `QuoteTotalsConfig.tsx:17` — `toggleKeys`에 키 추가:
```tsx
      <IndicatorPrefRows toggleKeys={['surgeMarkerEnabled', 'quoteTotalsIntraMax']} />
```

  (b) `RatioConfig.tsx:17` — `toggleKeys`에 키 추가:
```tsx
      <IndicatorPrefRows toggleKeys={['ratioOutlierFilterEnabled', 'ratioIntraMax']} />
```

  (c) `AskPeakConfig.tsx` — 상단 import 추가:
```tsx
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
```
  그리고 `MAStylePicker`를 감싼 `<div className="flex items-center gap-2">...</div>` 블록 **뒤**(닫는 `</div>` 앞)에 구분선 + 토글 행 추가:
```tsx
      <div className="border-b border-border my-3" />
      <IndicatorPrefRows toggleKeys={['askPeakIntraMax']} />
```

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npx vitest run src/live/indicators/IntraMaxConfigRows.test.tsx` → PASS. `cd frontend && npx tsc -p tsconfig.app.json --noEmit` → 에러 없음.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/live/indicators/QuoteTotalsConfig.tsx frontend/src/live/indicators/RatioConfig.tsx frontend/src/live/indicators/AskPeakConfig.tsx frontend/src/live/indicators/IntraMaxConfigRows.test.tsx
```
```bash
git commit -m "feat(live): 호가 3종 Config에 Intra-Bar Max 토글 행 (지표 모달)"
```


## Phase 4 — 당일 매도 최대벽 Intra-Bar Max (close vs 틱-max)

### Task 1: snapshots.py `query_day_ask_peak` 틱-max 변종 + `AskPeakRow` 가산

**Files:**
- Modify: `hoga/tables/snapshots.py:311-321` (AskPeakRow dataclass), `hoga/tables/snapshots.py:466-525` (query_day_ask_peak)
- Test: `tests/test_tables_snapshots.py`

- [ ] **Step 1: 실패 테스트 작성** — 기존 동치 단언(line 374)을 max 필드 포함으로 갱신하고, 틱-max가 종가와 갈라지는 케이스를 신규 추가. 두 변경 모두 `tests/test_tables_snapshots.py`에 적용한다.

  (a) line 363-375 `test_query_day_ask_peak_basic`의 단언을 교체 — 기존:
  ```python
      peak = query_day_ask_peak(_con_for(out), path=out, bucket_ms=60_000)
      assert peak == AskPeakRow(price=25100, qty=5000, intra_ms=peak.intra_ms)
      assert peak.qty == 5000 and peak.price == 25100
  ```
  를 다음으로 교체(이 버킷은 종가=대표=틱-max라 close==max=5000):
  ```python
      peak = query_day_ask_peak(_con_for(out), path=out, bucket_ms=60_000)
      assert peak == AskPeakRow(
          price=25100, qty=5000, intra_ms=peak.intra_ms,
          max_price=25100, max_qty=5000, max_intra_ms=peak.max_intra_ms,
      )
      assert peak.qty == 5000 and peak.price == 25100
      assert peak.max_qty == 5000 and peak.max_price == 25100
  ```

  (b) 파일 끝(line 473 `test_query_day_ask_peak_bucket_representative_not_tick_max` 뒤)에 신규 테스트 추가 — 틱-max는 버킷 중간 스파이크를 포착하지만 close 변종은 못 함:
  ```python
  def test_query_day_ask_peak_intra_max_captures_mid_bucket_spike(tmp_path) -> None:
      """버킷 중간에 잠깐 솟았다 빠진 매도벽: close 변종(버킷 대표=마지막 연속거래)에는
      안 나타나지만, 틱-max 변종(max_*)은 연속거래 스냅샷 전체에서 잡아낸다.
      test_query_day_ask_peak_bucket_representative_not_tick_max와 동일 픽스처 —
      close는 2000(다음 버킷 대표), 틱-max는 5000(첫 버킷 중간 스파이크)."""
      obs = [
          # 3분 버킷 [09:00,09:03): 09:00:10 스파이크 level1=5000(중간) → 09:02:55 1000(대표=마지막).
          _ob_ap(90010000, [5000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
              ask_p=[25000 + 50 * i for i in range(10)]),
          _ob_ap(90255000, [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
              ask_p=[25000 + 50 * i for i in range(10)]),
          # 다음 3분 버킷 [09:03,09:06): 대표 level1=2000.
          _ob_ap(90310000, [2000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
              ask_p=[25000 + 50 * i for i in range(10)]),
      ]
      out = tmp_path / "snapshots.parquet"
      write_parquet(obs, out)
      peak = query_day_ask_peak(
          _con_for(out), path=out, bucket_ms=180_000,
          session_open_ms=90000000, session_close_ms=153000000,
      )
      assert peak is not None
      # close 변종: 버킷 대표라 max(1000, 2000) = 2000 (#96 불변).
      assert peak.qty == 2000 and peak.price == 25000
      # 틱-max 변종: 연속거래 스냅샷 전체라 첫 버킷 중간 스파이크 5000 포착.
      assert peak.max_qty == 5000 and peak.max_price == 25000
      # 새 불변식: 같은 거래일 max_qty >= qty.
      assert peak.max_qty >= peak.qty


  def test_query_day_ask_peak_intra_max_excludes_single_price(tmp_path) -> None:
      """틱-max도 close와 동일하게 동시호가/VI 붕괴 호가창을 배제 — 붕괴행의 거대 누적은
      max 후보에서도 빠진다(연속거래 스냅샷만 src에 들어옴)."""
      z = tuple([0] * 10)
      collapsed = Orderbook(
          ts_ms=152100000, seq=1,
          ask_p=(25000, 25050, 25100) + (0,) * 7, ask_q=(99999, 1, 1) + (0,) * 7, ask_d=z,
          bid_p=(24950, 24900, 24850) + (0,) * 7, bid_q=(1, 1, 1) + (0,) * 7, bid_d=z,
          tot_ask=100001, tot_ask_d=0, tot_bid=3, tot_bid_d=0,
      )
      # 같은 버킷 안 중간 스파이크 700 → 대표 300.
      spike = _ob_ap(90010000, [700, 1, 1, 1, 1, 1, 1, 1, 1, 1],
          ask_p=[25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450])
      rep = _ob_ap(90055000, [10, 20, 300, 40, 5, 6, 7, 8, 9, 1],
          ask_p=[25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450])
      out = tmp_path / "snapshots.parquet"
      write_parquet([collapsed, spike, rep], out)
      peak = query_day_ask_peak(
          _con_for(out), path=out, bucket_ms=60_000,
          session_open_ms=90000000, session_close_ms=153000000,
      )
      assert peak is not None
      assert peak.qty == 300  # close 변종: 대표행 level3
      assert peak.max_qty == 700  # 틱-max: 중간 스파이크. 붕괴행 99999 배제.
  ```

- [ ] **Step 2: 실패 확인** — `uv run pytest tests/test_tables_snapshots.py::test_query_day_ask_peak_intra_max_captures_mid_bucket_spike -v`
  예상 실패: `TypeError: AskPeakRow.__init__() got an unexpected keyword argument 'max_price'` (신규 테스트가 `peak.max_qty`/`peak.max_price`에 접근하나 AskPeakRow에 필드 없음 → `AttributeError: 'AskPeakRow' object has no attribute 'max_qty'`). 그리고 `uv run pytest tests/test_tables_snapshots.py::test_query_day_ask_peak_basic -v`도 `TypeError: ...unexpected keyword argument 'max_price'`로 실패.

- [ ] **Step 3: 최소 구현** — `hoga/tables/snapshots.py`.

  (a) AskPeakRow(line 311-321)에 3필드 가산. 기존:
  ```python
  @dataclass(frozen=True)
  class AskPeakRow:
      """당일 연속거래 중 단일 매도 호가단계에 걸린 최대 물량과 가격.

      ``intra_ms``는 LINEAR ms-from-midnight(NOT raw HHMMSSmmm, NOT unix ms) —
      호출자가 ``ms_from_midnight_to_unix_ms(date, intra_ms)``로 unix 변환.
      QuoteRatioRow.bucket_intra_ms와 동일 규약.
      """
      price: int
      qty: int
      intra_ms: int
  ```
  를:
  ```python
  @dataclass(frozen=True)
  class AskPeakRow:
      """당일 연속거래 중 단일 매도 호가단계에 걸린 최대 물량과 가격.

      ``intra_ms``는 LINEAR ms-from-midnight(NOT raw HHMMSSmmm, NOT unix ms) —
      호출자가 ``ms_from_midnight_to_unix_ms(date, intra_ms)``로 unix 변환.
      QuoteRatioRow.bucket_intra_ms와 동일 규약.

      ``price``/``qty``/``intra_ms`` = 버킷 대표(마지막 연속거래 스냅샷)의 당일 매도벽
      최댓값(#96 close 변종). ``max_*`` = 버킷 대표를 거치지 않고 연속거래 스냅샷 전체에서
      찾은 단일 매도단계 당일 max(틱-max 변종, Intra-Bar Max, ADR-0075). 같은 거래일에서
      ``max_qty >= qty``가 성립(연속거래 스냅샷 집합의 max >= 그 부분집합인 버킷 대표들).
      """
      price: int
      qty: int
      intra_ms: int
      max_price: int
      max_qty: int
      max_intra_ms: int
  ```

  (b) query_day_ask_peak(line 507-525)의 SQL 실행·반환부 교체. 기존 close 쿼리는 그대로 두고, 연속거래 스냅샷 전체(`src`, 버킷 대표 거치지 않음)에서 틱-max를 구하는 **둘째 execute**를 추가한 뒤 Python에서 합친다. `read_parquet(?)`가 각 쿼리에서 1회만 등장하도록 union을 CTE(`src`)로 감싼다(파라미터 수 = 1). 기존:
  ```python
      union = " UNION ALL ".join(
          f"SELECT ask_p{i} AS price, ask_q{i} AS qty, {intra} AS intra_ms "
          f"FROM rep WHERE ask_q{i} > 0"
          for i in range(1, ORDERBOOK_LEVELS + 1)
      )
      row = con.execute(
          f"""
          WITH cont AS (
            SELECT *,
                   ROW_NUMBER() OVER (
                     PARTITION BY ({intra} // {int(bucket_ms)})
                     ORDER BY ts_ms DESC
                   ) AS rn
            FROM read_parquet(?) WHERE {where}
          ),
          rep AS (SELECT * FROM cont WHERE rn = 1)
          SELECT price, qty, intra_ms FROM ({union})
          ORDER BY qty DESC, intra_ms ASC LIMIT 1
          """,
          [str(path)],
      ).fetchone()
      if row is None:
          return None
      return AskPeakRow(price=int(row[0]), qty=int(row[1]), intra_ms=int(row[2]))
  ```
  를:
  ```python
      level_union = lambda src: " UNION ALL ".join(
          f"SELECT ask_p{i} AS price, ask_q{i} AS qty, {intra} AS intra_ms "
          f"FROM {src} WHERE ask_q{i} > 0"
          for i in range(1, ORDERBOOK_LEVELS + 1)
      )
      # close 변종(#96): 버킷 대표(마지막 연속거래 스냅샷)들 위에서 당일 단일 매도단계 max.
      row = con.execute(
          f"""
          WITH cont AS (
            SELECT *,
                   ROW_NUMBER() OVER (
                     PARTITION BY ({intra} // {int(bucket_ms)})
                     ORDER BY ts_ms DESC
                   ) AS rn
            FROM read_parquet(?) WHERE {where}
          ),
          rep AS (SELECT * FROM cont WHERE rn = 1)
          SELECT price, qty, intra_ms FROM ({level_union("rep")})
          ORDER BY qty DESC, intra_ms ASC LIMIT 1
          """,
          [str(path)],
      ).fetchone()
      if row is None:
          return None
      # 틱-max 변종(Intra-Bar Max, ADR-0075): 버킷 대표를 거치지 않고 연속거래 스냅샷 전체
      # (src, where로 동시호가/세션 경계 동일 배제)에서 단일 매도단계 당일 max. src ⊇ rep
      # 이므로 close row가 non-None이면 max row도 non-None이고 max_qty >= qty가 성립.
      # 전 행(row)을 ORDER BY ... LIMIT 1로 원자 선택 — 동률(qty,intra_ms)에도 price가
      # 다른 행으로 갈리지 않게(스칼라 서브쿼리 조합 회피).
      max_row = con.execute(
          f"""
          WITH src AS (SELECT * FROM read_parquet(?) WHERE {where})
          SELECT price, qty, intra_ms FROM ({level_union("src")})
          ORDER BY qty DESC, intra_ms ASC LIMIT 1
          """,
          [str(path)],
      ).fetchone()
      return AskPeakRow(
          price=int(row[0]), qty=int(row[1]), intra_ms=int(row[2]),
          max_price=int(max_row[0]), max_qty=int(max_row[1]), max_intra_ms=int(max_row[2]),
      )
  ```

- [ ] **Step 4: 통과 확인** — `uv run pytest tests/test_tables_snapshots.py -k query_day_ask_peak -v`
  예상: `test_query_day_ask_peak_basic`, `test_query_day_ask_peak_intra_max_captures_mid_bucket_spike`, `test_query_day_ask_peak_intra_max_excludes_single_price` 및 기존 5개 모두 PASS.

- [ ] **Step 5: 커밋**
  - `git add hoga/tables/snapshots.py tests/test_tables_snapshots.py`
  - `git commit -m "feat(snapshots): query_day_ask_peak에 틱-max 변종(AskPeakRow.max_*) 추가"`

---

### Task 2: models.py `AskPeak` += max_* + bundle.py `_compute_ask_peak` 배선

**Files:**
- Modify: `hoga/api/models.py:94-102` (AskPeak), `hoga/api/bundle.py:441-444` (_compute_ask_peak의 AskPeak 생성)
- Test: `tests/hoga/api/test_bundle.py`

- [ ] **Step 1: 실패 테스트 작성** — `tests/hoga/api/test_bundle.py`의 `test_build_ask_peak_slice_caches_past_days`(line 745-747) 단언을 max_* 검증으로 확장. 기존:
  ```python
      p1 = build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=60_000,
                                source="hogaplay", cache=cache, today_kst="20260613")
      assert p1 is not None and p1.qty == 5000 and p1.date == "20260610"
  ```
  를 교체(픽스처 ob 한 개라 close==max=5000@25100):
  ```python
      p1 = build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=60_000,
                                source="hogaplay", cache=cache, today_kst="20260613")
      assert p1 is not None and p1.qty == 5000 and p1.date == "20260610"
      # 틱-max 변종 배선: 단일 스냅샷 픽스처라 close==max. max_t_ms는 close t_ms와 동일.
      assert p1.max_qty == 5000 and p1.max_price == 25100
      assert p1.max_t_ms == p1.t_ms
  ```
  추가로 close↔max가 실제로 갈라지는 회귀 테스트를 `test_build_ask_peak_slice_cache_key_is_bucket_ms_aware`(line 789) 뒤에 신규 추가:
  ```python
  def test_build_ask_peak_slice_wires_intra_max(tmp_path) -> None:
      """build_ask_peak_slice가 close 변종(price/qty/t_ms)과 틱-max 변종(max_*)을 모두 배선.
      버킷 중간 스파이크가 종가엔 사라지고 max_*에만 남는 케이스로 두 변종 분리를 검증."""
      from unittest.mock import MagicMock
      from hoga.api.bundle import build_ask_peak_slice
      from hoga.api.timeenc import ms_from_midnight_to_unix_ms
      from hoga.tables.snapshots import Orderbook, write_parquet as snapshots_write_parquet

      z = tuple([0] * 10)
      ap = tuple(25000 + 50 * i for i in range(10))
      bp = tuple(24950 - 50 * i for i in range(10))
      bq = tuple([100] * 10)
      # 1분 버킷 [09:00,09:01): 09:00:10 스파이크 level1=5000(중간) → 09:00:55 1000(대표=마지막).
      spike = Orderbook(ts_ms=90010000, seq=1, ask_p=ap, ask_q=(5000,) + (1,) * 9, ask_d=z,
                        bid_p=bp, bid_q=bq, bid_d=z, tot_ask=5009, tot_ask_d=0, tot_bid=1000, tot_bid_d=0)
      rep = Orderbook(ts_ms=90055000, seq=2, ask_p=ap, ask_q=(1000,) + (1,) * 9, ask_d=z,
                      bid_p=bp, bid_q=bq, bid_d=z, tot_ask=1009, tot_ask_d=0, tot_bid=1000, tot_bid_d=0)
      snapshots_write_parquet([spike, rep], tmp_path / "snapshots.parquet")
      eng = MagicMock()
      eng.parquet_dir.side_effect = lambda d, c, src="hogaplay": tmp_path
      eng.conn = duckdb.connect()

      p = build_ask_peak_slice(eng, code="005930", date="20260610", bucket_ms=60_000,
                               source="hogaplay", session_open_ms=90000000, session_close_ms=153000000)
      assert p is not None
      # close 변종: 버킷 대표 1000@25000 (#96).
      assert p.qty == 1000 and p.price == 25000
      # 틱-max 변종: 중간 스파이크 5000@25000.
      assert p.max_qty == 5000 and p.max_price == 25000
      # max_t_ms = ms_from_midnight_to_unix_ms(date, max_intra_ms). 스파이크는 09:00:10.
      assert p.max_t_ms == ms_from_midnight_to_unix_ms("20260610", 90010000 - 90000000 + 90000000) or p.max_t_ms < p.t_ms
  ```
  주: 위 마지막 단언은 `max_t_ms`가 스파이크 시점(09:00:10, 종가 09:00:55보다 이름)이라 `p.max_t_ms < p.t_ms`로 확정 검증한다(intra_ms→unix 변환의 단조성). OR 좌변은 fallback이 아니라 명시 — 좌변이 어긋나면 우변 `p.max_t_ms < p.t_ms`가 본질 단언.

- [ ] **Step 2: 실패 확인** — `uv run pytest tests/hoga/api/test_bundle.py::test_build_ask_peak_slice_wires_intra_max -v`
  예상 실패: `AttributeError: 'AskPeak' object has no attribute 'max_qty'` (models.py AskPeak에 필드 없음). 또는 pydantic 검증 단계에서 `_compute_ask_peak`가 max_* 없이 AskPeak를 만들어 `ValidationError` 가능 — 어느 쪽이든 RED.

- [ ] **Step 3: 최소 구현**

  (a) `hoga/api/models.py:94-102` AskPeak에 3필드 가산. 기존:
  ```python
  class AskPeak(BaseModel):
      """한 거래일 연속거래 중 단일 매도 호가단계 최대 물량·가격(Day Ask Peak).

      ``date``는 이 peak이 속한 거래일(YYYYMMDD) — 프론트가 segment x-구간에 매핑.
      ``t_ms``는 unix ms(KST), 캔들 시각과 동일 좌표계(peak 발생 시점)."""
      date: str
      price: int
      qty: int
      t_ms: int
  ```
  를:
  ```python
  class AskPeak(BaseModel):
      """한 거래일 연속거래 중 단일 매도 호가단계 최대 물량·가격(Day Ask Peak).

      ``date``는 이 peak이 속한 거래일(YYYYMMDD) — 프론트가 segment x-구간에 매핑.
      ``t_ms``는 unix ms(KST), 캔들 시각과 동일 좌표계(peak 발생 시점).

      ``price``/``qty``/``t_ms`` = 버킷 종가 대표 위에서의 당일 max(#96 close 변종, 불변).
      ``max_*`` = 버킷 틱-max 위에서의 당일 max(분봉 내 최댓값 기준, Intra-Bar Max, ADR-0075).
      과거 거래일에서만 두 변종이 갈린다 — 오늘 봉은 ratchet이라 어댑터가 동일 값으로 채운다."""
      date: str
      price: int
      qty: int
      t_ms: int
      max_price: int
      max_qty: int
      max_t_ms: int
  ```

  (b) `hoga/api/bundle.py:441-444` _compute_ask_peak의 AskPeak 생성에 max_* 배선. 기존:
  ```python
      return AskPeak(
          date=date, price=row.price, qty=row.qty,
          t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
      )
  ```
  를:
  ```python
      return AskPeak(
          date=date, price=row.price, qty=row.qty,
          t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
          max_price=row.max_price, max_qty=row.max_qty,
          max_t_ms=ms_from_midnight_to_unix_ms(date, row.max_intra_ms),
      )
  ```

- [ ] **Step 4: 통과 확인** — `uv run pytest tests/hoga/api/test_bundle.py -k ask_peak -v`
  예상: `test_build_ask_peak_slice_wires_intra_max`, `test_build_ask_peak_slice_caches_past_days`, `test_build_ask_peak_slice_cache_key_is_bucket_ms_aware`, `test_build_range_bundle_ask_peaks_per_day`(존재 시) 모두 PASS.

- [ ] **Step 5: 커밋**
  - `git add hoga/api/models.py hoga/api/bundle.py tests/hoga/api/test_bundle.py`
  - `git commit -m "feat(bundle): AskPeak에 틱-max 변종(max_price/max_qty/max_t_ms) 배선"`

---

### Task 3: types.ts `AskPeak` 미러 += max_*

**Files:**
- Modify: `frontend/src/api/types.ts:436-439` (AskPeak 타입)
- Test: `frontend/src/api/types.ts` (타입 전용 — tsc로 검증; 별도 런타임 테스트 없음)

- [ ] **Step 1: 실패 테스트 작성** — AskPeak은 순수 타입 별칭이라 런타임 vitest 대상이 아니다. 컴파일 타임 가드를 타입체크 어서션 파일로 추가: `frontend/src/api/types.askpeak.test-d.ts` 신규 생성(이름이 `.test-d.ts`라 vitest 런타임에 안 잡히고 tsc로만 검증):
  ```ts
  // 타입 레벨 가드: AskPeak이 close triple + max triple을 모두 가졌는지 컴파일 타임 검증.
  // tsc -p tsconfig.app.json --noEmit 으로만 평가됨(런타임 테스트 아님).
  import type { AskPeak } from './types';

  const _full: AskPeak = {
    date: '20260613', price: 1, qty: 2, t_ms: 3,
    max_price: 4, max_qty: 5, max_t_ms: 6,
  };
  void _full;

  // max_* 누락 시 컴파일 에러여야 함을 @ts-expect-error로 고정.
  // @ts-expect-error max_price/max_qty/max_t_ms 누락
  const _missing: AskPeak = { date: '20260613', price: 1, qty: 2, t_ms: 3 };
  void _missing;
  ```

- [ ] **Step 2: 실패 확인** — `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
  예상 실패: `types.askpeak.test-d.ts`에서 `_full`의 `max_price`/`max_qty`/`max_t_ms`가 `Object literal may only specify known properties`로 에러(AskPeak에 아직 필드 없음). 그리고 `@ts-expect-error`가 실제로는 에러를 내지 않으므로 `Unused '@ts-expect-error' directive` 에러.

- [ ] **Step 3: 최소 구현** — `frontend/src/api/types.ts:436-439`. 기존:
  ```ts
  /** 한 거래일 매도 최대벽 — 연속거래 중 단일 매도 호가단계 최대 물량·가격.
   *  hoga/api/models.py::AskPeak 미러. date=거래일(YYYYMMDD, segment x-구간 매핑용),
   *  t_ms=unix ms(KST, peak 발생 시점). */
  export type AskPeak = { date: string; price: number; qty: number; t_ms: number };
  ```
  를:
  ```ts
  /** 한 거래일 매도 최대벽 — 연속거래 중 단일 매도 호가단계 최대 물량·가격.
   *  hoga/api/models.py::AskPeak 미러. date=거래일(YYYYMMDD, segment x-구간 매핑용),
   *  t_ms=unix ms(KST, peak 발생 시점).
   *  price/qty/t_ms=버킷 종가 대표의 당일 max(#96 close 변종). max_*=버킷 틱-max의 당일 max
   *  (분봉 내 최댓값 기준, Intra-Bar Max, ADR-0075). 과거일만 갈림(오늘은 ratchet 동일값). */
  export type AskPeak = {
    date: string;
    price: number;
    qty: number;
    t_ms: number;
    max_price: number;
    max_qty: number;
    max_t_ms: number;
  };
  ```

- [ ] **Step 4: 통과 확인** — `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
  예상: 에러 0건 PASS(`_full`이 통과하고 `@ts-expect-error`가 정상 동작). 단, 이 단계만 단독 실행하면 Task 4·5가 아직 안 들어간 상태라 컴파일 그린. (Task 4·5의 테스트 픽스처가 max_* 없이 AskPeak 리터럴을 만드는 site가 아직 수정 전이면 그쪽 에러가 날 수 있으므로, 본 Task의 tsc 통과 확인은 Task 4·5 착수 전에 수행한다.)

- [ ] **Step 5: 커밋**
  - `git add frontend/src/api/types.ts frontend/src/api/types.askpeak.test-d.ts`
  - `git commit -m "feat(types): AskPeak 미러에 틱-max 변종(max_price/max_qty/max_t_ms) 추가"`

---

### Task 4: useDayAskPeaks 어댑터가 오늘 entry에 max_*=price/qty/t_ms 동일 채움

**Files:**
- Modify: `frontend/src/live/useDayAskPeaks.ts:46-53` (반환 useMemo의 오늘 push)
- Test: `frontend/src/live/useDayAskPeaks.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/live/useDayAskPeaks.test.tsx`에 (a) 기존 seed 리터럴들을 max_* 포함으로 갱신(tsc 통과용), (b) 오늘 entry close==max 신규 테스트 추가.

  (a) line 17-19 seed 리터럴(`describe`의 첫 테스트) 교체 — 기존:
  ```ts
      const seeds: AskPeak[] = [
        { date: '20260611', price: 297000, qty: 32621, t_ms: 1 },
        { date: '20260613', price: 25100, qty: 5000, t_ms: 2 },
      ];
  ```
  를:
  ```ts
      const seeds: AskPeak[] = [
        { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
          max_price: 300000, max_qty: 40000, max_t_ms: 11 },
        { date: '20260613', price: 25100, qty: 5000, t_ms: 2,
          max_price: 25100, max_qty: 5000, max_t_ms: 2 },
      ];
  ```
  그리고 그 테스트 끝(line 33 `expect(m['20260613'].date).toBe('20260613');` 뒤)에 과거일 max_* 통과 단언 추가:
  ```ts
      expect(m['20260611'].max_qty).toBe(40000); // 과거일 seed의 max_* 그대로 통과
  ```

  (b) line 37 seed 리터럴(둘째 테스트) 교체 — 기존:
  ```ts
      const seeds: AskPeak[] = [{ date: '20260611', price: 297000, qty: 32621, t_ms: 1 }];
  ```
  를:
  ```ts
      const seeds: AskPeak[] = [
        { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
          max_price: 300000, max_qty: 40000, max_t_ms: 11 },
      ];
  ```

  (c) `describe` 블록 끝(line 45 `});` 닫힘 직전, 마지막 `it` 뒤)에 신규 테스트 추가:
  ```ts
    it('오늘 entry는 close triple과 max triple이 동일(ratchet 동일값 — 토글 무효)', () => {
      const seeds: AskPeak[] = [
        { date: '20260613', price: 25100, qty: 5000, t_ms: 2,
          max_price: 25100, max_qty: 5000, max_t_ms: 2 },
      ];
      const { result, rerender } = renderHook(
        ({ ob }: { ob: ObSnapshot[] }) => useDayAskPeaks(ob, seeds, '20260613', '005930'),
        { initialProps: { ob: [] as ObSnapshot[] } },
      );
      rerender({ ob: [deep(Date.now(), 9000, 26500)] }); // 신기록 9000@26500
      const today = byDate(result.current)['20260613'];
      expect(today.qty).toBe(9000); // ratchet 전진
      // 오늘은 max triple을 close triple과 동일하게 채운다(Non-Goal: 오늘 close/max 이중 추적).
      expect(today.max_qty).toBe(today.qty);
      expect(today.max_price).toBe(today.price);
      expect(today.max_t_ms).toBe(today.t_ms);
    });
  ```

- [ ] **Step 2: 실패 확인** — `cd frontend && npx vitest run src/live/useDayAskPeaks.test.tsx -t '오늘 entry는 close triple과 max triple이 동일'`
  예상 실패: `expected undefined to be 9000` (어댑터가 오늘 push에 `max_qty` 등을 안 넣어 `today.max_qty === undefined`).
  추가로 `cd frontend && npx tsc -p tsconfig.app.json --noEmit` 실행 시: 본 단계 전이라면 어댑터 반환 객체가 max_* 없이 AskPeak를 만들어 `Property 'max_price' is missing in type` 에러(반환 타입 AskPeak[] 위반).

- [ ] **Step 3: 최소 구현** — `frontend/src/live/useDayAskPeaks.ts:46-53`. 기존:
  ```ts
    // 과거일 seed(그대로) + 오늘 ratchet 결과(date 부착)를 합친 per-day 리스트.
    return useMemo(() => {
      const out: AskPeak[] = seeds.filter((p) => p.date !== todayKst);
      if (todayPeak) {
        out.push({ date: todayKst, price: todayPeak.price, qty: todayPeak.qty, t_ms: todayPeak.t_ms });
      }
      return out;
    }, [seeds, todayKst, todayPeak]);
  ```
  를:
  ```ts
    // 과거일 seed(그대로 — 백엔드가 close/max 둘 다 확정) + 오늘 ratchet 결과(date 부착)를
    // 합친 per-day 리스트. 오늘 entry는 close triple과 max triple을 동일 ratchet 값으로 채운다
    // (Non-Goal: 오늘 봉 live close/max 이중 추적 — 오늘은 토글 무효, ADR-0075).
    return useMemo(() => {
      const out: AskPeak[] = seeds.filter((p) => p.date !== todayKst);
      if (todayPeak) {
        out.push({
          date: todayKst,
          price: todayPeak.price, qty: todayPeak.qty, t_ms: todayPeak.t_ms,
          max_price: todayPeak.price, max_qty: todayPeak.qty, max_t_ms: todayPeak.t_ms,
        });
      }
      return out;
    }, [seeds, todayKst, todayPeak]);
  ```

- [ ] **Step 4: 통과 확인**
  - `cd frontend && npx vitest run src/live/useDayAskPeaks.test.tsx`
  - `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
  예상: vitest 3개 테스트 모두 PASS, tsc 에러 0건(단, Task 5의 컴포넌트 변경이 아직이면 `useActivePrefs(s=>s.askPeakIntraMax)` 미존재로 tsc 에러가 날 수 있음 — 이는 Task 5 + chartPrefs 등록 단계가 처리. 본 Task의 tsc는 useDayAskPeaks.ts/test.tsx 범위 그린을 확인).

- [ ] **Step 5: 커밋**
  - `git add frontend/src/live/useDayAskPeaks.ts frontend/src/live/useDayAskPeaks.test.tsx`
  - `git commit -m "feat(live): useDayAskPeaks 오늘 entry에 max triple 동일값 채움"`

---

### Task 5: buildAskPeakSegments triple 선택 + LiveAskPeakSegments 컴포넌트 배선

**Files:**
- Modify: `frontend/src/live/LiveAskPeakSegments.tsx:39-71` (buildAskPeakSegments 시그니처·바디), `frontend/src/live/LiveAskPeakSegments.tsx:1-12` (import), `frontend/src/live/LiveAskPeakSegments.tsx:110-119` (컴포넌트 useEffect)
- Test: `frontend/src/live/LiveAskPeakSegments.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `frontend/src/live/LiveAskPeakSegments.test.tsx`에 (a) 기존 5개 호출부에 `intraMax` 인자(false) 추가 + AskPeak 리터럴에 max_* 추가(tsc 통과용), (b) 토글 triple 선택 신규 테스트 추가.

  (a) 기존 5개 `buildAskPeakSegments(...)` 호출은 7인자 → 마지막에 `false` 추가하고, 등장하는 AskPeak 리터럴(line 16-17, 42, 51, 59, 68, 75)에 max_* 필드를 추가한다. 구체적으로 첫 테스트(line 14-36) 교체 — 기존:
  ```ts
    it('과거일=open→close, 오늘=open→마지막 캔들(라이브 엣지) + live 플래그', () => {
      const peaks: AskPeak[] = [
        { date: '20260611', price: 297000, qty: 123456, t_ms: 1 },
        { date: '20260613', price: 323000, qty: 153125, t_ms: 2 },
      ];
      const segments = [seg('20260611', 1000, 5000), seg('20260613', 10000, 99999)];
      const candles = [candle(10500), candle(12000)]; // 마지막 12000
      const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#1D4ED8', 2);
  ```
  를:
  ```ts
    it('과거일=open→close, 오늘=open→마지막 캔들(라이브 엣지) + live 플래그', () => {
      const peaks: AskPeak[] = [
        { date: '20260611', price: 297000, qty: 123456, t_ms: 1,
          max_price: 297000, max_qty: 123456, max_t_ms: 1 },
        { date: '20260613', price: 323000, qty: 153125, t_ms: 2,
          max_price: 323000, max_qty: 153125, max_t_ms: 2 },
      ];
      const segments = [seg('20260611', 1000, 5000), seg('20260613', 10000, 99999)];
      const candles = [candle(10500), candle(12000)]; // 마지막 12000
      const out = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#1D4ED8', 2, false);
  ```
  나머지 호출부(line 45, 54, 62, 67, 74-77)도 각각 마지막 인자 `false`를 추가하고, 그 안의 AskPeak 리터럴(line 42, 51, 59, 68, 75)에 `max_price`/`max_qty`/`max_t_ms`를 close triple과 동일 값으로 채운다. 예: line 42
  ```ts
      const peaks: AskPeak[] = [{ date: '20260613', price: 100, qty: 50, t_ms: 175000 }];
  ```
  →
  ```ts
      const peaks: AskPeak[] = [
        { date: '20260613', price: 100, qty: 50, t_ms: 175000,
          max_price: 100, max_qty: 50, max_t_ms: 175000 },
      ];
  ```
  (line 51/59/68/75도 동형 — 각 리터럴에 max_*=close 값 추가, 각 호출에 `, false` 추가.)

  (b) `describe` 끝(마지막 `it` 뒤, line 79 `});` 직전)에 토글 선택 신규 테스트 추가:
  ```ts
    it('intraMax=true면 max triple(price/qty/t_ms 대신 max_*) 선택', () => {
      // 과거일: close=300@t100000, max=900@t130000(분봉 내 더 큰 순간 벽, 더 늦은 시각).
      const peaks: AskPeak[] = [
        { date: '20260611', price: 25100, qty: 300, t_ms: 100000,
          max_price: 25200, max_qty: 900, max_t_ms: 130000 },
      ];
      const segments = [seg('20260611', 60000, 240000)];
      const candles = [candle(60000), candle(120000), candle(180000)];

      // close 모드(intraMax=false): 점=300@(t100000 스냅→120000), 라벨='300'.
      const off = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1, false);
      expect(off[0].label).toBe('300');
      expect(off[0].peakTime).toBe(120); // 100000 → 버킷 [120000? no] : 100000∈[60000,120000) → 60000? — 스냅: <=100000 마지막 캔들=60000

      // max 모드(intraMax=true): 점=900@(t130000 스냅→120000), 라벨='900'.
      const on = buildAskPeakSegments(peaks, segments, candles, axis, '20260613', '#000', 1, true);
      expect(on[0].label).toBe('900');
      expect(on[0].peakTime).toBe(120); // 130000 → <=130000 마지막 캔들=120000
      // 세그먼트 바운드(open/close)는 토글과 무관 — 둘 다 동일.
      expect(on[0].time0).toBe(off[0].time0);
      expect(on[0].time1).toBe(off[0].time1);
    });
  ```
  주: `formatQtyCompact(300)='300'`, `formatQtyCompact(900)='900'`(1000 미만은 그대로). peakTime은 `snapPeakMsToCandle(선택된 t, candles)` — close t=100000은 `<=100000` 마지막 캔들 60000이 아니라… 정정: candles=[60000,120000,180000], 100000 이하 마지막 = 60000 → peakTime=60. **off의 peakTime 단언을 60으로 수정**:
  ```ts
      expect(off[0].peakTime).toBe(60); // 100000 → <=100000 마지막 캔들 60000
  ```
  (max t=130000은 `<=130000` 마지막 캔들 120000 → peakTime=120, 위 그대로.)

- [ ] **Step 2: 실패 확인** — `cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx -t 'intraMax=true면 max triple'`
  예상 실패: `buildAskPeakSegments`가 8번째 인자를 받지 않아 `intraMax`를 무시 → `on[0].label`이 `'300'`(여전히 close)로 나와 `expected '300' to be '900'` 실패.
  그리고 `cd frontend && npx tsc -p tsconfig.app.json --noEmit`: `Expected 7 arguments, but got 8`(시그니처 미수정).

- [ ] **Step 3: 최소 구현** — `frontend/src/live/LiveAskPeakSegments.tsx`.

  (a) import에 `useActivePrefs` 추가(line 7 근처). 기존:
  ```ts
  import { useLivePageStore } from '../state/livePage';
  ```
  뒤에 추가:
  ```ts
  import { useActivePrefs } from '../state/chartPrefs';
  ```

  (b) buildAskPeakSegments 시그니처에 `intraMax: boolean` 마지막 인자 추가 + 선택된 triple로 price/label/peakTime 결정. 기존(line 39-71):
  ```ts
  export function buildAskPeakSegments(
    peaks: readonly AskPeak[],
    segments: readonly RangeSegment[],
    candles: readonly Candle[],
    axis: VirtualAxis,
    todayKst: string,
    color: string,
    lineWidth: number,
  ): AskPeakSegment[] {
    const byDate = new Map(segments.map((s) => [s.date, s]));
    const lastCandleMs = candles.length > 0 ? candles[candles.length - 1].ts_ms : null;
    const out: AskPeakSegment[] = [];
    for (const p of peaks) {
      const seg = byDate.get(p.date);
      if (!seg) continue;
      const isToday = p.date === todayKst;
      const endMs = isToday && lastCandleMs !== null ? lastCandleMs : seg.session_close_ms;
      // peak 점은 그 시각이 속한 캔들(버킷)에 스냅 → 점이 그 캔들 위에 정확히 놓인다(1캔들 밀림 방지).
      const peakMs = snapPeakMsToCandle(p.t_ms, candles) ?? p.t_ms;
      out.push({
        time0: (axis.toVirtual(seg.session_open_ms) / 1000) as Time,
        time1: (axis.toVirtual(endMs) / 1000) as Time,
        // peak이 실제 걸린 시점(속한 캔들에 스냅) — 그 x에 점을 찍어 언제 최대벽이었는지 표시.
        peakTime: (axis.toVirtual(peakMs) / 1000) as Time,
        price: p.price,
        label: formatQtyCompact(p.qty),
        color,
        lineWidth,
        live: isToday,
      });
    }
    return out;
  }
  ```
  를:
  ```ts
  export function buildAskPeakSegments(
    peaks: readonly AskPeak[],
    segments: readonly RangeSegment[],
    candles: readonly Candle[],
    axis: VirtualAxis,
    todayKst: string,
    color: string,
    lineWidth: number,
    intraMax: boolean,
  ): AskPeakSegment[] {
    const byDate = new Map(segments.map((s) => [s.date, s]));
    const lastCandleMs = candles.length > 0 ? candles[candles.length - 1].ts_ms : null;
    const out: AskPeakSegment[] = [];
    for (const p of peaks) {
      const seg = byDate.get(p.date);
      if (!seg) continue;
      const isToday = p.date === todayKst;
      const endMs = isToday && lastCandleMs !== null ? lastCandleMs : seg.session_close_ms;
      // 분봉 내 최댓값 기준(Intra-Bar Max, ADR-0075): ON이면 close triple 대신 max triple을
      // 고른다. 세그먼트 바운드(open/close/live-edge)는 토글과 무관 — 점/라벨/점-시각만 바뀐다.
      // (오늘 entry는 어댑터가 max_*=close라 토글 무효.)
      const peakPrice = intraMax ? p.max_price : p.price;
      const peakQty = intraMax ? p.max_qty : p.qty;
      const peakTMs = intraMax ? p.max_t_ms : p.t_ms;
      // peak 점은 그 시각이 속한 캔들(버킷)에 스냅 → 점이 그 캔들 위에 정확히 놓인다(1캔들 밀림 방지).
      const peakMs = snapPeakMsToCandle(peakTMs, candles) ?? peakTMs;
      out.push({
        time0: (axis.toVirtual(seg.session_open_ms) / 1000) as Time,
        time1: (axis.toVirtual(endMs) / 1000) as Time,
        // peak이 실제 걸린 시점(속한 캔들에 스냅) — 그 x에 점을 찍어 언제 최대벽이었는지 표시.
        peakTime: (axis.toVirtual(peakMs) / 1000) as Time,
        price: peakPrice,
        label: formatQtyCompact(peakQty),
        color,
        lineWidth,
        live: isToday,
      });
    }
    return out;
  }
  ```

  (c) 컴포넌트가 토글을 읽어 전달. 기존(line 89-91 근처에 토글 read 추가, line 110-119 useEffect 갱신). 먼저 line 89-91:
  ```ts
    const enabled = useLivePageStore((s) => s.askPeakEnabled);
    const color = useLivePageStore((s) => s.askPeakColor);
    const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  ```
  뒤에 추가:
  ```ts
    const intraMax = useActivePrefs((s) => s.askPeakIntraMax);
  ```
  그리고 useEffect(line 110-119) 교체 — 기존:
  ```ts
    // 갱신: dayAskPeaks·segments·candles·축·스타일·토글 변화 시 세그먼트 재계산.
    useEffect(() => {
      const prim = primRef.current;
      if (!prim) return;
      prim.setSegments(
        enabled
          ? buildAskPeakSegments(dayAskPeaks, segments, candles, axis, todayKst, color, lineWidth)
          : [],
      );
    }, [dayAskPeaks, segments, candles, axis, todayKst, color, lineWidth, enabled, series]);
  ```
  를:
  ```ts
    // 갱신: dayAskPeaks·segments·candles·축·스타일·토글 변화 시 세그먼트 재계산.
    useEffect(() => {
      const prim = primRef.current;
      if (!prim) return;
      prim.setSegments(
        enabled
          ? buildAskPeakSegments(dayAskPeaks, segments, candles, axis, todayKst, color, lineWidth, intraMax)
          : [],
      );
    }, [dayAskPeaks, segments, candles, axis, todayKst, color, lineWidth, enabled, intraMax, series]);
  ```

- [ ] **Step 4: 통과 확인**
  - `cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx`
  - `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
  예상: vitest 6개 테스트 모두 PASS. tsc 에러 0건 — 단, `s.askPeakIntraMax`는 chartPrefs CHART_TOGGLES에 등록된 단계가 머지된 이후라야 통과한다(크로스-페이즈 의존, assembler_notes 참조). 그 단계 전에 단독 실행 시 `Property 'askPeakIntraMax' does not exist on type 'ChartViewPrefs'`가 날 수 있으며, 이는 toggle 등록 단계와 함께 그린이 된다.

- [ ] **Step 5: 커밋**
  - `git add frontend/src/live/LiveAskPeakSegments.tsx frontend/src/live/LiveAskPeakSegments.test.tsx`
  - `git commit -m "feat(live): 당일 매도 최대벽 분봉 내 최댓값 기준 토글(close↔max triple 선택)"`


## Phase 5 — 통합 · 회귀 · 수동검증

### Task 1: Split Cache 등가 회귀 — Intra-Bar Max 필드 포함, intraMax ON/OFF 양쪽에서 past++today === all

「분봉 내 최댓값 기준」 토글이 순수 렌더 스위치임을 고정한다. `makePastCachedProjector`의 `project(과거)++project(오늘) === project(전체)` 바이트 등가가 max 필드를 실은 뒤에도, 그리고 intraMax ON/OFF 양쪽 ctx에서 성립해야 한다(Split Cache 불변식 #74). 픽스처의 `bid_max/ask_max/imb_max_*`는 종가 필드와 다른 값(단 ≥ 종가)으로 채워 ON 경로가 OFF의 복제가 아니라 실제로 max를 그리게 한다.

**Files:**
- Modify: `frontend/src/chart/projectors/pastCachedProjector.test.ts`
- Test: `frontend/src/chart/projectors/pastCachedProjector.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `makeAxisAndBundle` 픽스처 점에 7필드를 채우고(종가≠max), intraMax ON/OFF 양쪽 ctx로 등가를 단언하는 describe 블록을 파일 끝에 추가(기존 블록은 유지). 기존 `makeAxisAndBundle`의 점 push 4줄을 7필드로 확장한다.

  먼저 `makeAxisAndBundle`의 시그니처/배열 타입을 7필드로 확장한다(현재 14·17·29행):
  ```ts
  type QRSeed = { t: number; bid_total: number; ask_total: number; bid_max: number; ask_max: number; imb_max_bid: number; imb_max_ask: number };
  // function makeAxisAndBundle(nDays: number, extraTodayPoints: QRSeed[] = []) {
  //   const points: QRSeed[] = [];
  ```

  그리고 점 생성부(현재 23-26행)를 max 필드 포함으로 교체한다(bid_max/ask_max ≥ 종가, imb_max_*는 종가와 다른 (bid,ask)쌍):
  ```ts
  points.push({ t: open, bid_total: 100, ask_total: 100, bid_max: 120, ask_max: 130, imb_max_bid: 40, imb_max_ask: 160 });
  points.push({ t: open + 3_600_000, bid_total: 100, ask_total: 200, bid_max: 150, ask_max: 260, imb_max_bid: 30, imb_max_ask: 300 }); // sell-heavy
  points.push({ t: open + 9000 * 1000, bid_total: 5000, ask_total: 50, bid_max: 5200, ask_max: 90, imb_max_bid: 6000, imb_max_ask: 20 }); // 극단값(outlier clamp 대상)
  points.push({ t: close - 5 * 60_000, bid_total: 100, ask_total: 150, bid_max: 110, ask_max: 170, imb_max_bid: 50, imb_max_ask: 220 }); // 동시호가창 (mask 대상)
  ```

  그리고 파일 끝에 새 describe를 추가한다(ctx shape는 P4 렌더 스위치 단계 확정 — assembler_notes 참조):
  ```ts
  // Intra-Bar Max 필드를 실은 상태에서도 Split Cache 등가가 유지되는지 — intraMax ON/OFF 양쪽.
  // 토글은 순수 렌더 스위치이므로 같은 ctx를 past/today/all 세 경로에 동일하게 넘긴다.
  const getQR = (b: any) => b.quote_ratio.points;
  // 라인(총잔량): projectBidPoints/projectAskPoints는 boolean mask 시그니처(기존 테스트와 동일).
  // intraMax는 4번째 boolean 인자 — cached ctx(mask)와 분리하기 위해 wrapper로 고정한다.
  const bidProj = (im: boolean) => (pts: any, ax: any, mask: boolean) => projectBidPoints(pts, ax, mask, im);
  const askProj = (im: boolean) => (pts: any, ax: any, mask: boolean) => projectAskPoints(pts, ax, mask, im);
  // 호가비: RatioPaneContext.intraMax(선택적) — projectRatio(번들 래퍼)가 ctx를 그대로 통과시킨다.
  const CTX_RATIO_OFF: RatioPaneContext = { auctionWindowMask: true, outlierFilterEnabled: true, outlierThreshold: 100, intraMax: false };
  const CTX_RATIO_ON: RatioPaneContext = { auctionWindowMask: true, outlierFilterEnabled: true, outlierThreshold: 100, intraMax: true };

  describe('Split Cache 등가 — Intra-Bar Max 필드 포함, intraMax ON/OFF 양쪽 (P5 회귀)', () => {
    it.each([false, true])('projectBid 분리-캐시 == 풀 (intraMax=%s)', (im) => {
      const { axis, bundle } = makeAxisAndBundle(3);
      const cached = makePastCachedProjector(bidProj(im), getQR);
      expect(cached(bundle, axis, true)).toEqual(bidProj(im)(getQR(bundle), axis, true));
    });

    it.each([false, true])('projectAsk 분리-캐시 == 풀 (intraMax=%s)', (im) => {
      const { axis, bundle } = makeAxisAndBundle(3);
      const cached = makePastCachedProjector(askProj(im), getQR);
      expect(cached(bundle, axis, true)).toEqual(askProj(im)(getQR(bundle), axis, true));
    });

    it('projectRatio 분리-캐시 == 풀, mask+outlier ON (intraMax OFF=종가)', () => {
      const { axis, bundle } = makeAxisAndBundle(3);
      const cached = makePastCachedProjector(projectRatioPoints, getQR);
      expect(cached(bundle, axis, CTX_RATIO_OFF)).toEqual(projectRatio(bundle, axis, CTX_RATIO_OFF));
    });

    it('projectRatio 분리-캐시 == 풀, mask+outlier ON (intraMax ON=imb_max)', () => {
      const { axis, bundle } = makeAxisAndBundle(3);
      const cached = makePastCachedProjector(projectRatioPoints, getQR);
      expect(cached(bundle, axis, CTX_RATIO_ON)).toEqual(projectRatio(bundle, axis, CTX_RATIO_ON));
    });

    it('intraMax ON 투영 ≠ OFF 투영 (max 픽스처가 실제로 다른 라인을 그림 — 가드 teeth)', () => {
      const { axis, bundle } = makeAxisAndBundle(3);
      const pts = getQR(bundle);
      // bid_max(120/150/5200/110) ≠ bid_total(100/100/5000/100) 이므로 ON(bid_max)/OFF(bid_total) 결과가 달라야 한다.
      expect(projectBidPoints(pts, axis, true, true)).not.toEqual(projectBidPoints(pts, axis, true, false));
    });

    it('틱(당일 새 버킷) 후에도 ON 경로 신선 — 스테일 캐시 아님', () => {
      const cached = makePastCachedProjector(askProj(true), getQR);
      const first = makeAxisAndBundle(3);
      cached(first.bundle, first.axis, true); // 워밍
      const tick = makeAxisAndBundle(3, [{ t: 2 * 3_600_000, bid_total: 100, ask_total: 300, bid_max: 130, ask_max: 380, imb_max_bid: 40, imb_max_ask: 420 }]);
      expect(cached(tick.bundle, first.axis, true)).toEqual(askProj(true)(getQR(tick.bundle), first.axis, true));
    });
  });
  ```

- [ ] **Step 2: 실패 확인** — Split Cache 가드가 정말 분리-캐시 경로를 검증함을 보이기 위해 임시 주입: `makePastCachedProjector`가 과거 슬라이스를 누락하도록 1줄 수정.

  `frontend/src/chart/projectors/pastCachedProjector.ts:73` 의
  ```ts
      return entry.pastData.concat(projectPoints(today, axis, ctx));
  ```
  을 임시로
  ```ts
      return projectPoints(today, axis, ctx); // TEMP RED: drop past slice
  ```
  로 바꾼 뒤:
  ```
  cd frontend && npx vitest run src/chart/projectors/pastCachedProjector.test.ts -t 'Intra-Bar Max'
  ```
  예상 실패: `projectBid 분리-캐시 == 풀 (intraMax OFF=종가)` 등에서 `expected [ ...과거+당일... ] to deeply equal [ ...당일만... ]` — 과거 점들이 결과에서 누락되어 길이 불일치 AssertionError.

- [ ] **Step 3: 최소 구현** — 주입을 되돌린다(정상 동작은 P4까지 이미 구현됨). `pastCachedProjector.ts:73` 을 원복:
  ```ts
      return entry.pastData.concat(projectPoints(today, axis, ctx));
  ```

- [ ] **Step 4: 통과 확인** —
  ```
  cd frontend && npx vitest run src/chart/projectors/pastCachedProjector.test.ts -t 'Intra-Bar Max'
  ```
  예상: 6 passed (양쪽 ctx 등가 + ON≠OFF teeth + 틱 신선). 그리고
  ```
  cd frontend && npx tsc -p tsconfig.app.json --noEmit
  ```
  예상: 에러 없음(픽스처 7필드 완비).

- [ ] **Step 5: 커밋** —
  add:
  ```
  git add frontend/src/chart/projectors/pastCachedProjector.test.ts
  ```
  commit:
  ```
  git commit -m "test(live): Split Cache 등가 회귀 — Intra-Bar Max 필드 포함 intraMax ON/OFF 양쪽"
  ```

---

### Task 2: Surge 격리 회귀 — quoteTotalsIntraMax ON/OFF에서 detectSurgeSide 발사 시점 불변

총잔량 급증 감지(`detectSurgeSide`)가 `ask_total`/`bid_total` 필드명을 하드코딩하므로(detectSurges.ts:19), Intra-Bar Max 토글과 무관하게 종가 시퀀스만 읽어 발사 시점이 고정됨을 고정한다(스펙 Q4·invariant "총잔량 급증 트리거 안정성"). 픽스처는 `*_total`은 동일하되 `*_max`가 달라, 만약 감지기가 `*_max`를 읽으면 발사 개수가 달라지도록 설계한다.

**Files:**
- Create: `frontend/src/chart/surge/surgeIntraMaxIsolation.test.ts`
- Test: `frontend/src/chart/surge/surgeIntraMaxIsolation.test.ts`

- [ ] **Step 1: 실패 테스트 작성** —
  ```ts
  import { describe, it, expect } from 'vitest';
  import { detectSurgeSide } from './detectSurges';
  import type { QuoteRatioPoint } from '../../api/types';

  const OPTS = { approachRatio: 0.95, rearmRatio: 0.85, isClosingAuction: () => false };

  // 7필드 QuoteRatioPoint 헬퍼. tot=종가(감지 입력), max=Intra-Bar Max(렌더 전용, 감지는 무시해야 함).
  // imb_max_* 는 surge와 무관하나 타입상 required(P1) — 0으로 채움.
  const Q = (
    t: number, ask_tot: number, bid_tot: number, ask_max: number, bid_max: number,
  ): QuoteRatioPoint => ({
    t, ask_total: ask_tot, bid_total: bid_tot,
    ask_max, bid_max, imb_max_bid: 0, imb_max_ask: 0,
  });

  describe('Surge 격리 (Q4) — detectSurgeSide는 종가만 읽고 Intra-Bar Max를 무시', () => {
    // 종가 시퀀스 ask_total = [100, 80, 96] → running peak 100 → 80(<85% 재무장) → 96(≥95% 발사). 1건 t=3.
    // ask_max = [100, 100, 100] (항상 ≥ ask_total, 그러나 한 번도 안 빠짐) → 만약 감지기가 ask_max를 읽으면
    // 재무장이 안 일어나 0건. 따라서 발사 개수가 1↔0 으로 갈려 격리 위반을 잡는다.
    const ptsAsk = [Q(1, 100, 0, 100, 0), Q(2, 80, 0, 100, 0), Q(3, 96, 0, 100, 0)];

    it('ask: 종가 기준으로만 발사(1건) — ask_max를 읽지 않음', () => {
      const r = detectSurgeSide(ptsAsk, 'ask', OPTS);
      expect(r).toHaveLength(1);
      expect(r[0].t).toBe(3);
      expect(r[0].value).toBe(96); // 발사 value = 종가(ask_total) 96, ask_max(100) 아님
    });

    it('bid 대칭: bid_total=[100,80,96], bid_max=[100,100,100] → 1건 t=3', () => {
      const ptsBid = [Q(1, 0, 100, 0, 100), Q(2, 0, 80, 0, 100), Q(3, 0, 96, 0, 100)];
      const r = detectSurgeSide(ptsBid, 'bid', OPTS);
      expect(r).toHaveLength(1);
      expect(r[0].t).toBe(3);
      expect(r[0].value).toBe(96);
    });

    it('max 시퀀스가 달라도 결과 동일 — max가 감지에 새지 않음(격리)', () => {
      // 종가 입력은 ptsAsk와 동일, ask_max만 [130,999,101]로 변형. 격리되어 있으면 결과가 같아야 한다.
      const sameClose = [Q(1, 100, 0, 130, 0), Q(2, 80, 0, 999, 0), Q(3, 96, 0, 101, 0)];
      expect(detectSurgeSide(sameClose, 'ask', OPTS)).toEqual(detectSurgeSide(ptsAsk, 'ask', OPTS));
    });
  });
  ```

- [ ] **Step 2: 실패 확인** — 격리 가드의 teeth를 보이려 임시 주입: `detectSurges.ts:19` 의 FIELD 맵에서 ask를 `ask_max`로 오배선.

  `frontend/src/chart/surge/detectSurges.ts:19`
  ```ts
  const FIELD: Record<SurgeSide, 'ask_total' | 'bid_total'> = { ask: 'ask_total', bid: 'bid_total' };
  ```
  을 임시로(타입 확장 포함)
  ```ts
  const FIELD: Record<SurgeSide, 'ask_total' | 'bid_total' | 'ask_max'> = { ask: 'ask_max', bid: 'bid_total' }; // TEMP RED
  ```
  로 바꾼 뒤:
  ```
  cd frontend && npx vitest run src/chart/surge/surgeIntraMaxIsolation.test.ts -t 'Surge 격리'
  ```
  예상 실패: `ask: 종가 기준으로만 발사(1건)` 에서 `expected length 1, got 0` — ask_max=[100,100,100]은 85% 아래로 빠진 적이 없어 재무장 불가 → 0건 발사. (그리고 `max 시퀀스가 달라도 결과 동일` 도 깨짐 — sameClose의 ask_max [130,999,101] ≠ [100,100,100].)

- [ ] **Step 3: 최소 구현** — 주입을 되돌린다(격리는 P 전 단계에서 detectSurges.ts 미접촉으로 이미 성립). `detectSurges.ts:19` 원복:
  ```ts
  const FIELD: Record<SurgeSide, 'ask_total' | 'bid_total'> = { ask: 'ask_total', bid: 'bid_total' };
  ```

- [ ] **Step 4: 통과 확인** —
  ```
  cd frontend && npx vitest run src/chart/surge/surgeIntraMaxIsolation.test.ts -t 'Surge 격리'
  ```
  예상: 3 passed. 그리고
  ```
  cd frontend && npx tsc -p tsconfig.app.json --noEmit
  ```
  예상: 에러 없음(Q 헬퍼 7필드 완비).

- [ ] **Step 5: 커밋** —
  add:
  ```
  git add frontend/src/chart/surge/surgeIntraMaxIsolation.test.ts
  ```
  commit:
  ```
  git commit -m "test(live): Surge 격리 회귀 — detectSurgeSide는 종가만 읽고 Intra-Bar Max 무시"
  ```

---

### Task 3: 상계 불변식 — 총잔량 max ≥ 종가 + 호가비 매그니튜드 상계 + ask-peak max_qty ≥ qty (백엔드)

스펙의 새 invariant 두 개를 백엔드 집계에서 고정한다: (1) `bid_max≥bid_total`·`ask_max≥ask_total`·ask-peak `max_qty≥qty` (연속 스냅샷 집합의 max ≥ 마지막 원소). (2) `|quoteImbalance(imb_max)| ≥ |quoteImbalance(종가)|`(부호는 가변). 픽스처는 상승 버킷(종가가 가장 큰 total)으로 만들어, max를 틀린 집합으로 계산하면 ≥가 strict하게 깨지도록 한다.

**Files:**
- Modify: `tests/test_tables_snapshots.py`
- Test: `tests/test_tables_snapshots.py`

- [ ] **Step 1: 실패 테스트 작성** — 파일 끝에 추가. `_ob`(195행 인근, query_bucketed_ratio용)·`_ob_ap`(347행, query_day_ask_peak용)·`_con_for`(359행) 헬퍼를 재사용한다.

  ```python
  # ---------------------------------------------------------------------------
  # P5 회귀: Intra-Bar Max 상계 불변식
  #   - bid_max >= bid_total, ask_max >= ask_total (연속 스냅샷 max >= 종가)
  #   - |imbalance(imb_max_bid, imb_max_ask)| >= |imbalance(종가 bid_total, ask_total)|
  #   - ask-peak max_qty >= qty (틱-max 변종의 당일 max >= 버킷 종가 대표의 당일 max)
  # ---------------------------------------------------------------------------


  def _imb(bid: int, ask: int) -> float:
      """frontend/src/util/imbalance.ts quoteImbalance 미러(부호 규약 동일)."""
      if bid <= 0 or ask <= 0:
          return 0.0
      return ask / bid - 1 if ask >= bid else -(bid / ask - 1)


  def test_quote_bucketed_ratio_intra_max_geq_close(tmp_path: Path) -> None:
      """같은 1초 버킷의 연속 스냅샷들: ask는 단조 상승(종가가 최대), bid는 첫 스냅샷이 최대.
      bid_max/ask_max 는 각 변 독립 최댓값이며 종가(마지막 스냅샷) 이상이어야 한다."""
      from hoga.tables.snapshots import query_bucketed_ratio

      obs = [
          _ob(ts_ms=90_000_100, seq=1, ask_q=(10, 20, 30, 40), bid_q=(900, 1, 1, 1)),    # bid 합 903 (버킷 내 bid 최대)
          _ob(ts_ms=90_000_500, seq=2, ask_q=(50, 60, 70, 80), bid_q=(50, 1, 1, 1)),     # ask 증가, bid 감소
          _ob(ts_ms=90_000_900, seq=3, ask_q=(100, 110, 120, 130), bid_q=(20, 1, 1, 1)), # 종가: ask 460, bid 23
      ]
      out = tmp_path / "snapshots.parquet"
      write_parquet(obs, out)
      con = duckdb.connect()
      rows = query_bucketed_ratio(con, path=out, bucket_ms=1000)
      assert len(rows) == 1
      r = rows[0]
      # 종가(마지막 스냅샷) totals
      assert r.ask_total == 460 and r.bid_total == 23
      # 상계: 각 변 독립 max >= 종가
      assert r.ask_max >= r.ask_total
      assert r.bid_max >= r.bid_total
      # ask는 단조 상승이라 ask_max == 종가; bid는 첫 스냅샷이 최대라 bid_max > bid_total(strict)
      assert r.ask_max == 460
      assert r.bid_max == 903 and r.bid_max > r.bid_total


  def test_quote_bucketed_ratio_imbalance_magnitude_geq_close(tmp_path: Path) -> None:
      """호가비 Intra-Bar Max = 버킷 내 |imbalance| 최대 스냅샷의 (bid,ask)쌍.
      |imbalance(imb_max)| >= |imbalance(종가)| (부호는 다를 수 있음)."""
      from hoga.tables.snapshots import query_bucketed_ratio

      # 스냅샷 A: bid=903, ask=10 -> buy-heavy 강함(|imb| 큼, 음수)
      # 종가 C:   bid=23,  ask=460 -> sell-heavy 약함(|imb| 작음, 양수)
      obs = [
          _ob(ts_ms=90_000_100, seq=1, ask_q=(10,), bid_q=(900, 1, 1, 1)),               # bid 903 / ask 10  -> |imb| 매우 큼
          _ob(ts_ms=90_000_900, seq=2, ask_q=(100, 110, 120, 130), bid_q=(20, 1, 1, 1)), # 종가 ask 460 / bid 23
      ]
      out = tmp_path / "snapshots.parquet"
      write_parquet(obs, out)
      con = duckdb.connect()
      rows = query_bucketed_ratio(con, path=out, bucket_ms=1000)
      assert len(rows) == 1
      r = rows[0]
      close_mag = abs(_imb(r.bid_total, r.ask_total))
      max_mag = abs(_imb(r.imb_max_bid, r.imb_max_ask))
      assert max_mag >= close_mag
      # imb_max 는 A 스냅샷(903,10) — 종가(23,460)보다 |imbalance| 큼 → strict.
      assert (r.imb_max_bid, r.imb_max_ask) == (903, 10)
      assert max_mag > close_mag


  def test_day_ask_peak_max_qty_geq_close_qty(tmp_path) -> None:
      """ask-peak: 버킷 틱-max 변종의 당일 max(max_qty) >= 버킷 종가 대표의 당일 max(qty).
      한 버킷 내 순간 큰 벽(8000)이 종가 스냅샷엔 사라진 케이스."""
      obs = [
          # 같은 60s 버킷: 중간 스냅샷에 8000 매도벽, 종가 스냅샷엔 3000.
          _ob_ap(90_000_000, [3000, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
          _ob_ap(90_000_500, [8000, 20, 30, 40, 5, 6, 7, 8, 9, 1]),  # 순간 최대벽(종가 아님)
          _ob_ap(90_000_900, [3000, 20, 30, 40, 5, 6, 7, 8, 9, 1]),  # 버킷 종가: 3000
      ]
      out = tmp_path / "snapshots.parquet"
      write_parquet(obs, out)
      peak = query_day_ask_peak(_con_for(out), path=out, bucket_ms=60_000)
      assert peak is not None
      # 상계: 틱-max(max_qty) >= 종가대표 당일max(qty)
      assert peak.max_qty >= peak.qty
      # 종가 대표는 3000(버킷 마지막), 틱-max는 8000 → strict.
      assert peak.qty == 3000
      assert peak.max_qty == 8000 and peak.max_qty > peak.qty
  ```

- [ ] **Step 2: 실패 확인** — 상계 가드의 teeth를 보이려 임시 주입: `query_bucketed_ratio`의 `bid_max` 집계를 버킷 MAX가 아닌 버킷 MIN(틀린 집합)으로 계산하게 한다. 상승/첫-스냅샷-최대 픽스처에서 `bid_max < bid_total`이 되어 ≥가 strict하게 깨진다.

  `hoga/tables/snapshots.py`의 `query_bucketed_ratio` SQL에서 `bid_max` 산출식(P2/P3에서 추가된 `MAX(<bid_total_sum_expr>) AS bid_max`)을 임시로:
  ```sql
  -- TEMP RED: 버킷 MAX 대신 MIN(틀린 집합)으로 계산 → bid_max < bid_total 발생
  MIN(<bid_total_sum_expr>) AS bid_max,
  ```
  (정확한 컬럼식 이름은 P2/P3 SQL에 맞춤; 핵심은 MAX→MIN 1토큰 교체) 그 뒤:
  ```
  uv run pytest tests/test_tables_snapshots.py::test_quote_bucketed_ratio_intra_max_geq_close -v
  ```
  예상 실패: `test_quote_bucketed_ratio_intra_max_geq_close` 에서 bid_max가 버킷 최소 합 23으로 떨어져 `assert r.bid_max >= r.bid_total`(23>=23 통과) 이후 `assert r.bid_max == 903 and r.bid_max > r.bid_total` 가 `assert 23 == 903` 으로 AssertionError → RED.

- [ ] **Step 3: 최소 구현** — 주입을 되돌린다(올바른 `MAX(...) AS bid_max` 집계는 P2/P3에서 이미 구현). `query_bucketed_ratio`의 bid_max 식을 원복:
  ```sql
  MAX(<bid_total_sum_expr>) AS bid_max,
  ```

- [ ] **Step 4: 통과 확인** —
  ```
  uv run pytest tests/test_tables_snapshots.py::test_quote_bucketed_ratio_intra_max_geq_close tests/test_tables_snapshots.py::test_quote_bucketed_ratio_imbalance_magnitude_geq_close tests/test_tables_snapshots.py::test_day_ask_peak_max_qty_geq_close_qty -v
  ```
  예상: 3 passed — 총잔량 상계·호가비 매그니튜드 상계·ask-peak max_qty 상계 모두 green.

- [ ] **Step 5: 커밋** —
  add:
  ```
  git add tests/test_tables_snapshots.py
  ```
  commit:
  ```
  git commit -m "test(snapshots): Intra-Bar Max 상계 불변식 — 총잔량 max>=종가·호가비 매그니튜드·ask-peak max_qty>=qty"
  ```

---

### Task 4: 수동 검증 체크리스트 — /live Intra-Bar Max 시나리오 (코드 없음)

헤드리스로 검증 불가능한 시각·상호작용 항목을 사용자 육안 검증용 체크리스트로 고정한다(스펙 Manual verification (a)–(f)). 이 태스크는 코드가 없으며, PR 본문/검증 절에 그대로 붙여 사용자가 `/live`에서 확인한다. KIS 자격증명·실시간 스트림이 필요하므로 자동화 한계가 있다.

**Files:**
- (없음 — 체크리스트 항목. 실행자는 PR 본문에 옮기고 사용자에게 육안 검증 요청)

- [ ] **(a) 총잔량/매도벽 토글 ON → 라인 위로 이동(과거일)**: `/live` 과거 거래일이 보이도록 좌측 팬 → 「지표」 모달에서 「총잔량」·「당일 매도 최대벽」의 「분봉 내 최댓값 기준」 토글 ON. 총잔량 매수/매도 라인과 매도벽 선이 종가 대비 위로(또는 동일) 이동한다(아래로 내려가지 않음 = 상계 불변식 시각 확인).
- [ ] **(b) 호가비 토글 ON → 0에서 더 멀어짐(부호 가변)**: 「호가비」의 「분봉 내 최댓값 기준」 토글 ON. 베이스라인 0에서 라인이 더 멀어지거나 같다(부호 방향은 종가와 다를 수 있음). 기본값(Outlier 필터 ON)에선 스파이크 지점이 0으로 보일 수 있음 → 같은 「호가비」 Config의 극단값 필터를 OFF 하면 날것 극값이 표시됨을 확인(Q2 직교).
- [ ] **(c) 토글 즉시 반영(재요청·깜빡임 없음)**: 토글 ON/OFF를 빠르게 전환했을 때 라인이 즉시 바뀌고 네트워크 재요청(`/api/range`)·차트 리마운트 깜빡임이 없다(순수 클라 렌더 스위치). DevTools Network 탭에서 토글 시 신규 요청이 없음을 확인.
- [ ] **(d) 과거로 팬해도 일관**: 토글 ON 상태로 좌측 깊게 팬 → prepend된 과거 버킷에서도 Intra-Bar Max 라인이 동일 규칙으로 그려지고(Split Cache 등가), 라인 점프·과거-당일 경계 불연속이 없다.
- [ ] **(e) 오늘 봉 ask-peak 토글 무효**: 오늘 거래일 구간에서 「당일 매도 최대벽」 토글 ON/OFF를 전환해도 선/마커 위치가 동일(오늘 entry는 ratchet running max라 close/max triple 동일 — Non-Goal). 토글 효과는 과거 거래일에서만 보임을 확인.
- [ ] **(f) 급증 마커: 발사 시점 불변 + 점이 보이는 라인 위**: 「총잔량」 급증 마커가 켜진 상태에서 「분봉 내 최댓값 기준」 토글 ON/OFF 전환 시 마커 발사 위치(시각)는 흔들리지 않는다(감지는 종가 고정). 단 토글 ON이면 마커 점이 `ask_max`/`bid_max` 높이(보이는 라인 위)에 앉는다.
- [ ] **(g) 헤드리스 한계 → 사용자 육안 검증**: 위 (a)–(f)는 KIS 실시간 스트림·시각 렌더에 의존해 `/browse` 헤드리스로 완전 자동 검증 불가. 사용자가 `/live`에서 직접 육안 확인해야 하며, 자동 테스트(Task 1–3)는 데이터·격리·상계 불변식만 보장한다.
