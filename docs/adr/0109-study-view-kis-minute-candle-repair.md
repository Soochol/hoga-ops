# 0109 — /study 저장뷰 캡처 공백의 KIS 분봉 영구 복구 (kis_api candles.parquet)

**Status:** accepted (2026-07-12)

**Related:**
- ADR-0037 — Stock-Date v2 레이아웃(`parquet/<date>/<code>/<source>/`), source 서브디렉토리
- ADR-0039 — Source Preference는 필터가 아닌 선호(hogaplay → kis_live → kis_api 폴백)
- ADR-0040 — Live Candle Backfill 별도 캐시; **kis_live 승격은 candles.parquet을 절대 쓰지 않는다**
- ADR-0077 — /study v2 참조뷰(스냅샷 아님, range/candle API로 재조회)
- ADR-0095 — KIS 과거 분봉 캐시는 memory-only(라이브 스크롤백 디스크 캐시 되돌림 거부)
- #488 — /study 디스크 온리 전환(KIS 분봉 청크 워크백 제거)

## Context

/study 저장뷰는 hogaplay 정규장 캡처 parquet에서 캔들을 합성한다(#488 디스크 온리).
hogaplay 업스트림 장애로 특정 거래일이 통째로 비면 `/api/range?mode=candles`가 빈
배열을 반환하고(정상 경로, `_empty_range_bundle`) 그날 캔들이 렌더되지 않는다 —
사용자에겐 "저장뷰를 열었는데 캔들이 안 보이는" 증상이다.

KIS 과거 분봉(`FHKST03010230`)은 포털 기준 ~1년치를 날짜 지정으로 조회할 수 있어
(`kis_endpoints.py:fetch_past_minute_candles`) 공백일의 캔들을 메울 수 있다. 관건은
**폴백을 어느 시점에 두느냐**다.

기각된 대안:
- **프론트 런타임 폴백**(조회 시 빈 날짜를 감지해 `/api/live/past-candles`를 추가
  호출·병합): #488이 성능 때문에 제거한 KIS 분봉 의존을 /study에 재도입한다. KIS
  캐시가 memory-only(ADR-0095)라 **서버 재시작마다, 저장뷰를 열 때마다** 콜드
  fetch(340ms~1.9s/일)가 반복되고, "study는 KIS를 치지 않는다"는 계약·설정 UI·테스트를
  전부 뒤집는다. 게다가 KIS 1년 보존이 지난 공백은 영영 못 메운다. 기각.
- **전역 백필**(모든 종목·전 기간 공백을 미리 복구): 저장뷰와 무관한 데이터까지
  디스크를 불린다. 사용자가 실제로 보는 건 저장한 것뿐이다. 기각.
- **가시성만**(공백일 "데이터 없음" 마커): 근본 미해결. 단독 기각(단, 복구본 배지는
  채택 — 아래).

## Decision

공백을 **저장 시점에, 저장뷰가 실제로 가리키는 (종목, 구간)에 한해, 1회, 디스크에
영구 복구**한다. 복구본은 **`parquet/<date>/<code>/kis_api/candles.parquet`(+ meta.json)**
으로 쓴다.

1. **읽기 경로 무변경 — 기존 소스 우선순위 사다리 재사용.** `resolve_source_result`가
   `hogaplay_first`를 `hogaplay → kis_live → kis_api`로 이미 해석한다(ADR-0039). 복구본을
   kis_api 네임스페이스에 쓰면 `build_candles_slice`가 **분기 추가 없이** 서빙한다 —
   hogaplay가 있으면 hogaplay가 이기고, 없는 날만 kis_api가 이긴다. hogaplay가 나중에
   재캡처되면 정본이 다시 승리하므로 provenance 복원도 공짜다. 멱등: 이미 복구된 날은
   같은 서빙 판정(`_has_served_candles`)에서 non-empty가 되어 스킵된다.

2. **복구 모듈 `hoga/live/candle_repair.py`.** 공백 판정은 서빙 로직(`resolve_source_result`
   + `candles_tbl.query_all`)을 재현해 "서빙이 캔들을 내는가"로 한다(감지와 증상이
   어긋나지 않음; bundle import는 순환 회피로 하지 않음). 대상은 구간의 **과거 거래일**만
   (`is_trading_day` True, 오늘/미래 제외). KIS `KisCandle.t_ms`(Unix ms) → parquet
   `ts_ms`(자정 기준 ms, `unix_ms_to_ms_from_midnight`), `vol_a=volume`·`vol_b=0`
   (스크리너 일봉 갭필 관례). KIS 빈 응답(1년 만료 등)은 **빈 parquet을 쓰지 않는다**
   (추후 재시도 여지).

3. **meta.json은 없을 때만 생성.** rest30 승격이 만든 kis_api meta가 이미 있는 날이면
   덮지 않고 캔들만 추가한다(그날 30초 스냅샷 지표와 복구 캔들이 공존). 복구 meta는 KRX
   정규장 경계(09:00–15:30)로 invariant를 통과해 `classify_from_meta`가 SOURCE_PARTIAL
   (healthy)로 분류하게 하고, `created_from == "kis_minute_repair"` 마커로 복구본을
   식별한다.

4. **트리거 2개.**
   - 저장 시 자동: `study_view_routes`가 `on_reference_saved` 콜백을 받아 create/update
     성공 후 `asyncio.create_task`로 fire-and-forget 예약(저장 응답 비블로킹 — KIS fetch가
     일당 최대 ~2초). study_views 계층은 KIS를 모른다(콜백 주입). 훅 실패는 저장을 깨지
     않는다(격리 try/except).
   - CLI 스윕: `hoga repair-study-candles [--dry-run]` — 모든 저장뷰의 공백을 순차 복구.
     기존 뷰 일회성 복구용. dry-run은 KIS 미접근으로 공백만 보고.

5. **게이트.** `kis_rest_bypass_enabled`(ADR-0083) ON이면 스킵. KIS 무자격/오프라인
   (클라이언트 None)이면 fetch가 빈 리스트 → 스킵. (code, date) in-flight 집합(모듈 전역
   + asyncio.Lock)으로 **프로세스 내** 중복 실행 방지 — 서버 프로세스에서 저장 훅이 빠르게
   두 번(create→update) 겹치거나 여러 저장 훅이 동시에 도는 경우를 커버한다. CLI 스윕은
   별도 프로세스(`asyncio.run`)라 이 집합을 공유하지 않으므로, 서버 가동 중 스윕을 돌리면
   같은 (code, date)를 양쪽이 복구할 수 있다 — 그러나 쓰기가 멱등(동일 캔들 덮어쓰기,
   meta는 존재-가드)이라 결과는 안전하다(중복 KIS fetch 한 번이 유일한 낭비). KIS 접근은
   클라이언트 내장 rate-limiter로 쿼터 보호, background 예산(foreground=False)이라 /live
   포그라운드를 굶기지 않는다.

6. **배지.** `RangeBundle.repaired_candle_dates`(기본 [])에 승리 소스 kis_api +
   `created_from == kis_minute_repair`인 날을 방출. 프론트는 /study 헤더에 "KIS 보충 캔들
   N일 · 호가 지표 없음" 배지(kis_api warn-tint 토큰). `data_warnings`를 안 쓰는 이유:
   그건 invariant 위반 타입이라 KIS 지연 칩으로 오독된다(디스크는 지연 개념이 없음).

## Consequences

- **경계 명문화.** ADR-0040의 "candles.parquet 금지"는 *kis_live* 한정이다 — kis_api에
  캔들을 쓰는 것은 위반이 아니다. ADR-0095가 거부한 것은 *라이브 스크롤백 캐시*다 — 이
  모듈은 *캡처 공백의 정본 복구*로 목적이 다르다(저장뷰가 가리키는 구간만, 1회, 영구).
- **호가 지표는 복구 불가.** KIS 분봉은 캔들만 준다. 최대벽·POC·거래량분포·호가비는
  원천이 호가 캡처라 어떤 방식으로도 복원 불가 — 복구일은 "캔들은 있고 지표는 없는 날".
  배지가 이를 알린다.
- **소멸 시한.** KIS 1년 보존이 지난 공백은 복구 불가. 저장 시점 트리거가 유리한 이유:
  저장뷰는 보통 사건 근처에 만들어지므로 "저장 순간 박제"가 시한 문제를 구조적으로 줄인다.
- **at-most-once로 충분.** 저장 직후 재시작으로 복구 태스크가 유실돼도 다음 저장 or CLI
  스윕이 커버한다(영구 저장이라 성공 1회면 끝).
- **되돌림.** 복구본은 kis_api Stock-Date라 표준 삭제로 제거된다. 콜백을 떼면(app.py
  `on_reference_saved=None`) 저장 훅이 no-op이 되고, 읽기 경로는 kis_api가 원래도 폴백
  순위에 있었으므로 잔존 복구본을 계속 서빙한다(무해). `repaired_candle_dates`는 additive.
- **엣지.** 캔들만 있고 스냅샷 없는 kis_api 날에 `mode=hoga/sidecar` 요청 → 각 슬라이스
  빌더의 파일부재 가드(`if not path.exists(): return []`)로 무해(역방향은 이미 프로덕션
  검증). hogaplay가 SOURCE_PARTIAL로 존재하면 hogaplay가 계속 승리(부분일 병합은 비목표).
