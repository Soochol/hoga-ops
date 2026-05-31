# 종목 스크리너 (Screener) — Design

**Date**: 2026-05-31
**Status**: Draft
**Scope**: `hoga/api/screener.py` (신규), `hoga/api/screener_store.py` (신규: seed/derive/update), `hoga/api/screener_scan.py` (신규: DuckDB 스캔), `hoga/api/scheduler.py`, `hoga/api/app.py`, `hoga/api/models.py`, `hoga/live/kis_client.py`, `hoga/live/lifecycle.py` (KisClient 프로세스 싱글턴화), `frontend/src/pages/Screener.tsx` (신규), `frontend/src/screener/*` (신규), `frontend/src/api/screener.ts` (신규), `frontend/src/nav/LeftNav.tsx`, `frontend/src/main.tsx`

> grill-with-docs(2026-05-31)로 critic 패널 22개 발견을 반영: 네이밍 충돌 해소(`raw`→`unadjusted`, `meta.json`→`status.json`, `ohlcv_daily`→`daily_*`, `scanner`→`Screener/scan`), 수정주가 SSOT 일관성(보정 A + KIS 교차검증), KisClient 프로세스 싱글턴, 타입 경계 조이기.

## Problem

사용자는 호가 리플레이를 **캡처할 가치가 있는 종목을 발굴**할 수단이 없다. 진입점이
이름/코드 직접 검색뿐이라 "지금 주목할 종목"을 조건으로 거를 수 없다. 호가 리플레이
캡처가 hoga-ops에만 있으므로 — 스크리너 결과 클릭 → 바로 `/live` 호가 차트 — 이 기능은
hoga-ops에 만든다.

요구 조건(사용자 확정): **거래대금** 임계값 · **"N일 내 M일 신고가/신고거래량"**(돌파
이력) · 전 종목(소형주 포함) · **시가총액 조건 제외**.

### dev-tradingview 평가 결과 (출발점)

`/home/dev/code/dev-tradingview`에 동일 개념 scanner와 27년 일봉 데이터가 있어 재사용 평가:

- **스캔 로직 이식**: dev-tradingview의 "N일 내 M일 신고가/신고거래량" 윈도우 SQL은 이미
  DuckDB 방언. hoga-ops도 DuckDB-over-parquet 쿼리엔진(`hoga/api/queries.py`)을 쓰므로
  거의 verbatim 이식(새 의존성 0). 실측: 92MB parquet에 그 SQL → "200일내 200일 신고가"
  **0.45초** 반환.
- **27년 일봉 유지**: dev-tradingview TimescaleDB `ohlcv_daily` 3,561종목 × 8,458,572행,
  1999-01-04 ~ 2026-05-14. DB→parquet 마이그레이션 실측 **~10초**(Postgres→CSV 8.5초 +
  CSV→parquet 0.7초), 결과 **92MB**(zstd). markets = KOSPI 1797 / KOSDAQ 1764(제3시장
  없음), ETF 745. 단 ⚠️ **원주가**(카카오 5:1·삼성 50:1 분할 불연속 검증) — 다년 신고가
  정확성 위해 보정 필요(Design "수정주가 파생").
- **시총은 dev-tradingview에 없음**(상장주식수 부재). 사용자가 시총 조건 제외 → 쟁점 소멸.
- **교훈**: dev-tradingview 데이터는 2026-05-14에 멈춤(in-process cron + 관측성 0). 우리는
  gap 따라잡기 + staleness 가시화로 구조적으로 방지.

## Invariants

- **KIS 앱키 레이트 한도 단일 공유**: 한 앱키의 모든 KIS 호출은 단일 토큰버킷(15콜/초)을
  거쳐야 한다. 별도 `KisClient` 인스턴스는 각자 버킷을 가져 합산이 한도를 넘어 `EGW00201`을
  유발. 근거: [kis_client.py](../../../hoga/live/kis_client.py) `_TokenBucket`,
  `_RATE_LIMIT_CALLS_PER_SEC=15.0`. **현 상태의 약점**: 버킷이 폴러 소유
  (`lifecycle._kis_client`, 폴러 stop 시 None) → EOD 업데이트가 돌 때 공유 대상이 없을 수
  있음. 이 spec이 **프로세스 싱글턴으로 격상해 invariant를 강화한다**(Invariant impact 참고).
- **핫패스 모듈은 pyarrow/polars/duckdb를 import하지 않음 (ADR-0038)**: `hoga/live/*`
  write-path·`kis_client.py`는 무거운 데이터 라이브러리를 import하지 않는다.
- **Catch-up Run = gap 따라잡기**: hoga-ops는 "마지막 성공일~오늘 사이 빈 거래일을 따라잡는"
  패턴을 Watchlist에 보유(`scheduler.catchup_one_entry`). 서버 다운타임을 견딘다. 근거:
  CONTEXT.md "Catch-up Run".
- **activeCode 단일 진실원천 (ADR-0052)**: `/live` 차트 Code는 `useLivePageStore.activeCode`.
- **Code는 문자열, leading-zero 유의 (CONTEXT.md "Code")**: `005930`은 6자리 문자열이며
  정수 5930이 아니다. **시드 경로(psql copy → CSV → DuckDB)에서 CSV는 dtype가 없어 자동추론이
  005930을 BIGINT로 뭉갤 위험** → 이 spec은 전 구간 VARCHAR를 강제한다.
- **Wire Model은 도메인 이름 (CONTEXT.md "Wire Model")**: 클라이언트가 보는 필드는 KIS 원시
  필드명이 아니라 도메인 이름(`ApiCandle.open` 등). → 결과 행은 `prdy_ctrt`가 아니라
  `change_pct`.
- **DuckDB-over-parquet 읽기 패턴**: 분석 읽기경로는 `duckdb.connect(":memory:")`로 parquet
  직접 쿼리(`hoga/api/queries.py`). 스크리너 스캔도 이 idiom.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| KIS 레이트 한도 단일 공유 | **strengthens(의도적 강화)** | KisClient를 **폴러 소유 → 프로세스 싱글턴**으로 격상(`lifecycle`에서 lifespan 생성·보존, stop과 무관). 폴러·업데이트가 같은 인스턴스/버킷 공유 → 폴러 on/off 무관하게 항상 15/s 한 버킷. 폴러 idle 시엔 업데이트가 유일 호출자라 자명히 안전. |
| 핫패스 pyarrow/duckdb 금지 (ADR-0038) | preserves | seed/derive/scan(duckdb·polars)은 `hoga/api/screener_*.py`; `hoga/live/*`에서 import 안 함. KIS fetch만 기존 `kis_client.py` 메서드 재사용. |
| Catch-up Run gap 패턴 | preserves(재사용) | 업데이트가 동일 gap-따라잡기 멘탈모델 복제(별도 store). |
| activeCode SSOT | preserves | 결과 클릭은 `setActiveCode` writer 경로. |
| Code 문자열/leading-zero | preserves(명시 강제) | 시드·parquet·스캔·결과 전 구간 VARCHAR. round-trip 회귀 테스트. |
| Wire Model 도메인 이름 | preserves | 결과 필드 `change_pct`(KIS `prdy_ctrt` 미노출). |
| DuckDB-over-parquet | preserves(재사용) | 신규 in-memory 연결. |

*의도적으로 깨는 invariant 없음. KIS 레이트 한도는 의도적으로 **강화**.*

## Goals

- 전 종목(~3,561, ETF 제외 옵션)에 `거래대금 / 신고가(N,M) / 신고거래량(N,M)` AND 필터
  전용 `/screener` 페이지.
- **조회 지연 sub-second**(실측 0.45초/27년 풀스캔), 필터 선택도 무관.
- `(Lookback Window N, Record Period M)` UI 가변, **깊이 제한 없음**(27년 보유).
- 정확성: **수정주가 기준, KIS 공식 수정주가와 일치**(보정 A + KIS 교차검증), 분할 가짜
  신고가 없음, Code leading-zero 보존.
- 데이터 최신성: 자동(EOD)+서버시작 복구+수동, **staleness 항상 가시화**.
- 결과 행 → 클릭 차트 / ♥워치리스트 / 캡처 큐.

## Non-Goals

- 시가총액 조건(확정 제외). 실시간 틱 스크리닝. 분봉 활용. OR 조건/임의 팩터. 멀티유저
  per-user 상태(서비스화 시 Postgres 별도 트랙; 일봉 store는 parquet 유지).

## Design

### 용어 (CONTEXT.md 등재)

- **Screener** — 이 기능/페이지. 조회 연산은 동사 **scan**(`run_scan`). dev-tradingview의
  "scanner" 명칭은 _Avoid_(hoga 네임스페이스 통일).
- **Lookback Window (N)** — 돌파를 찾는 최근 거래일 수("최근 200일").
- **Record Period (M)** — 신고 판정의 직전 거래일 수("500일 신고가"). N·M 모두 거래일.
- **Breakout(돌파)** — 어떤 날의 값이 직전 M-1일 최고를 달성(`>=`, 동점 포함)한 사건. 신고가
  ·신고거래량이 공유하는 개념.

### 데이터 파이프라인 — 원주가 아카이브 → 수정주가 파생 → 스캔

```
[1회 시드] dev-tradingview DB(원주가) ──10초──► daily_unadjusted.parquet (원주가 아카이브, 92MB)
[매일]     KIS 원주가 신규 거래일 append (gap 따라잡기) ─────────────► daily_unadjusted.parquet (append-only)
[싼 파생]  보정 A(오프라인 split) + KIS 수정주가 교차검증 ──────────► daily_adjusted.parquet (수정주가, 스캔 대상)
[조회]     DuckDB 윈도우 SQL (거래대금·신고가·신고거래량) ◄─────────┘  sub-second
```

**원주가 아카이브가 진실원천**(append-only), **수정주가는 파생**. 파생이 싸 raw 변경 시
재계산 → 보정 seam 없음, 분할 자동 처리, 아카이브 보존이라 정확도 escape hatch 확보.

### 컴포넌트 1 — 시드 (1회, `screener_store.seed_from_db`)

- dev-tradingview `ohlcv_daily`(+`stocks`의 code/name/market/is_etf/is_halted)를 parquet으로.
  경로: `<data_dir>/screener/daily_unadjusted.parquet`, `<data_dir>/screener/stocks.parquet`.
- 방식(실측): `docker exec ... psql \copy (...) TO STDOUT CSV` → DuckDB
  `COPY (read_csv(..., types={'code':'VARCHAR'})) TO ... (FORMAT parquet, COMPRESSION zstd)`.
  **~10초, 92MB.** **`code`는 전 구간 VARCHAR 강제**(read_csv dtype override; parquet code
  컬럼 VARCHAR) — 005930 round-trip 보존.
- **parquet 스키마(확정)**: `daily_unadjusted`/`daily_adjusted` = `{code:VARCHAR, date:DATE,
  open:DOUBLE, high:DOUBLE, low:DOUBLE, close:DOUBLE, volume:BIGINT}`. `stocks` =
  `{code:VARCHAR, name:VARCHAR, market:VARCHAR, is_etf:BOOLEAN, is_halted:BOOLEAN}`.
- 시드는 1회. 이후 DB 비의존. `screener/`는 parquet/raw/timing/live와 나란한 **새 top-level
  sibling**(Stock-Date 스코프가 아닌 전역 코퍼스라 flat 의도적).

### 컴포넌트 2 — 수정주가 파생: 보정 A + KIS 교차검증 (`screener_store.derive_adjusted`)

수정주가 SSOT는 **KIS 공식 수정주가**(/live와 일치)이되, 비용을 위해 오프라인 A를 1차로:

- **1차 — 오프라인 A**: 종목별 원주가에서 분할/병합일(하룻밤 비율 점프가 깨끗한 분수
  ≈1/2,1/5,1/10,1/50)을 탐지해 back-adjust(가격 곱·거래량 역수).
- **2차 — KIS 교차검증·per-code 폴백**: A의 보정 비율이 **깨끗하지 않은(유상증자 등) 의심
  종목만** KIS 수정주가(`FID_ORG_ADJ_PRC=0`, /live가 쓰는 바로 그 값)로 대조해, 갈리면 그
  종목을 KIS 수정주가로 교체. 분할 안 한 대다수는 A=KIS라 그대로 → **전종목 재수집 회피 +
  /live와 일치**.
- 결과: `<data_dir>/screener/daily_adjusted.parquet`(스캔 대상). raw 변경 시 재파생.
- 비용: polars/DuckDB 윈도우 연산(92MB) → 초 단위(구현 시 실측). 의심 종목 KIS 호출만 추가.

### 컴포넌트 3 — 스캔 (조회, `screener_scan.run_scan`)

dev-tradingview `buildScanQuery`의 윈도우 SQL을 DuckDB-over-parquet로 이식(거의 verbatim).
SQL의 `lookback`(N)/`period`(M)를 **그대로** 쓴다(wire 파라미터도 `nh_lookback`/`nh_period`로
일치 — 반쪽 명명 제거).

- **거래대금**: 인라인 명명 표현식 `trade_value_won := close * volume`, `>= min_trade_value_eok
  * 1e8`. (억원 입력 → 원 환산; SQL 텍스트 한 곳에서 정의.)
- **신고가 (N,M)** — 핵심 이식 SQL(실측 0.45초): `lb_start`(최근 N번째 거래일) → 롤링 M일
  최대 `MAX(high) OVER (... ROWS BETWEEN M-1 PRECEDING AND CURRENT ROW)` + 윈도우 충원수
  `COUNT(*) OVER w` → 최근 N일 내 `high = mx AND wc = M`인 가장 최근 날(`DISTINCT ON`).
  시맨틱: **거래일 단위**, 돌파 `>=`(**동점 포함**, dev-tradingview 일치), **`wc=M` 부분윈도우
  가드**(상장 M일 미만 신규주 제외).
- **신고거래량 (N,M)**: 동일하되 `volume` 기준.
- **글로벌 필터**: `markets: list[Literal['KOSPI','KOSDAQ']]`, ETF 제외(`is_etf`), 정지
  제외(`is_halted`).

### 컴포넌트 4 — 일일 업데이트 (자동+복구+수동, gap 따라잡기)

원주가 아카이브 최신일~최신 거래일 gap을 따라잡는다(Watchlist Catch-up과 동형):

- **트리거 3종 → 동일 호출**: ① Daily Scheduler EOD 단계 ② 서버 시작 시 복구 ③ 헤더 "갱신".
- **KIS fetch**: 신규 거래일을 **원주가(`FID_ORG_ADJ_PRC=1`)** 로 받아 아카이브 append →
  수정주가 재파생. ⚠️ `fetch_past_daily_candles`는 현재 `FID_ORG_ADJ_PRC='0'` 하드코딩
  (/live·ADR-0048 의존) → **플래그를 인자화**(기본 `'0'` 유지로 /live 보존, 스크리너만 `'1'`).
- **KisClient**: `lifecycle`의 **프로세스 싱글턴**을 `get_kis_client()`로 획득(폴러와 동일
  버킷). 폴러 미가동 시에도 싱글턴 존재(lifespan 생성). 비용 ~4분/일(전종목 1페이지씩).
- **관측성(필수)**: `screener/status.json` = 타입드 pydantic 모델 `ScreenerStatusFile{
  schema_version:int, last_raw_date:str(YYYYMMDD), last_built_ms:int, universe_size:int,
  derive_ms:int}` (구버전은 default 채움). UI는 "마지막 YYYY-MM-DD (N거래일 뒤처짐)" 칩,
  뒤처지면 강조. 진행률 `EventBus.publish('screener.update', {done,total})` → SSE.

### API (`hoga/api/screener.py`)

- `GET /api/screener` — 쿼리: `min_trade_value_eok?`, `nh_lookback?`+`nh_period?`(둘 다-또는-
  둘 다-없음, 라우트에서 `NewHighFilter{lookback≥1, period≥1}|None`로 조립), `nhv_lookback?`+
  `nhv_period?`, `markets?`(repeated, Literal), `exclude_etf?`, `exclude_halted?`, `q?`,
  `sort?`(Literal), `limit?`. 상한: `lookback+period > 가용 깊이`면 클램프 + `truncated`
  경고(silent cap 금지). `period > lookback` 허용(헤드라인 200내500).
- `POST /api/screener/update` — gap 따라잡기(single-flight). 즉시 반환, 진행 SSE.
- `GET /api/screener/status` — `ScreenerStatusFile` + `days_behind` 파생.
- **Wire Model**(`hoga/api/models.py`):
  - `Breakout` 판별 union: `BreakoutHit{hit:Literal[True], event_date:str, days_ago:int,
    period_extreme:int}` | `BreakoutMiss{hit:Literal[False]}`. 신고가의 `period_extreme`=기간
    최고가, 신고거래량의 `period_extreme`=기간 최대거래량(대칭).
  - `ScreenerRow{code:str, name:str, market:Literal['KOSPI','KOSDAQ'], price:int,
    trade_value_won:int, change_pct:float|None, new_high:Breakout|None,
    new_high_vol:Breakout|None}`. 필터 off면 해당 Breakout=None(omit).
  - `ScreenerResponse{status:Literal['ok','not_seeded','building'], rows:list[ScreenerRow]}`
    — **빈 rows의 의미를 status가 판별**(not_seeded=시드 필요 vs ok+rows=[]=0매칭). `building`은
    `/status`와 단일 진실원천 공유.

### 프론트엔드 (`/screener`)

- 라우팅: `main.tsx` `<Route path="screener">`, `LeftNav`에 `Screener`.
- 좌측 조건 패널: 이름/코드 검색 · 거래대금 하한(억원) · 신고가 토글+`Lookback`+`Period`
  (프리셋 20/60/120/250+직접입력) · 신고거래량 동일 · market/ETF/정지 필터.
- 결과 테이블: 코드·종목명·현재가·전일대비(`change_pct`)·거래대금 + 신고가/신고거래량 **돌파
  배지**(`days_ago` tooltip) + 3액션(클릭→차트 `setActiveCode` / ♥ `POST /api/watchlist` /
  캡처 `api/captures.ts`).
- 헤더: staleness 칩 + "갱신" 버튼 + 진행률(SSE). `status='not_seeded'`면 "시드 필요" 안내.
- `DESIGN.md` 토큰 준수.

### 저장소 선택 — parquet (서비스화 포함)

일봉은 공용·읽기 위주·하루 1회 추가 → 컬럼형 parquet+DuckDB가 풀스캔에 유리, hoga 패턴
일치. 서비스화해도 parquet 유지(로컬→S3=파일 이동). DB는 유저별 상태용으로 그때 Postgres
별도 추가. Timescale은 고속 수집(틱/분봉)용이라 일봉 스크리너엔 이득 없음.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| Code round-trip | 005930 시드→parquet→scan→결과 | 6자리 문자열 보존(BIGINT 5930 아님) |
| 돌파 동점 포함 | high=직전 M 최대와 같음 | `>=` → 돌파 인정 |
| 돌파 hit/날짜 | d에서 직전 M-1 최고 갱신 | `BreakoutHit{event_date=d, days_ago}` |
| 부분윈도우 가드 | 상장 M일 미만 | `wc<M` → 제외 |
| N 윈도우 경계 | 돌파가 N+1일 전만 | `BreakoutMiss` |
| 필터 off | nh_lookback 없음 | `new_high=None`(omit) |
| 필터 짝 검증 | nh_lookback만 주고 nh_period 없음 | 422(둘 다-또는-없음) |
| 깊이 클램프 | lookback+period > 깊이 | 결과 + `truncated` 경고 |
| 보정 A=KIS | 분할 종목 A보정 vs KIS adjusted | 일치(동일 다년 신고가) |
| KIS 폴백 | 유상증자 등 A≠KIS 종목 | KIS 수정주가로 교체됨 |
| status 판별 | 시드 전 / 0매칭 | `not_seeded` / `ok`+rows=[] |
| markets Literal | 잘못된 market 값 | 422 |
| 시드 왕복 | DB→parquet count | 8,458,572 |
| gap 따라잡기 | last_raw_date < 최신거래일 | 누락일만 fetch, 누적 안 됨 |

**Invariant 회귀**: KisClient 싱글턴(폴러+업데이트 단일 버킷); ADR-0038 import 그래프;
activeCode setter; Code VARCHAR round-trip; `change_pct`(prdy_ctrt 미노출).

### Manual verification

- 시드 1회 → `daily_unadjusted.parquet`/`daily_adjusted.parquet` 생성, status `universe_size`.
- `/screener` "200일 내 500일 신고가" → sub-second + 배지. 분할 종목(카카오 등) 고가가 /live
  차트와 일치.
- "갱신" → 진행률 → `days_behind=0`. 결과 클릭 → `/live` 호가 차트.

## Risks / Open questions

- **보정 A 정확도**: 유상증자 등은 오프라인 탐지 근사 → **KIS 교차검증·per-code 폴백으로
  완화**(의심 종목만 KIS 수정주가로 교정, /live와 일치). 의심 판정 임계값 튜닝 필요.
- **파생 비용 실측**: derive_adjusted를 92MB에 실측(구현 1순위).
- **KisClient 싱글턴 리팩터**: `lifecycle`의 폴러-소유 → 프로세스-소유 격상은 폴러 start/stop
  경로를 건드림 → plan에서 회귀 주의(stop이 클라이언트를 null하지 않게).
- **`fetch_past_daily_candles` 플래그 인자화**: 기본 `'0'` 유지로 /live(ADR-0048) 보존 확인.
- **DB 가용성**: 시드는 dev-tradingview DB 가동 시 1회. 이후 영구 비의존.

## Out of Scope (Backlog)

- 분봉(`ohlcv_minute`) 활용. 추가 조건(등락률·이평선·PER/PBR), OR 로직, 저장 프리셋
  (dev-tradingview `scanner_configs` JSONB 참고 — 단 hoga에선 `screener_presets`로 명명).
- 서비스화: 유저 상태용 Postgres, parquet S3 이전. 시가총액(상장주식수 소스 확보 시,
  KIS output1 `hts_avls`).
