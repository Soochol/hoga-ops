# 호가비 UNBOUNDED 윈도우 → arg_max 집계 재작성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `query_bucketed_ratio`(hoga/tables/snapshots.py:775)의 윈도우 함수 5개(ROW_NUMBER 1 + MAX OVER 2 + FIRST_VALUE UNBOUNDED 2)를 단일 GROUP BY 집계(arg_max/arg_min/MAX)로 재작성해 정렬·윈도우 머티리얼라이즈 비용을 제거한다. 출력은 기존과 행 단위로 동일해야 한다(차등 테스트 게이트).

**Architecture:** ADR-0085(peak-wall Fenwick 재작성)와 같은 원칙 — "버킷당 대푯값 선택"은 윈도우 정렬이 아니라 집계로 표현한다. 핵심 관찰 3가지: (1) 대표 행 선택 `ROW_NUMBER() ORDER BY is_pre DESC, ts_ms DESC ... WHERE rn=1`은 `arg_max(값, is_pre·10^8 + intra_ms)` 단일 BIGINT 키와 동치다(intra_ms < 86,400,000 < 10^8이라 자릿수 충돌 없음). (2) 완전-동시호가 버킷의 0 방출은 is_pre 게이트된 인자가 전부 0이므로 별도 CASE 없이 자동 성립한다. (3) `imb_max_bid/ask` 쌍은 **같은 행**에서 나와야 하므로 `arg_min(struct_pack(b, a), struct_pack(neg_imb, ts))` 하나로 뽑는다 — 두 개의 독립 arg_max는 동률에서 서로 다른 행을 고를 수 있다.

**검증 전략:** 기존 구현을 `_query_bucketed_ratio_windowed`로 개명해 남겨두고, 신·구 출력을 (a) 기존 단위 픽스처, (b) 신규 합성 픽스처(경매 꼬리·동률·degenerate), (c) 실데이터 전량 차등 스크립트(ADR-0085의 25일 차등과 같은 방식)로 비교한다. 전부 green이면 구 구현을 삭제한다.

**Tech Stack:** Python 3 / DuckDB (arg_max, arg_min, struct_pack) / pytest (`uv run --extra dev pytest`)

---

### Task 1: DuckDB struct 키 arg_min 스파이크 (5분)

arg_min의 정렬 키로 STRUCT를 쓸 수 있는지 이 DuckDB 버전에서 즉석 확인한다. 코드 변경 없음.

- [ ] **Step 1: 스파이크 실행**

```bash
uv run python -c "
import duckdb
con = duckdb.connect()
r = con.execute('''
  SELECT arg_min(struct_pack(b := b, a := a), struct_pack(neg_imb := -imb, ts := ts))
  FROM (VALUES (10, 20, 2.0, 100), (30, 40, 2.0, 50), (5, 5, 1.0, 10)) t(b, a, imb, ts)
''').fetchone()
print(r)  # 기대: ({'b': 30, 'a': 40},) — imb 최대(2.0) 동률 중 ts 최소(50) 행
"
```

Expected: `({'b': 30, 'a': 40},)`

- [ ] **Step 2: 실패 시 폴백**

STRUCT 키가 `Binder Error`로 거부되면 LIST 키로 대체한다(DuckDB 리스트도 사전식 비교 가능): `struct_pack(...)` 대신 `[-imb, ts::DOUBLE]`. 이후 Task의 SQL에서 `struct_pack(neg_imb := ..., ts := ...)` 부분만 동일하게 치환. 둘 다 거부되면 이 플랜을 중단하고 Python 스위프(peak-wall 방식) 재설계로 보고한다.

---

### Task 2: 차등(parity) 테스트 — red 먼저

**Files:**
- Modify: `hoga/tables/snapshots.py:775` (개명), `tests/test_tables_snapshots.py` (테스트 추가)

- [ ] **Step 1: 기존 구현 개명**

`query_bucketed_ratio` → `_query_bucketed_ratio_windowed`로 함수명만 바꾸고, 같은 자리에 새 public 함수 스텁을 둔다(아직 미구현 — red 유도):

```python
def query_bucketed_ratio(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    bucket_ms: int,
    session_close_ms: int | None = None,
) -> list[QuoteRatioRow]:
    raise NotImplementedError  # Task 3에서 arg_max 재작성으로 채운다
```

(기존 docstring은 새 함수로 옮긴다 — 계약은 불변이므로.)

- [ ] **Step 2: parity 테스트 작성**

`tests/test_tables_snapshots.py`에 추가. 이 파일의 기존 스냅샷 픽스처 빌더(파일 상단의 parquet 생성 헬퍼)를 재사용하되, 없다면 아래 자체 빌더를 사용:

```python
def _write_snapshots_parquet(tmp_path, rows):
    """rows: list[dict] — ts_ms(HHMMSSmmm) + ask_q1..10 + bid_q1..10 최소 컬럼.
    기존 픽스처 빌더가 있으면 그것을 사용하고 이 헬퍼는 만들지 않는다."""
    import duckdb, pandas as pd
    df = pd.DataFrame(rows)
    p = tmp_path / "snapshots.parquet"
    duckdb.connect().execute(f"COPY (SELECT * FROM df) TO '{p}' (FORMAT PARQUET)")
    return p


def _snap(ts_ms, ask, bid, deep=True):
    """레벨 4..10 깊이(deep) 존재 여부로 연속거래/동시호가 책을 구분하는 한 행.
    ask/bid는 레벨1 잔량으로 넣고 나머지는 deep 여부에 따라 채운다."""
    row = {"ts_ms": ts_ms}
    for i in range(1, 11):
        row[f"ask_q{i}"] = ask if i == 1 else (1 if (deep and i >= 4) else 0)
        row[f"bid_q{i}"] = bid if i == 1 else (1 if (deep and i >= 4) else 0)
    return row


PARITY_CASES = [
    # (이름, rows, bucket_ms, session_close_ms)
    (
        "혼합 버킷 + 경매 꼬리",
        [
            _snap(90000000, 100, 200),           # 09:00:00.000 연속
            _snap(90000500, 150, 250),           # 같은 버킷, 뒤 ts → 대표
            _snap(90100000, 300, 50),            # 09:01 버킷
            _snap(152000000, 10, 10, deep=False),  # 15:20 동시호가(얕은 책)
            _snap(152100000, 20, 20, deep=False),  # 완전-동시호가 버킷 → 0 방출
        ],
        60_000,
        153000000,
    ),
    (
        "degenerate(한쪽 0) + imb 동률",
        [
            _snap(90000000, 0, 500),    # ask=0 → imb_key 0
            _snap(90000100, 100, 200),  # imb 2.0
            _snap(90000200, 200, 400),  # imb 2.0 동률 → 더 이른 ts(90000100)가 이겨야 함
        ],
        60_000,
        None,
    ),
    ("빈 parquet", [], 60_000, None),
]


@pytest.mark.parametrize("name,rows,bucket_ms,close_ms", PARITY_CASES, ids=[c[0] for c in PARITY_CASES])
def test_bucketed_ratio_argmax_parity(tmp_path, name, rows, bucket_ms, close_ms):
    """arg_max 재작성이 윈도우 구현과 행 단위 동일함을 잠근다 (ADR-0085 차등 방식)."""
    if rows:
        path = _write_snapshots_parquet(tmp_path, rows)
    else:
        # 스키마는 있고 행이 0개인 빈 parquet: WHERE false 로 생성.
        path = _write_snapshots_parquet(tmp_path, [_snap(90000000, 1, 1)])
        import duckdb as _d
        empty = tmp_path / "empty.parquet"
        _d.connect().execute(
            f"COPY (SELECT * FROM read_parquet('{path}') WHERE false) TO '{empty}' (FORMAT PARQUET)"
        )
        path = empty
    con = duckdb.connect()
    old = snapshots._query_bucketed_ratio_windowed(
        con, path=path, bucket_ms=bucket_ms, session_close_ms=close_ms)
    new = snapshots.query_bucketed_ratio(
        con, path=path, bucket_ms=bucket_ms, session_close_ms=close_ms)
    assert new == old
```

주의: 이 파일의 실제 스냅샷 parquet 스키마(컬럼명)는 `_ASK_Q_SUM`/`_BID_Q_SUM` 상수 정의(snapshots.py 상단)를 먼저 읽고 맞출 것 — 위 `ask_q{i}` 네이밍은 그 상수가 참조하는 실제 컬럼명으로 교체해야 한다.

- [ ] **Step 3: red 확인**

Run: `uv run --extra dev pytest tests/test_tables_snapshots.py -k parity -v`
Expected: FAIL — `NotImplementedError`

- [ ] **Step 4: Commit (red 상태 커밋은 하지 않는다 — Task 3과 묶어 커밋)**

---

### Task 3: arg_max GROUP BY 구현

**Files:**
- Modify: `hoga/tables/snapshots.py` (새 `query_bucketed_ratio` 본문)

- [ ] **Step 1: 구현**

Task 2의 스텁 본문을 채운다. `last_continuous_ms` 산출부(기존 라인 813-839)는 그대로 두고 — 이미 선형 스캔 1회다 — 메인 쿼리만 교체:

```python
    rows = con.execute(
        f"""
        WITH scanned AS (
          SELECT ({_ASK_Q_SUM}) AS ask_total,
                 ({_BID_Q_SUM}) AS bid_total,
                 ({pre_auction_pred}) AS is_pre,
                 ({intra_ms_expr}) AS intra_ms,
                 ({intra_ms_expr} // {bucket_ms}) AS bucket
          FROM read_parquet(?)
        ), keyed AS (
          SELECT bucket, is_pre,
                 CASE WHEN is_pre THEN bid_total ELSE 0 END AS g_bid,
                 CASE WHEN is_pre THEN ask_total ELSE 0 END AS g_ask,
                 -- 대표 키: ROW_NUMBER ORDER BY is_pre DESC, ts_ms DESC 와 동일 전순서.
                 -- intra_ms < 86,400,000 < 10^8 → is_pre 자릿수와 충돌 없음.
                 (CASE WHEN is_pre THEN 1 ELSE 0 END)::BIGINT * 100000000 + intra_ms AS rep_key,
                 -- |imbalance| 단조 대용(기존 FIRST_VALUE ORDER BY 식과 동일).
                 CASE WHEN is_pre AND bid_total > 0 AND ask_total > 0
                      THEN GREATEST(ask_total, bid_total) * 1.0 / LEAST(ask_total, bid_total)
                      ELSE 0 END AS imb_key,
                 intra_ms
          FROM scanned
        )
        -- 완전-동시호가 버킷: is_pre 게이트된 인자(g_bid/g_ask)가 전 행 0이므로
        -- 모든 집계가 자동으로 0을 방출한다 — 기존 outer CASE WHEN is_pre 와 동치
        -- (대표 행이 is_pre ⇔ 버킷에 pre 행이 하나라도 존재: 대표 키가 pre 우선이므로).
        SELECT bucket * {bucket_ms},
               arg_max(g_bid, rep_key),
               arg_max(g_ask, rep_key),
               MAX(g_bid),
               MAX(g_ask),
               -- (imb DESC, ts ASC) 승자 행의 (bid, ask) 쌍 — 반드시 한 집계로 뽑는다.
               -- 독립된 arg_max 2개는 imb 동률에서 서로 다른 행을 고를 수 있다.
               arg_min(struct_pack(b := g_bid, a := g_ask),
                       struct_pack(neg_imb := -imb_key, ts := intra_ms)) AS imb_pair
        FROM keyed
        GROUP BY bucket ORDER BY bucket
        """,
        [str(path)],
    ).fetchall()
    return [
        QuoteRatioRow(
            bucket_intra_ms=int(r[0]), bid_total=int(r[1]), ask_total=int(r[2]),
            bid_max=int(r[3]), ask_max=int(r[4]),
            imb_max_bid=int(r[5]["b"]), imb_max_ask=int(r[5]["a"]),
        )
        for r in rows
    ]
```

(Task 1에서 LIST 폴백이 필요했다면 `struct_pack(neg_imb := ..., ts := ...)` → `[-imb_key, intra_ms::DOUBLE]`, 인자 struct는 유지.)

- [ ] **Step 2: parity green 확인**

Run: `uv run --extra dev pytest tests/test_tables_snapshots.py -v`
Expected: PASS (parity 3케이스 + 기존 query_bucketed_ratio 계약 테스트 전부)

- [ ] **Step 3: 소비자 회귀**

Run: `uv run --extra dev pytest tests/unit/api/test_indicator_reaggregate.py tests/unit/api/test_range_indicator_cache_integration.py tests/test_api_range.py -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add hoga/tables/snapshots.py tests/test_tables_snapshots.py
git commit -m "perf(tables): 호가비 버킷 쿼리를 윈도우 5개 → arg_max GROUP BY로 재작성 (parity 게이트)"
```

---

### Task 4: 실데이터 전량 차등 + 성능 실측

**Files:**
- Create: `scripts/diff_bucketed_ratio.py`

- [ ] **Step 1: 차등 스크립트 작성**

```python
"""신·구 query_bucketed_ratio를 로컬 캡처 전량에 대해 행 단위 비교한다.

ADR-0085의 25일 차등과 같은 게이트: 불일치 0건이어야 구 구현을 삭제할 수 있다.
사용: uv run python scripts/diff_bucketed_ratio.py [--bucket-ms 60000]
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import duckdb

from hoga.tables import snapshots


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="data", help="캡처 루트 (date/code/source 레이아웃)")
    ap.add_argument("--bucket-ms", type=int, default=60_000)
    args = ap.parse_args()

    con = duckdb.connect()
    paths = sorted(Path(args.data_dir).glob("**/snapshots.parquet"))
    mismatches = 0
    t_old = t_new = 0.0
    for p in paths:
        t0 = time.perf_counter()
        old = snapshots._query_bucketed_ratio_windowed(con, path=p, bucket_ms=args.bucket_ms)
        t1 = time.perf_counter()
        new = snapshots.query_bucketed_ratio(con, path=p, bucket_ms=args.bucket_ms)
        t2 = time.perf_counter()
        t_old += t1 - t0
        t_new += t2 - t1
        if new != old:
            mismatches += 1
            print(f"MISMATCH {p}")
            for o, n in zip(old, new):
                if o != n:
                    print(f"  old={o}\n  new={n}")
                    break
    print(f"files={len(paths)} mismatches={mismatches} old={t_old:.2f}s new={t_new:.2f}s "
          f"speedup={t_old / t_new if t_new else float('inf'):.2f}x")
    raise SystemExit(1 if mismatches else 0)


if __name__ == "__main__":
    main()
```

주의: 실제 캡처 루트 경로는 `.env` / `engine` 설정에서 확인해 `--data-dir` 기본값을 맞춘다(레포에 하드코딩된 `data/`가 아닐 수 있음 — `hoga/api/queries.py`의 data_dir 해석을 참조). `session_close_ms`는 meta.json에서 읽어야 정확하나, 신·구가 **같은 인자**를 받으므로 None으로도 차등 목적은 충분하다.

- [ ] **Step 2: 차등 실행**

Run: `uv run python scripts/diff_bucketed_ratio.py`
Expected: `mismatches=0` + speedup 수치 확보 (exit 0). 불일치가 나오면 원인 규명 전까지 Task 5 진행 금지.

- [ ] **Step 3: Commit**

```bash
git add scripts/diff_bucketed_ratio.py
git commit -m "test(tables): 호가비 신·구 구현 실데이터 전량 차등 스크립트"
```

---

### Task 5: 구 구현 삭제

- [ ] **Step 1: `_query_bucketed_ratio_windowed` 삭제**

Task 4 차등이 0불일치일 때만. 함수 본문과 이를 참조하는 parity 테스트의 old 측을 삭제하는 대신 — parity 테스트는 **기대값 하드코딩(golden)** 으로 전환한다: 각 케이스의 `old` 결과를 리터럴로 박아 회귀 게이트로 남긴다. `scripts/diff_bucketed_ratio.py`도 함께 삭제(일회성 게이트 완료).

- [ ] **Step 2: 전체 회귀**

Run: `uv run --extra dev pytest -q`
Expected: 신규 실패 0

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(tables): 윈도우 구현 제거 — arg_max 재작성 단독 (차등 0불일치 확인)"
```
