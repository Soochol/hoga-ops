# 종목 스크리너 (Screener) — Design

**Date**: 2026-05-31
**Status**: Draft
**Scope**: `hoga/api/screener.py` (신규), `hoga/api/screener_store.py` (신규: seed/adjust/update), `hoga/api/screener_scan.py` (신규: DuckDB 스캔), `hoga/api/scheduler.py`, `hoga/api/app.py`, `hoga/api/models.py`, `hoga/live/kis_client.py`, `frontend/src/pages/Screener.tsx` (신규), `frontend/src/screener/*` (신규), `frontend/src/api/screener.ts` (신규), `frontend/src/nav/LeftNav.tsx`, `frontend/src/main.tsx`

## Problem

사용자는 호가 리플레이를 **캡처할 가치가 있는 종목을 발굴**할 수단이 없다. 현재
진입점은 이름/코드 직접 검색뿐이며, "지금 주목할 종목"을 조건으로 거를 방법이 없다.
호가 리플레이 캡처가 hoga-ops에만 있으므로 — 스크리너 결과를 클릭하면 바로 `/live`
호가 차트로 이어지는 것이 핵심 가치 — 이 기능은 hoga-ops에 만든다.

요구 조건(사용자 확정):

- **거래대금** 임계값 필터.
- **"N일 내 M일 신고가 (고가 기준)"** — *최근 N거래일 중 하루라도, 그날 고가가
  직전 M일 최고가를 갱신한 적이 있는가* (돌파 이력; 한국 조건검색 관용구). 예: 200일 내
  500일 신고가.
- **"N일 내 M일 신고거래량"** — 위와 동일하되 거래량 기준.
- 전 종목 대상(소형주 포함).
- **시가총액 조건은 제외**(확정).

### dev-tradingview 평가 결과 (이 설계의 출발점)

`/home/dev/code/dev-tradingview`(사용자가 만든 별도 프로젝트)에 이미 동일 개념의
scanner와 데이터가 있어 재사용을 평가했다. 결론:

- **스캔 로직은 가져온다(참고).** dev-tradingview의 "N일 내 M일 신고가/신고거래량"
  쿼리는 윈도우 함수 기반이고 **이미 DuckDB 방언**(`apps/api/src/domain/scanner/`).
  hoga-ops도 이미 DuckDB-over-parquet 쿼리엔진(`hoga/api/queries.py`의 `QueryEngine`)을
  쓰므로 **검증된 윈도우 SQL을 거의 그대로 이식**한다(새 의존성 0, correctness-by-reuse).
  실측: 92MB parquet에 그 SQL을 돌려 "200일내 200일 신고가" 2,501종목을 **0.45초**에 반환.
- **27년 일봉 데이터는 가져온다(유지).** dev-tradingview의 TimescaleDB `ohlcv_daily`는
  3,561종목 × 8,458,572행, 1999-01-04 ~ 2026-05-14. DB→parquet 마이그레이션 실측
  **~10초**(Postgres→CSV 8.5초 + CSV→parquet 0.7초), 결과 **92MB**(zstd). 무시할 비용.
  단 ⚠️ **원주가(수정 미반영)** — 카카오 2021-04 5:1(558,000→120,500), 삼성전자 2018-05
  50:1(2,650,000→51,900) 분할 불연속 검증됨. **다년 신고가 정확성을 위해 보정 필요**(아래
  Design "보정" 참고).
- **시총은 dev-tradingview에 없다**(상장주식수 부재). 사용자가 시총 조건을 제외하기로 해
  쟁점 소멸.
- **교훈**: dev-tradingview의 데이터는 2026-05-14에 멈춰 있다. 원인은 in-process
  node-cron(서버 미가동 시 그날 업데이트 증발) + **관측성 0**(`cron_runs` 미기록). 우리
  업데이트는 gap 따라잡기 + staleness 가시화로 이 실패를 구조적으로 막는다.

## Invariants

- **KIS 앱키 레이트 한도 단일 공유**: 한 앱키의 모든 KIS 데이터 호출은 단일
  토큰버킷(15콜/초)을 거친다. 별도 `KisClient` 인스턴스가 각자 토큰버킷을 가지면 합산
  호출이 한도를 넘어 `EGW00201`을 유발한다. 근거: [kis_client.py](../../../hoga/live/kis_client.py) `_TokenBucket`, `_RATE_LIMIT_CALLS_PER_SEC=15.0`.
- **핫패스 모듈은 pyarrow/polars/duckdb를 import하지 않음 (ADR-0038)**: 라이브 캡처
  핫패스(`hoga/live/*` write-path, `kis_client.py`)는 무거운 데이터 라이브러리를 import하지
  않는다. 근거: ADR-0038, `kis_client.py` 헤더 주석.
- **Catch-up Run = gap 따라잡기 (ADR-0034 부근)**: hoga-ops는 이미 "마지막 성공일과 오늘
  사이의 빈 거래일을 따라잡는다"는 패턴을 Watchlist에 보유(`scheduler.catchup_one_entry`).
  서버 다운타임을 견디고 놓침이 누적되지 않는다. 근거: CONTEXT.md "Catch-up Run",
  [scheduler.py](../../../hoga/api/scheduler.py).
- **activeCode 단일 진실원천 (ADR-0052)**: `/live` 차트 Code는
  `useLivePageStore.activeCode` 하나가 결정. 헤더 검색·Watchlist Panel은 writer. 근거:
  CONTEXT.md "activeCode".
- **DuckDB-over-parquet 읽기 패턴**: hoga-ops의 분석 읽기경로는
  `duckdb.connect(":memory:")`로 parquet을 직접 쿼리(`hoga/api/queries.py`). 스크리너 스캔도
  이 idiom을 따른다.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| KIS 앱키 레이트 한도 단일 공유 | preserves | 스크리너 일일 업데이트는 라이브 폴러와 **동일 `KisClient`(동일 토큰버킷)** 를 공유, EOD/폴러 idle 시간대에 실행. |
| 핫패스 pyarrow/duckdb 금지 (ADR-0038) | preserves | seed/adjust/scan(duckdb·polars)은 신규 `hoga/api/screener_*.py`에 두며 `hoga/live/*` 핫패스에서 import하지 않음. KIS fetch만 기존 `kis_client.py` 메서드 재사용. |
| Catch-up Run gap 패턴 | preserves (재사용) | 스크리너 업데이트는 동일 gap-따라잡기 멘탈모델을 복제(별도 store 대상). Watchlist Catch-up 코드를 직접 수정하지 않음. |
| activeCode SSOT | preserves | 결과 클릭은 `setActiveCode` writer 경로 그대로(Watchlist Panel과 동일 jump-to-chart). |
| DuckDB-over-parquet 패턴 | preserves (재사용) | 스캔은 기존 패턴을 따르는 신규 in-memory 연결. |

*의도적으로 깨는 invariant 없음.*

## Goals

- 전 종목(~3,561, ETF 제외 옵션)에 대해 `거래대금 / 신고가(N,M) / 신고거래량(N,M)` AND
  조건으로 필터링하는 전용 `/screener` 페이지.
- **검색(조회) 지연 sub-second** — 필터 선택도와 무관(실측 0.45초/27년 풀스캔).
- 신고가/신고거래량의 `(최근 N일, M일 신고)`를 UI에서 가변. **깊이 제한 없음**(27년 보유 →
  "10년 신고가"까지 가능).
- 정확성: **수정주가 기준**(분할 보정), 분할 가짜 신고가 없음.
- 데이터 최신성: 자동(EOD) + 서버시작 복구 + 수동 갱신, **staleness 항상 가시화**(silent
  staleness 불가 — dev-tradingview 실패 방지).
- 결과 행 → 캡처 워크플로우 직결: 클릭→`/live` 차트 / ♥워치리스트 / 캡처 큐.

## Non-Goals

- 시가총액 조건(확정 제외).
- 실시간(틱) 스크리닝. EOD 일봉 기준. 장중 변동은 다음 업데이트 전까지 미반영.
- 분봉(`ohlcv_minute`) 활용. dev-tradingview의 1.3억행 분봉은 스크리너 범위 밖(향후).
- OR 조건/임의 팩터(PER/PBR/수급). v1은 거래대금·신고가·신고거래량 AND.
- 멀티유저/서비스용 per-user 상태 저장(향후 서비스화 시 Postgres 별도 트랙; 일봉 store는
  parquet 유지 — Design "저장소 선택" 참고).

## Design

### 데이터 파이프라인 — raw 아카이브 → 수정주가 파생 → 스캔

```
[1회 시드] dev-tradingview DB.ohlcv_daily(원주가) ──10초──► raw 아카이브 parquet (92MB)
[매일]     KIS 원주가 신규 거래일 append (gap 따라잡기) ──────► raw 아카이브 (append-only)
[파생,싼]  raw → split 보정(A) ─────────────────────────────► 수정주가 scan store parquet
[조회]     DuckDB 윈도우 SQL (거래대금·신고가·신고거래량) ◄──┘  sub-second
```

핵심: **raw 아카이브가 진실원천**(append-only, 1999~현재 원주가), **수정주가 scan
store는 그 위에서 파생**(split 보정). 파생이 싸므로 raw가 바뀔 때마다 재계산 → 역사/신규
사이 보정 seam 없음, **분할이 파생 단계에서 자동 처리**(per-code 재빌드 불필요), raw 보존이라
보정 방식을 나중에 B(KIS 수정주가 재수집)로 교체할 escape hatch 확보.

### 컴포넌트 1 — 시드 (1회, `screener_store.seed_from_db`)

- dev-tradingview TimescaleDB `ohlcv_daily`(+`stocks`의 code/name/market/is_etf/is_halted)를
  parquet으로 내보냄. 경로: `<data_dir>/screener/ohlcv_daily_raw.parquet`,
  `<data_dir>/screener/stocks.parquet`.
- 방식(실측): `docker exec ... psql \copy (...) TO STDOUT CSV` → DuckDB
  `COPY (read_csv) TO ... (FORMAT parquet, COMPRESSION zstd)`. **~10초, 92MB.**
- DuckDB postgres scanner(ATTACH)로 한 단계 직결도 가능하나 네트워크/확장 의존이 있어 CSV
  중간 경로를 기본으로(검증됨).
- 시드는 운영 중 1회. 이후 DB 불필요(파일로 보존). DB는 dev-tradingview용으로 두거나 끔.

### 컴포넌트 2 — 수정주가 파생: 보정 A (`screener_store.derive_adjusted`)

원주가 → 수정주가 오프라인 보정(재수집 없음):

- 종목별 일봉 시계열에서 **분할/병합일 탐지**: 무상 가격 변동 외의 **하룻밤 비율 점프**가
  깨끗한 분수(≈1/2,1/3,1/5,1/10,1/50 등)에 가까운 날을 분할로 판정. 그 이전 가격에
  누적 계수를 곱하고(back-adjust), 거래량은 역수로 보정.
- 결과: `<data_dir>/screener/ohlcv_daily.parquet`(수정주가, scan store).
- polars/DuckDB 윈도우 연산(92MB 규모) → 초 단위(구현 시 실측). raw가 바뀔 때만 재파생.
- **알려진 한계**(사용자 승인): 유상증자·비율이 깔끔하지 않은 이벤트는 근사·오차 가능.
  raw 아카이브를 보존하므로, A의 정확도가 부족하면 해당 종목만(또는 전체) **B(KIS
  `FID_ORG_ADJ_PRC=0` 재수집)** 로 교체 가능 — Risks 참고.

### 컴포넌트 3 — 스캔 (조회, `screener_scan.run_scan`)

dev-tradingview `buildScanQuery`의 윈도우 SQL을 DuckDB-over-parquet로 이식(거의 verbatim).
`base` CTE = 종목별 최신 봉, 조건별 CTE를 JOIN, 거래대금 desc 정렬, LIMIT.

- **거래대금**: 인라인 `close * volume >= 임계값`(억원 입력 → 원 변환). dev-tradingview와 동일.
- **신고가 (N,M) = 돌파 이력** (이식할 핵심 SQL, 실측 0.45초):
  ```sql
  -- lookback 시작일(최근 N번째 거래일) per code
  lb_start AS (
    SELECT code, MIN(date) lb_start FROM (
      SELECT code, date, ROW_NUMBER() OVER (PARTITION BY code ORDER BY date DESC) rn
      FROM adj) t WHERE rn <= :N GROUP BY code),
  -- 롤링 M일 최대 + 윈도우 충원수
  win AS (
    SELECT code, date, high,
      MAX(high) OVER (PARTITION BY code ORDER BY date
                      ROWS BETWEEN :M-1 PRECEDING AND CURRENT ROW) AS mx,
      COUNT(*)  OVER (PARTITION BY code ORDER BY date
                      ROWS BETWEEN :M-1 PRECEDING AND CURRENT ROW) AS wc
    FROM adj),
  -- 최근 N일 내, 직전 M일 최고를 달성한(=) 가장 최근 날; 부분윈도우(wc<M) 제외
  evt AS (
    SELECT DISTINCT ON (w.code) w.code, w.date event_date
    FROM win w JOIN lb_start l ON l.code=w.code
    WHERE w.date >= l.lb_start AND w.high = w.mx AND w.wc = :M
    ORDER BY w.code, w.date DESC)
  ```
  **확정 시맨틱**(dev-tradingview 일치): lookback/period는 **거래일** 단위; 돌파 판정은
  `high = rolling_max`(**동점 포함** — 고점 터치도 돌파로 인정); `wc = M` **부분윈도우
  가드**(상장 M일 미만 신규주 가짜 신고가 제외). `daysAgo`로 가장 최근 돌파일 보고.
- **신고거래량 (N,M)**: 위와 동일하되 `volume` 기준.
- **글로벌 필터**: market(KOSPI/KOSDAQ), ETF 제외(`stocks.is_etf`), 거래정지 제외(`is_halted`).
- 결과 행: `{code, name, market, price, trade_value, prdy_ctrt?, new_high:{hit, event_date,
  days_ago, period_high}, new_high_vol:{hit, event_date, days_ago}}`. 정렬 거래대금 desc, LIMIT 1000.

### 컴포넌트 4 — 일일 업데이트 (자동+복구+수동, gap 따라잡기)

raw 아카이브 최신일과 최신 거래일 사이의 **gap을 따라잡는다**(Watchlist Catch-up과 동형):

- **트리거 3종 → 동일 gap 따라잡기 호출**:
  1. **자동**: Daily Scheduler EOD 단계에 "스크리너 gap 따라잡기" 추가(서버 가동 시).
  2. **서버 시작 시**: 부팅하며 밀린 거래일 자동 복구(17:00 미가동도 다음 기동에 복구).
  3. **수동**: 헤더 "갱신" 버튼 → 즉시 gap 따라잡기.
- **비용**: 하루치 = 전종목 KIS 1페이지씩 ≈ 3,561콜 ÷ 15 ≈ **~4분/일**. 1주 밀리면 ~30분.
- **KIS fetch**: 신규 거래일을 **원주가(`FID_ORG_ADJ_PRC=1`)** 로 받아 raw 아카이브에 append
  (DB 시드와 동일 원주가 계열 유지). 이후 수정주가 scan store 재파생(분할 자동 반영).
- **레이트리밋 공유**: 라이브 폴러와 동일 토큰버킷(15/s), EOD/idle 시간대.
- **관측성(필수)**: `screener/meta.json`에 `last_raw_date, last_built_ms, universe_size,
  derive_ms`. UI는 "마지막: YYYY-MM-DD (N거래일 뒤처짐)" 칩을 항상 표시, 뒤처지면 강조.
  진행률은 기존 `EventBus.publish('screener.update', {done,total})` → SSE.

### API (`hoga/api/screener.py`)

- `GET /api/screener` — 쿼리: `min_trade_value?, nh_enabled?, nh_recency?, nh_period?,
  nhv_enabled?, nhv_recency?, nhv_period?, markets?, exclude_etf?, exclude_halted?, q?,
  sort?, limit?`. scan store 위 DuckDB 즉시 실행. store 없으면 빈 결과 + status.
- `POST /api/screener/update` — gap 따라잡기 트리거(single-flight). 즉시 반환, 진행 SSE.
- `GET /api/screener/status` — `{last_raw_date, last_built_ms, days_behind, universe_size,
  building?}`.
- Wire Model: `ScreenerRow, ScreenerResponse, ScreenerStatus` (`hoga/api/models.py`).

### 프론트엔드 (`/screener`)

- **라우팅**: `main.tsx` `<Route path="screener">`, `LeftNav` Workspace에
  `<NavItem to="/screener" label="Screener" />`.
- **레이아웃**: 전용 페이지. 좌측 조건 패널 + 우측 결과 테이블.
  - 조건: 이름/코드 검색 · 거래대금 하한 · 신고가 토글+`최근 N일`+`M일 신고`(프리셋
    20/60/120/250 + 직접입력) · 신고거래량 동일 · 글로벌(market·ETF/정지 제외).
  - 결과 테이블: 코드·종목명·현재가·전일대비·거래대금 + **신고가/신고거래량 돌파 배지**
    (돌파일 `N일 전` tooltip). 행 액션 3종:
    - 클릭(행) → `setActiveCode(code)` + `/live` 이동(이미 /live면 차트 교체).
    - ♥ → `POST /api/watchlist` (기존 `api/watchlist.ts`).
    - 캡처 → 오늘자 Stock-Date Capture Queue 등록(기존 `api/captures.ts`).
  - 헤더: **staleness 칩**("마지막 YYYY-MM-DD · N일 뒤처짐") + "갱신" 버튼 + 진행률(SSE).
- 훅: `useScreener(filters)`, `useScreenerStatus()`, `api/screener.ts`.
- **디자인**: `DESIGN.md` 토큰 준수(UI 작업 전 정독).

### 저장소 선택 — 왜 parquet (서비스화 포함)

- 일봉은 **공용·읽기 위주·하루 1회 추가**(유저 수와 무관하게 데이터량 일정) → 컬럼형
  parquet+DuckDB가 행기반 DB보다 풀스캔 분석에 빠르고 운영비 0. hoga-ops 기존 패턴과 일치.
- 서비스화해도 일봉 store는 parquet 유지(로컬→S3는 "파일 이동"이지 재작성 아님; DuckDB가 S3
  parquet 직읽기; 스캔 SQL 이식 가능 → 락인 낮음).
- DB가 필요해지는 건 일봉이 아니라 **유저별 상태**(계정·유저 워치리스트·설정) — 서비스화 시
  Postgres를 별도 트랙으로 추가. Timescale은 고속 수집(틱/분봉)용이라 일봉 스크리너엔 이득
  없음. 따라서 지금 DB 도입은 순손해.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 돌파 동점 포함 | high가 직전 M 최대와 같음 | `=` 이므로 돌파 인정(hit) |
| 돌파 hit/날짜 | d에서 직전 M-1 최고 갱신 | `hit=true`, `event_date=d`, `days_ago` 정확 |
| 부분윈도우 가드 | 상장 M일 미만 신규주 | `wc<M` → 제외(가짜 신고가 없음) |
| N 윈도우 경계 | 돌파가 N+1일 전만 존재 | `hit=false` |
| 신고거래량 | volume 시계열 동일 로직 | 가격과 독립 계산 |
| 거래대금 임계 | close*volume 경계값 | `>=` 정확(억원→원 변환) |
| 분할 보정 정확성 | 카카오/삼성 분할 종목 | 보정 후 분할 가짜 신고가 없음(연속 시계열) |
| 분할 자동 반영 | raw에 분할일 추가 후 재파생 | scan store가 자동 re-base |
| 시드 왕복 | DB→parquet→DuckDB count | DB 행수와 일치(8,458,572) |
| gap 따라잡기 | last_raw_date < 최신거래일 | 누락 거래일만 fetch, 누적 안 됨 |
| store 없음 | 시드 전 조회 | 빈 결과 + status, 500 아님 |

**Invariant 회귀 테스트**:
- 레이트리밋 공유: 업데이트+폴러 동시 시 단일 토큰버킷 경유(주입된 동일 인스턴스).
- ADR-0038: `hoga/live/*` 핫패스가 `screener_*`/duckdb/polars를 import하지 않음(import 그래프).
- activeCode: 결과 클릭이 `setActiveCode`만 호출.

### Manual verification

- 시드 1회 → `screener/ohlcv_daily.parquet` 생성, status `universe_size` 표시.
- `/screener` "200일 내 500일 신고가" 조회 → sub-second 결과 + 배지.
- "갱신" → 진행률 → status `days_behind=0`.
- 결과 클릭 → `/live` 해당 Code 호가 차트. ♥/캡처 → Watchlist/Capture Queue 반영.

## Risks / Open questions

- **보정 A 정확도**: 유상증자·비정수 비율 이벤트는 오프라인 탐지가 근사. 검출 임계값 튜닝
  필요. **완화**: raw 아카이브 보존 → 의심 종목을 KIS 수정주가(B)로 교체하는 per-code
  fallback을 backlog에 둔다(스캔 store는 derived라 일부만 교체해도 일관 유지).
- **파생 비용 실측**: derive_adjusted를 92MB에 대해 실측해 "초 단위" 주장을 검증(구현 1순위).
- **신규일 원주가 append vs 분할일**: 분할일은 raw에 자연 반영(원주가가 실제로 하락) →
  파생이 자동 처리. 별도 분할 이벤트 API 의존 없음(탐지 기반).
- **DB 가용성**: 시드는 dev-tradingview DB가 켜져 있을 때 1회. 꺼졌다면 docker compose up 후
  시드. 시드 후 영구 비의존.
- **레이트리밋 경합**: 업데이트 중 `/live` 동시 사용 시 폴러+업데이트가 15/s 분할 → 업데이트가
  느려질 뿐 정확성 무해(동일 버킷).

## Out of Scope (Backlog)

- 분봉(`ohlcv_minute`, 1.3억행) 활용 — 분봉 기반 조건/리플레이.
- 보정 B(KIS 수정주가) per-code fallback, A/B 교차검증 리포트.
- 추가 조건(등락률·이평선 배열·PER/PBR), OR 로직, 저장 프리셋(dev-tradingview `scanner_configs`
  JSONB 모델 참고).
- 서비스화: 유저별 상태용 Postgres, 일봉 parquet의 S3 이전, 동시성 스케일아웃.
- 시가총액 조건(상장주식수 소스 확보 시; KIS output1 `hts_avls` 경로 존재).
