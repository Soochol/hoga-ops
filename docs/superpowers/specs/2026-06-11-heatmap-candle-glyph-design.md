# 관심맵 행 — 당일 캔들 글리프 (스파크라인 대체) — 설계

- **Date**: 2026-06-11
- **Status**: Draft — 실응답 검증 + 방향/색 결정 확정. 사장님 검토 대기.
- **Topic slug**: `heatmap-candle-glyph`
- **Branch**: `worktree-heatmap-candle-glyph` (worktree)
- **Supersedes**: [`2026-06-11-heatmap-hybrid-sparkline-design.md`](./2026-06-11-heatmap-hybrid-sparkline-design.md)(v0.7.15.0)의 **스파크라인 부분만**. 섹터 온도 스트립은 그대로 유지한다. since-open 누적(`sparklineStore`·옵션 a)은 **삭제**한다.
- **Scope (코드)**: 백엔드 `hoga/live/kis_client.py`(`KisQuote`·`_parse_quote`), `hoga/live/api.py`(`LiveQuote`·`LiveQuoteFetcher`). 프론트 신규 `frontend/src/heatmap/CandleGlyph.tsx`; 변경 `frontend/src/api/liveQuotes.ts`, `frontend/src/heatmap/{HeatmapRow,HeatmapFolder,HeatmapBoard}.tsx`, `frontend/src/pages/Heatmap.tsx`; 삭제 `frontend/src/heatmap/{Sparkline,useSparklineSeries}.tsx`, `frontend/src/state/sparklineStore.ts`(+테스트). `DESIGN.md` 규칙 교체.
- **관련 ADR**: 0056(KIS live quote 오버레이·10초 폴), 0068(히트맵 분리), 0045(spec invariants).
- **실응답 검증(2026-06-11 15:11 KST 장중)**: 멀티시세 `intstock-multprice`(FHKST11300006, 히트맵이 이미 폴하는 그 엔드포인트) 응답에 당일 OHLC가 **이미 포함**됨 — `inter2_oprc`(시)·`inter2_hgpr`(고)·`inter2_lwpr`(저)·`inter2_prpr`(현재가)·`inter2_prdy_clpr`(전일종가). 005930 실측 확인.

---

## Problem

v0.7.15.0의 행 스파크라인은 **"보드를 연 이후(since-open)" 추세**만 보여준다 — 클라이언트 누적이라 새로고침에 리셋되고, 시간이 지나며 점이 쌓이며, 영속·기기 공유가 안 된다. 사장님 정정:

> "그 히스토리 그래프 필요 없고, 이걸 캔들로 변경해줘. 현재가·시가·고가·저가만 알면 되잖아. 당일 기준."

**당일 캔들(O/H/L/C)은 현재 시세만으로 완전히 결정**된다 — 누적·히스토리가 원천적으로 불필요하고, 매 폴이 최신값을 주므로 새로고침·기기 무관이 자동 성립한다. 게다가 그 4값은 **이미 폴 중인 멀티시세 응답에 들어있다**(추가 호출 0).

## Invariants

- **히트색 = 가격방향 카테고리**: 등락 기반 색은 `--price-up`(KRX 상승 적)·`--price-down`(하락 청)에서만. 근거: DESIGN.md §Color.
- **teal `--accent` = UI 상태 전용**: 시장 데이터에 teal 금지. 근거: DESIGN.md 색 규율.
- **10초 배치 시세 폴 계약**: `/api/live/quotes`가 코드 집합의 현재 시세를 10초 폴로 배치 반환(closed=600s 하트비트, 마지막 시세 서빙). 근거: ADR-0056, [liveQuotes.ts](../../../frontend/src/api/liveQuotes.ts).
- **시세 오버레이는 KIS 실패를 전파하지 않는다**: `/api/live/quotes`는 500 금지(오버레이라 부분 결측 허용). 근거: [live/api.py](../../../hoga/live/api.py) `LiveQuoteFetcher`.
- **행 클릭 = jump-to-live**: 근거: ADR-0052.
- **숫자 = mono tabular-nums**: 근거: DESIGN.md §Typography.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 히트색 = 가격방향 카테고리 | **preserves (+확장)** | 캔들 몸통/심지를 `--price-up`/`--price-down`로 — 종가 vs 시가 부호. 새 색 0. (스파크라인 stroke 확장을 캔들로 대체.) |
| teal UI 전용 | preserves | 캔들·칩 모두 가격방향 색만. |
| 10초 배치 폴 계약 | **preserves (additive)** | `LiveQuote`에 `open/high/low` **추가만** — 기존 `price`/`change_pct`/`change_won` 불변. 추가 호출·필드 제거 없음. |
| 시세 오버레이 500 금지 | preserves | OHLC도 동일 응답에서 파싱; 결측은 0/None 폴백(예외 전파 X). |
| 행 클릭 = jump-to-live | preserves | 캔들 셀만 교체, 클릭 핸들러 불변. |
| 숫자 = mono tabular-nums | preserves | 캔들은 SVG. 가격·등락칩 표현 불변. |

> **의도적 제거 — since-open 누적(v0.7.15.0)**: `sparklineStore`(carry-forward·phase 게이트·KST 롤오버 리셋)와 옵션 a 시계열을 **삭제**한다. 캔들은 누적이 필요 없으므로 그 불변식들은 더 이상 보존 대상이 아니다. 사장님 방향 전환에 따른 의도적 대체다(스파크라인은 v0.7.15.0에 배포됐으나 이 spec이 대체).

> **캔들 색 기준(결정 A, 2026-06-11 승인)**: 몸통·심지 색 = `sign(close − open)` — **종가≥시가 양봉 적(`--price-up`)·종가<시가 음봉 청(`--price-down`)·동일 도지 중립(`--fg-dim`)**. 이는 *당일 시가 대비* 흐름으로, *전일대비* 등락칩(`change_pct`)과 다른 정보다(둘 다 가격방향 카테고리, 시간/기준만 다름). 표준 캔들봉 관습(KRX 적=양봉)과 일치.

## Goals

- 각 종목 행에 **당일 1봉 캔들 글리프**(시·고·저·종) — 고-저 심지 + 시-종 몸통, [low,high]로 스케일.
- 데이터는 **기존 10초 멀티시세 폴**에서(추가 호출·엔드포인트·누적·영속 0).
- **새로고침·기기 무관 자동** — 매 폴이 최신 O/H/L/C, 클라이언트 상태 없음.
- 디자인시스템 0 위반(토큰 + 가격방향 색만).

## Non-Goals

- 인트라데이 시계열/추세선/히스토리(스파크라인 옵션 a) — **삭제**.
- 서버 시계열 엔드포인트(옵션 b) — **폐기**.
- 분봉 캔들·당일 외 기간 — 당일 1봉만.
- 섹터 온도 스트립 변경 — 그대로 유지.
- 거래량 막대 등 추가 글리프.

## Design

### 1. 백엔드 — 멀티시세에 OHLC 노출 (additive)

`hoga/live/kis_client.py`:
- `KisQuote` 데이터클래스에 `open: int | None`, `high: int | None`, `low: int | None` 추가(기본 None).
- `_parse_quote(row)`: `inter2_oprc`/`inter2_hgpr`/`inter2_lwpr`를 `int(float(...))`로 파싱. 빈값/파싱실패/`<=0`(장전 미체결)이면 `None`. price 파싱 패턴(995–997) 재사용. 기존 price/change 로직 불변.

`hoga/live/api.py`:
- 와이어 `LiveQuote`(BaseModel)에 `open: int | None`, `high: int | None`, `low: int | None` 추가.
- `LiveQuoteFetcher`의 두 매핑(open 경로 365–366, closed 경로 381–382)에서 `open=q.open, high=q.high, low=q.low` 전달.
- `pre_open` 분기: 등락률처럼 OHLC도 숨길지? **숨기지 않는다** — 장전 동시호가엔 시/고/저가 미형성(0/None)이라 파서가 이미 None을 주고, 프론트가 결측 캔들로 처리(빈 셀). 별도 분기 불필요.

### 2. 프론트 — 캔들 글리프

`frontend/src/api/liveQuotes.ts`: `LiveQuote` 인터페이스에 `open: number | null`, `high: number | null`, `low: number | null` 추가.

`frontend/src/heatmap/CandleGlyph.tsx`(신규):
```
interface CandleGlyphProps { open: number|null; high: number|null; low: number|null; close: number|null; width?: number; height?: number; }
```
- **가드**: o/h/l/c 중 하나라도 null이거나 high<=0 또는 high<low면 `null` 반환(빈 셀; 장전·결측).
- **색**: `close >= open ? --price-up : close < open ? --price-down : --fg-dim`(도지). 몸통·심지 동색.
- **지오메트리**(viewBox `0 0 W H`, W≈10, H≈16, pad 1): y 매핑 `y(v)=pad+(1-(v-low)/(high-low||1))*(H-2pad)` (SVG 반전: 고가=위). 심지=중앙 x의 `low→high` 1px 선. 몸통=중앙 폭(≈W-2) 사각형 `min(open,close)→max(open,close)`; 높이 0(도지)이면 1px 가로선. `memo`.
- 단일 체결(o=h=l=c)·도지는 1px 선으로 안전 렌더.

`HeatmapRow.tsx`: `series?: number[]` prop 제거, `open/high/low` 추가(`close`는 기존 `price`). 스파크 셀(`<span><Sparkline/></span>`)을 `<span><CandleGlyph open={open} high={high} low={low} close={price}/></span>`로 교체. 그리드 4칼럼 폭(`3.5rem`→캔들 폭에 맞게 `2.5rem`로 좁힘) — 디테일은 plan. `onContextMenu`·드래그·클릭 계약 불변.

`HeatmapFolder.tsx`: `seriesByCode` prop 제거. 행에 `open={q?.open ?? null} high={q?.high ?? null} low={q?.low ?? null}` 전달(q=quoteByCode.get(code)). `SortableHeatmapRow`도 동일 통과.

`HeatmapBoard.tsx`: `seriesByCode` prop 제거(나머지 onRowMenu 등 불변).

`pages/Heatmap.tsx`: 누적 effect·`lastAppendedRef`·`useSparklineStore`·`useSparklineSeries`·`seriesByCode`·캡션(`스파크라인 = 장중 추세`) **삭제**. `useEffect`/`useRef` import도 미사용 시 제거. SectorTempStrip·나머지 불변.

**삭제 파일**: `frontend/src/heatmap/Sparkline.tsx`(+test), `frontend/src/heatmap/useSparklineSeries.ts`, `frontend/src/state/sparklineStore.ts`(+test).

### 3. DESIGN.md 규칙 교체

기존 "Price-direction sparkline" 항목 → "**Price-direction candle glyph (관심맵 행 전용)**": `CandleGlyph`가 당일 시·고·저·종을 1봉으로 그린다. 색 = 종가 vs 시가 부호(양봉 `--price-up`·음봉 `--price-down`·도지 `--fg-dim`); 전일대비 등락칩과 다른 기준(당일 시가 대비). 가격 방향 카테고리 준수(새 색 없음).

## Testing

### Unit — 백엔드(pytest)
| Case | Setup | Expected |
|------|------|----------|
| `_parse_quote` OHLC 정상 | inter2_oprc/hgpr/lwpr 유효 | open/high/low = int |
| `_parse_quote` OHLC 결측 | 빈값/0/누락 | open/high/low = None (price·change 영향 없음) |
| `LiveQuote` 와이어 | 매핑 | 응답에 open/high/low 포함, 기존 필드 불변 |

### Unit — 프론트(vitest)
| Case | Setup | Expected |
|------|------|----------|
| 양봉 색 | close>open | 몸통 fill = var(--price-up) |
| 음봉 색 | close<open | var(--price-down) |
| 도지 | close==open | var(--fg-dim) |
| 결측 가드 | open=null 또는 high<=0 | 렌더 없음(svg null) |
| 지오메트리 | o<c, low<high | 심지 low→high, 몸통 open→close, 고가=위(작은 y) |
| HeatmapRow 캔들 셀 | open/high/low/price 전달 | `.candle-glyph` 존재; 결측 시 '—' 개수 불변(2) |

### 기존 테스트
- **삭제**: `Sparkline.test.tsx`, `sparklineStore.test.ts`.
- **수정**: `HeatmapRow.test.tsx`(series→OHLC), `HeatmapBoard.test.tsx`(seriesByCode 제거 + 캔들), `Heatmap.test.tsx`(스파크라인 누적/캡션 테스트 삭제, 캔들 present), `HeatmapFolder.test.tsx`.

### Manual (`/heatmap`)
- 장중: 각 행에 당일 캔들(양봉 적·음봉 청), 새로고침해도 즉시 동일(누적 대기 없음).
- 다른 페이지 갔다와도 즉시 정상(상태 없음).
- closed: 당일 최종 캔들 고정. pre_open: 빈 캔들 셀.

## Risks / Open questions

- **pre_open OHLC=0**: 파서 `<=0 → None` 가드로 빈 셀. (열린 질문: 장전 예상체결 `intr_antc_cntg_*`를 쓸지 — Non-Goal, 무시.)
- **글리프 가독성(~10×16px)**: 캔들은 스파크라인보다 더 작은 정보지만 "오늘 시가 대비 어디"를 즉시 전달. plan에서 폭·패딩 튜닝.
- **v0.7.15.0 스파크라인 제거**: 배포된 기능 대체 — 의도적(사장님 방향 전환). CHANGELOG에 명시.
- **백엔드 첫 변경(이 히트맵 작업 중)**: OHLC는 additive라 다른 소비자 영향 없음(price/change 불변).

## Out of Scope (Backlog)

- 인트라데이 시계열/추세선(옵션 a/b) — 폐기.
- 분봉 캔들·당일 외 기간.
- 거래량·예상체결 글리프.
- 캔들 호버 툴팁(O/H/L/C 수치) — 원하면 후속.
