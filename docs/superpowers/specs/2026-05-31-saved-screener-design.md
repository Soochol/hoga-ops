# 저장형 스크리너 (Saved Screener) — Design

**Date**: 2026-05-31
**Status**: Draft
**Supersedes (부분)**: `2026-05-31-screener-design.md` 의 고정 3조건·AND-only·결과 wire model 부분. 데이터 파이프라인(원주가 아카이브 → 수정주가 파생 → DuckDB 스캔)·시드·업데이트·staleness 는 그대로 유지.
**Scope**: `hoga/api/models.py`, `hoga/api/screener_scan.py`, `hoga/api/screener.py`, `hoga/api/screener_saves.py`(신규), `hoga/api/app.py`(CORS), `frontend/src/screener/*`, `frontend/src/api/*`, `frontend/src/pages/Screener.tsx`, `CONTEXT.md`

## Problem

현재 `/screener` 는 **하드코딩 패널**이다 — 고정 조건(거래대금·신고가·신고거래량)을 `GET /api/screener` flat query param 으로 보내고, 결과는 고정 슬롯 `new_high`/`new_high_vol` 로 받는다. 사용자가 *자기 조건을 정의·조합·저장*할 수 없다.

원하는 것: 시스템이 제공하는 **빌트인 조건 카탈로그**(신규 타입 포함)에서 조건을 골라 파라미터를 넣고 **AND 로 조합** → 이름 붙여 **저장/삭제/변경(CRUD)** → 저장 목록을 **선택 → 조회** → 매칭 종목 표시.

## Decisions (brainstorming 2026-05-31, 시각 미리보기로 확정)

| 항목 | 결정 | 비고 |
|---|---|---|
| **복합 구조** | **AND 전용, 평면 목록** | OR/그룹은 다음 버전. 백엔드 모델은 가산적 확장 가능하게(트리 안 만듦). |
| **페이지 레이아웃** | **C — 3열**: 저장 목록(~236px) · 조건 빌더(~336px) · 결과(1fr) | 앱 공통 좌측 nav·우측 Right Rail 사이. |
| **빌더 편집** | **B — 요약+펼치기**: 평소 한 줄 요약(`신고가 200·500`), 클릭 시 펼쳐 편집 | |
| **파라미터 입력** | **숫자 입력**(거래대금처럼). lookback/period/MA period 모두 숫자 입력 | **preset pill 제거** (PERIOD_PRESETS·PresetGroup 삭제). |
| **결과 표시** | **조건 배지 없음** — 표준 컬럼만(코드·종목명·시장·현재가·등락률·거래대금) | 행 클릭→`/live`, ♥ 관심·📥 캡처 유지. |
| **조건 6종** | 거래대금·신고가·신고거래량·등락률·현재가 범위·이동평균 (전부 AND) | 카탈로그 레지스트리. 같은 타입 중복 추가 가능. |
| **전역 사전필터** | 시장(KOSPI/KOSDAQ)·ETF제외·거래정지제외 | 조건 아님 — 코퍼스 제한(항상 AND). SavedScreener 에 함께 저장. |
| **저장 클릭** | 선택 = 빌더에 **로드만**(자동 조회 X), 사용자가 조회 버튼 | `/saves/{id}/run` 엔드포인트 없음. |
| **검색(q)** | v1 UI 미노출 | `run_scan` 은 q 지원하나 빌더에서 안 보냄. |

**배지 삭제의 파급(핵심 단순화)**: 결과에 조건별 표시가 없으므로 행마다 `matches:{id→payload}` 맵·`ConditionPayload` union 불필요. `ScreenerRow` 는 평면형. 조건은 **멤버십 필터로만** 작동(어떤 Code 가 충족했나). leaf 의 클라이언트 `id` 는 프론트 React key/저장 라운드트립 용도로만 남고 **스캔 결과 경로에서 빠진다**.

## Invariants (유지)

- **`_breakout_cte` verbatim 재사용** — 신고가/신고거래량 leaf 는 `screener_scan._breakout_cte(name, col, f)` 를 그대로 호출(tie `>=`·`wc=M` 부분윈도우 가드·거래일 `days_ago` 가 거기 박혀 있음). SQL 재작성 금지. 결과 멤버십에만 쓰고 payload 컬럼은 surface 안 함.
- **수정주가(adjusted) 기준 스캔** — 모든 조건은 `daily_adjusted.parquet` 위에서 평가. 보정계수는 최신일=1 basis 라 **최신일 현재가·거래대금은 실제가와 일치**(과거값만 back-adjust). 신고가/MA 등 다년 비교는 split 가짜신고 없는 수정주가로.
- **Code 6자리 VARCHAR** — `005930` 문자열 보존(BIGINT 5930 아님), 전 구간.
- **Wire Model 도메인 이름** — `change_pct`(KIS `prdy_ctrt` 미노출).
- **DuckDB-over-parquet, sub-second** — 신규 조건 전부 pure-parquet(KIS fetch 없음) → KisClient 15/s 버킷 불변식 무관.
- **저장 영속 = watchlist 패턴(파일=SSOT)** — Pydantic + `asyncio.Lock` + `atomic_write_json` + `schema_version` + 손상파일 격리(ADR-0019). 쓰기 OSError **전파(→500)**(삼키면 무성 데이터 손실).

## Design

### 조건 카탈로그 (빌트인 6종) — 의미 확정

수정주가 기준, 모두 최신 거래일 행에 대해 평가(신고가/신고거래량은 Lookback Window 내 돌파 이력).

| type 키 | 한글 | params | 의미 (확정) |
|---|---|---|---|
| `trade_value` | 거래대금 | `{min_eok: float≥0}` | 최신일 `close*volume ≥ min_eok*1e8` |
| `new_high` | 신고가 | `{lookback:int≥1, period:int≥1}` | `_breakout_cte('high')` — 최근 N거래일 내 M일 신고가 돌파 이력 |
| `new_high_vol` | 신고거래량 | `{lookback:int≥1, period:int≥1}` | `_breakout_cte('volume')` |
| `change_pct` | 등락률 | `{op:'gte'|'lte'|'between', pct?, lo?, hi?}` | **최신일** `(close/prev_close-1)*100` 에 op 적용. gte:≥pct, lte:≤pct, between:lo≤x≤hi |
| `price_range` | 현재가 범위 | `{min?:int, max?:int}` (원, 최소 한쪽) | 최신일 `close` 가 [min,max] 안. 둘 다면 min≤max |
| `ma` | 이동평균 | `{period:int≥1, relation:'above'|'below'}` | 최신일 `close` vs `SMA(close, period거래일)`. above:`close≥SMA`(동점 포함), below:`close≤SMA`. `wc=period` 풀윈도우 가드(상장 N일 미만 제외) |

UI 기본값(makeLeaf): trade_value 50, new_high {200,500}, new_high_vol {60,250}, change_pct {gte,5}, price_range {min:1000}, ma {20,above}. (price_range·change_pct는 빈/불완전 params면 백엔드가 422 — 기본값은 항상 유효한 값으로; change_pct op 토글 시 폼이 새 op에 맞는 필드를 시드.)

### 백엔드 — 레지스트리 + 컴파일러 (`screener_scan.py`)

**레지스트리**: `type → compile(leaf, i)` 가 `cond_{i} AS (SELECT code FROM <source> WHERE <pred>)` CTE 문자열을 반환(위치 인덱스 `i` 로 식별자 안전; **클라이언트 id 는 SQL 에 안 들어감**). payload SELECT/추출 없음(배지 없음).

`run_scan(adjusted_path, stocks_path, *, conditions, universe, limit)`:
1. `base` CTE (오늘 그대로: DISTINCT ON code 최신행 + `prev_close` LAG → change_pct 컬럼).
2. 각 condition[i] → `cond_{i}` CTE.
3. `WITH base, cond_0, cond_1, ... SELECT base.code, stk.name, stk.market, close::BIGINT price, (close*volume)::BIGINT trade_value_won, change_pct FROM base JOIN stk JOIN cond_0 ON .code JOIN cond_1 ... WHERE <universe: markets/etf/halted (? params)> ORDER BY trade_value_won DESC LIMIT ?`. **INNER JOIN per leaf = AND 멤버십**(현 nh/nhv JOIN 패턴을 N개로 일반화).
4. 행 → `ScreenerRow`(payload 없음).
- 신규 leaf SQL: `change_pct`/`price_range` 는 base 위 1줄 WHERE(`?` 파라미터); `ma` 는 자체 윈도우 CTE(`AVG(close) OVER N행` + `wc=period` 가드 → DISTINCT ON 최신행 → relation). 윈도우 크기(lookback/period/ma period)는 Pydantic 검증 int 라 인라인.
- **OR 미래 경로(주석)**: INNER JOIN → `code IN (SELECT code FROM cond_i)` 불리언식으로 전환.
- depth 클램프: breakout/ma 깊이 초과 시 클램프 + `warnings`(무성 cap 금지).

### 확장성 — 새 조건 타입 추가 (설계 계약)

조건은 **레지스트리 기반**으로 구조화한다. `run_scan` 코어는 타입을 모르고, 컴파일러가 조건을 `cond_i` CTE(매칭 Code 집합)로 균일 환원하면 순회·JOIN만 한다.

```python
CONDITION_COMPILERS: dict[str, LeafCompiler] = {
    "trade_value": _compile_trade_value, "new_high": ..., "ma": _compile_ma, ...
}
for i, leaf in enumerate(conditions):
    cte, params_i = CONDITION_COMPILERS[leaf.type](leaf, i)   # cond_i CTE 반환
```
프론트도 대칭: `CONDITION_CATALOG: Record<type, {label, defaultParams, ParamForm, summarize}>` 를 `ConditionBuilder`/`ResultTable` 가 순회(타입 하드코딩 없음).

**새 조건 타입 추가 = 가산적 4곳, 코어 무수정** (run_scan·빌더·결과 테이블·저장/CRUD 라우트·app.py 불변):
1. `models.py` — `XLeaf` Pydantic 클래스 + `ConditionLeaf` union 변형 추가
2. `screener_scan.py` — `_compile_x`(→ `cond_i` CTE) + `CONDITION_COMPILERS` 1줄 등록
3. `api/screener.ts` — TS leaf union 변형 추가
4. `screener/catalog.tsx`(+`paramForms.tsx`) — 카탈로그 항목 + ParamForm
   (+ 해당 leaf SQL 테스트)

**한계(명시)**: (a) Pydantic·TS 양쪽에 변형을 추가하는 **2언어 미러**(ADR-0004 no-codegen) — type 키 문자열 byte-for-byte 일치 필수. (b) 일봉 OHLCV(수정주가) 코퍼스로 계산되는 조건만 순수 레지스트리 추가. **PER·시총·섹터·분봉** 등 코퍼스에 없는 데이터가 필요하면 데이터 파이프라인 변경이 선행. (c) OR/그룹은 컴파일러를 `code IN (...)` 불리언식으로 전환하는 별도 변경(backlog) — 조건 *타입* 확장과 직교.

### Wire 모델 (`models.py`, Pydantic ⇄ TS 손수 미러 ADR-0004)

```
ConditionLeaf = discriminated union(discriminator='type') — 6 변형, 각 {id:str(클라이언트), type, params}.
  (백엔드는 id 무시·위치 인덱스 사용. id 는 프론트 key/저장 라운드트립용.)
ScanRequest{conditions:list[ConditionLeaf], universe:ScreenerUniverse, limit:int=1000(1..2000)}
ScreenerUniverse{markets:list[Literal['KOSPI','KOSDAQ']]=[], exclude_etf=False, exclude_halted=False}
ScreenerRow{code:str(^\d{6}$), name, market:Literal['KOSPI','KOSDAQ'], price:int, trade_value_won:int, change_pct:float|None}   # 고정 슬롯·matches 없음
ScreenerResponse{status:Literal['ok','not_seeded','building'], rows:list[ScreenerRow], warnings:list[str]=[]}
```
- 기존 `BreakoutHit`/`BreakoutMiss`/`Breakout`/`BreakoutFilter` 는 `_breakout_cte` 내부 호출용으로만 잔존(또는 BreakoutParams 로 대체). 기존 `ScreenerRow` 의 new_high/new_high_vol 슬롯 제거.

### 스캔 API (`screener.py` build_router)
- **`POST /api/screener/scan`** (기존 `GET /api/screener` 대체) — body `ScanRequest`, 응답 `ScreenerResponse`. status.json 없으면 `not_seeded`.
- `GET /api/screener/status`, `POST /api/screener/update` 불변.

### 저장 영속 + CRUD

**`screener_saves.py`(신규)** — `watchlist.py` 미러. 파일=SSOT, lock-free 읽기(`os.replace` 원자성), 쓰기만 `_lock` 직렬화. `load_saves`(순수: 읽기+메모리 마이그레이션+반환), `save_saves`(atomic, **OSError 전파**), `_quarantine`(`.corrupt-<ts>-<reason>`), `_migrate`(`<current` forward / `>current` quarantine / parse·Validation quarantine), CRUD 헬퍼 + `ScreenerSaveNotFoundError`. 경로 `<data_dir>/screener/saves.json`.

**모델**: `ScreenerSaveWriteRequest{name, conditions, universe}`(POST·PUT body) ⇄ `SavedScreener{id(서버 uuid4().hex), name, conditions, universe, created_at_ms, updated_at_ms}`(응답). `SavedScreenersFile{schema_version:int=1, saves:list[SavedScreener]}`. universe 저장, q 미저장.

**라우트**(build_router, `watchlist_routes.py` 패턴, HTTPException detail `{code,message}`): `POST /api/screener/saves`(201, 서버 id+시각 스탬프) · `GET /api/screener/saves` · `GET /api/screener/saves/{id}` · `PUT /api/screener/saves/{id}`(full replace, id+created_at 보존, updated_at 갱신, 404) · `DELETE /api/screener/saves/{id}`(204, 404). **lifespan 훅 없음**(boot 소비자 없음, lazy load).

**`app.py` CORS `allow_methods` 에 `'PUT'` 추가** — 유일한 app.py 변경.

**선택→조회 흐름**: `GET /saves/{id}` 전체 반환 → 프론트가 빌더에 conditions+universe 로드 → 사용자가 조회 → 빌더 상태를 `/scan` 에 POST. 단일 스캔 경로, 로드 후 수정 가능.

### 프론트엔드 (`/screener`, C 3열)

- `pages/Screener.tsx` — state `{conditions:ConditionLeaf[], universe}`. 컨트롤바: `조회`/`갱신`/StalenessChip. 3열: `SavedScreenerList` · `ConditionBuilder` · `ResultTable`.
- `screener/catalog.tsx`(신규) — `CONDITION_CATALOG: type → {key, label, defaultParams, ParamForm, summarize(params)→string}` (배지 렌더러 없음) + `CONDITION_ORDER` + `makeLeaf(type)`(`{id:nanoid(8), type, params:default}`).
- `screener/ConditionBuilder.tsx`(신규, ConditionPanel 대체) — `+ 조건 추가 ▾` 카탈로그 메뉴 → 평면 AND 목록(요약 행, 클릭 펼침·편집), 하단 전역 사전필터 섹션.
- `screener/ConditionRow.tsx`(신규) — 요약/펼침 + `catalog[type].ParamForm` + × 제거.
- `screener/paramForms.tsx`(신규) — 타입별 폼(전부 **숫자 입력**·op select). `PresetGroup`/`PERIOD_PRESETS` **삭제**.
- `screener/SavedScreenerList.tsx`(신규) — 목록 + ＋새로저장(이름)/✎이름변경/🗑삭제. 선택=`onLoad`(조회 X).
- `screener/useSavedScreeners.ts`(신규) — `useWatchlist` 미러(useQuery `['screener-saves']` + create/update/delete mutation invalidate).
- `api/screener.ts` — `ScreenerFilters`/`runScreener`(GET) 제거; `ConditionLeaf`/`ScanRequest`/평면 `ScreenerRow`/`ScreenerUniverse` 추가; `runScan(body):POST /api/screener/scan`. `api/savedScreeners.ts`(또는 동일 파일) CRUD 클라이언트.
- `screener/ResultTable.tsx` — **배지 칼럼 삭제**(돌파 컬럼·BreakoutBadge 제거). 표준 컬럼 + 3액션 유지.
- **삭제**: `screener/ConditionPanel.tsx`, `screener/BreakoutBadge.tsx`(미사용화).

### 도메인 (`CONTEXT.md`)
신규 등재: **저장된 조건검색(SavedScreener)**, **조건(Condition)/빌트인 조건 카탈로그**, **등락률/현재가 범위/이동평균(MA)**. Screener 항목의 고정 3조건 서술을 "빌트인 조건 카탈로그(AND 조합)·저장형"으로 갱신.

## Testing

**백엔드(`uv run --extra dev pytest`)** — `test_screener_scan.py` 확장 + `test_screener_saves.py` 신규:
- Code round-trip, breakout tie `>=`, `wc=M` 가드, lookback 경계, depth 클램프→`warnings`.
- 반복 동일 타입(신고가 200/500 + 20/60 둘 다 AND → 둘 다 충족 행만).
- 신규 타입 hit/miss·경계: change_pct(gte/lte/between), price_range(min만/max만/둘다·min≤max), ma(above/below·`wc=N` 가드·**TDD 우선**: 경계·상장 N일 미만 제외).
- 혼합 타입 AND, POST /scan 계약, status 판별.
- 저장 CRUD round-trip, atomic write, 손상 격리, version `<`migrate/`>`quarantine, Lock 동시성, id 유일성, 404, 이름 공백 422, 쓰기 OSError→500, PUT 시 created_at 보존·updated_at 변경.

**프론트(vitest)** — 빌더(카탈로그 추가/숫자입력 편집/제거/반복 동일타입/change_pct between 토글), summarize, SavedScreenerList(목록/선택=로드만(runScan 호출 X)/새로저장/이름변경/삭제), runScan POST body, ResultTable(배지 없음·표준 컬럼·행 클릭 setActiveCode), not_seeded, `Screener.test.tsx` 마이그레이션.

## Non-Goals (v1)
OR/그룹 조건. 결과 조건 배지. 검색(q) UI. cross_up(이동평균 상향돌파)·이격% 임계값. 결과 정렬/페이지네이션 사용자 제어. 멀티유저 per-user 저장. 사용자 정의(빌트인 아닌) 조건.

## Risks
- 공유 계약(ConditionLeaf union·ScreenerRow·SavedScreener)을 Pydantic ⇄ TS 손수 미러 — discriminator 문자열 byte-for-byte.
- 마이그레이션: `test_screener_routes.py`(GET)·ResultTable 고정 배지·`Screener.test.tsx` 는 깨짐 → 같은 변경셋에서 마이그레이션.
- `_breakout_cte` 리팩터 금지(불변식 박힘). `run_scan` 이 `adj`/`stk` 뷰 계속 생성해야 함. `BreakoutParams`→`BreakoutFilter` 변환.
- `ma` 가 유일한 윈도우-CTE 신규 leaf → TDD 우선.
