# 스크리너 조건 분류 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 거래대금을 평균가×거래량으로 통일하고, 조건 3종(기간내 거래대금=임계값, 당일 신고가/신고거래량=돌파)을 추가하고, 기존 신고가/신고거래량을 "기간내"로 리네이밍하고, "새로 저장 ＋"가 빌더를 비우도록 고친다.

**Architecture:** 레지스트리 기반 조건 — 백엔드 `CONDITION_COMPILERS`에 컴파일러를 가산 등록(`run_scan` 코어 무수정), 프론트 `CONDITION_CATALOG`에 항목 가산. 당일 돌파는 기존 `_breakout_cte`를 `lookback=1`로 재사용(SQL 무복제). Pydantic ⇄ TS 2언어 손수 미러(ADR-0004), `type` 키 byte 일치.

**Tech Stack:** Python(FastAPI/Pydantic/DuckDB, pytest) · TypeScript/React(vitest/@testing-library)

**참조:** spec `docs/superpowers/specs/2026-06-01-screener-condition-taxonomy-design.md`, ADR-0055, `CONTEXT.md`(Breakout/Condition/거래대금).

**게이트:** 백엔드 `uv run --extra dev pytest tests/api/test_screener_scan.py -q`, 프론트 `cd frontend && npx vitest run` + `npx tsc -b`. eslint는 변경 파일만.

---

## Task 1: 거래대금 산식 통일 — 평균가×거래량

**Files:**
- Modify: `hoga/api/screener_scan.py` (`_WON_PER_EOK` 근처, `base` CTE, `_compile_trade_value`, 최종 SELECT)
- Test: `tests/api/test_screener_scan.py`

- [ ] **Step 1: 실패 테스트 추가**

`tests/api/test_screener_scan.py` 끝에 추가:
```python
def test_trade_value_uses_ohlc_average_price(tmp_path):
    # close*volume = 1억(<2) 이지만 avg(OHLC)*volume = 2.5억(>=2). 새 산식이
    # 임계값 매칭과 표시 trade_value_won 둘 다를 구동해야 한다.
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-30", 300, 300, 300, 100, 1_000_000)],
        stocks=[("005930", "삼성", "KOSPI", False, False)])
    leaf = TradeValueLeaf(id="t", params=TradeValueParams(min_eok=2))
    rows = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["005930"]
    assert rows[0].trade_value_won == 250_000_000
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py::test_trade_value_uses_ohlc_average_price -q`
Expected: FAIL — 현재 `close*volume`=1억 < 2억이라 행이 0개 (`assert [] == ["005930"]`).

- [ ] **Step 3: `_TV` 상수 + base CTE 확장**

`hoga/api/screener_scan.py`에서 `_WON_PER_EOK = 100_000_000` 바로 아래에 추가:
```python
# 거래대금 = 평균가(OHLC/4) × 거래량. 코퍼스에 거래대금 컬럼이 없어 매일 산출(ADR-0055/CONTEXT).
# trade_value·trade_value_period·결과표가 공유하는 단일 식(드리프트 방지).
_TV = "((open+high+low+close)/4.0)*volume"
```

`base` CTE에 `open, low` 추가 — 다음을:
```python
    ctes = ["base AS (SELECT DISTINCT ON (code) code, date, high, close, volume, "
            "LAG(close) OVER (PARTITION BY code ORDER BY date) AS prev_close "
            "FROM adj ORDER BY code, date DESC)"]
```
이렇게 변경:
```python
    ctes = ["base AS (SELECT DISTINCT ON (code) code, date, open, high, low, close, volume, "
            "LAG(close) OVER (PARTITION BY code ORDER BY date) AS prev_close "
            "FROM adj ORDER BY code, date DESC)"]
```

- [ ] **Step 4: `_compile_trade_value` + 최종 SELECT 산식 교체**

`_compile_trade_value`를:
```python
def _compile_trade_value(leaf, i):
    return f"cond_{i} AS (SELECT code FROM base WHERE close*volume >= ?)", [int(leaf.params.min_eok * _WON_PER_EOK)]
```
이렇게:
```python
def _compile_trade_value(leaf, i):
    return f"cond_{i} AS (SELECT code FROM base WHERE {_TV} >= ?)", [int(leaf.params.min_eok * _WON_PER_EOK)]
```

최종 SELECT의 `sel`에서:
```python
           "(base.close*base.volume)::BIGINT trade_value_won, "
```
이렇게(컬럼은 base에만 존재 → 미한정 `_TV` 안전):
```python
           f"({_TV})::BIGINT trade_value_won, "
```
주의: `sel` 문자열 전체가 f-string이 되도록 해당 인접 리터럴 조각에 `f` 접두를 붙인다(이미 다른 조각은 일반 문자열 — `_TV` 보간 줄만 f-string).

- [ ] **Step 5: 통과 확인 + 기존 거래대금 테스트 회귀 없음**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py -q`
Expected: PASS — 신규 테스트 통과. `test_trade_value_filters_latest_day`는 OHLC가 모두 100이라 avg=close → 600_000_000 그대로 통과.

- [ ] **Step 6: 커밋**

```bash
git add hoga/api/screener_scan.py tests/api/test_screener_scan.py
git commit -m "feat(screener): 거래대금을 평균가(OHLC/4)×거래량으로 통일 (_TV 공용식)"
```

---

## Task 2: 기간내 거래대금 — 임계값-over-lookback 조건

**Files:**
- Modify: `hoga/api/models.py` (param/leaf 클래스 + `ConditionLeaf` union)
- Modify: `hoga/api/screener_scan.py` (컴파일러 + 레지스트리)
- Test: `tests/api/test_screener_scan.py`

- [ ] **Step 1: 실패 테스트 추가**

`tests/api/test_screener_scan.py` 끝에 추가:
```python
from hoga.api.models import TradeValuePeriodLeaf, TradeValuePeriodParams

def test_trade_value_period_threshold_within_lookback(tmp_path):
    # 005930: 3억 날이 2거래일 전(lookback 3 안) → 매치.
    # 000660: 유일한 3억 날이 5거래일 전(lookback 3 밖) → 미스. OHLC 평탄(avg=close).
    rows = [("005930","2026-05-26",100,100,100,100,1_000_000),
            ("005930","2026-05-27",100,100,100,100,3_000_000),   # 3억, 2일 전(rn=3)
            ("005930","2026-05-28",100,100,100,100,1_000_000),
            ("005930","2026-05-29",100,100,100,100,1_000_000),
            ("000660","2026-05-25",100,100,100,100,3_000_000),   # 3억, 5일 전(rn=5)
            ("000660","2026-05-26",100,100,100,100,1_000_000),
            ("000660","2026-05-27",100,100,100,100,1_000_000),
            ("000660","2026-05-28",100,100,100,100,1_000_000),
            ("000660","2026-05-29",100,100,100,100,1_000_000)]
    adj, stk = _seed(tmp_path, rows=rows,
        stocks=[("005930","a","KOSPI",False,False),("000660","b","KOSPI",False,False)])
    leaf = TradeValuePeriodLeaf(id="tp", params=TradeValuePeriodParams(lookback=3, min_eok=3))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["005930"]

def test_trade_value_period_short_history_eligible(tmp_path):
    # 임계값 가족은 wc 가드 없음 — 상장 2일짜리도 보유일 중 도달하면 매치.
    rows = [("000111","2026-05-28",100,100,100,100,1_000_000),
            ("000111","2026-05-29",100,100,100,100,3_000_000)]
    adj, stk = _seed(tmp_path, rows=rows, stocks=[("000111","a","KOSPI",False,False)])
    leaf = TradeValuePeriodLeaf(id="tp", params=TradeValuePeriodParams(lookback=60, min_eok=3))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000111"]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py -k trade_value_period -q`
Expected: FAIL — `ImportError: cannot import name 'TradeValuePeriodLeaf'`.

- [ ] **Step 3: 모델 추가**

`hoga/api/models.py`에서 `class TradeValueParams` 바로 아래에 추가:
```python
class TradeValuePeriodParams(BaseModel):                # 최근 N거래일 중 하루라도 거래대금 ≥ min_eok억
    lookback: int = Field(ge=1)
    min_eok: float = Field(ge=0)
```
`class TradeValueLeaf` 바로 아래에 추가:
```python
class TradeValuePeriodLeaf(BaseModel):
    type: Literal["trade_value_period"] = "trade_value_period"
    id: str
    params: TradeValuePeriodParams
```
`ConditionLeaf` union에 변형 추가 — 다음을:
```python
ConditionLeaf = Annotated[
    Union[TradeValueLeaf, NewHighLeaf, NewHighVolLeaf, ChangePctLeaf, PriceRangeLeaf, MaLeaf],
    Field(discriminator="type"),
]
```
이렇게:
```python
ConditionLeaf = Annotated[
    Union[TradeValueLeaf, TradeValuePeriodLeaf, NewHighLeaf, NewHighVolLeaf,
          ChangePctLeaf, PriceRangeLeaf, MaLeaf],
    Field(discriminator="type"),
]
```

- [ ] **Step 4: 컴파일러 + 레지스트리 등록**

`hoga/api/screener_scan.py`의 `_compile_trade_value` 바로 아래에 추가:
```python
def _compile_trade_value_period(leaf, i):
    # 돌파 아님 — 최근 N거래일 중 하루라도 거래대금이 임계값 도달. wc 가드 없음.
    n = leaf.params.lookback
    return (f"cond_{i} AS (SELECT DISTINCT code FROM ("
            f"SELECT code, {_TV} AS tv, "
            f"ROW_NUMBER() OVER (PARTITION BY code ORDER BY date DESC) rn FROM adj) t "
            f"WHERE rn <= {n} AND tv >= ?)",
            [int(leaf.params.min_eok * _WON_PER_EOK)])
```
`CONDITION_COMPILERS` 딕셔너리에 `"trade_value"` 줄 아래로 추가:
```python
    "trade_value_period": _compile_trade_value_period,
```

- [ ] **Step 5: 통과 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py -k trade_value_period -q`
Expected: PASS (2 passed).

- [ ] **Step 6: 커밋**

```bash
git add hoga/api/models.py hoga/api/screener_scan.py tests/api/test_screener_scan.py
git commit -m "feat(screener): 기간내 거래대금(trade_value_period) — 임계값-over-lookback"
```

---

## Task 3: 당일 신고가/신고거래량 — breakout(lookback=1) 재사용

**Files:**
- Modify: `hoga/api/models.py` (`PeriodParams` + leaf 2종 + union)
- Modify: `hoga/api/screener_scan.py` (`_breakout_today` + 레지스트리 2줄)
- Test: `tests/api/test_screener_scan.py`

- [ ] **Step 1: 실패 테스트 추가 (핵심 발산 + 가드 + 거래량 + 동치)**

`tests/api/test_screener_scan.py` 끝에 추가:
```python
from hoga.api.models import NewHighTodayLeaf, NewHighVolTodayLeaf, PeriodParams

def test_new_high_today_vs_period_divergence(tmp_path):
    # A(000111): 최신일까지 상승 → 오늘이 5일 신고가.
    # B(000222): 5일 신고가를 day5에 찍고 이후 하락 → 오늘은 신고가 아님, 그러나
    #            최근 5일 내 돌파 이력은 있음. 당일/기간내가 갈려야 신규 타입이 진짜 다름.
    a = [("000111", f"2026-04-{d:02d}", 0, 100+d, 0, 100+d, 1) for d in range(1, 9)]   # 고가 101..108
    bh = [100, 101, 102, 103, 104, 103, 102, 101]                                       # day5=104 peak
    b = [("000222", f"2026-04-{d:02d}", 0, h, 0, h, 1) for d, h in zip(range(1, 9), bh)]
    adj, stk = _seed(tmp_path, rows=a + b,
        stocks=[("000111","a","KOSPI",False,False),("000222","b","KOSPI",False,False)])
    today = NewHighTodayLeaf(id="t", params=PeriodParams(period=5))
    period = NewHighLeaf(id="p", params=BreakoutParams(lookback=5, period=5))
    out_today = screener_scan.run_scan(adj, stk, conditions=[today], universe=ScreenerUniverse())
    out_period = screener_scan.run_scan(adj, stk, conditions=[period], universe=ScreenerUniverse())
    assert [r.code for r in out_today] == ["000111"]                       # 당일: 오늘 신고만
    assert sorted(r.code for r in out_period) == ["000111", "000222"]      # 기간내: 둘 다

def test_new_high_today_wc_window_guard(tmp_path):
    # period=5: 상장 3일 종목은 wc=5 불충족 → 제외; 6일 상승 종목은 오늘이 신고 → 포함.
    short = [("000111", f"2026-05-{d:02d}", 0, 100+d, 0, 100+d, 1) for d in range(10, 13)]
    full = [("000222", f"2026-05-{d:02d}", 0, 100+d, 0, 100+d, 1) for d in range(10, 16)]
    adj, stk = _seed(tmp_path, rows=short + full,
        stocks=[("000111","a","KOSPI",False,False),("000222","b","KOSPI",False,False)])
    leaf = NewHighTodayLeaf(id="g", params=PeriodParams(period=5))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000222"]

def test_new_high_vol_today_latest_is_volume_peak(tmp_path):
    # A: 거래량이 오늘 최고; B: 거래량이 과거에 최고, 오늘은 최저.
    a = [("000111", f"2026-05-{d:02d}", 0, 1, 0, 1, vol) for d, vol in zip(range(10, 14), [10, 20, 30, 40])]
    b = [("000222", f"2026-05-{d:02d}", 0, 1, 0, 1, vol) for d, vol in zip(range(10, 14), [40, 30, 20, 10])]
    adj, stk = _seed(tmp_path, rows=a + b,
        stocks=[("000111","a","KOSPI",False,False),("000222","b","KOSPI",False,False)])
    leaf = NewHighVolTodayLeaf(id="v", params=PeriodParams(period=4))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000111"]

def test_new_high_today_equals_breakout_lookback1(tmp_path):
    # 동치 보증: new_high_today(P) == new_high(lookback=1, period=P).
    hs = [100, 105, 103, 108, 107, 110, 109, 112]
    rows = [("000111", f"2026-05-{d:02d}", 0, h, 0, h, 1) for d, h in zip(range(10, 18), hs)]
    adj, stk = _seed(tmp_path, rows=rows, stocks=[("000111","a","KOSPI",False,False)])
    today = screener_scan.run_scan(adj, stk,
        conditions=[NewHighTodayLeaf(id="t", params=PeriodParams(period=5))], universe=ScreenerUniverse())
    bk1 = screener_scan.run_scan(adj, stk,
        conditions=[NewHighLeaf(id="b", params=BreakoutParams(lookback=1, period=5))], universe=ScreenerUniverse())
    assert [r.code for r in today] == [r.code for r in bk1]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py -k new_high_today -q`
Expected: FAIL — `ImportError: cannot import name 'NewHighTodayLeaf'`.

- [ ] **Step 3: 모델 추가**

`hoga/api/models.py`에서 `class BreakoutParams` 바로 아래에 추가:
```python
class PeriodParams(BaseModel):                         # 당일 신고가/신고거래량 — 단일 윈도우
    period: int = Field(ge=1)
```
`class NewHighVolLeaf` 바로 아래에 추가:
```python
class NewHighTodayLeaf(BaseModel):
    type: Literal["new_high_today"] = "new_high_today"
    id: str
    params: PeriodParams

class NewHighVolTodayLeaf(BaseModel):
    type: Literal["new_high_vol_today"] = "new_high_vol_today"
    id: str
    params: PeriodParams
```
`ConditionLeaf` union에 두 변형 추가(Task 2에서 갱신한 union을 기준으로):
```python
ConditionLeaf = Annotated[
    Union[TradeValueLeaf, TradeValuePeriodLeaf, NewHighTodayLeaf, NewHighLeaf,
          NewHighVolTodayLeaf, NewHighVolLeaf, ChangePctLeaf, PriceRangeLeaf, MaLeaf],
    Field(discriminator="type"),
]
```

- [ ] **Step 4: 컴파일러 + 레지스트리 등록**

`hoga/api/screener_scan.py`의 `_breakout` 함수 바로 아래에 추가:
```python
def _breakout_today(col: str) -> LeafCompiler:
    # 당일 = Lookback Window N=1. 기존 _breakout_cte 재사용(VERBATIM 준수, SQL 무복제).
    return lambda leaf, i: (
        _breakout_cte(f"cond_{i}", col, BreakoutParams(lookback=1, period=leaf.params.period)), [])
```
`_breakout`의 주석 `# registry guarantees only new_high/new_high_vol leaves reach here ...`를:
```python
    # registry guarantees only new_high/new_high_vol/new_high_*_today leaves reach _breakout_cte
```
로 갱신. `CONDITION_COMPILERS`에 추가(각 기간내 줄 아래):
```python
    "new_high_today": _breakout_today("high"),
    "new_high_vol_today": _breakout_today("volume"),
```

- [ ] **Step 5: 통과 확인 + 전체 스캔 스위트**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py -q`
Expected: PASS (전부).

- [ ] **Step 6: 커밋**

```bash
git add hoga/api/models.py hoga/api/screener_scan.py tests/api/test_screener_scan.py
git commit -m "feat(screener): 당일 신고가/신고거래량 — _breakout_cte(lookback=1) 재사용"
```

---

## Task 4: 모델 라운드트립 + 하위호환

**Files:**
- Test: `tests/api/test_screener_models.py`

- [ ] **Step 1: 실패 테스트 추가**

`tests/api/test_screener_models.py` 끝에 추가:
```python
def test_new_today_and_period_leaves_roundtrip():
    nt = _A.validate_python({"id": "x", "type": "new_high_today", "params": {"period": 200}})
    assert nt.type == "new_high_today" and nt.params.period == 200
    tv = _A.validate_python({"id": "y", "type": "trade_value_period", "params": {"lookback": 60, "min_eok": 1000}})
    assert tv.type == "trade_value_period" and tv.params.min_eok == 1000

def test_period_params_reject_below_one():
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "new_high_today", "params": {"period": 0}})
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "y", "type": "trade_value_period", "params": {"lookback": 0, "min_eok": 1}})

def test_existing_new_high_still_parses_backcompat():
    # 디스크 saves.json의 기존 new_high 형태(타입 불변)가 여전히 유효 — 마이그레이션 0.
    leaf = _A.validate_python({"id": "old", "type": "new_high", "params": {"lookback": 500, "period": 250}})
    assert leaf.type == "new_high" and leaf.params.period == 250
```

- [ ] **Step 2: 실패→통과 확인**

Run: `uv run --extra dev pytest tests/api/test_screener_models.py -q`
Expected: PASS — Task 2·3에서 모델을 이미 추가했으므로 통과(타입 이름 오타가 있으면 여기서 잡힘). 만약 미구현 상태로 먼저 실행했다면 FAIL.

- [ ] **Step 3: 라우트/저장 라운드트립 확인 (기존 스위트 회귀 없음)**

Run: `uv run --extra dev pytest tests/api/test_screener_routes.py tests/api/test_screener_saves.py -q`
Expected: PASS — 라우트는 `ConditionLeaf` union을 그대로 받으므로 신규 타입 자동 수용.

- [ ] **Step 4: 커밋**

```bash
git add tests/api/test_screener_models.py
git commit -m "test(screener): 신규 조건 타입 라운드트립 + new_high 하위호환"
```

---

## Task 5: 프론트 타입 + 파라미터 폼

**Files:**
- Modify: `frontend/src/api/screener.ts:4-19`
- Modify: `frontend/src/screener/paramForms.tsx:1-3` (import), 끝에 폼 2종 추가

- [ ] **Step 1: TS 타입 추가**

`frontend/src/api/screener.ts`에서 `export interface BreakoutParams { lookback: number; period: number }` 아래에 추가:
```ts
export interface PeriodParams { period: number }
export interface TradeValuePeriodParams { lookback: number; min_eok: number }
```
`ConditionLeaf` union에 변형 3개 추가 — 다음을:
```ts
export type ConditionLeaf =
  | { id: string; type: 'trade_value'; params: TradeValueParams }
  | { id: string; type: 'new_high'; params: BreakoutParams }
  | { id: string; type: 'new_high_vol'; params: BreakoutParams }
  | { id: string; type: 'change_pct'; params: ChangePctParams }
  | { id: string; type: 'price_range'; params: PriceRangeParams }
  | { id: string; type: 'ma'; params: MaParams };
```
이렇게:
```ts
export type ConditionLeaf =
  | { id: string; type: 'trade_value'; params: TradeValueParams }
  | { id: string; type: 'trade_value_period'; params: TradeValuePeriodParams }
  | { id: string; type: 'new_high_today'; params: PeriodParams }
  | { id: string; type: 'new_high'; params: BreakoutParams }
  | { id: string; type: 'new_high_vol_today'; params: PeriodParams }
  | { id: string; type: 'new_high_vol'; params: BreakoutParams }
  | { id: string; type: 'change_pct'; params: ChangePctParams }
  | { id: string; type: 'price_range'; params: PriceRangeParams }
  | { id: string; type: 'ma'; params: MaParams };
```

- [ ] **Step 2: 폼 import 갱신**

`frontend/src/screener/paramForms.tsx`의 import를:
```ts
import type {
  TradeValueParams, BreakoutParams, ChangePctParams, PriceRangeParams, MaParams,
} from '../api/screener';
```
이렇게:
```ts
import type {
  TradeValueParams, BreakoutParams, ChangePctParams, PriceRangeParams, MaParams,
  PeriodParams, TradeValuePeriodParams,
} from '../api/screener';
```

- [ ] **Step 3: 폼 2종 추가**

`paramForms.tsx` 끝(파일 마지막 `}` 다음)에 추가:
```tsx
export function PeriodForm({ params, onChange }: { params: PeriodParams; onChange: (p: PeriodParams) => void }) {
  return <div className="flex items-center gap-2">
    <Num label="period (M)" value={params.period} onChange={(n) => onChange({ period: n ?? 1 })} />
    <span className="text-sm text-fg-dimmer">일</span></div>;
}
export function TradeValuePeriodForm({ params, onChange }: { params: TradeValuePeriodParams; onChange: (p: TradeValuePeriodParams) => void }) {
  return <div className="flex items-center gap-2 flex-wrap">
    <Num label="lookback (N)" value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
    <span className="text-fg-dimmer">일내 ≥</span>
    <Num label="min_eok" value={params.min_eok} onChange={(n) => onChange({ ...params, min_eok: n ?? 0 })} />
    <span className="text-sm text-fg-dimmer">억</span></div>;
}
```

- [ ] **Step 4: 타입체크**

Run: `cd frontend && npx tsc -b`
Expected: PASS (카탈로그가 아직 신규 타입을 안 쓰므로 union 추가만으로 에러 없음).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/api/screener.ts frontend/src/screener/paramForms.tsx
git commit -m "feat(screener-fe): PeriodParams/TradeValuePeriodParams 타입 + 폼 2종"
```

---

## Task 6: 카탈로그 항목·라벨 + 깨지는 테스트 갱신

**Files:**
- Modify: `frontend/src/screener/catalog.tsx`
- Modify: `frontend/src/screener/catalog.test.tsx`
- Modify: `frontend/src/screener/ConditionBuilder.test.tsx`

- [ ] **Step 1: catalog.test.tsx 갱신 (실패 상태로)**

`frontend/src/screener/catalog.test.tsx`의 첫 두 테스트를 교체 — 다음 `it('covers all 6 types', ...)` 블록과 `it('makeLeaf assigns id + default params', ...)` 블록, `it('summarize renders sublabels', ...)`의 new_high 줄을 아래로 바꾼다:
```tsx
  it('covers all 9 types incl. 당일/기간내 변형', () => {
    expect(CONDITION_ORDER).toHaveLength(9);
    expect(Object.keys(CONDITION_CATALOG).sort()).toEqual(
      ['change_pct', 'ma', 'new_high', 'new_high_today', 'new_high_vol',
       'new_high_vol_today', 'price_range', 'trade_value', 'trade_value_period']);
  });
  it('renames breakout labels to 기간내, bare label = 당일', () => {
    expect(CONDITION_CATALOG.new_high.label).toBe('기간내 신고가');
    expect(CONDITION_CATALOG.new_high_vol.label).toBe('기간내 신고거래량');
    expect(CONDITION_CATALOG.new_high_today.label).toBe('신고가');
    expect(CONDITION_CATALOG.new_high_vol_today.label).toBe('신고거래량');
    expect(CONDITION_CATALOG.trade_value_period.label).toBe('기간내 거래대금');
  });
  it('makeLeaf assigns id + default params (single & dual)', () => {
    expect(makeLeaf('new_high_today').params).toEqual({ period: 200 });
    expect(makeLeaf('new_high_vol_today').params).toEqual({ period: 60 });
    expect(makeLeaf('trade_value_period').params).toEqual({ lookback: 60, min_eok: 1000 });
    const a = makeLeaf('new_high'); const b = makeLeaf('new_high');
    expect(a.params).toEqual({ lookback: 200, period: 500 });
    expect(a.id).not.toBe(b.id);
  });
```
그리고 기존 `summarize renders sublabels` 테스트에 신규 요약 단언 2줄 추가:
```tsx
    expect(CONDITION_CATALOG.new_high_today.summarize({ period: 200 })).toBe('200일');
    expect(CONDITION_CATALOG.trade_value_period.summarize({ lookback: 60, min_eok: 1000 })).toBe('60일내 ≥1000억');
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/screener/catalog.test.tsx`
Expected: FAIL — `new_high_today` 등 미정의, `toHaveLength(9)` 불일치.

- [ ] **Step 3: catalog.tsx 구현**

`frontend/src/screener/catalog.tsx` import에 새 폼 추가:
```tsx
import { TradeValueForm, BreakoutForm, ChangePctForm, PriceRangeForm, MaForm, PeriodForm, TradeValuePeriodForm } from './paramForms';
```
`CONDITION_ORDER`를:
```tsx
export const CONDITION_ORDER: ConditionType[] =
  ['trade_value', 'new_high', 'new_high_vol', 'change_pct', 'price_range', 'ma'];
```
이렇게:
```tsx
export const CONDITION_ORDER: ConditionType[] =
  ['trade_value', 'trade_value_period', 'new_high_today', 'new_high',
   'new_high_vol_today', 'new_high_vol', 'change_pct', 'price_range', 'ma'];
```
`CONDITION_CATALOG`에서 `trade_value` 항목 아래에 `trade_value_period` 추가, `new_high`/`new_high_vol` 라벨 변경 + 그 앞에 당일 항목 추가 — 해당 세 줄을 다음으로 교체:
```tsx
  trade_value: { label: '거래대금', defaultParams: { min_eok: 50 }, ParamForm: TradeValueForm,
    summarize: (p) => `≥ ${p.min_eok}억` },
  trade_value_period: { label: '기간내 거래대금', defaultParams: { lookback: 60, min_eok: 1000 }, ParamForm: TradeValuePeriodForm,
    summarize: (p) => `${p.lookback}일내 ≥${p.min_eok}억` },
  new_high_today: { label: '신고가', defaultParams: { period: 200 }, ParamForm: PeriodForm,
    summarize: (p) => `${p.period}일` },
  new_high: { label: '기간내 신고가', defaultParams: { lookback: 200, period: 500 }, ParamForm: BreakoutForm,
    summarize: (p) => `${p.lookback}·${p.period}` },
  new_high_vol_today: { label: '신고거래량', defaultParams: { period: 60 }, ParamForm: PeriodForm,
    summarize: (p) => `${p.period}일` },
  new_high_vol: { label: '기간내 신고거래량', defaultParams: { lookback: 60, period: 250 }, ParamForm: BreakoutForm,
    summarize: (p) => `${p.lookback}·${p.period}` },
```
(`trade_value` 항목은 내용 동일 — 위치만 확인. 기존 `trade_value`/`new_high`/`new_high_vol` 세 항목을 위 6개 항목으로 대체.)

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/screener/catalog.test.tsx`
Expected: PASS.

- [ ] **Step 5: ConditionBuilder.test.tsx 깨진 단언 수정**

라벨 리네이밍으로 `/신고가$/`가 "신고가"·"기간내 신고가" 둘 다 매칭 → 정확 문자열로 교체. `frontend/src/screener/ConditionBuilder.test.tsx`에서:

(a) "adds a condition from the catalog menu" — 다음 줄:
```tsx
    fireEvent.click(screen.getByRole('menuitem', { name: /신고가$/ }));
```
을:
```tsx
    fireEvent.click(screen.getByRole('menuitem', { name: '기간내 신고가' }));
```
(assertion `type: 'new_high'`은 그대로 유지 — "기간내 신고가"=new_high.)

(b) "repeated same-type leaves keep distinct ids" — 다음 줄:
```tsx
    expect(screen.getAllByText('신고가')).toHaveLength(2);
```
을(두 leaf가 new_high이므로 라벨이 "기간내 신고가"):
```tsx
    expect(screen.getAllByText('기간내 신고가')).toHaveLength(2);
```

(c) "closes the menu on outside mousedown" — 두 줄의 `{ name: /신고가$/ }`를 `{ name: '기간내 신고가' }`로 교체.

- [ ] **Step 6: 통과 확인 (스크리너 프론트 전체)**

Run: `cd frontend && npx vitest run src/screener && npx tsc -b`
Expected: PASS.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/screener/catalog.tsx frontend/src/screener/catalog.test.tsx frontend/src/screener/ConditionBuilder.test.tsx
git commit -m "feat(screener-fe): 카탈로그 9종(당일/기간내) + 라벨 리네이밍 + 테스트 갱신"
```

---

## Task 7: 버그 수정 — "새로 저장 ＋"가 빈 빌더로 시작

**Files:**
- Modify: `frontend/src/screener/useSaveAnchor.ts` (인터페이스 + `newDraft`)
- Modify: `frontend/src/screener/useSaveAnchor.test.ts`
- Modify: `frontend/src/screener/SavedScreenerList.tsx` (`onNew` prop + ＋ 핸들러)
- Modify: `frontend/src/screener/SavedScreenerList.test.tsx`
- Modify: `frontend/src/pages/Screener.tsx` (배선)

- [ ] **Step 1: useSaveAnchor 실패 테스트 추가**

`frontend/src/screener/useSaveAnchor.test.ts`의 describe 안에 추가:
```tsx
  it('newDraft clears conditions/universe/anchor and marks clean', () => {
    const { result } = renderHook(() => useSaveAnchor());
    act(() => result.current.loadSave(SAVE));
    act(() => result.current.editConditions(SAVE.conditions));   // anchored + dirty
    act(() => result.current.newDraft());
    expect(result.current.conditions).toEqual([]);
    expect(result.current.universe).toEqual({});
    expect(result.current.anchorId).toBeNull();
    expect(result.current.dirty).toBe(false);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/screener/useSaveAnchor.test.ts`
Expected: FAIL — `result.current.newDraft is not a function`.

- [ ] **Step 3: useSaveAnchor 구현**

`frontend/src/screener/useSaveAnchor.ts`의 `SaveAnchor` 인터페이스에 추가(`loadSave` 아래):
```ts
  newDraft: () => void;
```
`loadSave` 정의 아래에 추가:
```ts
  const newDraft = () => { setConditions([]); setUniverse({}); setAnchorId(null); setDirty(false); };
```
return 객체에 `newDraft` 추가:
```ts
  return { conditions, universe, anchorId, dirty, loadSave, newDraft, editConditions, editUniverse, beginSave, settleAnchor };
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/screener/useSaveAnchor.test.ts`
Expected: PASS.

- [ ] **Step 5: SavedScreenerList 실패 테스트 추가**

`frontend/src/screener/SavedScreenerList.test.tsx`의 `mount` 헬퍼 props 기본값에 `onNew: vi.fn()` 추가 — 다음을:
```tsx
    anchorId: null, dirty: false, onLoad: vi.fn(), onBeginSave: vi.fn(), onAnchorChange: vi.fn(),
```
이렇게:
```tsx
    anchorId: null, dirty: false, onLoad: vi.fn(), onBeginSave: vi.fn(), onAnchorChange: vi.fn(), onNew: vi.fn(),
```
describe 안에 테스트 추가:
```tsx
  it('＋ starts a blank draft (calls onNew) then opens the name editor', async () => {
    const onNew = vi.fn();
    mount({ onNew });
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('조건검색 이름')).toBeInTheDocument();
  });
```

- [ ] **Step 6: 실패 확인**

Run: `cd frontend && npx vitest run src/screener/SavedScreenerList.test.tsx`
Expected: FAIL — `onNew is not a function`(prop 미정의) 또는 `expect(onNew).toHaveBeenCalled` 실패.

- [ ] **Step 7: SavedScreenerList 구현**

`frontend/src/screener/SavedScreenerList.tsx`의 props 타입·구조분해에 `onNew` 추가 — 다음을:
```tsx
export function SavedScreenerList({ current, anchorId, dirty, onLoad, onBeginSave, onAnchorChange }: {
  current: Current; anchorId: string | null; dirty: boolean;
  onLoad: (s: SavedScreener) => void; onBeginSave: () => void; onAnchorChange: (id: string | null) => void;
}) {
```
이렇게:
```tsx
export function SavedScreenerList({ current, anchorId, dirty, onLoad, onBeginSave, onAnchorChange, onNew }: {
  current: Current; anchorId: string | null; dirty: boolean;
  onLoad: (s: SavedScreener) => void; onBeginSave: () => void; onAnchorChange: (id: string | null) => void;
  onNew: () => void;
}) {
```
＋ 버튼 onClick을 — 다음을:
```tsx
          onClick={() => setEditing({ mode: 'create', initial: suggestSaveName(saves.map((s) => s.name)) })}
```
이렇게(빌더를 먼저 비우고 이름 편집 시작):
```tsx
          onClick={() => { onNew(); setEditing({ mode: 'create', initial: suggestSaveName(saves.map((s) => s.name)) }); }}
```

- [ ] **Step 8: Screener.tsx 배선**

`frontend/src/pages/Screener.tsx`에서 `useSaveAnchor()` 구조분해에 `newDraft` 추가 — 다음을:
```tsx
  const { conditions, universe, anchorId, dirty, loadSave, editConditions, editUniverse, beginSave, settleAnchor } = useSaveAnchor();
```
이렇게:
```tsx
  const { conditions, universe, anchorId, dirty, loadSave, newDraft, editConditions, editUniverse, beginSave, settleAnchor } = useSaveAnchor();
```
`SavedScreenerList`에 `onNew` 전달 — 다음을:
```tsx
      <SavedScreenerList current={{ conditions, universe }} anchorId={anchorId} dirty={dirty}
        onLoad={loadSave} onBeginSave={beginSave} onAnchorChange={settleAnchor} />
```
이렇게:
```tsx
      <SavedScreenerList current={{ conditions, universe }} anchorId={anchorId} dirty={dirty}
        onLoad={loadSave} onBeginSave={beginSave} onAnchorChange={settleAnchor} onNew={newDraft} />
```

- [ ] **Step 9: 통과 확인 (전체 프론트 + 타입)**

Run: `cd frontend && npx vitest run src/screener src/pages/Screener.test.tsx && npx tsc -b`
Expected: PASS.

- [ ] **Step 10: 커밋**

```bash
git add frontend/src/screener/useSaveAnchor.ts frontend/src/screener/useSaveAnchor.test.ts frontend/src/screener/SavedScreenerList.tsx frontend/src/screener/SavedScreenerList.test.tsx frontend/src/pages/Screener.tsx
git commit -m "fix(screener-fe): 새로 저장 ＋ 가 빌더를 빈 새 조건검색으로 초기화"
```

---

## Task 8: 전체 회귀 + 수동 확인

- [ ] **Step 1: 백엔드 전체 스크리너 스위트**

Run: `uv run --extra dev pytest tests/api/ -k screener -q`
Expected: PASS (전부).

- [ ] **Step 2: 프론트 전체 + 타입 + 변경파일 eslint**

Run: `cd frontend && npx vitest run && npx tsc -b`
Expected: PASS. (기존 레포 eslint 부채는 게이트 아님 — 변경 파일만 `npx eslint src/screener src/pages/Screener.tsx src/api/screener.ts` 0 에러 확인.)

- [ ] **Step 3: 수동 확인 (dev 서버 + /browse)**

dev 서버 가동 후 `/screener`에서: 저장된 조건(신고가) 로드 → "새로 저장 ＋" → 빌더가 비는지; "＋ 조건 추가"에서 9개 라벨(거래대금·기간내 거래대금·신고가·기간내 신고가·신고거래량·기간내 신고거래량·등락률·현재가 범위·이동평균); "신고가"는 숫자 1칸, "기간내 거래대금"은 "일내 ≥ 억" 폼; 조회 결과표 거래대금 숫자가 평균가 기준인지.

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/screener
$B click @c1            # 저장된 신고가 조건 로드
$B click @e9            # 새로 저장 ＋
$B text | grep -c "모두 충족"   # 0 이어야 함(빌더 비었음)
```

- [ ] **Step 4: 최종 커밋(필요 시 문서 동기화)**

스펙/CONTEXT.md는 이미 커밋됨. 추가 변경 없으면 생략.

---

## Self-review 메모 (계획 작성자 확인 완료)

- **Spec coverage**: 거래대금 산식(T1)·기간내 거래대금(T2)·당일 2종(T3)·라운드트립/하위호환(T4)·FE 타입+폼(T5)·카탈로그+라벨+테스트갱신(T6)·버그(T7)·회귀(T8) — spec 전 항목 매핑됨.
- **No placeholder**: 모든 step에 실제 코드/명령/기대출력 포함.
- **Type 일관성**: `PeriodParams{period}`, `TradeValuePeriodParams{lookback,min_eok}`, 타입키 `new_high_today`/`new_high_vol_today`/`trade_value_period`가 BE(models.py)·FE(screener.ts)·카탈로그·테스트에서 동일. `_TV` 식 1곳 정의 3곳 사용. `newDraft` 시그니처 useSaveAnchor↔Screener↔SavedScreenerList 일치.
- **알려진 깨짐 처리**: catalog.test(9종), ConditionBuilder.test(/신고가$/ 모호성·getAllByText), SavedScreenerList.test(onNew prop) 모두 해당 task에서 갱신. Screener.test:112(`queryByText('신고가')` 빈 빌더)는 초기 메뉴 닫힘이라 영향 없음.
