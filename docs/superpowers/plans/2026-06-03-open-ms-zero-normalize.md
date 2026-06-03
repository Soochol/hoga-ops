# hogaplay `open_ms=0` 분류단계 정상화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hogaplay가 `regular_session_open_ms=0`을 보낸 salvageable 31건을, 검사 단계(`check()`)와 read-path 값 변환처(bundle/queries)에서 09:00으로 정상화해 INVALID→COMPLETE로 되살린다(원본 meta 불변).

**Architecture:** `invariants.py`에 순수 헬퍼 `normalize_session_bounds(meta)`를 추가하고 `check()` 진입부에서 호출한다(분류·CLI·archival 자동 일관). read-path 값 변환은 `check()`를 거치지 않으므로 `bundle.py`·`queries.py` 두 변환처에서 같은 헬퍼를 명시 적용한다 — 단 분류는 원본 meta로 수행해 warn 꼬리표가 한 번만 생성되게 한다.

**Tech Stack:** Python 3.12, pytest (`uv run --extra dev pytest`), DuckDB/parquet read-path, Pydantic 모델.

스펙: `docs/superpowers/specs/2026-06-03-open-ms-zero-normalize-design.md`

---

### Task 1: `normalize_session_bounds` 헬퍼 + `check()` 통합

**Files:**
- Modify: `hoga/api/invariants.py` (상단 상수 영역 ~line 79, `check()` line 200-205)
- Test: `tests/hoga/api/test_invariants.py` (기존 파일에 추가)

기존 `check()` 본문:
```python
def check(meta: dict) -> list[Violation]:
    return [v for inv in INVARIANTS if (v := inv.check(meta)) is not None]
```
`_healthy_meta()`(test 상단, `regular_session_open_ms=90_000_000`)와 `Severity`/`Violation`은 이미 존재한다.

- [ ] **Step 1: 실패 테스트 작성**

`tests/hoga/api/test_invariants.py` 끝에 추가:
```python
# --- ADR-0063: open_ms=0 분류단계 정상화 ---

def test_open_ms_zero_normalized_to_0900_no_error() -> None:
    meta = _healthy_meta() | {"regular_session_open_ms": 0}
    violations = check(meta)
    ids = {v.invariant_id for v in violations}
    assert "meta.open_in_kst_range" not in ids       # 09:00으로 정상화되어 통과
    assert "meta.open_ms_normalized" in ids           # 보정 꼬리표 1개
    note = next(v for v in violations if v.invariant_id == "meta.open_ms_normalized")
    assert note.severity is Severity.warn
    assert note.ctx == {"original_open_ms": 0, "normalized_open_ms": 90_000_000}

def test_open_ms_zero_does_not_touch_close() -> None:
    # close=0 은 정상화 대상이 아님 — close invariants 그대로 발화
    meta = _healthy_meta() | {"regular_session_open_ms": 0, "regular_session_close_ms": 0}
    ids = {v.invariant_id for v in check(meta)}
    assert "meta.close_after_open" in ids
    assert "meta.close_in_kst_range" in ids

def test_normalize_session_bounds_does_not_mutate_input() -> None:
    meta = _healthy_meta() | {"regular_session_open_ms": 0}
    patched, notes = normalize_session_bounds(meta)
    assert meta["regular_session_open_ms"] == 0        # 원본 불변
    assert patched["regular_session_open_ms"] == 90_000_000
    assert len(notes) == 1

def test_normalize_noop_when_open_nonzero() -> None:
    meta = _healthy_meta()                              # open=90_000_000
    patched, notes = normalize_session_bounds(meta)
    assert patched is meta                              # 사본 안 만듦
    assert notes == []
```

`tests/hoga/api/test_invariants.py` 상단 import에 `normalize_session_bounds` 추가:
```python
from hoga.api.invariants import check, normalize_session_bounds, Severity  # 기존 import에 합류
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run --extra dev pytest tests/hoga/api/test_invariants.py -k "normalize or open_ms_zero" -v`
Expected: FAIL — `ImportError: cannot import name 'normalize_session_bounds'`

- [ ] **Step 3: 헬퍼 + check() 구현**

`hoga/api/invariants.py`의 인코딩 주석(line 76-79) 바로 아래에 상수와 헬퍼를 추가:
```python
_KRX_REGULAR_OPEN_MS = 90_000_000  # 09:00:00.000 — KRX 정규장 정의상 시가 (ADR-0063)


def normalize_session_bounds(meta: dict) -> tuple[dict, list["Violation"]]:
    """알려진 업스트림 sentinel(``regular_session_open_ms == 0``)을 KRX 표준
    09:00으로 복원한 사본과, 보정이 일어났을 때의 warn violation을 반환한다.

    원본 ``meta``는 변경하지 않는다(원본 불변). ``open != 0``이면 원본을 그대로
    반환한다. ``close_ms``는 의도적으로 손대지 않는다(별도 복합 결함, ADR-0063 §Non-Goals).

    규약: ``regular_session_open_ms``를 *값으로 소비*하기 전(분류 또는 unix 변환)에
    호출한다. 새 변환처를 추가하면 반드시 여기를 통과시킨다.
    """
    if meta.get("regular_session_open_ms") != 0:
        return meta, []
    patched = {**meta, "regular_session_open_ms": _KRX_REGULAR_OPEN_MS}
    note = Violation(
        "meta.open_ms_normalized",
        Severity.warn,
        "upstream sent regular_session_open_ms=0; normalized to KRX 09:00",
        {"original_open_ms": 0, "normalized_open_ms": _KRX_REGULAR_OPEN_MS},
    )
    return patched, [note]
```

`check()`(line 200-205)를 교체:
```python
def check(meta: dict) -> list[Violation]:
    """Run every invariant against ``meta``. Returns the violations list
    (empty when ``meta`` is integral). Order matches ``INVARIANTS`` declaration
    order — callers that care about presentation order should not re-sort.

    ADR-0063: ``regular_session_open_ms == 0`` (알려진 hogaplay 업스트림 결함)은
    invariant 평가 전에 09:00으로 정상화되고, ``meta.open_ms_normalized`` warn이
    선두에 추가된다(warn은 state를 강등하지 않음).
    """
    patched, notes = normalize_session_bounds(meta)
    return notes + [v for inv in INVARIANTS if (v := inv.check(patched)) is not None]
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run --extra dev pytest tests/hoga/api/test_invariants.py -v`
Expected: PASS (신규 4개 + 기존 전부; 기존은 open≠0/close=0만 단정해 영향 없음)

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/invariants.py tests/hoga/api/test_invariants.py
git commit -m "feat(invariants): normalize open_ms=0 to KRX 09:00 in check() (ADR-0063)"
```

---

### Task 2: `classify_from_meta` COMPLETE 전환 회귀 (코드 변경 없음, 테스트만)

`check()` 변경만으로 `classify_from_meta`가 자동으로 COMPLETE를 낸다. 이를 고정한다.

**Files:**
- Test: `tests/test_api_disk_state.py` (기존 파일에 추가)

- [ ] **Step 1: 실패 테스트 작성**

`tests/test_api_disk_state.py`에 추가(상단에 `from hoga.api.disk_state import classify_from_meta, DiskState` 존재 확인; 없으면 추가):
```python
def test_open_ms_zero_classifies_complete_with_warning() -> None:
    meta = {
        "regular_session_open_ms": 0,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
    }
    c = classify_from_meta(meta)
    assert c.state is DiskState.COMPLETE
    assert [v.invariant_id for v in c.warnings] == ["meta.open_ms_normalized"]
    assert c.errors == []

def test_open_ms_zero_but_incomplete_stays_client_incomplete() -> None:
    meta = {
        "regular_session_open_ms": 0,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": False,   # 수집 미완은 정상화로 안 살아남
        "is_partial": False,
    }
    assert classify_from_meta(meta).state is DiskState.CLIENT_INCOMPLETE

def test_close_ms_zero_still_invalid() -> None:
    meta = {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,     # 별도 트랙: 여전히 INVALID
        "collection_complete": True,
        "is_partial": False,
    }
    assert classify_from_meta(meta).state is DiskState.INVALID
```

- [ ] **Step 2: 실패/통과 확인**

Run: `uv run --extra dev pytest tests/test_api_disk_state.py -k "open_ms_zero or close_ms_zero" -v`
Expected: PASS (Task 1이 이미 머지됐으므로 바로 통과; classify는 check() 결과를 그대로 사용). 만약 import 누락이면 FAIL 후 import 추가.

- [ ] **Step 3: 커밋**

```bash
git add tests/test_api_disk_state.py
git commit -m "test(disk_state): open_ms=0→COMPLETE, close=0 stays INVALID (ADR-0063)"
```

---

### Task 3: `bundle.py` 값 변환처 정상화

**Files:**
- Modify: `hoga/api/bundle.py` (line 392-425, 특히 422의 `session_open_ms`)
- Test: `tests/hoga/api/test_bundle.py` (기존 fixture 패턴 사용)

현재(line 392-425) 흐름: `meta = engine.get_meta(...)` → `c = classify_from_meta(meta)` → INVALID면 excluded → 아니면 `session_open_ms=hhmmssms_to_unix_ms(d, meta["regular_session_open_ms"])`.

- [ ] **Step 1: 실패 테스트 작성**

`tests/hoga/api/test_bundle.py`의 기존 엔진/메타 fixture 패턴(같은 파일 상단의 `_make_engine`/meta 생성 헬퍼)을 그대로 사용해, open=0·close=153_000_000·collection_complete=True·is_partial=False·정상 snapshots/candles parquet을 가진 하루를 구성하고:
```python
def test_bundle_open_ms_zero_served_and_normalized(tmp_path) -> None:
    # ... 기존 fixture 헬퍼로 open=0 meta + 정상 parquet 작성 ...
    bundle = build_range_bundle(engine, code=CODE, start=DATE, end=DATE, bucket_ms=...)
    # 1) excluded 되지 않고 segment에 포함
    assert [s.date for s in bundle.segments] == [DATE]
    assert DATE not in [e.date for e in bundle.excluded_dates]
    # 2) session_open_ms 는 09:00 unix (0 아님)
    seg = bundle.segments[0]
    assert seg.session_open_ms == hhmmssms_to_unix_ms(DATE, 90_000_000)
    assert seg.session_open_ms != hhmmssms_to_unix_ms(DATE, 0)
    # 3) 보정 꼬리표가 data_warnings 에 정확히 1개
    warns = [w for w in bundle.data_warnings if w.date == DATE]
    assert any(v.invariant_id == "meta.open_ms_normalized"
               for w in warns for v in w.warnings)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run --extra dev pytest tests/hoga/api/test_bundle.py -k "open_ms_zero" -v`
Expected: FAIL — `session_open_ms`가 `hhmmssms_to_unix_ms(DATE, 0)`(자정 기준)이라 단정 불일치

- [ ] **Step 3: 구현**

`hoga/api/bundle.py` 상단 import에 추가(기존 `from hoga.api.disk_state import classify_from_meta, DiskState` 인근):
```python
from hoga.api.invariants import normalize_session_bounds
```
line 420-425의 `RangeSegment` 생성 직전/내부를 수정 — 분류는 원본 `meta`로 유지하고(꼬리표는 classify가 생성), 변환만 정상화된 값을 사용:
```python
        norm_meta, _ = normalize_session_bounds(meta)   # 값 변환용 (notes는 classify가 처리)
        segments.append(RangeSegment(
            date=d,
            session_open_ms=hhmmssms_to_unix_ms(d, norm_meta["regular_session_open_ms"]),
            session_close_ms=hhmmssms_to_unix_ms(d, meta["regular_session_close_ms"]),
            source=source,
        ))
```
(line 398의 `c = classify_from_meta(meta)`는 **원본 meta 그대로** 둔다 — 이것이 warn 꼬리표를 만든다.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run --extra dev pytest tests/hoga/api/test_bundle.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/bundle.py tests/hoga/api/test_bundle.py
git commit -m "feat(bundle): normalize open_ms=0 in session_open_ms conversion (ADR-0063)"
```

---

### Task 4: `queries.py` 값 변환처 정상화

**Files:**
- Modify: `hoga/api/queries.py` (line 184-238, 특히 194의 `open_ms`)
- Test: `tests/test_api_stock_dates.py` (기존 fixture 패턴 사용)

현재(line 184-238): `meta = json.loads(...)` → `_state = classify_from_meta(meta).state` → `open_ms = hhmmssms_to_unix_ms(date, meta["regular_session_open_ms"])` → `StockDate(..., regular_session_open_ms=open_ms, ..., disk_state=_state.value)`.

- [ ] **Step 1: 실패 테스트 작성**

`tests/test_api_stock_dates.py`의 기존 fixture 패턴으로 open=0·정상 수집 Stock-Date를 만들고:
```python
def test_stock_date_open_ms_zero_normalized_and_complete(tmp_path) -> None:
    # ... 기존 헬퍼로 open=0 meta + parquet 작성 ...
    sd = engine.get_stock_date(code=CODE, date=DATE)   # 또는 inventory 조회 경로
    assert sd.regular_session_open_ms == hhmmssms_to_unix_ms(DATE, 90_000_000)
    assert sd.regular_session_open_ms != hhmmssms_to_unix_ms(DATE, 0)
    assert sd.disk_state == "complete"
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/test_api_stock_dates.py -k "open_ms_zero" -v`
Expected: FAIL — `regular_session_open_ms`가 자정 기준 변환값

- [ ] **Step 3: 구현**

`hoga/api/queries.py` 상단 import에 `from hoga.api.invariants import normalize_session_bounds` 추가(기존 `classify_from_meta` import 인근). line 184-194를 수정 — 분류는 원본 `meta`로, 변환만 정상화:
```python
        meta = json.loads((code_dir / "meta.json").read_text(encoding="utf-8"))
        _state = classify_from_meta(meta).state          # 원본으로 분류 (꼬리표 생성 경로)
        norm_meta, _ = normalize_session_bounds(meta)    # 값 변환용
        snap_path = code_dir / "snapshots.parquet"
        bounds = (
            snapshots.query_time_bounds(self.conn, path=snap_path)
            if snap_path.exists()
            else None
        )
        open_ms = hhmmssms_to_unix_ms(date, norm_meta["regular_session_open_ms"])
        close_ms = hhmmssms_to_unix_ms(date, meta["regular_session_close_ms"])
```
(close_ms·이하 로직은 그대로.)

- [ ] **Step 4: 통과 확인**

Run: `uv run --extra dev pytest tests/test_api_stock_dates.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/queries.py tests/test_api_stock_dates.py
git commit -m "feat(queries): normalize open_ms=0 in StockDate open_ms (ADR-0063)"
```

---

### Task 5: 기존 테스트 reconcile (회귀 청소)

`check()`는 공유 술어라 `open=0`을 INVALID/error로 단정하던 기존 테스트가 있으면 깨진다. 전수 grep으로 확정하고 갱신한다.

**Files:**
- Modify: grep으로 발견되는 테스트 파일들

- [ ] **Step 1: 영향 테스트 grep**

Run:
```bash
grep -rn "regular_session_open_ms.*: *0\|regular_session_open_ms.*=.*0\b" tests/ | grep -v "90000000\|90_000_000\|153000000"
grep -rln "open_in_kst_range" tests/
```
`open=0`을 fixture로 쓰면서 결과를 `INVALID`/`open_in_kst_range` error로 단정하는 케이스만 추린다(0이 아닌 범위밖 값·close=0 케이스는 영향 없음 — 그대로 둔다).

- [ ] **Step 2: 전체 백엔드 테스트 실행으로 red 확인**

Run: `uv run --extra dev pytest tests/ -q`
Expected: Task 1-4 반영 후 red인 테스트가 있다면 그것이 reconcile 대상(이 변경이 의도한 동작 전환). 0건이면 Step 4로.

- [ ] **Step 3: 각 red 테스트 갱신**

해당 테스트가 `open=0`을 가정했다면, 기대를 새 동작으로 바꾼다 — INVALID/`open_in_kst_range` 대신 COMPLETE + `meta.open_ms_normalized` warn. (실제 fixture를 그대로 두고 assert만 갱신.) 만약 open=0이 "비정상이어야 한다"는 의도였던 테스트라면, 0이 아닌 범위밖 값(예: `39_999_999`)으로 fixture를 바꿔 원 의도를 보존한다.

- [ ] **Step 4: 전체 green 확인 + 커밋**

Run: `uv run --extra dev pytest tests/ -q`
Expected: PASS (전체)
```bash
git add tests/
git commit -m "test: reconcile open=0 expectations to normalized behavior (ADR-0063)"
```

---

### Task 6: 실 디스크 회귀 검증 (002380/2026-06-02) + 수동 확인

**Files:**
- 없음 (검증 스크립트만; 자동 테스트는 합성 fixture로 Task 1-4가 커버)

- [ ] **Step 1: check_disk_state 재실행**

Run:
```bash
.venv/bin/python3 -c "
from hoga.config import resolve_data_dir
from hoga.api.disk_state import check_disk_state
c = check_disk_state(resolve_data_dir(), '002380', '20260602')
print(c.state, [v.invariant_id for v in c.warnings])
"
```
Expected: `DiskState.COMPLETE ['meta.open_ms_normalized']`

- [ ] **Step 2: 2026-03-18 묶음 표본 확인**

Run: 같은 스크립트로 `('003490','20260318')` 등 2-3개 → 모두 `DiskState.COMPLETE`. (002380/20260318은 collection_complete=False라 CLIENT_INCOMPLETE 유지 — 정상.)

- [ ] **Step 3: read-path 수동 확인**

서버 기동 후 `/replay` 또는 inventory calendar에서 002380/2026-06-02가 더 이상 제외되지 않고 표시되며, calendar 셀이 `complete`인지 확인(스펙 Manual verification 참조).

---

### Task 7: ADR-0063 작성 + 스펙 상태 갱신

**Files:**
- Create: `docs/adr/0063-open-ms-zero-classification-normalize.md`
- Modify: `docs/superpowers/specs/2026-06-03-open-ms-zero-normalize-design.md` (Status: Draft → Approved)

- [ ] **Step 1: ADR 작성**

`docs/adr/0063-open-ms-zero-classification-normalize.md` 생성(기존 ADR 형식 따름):
```markdown
# ADR-0063: hogaplay open_ms=0 분류단계 정상화

## Status
Accepted (2026-06-03)

## Context
hogaplay가 특정 거래일 전체에 대해 info.tsv의 regular_session_open_ms를 0으로
내려보낸다(close는 정상). open=0은 meta.open_in_kst_range(error)를 발화시켜 source를
INVALID로 만들고 read-path에서 그 날짜를 제외한다. 그러나 수집·밀도는 정상인 경우가
대부분(스캔: open=0 32건 중 31건 salvageable)이라 데이터가 낭비된다. close=0(129건)은
collection_complete=False/is_partial=True 복합 결함으로 별개 트랙이다.

## Decision
검사 규칙 단일 출처인 invariants.check() 진입부에서 regular_session_open_ms==0을
KRX 표준 09:00(90_000_000)으로 정상화한 사본으로 invariant를 평가하고,
meta.open_ms_normalized(warn) 꼬리표를 추가한다. 원본 meta.json은 불변.
read-path 값 변환처(bundle.py, queries.py)는 check()를 거치지 않으므로 같은
normalize_session_bounds 헬퍼를 변환 직전에 명시 적용한다. 분류는 원본 meta로
수행해 꼬리표가 한 번만 생성되게 한다. close_ms는 손대지 않는다.

## Consequences
- salvageable 31건 + 미래 발생분이 재파싱 없이 COMPLETE로 분류된다.
- check() 경유 모든 소비자(eligibility/fail_streak/watchlist/calendar)가 일관 전환된다.
- 09:00은 KRX 정규장 정의상 상수이므로 추측이 아닌 복원이다. 0이 아닌 범위밖 값은
  여전히 INVALID로 정확히 탐지된다.
- inventory StockDate row는 warn 필드가 없어 꼬리표 미노출(disk_state는 complete로 전환).
- close_ms=0 129건은 미해결 — 별도 재캡처 트랙(후속 ADR).
```

- [ ] **Step 2: 스펙 Status 갱신**

`docs/superpowers/specs/2026-06-03-open-ms-zero-normalize-design.md`의 `**Status**: Draft`를 `**Status**: Approved`로 변경.

- [ ] **Step 3: 커밋**

```bash
git add docs/adr/0063-open-ms-zero-classification-normalize.md docs/superpowers/specs/2026-06-03-open-ms-zero-normalize-design.md
git commit -m "docs(adr): ADR-0063 open_ms=0 classification normalize"
```

---

## 완료 기준

- `uv run --extra dev pytest tests/ -q` 전체 green.
- 002380/2026-06-02 `check_disk_state` == COMPLETE (warn: meta.open_ms_normalized).
- close=0 129건은 INVALID 유지(회귀로 고정).
- ADR-0063 + 스펙 Approved 커밋.
