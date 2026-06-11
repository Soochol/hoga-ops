# 관심맵 행 — 당일 캔들 글리프 (스파크라인 대체) — 설계

- **Date**: 2026-06-11
- **Status**: Draft — 실응답 검증 + 그릴링(plan-eng-review 8결정) 반영 완료. 사장님 검토 대기.
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

> **캔들 색 기준(결정 A, 2026-06-11 승인)**: 몸통·심지 색 = `sign(close − open)` — **종가>시가 양봉 적(`--price-up`)·종가<시가 음봉 청(`--price-down`)·종가==시가 도지 중립(`--fg-dim`)**. ⚠️ 반드시 **strict `>`** (초안의 `close >= open`은 도지를 적색으로 보내 `--fg-dim` 분기를 dead code화 — 버그). 정수 KRW(`int`)라 `==`(보합)은 정확·빈번한 실사건이므로 sparkline의 `EPS_PP` 같은 부동소수 임계 **절대 추가 금지**. 이는 *당일 시가 대비* 흐름으로 *전일대비* 등락칩(`change_pct`)과 다른 정보다(둘 다 가격방향 카테고리, 시간/기준만 다름). 표준 캔들봉 관습(KRX 적=양봉)과 일치.

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
- `KisQuote` 데이터클래스에 `open: int | None = None`, `high: int | None = None`, `low: int | None = None` 추가(**디폴트 필수** — 무기본은 Python "non-default follows default" TypeError + 기존 positional 생성자·동등성 테스트 깨짐).
- 전용 헬퍼 `_parse_ohlc_field(raw)`: `raw in (None,"")`→None; `int(float(raw))` 실패→None; `v>0 ? v : None`. price 파서(995–997)와 달리 **0으로 위조 금지**(0은 양봉/음봉 판정·`[low,high]` 스케일 분모를 오염).
- `_parse_quote`는 **단일 return으로 리팩터**: `if not code: return None`(992) 직후 `o/h/lo = _parse_ohlc_field(row.get("inter2_oprc"/"inter2_hgpr"/"inter2_lwpr"))`로 OHLC를 뽑고, change 산출(현 998–1010의 조기-return 3곳)을 `_parse_change(row)->tuple[float|None,int|None]`로 추출한 뒤 **끝에서 한 번** `return KisQuote(code, price, change_pct=cp, change_won=cw, open=o, high=h, low=lo)`. **이유**: OHLC를 정상 return(1012)에만 붙이면 change 파싱이 바일아웃하는 종목(빈 `prdy_ctrt`·미인식 부호코드 → 1000/1004/1010)에서 유효 OHLC가 누락돼 캔들이 사라진다 — OHLC와 change는 **독립 필드군**. (리팩터 불가 시 폴백: 네 return 1000·1004·1010·1012 **전부**에 open/high/low 부착.)
- `inter2_prdy_clpr`(전일종가)는 **파싱하지 않는다** — 캔들은 `close=inter2_prpr`(price)만 쓴다(전일대비는 기존 `change_pct`가 담당).

`hoga/live/api.py`:
- 와이어 `LiveQuote`(BaseModel)에 `open: int | None = None`, `high: int | None = None`, `low: int | None = None` 추가(디폴트 부여 — 대칭·방어).
- `LiveQuoteFetcher` 두 매핑에 OHLC 전달 (스펙 초안의 365–366/381–382 줄번호는 **뒤바뀜**이라 정정):
  - **closed 경로(api.py:364–369, `_last_quotes` 서빙)** — 가드 없음(캐시가 당일/직전세션 종가): `open=q.open, high=q.high, low=q.low`.
  - **open/pre_open 경로(api.py:380–385)** — pre 게이트 적용(아래): `open=(None if pre else q.open)` 식.
- **`pre_open` 분기: OHLC도 숨긴다(pre면 None)** — `change_pct`/`change_won`과 **동일 게이트**(api.py:379, 2026-06-08 ⑧ 계약·CONTEXT.md). 근거: pre_open(08:50–09:00 장 시작 동시호가)엔 당일 **시가가 09:00 단일가 전이라 미존재** → 어떤 캔들도 "당일 캔들"이 아니고, 동시호가 예상체결가가 방향 신호(캔들색=sign(close−open))를 지면 안 된다. 명시적 None이 **KIS 장전 응답과 무관하게** 빈 셀을 보장(파서 0-가드에 베팅하지 않음 — 장전 OHLC 동작은 미검증).

### 2. 프론트 — 캔들 글리프

`frontend/src/api/liveQuotes.ts`: `LiveQuote` 인터페이스에 **선택적** `open?: number | null`, `high?: number | null`, `low?: number | null` 추가. ⚠️ **필수(`number|null`)로 하면 tsc 8에러/6파일** — 그중 `SectorTempStrip.test.tsx`(이 spec의 **Non-Goal** '섹터 온도 스트립 유지'), `screener/*`·`live/*PriceLine*` 4파일이 편집 범위 밖. **optional이면 tsc 0에러·범위밖 편집 0**이고 'additive, 다른 소비자 무영향' 불변식을 참으로 유지(removal-isolation 검증). 와이어는 항상 키를 보내지만(FastAPI 전필드 직렬화) 타입은 느슨히 두고, 호출부(HeatmapFolder)는 `q?.open ?? null`로 강제.

`frontend/src/heatmap/CandleGlyph.tsx`(신규):
```
interface CandleGlyphProps { open: number|null; high: number|null; low: number|null; close: number|null; width?: number; height?: number; }
```
- 치수 상수: `W=10, H=16, PAD=1, BODY_W=8, CX=5`.
- **가드(early-return 타입가드)**: `if (open==null||high==null||low==null||close==null||high<=0||high<low) return null;` — 이후 open/high/low/close는 모두 `number`로 좁혀짐(tsc: `number|null` 직접 비교 금지). 빈 셀(장전·결측·모순행). 교차필드 모순(high<low)은 백엔드 아닌 **여기서** 방어(일봉 파서 선례와 동형; `_parse_quote`는 표시전용 오버레이라 위반 채널 없음).
- **색(strict `>`)**: `close > open ? 'var(--price-up)' : close < open ? 'var(--price-down)' : 'var(--fg-dim)'`. 몸통(fill)·심지(stroke/fill) 동색. (`>=` 금지 — 도지 dead code.)
- **스케일**: `span=(high-low)||1; y(v)=PAD+(1-(v-low)/span)*(H-2*PAD)` (SVG 반전: 고가=위). `close`는 `clamp(close,low,high)`로 캔들 범위에 가둠(close=0 등 off-canvas 방어).
- **세그먼트 헬퍼(심지·몸통 공용 — 최소 1px·중점정렬)**: `place(a,b)={ const raw=Math.abs(a-b); const height=Math.max(raw,1); return { y:Math.min(a,b)-(height-raw)/2, height }; }`. limit-lock(high==low) 심지가 바닥 PAD에 flush로 박히는 비대칭 버그를 분기 없이 해소.
- **렌더**: 심지=`<rect>`(x=CX-0.5, 폭 1, `place(y(low),y(high))`), 몸통=`<rect>`(중앙 폭 BODY_W, `place(y(open),y(closeClamped))`; 도지는 height≈1px 가로선). 둘 다 `fill=색` + `shapeRendering="crispEdges"`. `className="candle-glyph"`(테스트 셀렉터·색 단언은 몸통 rect의 fill). `memo`(primitive props 얕은비교).

`HeatmapRow.tsx`: `series?: number[]` prop 제거, `open?/high?/low?: number|null` 추가(`close`는 기존 `price`). 스파크 셀을 `<span className="flex items-center justify-center overflow-hidden"><CandleGlyph open={open} high={high} low={low} close={price}/></span>`로 교체. 그리드를 **`grid-cols-[minmax(4rem,1fr)_2.5rem_3.2rem_4.25rem]`** (글리프 칼럼 `3.5rem`→`2.5rem`)로 명시. `onContextMenu`·드래그·클릭 계약 불변.

`HeatmapFolder.tsx`: `seriesByCode` prop 제거. 행에 `open={q?.open ?? null} high={q?.high ?? null} low={q?.low ?? null}` 전달(q=quoteByCode.get(code)). `SortableHeatmapRow`도 동일 통과.

`HeatmapBoard.tsx`: `seriesByCode` prop 제거(나머지 onRowMenu 등 불변). **`columnWidth: '12rem'` → `'16.5rem'`** + 주석 정정. 근거(합성 하니스 실측, :root 20px, 실칩 "▲+12.34"): 글리프 행 min-content ≈314px(15.7rem)인데 12rem 플로어면 multicol이 칼럼수를 올린 뒤 stretch폭이 행 min-content 미만이 되는 **board 밴드**(실측 board 800/1044/1498px 등)에서 카드(overflow-hidden)가 등락칩을 잘랐다 — **v0.7.15.0 스파크라인(3.5rem)부터 잠재**(전 구간 아님·밴드별이라 기존 '실측 오버플로 없음' 주석이 no-clip 밴드에서 통과했던 것). 플로어 ≥ 행 min-content(16.5rem)로 클리핑 밴드 제거. 주석은 파생 px를 박지 말고 "측정 행 min-content ≥ 보장"으로 서술. **한계**: board 자체가 행 min-content(~16rem)보다 좁으면(관심목록 패널 열림+좁은 뷰포트 → 단일칼럼) 어떤 플로어로도 클립 불가피(레이아웃 붕괴는 아님). 칼럼수는 viewport 아닌 **board폭(=vp−nav262.5−rail60−패널350)** 기준.

`pages/Heatmap.tsx`: 누적 effect·`lastAppendedRef`·`useSparklineStore`·`useSparklineSeries`·`seriesByCode`·캡션(`스파크라인 = 장중 추세`) **삭제**. `useEffect`/`useRef` import도 미사용 시 제거. SectorTempStrip·나머지 불변.

**삭제 파일**: `frontend/src/heatmap/Sparkline.tsx`(+test), `frontend/src/heatmap/useSparklineSeries.ts`, `frontend/src/state/sparklineStore.ts`(+test).

### 3. DESIGN.md 규칙 교체

기존 "Price-direction sparkline" 항목 → "**Price-direction candle glyph (관심맵 행 전용)**": `CandleGlyph`가 당일 시·고·저·종을 1봉으로 그린다. 색 = 종가 vs 시가 부호(양봉 `--price-up`·음봉 `--price-down`·도지 `--fg-dim`); 전일대비 등락칩과 다른 기준(당일 시가 대비). 가격 방향 카테고리 준수(새 색 없음).

## Testing

### Unit — 백엔드(pytest)
| Case | Setup | Expected |
|------|------|----------|
| `_parse_quote` OHLC 정상 | inter2_oprc/hgpr/lwpr 유효 | open/high/low = int |
| `_parse_quote` OHLC 결측 | 빈값/0/누락 | open/high/low = None |
| `_parse_quote` change 바일아웃+OHLC 유효 | 빈 prdy_ctrt + 유효 oprc/hgpr/lwpr | change=None이어도 **open/high/low=int**(단일 return 검증; test_kis_multi_price.py 확장) |
| `LiveQuoteFetcher` pre_open | phase=pre_open, 픽스처 Q에 **non-null OHLC** | open/high/low=None·price 유지(pre 게이트; test_live_quote_fetcher.py:35 확장) |
| `LiveQuoteFetcher` open/closed | open/closed | OHLC 그대로 통과·캐시(:26 확장) |
| 라우트 exact-dict | test_live_quotes_route.py:51 | 기대 dict에 open/high/low 키 추가(미전달 픽스처면 None) |

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
- **삭제 파일**: `Sparkline.tsx`(+`Sparkline.test.tsx`), `useSparklineSeries.ts`, `sparklineStore.ts`(+`sparklineStore.test.ts`).
- **수정**: `HeatmapRow.test.tsx`(series→OHLC props, `.srow-spark`→`.candle-glyph`), `HeatmapBoard.test.tsx`(seriesByCode 테스트→OHLC 캔들, 셀렉터 교체), `Heatmap.test.tsx`(스파크라인 누적/캡션 테스트·`useSparklineStore` import/reset 삭제, 캔들 present), `HeatmapFolder.test.tsx`.
- **신규**: `CandleGlyph.test.tsx`(위 프론트 Unit 케이스).
- **프론트 LiveQuote optional** 덕에 `SectorTempStrip.test.tsx`(Non-Goal)·`screener/*`·`live/*PriceLine*` 등 **범위 밖 파일 편집 0**(필수였다면 6파일 깨짐). 권위 타입체크 `tsc -p tsconfig.app.json` 0에러로 검증.

### Manual (`/heatmap`)
- 장중: 각 행에 당일 캔들(양봉 적·음봉 청), 새로고침해도 즉시 동일(누적 대기 없음).
- 다른 페이지 갔다와도 즉시 정상(상태 없음).
- closed: 당일 최종 캔들 고정. pre_open: 빈 캔들 셀.

## Risks / Open questions

- **멀티칼럼 클리핑(레이아웃)**: 글리프 칼럼이 카드 min-content를 12rem 플로어 위로 올려 특정 board 밴드에서 등락칩이 잘렸다(v0.7.15.0 스파크라인부터 잠재·전구간 아님). 16.5rem 플로어로 제거하되 **board≥~16rem에서만 오버플로 0 보장**(관심목록 패널 열림+좁은 뷰포트 → 단일칼럼 클립 불가피, 붕괴 아님). **머지 전 `/browse`로 실시세(멀티자리 칩) 채운 채 1366·1820px(패널 닫힘/열림)에서 칩 클리핑 0·칼럼수 1회 실측** ('—'/한자리 칩은 위양성 → 실시세 필수; 데몬 resize 안 되면 합성 하니스로).
- **close<=0 + 유효 OHL**: 가드(high<=0)로는 못 거르나 `clamp(close,low,high)`가 캔들 범위에 가둠(off-canvas 방어). 정상 거래면 미발생.
- **pre_open**: OHLC를 명시적 None으로 숨김(§1) — KIS 장전 OHLC 동작 미검증이라 0-가드에 베팅 안 함. (장전 예상체결 `intr_antc_cntg_*`는 Non-Goal.)
- **글리프 가독성(~10×16px)**: "오늘 시가 대비 어디"를 즉시 전달. 너무 좁으면 plan에서 글리프 2.5rem→2rem(+플로어 16rem) 옵션.
- **v0.7.15.0 스파크라인 제거**: 배포된 기능 대체 — 의도적(사장님 방향 전환). CHANGELOG에 명시.
- **백엔드 첫 변경**: OHLC는 additive라 다른 소비자 영향 없음(price/change 불변).

## Out of Scope (Backlog)

- 인트라데이 시계열/추세선(옵션 a/b) — 폐기.
- 분봉 캔들·당일 외 기간.
- 거래량·예상체결 글리프.
- 캔들 호버 툴팁(O/H/L/C 수치) — 원하면 후속.
