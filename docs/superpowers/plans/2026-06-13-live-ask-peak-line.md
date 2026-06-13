# 당일 매도 최대벽 (Day Ask Peak) 지표 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 당일(오늘) 매도 10호가 중 연속거래 중 단일 단계에 걸린 최대 물량과 그 가격을 `/live` 캔들 차트에 수평 실선으로 표시하고, 지표 모달 사이드메뉴에서 on/off·색·두께를 조절한다.

**Architecture:** "당일 전체" 정확성 = 백엔드 seed(오늘 `snapshots.parquet` 1패스 `query_day_ask_peak`, 연속거래만) + 클라 단조 ratchet(`useDayAskPeak`이 LivePage의 기존 `live.ob`를 폴드, 15분 버퍼 누락 방지). 렌더는 `LiveCurrentPriceLine` 패턴을 복제한 멍청한 컴포넌트가 native price line 1개를 그린다. UI는 `IndicatorPanel` 사이드메뉴 + `MAStylePicker` 재활용.

**Tech Stack:** Python(FastAPI·DuckDB·pydantic)/pytest, TypeScript(React·Zustand·lightweight-charts)/Vitest.

**Spec:** `docs/superpowers/specs/2026-06-13-live-ask-peak-line-design.md` (commit 7b53454).

**Test commands (learnings):**
- Backend: `uv run --extra dev pytest -q <path>` (pytest는 `[dev]` extra에 있음)
- Frontend: `cd frontend && npx vitest run <path>` · 타입체크 `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
- 워크트리에서 작업 중(`worktree-live-ask-peak-line`). 커밋은 메시지 파일 + 단독 `git commit -F`(block-no-verify 훅이 `&&`-체이닝·`--no-verify` 차단).

---

## Phase A — Backend (DuckDB 집계 + 번들 배선)

### Task 1: `query_day_ask_peak` + `AskPeakRow` (snapshots 테이블)

**Files:**
- Modify: `hoga/tables/snapshots.py` (추가: `AskPeakRow` 데이터클래스, `_DEEP_BOOK_SQL` 상수, `query_day_ask_peak`)
- Test: `tests/test_tables_snapshots.py`

핵심 사실:
- 컬럼 `ask_p1..10`/`ask_q1..10`, `ORDERBOOK_LEVELS=10`. 연속거래 술어 = `(_ASK_DEEP_SUM)>0 OR (_BID_DEEP_SUM)>0`(레벨4..10 합).
- `ts_ms`는 **HHMMSSmmm 인코딩** — `hhmmssms_to_intra_ms_sql("ts_ms")`로 선형 ms-from-midnight 디코드해 정렬·반환(번들이 unix 변환).
- `Orderbook(ts_ms, seq, ask_p, ask_q, ask_d, bid_p, bid_q, bid_d, tot_ask, tot_ask_d, tot_bid, tot_bid_d)` (각 *_p/*_q/*_d는 길이 10 tuple), `write_parquet(list, path)`.

- [ ] **Step 1: 실패 테스트 작성**

`tests/test_tables_snapshots.py` 상단 import에 추가(기존 import 블록 옆):

```python
import duckdb
from hoga.tables.snapshots import AskPeakRow, query_day_ask_peak
```

테스트 헬퍼 + 케이스 추가(파일 끝에):

```python
def _ob(ts_ms: int, ask_q: list[int], ask_p: list[int] | None = None) -> "Orderbook":
    """ask_q/ask_p는 길이 10. bid는 연속거래로 보이게 깊이 채움(레벨4+ >0)."""
    from hoga.tables.snapshots import Orderbook
    ap = tuple(ask_p or [25000 + 50 * i for i in range(10)])
    aq = tuple(ask_q)
    bq = tuple([100] * 10)  # bid 깊이 충분 → 연속거래(_BID_DEEP_SUM>0)
    bp = tuple([24950 - 50 * i for i in range(10)])
    z = tuple([0] * 10)
    return Orderbook(ts_ms=ts_ms, seq=1, ask_p=ap, ask_q=aq, ask_d=z,
                     bid_p=bp, bid_q=bq, bid_d=z, tot_ask=sum(aq), tot_ask_d=0,
                     tot_bid=sum(bq), tot_bid_d=0)


def _con_for(path) -> "duckdb.DuckDBPyConnection":
    return duckdb.connect()


def test_query_day_ask_peak_basic(tmp_path) -> None:
    # 가장 큰 단일 매도단계: ts 90100000, level3(가격 25100)에 5000
    obs = [
        _ob(90000000, [10, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
        _ob(90100000, [100, 200, 5000, 40, 5, 6, 7, 8, 9, 1],
            ask_p=[25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450]),
        _ob(90200000, [10, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    peak = query_day_ask_peak(_con_for(out), path=out)
    assert peak == AskPeakRow(price=25100, qty=5000, intra_ms=peak.intra_ms)
    assert peak.qty == 5000 and peak.price == 25100


def test_query_day_ask_peak_tie_earliest(tmp_path) -> None:
    obs = [
        _ob(90200000, [7000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[26000] + [25000 + i for i in range(9)]),
        _ob(90100000, [7000, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ask_p=[25500] + [25000 + i for i in range(9)]),  # 더 이른 시각
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    peak = query_day_ask_peak(_con_for(out), path=out)
    assert peak is not None and peak.qty == 7000 and peak.price == 25500  # 이른 시각 채택


def test_query_day_ask_peak_excludes_single_price(tmp_path) -> None:
    # 동시호가/VI 붕괴 호가창(레벨4..10 = 0 양측)이 더 큰 누적 qty를 가져도 배제.
    from hoga.tables.snapshots import Orderbook
    z = tuple([0] * 10)
    collapsed = Orderbook(
        ts_ms=152100000, seq=1,
        ask_p=(25000, 25050, 25100) + (0,) * 7, ask_q=(99999, 1, 1) + (0,) * 7, ask_d=z,
        bid_p=(24950, 24900, 24850) + (0,) * 7, bid_q=(1, 1, 1) + (0,) * 7, bid_d=z,
        tot_ask=100001, tot_ask_d=0, tot_bid=3, tot_bid_d=0,
    )
    continuous = _ob(90100000, [10, 20, 300, 40, 5, 6, 7, 8, 9, 1],
                     ask_p=[25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400, 25450])
    out = tmp_path / "snapshots.parquet"
    write_parquet([collapsed, continuous], out)
    peak = query_day_ask_peak(_con_for(out), path=out)
    assert peak is not None and peak.qty == 300  # 붕괴행의 99999 무시, 연속행 최대


def test_query_day_ask_peak_empty(tmp_path) -> None:
    out = tmp_path / "snapshots.parquet"
    write_parquet([], out)
    assert query_day_ask_peak(_con_for(out), path=out) is None
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/test_tables_snapshots.py -k ask_peak -q`
Expected: FAIL — `ImportError: cannot import name 'AskPeakRow'`.

- [ ] **Step 3: 구현**

`hoga/tables/snapshots.py`에서 `_BID_DEEP_SUM` 정의 바로 아래에 상수 추가:

```python
# 연속거래 호가창 술어 — query_bucketed_ratio의 deep_book_sql과 동일(단일진실원).
# 클라 isContinuousBook(bucketHogaSeries.ts)과도 글자 그대로 같은 정의.
_DEEP_BOOK_SQL: str = f"(({_ASK_DEEP_SUM}) > 0 OR ({_BID_DEEP_SUM}) > 0)"
```

`QuoteRatioRow` 데이터클래스 근처(같은 `@dataclass(frozen=True)` 군집)에 추가:

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

파일 끝(쿼리 함수들 옆)에 추가:

```python
def query_day_ask_peak(
    con: duckdb.DuckDBPyConnection, *, path: Path
) -> AskPeakRow | None:
    """연속거래 호가창만 대상으로 당일 단일 매도 호가단계 최대 qty와 그 가격을 반환.

    동시호가·VI 단일가(3-레벨 붕괴)는 ``_DEEP_BOOK_SQL``로 배제(ADR-0062). 동률이면
    가장 이른 시각. 빈 parquet → None. 파일 부재 가드는 호출자(bundle) 책임."""
    intra = hhmmssms_to_intra_ms_sql("ts_ms")
    union = " UNION ALL ".join(
        f"SELECT ask_p{i} AS price, ask_q{i} AS qty, {intra} AS intra_ms "
        f"FROM s WHERE ask_q{i} > 0"
        for i in range(1, ORDERBOOK_LEVELS + 1)
    )
    row = con.execute(
        f"WITH s AS (SELECT * FROM read_parquet(?) WHERE {_DEEP_BOOK_SQL}) "
        f"SELECT price, qty, intra_ms FROM ({union}) "
        f"ORDER BY qty DESC, intra_ms ASC LIMIT 1",
        [str(path)],
    ).fetchone()
    if row is None:
        return None
    return AskPeakRow(price=int(row[0]), qty=int(row[1]), intra_ms=int(row[2]))
```

- [ ] **Step 4: 통과 확인**

Run: `uv run --extra dev pytest tests/test_tables_snapshots.py -k ask_peak -q`
Expected: PASS (4 passed).

- [ ] **Step 5: 커밋**

메시지 파일에 적고 단독 커밋:
```bash
printf '%s\n' "feat(live): query_day_ask_peak — 당일 연속거래 매도 최대벽 집계" "" "snapshots 테이블에 단일 매도 호가단계 최대 qty/가격 집계 추가. 동시호가·VI" "단일가는 deep_book_sql로 배제. ts_ms는 HHMMSSmmm→intra_ms 디코드." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t1.txt
git add hoga/tables/snapshots.py tests/test_tables_snapshots.py
git commit -F /tmp/cm_t1.txt
```

---

### Task 2: `AskPeak` 와이어 모델 + `RangeBundle.ask_peak`

**Files:**
- Modify: `hoga/api/models.py` (추가: `class AskPeak`, `RangeBundle.ask_peak`)
- Test: `tests/hoga/api/test_bundle.py` (모델 직렬화 단위 — 기존 파일에 한 케이스)

- [ ] **Step 1: 실패 테스트 작성**

`tests/hoga/api/test_bundle.py` 끝에 추가:

```python
def test_range_bundle_ask_peak_field_defaults_none() -> None:
    from hoga.api.models import AskPeak, RangeBundle
    from hoga.api.models import QuoteRatio, FillStrength, VolumeProfile
    b = RangeBundle(
        code="005930", from_date="20260613", to_date="20260613", bucket_ms=60000,
        segments=[], candles=[],
        quote_ratio=QuoteRatio(bucket_ms=60000, points=[]),
        fill_strength=FillStrength(bucket_ms=60000, points=[]),
        volume_profile_range=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[]),
        volume_profile_by_day=[],
    )
    assert b.ask_peak is None  # 기본 None — 기존 클라 무영향
    b2 = b.model_copy(update={"ask_peak": AskPeak(price=25100, qty=5000, t_ms=1)})
    assert b2.ask_peak.price == 25100 and b2.ask_peak.t_ms == 1
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/hoga/api/test_bundle.py -k ask_peak -q`
Expected: FAIL — `ImportError: cannot import name 'AskPeak'`.

- [ ] **Step 3: 구현**

`hoga/api/models.py`에서 `QuoteRatioPoint`(line ~94) 근처에 추가:

```python
class AskPeak(BaseModel):
    """당일 연속거래 중 단일 매도 호가단계 최대 물량·가격(Day Ask Peak).

    ``t_ms``는 unix ms(KST). 캔들 시각과 동일 좌표계."""
    price: int
    qty: int
    t_ms: int
```

`class RangeBundle(BaseModel)` 본문 끝(`data_warnings` 다음)에 추가:

```python
    # 당일 매도 최대벽 seed(연속거래만). 오늘 slice에서만 채워지고, 그 외/D·W·M/무데이터는
    # None. 기본 None이라 기존 클라 무영향. 라이브 ratchet이 이 값을 시드로 전진.
    ask_peak: "AskPeak | None" = None
```

- [ ] **Step 4: 통과 확인**

Run: `uv run --extra dev pytest tests/hoga/api/test_bundle.py -k ask_peak -q`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
printf '%s\n' "feat(live): AskPeak 와이어 모델 + RangeBundle.ask_peak 필드" "" "기본 None이라 기존 클라 무영향." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t2.txt
git add hoga/api/models.py tests/hoga/api/test_bundle.py
git commit -F /tmp/cm_t2.txt
```

---

### Task 3: 번들 배선 — `build_ask_peak_slice` + 오늘-전용 계산

**Files:**
- Modify: `hoga/api/bundle.py` (추가: `build_ask_peak_slice`, build_range_bundle 루프 훅·반환, `_empty_range_bundle` ask_peak=None)
- Test: `tests/hoga/api/test_bundle.py`

- [ ] **Step 1: 실패 테스트 작성**

먼저 `tests/hoga/api/test_bundle.py`를 읽어 기존 엔진 fixture 헬퍼(예: 메타·parquet을 깔고 `build_range_bundle`을 부르는 헬퍼) 이름과 시그니처를 확인한다. 그 헬퍼로 "오늘 날짜"에 연속거래 스냅샷을 깐 뒤:

```python
def test_build_range_bundle_includes_ask_peak_for_today(monkeypatch) -> None:
    # 기존 헬퍼로 오늘(today_kst) 날짜에 snapshots.parquet(연속거래 + 단일 큰 매도단계)를
    # 깔고 build_range_bundle 호출. ask_peak가 그 최대단계 price/qty로 채워지는지.
    # (today_kst 고정: bundle._today_kst_yyyymmdd를 monkeypatch 또는 헬퍼의 날짜를 오늘로.)
    ...
    bundle = build_range_bundle(engine, code=code, from_date=today, to_date=today, bucket_ms=60000)
    assert bundle.ask_peak is not None
    assert bundle.ask_peak.qty == EXPECTED_QTY and bundle.ask_peak.price == EXPECTED_PRICE
    # t_ms는 unix ms(그 날짜 09:xx) — 양수·해당일 범위
    assert bundle.ask_peak.t_ms > 0


def test_build_range_bundle_ask_peak_none_when_no_today(monkeypatch) -> None:
    # 범위가 과거일만(오늘 미포함) → ask_peak None.
    ...
    assert bundle.ask_peak is None
```

> 구현 메모(테스트 작성 시): `build_range_bundle`은 `today_kst = _today_kst_yyyymmdd()`를 루프 안에서 쓴다. 테스트는 (a) 헬퍼 날짜를 진짜 오늘로 맞추거나 (b) `monkeypatch.setattr(bundle, "_today_kst_yyyymmdd", lambda: <fixture date>)`로 고정한다.

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/hoga/api/test_bundle.py -k ask_peak -q`
Expected: FAIL (`AttributeError`/assert — bundle.ask_peak가 항상 None).

- [ ] **Step 3: 구현**

`hoga/api/bundle.py`에 `build_quote_ratio_slice` 근처로 슬라이스 빌더 추가:

```python
def build_ask_peak_slice(
    engine: QueryEngine, *, code: str, date: str, source: str = "hogaplay",
) -> "AskPeak | None":
    """당일(date) 연속거래 매도 최대벽 seed. 파일 부재(=무데이터, ADR-0043) → None."""
    path_obj = engine.parquet_dir(date, code, source) / "snapshots.parquet"
    if not path_obj.exists():
        return None
    row = snapshots_tbl.query_day_ask_peak(engine.conn, path=path_obj)
    if row is None:
        return None
    return AskPeak(
        price=row.price, qty=row.qty,
        t_ms=ms_from_midnight_to_unix_ms(date, row.intra_ms),
    )
```

`models` import에 `AskPeak` 추가(파일 상단 `from hoga.api.models import (...)` 블록에 `AskPeak,`).

`build_range_bundle` 루프에서 `vp_d = build_volume_profile_slice(...)` 다음에:

```python
        if d == today_kst and c.state != DiskState.INVALID:
            ask_peak_today = build_ask_peak_slice(engine, code=code, date=d, source=source)
```

루프 앞 변수 초기화부(예: `profiles_by_day: list[VolumeProfile] = []` 근처):

```python
    ask_peak_today: "AskPeak | None" = None
```

성공-경로 `return RangeBundle(...)`에 필드 추가:

```python
        ask_peak=ask_peak_today,
```

`_empty_range_bundle` 반환에도(명시적으로) `ask_peak=None,` 추가.

- [ ] **Step 4: 통과 확인**

Run: `uv run --extra dev pytest tests/hoga/api/test_bundle.py -q`
Expected: PASS(전체). 회귀 없게 전체 파일 실행.

- [ ] **Step 5: 백엔드 전체 + 불변식 확인**

Run: `uv run --extra dev pytest tests/test_tables_snapshots.py tests/hoga/api/test_bundle.py tests/test_adr_invariants.py -q`
Expected: PASS. (ADR-0038 — snapshots 집계는 cold-path만이므로 hot-path import 불변식 불변.)

- [ ] **Step 6: 커밋**

```bash
printf '%s\n' "feat(live): 번들에 ask_peak seed 배선 — 오늘 slice 연속거래만" "" "build_ask_peak_slice + build_range_bundle 오늘-전용 계산. intra_ms→unix 변환." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t3.txt
git add hoga/api/bundle.py tests/hoga/api/test_bundle.py
git commit -F /tmp/cm_t3.txt
```

---

## Phase B — Frontend 순수함수 + 훅

### Task 4: `formatQtyKo` 만/억 포맷터

**Files:**
- Create: `frontend/src/util/formatQtyKo.ts`
- Test: `frontend/src/util/formatQtyKo.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/util/formatQtyKo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatQtyKo } from './formatQtyKo';

describe('formatQtyKo', () => {
  it('< 1만은 천단위 구분', () => {
    expect(formatQtyKo(9_999)).toBe('9,999');
    expect(formatQtyKo(0)).toBe('0');
  });
  it('만 단위 한 자리 소수', () => {
    expect(formatQtyKo(123_456)).toBe('12.3만');
    expect(formatQtyKo(10_000)).toBe('1만');
  });
  it('억 단위 한 자리 소수', () => {
    expect(formatQtyKo(123_456_789)).toBe('1.2억');
    expect(formatQtyKo(100_000_000)).toBe('1억');
  });
  it('음수·비정상은 0', () => {
    expect(formatQtyKo(-5)).toBe('0');
    expect(formatQtyKo(Number.NaN)).toBe('0');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/util/formatQtyKo.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 구현**

`frontend/src/util/formatQtyKo.ts`:

```ts
/** 호가 물량(주)을 컴팩트 한국어 단위로. 차트 선 라벨용(좁은 폭).
 *  < 1만: 천단위 콤마. 1만~1억: `N.N만`(정수면 소수 생략). ≥1억: `N.N억`.
 *  음수·비유한값은 '0'. */
export function formatQtyKo(qty: number): string {
  if (!Number.isFinite(qty) || qty <= 0) return '0';
  const trim = (n: number): string =>
    (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
  if (qty >= 100_000_000) return `${trim(qty / 100_000_000)}억`;
  if (qty >= 10_000) return `${trim(qty / 10_000)}만`;
  return qty.toLocaleString('en-US');
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/util/formatQtyKo.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
printf '%s\n' "feat(live): formatQtyKo — 호가 물량 만/억 컴팩트 포맷터" "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t4.txt
git add frontend/src/util/formatQtyKo.ts frontend/src/util/formatQtyKo.test.ts
git commit -F /tmp/cm_t4.txt
```

---

### Task 5: 와이어 타입 `AskPeak` + `RangeBundle.ask_peak`

**Files:**
- Modify: `frontend/src/api/types.ts` (추가 type + RangeBundle 필드)

(순수 타입 추가라 단독 테스트 없음 — Task 7/8에서 사용·tsc로 검증.)

- [ ] **Step 1: 구현**

`frontend/src/api/types.ts`의 `InvestorNetPoint`(line ~434) 근처에 추가:

```ts
/** 당일 매도 최대벽 — 연속거래 중 단일 매도 호가단계 최대 물량·가격.
 *  hoga/api/models.py::AskPeak 미러. t_ms는 unix ms(KST). */
export type AskPeak = { price: number; qty: number; t_ms: number };
```

`RangeBundle` 타입(line ~436) 본문 끝(`investorPoints` 다음)에 추가:

```ts
  /** 당일 매도 최대벽 seed(오늘 slice 연속거래만). 오늘 미포함/D·W·M/무데이터 → null.
   *  라이브 ratchet(useDayAskPeak)의 시드. */
  ask_peak: AskPeak | null;
```

> 주: 백엔드는 항상 필드를 보낸다(없으면 null). 기존 번들 빌드 테스트 fixture가 이 필드를 누락하면
> TS 컴파일은 통과하나 런타임 객체에 없을 수 있다 — Task 7 훅은 `bundle?.ask_peak ?? null`로 방어한다.

- [ ] **Step 2: 타입체크**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Expected: 통과(기존 `RangeBundle` 생성처가 새 필수 필드 `ask_peak` 누락으로 에러나면 그 fixture/생성처에 `ask_peak: null` 추가. 에러 목록의 각 위치에 추가).

- [ ] **Step 3: 커밋**

```bash
printf '%s\n' "feat(live): 프론트 AskPeak 타입 + RangeBundle.ask_peak" "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t5.txt
git add frontend/src/api/types.ts
git commit -F /tmp/cm_t5.txt
```

---

### Task 6: `computeDayAskPeak` — 순수 fold + tradingDayOf

**Files:**
- Create: `frontend/src/live/computeDayAskPeak.ts`
- Test: `frontend/src/live/computeDayAskPeak.test.ts`

재활용: `isContinuousBook`·`ObSnapshot`(`./bucketHogaSeries`), `AskPeak`(`../api/types`).

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/live/computeDayAskPeak.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { foldAskPeak, type RatchetState } from './computeDayAskPeak';
import type { ObSnapshot } from './bucketHogaSeries';

const KST = 9 * 3600_000;
const t = (h: number, m = 0) => Date.UTC(2026, 5, 13, h - 9, m) ; // 대충 KST 시각의 unix ms

// 깊은(연속거래) 호가창: asks 길이 10, 레벨4+ qty>0
function deepOb(t_ms: number, asks: Array<[number, number]>): ObSnapshot {
  return {
    t_ms, total_ask_qty: 0, total_bid_qty: 0,
    asks: asks.map(([price, qty]) => ({ price, qty })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: 24000 - i, qty: 100 })),
  };
}
const FRESH: RatchetState = { peak: null, tradingDay: -1, lastTMs: -1 };

describe('foldAskPeak', () => {
  it('seed-only: 버퍼 빈, seed 유지', () => {
    const seed = { price: 25100, qty: 5000, t_ms: t(9) };
    const s = foldAskPeak(FRESH, seed, deepOb(t(9, 1), []), seed); // ob 없음 취급
    expect(s.peak).toEqual(seed);
  });

  it('버퍼 신기록이 seed 초과 → 교체', () => {
    const seed = { price: 25100, qty: 5000, t_ms: t(9) };
    const ob = deepOb(t(10), [[26000, 9000], [25000, 10], ...Array(8).fill([0, 0])] as any);
    const s = foldAskPeak(FRESH, seed, ob, seed);
    expect(s.peak).toEqual({ price: 26000, qty: 9000, t_ms: t(10) });
  });

  it('단조: 큰 값 뒤 작은 값 무시', () => {
    const seed = null;
    let s = foldAskPeak(FRESH, seed, deepOb(t(10), [[26000, 9000], ...Array(9).fill([1, 1])] as any), seed);
    s = foldAskPeak(s, seed, deepOb(t(11), [[25000, 100], ...Array(9).fill([1, 1])] as any), seed);
    expect(s.peak!.qty).toBe(9000);
  });

  it('붕괴 호가창(isContinuousBook=false) 스킵', () => {
    const seed = null;
    const collapsed: ObSnapshot = {
      t_ms: t(15, 21), total_ask_qty: 0, total_bid_qty: 0,
      asks: [{ price: 25000, qty: 99999 }, { price: 25050, qty: 1 }, { price: 25100, qty: 1 },
             ...Array(7).fill({ price: 0, qty: 0 })],
      bids: [{ price: 24000, qty: 1 }, { price: 23950, qty: 1 }, { price: 23900, qty: 1 },
             ...Array(7).fill({ price: 0, qty: 0 })],
    };
    const s = foldAskPeak(FRESH, seed, collapsed, seed);
    expect(s.peak).toBeNull(); // 99999 무시
  });

  it('동률은 먼저 것 유지', () => {
    const seed = { price: 25500, qty: 7000, t_ms: t(9) };
    const ob = deepOb(t(10), [[26000, 7000], ...Array(9).fill([1, 1])] as any);
    const s = foldAskPeak(FRESH, seed, ob, seed);
    expect(s.peak!.price).toBe(25500); // 동률 비교체
  });

  it('거래일 경계: 리셋 후 재시드', () => {
    const seed = { price: 25100, qty: 5000, t_ms: t(9) };
    let s: RatchetState = { peak: { price: 99, qty: 99999, t_ms: t(9) - 86_400_000 },
                            tradingDay: 0, lastTMs: t(9) - 86_400_000 };
    s = foldAskPeak(s, seed, deepOb(t(9, 1), []), seed);
    expect(s.peak).toEqual(seed); // 어제 99999 버리고 오늘 seed로
  });

  it('증분 멱등: 이미 fold한 tMs 이하 재공급 무시', () => {
    const seed = null;
    const ob = deepOb(t(10), [[26000, 9000], ...Array(9).fill([1, 1])] as any);
    let s = foldAskPeak(FRESH, seed, ob, seed);
    s = foldAskPeak(s, seed, ob, seed); // 같은 tMs
    expect(s.peak!.qty).toBe(9000);
  });
});
```

> 시그니처 메모: `foldAskPeak(prev, seed, ob, seedForReseed)` 4-인자 대신, 구현은 `foldAskPeak(prev, seed, ob)`로 두고 거래일 리셋 시 같은 `seed`로 재반영한다(seed는 인자에 이미 있음). 위 테스트의 4번째 인자는 가독용 중복 — 구현 시그니처는 3-인자 `foldAskPeak(prev, seed, ob)`로 하고 테스트의 4번째 인자 제거. (Step 3에서 테스트도 3-인자로 정리.)

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/computeDayAskPeak.test.ts`
Expected: FAIL(모듈 없음).

- [ ] **Step 3: 구현 + 테스트 3-인자 정리**

`frontend/src/live/computeDayAskPeak.ts`:

```ts
import type { AskPeak } from '../api/types';
import { isContinuousBook, type ObSnapshot } from './bucketHogaSeries';

export type RatchetState = {
  peak: AskPeak | null;
  tradingDay: number;
  lastTMs: number;
};

export const FRESH_RATCHET: RatchetState = { peak: null, tradingDay: -1, lastTMs: -1 };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** KST 자정 기준 거래일 번호(급증 마커 detectSurges와 동일 규칙). */
export function tradingDayOf(tMs: number): number {
  return Math.floor((tMs + KST_OFFSET_MS) / 86_400_000);
}

/** seed로 시작한 단조 ratchet에 한 ObSnapshot을 폴드. 연속거래(isContinuousBook)만,
 *  거래일 경계에서 리셋·재시드, 동률 비교체(먼저 도달 유지), 이미 본 tMs는 멱등.
 *  ob.asks가 없으면(totals-only) 후보는 seed뿐. */
export function foldAskPeak(
  prev: RatchetState,
  seed: AskPeak | null,
  ob: ObSnapshot,
): RatchetState {
  const day = tradingDayOf(ob.t_ms);
  let state = prev;
  if (day !== prev.tradingDay) {
    // 거래일 전환: 리셋 후 seed 재반영.
    state = { peak: seed, tradingDay: day, lastTMs: -1 };
  }
  if (ob.t_ms <= state.lastTMs) return state; // 멱등(증분)
  let best = state.peak;
  if (isContinuousBook(ob) && ob.asks) {
    for (const lv of ob.asks) {
      if (lv.qty > 0 && (best === null || lv.qty > best.qty)) {
        best = { price: lv.price, qty: lv.qty, t_ms: ob.t_ms };
      }
    }
  }
  return { peak: best, tradingDay: day, lastTMs: ob.t_ms };
}
```

위 테스트에서 `foldAskPeak(... , seed)` 4번째 인자를 모두 제거(3-인자)하고, seed-only 케이스는 `ob.asks` 없는 ObSnapshot으로 표현:
```ts
const noAsks = (t_ms: number): ObSnapshot => ({ t_ms, total_ask_qty: 0, total_bid_qty: 0 });
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/computeDayAskPeak.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
printf '%s\n' "feat(live): computeDayAskPeak — 단조 ratchet 순수 fold" "" "isContinuousBook 재활용(연속거래만)·거래일 리셋·동률 비교체·멱등 증분." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t6.txt
git add frontend/src/live/computeDayAskPeak.ts frontend/src/live/computeDayAskPeak.test.ts
git commit -F /tmp/cm_t6.txt
```

---

### Task 7: `useDayAskPeak` — 상태 ratchet 훅(LivePage용)

**Files:**
- Create: `frontend/src/live/useDayAskPeak.ts`
- Test: `frontend/src/live/useDayAskPeak.test.tsx`

제약: 이 훅은 `useLiveSeries`를 **절대 호출하지 않는다**(2차 SSE 금지). `ob`/`seed`/`code`를 인자로 받기만.

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/live/useDayAskPeak.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDayAskPeak } from './useDayAskPeak';
import type { ObSnapshot } from './bucketHogaSeries';

const deep = (t_ms: number, q: number, price = 26000): ObSnapshot => ({
  t_ms, total_ask_qty: 0, total_bid_qty: 0,
  asks: [{ price, qty: q }, ...Array.from({ length: 9 }, () => ({ price: 1, qty: 1 }))],
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 24000 - i, qty: 100 })),
});

describe('useDayAskPeak', () => {
  it('seed로 시작, 증분 ob로 전진', () => {
    const seed = { price: 25100, qty: 5000, t_ms: deep(1, 0).t_ms };
    const { result, rerender } = renderHook(
      ({ ob }: { ob: ObSnapshot[] }) => useDayAskPeak(ob, seed, '005930'),
      { initialProps: { ob: [] as ObSnapshot[] } },
    );
    expect(result.current).toEqual(seed);
    rerender({ ob: [deep(Date.now(), 9000)] });
    expect(result.current!.qty).toBe(9000);
  });

  it('code 변경 시 리셋·재시드', () => {
    const seedA = { price: 1, qty: 9000, t_ms: Date.now() };
    const { result, rerender } = renderHook(
      ({ code, ob, seed }: any) => useDayAskPeak(ob, seed, code),
      { initialProps: { code: 'A', ob: [deep(Date.now(), 12000)], seed: seedA } },
    );
    expect(result.current!.qty).toBe(12000);
    const seedB = { price: 2, qty: 100, t_ms: Date.now() };
    rerender({ code: 'B', ob: [], seed: seedB });
    expect(result.current).toEqual(seedB); // A의 12000 안 새어나옴
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/useDayAskPeak.test.tsx`
Expected: FAIL(모듈 없음).

- [ ] **Step 3: 구현**

`frontend/src/live/useDayAskPeak.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import type { AskPeak } from '../api/types';
import type { ObSnapshot } from './bucketHogaSeries';
import { foldAskPeak, FRESH_RATCHET, type RatchetState } from './computeDayAskPeak';

/** 당일 매도 최대벽 ratchet. LivePage에서 **1회** 호출(기존 live.ob 재사용 —
 *  useLiveSeries를 다시 부르지 않아 2차 SSE 연결을 만들지 않는다).
 *  ob: SSE 버퍼(≤15분, ref가 틱마다 바뀜). seed: bundle.ask_peak. */
export function useDayAskPeak(
  ob: ReadonlyArray<ObSnapshot>,
  seed: AskPeak | null,
  code: string | null,
): AskPeak | null {
  const stateRef = useRef<RatchetState>(FRESH_RATCHET);
  const [peak, setPeak] = useState<AskPeak | null>(seed);

  // code 변경 → 리셋·재시드(remount 비의존).
  useEffect(() => {
    stateRef.current = FRESH_RATCHET;
    setPeak(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // ob 틱마다 증분 fold(lastTMs 가드로 본 것은 건너뜀). seed 변동도 반영.
  useEffect(() => {
    let s = stateRef.current;
    for (const snap of ob) s = foldAskPeak(s, seed, snap);
    stateRef.current = s;
    setPeak(s.peak ?? seed);
  }, [ob, seed]);

  return peak;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/useDayAskPeak.test.tsx`
Expected: PASS.

- [ ] **Step 5: 단일-구독 정적 확인(불변식)**

Run: `cd frontend && grep -n "useLiveSeries" src/live/useDayAskPeak.ts src/live/LiveAskPeakLine.tsx 2>/dev/null || echo "OK: no useLiveSeries in ratchet/render"`
Expected: `OK: no useLiveSeries ...` (둘 다 useLiveSeries 미사용 — 2차 SSE 없음).

- [ ] **Step 6: 커밋**

```bash
printf '%s\n' "feat(live): useDayAskPeak — LivePage용 단조 ratchet 훅(단일 SSE 구독)" "" "기존 live.ob 재사용, code 리셋·증분 fold. useLiveSeries 미호출." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t7.txt
git add frontend/src/live/useDayAskPeak.ts frontend/src/live/useDayAskPeak.test.tsx
git commit -F /tmp/cm_t7.txt
```

---

## Phase C — Frontend 렌더 + 배선

### Task 8: 스토어 필드·세터·영속(`askPeakEnabled`/`askPeakColor`/`askPeakLineWidth`)

**Files:**
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts` (PersistedIndicators 타입 + merge 검증·기본값)
- Modify: `frontend/src/state/livePage.ts` (PersistedIndicators 타입, Store 세터 타입, 세터 구현, snapshotIndicators)
- Test: `frontend/src/state/liveIndicatorsPersistence.test.ts`(있으면 거기) 또는 신규 `*.test.ts`

기존 재활용: `HEX_COLOR`, `VALID_LINE_WIDTHS`(liveIndicatorsPersistence.ts). 기본값 `#1D4ED8`/`2`/`false`.

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/state/liveIndicatorsPersistence.test.ts`(기존 파일이면 케이스 추가, 없으면 생성):

```ts
import { describe, it, expect } from 'vitest';
import { mergeLiveIndicatorPrefs } from './liveIndicatorsPersistence';

describe('mergeLiveIndicatorPrefs — askPeak', () => {
  it('레거시(필드 없음): 기본 off/#1D4ED8/2', () => {
    const m = mergeLiveIndicatorPrefs(undefined);
    expect(m.askPeakEnabled).toBe(false);
    expect(m.askPeakColor).toBe('#1D4ED8');
    expect(m.askPeakLineWidth).toBe(2);
  });
  it('유효값 보존', () => {
    const m = mergeLiveIndicatorPrefs({ askPeakEnabled: true, askPeakColor: '#EF4444', askPeakLineWidth: 3 });
    expect(m.askPeakEnabled).toBe(true);
    expect(m.askPeakColor).toBe('#EF4444');
    expect(m.askPeakLineWidth).toBe(3);
  });
  it('이상값 폴백', () => {
    const m = mergeLiveIndicatorPrefs({ askPeakColor: 'red', askPeakLineWidth: 9 });
    expect(m.askPeakColor).toBe('#1D4ED8');
    expect(m.askPeakLineWidth).toBe(2);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts`
Expected: FAIL(`askPeakEnabled` undefined).

- [ ] **Step 3: 구현 — liveIndicatorsPersistence.ts**

`PersistedIndicators` 타입에 추가:
```ts
  /** 당일 매도 최대벽 토글. opt-in(기본 false). */
  askPeakEnabled: boolean;
  /** 매도 최대벽 선 색(hex). 기본 #1D4ED8(파랑). */
  askPeakColor: string;
  /** 매도 최대벽 선 두께. 기본 2. */
  askPeakLineWidth: 1 | 2 | 3 | 4;
```

기본값 상수(파일에 색/폭 기본 정의):
```ts
export const ASK_PEAK_DEFAULT_COLOR = '#1D4ED8';
export const ASK_PEAK_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 2;
```

`mergeLiveIndicatorPrefs`의 `build(...)` 호출과 그 헬퍼를 확장한다. 현재 `build(arr, enabled, fNet, iNet, vol, hidden)` 시그니처에 3개 인자를 더하는 대신, build 내부에서 `obj`를 직접 읽도록 리팩터(아래)하거나 build에 askPeak 묶음을 추가한다. 최소 변경:

`build` 함수가 만드는 반환 객체에 추가(merge 본문에서 `obj` 접근 가능하게 askPeak 값을 build 인자로 전달):
```ts
  const apEnabled = obj?.askPeakEnabled === true;
  const apColor = typeof obj?.askPeakColor === 'string' && HEX_COLOR.test(obj.askPeakColor)
    ? obj.askPeakColor : ASK_PEAK_DEFAULT_COLOR;
  const apWidth = VALID_LINE_WIDTHS.has(obj?.askPeakLineWidth as number)
    ? (obj!.askPeakLineWidth as 1 | 2 | 3 | 4) : ASK_PEAK_DEFAULT_WIDTH;
```
그리고 반환 객체에 `askPeakEnabled: apEnabled, askPeakColor: apColor, askPeakLineWidth: apWidth` 추가. (raw 없음 경로/배열-없음 경로 모두 동일 기본이 되도록, `obj`가 없으면 기본값으로 평가됨 — `obj?.` 옵셔널 접근.)

> 정확한 삽입은 기존 `mergeLiveIndicatorPrefs`/`build` 구조를 읽고 모든 반환 분기가 askPeak 3필드를 포함하도록 한다(누락 분기 없게).

- [ ] **Step 4: 구현 — livePage.ts**

`PersistedIndicators`(line ~88)에 동일 3필드 추가. `Store` 타입에 세터 추가:
```ts
  setAskPeakEnabled: (enabled: boolean) => void;
  setAskPeakStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
```
세터 구현(다른 `set...Enabled` 옆):
```ts
  setAskPeakEnabled: (enabled) => {
    set({ askPeakEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },
  setAskPeakStyle: (patch) => {
    set((s) => ({
      askPeakColor: patch.color ?? s.askPeakColor,
      askPeakLineWidth: patch.lineWidth ?? s.askPeakLineWidth,
    }));
    persistIndicators(snapshotIndicators(get));
  },
```
`snapshotIndicators`(line ~170)에 3필드 추가:
```ts
    askPeakEnabled: s.askPeakEnabled,
    askPeakColor: s.askPeakColor,
    askPeakLineWidth: s.askPeakLineWidth,
```
스토어 초기 상태는 `readIndicatorsStorage()`(= mergeLiveIndicatorPrefs)에서 오므로 별도 DEFAULTS 불요(MA들과 동일 경로).

- [ ] **Step 5: 통과 + 타입체크**

Run: `cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS + 타입 OK.

- [ ] **Step 6: 커밋**

```bash
printf '%s\n' "feat(live): livePage 스토어에 askPeak 토글·색·두께 + 영속" "" "기본 off/#1D4ED8/2. HEX·width 검증 재활용. 3-지점 등록." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t8.txt
git add frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/livePage.ts frontend/src/state/liveIndicatorsPersistence.test.ts
git commit -F /tmp/cm_t8.txt
```

---

### Task 9: `LiveAskPeakLine.tsx` — 멍청한 price-line 렌더러

**Files:**
- Create: `frontend/src/live/LiveAskPeakLine.tsx`
- Test: `frontend/src/live/LiveAskPeakLine.test.tsx` (LiveCurrentPriceLine.test.tsx의 mock 패턴 복제)

먼저 `frontend/src/live/LiveCurrentPriceLine.tsx`와 `LiveCurrentPriceLine.test.tsx`를 읽어 `paneSeries`/`createPriceLine`/`applyOptions` mock 패턴을 그대로 따른다.

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/live/LiveAskPeakLine.test.tsx`(LiveCurrentPriceLine.test.tsx의 fake series/paneSeries 헬퍼 복제):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import LiveAskPeakLine from './LiveAskPeakLine';
import { useLivePageStore } from '../state/livePage';

// fake price line + series + paneSeries (LiveCurrentPriceLine.test.tsx에서 복제)
function fakeSeries() {
  const line = { applyOptions: vi.fn(), };
  const series = { createPriceLine: vi.fn(() => line), removePriceLine: vi.fn() };
  const paneSeries = new Map([['candle', series]]);
  return { line, series, paneSeries };
}

beforeEach(() => {
  useLivePageStore.setState({ askPeakEnabled: true, askPeakColor: '#1D4ED8', askPeakLineWidth: 2 } as any);
});

describe('LiveAskPeakLine', () => {
  it('peak 있으면 price line 생성(가격·색·두께)', () => {
    const { series, paneSeries } = fakeSeries();
    render(<LiveAskPeakLine paneSeries={paneSeries as never} peak={{ price: 25100, qty: 123456, t_ms: 1 }} />);
    expect(series.createPriceLine).toHaveBeenCalled();
    const opts = series.createPriceLine.mock.calls[0][0];
    expect(opts.price).toBe(25100);
    expect(opts.color).toBe('#1D4ED8');
    expect(opts.lineWidth).toBe(2);
    expect(opts.title).toContain('12.3만'); // formatQtyKo
  });

  it('토글 off면 lineVisible=false', () => {
    useLivePageStore.setState({ askPeakEnabled: false } as any);
    const { series, paneSeries } = fakeSeries();
    render(<LiveAskPeakLine paneSeries={paneSeries as never} peak={{ price: 25100, qty: 100, t_ms: 1 }} />);
    const opts = series.createPriceLine.mock.calls[0][0];
    expect(opts.lineVisible).toBe(false);
  });

  it('peak null이면 lineVisible=false', () => {
    const { series, paneSeries } = fakeSeries();
    render(<LiveAskPeakLine paneSeries={paneSeries as never} peak={null} />);
    const opts = series.createPriceLine.mock.calls[0][0];
    expect(opts.lineVisible).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/LiveAskPeakLine.test.tsx`
Expected: FAIL(모듈 없음).

- [ ] **Step 3: 구현**

`frontend/src/live/LiveAskPeakLine.tsx`(LiveCurrentPriceLine.tsx 패턴 복제):

```tsx
import { memo, useEffect, useRef } from 'react';
import type { IPriceLine, PriceLineOptions } from 'lightweight-charts';
import type { AskPeak } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import { useLivePageStore } from '../state/livePage';
import { formatQtyKo } from '../util/formatQtyKo';

type Props = {
  paneSeries: PaneSeriesMap;
  /** LivePage의 useDayAskPeak 결과(당일 매도 최대벽). null이면 숨김. */
  peak: AskPeak | null;
};

/** 당일 매도 최대벽 수평선. candle primary series에 native price line 1개를 걸어
 *  (1) 최대벽 가격 수평 실선 + (2) y축 가격 태그 + (3) 물량 라벨(title)을 그린다.
 *  색·두께·on/off는 livePage 스토어, 값(peak)은 prop. 형제: LiveCurrentPriceLine. */
function LiveAskPeakLine({ paneSeries, peak }: Props) {
  const series = paneSeries.get('candle' as PaneId);
  const enabled = useLivePageStore((s) => s.askPeakEnabled);
  const color = useLivePageStore((s) => s.askPeakColor);
  const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const visible = enabled && peak != null;
  const lineRef = useRef<IPriceLine | null>(null);

  useEffect(() => {
    if (!series) return;
    const line = series.createPriceLine({
      price: peak?.price ?? 0,
      color,
      lineWidth,
      lineStyle: 0, // Solid (현재가선 dashed와 구분)
      lineVisible: visible,
      axisLabelVisible: visible,
      axisLabelColor: color,
      title: peak ? `${formatQtyKo(peak.qty)}` : '',
    } as PriceLineOptions);
    lineRef.current = line;
    return () => {
      try { series.removePriceLine(line); } catch { /* torn down */ }
      lineRef.current = null;
    };
    // 생성은 series 핸들당 1회(LiveCurrentPriceLine과 동일). 값 변화는 아래 update effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  useEffect(() => {
    lineRef.current?.applyOptions({
      price: peak?.price ?? 0,
      color,
      lineWidth,
      lineVisible: visible,
      axisLabelVisible: visible,
      axisLabelColor: color,
      title: peak ? `${formatQtyKo(peak.qty)}` : '',
    } as Partial<PriceLineOptions>);
  }, [peak, color, lineWidth, visible]);

  return null;
}

export default memo(LiveAskPeakLine);
```

> import 경로(`PaneId`, `PaneSeriesMap`)는 LiveCurrentPriceLine.tsx와 **동일하게** 맞춘다(Step 1에서 읽은 경로).

- [ ] **Step 4: 통과 + 타입체크**

Run: `cd frontend && npx vitest run src/live/LiveAskPeakLine.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS + 타입 OK.

- [ ] **Step 5: 커밋**

```bash
printf '%s\n' "feat(live): LiveAskPeakLine — 매도 최대벽 수평선 렌더러" "" "LiveCurrentPriceLine 패턴 복제. peak prop + 스토어 색/두께/토글. 실선." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t9.txt
git add frontend/src/live/LiveAskPeakLine.tsx frontend/src/live/LiveAskPeakLine.test.tsx
git commit -F /tmp/cm_t9.txt
```

---

### Task 10: `dayAskPeak` 배선 — LivePage → LiveWorkarea → LiveChartRoot → 마운트

**Files:**
- Modify: `frontend/src/live/LivePage.tsx` (useDayAskPeak 호출 + prop 전달)
- Modify: `frontend/src/live/LiveWorkarea.tsx` (prop 통과)
- Modify: `frontend/src/live/LiveChartRoot.tsx` (Props에 dayAskPeak + LiveAskPeakLine 마운트)

순수 배선(렌더 동작은 Task 9에서 검증). 타입체크 + 기존 테스트 그린이 게이트.

- [ ] **Step 1: LivePage.tsx — ratchet 호출 + 전달**

`const live = useLiveSeries(...)`와 `useLiveBundle(...)` 다음에:
```ts
const dayAskPeak = useDayAskPeak(
  live.ob,
  (chartBundle ?? bundle)?.ask_peak ?? null,
  activeCode,
);
```
import 추가: `import { useDayAskPeak } from './useDayAskPeak';`
그리고 `<LiveWorkarea ... />`에 `dayAskPeak={dayAskPeak}` prop 전달(LiveWorkarea가 LiveChartRoot로 넘기는 다른 bundle props 옆).

- [ ] **Step 2: LiveWorkarea.tsx — 통과**

`Props`에 `dayAskPeak: AskPeak | null;`(import `AskPeak` from `../api/types`) 추가하고, `<LiveChartRoot ... />`에 `dayAskPeak={dayAskPeak}` 전달.

- [ ] **Step 3: LiveChartRoot.tsx — Props + 마운트**

`interface Props`에 추가:
```ts
  /** LivePage의 useDayAskPeak 결과 — LiveAskPeakLine에 전달. */
  dayAskPeak: AskPeak | null;
```
함수 시그니처 구조분해에 `dayAskPeak` 추가. import: `import LiveAskPeakLine from './LiveAskPeakLine';` + `import type { AskPeak } from '../api/types';`
`<LiveCurrentPriceLine ... />` 바로 다음 줄에 형제로:
```tsx
          <LiveAskPeakLine paneSeries={paneSeries} peak={dayAskPeak} />
```

- [ ] **Step 4: 타입체크 + 기존 테스트 회귀**

Run: `cd frontend && npx tsc -p tsconfig.app.json --noEmit`
Expected: 통과. (LiveChartRoot/LiveWorkarea의 기존 호출부·테스트가 새 필수 prop `dayAskPeak` 누락으로 에러나면 → 그 호출부/테스트에 `dayAskPeak={null}` 추가.)

Run: `cd frontend && npx vitest run src/live/LiveChartRoot src/live/LiveWorkarea src/live/LivePage`
Expected: PASS(회귀 없음).

- [ ] **Step 5: 커밋**

```bash
printf '%s\n' "feat(live): dayAskPeak 배선 — LivePage useDayAskPeak → 차트 마운트" "" "단일 live.ob 재사용. LiveAskPeakLine을 LiveCurrentPriceLine 형제로 마운트." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t10.txt
git add frontend/src/live/LivePage.tsx frontend/src/live/LiveWorkarea.tsx frontend/src/live/LiveChartRoot.tsx
git commit -F /tmp/cm_t10.txt
```

---

## Phase D — 지표 모달 UI

### Task 11: `MAStylePicker` aria-label 일반화(선택적 `label` prop)

**Files:**
- Modify: `frontend/src/live/indicators/MAStylePicker.tsx`
- Test: `frontend/src/live/indicators/MAStylePicker.test.tsx`(기존 — 기본 'MA' 불변 확인 + 신규 label 케이스)

- [ ] **Step 1: 실패 테스트 추가**

`MAStylePicker.test.tsx`에 케이스 추가:
```ts
it('label prop으로 aria 문구 일반화', () => {
  render(<MAStylePicker color="#1D4ED8" lineWidth={2} onChange={() => {}} label="매도벽" />);
  expect(screen.getByRole('button', { name: '매도벽 스타일 선택' })).toBeTruthy();
});
```
(기존 케이스들은 label 미전달 → '`MA 스타일 선택`' 그대로 통과해야 함 = 회귀 가드.)

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/indicators/MAStylePicker.test.tsx`
Expected: FAIL(신규 케이스 — '매도벽 스타일 선택' 못 찾음).

- [ ] **Step 3: 구현**

`Props`에 `label?: string;` 추가. 컴포넌트 본문 시작에 `const lbl = label ?? 'MA';`. aria-label 문자열 3곳을 치환:
- 트리거 `aria-label="MA 스타일 선택"` → `aria-label={`${lbl} 스타일 선택`}`
- 색상 버튼 `aria-label={`MA 색상 ${c}`}` → `` `${lbl} 색상 ${c}` ``
- 굵기 버튼 `aria-label={`MA 굵기 ${w}px`}` → `` `${lbl} 굵기 ${w}px` ``
- (팔레트 dialog `aria-label="MA 스타일 팔레트"`도 `` `${lbl} 스타일 팔레트` ``)

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/indicators/MAStylePicker.test.tsx`
Expected: PASS(기존 + 신규).

- [ ] **Step 5: 커밋**

```bash
printf '%s\n' "refactor(live): MAStylePicker aria-label 선택적 label prop으로 일반화" "" "기본 'MA' — 기존 호출부·테스트 불변. 매도벽 설정에서 재활용 위함." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t11.txt
git add frontend/src/live/indicators/MAStylePicker.tsx frontend/src/live/indicators/MAStylePicker.test.tsx
git commit -F /tmp/cm_t11.txt
```

---

### Task 12: `IndicatorPanel` 사이드메뉴 항목 + `AskPeakConfig` 상세 pane

**Files:**
- Create: `frontend/src/live/indicators/AskPeakConfig.tsx`
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Test: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

- [ ] **Step 1: 실패 테스트 추가**

`IndicatorPanel.test.tsx`에 케이스 추가:
```tsx
it('당일 매도 최대벽 카테고리 토글', () => {
  render(<IndicatorPanel onClose={() => {}} />);
  const cb = screen.getByRole('checkbox', { name: '당일 매도 최대벽' });
  fireEvent.click(cb);
  expect(useLivePageStore.getState().askPeakEnabled).toBe(true);
});
it('매도 최대벽 선택 시 스타일 pane(MAStylePicker) 표시', () => {
  render(<IndicatorPanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '당일 매도 최대벽' }));
  expect(screen.getByRole('button', { name: '매도벽 스타일 선택' })).toBeTruthy();
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/indicators/IndicatorPanel.test.tsx`
Expected: FAIL(카테고리·pane 없음).

- [ ] **Step 3: 구현 — AskPeakConfig.tsx**

```tsx
import { useLivePageStore } from '../../state/livePage';
import MAStylePicker from './MAStylePicker';

/** 당일 매도 최대벽 상세 설정 — 선 색·두께(MAStylePicker 재활용). */
export default function AskPeakConfig() {
  const color = useLivePageStore((s) => s.askPeakColor);
  const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const setStyle = useLivePageStore((s) => s.setAskPeakStyle);
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        당일 매도 최대벽 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        오늘 매도 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 수평선을 그립니다(연속거래 기준).
      </p>
      <div className="flex items-center gap-2">
        <span className="text-sm text-fg">선 스타일</span>
        <MAStylePicker color={color} lineWidth={lineWidth} onChange={setStyle} label="매도벽" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 구현 — IndicatorPanel.tsx**

- `CategoryId` 유니온에 `| 'ask-peak'` 추가.
- `CATEGORIES` 배열에 추가(active 군집): `{ id: 'ask-peak', label: '당일 매도 최대벽', active: true },`
- `checkedFor` switch에 `case 'ask-peak': return askPeakEnabled;`
- `toggleFor` switch에 `case 'ask-peak': return () => setAskPeakEnabled(!askPeakEnabled);`
- 스토어 셀렉터 추가:
  ```ts
  const askPeakEnabled = useLivePageStore((s) => s.askPeakEnabled);
  const setAskPeakEnabled = useLivePageStore((s) => s.setAskPeakEnabled);
  ```
- import: `import AskPeakConfig from './AskPeakConfig';`
- 우측 상세 pane 분기에 추가: `{selected === 'ask-peak' && <AskPeakConfig />}`

- [ ] **Step 5: 통과 + 타입체크**

Run: `cd frontend && npx vitest run src/live/indicators/IndicatorPanel.test.tsx && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS + 타입 OK.

- [ ] **Step 6: 커밋**

```bash
printf '%s\n' "feat(live): 지표 모달에 당일 매도 최대벽 — 사이드메뉴 + 색/두께 pane" "" "AskPeakConfig(MAStylePicker 재활용). 체크박스 on/off + 상세 pane." "" "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > /tmp/cm_t12.txt
git add frontend/src/live/indicators/AskPeakConfig.tsx frontend/src/live/indicators/IndicatorPanel.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -F /tmp/cm_t12.txt
```

---

## 최종 검증 (전체 스위트)

- [ ] **백엔드 전체**

Run: `uv run --extra dev pytest -q`
Expected: PASS(기존 + 신규; 4 skip은 녹화 fixture 게이트).

- [ ] **프론트 전체 + 타입 + 빌드**

Run: `cd frontend && npx vitest run && npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: PASS + 타입 OK + 빌드 그린.

- [ ] **수동 검증(사용자 /live dev)** — 헤드리스로 crosshair/실시간 틱 트리거 불가, 사용자 확인 항목:
  - 장중: 매도 최대벽 선이 호가창 최대 매도단계 가격에 그려지고, 신기록 시 이동·라벨(`12.3만`) 갱신.
  - 오후 새로고침: 오전 최대벽 유지(seed 경로).
  - 마감 동시호가(15:20~): 누적으로 선이 튀지 **않음**(연속거래만).
  - D/W/M 전환 시 선 사라짐, 분봉 복귀 시 재표시.
  - 지표 모달: 당일 매도 최대벽 체크 on/off, 색·두께 변경 즉시 반영 + 새로고침 후 유지.

---

## Spec Coverage 점검(self-review)

| Spec 요구 | Task |
|---|---|
| query_day_ask_peak(연속거래만, 동률 이른시각, HHMMSSmmm 디코드) | T1 |
| AskPeak 모델 + RangeBundle.ask_peak | T2 |
| 오늘-전용 번들 배선(seed) | T3 |
| formatQtyKo 만/억 | T4 |
| 프론트 AskPeak 타입 | T5 |
| 단조 ratchet fold(isContinuousBook 재활용·거래일 리셋·동률·증분) | T6 |
| useDayAskPeak(단일 SSE 구독·code 리셋) | T7 |
| 스토어 토글·색·두께·영속(기본 off/#1D4ED8/2) | T8 |
| LiveAskPeakLine(실선·스토어 스타일·null 숨김) | T9 |
| dayAskPeak 배선·마운트 | T10 |
| MAStylePicker label 일반화 | T11 |
| IndicatorPanel 사이드메뉴 + AskPeakConfig | T12 |
| 단일가 배제 술어 일치(클라/백엔드) | T1(deep_book) + T6(isContinuousBook) — 공유 정의 |
