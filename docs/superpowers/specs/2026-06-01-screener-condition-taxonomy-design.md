# 스크리너 조건 분류 확장 — 당일/기간내 신고가·거래대금 + 새 조건검색 빈 빌더 — Design

작성 2026-06-01 (brainstorming). 선행: [2026-05-31-saved-screener-design.md](2026-05-31-saved-screener-design.md)의
"새 조건 타입 추가 = 가산적 4곳" 계약을 그대로 따른다.

## Problem

1. **버그** — `/screener`에서 저장된 조건(예: 신고가)을 로드한 뒤 **"새로 저장 ＋"**를 누르면
   빌더가 빈 새 조건검색으로 초기화되지 않고 **방금 로드한 조건이 그대로 남는다**. 새 조건검색은
   빈 빌더에서 시작해야 한다. (브라우저로 재현 확인)
2. **의미 혼동** — 현재 `new_high`(신고가)/`new_high_vol`(신고거래량)은 라벨이 "신고가"지만
   실제 로직은 **기간내 돌파**(최근 N거래일 이내에 M일 신고가 돌파 이력)다. 사용자는 "당일 기준"
   신고가(오늘 고가가 N일 신고가)와 "기간내" 신고가를 **둘 다** 쓰고 싶다.
3. **누락 조건** — "기간내 거래대금"(최근 N일 안에 거래대금이 임계값을 넘은 적 있나)이 없다.
4. **거래대금 산식** — 코퍼스에 거래대금 컬럼이 없어 현재 `종가×거래량`으로 어림한다.
   사용자는 **평균가×거래량 = `(open+high+low+close)/4 × volume`** 를 원한다(일중 체결가에 더 근접).

## Decisions (그릴링 2026-06-01, 사용자 확정)

- **당일 신고가/신고거래량**은 **별도 조건 타입**(프리셋 아님 — 폼 숫자 1개·메뉴 독립 노출). 글로서리는
  같은 타입 중복 추가를 허용하므로 `new_high {lookback:1}`로도 가능하나, UX 단순화를 위해 타입 신설. [ADR](../../adr/) 후보.
- 라벨은 **그대로 "신고가"/"신고거래량"**(당일), 기존은 **"기간내 …"**. bare="당일"이 트레이더 직관과 일치.
- **기간내 거래대금 = 임계값 가족**(돌파/신고 아님). "최근 **N**거래일 중 **하루라도** 거래대금 ≥ `min_eok`억".
  param `{lookback, min_eok}`. **`wc` 풀윈도우 가드 없음** — 상장 N일 미만도 보유일 중 도달하면 매치.
- **당일 거래대금은 만들지 않음**(거래대금은 이미 당일 `trade_value` 임계값이 있음).
- **거래대금 = `(open+high+low+close)/4 × volume`**, **3곳 통일** — 기존 `trade_value` 조건, 신규
  `trade_value_period` 조건, 결과표 `trade_value_won` 컬럼 전부.
- 새 조건검색 ＋ 는 **빌더를 빈 상태로 초기화**한다(`비어있는걸로 해줘`).

## Invariants (유지)

- 레지스트리 기반 — `run_scan` 코어는 타입을 모른다. 조건은 `cond_i` CTE(매칭 code 집합)로 균일 환원.
- `_breakout_cte`는 **VERBATIM, 재작성 금지** — 재사용만 한다.
- Pydantic ⇄ TS 2언어 손수 미러(ADR-0004 no-codegen). `type` 키 문자열 byte-for-byte 일치.
- 백엔드는 leaf `id`를 무시하고 위치 인덱스(`cond_i`)로 식별.

## Design

### 조건 카탈로그 (6종 → 9종)

라벨 변경은 **프론트 카탈로그 라벨 전용**이다. `type` 판별자는 불변 →
디스크 `saves.json`의 기존 `new_high`/`new_high_vol` 저장은 **마이그레이션 없이 유효**하고
다음 조회부터 "기간내 …"로 표시된다.

`TV = (open+high+low+close)/4 × volume` (거래대금, 3곳 공용 SQL 식).

| type 키 | 한글 라벨 | params | 의미 (확정) | 상태 |
|---|---|---|---|---|
| `trade_value` | 거래대금 | `{min_eok≥0}` | 최신일 `TV ≥ min_eok*1e8` | **산식 변경**(종가→평균가) |
| `trade_value_period` | **기간내 거래대금** | `{lookback≥1, min_eok≥0}` | 최근 N거래일 중 **하루라도** `TV ≥ min_eok*1e8`. 돌파 아님·`wc` 가드 없음 | **신규** |
| `new_high_today` | **신고가** | `{period≥1}` | `_breakout_cte('high', lookback=1, period)` — 오늘 고가가 N일 롤링 최고 | **신규** |
| `new_high` | **기간내 신고가** | `{lookback≥1, period≥1}` | `_breakout_cte('high')` — 최근 N일 내 M일 신고가 돌파 | 라벨만 변경 |
| `new_high_vol_today` | **신고거래량** | `{period≥1}` | `_breakout_cte('volume', lookback=1, period)` — 오늘 거래량이 N일 롤링 최고 | **신규** |
| `new_high_vol` | **기간내 신고거래량** | `{lookback≥1, period≥1}` | `_breakout_cte('volume')` | 라벨만 변경 |
| `change_pct` | 등락률 | `{op, pct?, lo?, hi?}` | 최신일 등락률에 op 적용 | 불변 |
| `price_range` | 현재가 범위 | `{min?, max?}` | 최신일 close 범위 | 불변 |
| `ma` | 이동평균 | `{period≥1, relation}` | 최신일 close vs SMA | 불변 |

**핵심 등가**: `new_high_today(period=P)` ≡ `new_high(lookback=1, period=P)`.
N=1이면 `_lb`의 `lb_start`가 최신 거래일 하나뿐 → `date >= lb_start`가 최신 행만 통과 →
`v >= mx AND wc = M`이 "오늘이 M일 신고가"가 된다. 그래서 당일 타입은 SQL을 복제하지 않고
`_breakout_cte`를 lookback=1로 호출한다.

**`CONDITION_ORDER`** (당일/기간내 페어링):
`['trade_value', 'trade_value_period', 'new_high_today', 'new_high', 'new_high_vol_today', 'new_high_vol', 'change_pct', 'price_range', 'ma']`

**기본값(makeLeaf)**: 신규 `new_high_today {period:200}`, `new_high_vol_today {period:60}`,
`trade_value_period {lookback:60, min_eok:1000}`. 기존 5종 기본값 유지.

### 백엔드 — 가산적 변경 + 거래대금 산식

`models.py`:
- 신규 `PeriodParams{period:int≥1}` (당일 신고가/신고거래량 공용, 단일 period).
- 신규 `TradeValuePeriodParams{lookback:int≥1, min_eok:float≥0}` (임계값-over-lookback).
- 신규 leaf 클래스 3종 + `ConditionLeaf` 판별 union에 변형 3개 추가:
  `NewHighTodayLeaf(type='new_high_today', params=PeriodParams)`,
  `NewHighVolTodayLeaf(type='new_high_vol_today', params=PeriodParams)`,
  `TradeValuePeriodLeaf(type='trade_value_period', params=TradeValuePeriodParams)`.

`screener_scan.py`:
- **공용 거래대금 식**: 모듈 상수 `_TV = "((open+high+low+close)/4.0)*volume"` 도입,
  3곳에서 재사용(드리프트 방지).
- **`base` CTE에 `open, low` 추가** — 현재 `high, close, volume`만 있어 `_TV`를 못 만든다.
- **`_compile_trade_value`**: `WHERE close*volume >= ?` → `WHERE {_TV} >= ?`.
- **결과 SELECT `trade_value_won`**: `(close*volume)::BIGINT` → `({_TV})::BIGINT`.
- **신규 `_compile_trade_value_period(leaf, i)`** (돌파 아님 — 임계값-over-lookback):
  ```
  cond_i AS (SELECT DISTINCT code FROM (
    SELECT code, {_TV} AS tv,
      ROW_NUMBER() OVER (PARTITION BY code ORDER BY date DESC) rn FROM adj) t
    WHERE rn <= {lookback} AND tv >= ?)   -- param: [int(min_eok*1e8)]
  ```
- **당일 돌파 2종**: 당일 컴파일러가 `_breakout_cte(f"cond_{i}", col, BreakoutParams(lookback=1, period=leaf.params.period))` 호출(SQL 무복제, VERBATIM 준수).
- `CONDITION_COMPILERS`에 3줄 등록. `_breakout`의 "registry guarantees only new_high/new_high_vol"
  주석 갱신(이제 4종이 `_breakout_cte`를 거친다 — `trade_value_period`는 거치지 않음).

### 프론트엔드 — 가산적 변경

- `api/screener.ts` — `PeriodParams{period}` + `TradeValuePeriodParams{lookback, min_eok}` +
  `ConditionLeaf` union에 변형 3개 추가.
- `paramForms.tsx` — 신규 **`PeriodForm`**(단일 period, `Num` 재사용) +
  신규 **`TradeValuePeriodForm`**(lookback "일내" + min_eok "억", `Num` 2개).
  `trade_value_period`는 params 모양({lookback, min_eok})이 BreakoutParams와 달라 BreakoutForm 재사용 불가.
- `catalog.tsx` — 신규 3 항목 추가 + `new_high`/`new_high_vol` **label 변경** + `CONDITION_ORDER` 확장.
  summarize: 당일 `${period}일`, `trade_value_period` `${lookback}일내 ≥${min_eok}억`.

### 버그 수정 — 새 조건검색 빈 빌더

원인: [SavedScreenerList.tsx](../../../frontend/src/screener/SavedScreenerList.tsx) ＋ 핸들러가
`setEditing(...)`만 호출하고 빌더 상태(부모 `useSaveAnchor` 소유)를 건드리지 않는다.

수정: `useSaveAnchor`에 **`newDraft()`** 액션 추가
(`setConditions([]); setUniverse({}); setAnchorId(null); setDirty(false);`).
`Screener.tsx`가 `onNew={newDraft}`로 `SavedScreenerList`에 내려주고, ＋ 핸들러가
`onNew()` 후 `setEditing({mode:'create', ...})`를 호출.

**채택안 (a)** — ＋ 는 빌더를 비운 뒤 **기존대로 이름 입력을 띄운다**. 이름을 바로 커밋하면
빈 조건의 저장이 생기고, 사용자는 조건을 채운 뒤 ⤓(덮어쓰기)로 갱신한다. 이는 디스크의
"새조건1"/"새조건2"가 만들어진 현재 "생성 후 편집" 패턴과 일치하며 단일 저장 버튼 모델을 유지한다.
대안 (b)(＋ 는 빌더만 비우고 이름 입력은 생략)는 별도 저장 affordance가 필요해 범위를 키우므로 보류.

## Testing

기존 패턴: 백엔드 `test_screener_scan.py`의 `_seed(tmp_path, rows, stocks)` + `run_scan`,
프론트 vitest. 게이트: `uv run --extra dev pytest` / `npx vitest run` + `npx tsc -b`,
eslint는 변경 파일만.

### 백엔드 scan (의미 증명)

- **🎯 당일 vs 기간내 발산(핵심 판별)**: A는 최신일까지 상승(오늘 신고가), B는 5일 전 P일 신고가 후 하락.
  `new_high_today(P)` → A만; `new_high(lookback≥5, period=P)` → A·B 둘 다. 결과가 갈려야 신규 타입이
  진짜 다름이 증명됨. ([test_new_high_lookback_window_boundary](../../../tests/api/test_screener_scan.py) 패턴 교차)
- **당일=lookback1 동치**: `new_high_today(P)` 결과 == `new_high(lookback=1, period=P)` 결과.
- **wc 윈도우 가드**: P거래일 미만 상장 종목은 `new_high_today` 절대 매칭 안 됨.
- **동률 포함(≥)**: 평탄 종가 → 당일 고가 == 윈도우 max → 매칭.
- **당일 신고거래량**: 거래량 최신일 최고 vs 과거 최고 픽스처로 col=volume 검증.
- **🎯 거래대금 평균가 산식**: `종가×거래량`과 `평균가×거래량`이 **갈리는** 픽스처(예: 종가는 낮지만
  시·고가 높은 날) → `trade_value` 매칭과 결과표 `trade_value_won` 둘 다 **평균가 식**으로 계산됨을 확정.
- **🎯 기간내 거래대금 — 임계값-over-lookback**:
  (a) 임계값 ≥일이 lookback 안(예: 5일 전)이면 매치, lookback 밖(예: 100일 전)이면 미스;
  (b) **상장 N일 미만 종목도** 보유일 중 임계값 도달하면 매치(`wc` 가드 없음 — 돌파와 대비);
  (c) `trade_value`(당일 임계값)와 달리 **과거 어느 날** 도달이면 잡힘을 당일 버전과 교차 확인.

### 백엔드 모델/라우트

- `test_screener_models.py`: 신규 3 leaf 판별 union 라운드트립; `PeriodParams`가 `period<1` 거부;
  **하위호환** — 기존 `new_high` 페이로드 여전히 파싱(명시 테스트).
- `test_screener_saves.py`/`test_screener_routes.py`: `new_high_today` 포함 저장 create→get 라운드트립;
  기존 `saves.json` 형태가 list_saves로 여전히 로드.

### 프론트엔드 (vitest)

- `catalog.test.tsx` **갱신**(현 "covers all 6 types" 하드코딩): 길이 9, 키 3종 추가;
  **라벨 단언**(`new_high`→'기간내 신고가', `new_high_vol`→'기간내 신고거래량',
  `new_high_today`→'신고가', `new_high_vol_today`→'신고거래량'); `makeLeaf` 단일/이중 params; summarize.
- 신규 `PeriodForm`이 입력 1개만 렌더(당일이 lookback 노출 안 함 보장).
- `ConditionBuilder.test.tsx`/`Screener.test.tsx`: 메뉴 9개 라벨; "신고가"(당일) 추가 시 단일 period leaf;
  old 라벨 의존 단언 갱신.
- **🎯 버그 회귀**: 비어있지 않은 저장 로드 → "새로 저장 ＋" → 빌더 조건 0개("모두 충족 · AND" 미표시).

### 진행 순서 (TDD)

1. 백엔드 모델 3종 → 컴파일러 3종 → 발산/계산컬럼 테스트 red→green.
2. 프론트 타입·카탈로그·폼 → catalog.test 갱신 → 버그 회귀.
3. 라벨 리네이밍은 라벨 단언과 함께(최저위험).

## Non-Goals

- 데이터 파이프라인 변경(일봉 OHLCV로 계산 가능한 조건만 추가).
- OR/그룹 조합(현 AND-only 유지).
- 새 조건검색 ＋ 의 저장 플로우 재설계(버그는 빌더 초기화로 최소 수정; 부수효과만 확정).

## Risks

- **2언어 미러 드리프트**: `type` 키 3개를 BE/FE 양쪽에 추가 — byte 불일치 시 422. catalog.test의
  키 집합 단언 + 모델 라운드트립이 가드.
- **거래대금 산식 변경 = 기존 동작 변경**: 기존 저장 `trade_value`와 결과표 거래대금 숫자가 살짝 바뀐다
  (종가→평균가). 저장은 안 깨짐(param 동일, 비교 기준값만 이동). `_TV`는 모듈 상수 문자열(사용자 입력
  무삽입)이라 인젝션 없음 — Pydantic 검증 정수만 인라인. 평균가 산식 테스트가 가드.
- **`base` CTE 확장**: `open, low` 추가 — `DISTINCT ON (code) … ORDER BY` 형태 유지, 기존 컬럼 불변.
- **라벨/타입 혼동**: 신규 "신고가"(당일)와 "기간내 신고가"가 메뉴에 공존 — 페어링 순서로 완화.
