# 0051 — Spot 엔드포인트(`/api/orderbook`, `/api/brokers/series`)는 미캡처 (date, code)에 빈 응답을 반환한다

**Status:** accepted (2026-05-29)

**Related:**
- ADR-0044 (Live 페이지 hover spot은 promoted parquet에서만 읽는다)
- ADR-0039 (Source Preference는 preference + fallback)
- ADR-0037 (Source subfolder layout — `parquet/{date}/{code}/{source}/`)
- Diagnostic session 2026-05-29 (058610 호버 시 console 404 spam 진단 및 fix; 28개 빈 source dir 잔재 cleanup)

## Decision

`/api/orderbook` 과 `/api/brokers/series` 는 요청된 `(date, code, source_pref)`
의 parquet 디렉터리가 디스크에 없을 때 **HTTP 200 + 빈 payload** 를 반환한다.
404 가 아니다.

빈 payload 형태:

- `/api/orderbook` → `{available_from: null, snapshot: null, source: <pref>}`
- `/api/brokers/series` → `{date: <req>, brokers: [], source: <pref>}`

`source` 필드는 `resolve_source` 가 디스크 부재 시 그대로 `pref` 를 돌려주는
계약에 맞춰 *요청된 preference 그대로* 에코한다. ADR-0039 fallback 도 실제
디스크에 어떤 source 라도 존재할 때만 발동된다 — 둘 다 없으면 fallback 도 무의미.

이 결정은 다른 두 read 엔드포인트와 **의도된 비대칭**을 만든다:

- `/api/meta` 와 `/api/candles` 는 그대로 `StockDateNotFound` → HTTP 404 유지
- 두 엔드포인트는 hover spot 경로가 아니므로 ADR-0044 의 graceful-empty
  의도에 해당되지 않음

## Why

### 사고가 만든 결정

ADR-0037 V2 layout migration 이 2026-05-27 14:40 에 *이미 비어 있던* 28 개
V1 Stock-Date 디렉터리를 빈 `hogaplay/` source dir 로 변환. parser 자체도
`out_dir.mkdir()` 을 validation 전에 호출하던 시점이라 upstream-empty 캡처가
들어올 때마다 빈 dir 누적 (memory note "hogaplay empty-body = no-data signal").

결과: 사용자가 미캡처 일자 캔들에 호버하면 두 엔드포인트가 404 를 반환,
프론트엔드 `useSpot` 의 catch handler 가 `console.error` 로 surface → 콘솔
빨간 404 도배. 동시에 sidebar 는 ADR-0044 가 의도한 "다음 가용 HH:MM" 힌트
도, 명시적 "데이터 없음" 메시지도 보여주지 못한 채 "커서 위치 로딩 중…"
영원 루프.

근본 원인은 **read path 의 의미론 선택**이지 캡처 누락이 아니다 — KIS/hogaplay
업스트림이 합법적으로 빈 응답을 줄 수 있는 종목/날짜 조합이 항상 존재하므로,
"미캡처 = 디스크 부재" 는 운영상 정상 상태의 부분집합이다.

### 대안 비교

세 가지 옵션을 검토:

**A. 백엔드 graceful 200 (채택)**
- 장점: ADR-0044 의 "데이터 없으면 sidebar 가 빈 상태" UX 가 *실제로* 도달.
  콘솔 깨끗. `/api/range` 가 이미 동일 패턴 (empty bundle, no 404). useSpot LRU
  가 빈 payload 도 캐싱하여 같은 (date, code) 재호버 시 네트워크 안 탐.
- 단점: 코드/날짜 typo 가 silently 200 으로 통과해 frontend 디버깅에서 "빈
  결과" vs "잘못된 입력" 구분이 어려워짐. `/api/meta` / `/api/candles` 와
  의 비대칭 발생.

**B. 프론트엔드에서 404 silent 흡수 (`useSpot` catch 가 `status===404` 면
`console.debug` 로 강등)**
- 장점: 작은 변경. 백엔드 API 의미 변화 없음.
- 단점: 진짜 백엔드 버그로 인한 404 도 함께 묻힘. 404 catch 가 두 spot 엔드
  포인트만 알아야 해서 frontend 가 endpoint-specific 지식을 가짐 (caller-side
  policy → ADR-0050 의 *single ingress* 정신과 반대 방향).

**C. 빈 dir 정리 + parser fix 만 하고 기존 404 수용**
- 장점: API 의미 변화 zero, 가장 보수적.
- 단점: 28 개 기존 (date, code) 가 그대로 404 계속. 미래 upstream-empty
  캡처는 빈 dir 안 만들지만 *원래 의도된* 빈 sidebar UX 는 여전히 도달 불가.
  주 사용자 시그널 (콘솔 노이즈) 해소 안 됨.

A 가 사용자 시그널을 직접 해소하고 ADR-0044 의 원래 의도를 코드 경로 상
도달 가능하게 만든다 — B 는 *증상만* 가리고, C 는 *증상은 남기고* 차단만 함.

## Trade-off accepted

- **Split-personality with `/api/meta` and `/api/candles`**: 같은 hoga-ops API
  surface 안에서 hover-spot 두 엔드포인트는 200-empty, 메타/캔들 두 엔드포
  인트는 404. 이 비대칭은 *유지 보수자가 "API 일관성"을 명분으로 잘못된 방향
  으로 통일하려는 시도* 의 위험을 만든다. 본 ADR + 두 핸들러의 docstring 이
  의도된 비대칭임을 명시한다. 미래 reviewer 가 두 엔드포인트를 404 로 되돌리
  거나 `/api/meta`/`/api/candles` 를 200-empty 로 바꾸려 하면 본 ADR 위반.
- **Typo silently 200**: `code=999999&date=20990101` 같은 명백한 잘못이
  이제 빈 응답으로 통과한다. 이 케이스의 디버깅 가시성은 frontend 가
  요청 직전 입력 검증에서 자체 책임진다 (코드/날짜는 store 상태에서 오므로
  발생 가능성 자체가 낮음).
- **`_resolved_parquet_dir` 시그니처 변경**: `tuple[Path, SourceName]` →
  `tuple[Path | None, SourceName]`. 호출자 2 곳 (orderbook, brokers_series)
  모두 본 패치에서 None-check 추가. 미래에 helper 를 재사용하는 새 핸들러는
  None 처리 책임을 진다 — type checker 가 검증.

## Invariant introduced

- (Invariant-51.1) `/api/orderbook` 과 `/api/brokers/series` 는 어떤 (date,
  code, source_pref) 입력에도 4xx 를 raise 하지 않는다 (단, FastAPI 가
  스키마 검증 단계에서 422 를 던지는 경우는 제외 — 그건 라우터 진입 전에
  발생). source dir 부재 / Stock-Date 부재 / 둘 다 부재 모두 200-empty 로
  매핑된다.
- (Invariant-51.2) `_resolved_parquet_dir` 은 `StockDateNotFound` 를 swallow
  하고 `(None, source_pref)` 를 반환한다. 두 spot 핸들러는 `sd_dir is None`
  분기를 반드시 가진다 — 없으면 type checker 가 `Path | None / "..."` 에서
  실패하므로 enforce 됨.
- (Invariant-51.3) `source` 필드는 *실제 데이터를 읽어온 source* 를 반영하되,
  데이터가 없는 경우엔 *요청된 preference* 를 그대로 반영한다. fallback 은
  디스크에 다른 source 가 *존재할 때만* 발동된다 (ADR-0039 기존 계약 유지).

## Implementation reference

- 코드 위치: [hoga/api/routes.py](../../hoga/api/routes.py) `_resolved_parquet_dir`
  (helper) + `orderbook` / `brokers_series` 두 핸들러의 `if sd_dir is None`
  분기
- 회귀 테스트:
  [test_orderbook_endpoint.py](../../tests/unit/api/test_orderbook_endpoint.py)
  `test_orderbook_returns_empty_response_when_source_dir_missing`,
  `test_orderbook_returns_empty_response_when_source_dir_missing_kis_live_pref`
  / [test_api_brokers_series.py](../../tests/test_api_brokers_series.py)
  `test_brokers_series_returns_empty_response_for_unknown_stock_date`
- 프론트엔드 렌더링 경로 검증:
  [OrderbookTable.tsx](../../frontend/src/sidebar/OrderbookTable.tsx) `snapshot
  === null` 분기 → "호가 데이터 없음" /
  [BrokerTrajectoryTable.tsx](../../frontend/src/sidebar/BrokerTrajectoryTable.tsx)
  `series.length === 0` 분기 → "거래원 정보 없음" (undefined 분기와 별개라
  eternal-loading 회귀 없음)
- 선행 cleanup: parser `out_dir.mkdir()` 을 validation 이후로 이동
  ([commit 5f16b11](../../hoga/parser/__init__.py)). 미래 upstream-empty
  캡처가 빈 source dir 을 누적하지 않음

## Future signal to revisit

다음 신호 중 어느 하나라도 발생하면 본 ADR 재검토:

- 사용자가 "왜 404 안 나오지? 잘못 입력했는데" 라고 보고 — typo silently 200
  의 부작용. 추가 가시성이 필요해지면 query-param schema 단계에서 known-set
  검증 (가능한 (date, code) 만 허용) 으로 frontend 측 가드 도입.
- `/api/meta` 또는 `/api/candles` 도 hover spot 경로에 편입될 필요가 생김 —
  그때 본 ADR 의 graceful-empty 계약을 두 엔드포인트로 확장. 단순 *API 일관성*
  명목으로 통일하면 안 됨 (`/api/meta` 가 404 인 이유는 hover-spot 가 아닌
  단일 read 로서 "없으면 없음" 이 의미 있는 시그널이기 때문).
- `_resolved_parquet_dir` 를 세 번째 핸들러가 호출하기 시작하면 — None 처리
  중복이 누적되면 helper 패턴 자체 재검토 (예: 빈 response 빌더를 helper 에
  주입).
- 캡처 파이프라인이 *빈 dir 을 적극 생성* 하는 다른 경로가 발견됨 — parser
  fix 외에 promote.py / migrate.py 도 같은 패턴 가능. 발견 시 본 ADR + parser
  fix 가 가정한 invariant ("미캡처 = 디스크 부재") 가 깨지므로 재평가.
