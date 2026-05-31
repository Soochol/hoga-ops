# 종목 스크리너 (Screener) — Design

**Date**: 2026-05-31
**Status**: Draft
**Scope**: `hoga/api/screener.py` (신규), `hoga/api/screener_cache.py` (신규), `hoga/api/scheduler.py`, `hoga/api/app.py`, `hoga/api/models.py`, `hoga/live/kis_client.py`, `frontend/src/pages/Screener.tsx` (신규), `frontend/src/screener/*` (신규), `frontend/src/api/screener.ts` (신규), `frontend/src/nav/LeftNav.tsx`, `frontend/src/main.tsx`

## Problem

사용자는 호가 리플레이를 **캡처할 가치가 있는 종목을 발굴**할 수단이 없다. 현재
종목 진입점은 이름/코드 직접 검색(Symbol Master)뿐이며, "지금 주목할 종목"을
조건으로 거를 방법이 없다. 사용자가 명시한 조건:

- 시가총액 / 거래대금 임계값 필터
- **"200일 내 500일 신고가 (고가 기준)"** — *최근 N거래일 중 하루라도, 그날
  고가가 직전 M일 최고가를 돌파한 적이 있는가* (돌파 이력; 한국 조건검색 관용구).
- **"300일 내 500일 신고거래량"** — 위와 동일하되 거래량 기준.
- 전 종목 대상(소형주 포함). 사용자 인용: *"kis 방식으로 전 종목 검색해야 하는데,
  가능해?"* → 결론: 가능. 단 *실시간 온디맨드 전종목 스캔*이 아니라
  **야간 사전빌드 캐시 + 즉시 조회**의 형태로.

데이터 소스 검증 결과(2026-05-31, 라이브 KIS 호출):

- KIS `inquire-daily-itemchartprice` (FHKST03010100) **1콜**이 `output1`에
  시가총액(`hts_avls`, 억원)·상장주식수·거래대금(`acml_tr_pbmn`)·전일대비율·PER/PBR을,
  `output2`에 일봉 이력(고가·저가·시·종가·거래량·일별 거래대금)을 동봉한다. 즉
  스크리너가 필요로 하는 모든 데이터가 한 엔드포인트에서 나온다 → pykrx 불필요.
- `FID_ORG_ADJ_PRC="0"` = **수정주가**(카카오 035720 2021-04 5:1 분할 검증: `0`→
  100,759 연속 / `1`→502,000 원주가, 비율 4.98≈5). 다년 신고가 비교는 반드시 수정주가
  기준이어야 하며 이 값이 코드베이스가 이미 쓰는 값이다.
- 830행(3년+) 일봉 fetch = 0.25초, 레이트리밋 15콜/초.

## Invariants

이 spec이 건드리거나 의존하는, 시스템이 **현재 보존하고 있는** 속성들:

- **KIS 앱키 레이트 한도 단일 공유**: 한 앱키에 대한 모든 KIS 데이터 호출은 단일
  토큰버킷(15콜/초)을 거친다. 별도 `KisClient` 인스턴스가 각자 토큰버킷을 가지면
  합산 호출이 한도를 넘어 `EGW00201`을 유발한다. 근거: [kis_client.py](../../../hoga/live/kis_client.py) `_TokenBucket`, `_RATE_LIMIT_CALLS_PER_SEC=15.0`.
- **핫패스 모듈은 pyarrow/polars를 import하지 않음 (ADR-0038)**: 라이브 캡처
  핫패스(`hoga/live/*` write-path, `kis_client.py`)는 무거운 데이터프레임 라이브러리를
  import하지 않는다. 근거: ADR-0038, `kis_client.py` 헤더 주석.
- **Daily Scheduler는 Capture Queue의 client (ADR-0034)**: 스케줄러는
  `enqueue_items_core`만 호출하고 `_queue`/`_active`/`_done`을 직접 만지지 않는다.
  근거: [scheduler.py](../../../hoga/api/scheduler.py) 헤더, CONTEXT.md "Daily Scheduler".
- **activeCode 단일 진실원천 (ADR-0052)**: `/live` 차트에 렌더되는 Code는
  `useLivePageStore.activeCode` 하나가 결정한다. 헤더 검색·Watchlist Panel은 writer,
  차트는 reader. 근거: CONTEXT.md "activeCode".
- **Symbol Master 캐시 계약 (ADR-0006/0015)**: 디스크 캐시 + single-flight 코디네이터
  + `fresh/loading/stale/unavailable` 상태 + 명시적 refresh 트리거. 근거:
  [symbols.py](../../../hoga/api/symbols.py).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| KIS 앱키 레이트 한도 단일 공유 | preserves | 스크리너 빌드는 라이브 폴러와 **동일 `KisClient`(또는 동일 토큰버킷)** 을 공유한다. 또한 콜드/증분 빌드는 폴러가 idle한 **야간(스케줄러 17:00 단계)** 에 돈다. |
| 핫패스 pyarrow 금지 (ADR-0038) | preserves | 캐시 빌드/쿼리(polars 사용)는 신규 `hoga/api/screener_cache.py`에 두며 `hoga/live/*` 핫패스에서 import하지 않는다. KIS fetch만 기존 `kis_client.py`(핫패스) 메서드 재사용. |
| Daily Scheduler = Queue client | preserves | 스크리너 빌드는 큐와 무관한 **독립 단계**를 `_daily_run`에 추가할 뿐, `enqueue_items_core` 계약을 건드리지 않는다(Promotion 단계와 동급의 Scheduler-owned 작업). |
| activeCode SSOT | preserves | 결과 행 클릭은 `useLivePageStore.setActiveCode` writer 경로를 그대로 사용 — Watchlist Panel과 동일한 jump-to-chart 패턴. |
| Symbol Master 캐시 계약 | preserves | 스크리너는 동일 패턴을 **복제**(별도 디스크 캐시 + 상태 + 빌드 트리거)하되 Symbol Master 모듈 자체는 수정하지 않는다. 종목 리스트만 읽어 재사용. |

*의도적으로 깨는 invariant 없음.*

## Goals

- 전 종목(~2,900)에 대해 `시총 / 거래대금 / 신고가(N,M) / 신고거래량(N,M)` AND 조건으로
  필터링하는 전용 `/screener` 페이지.
- **검색(조회) 지연 ~1초** — 필터 선택도(selectivity)와 무관. 사용자가 임계값 없이
  breakout 조건만 켜도 동일.
- 신고가/신고거래량의 룩백 파라미터 `(최근 N일, M일 신고)`를 UI에서 가변. 캐시 깊이
  **1,500거래일**까지 지원(N≤250 + M≤1,250(5년) 조합).
- 결과 행에서 캡처 워크플로우로 직결: 클릭→차트 이동 / ♥워치리스트 추가 / 캡처 큐 등록.
- 다년 신고가의 **정확성**: 수정주가 기준, 분할/증자 가짜 신고가 없음.
- 비용 투명성: 콜드 빌드/증분/조회 시간을 UI에 명시(silent cap 없음).

## Non-Goals

- 실시간(틱) 스크리닝. 데이터는 EOD 일봉 기준. 장중 가격 변동은 다음 야간 빌드(또는
  수동 빌드) 전까지 반영 안 됨.
- pykrx 사용. 종목 리스트는 기존 Symbol Master 재사용, 스크리닝 데이터는 100% KIS.
- 임의 팩터(PER/PBR/외국인 등) 스크리닝. v1 조건은 시총·거래대금·신고가·신고거래량으로 한정.
- 사용자별 조건 프리셋 저장/공유. 단일 사용자 로컬 도구.

## Design

### 큰 그림 — 사전빌드 + 즉시 조회 2분리

쿼리당 deep fetch를 하지 않는다(그러면 쿼리 지연이 필터 선택도에 의존하고, 임계값
없는 breakout 조건은 전종목 deep = 분 단위가 된다). 대신:

```
[야간/수동 빌드]  KIS 전종목 일봉(수정주가, 1,500일) ──► 디스크 캐시(raw 일봉)
                                                              │
[조회 ~1초]       시총·거래대금 임계값 + (N,M) 롤링맥스  ◄────┘  polars in-memory
```

캐시는 **raw 일봉**이므로 `(N, M)` 파라미터와 무관 → 어떤 조건 조합도 같은 캐시 위에서
즉시 조회된다.

### 컴포넌트 1 — 스크리너 캐시 (`hoga/api/screener_cache.py`)

디스크 영속 캐시(라이브 일봉 캐시는 메모리 전용·per-active-code라 ADR-0048; 스크리너는
전종목·재시작 생존이 필요해 **디스크**로 별도 정의 — 분봉 `PastCandlesCache`의 디스크
패턴에 대응).

- **레이아웃**: 단일 columnar `<data_dir>/screener/candles.parquet` (polars 벌크
  로드·rolling 연산 효율을 위해 종목별 파일이 아닌 단일 파일로 확정). 컬럼:
  `code, date(YYYYMMDD), high, low, open, close, volume, value(거래대금)`. 수정주가.
  거래대금/시총 임계값은 UI에서 억원 단위로 받아 내부 원 단위와 변환.
- **메타**: `<data_dir>/screener/meta.json` — `{schema_version, built_at_ms,
  depth_trading_days, universe_size, per_code_summary: {code: {name, market_cap,
  trade_value, price, prdy_ctrt, listed_days}}}`. `per_code_summary`는 KIS `output1`에서
  채워 시총/거래대금 임계값 필터를 일봉 로드 없이 즉시 적용 가능하게 한다.
- **상태**: Symbol Master와 동형 — `fresh / loading / stale / unavailable` +
  `built_at_ms`. single-flight 코디네이터로 동시 빌드 트리거 합치기.
- **깊이**: `depth_trading_days = 1500`(승인됨). 그보다 깊은 조건 요청 시 쿼리는
  가용 깊이로 클램프하고 응답에 `truncated_to_depth` 경고를 싣는다(silent cap 금지).

### 컴포넌트 2 — 빌드 잡 (`screener_cache.build`)

- **KIS fetch**: 종목 리스트(Symbol Master) × `fetch_past_daily_candles(code, from, to)`
  재사용. `from = today - 1500거래일`. 수정주가 `FID_ORG_ADJ_PRC="0"`.
  `output1`(시총·거래대금·종목명·전일대비)도 함께 수집해 `per_code_summary`에 저장.
- **레이트리밋 공유**: 라이브 폴러와 **동일 `KisClient` 인스턴스**(또는 동일
  `_TokenBucket`)를 주입받아 15콜/초를 공유. 새 인스턴스를 만들지 않는다.
- **스케줄**: `scheduler._daily_run`에 Promotion·hogaplay enqueue와 **동급의 독립
  단계**로 추가(KST 17:00, 폴러 idle 시간대). + 수동 트리거
  `POST /api/screener/build`.
- **증분**: 빌드된 캐시가 있으면 종목당 최신 1페이지만 fetch해 append(거래일 1개 추가).
  콜드 빌드만 1,500일 전체.
- **진행률**: 기존 `EventBus.publish`로 `screener.build` 진행 이벤트
  (`{phase:"building", done, total}`) → 프론트 SSE 표시.
- **비용(투명 공시)**: 콜드 빌드 ≈ 2,900×15페이지 ÷ 15콜/s ≈ **~48분**(1회/야간).
  증분 ≈ 2,900콜 ÷ 15 ≈ **~3분/일**. 조회 ≈ **~1초**.

### 스크리닝 조건 & 알고리즘

조회 시 캐시를 polars로 로드하고 다음을 AND로 적용:

- **시총**: `min_market_cap ≤ market_cap ≤ max_market_cap` (억원, `per_code_summary`에서).
- **거래대금**: `trade_value ≥ min_trade_value` (`per_code_summary`에서).
- **신고가 (N,M)**: 종목의 수정주가 고가 시계열 `high[0..n-1]`(ASC)에 대해
  > ∃ d ∈ [n−N, n−1] 이고 d ≥ M−1 이며 **`high[d] > max(high[d−M+1 .. d−1])`**

  즉 "최근 N거래일 중, 직전 M−1일을 **strict 초과**(`>`)하는 신고가 돌파일이 하나라도
  있는가". **최소이력 가드** `d ≥ M−1`: 완전한 M일 윈도우가 없는 신규 상장주는 돌파로
  치지 않는다(짧은 윈도우 가짜 신고가 방지).
- **신고거래량 (N,M)**: 위와 동일하되 `volume[]` 기준.

롤링 윈도우 최대값은 deque(단조 큐) 또는 polars `rolling_max`로 O(n). 전종목
2,900×~1,500행 벌크 연산은 polars로 sub-second.

응답 행은 매치 종목별로 `{code, name, market, price, market_cap, trade_value,
prdy_ctrt, new_high: {hit, last_breakout_date, period_high}, new_high_vol: {hit,
last_breakout_date}}`. 정렬 기본값: 거래대금 desc.

### API (`hoga/api/screener.py`, `build_router`)

- `GET /api/screener` — 쿼리 파라미터: `min_market_cap?, max_market_cap?,
  min_trade_value?, nh_enabled?, nh_recency?, nh_period?, nhv_enabled?, nhv_recency?,
  nhv_period?, q?(이름/코드), sort?, limit?`. 캐시 위 즉시 계산. 캐시
  `unavailable`이면 빈 결과 + 상태로 응답(프론트가 빌드 유도).
- `POST /api/screener/build` — 빌드 트리거(single-flight). 즉시 `loading` 반환,
  진행은 SSE.
- `GET /api/screener/status` — `{status, built_at_ms, depth_trading_days,
  universe_size, reason?}`.

Wire Model은 `hoga/api/models.py`에 `ScreenerRow`, `ScreenerResponse`,
`ScreenerStatus` 추가.

### 프론트엔드 (`/screener`)

- **라우팅**: `main.tsx`에 `<Route path="screener">`, `LeftNav` Workspace 섹션에
  `<NavItem to="/screener" label="Screener" />`.
- **레이아웃**: 전용 페이지(main 영역). 좌측 조건 패널 + 우측 결과 테이블.
  - 조건 패널: 이름/코드 검색 input · 시총 min/max · 거래대금 하한 · 신고가 토글 +
    `최근 N일` `M일 신고`(프리셋 20/60/120/250 + 직접입력) · 신고거래량 동일.
  - 결과 테이블: 코드·종목명·현재가·전일대비·거래대금·시총 + **신고가/신고거래량
    돌파 배지**(돌파일 tooltip). 행 액션 3종:
    - 클릭(행) → `setActiveCode(code)` + `/live` 이동(이미 /live면 차트만 교체).
    - ♥ 버튼 → `POST /api/watchlist` (기존 `api/watchlist.ts`).
    - 캡처 버튼 → 오늘자 Stock-Date를 Capture Queue 등록(기존 `api/captures.ts`).
  - 헤더: 캐시 상태 칩(`fresh`/마지막 빌드 시각/`stale`) + "전체 빌드" 버튼 + 빌드
    진행률(SSE `screener.build` 구독).
- **데이터 훅**: `useScreener(filters)` (react-query), `useScreenerStatus()`,
  `api/screener.ts` 클라이언트.
- **디자인**: `DESIGN.md` 토큰 준수(색·간격·폰트·라운드). UI 작업 전 정독.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| 돌파 정의 strict | high=[…,10,10] 직전 M 최대=10 | 동점은 돌파 아님(`>` 이므로 false) |
| 돌파 정의 hit | high 시계열에 d에서 직전 M−1 최대 초과 | `hit=true`, `last_breakout_date=d` |
| 최소이력 가드 | 상장 M−1일 미만 신규주 | breakout 아님(가짜 신고가 방지) |
| N 윈도우 경계 | 돌파가 N+1일 전에만 존재 | `hit=false`(최근 N일 밖) |
| 신고거래량 | volume 시계열로 동일 로직 | 가격과 독립적으로 계산 |
| 시총/거래대금 필터 | per_code_summary 임계값 | 경계값 포함(≥, ≤) 정확 |
| 수정주가 정확성 | 분할 종목(원주가면 가짜 신고가) | `ORG_ADJ=0` 캐시로 가짜 신고가 없음 |
| 깊이 클램프 | M+N > depth 요청 | 결과 + `truncated_to_depth` 경고(silent cap 아님) |
| 캐시 unavailable | 빌드 전 조회 | 빈 결과 + status, 500 아님 |
| single-flight 빌드 | 동시 build 2회 | KIS fetch 1회만, 둘 다 같은 스냅샷 |

**Invariant 회귀 테스트**:
- 레이트리밋 공유: 빌드+폴러 동시 시 단일 토큰버킷 경유(주입된 동일 인스턴스) 검증.
- ADR-0038: `hoga/live/*` 핫패스 모듈이 `screener_cache`/polars를 import하지 않음(import 그래프 테스트).
- activeCode: 결과 클릭이 `setActiveCode`만 호출(스토어 writer 경로) 검증.

### Manual verification

- `/screener`에서 "200일 내 500일 신고가" 조건으로 조회 → ~1초 내 결과, 배지 표시.
- "전체 빌드" 클릭 → 진행률 증가 → 완료 후 상태 `fresh`.
- 결과 행 클릭 → `/live`로 이동하며 해당 Code 차트 렌더.
- ♥ / 캡처 버튼 → 각각 Watchlist / Capture Queue에 반영.

## Risks / Open questions

- **콜드 빌드 ~48분**: 최초 1회. 야간 스케줄러가 무인 처리하지만, 빈 캐시 상태로 처음
  페이지를 연 사용자에게 "빌드 필요/진행 중"을 명확히 안내해야 한다.
- **증분 빌드 정합성**: 거래일이 추가될 때 append만으로 충분한지(휴장일·정정거래
  `mod_yn`/`prtt_rate` 처리). 정정/분할 발생 시 해당 종목 전체 재빌드 필요할 수 있음 →
  v1은 분할 이벤트 감지 시 per-code 재빌드.
- **KIS 일봉 가용 깊이**: 일부 종목은 1,500거래일 이력이 없을 수 있음(신규/재상장).
  최소이력 가드로 안전하지만 깊이 부족 종목 표기 고려.
- **레이트리밋 경합**: 야간 빌드 중 사용자가 `/live`를 열면 폴러+빌드가 15콜/s를
  나눠 쓴다 → 빌드를 폴러보다 낮은 우선순위로 양보시킬지 검토(v1: 동일 버킷, 빌드가
  느려질 뿐 정확성엔 무해).

## Out of Scope (Backlog)

- 실시간(KIS 순위/현재가) 보강 — 야간 캐시 위에 당일 장중 가격을 덧입혀 "오늘 갱신
  중" 표시.
- 추가 팩터(PER/PBR/회전율/외국인) — `output1`에 이미 PER/PBR 존재, 후속 확장 용이.
- 조건 프리셋 저장, 결과 CSV 내보내기.
- 전종목 깊이 분할 빌드(우선순위 큐로 유동 상위부터 점진 빌드해 첫 사용 가능 시점 단축).
