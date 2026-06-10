# Changelog

All notable changes to this project are documented here.
The format follows a 4-digit `MAJOR.MINOR.PATCH.MICRO` scheme.

## [0.7.13.0] - 2026-06-10

### Added
- **관심맵 (`/heatmap`) — 관심종목 히트맵 보드**: 한 화면에 모든 섹터 폴더(미분류·빈 폴더 제외)의
  관심종목을 신문형 CSS multi-column으로 펼쳐 **Live Quote**(현재가·전일대비·등락률)를 등락률
  히트로 칠하는 풀페이지 보드. 하이브리드 히트(은은한 배경 틴트 ±8% 포화·max α0.42 + KRX 색 숫자,
  색약 삼중 표현), 정렬 토글(기본 manual=큐레이션 순서 ↔ change=등락률↓ 옵트인 라이브 재정렬),
  폴더 헤더 평균 등락률 + 인라인 **＋종목**(SymbolSearch 팝오버 → add 후 move), 상단 **＋새 그룹**,
  색 범례 바, KIS 자격증명 없음/오프라인 배너(`deriveBannerState`+`LiveStateBanner` 재사용). 행 클릭
  → activeCode + `/live` 점프. 좌측 내비에 Heatmap 추가, 라우트 `/heatmap`. `useWatchlist`+
  `useQuotes`(10s)+`useLiveStatus` 재사용, **백엔드 무변경**. 신규 `pages/Heatmap.tsx` +
  `heatmap/*`(Board/Folder/Row/FolderAddButton/heat/visibleGroups/useAddToFolder) + `state/heatmapPrefs`.
  TDD 10태스크 + plan-eng-review 7개 결정 + 최종 리뷰 SHIP-WITH-MINORS 2건(색 범례·제출 에러가드) 수정.

### Internal
- **Live Quote 오버레이 deepening(아키텍처 후보1)**: 흩어진 "Live Quote 오버레이"(코드→시세 Map +
  phase + 갱신시각)를 단일 deep 훅 `useLiveQuoteOverlay(codes)`로 모으고, `useQuoteByCode`를 그
  thin view(`.quoteByCode`)로 축약했습니다(시그니처·메모 안정성·동작 불변 → 관심종목/스크리너
  패널·라이브 상태바 무영향). 관심맵을 오버레이 훅으로 전환해 인라인 Map 중복 제거. 후보2(등락률
  포맷 통합)는 CandleTooltip의 색/텍스트 불일치 "버그"가 `PriceRow`에서 이미 반올림-후-채색으로
  해결돼 있어(1차 자료 확인) 정당화가 사라지고 표면별 합성이 의도적으로 달라 over-engineering
  위험 → **드롭**. 후보3(`visibleFolderGroups`)은 히트맵 표시 정책이라 grouping.ts로 안 옮김(no-op).
  프론트 1658 테스트 통과.

### Docs
- 관심맵 스펙/플랜(`docs/superpowers/specs|plans/2026-06-10-*`), DESIGN.md 가격 방향 히트 램프 노트,
  CONTEXT.md "관심맵" 용어 등재.

## [0.7.12.0] - 2026-06-10

### Internal
- **Live Session 상태기계 추출(아키텍처 deepening C3) — strangler 5단계**: lifecycle.py(772줄·
  7관심사)의 KIS WS 연결집합 상태기계(streams + start/refresh/restart/stop + degraded + status)를
  신규 `LiveSession` 객체(`hoga/live/live_session.py`)로 추출했습니다. 이제 관심종목 변경 1회가
  4개 하위시스템을 튕기는 대신 한 객체의 `refresh()`에 집중되고, 불변식(streams 키 ∈ [0,N)·
  이중-write 방지·R1 KisClient 보존·dynamic-N)이 주석이 아닌 코드로 봉인됩니다. lifecycle은
  lifespan 오케스트레이션(poller·today-promoter·watchdog 트리거·get_status 합성)만 남습니다.
  load-bearing(장중 캡처 핵심) 작업이라 Beck "make the change easy" 원칙대로 진행했습니다:
  (0) 공개-seam characterization 테스트 10건 선행(`test_live_session_characterization.py`) —
  `_state` 내부를 안 찌르고 get_status 관측만 검증해 추출 내내 byte-identical로 살아남는 독립
  회귀 앵커. (1) 순수 헬퍼·_StreamConn 이동 → (2) LiveSession이 streams + 세션 스코프 상태 소유
  (lifecycle._state는 위임 facade) → (3) start/refresh/restart/stop을 메서드로(conn 빌드/teardown
  은 의존성 주입) → (4) degraded_set/status_fields 노출 + get_status 단일 계산 dedup + account_health
  WS-probe 합류. ADR-0064(예외격리·watchdog dead/stale·거짓health 금지)·ADR-0067(exclude-then-
  subscribe 순서, lifecycle 봉인) 정확 승계. 그려지는 결과·라우트 동작 동일(순수 내부 정리).
  기존 lifecycle 테스트는 compat facade로 *무수정* green(회귀 신호), 백엔드 1492 통과.
  ⚠️ **머지 게이트**: load-bearing이라 실-2계좌 KIS 장중 1세션 수동 카나리가 머지 전 필요.

## [0.7.11.0] - 2026-06-10

### Internal
- **KIS build_router seam 통일(아키텍처 deepening C1b)**: /api/live 라우터가 KIS
  클라이언트를 얻는 길이 둘이던 shallow seam(`build_router(get_kis_client=...)` 주입 +
  `_kis_for_background`의 else 폴백)을 제거하고, 모든 라우트가 `kis_access.kis_for_role(
  role, data_dir)` 단일 seam을 경유하도록 접었습니다(foreground=과거 분봉/일봉은 account
  0 전용, background=시세/투자자 순매수는 account 1, 1개 키·저하 시 account 0 폴백).
  테스트 fake 주입도 6가지 형태에서 `set_kis_client(fake, account)` 단일 메커니즘으로
  통일했습니다. 그려지는 결과·동작은 종전과 동일한 순수 내부 정리이며, 백엔드 테스트
  1482 무회귀입니다. 다음 차례: Live Session 상태기계 추출(C3).

## [0.7.10.0] - 2026-06-10

### Changed
- **/live에서 과거로 깊게 스크롤해도 호가 보조지표가 끊기지 않습니다**: 장중에 1분봉을 과거로 멀리
  스크롤한 상태에서, 실시간 틱마다 호가비·호가총합·체결강도를 매번 처음부터 다시 계산하고 차트에
  통째로 다시 그리느라 갱신 한 번에 수십~100ms씩 메인 스레드가 멈춰 버벅였습니다. 과거 구간은 장중에
  바뀌지 않으므로 한 번 계산해 캐시하고 당일 구간만 다시 계산하도록 바꿨고(딥스크롤 기준 보조지표 계산
  약 33배 단축), 차트에는 매번 전체를 새로 밀어넣는 대신 바뀐 마지막 봉만 갱신하도록 바꿨습니다(약 5배
  단축). 기본 화면(최근 5거래일)은 원래 빨라 체감 변화가 없고, 과거로 깊게 본 상태의 버벅임이
  사라집니다. 그려지는 결과(값·색·오토스케일)는 종전과 바이트 단위로 동일합니다.

## [0.7.9.0] - 2026-06-10

### Changed
- **/live KIS REST가 2번째 계좌 키를 활용해 사용자 fetch와 백그라운드를 분리 — 체감 더 빠른 차트
  로딩**: 사용자가 차트 그려지길 기다리는 분봉·일봉(foreground)은 account 0 전용 15콜/초를, 백그라운드
  작업(보는종목 폴러·시세·투자자 순매수·스크리너 일배치/백필)은 그동안 WS 접속키 발급에만 쓰여 통째로
  놀던 account 1의 REST 15콜/초를 쓰도록 분리했습니다. 사용자 fetch가 백그라운드 부하와 같은 버킷을
  다투지 않아(총 30콜/초) 분봉/일봉이 더 빨리 뜹니다. 키가 1개거나 2번째 계좌가 저하되면 account 0로
  자동 폴백합니다.

### Fixed
- **2번째 계좌 키 오설정 시 조용한 성능 저하 방지**: account 1이 REST 토큰 발급에 실패하면(예: 잘못된
  KIS_APP_KEY_2) 백그라운드를 account 0로 자동 폴백하고, 전환 시 운영자가 grep할 1회성 경고를 남깁니다
  (이게 없으면 30콜/초로 착각한 채 영구히 15콜/초로 조용히 강등됩니다). 스크리너 배치는 코드별 재시도로
  토큰 실패에도 끝까지 진행합니다.

### Internal
- **KIS 리소스 레이어 아키텍처 정리(deepening)**: role→account 라우팅을 `kis_access`, 계정 health(REST
  토큰 latch ∪ WS 저하)를 leaf `account_health` 모듈로 추출해 이전의 5가지 흩어진 클라이언트 해결
  방식과 late-import 순환을 제거했습니다. WS 캡처 게이트(`ws_capture_window`)의 blocking 계약을
  `*_async` 진입점으로 명시화(이벤트 루프 동결 방지). 후속 정리(build_router seam 통일, Live Session
  상태기계 추출)는 다음 차례. 백엔드 테스트 1481 무회귀.
- ADR-0067·CONTEXT.md를 계정 분리 현실로 갱신(account k>0 = WS approval 전용 전제 폐기).

## [0.7.8.0] - 2026-06-09

### Fixed
- **/live에서 처음 보는 종목의 분봉이 안 그려지던 버그 수정**: 캔들이 아직 로드되지 않은 빈 차트에서
  과거데이터 자동 백필이 오발해, 요청 범위가 250일 한계까지 폭주하며 거대한 미캐시 fetch가 영원히
  pending 상태가 돼 차트가 영구히 빈칸이 됐습니다. 빈 차트에서는 백필을 트리거하지 않도록 가드를
  추가했습니다(빈영역 자동 채움은 데이터가 도착한 뒤 정상 동작).

### Changed
- **분봉 첫 로딩이 빨라졌습니다**: 분봉 전환 시 과거 40일치를 한꺼번에 받던 것을 5거래일치로 줄여
  KIS 호출을 약 6배 줄였습니다. 화면에 보이는 구간만 먼저 받고, 왼쪽으로 스크롤하면 나머지를
  자동으로 채웁니다.
- **KIS 호출 한도로 데이터가 지연될 때 명확히 표시**: 분봉이 늦게 뜰 때 "고장?"으로 오해하지 않도록,
  호출 한도 지연이면 "KIS 호출 한도로 지연 중" 문구를, 일부 구간만 지연이면 비차단 안내 칩을
  표시합니다.

## [0.7.7.0] - 2026-06-09

### Changed
- **/live KIS REST 호출에 foreground 우선순위 레인 추가 — 사용자가 보는 차트 fetch가 백그라운드 부하 앞으로**:
  단일 15/s KIS 토큰버킷을 여러 소비자(rest_poller·투자자·screener·사용자 분봉/일봉 fetch)가
  우선순위 없이 공유해, 방금 누른 종목의 과거 캔들 fetch가 백그라운드 폴링 뒤로 밀렸습니다. 이제
  사용자가 기다리는 fetch(past-candles/daily)에 우선순위를 줘, 백그라운드는 사용자 대기자가 있는
  동안 토큰을 양보합니다(벽시계 기아 백스톱으로 백그라운드 영구 기아 방지). 단일 15/s 예산은
  그대로 — 순서만 바뀝니다.

### Fixed
- **장 마감 후 보는종목 REST 폴러가 KIS를 무의미하게 계속 호출하던 문제 차단**: rest_poller가 장
  마감(closed) 시 시세 불변 종목을 2초마다 폴링하던 것을, 구독 직후 1회 종가 스냅샷만 받고
  멈추도록 했습니다(재개장 시 정상 복원). KIS 초당 호출 쿼터 낭비 제거.

## [0.7.6.0] - 2026-06-09

### Added
- **/live 관심종목 실시간 수집이 13종목 → 26종목으로 늘었습니다 — 2계좌 WebSocket (ADR-0067 출시2)**:
  KIS는 appkey당 41등록(종목당 3등록: 호가+체결+거래원)이라 1계좌로는 13종목이 한계였습니다.
  이제 2번째 KIS 계좌(`KIS_APP_KEY_2`/`KIS_APP_SECRET_2`)를 설정하면 관심종목 상위 26개를
  **두 WebSocket 연결로 나눠(13/13) 실시간 수집·저장**합니다. 1계좌만 설정돼 있으면 기존
  13종목 동작 그대로입니다(무변경 폴백). *(실-KIS 장중 2계좌 enable 검증은 키 등록 후 1회
  수동 스모크로 확정 — `scripts/smoke_2account_ws.py`.)*
- **빈 관심종목에서도 보는 종목 호가가 표시됩니다 (C4)**: 관심종목이 0개여도 보는종목 REST
  표시폴러가 살아 있어, 검색·차트로 연 종목의 호가창이 백지가 아니라 즉시 표시됩니다.

### Changed
- **연결 생명주기 = dynamic-N**: 코드가 있는 계좌의 연결만 만들고(빈 파티션은 연결 없음),
  watchdog가 죽은 연결만 격리 복구합니다 — 한 계좌가 끊겨도 다른 계좌·보는종목 표시는 유지.
  일부 연결만 저하되면 전체 배너로 정직하게 알리고 `degraded_accounts`(GET /api/live/status)로
  어느 계좌인지 노출합니다(종목별 표시는 후속 deepening).

### Internal
- `kis_runtime` KIS 리소스 싱글톤을 `account_id`별 dict로 일반화(account k>0 = WS approval key
  전용, bearer 토큰·15콜/초 버킷 미사용; account 0 경로는 backcompat 무변경).
- `lifecycle` `_State`를 N-스트림 dict로, refresh·watchdog가 공유하는 `_build_conn`/`_teardown_conn`
  프리미티브 + 연결별 `_restart_conn`. cross-boundary 재정렬 이중-write 방지(2-pass 원자 active 스왑).
  rest_poller를 stream 생명주기에서 분리(빈 watchlist poller-only + 재시작 시 보는종목 구독 보존).
- 선결: 동일 IP에서 appkey 2개로 WS 2소켓 동시 유지 스모크 통과(ADR-0067 위험 #1 해소).

## [0.7.5.0] - 2026-06-09

### Added
- **관심종목 밖 종목도 /live에서 호가가 보입니다 — 보는종목 REST 표시폴러 (ADR-0067)**:
  지금까지 /live 실시간(KIS WebSocket)은 실시간 수집 대상(Live Set)만 채워, 그 밖의
  종목을 차트에 올리면 호가창·체결강도·거래원이 백지였습니다. 이제 보고 있는 종목이
  Live Set 밖이면 **그 종목만 REST로 2초 주기 폴링(호가 FHKST01010200·체결
  FHPST01060000·거래원 FHKST01010600)해 화면에 즉시 표시**합니다. 이 경로는 **화면 표시
  전용이라 디스크에 저장하지 않습니다**(저장은 WS Live Set만) — 같은 종목이 WS·REST
  양쪽에 기록돼 JSONL이 혼합되거나 체결강도가 이중계상되던 위험이 구조적으로 생길 수
  없습니다.
- **수집 상태 배지**: 보고 있는 종목(헤더)과 관심종목 패널 행에 수집 상태를 배지로
  명시합니다 — 실시간(WS 수집·저장) / 준실시간(REST 화면 표시) / 미수집. 종목을 열었는데
  패널이 비어 보이던 이유를 한눈에 알 수 있고, 미수집 종목엔 "관심종목에 추가하면 실시간
  수집" 안내를 띄웁니다.

### Internal
- REST 표시폴러는 감독형입니다 — 폴링 루프 예외 격리 + 태스크 사망 감지 + 거짓 health
  금지(ADR-0064 교훈). `live_set` 멤버십을 "누가 그 종목을 수집하는가"의 단일 권위로
  삼아 WS 수집 종목은 폴러가 건너뛰고(배타), live_set 도출과 폴러 배제 동기화를
  `_sync_and_live_set` 한 지점으로 묶어 이중수집을 막습니다.

## [0.7.4.0] - 2026-06-09

### Fixed
- **분봉(타임프레임) 전환 시 캔들이 "그려진 뒤 다시 fitting되며 재생성"되던 플리커
  제거**: 전환 직후 차트가 동일한 캔들 데이터를 여러 번 setData하면서
  lightweight-charts가 가격축을 다시 오토스케일하고 화면을 재배치하던 것이 원인.
  같은 내용이면 setData를 건너뛰도록 가드를 추가해, 전환 시 캔들이 한 번에 최종
  위치로 그려집니다.

### Changed
- **/live 차트가 실시간 호가 갱신(SSE)마다 화면 전체를 다시 그리던 부담 감소**:
  호가 지표(quote_ratio/fill_strength)만 실시간 데이터에 의존하는데도 SSE 틱마다
  캔들·이동평균·툴팁·현재가선까지 함께 재렌더되던 구조를 분리했습니다(번들을
  candle/hoga로 나누고 candle 경로 컴포넌트를 memo화). 또한 SSE 푸시를 ~150ms로
  묶어(coalescing) 장중 고빈도 갱신에도 재렌더 빈도를 ~6.7Hz로 제한합니다. 라이브
  호가·사이드바 표시에 최대 150ms 지연이 더해지지만(현재가선 제외), 차트가 눈에
  띄게 부드러워집니다.

## [0.7.3.0] - 2026-06-09

### Changed
- **/live 차트를 과거로 깊이 스크롤할 때 렌더가 더 부드러워짐**: 캔들 하나하나를
  화면에 올릴 때 세션 축을 3번씩 조회하던 것을 1번으로 융합(`classifyAndProject`).
  170거래일·6.6만 캔들 기준 projector 커밋이 약 33~43% 빨라짐(실측). 깊은 스크롤에서
  프레임 끊김이 줄어듭니다. 백엔드 응답 지연(별도 경로)에는 영향이 없습니다.
- **장 마감 후 /live를 열어둬도 불필요한 과거 데이터 재요청이 멈춤**: 분봉·일봉·투자자
  순매수의 60초 자동 재요청을 정규장 시간대(평일 09:00–15:30 KST)에만 활성화. 장외에는
  네트워크 왕복과 오늘자 KIS 호출이 0이 됩니다(공휴일은 백엔드 캘린더가 별도 관리).

### Fixed
- **과거를 빠르게 연속 드래그할 때 이전 요청의 늦은 응답이 화면을 덮어쓰지 않음**:
  과거 데이터 쿼리 4종에 요청 취소(`AbortSignal`)를 연결해, 드래그로 구간이 바뀌면
  버려질 직전 요청이 도착해도 차트를 다시 그리지 않습니다(백엔드 KIS 호출 자체는
  취소되지 않으므로 호출량 절감은 아님).

### Internal
- `sessionPhaseAt`의 이진 탐색을 `locateSegment`(소유 세그먼트 인덱스 + phase 반환)로
  추출해 캔들 projector의 단일-조회 융합에 재사용. 선형 레퍼런스 동치 스윕 + 접근수
  가드 + idx 계약 핀 테스트로 동작 보존을 회귀 검증.

## [0.7.2.0] - 2026-06-09

### Fixed
- **분봉 호가 지표(총잔량·호가비·체결강도) 누락 복구**: 특정 날짜에 캔들을 올려도
  이 세 지표가 백지로 보이던 문제를 고쳤습니다. 원인은 하루치 체결 중 누적거래량이
  단 한 번 역행(`series.cum_vol_monotonic`)하면 그 날짜 전체가 `/api/range`에서
  통째로 제외되던 것. 이 위반은 데이터 형태를 깨지 않는 포렌식 신호라 제외 사유(error)가
  아니라 경고(warn)로 바로잡았고, 영향받던 67개 종목·날짜가 다시 표시됩니다(10호가·거래원은
  원래 정상이었습니다). 데이터에 알려진 이상이 있는 날은 경고로 함께 표시됩니다.
- **hogaplay 페이지 재전송 중복 제거**: 같은 체결 묶음이 새 일련번호로 두 번 들어오던
  경우를 파서가 누적거래량 기준으로 정리합니다. 해당 분봉의 체결강도가 부풀려지던
  이중계상과 누적거래량 역행이 함께 사라집니다.
- **`hoga validate --deep` 캔들 검사 복구**: 캔들 parquet 로딩 버그로 `--deep`가
  캔들 단조성 검사를 건너뛰던 문제를 고쳤습니다. 이 때문에 `--deep --fix`가 차트 크래시를
  유발할 결함 날짜의 검사 결과를 지울 위험이 있었습니다.

## [0.7.1.0] - 2026-06-09

### Added
- **관심종목 패널 드래그 재정렬**: 오른쪽 관심종목 패널에서 종목과 그룹을 마우스
  드래그로 직접 재정렬할 수 있습니다. ① 종목 행을 끌어 **같은 그룹 안에서** 순서를
  바꾸고(드롭 즉시 반영), ② 그룹 헤더에 마우스를 올리면 나타나는 ⠿ 핸들을 끌어 그룹
  순서를 바꿉니다. 두 동작 모두 낙관적 업데이트라 화면이 튀지 않습니다. 단순 클릭은
  그대로 차트 이동으로 동작하고(5px 임계로 드래그와 구분), 우클릭 메뉴·Delete·접기
  토글·⋯ 메뉴도 그대로입니다. v0.5.5.0에서 폴더 도입과 함께 빠졌던 패널 드래그를
  폴더 인지 형태로 되살린 것입니다(ADR-0066).

### Changed
- 그룹 *간* 이동(다른 그룹으로 종목 옮기기)은 기존처럼 우클릭 "그룹으로 이동" 또는
  관심종목 편집 모달이 담당합니다 — 패널 드래그는 같은 그룹 내 순서 변경 전용입니다.
- 폴더 재정렬(`useReorderFolders`)을 낙관적+롤백 경로로 전환해 드롭 즉시 반영되도록
  했습니다(종목 재정렬과 동일한 패턴).

## [0.7.0.3] - 2026-06-08

### Fixed
- **드로잉 수평선을 차트 우측 빈 영역에서 드래그하면 안 움직이던 문제 수정**:
  마지막 캔들 오른쪽의 빈 띠(rightOffset=15)에서는 시간축 좌표 변환
  (`coordinateToTime`)이 null이라, X·Y를 함께 푸는 `pixelToData`가 통째로
  실패해 드래그가 조용히 멈췄다. 수평선은 가격(Y)만 필요한데도 시간(X) 해석
  실패가 이동을 막은 셈. 시간과 독립인 `canvasYToPrice`를 추가해 body-drag와
  추세선 핸들 이동이 가격축을 단독으로 해석하도록 분리 — 이제 수평선을 빈 영역
  어디에서 잡아도 드래그된다. 덤으로 추세선·연필 body-drag도 빈 영역에서 얼지
  않고 수직 이동이 된다(기존엔 완전 정지).

## [0.7.0.1] - 2026-06-08

### Fixed
- **마우스 휠 줌인 시 마지막 캔들 앵커 풀림 수정**: (수정자 없는) 휠로 줌인하면
  최신 캔들이 화면 왼쪽으로 밀려나던 문제. 이제 줌인·줌아웃 양쪽에서 최신 캔들이
  화면에 고정된다(과거 구간을 보던 중에는 기존대로 오른쪽 끝 고정). 곁들여,
  Shift+휠 오른쪽 벽이 호가 데이터 때문에 실제 마지막 캔들보다 한참 왼쪽에서
  멈추던 인덱스 오차(약 270칸)도 함께 정상화 — 이제 벽이 기본 뷰 위치에 정확히
  맞는다.

## [0.7.0.0] - 2026-06-08

### Added
- **KIS WebSocket 실시간 파이프라인**: /live의 호가창·체결강도·거래원이 REST
  폴링(호가 20초 주기)에서 KIS WebSocket push 기반 **sub-second 표시**로 전환.
  관심종목 표시 순서 상위 13종목(Live Set)을 구독하고, 표시(틱 단위)와
  저장(10초 다운샘플)을 분리. 재연결 백오프·PINGPONG·silent-stall watchdog 포함
- **fills.parquet (체결강도 구간합)**: 체결 내역 raw 저장을 10초 구간합으로
  대체 — WS 전수 수신으로 체결강도가 샘플링이 아닌 전수 합산이 되고 디스크는
  가벼워짐. API는 fills 우선, 구버전 데이터는 trades 폴백
- **past-candles 병렬 fetch**: 미캐시 날짜를 동시 5개로 가져오고 같은 날짜의
  중복 요청은 한 번만(싱글플라이트) — 콜드 캐시 차트 로드 3.3초 → ~0.7초
  (예상치, 실서버 실측 예정)
- **장외 quotes 폴링 게이트**: 관심종목 현재가 폴링이 장 시간(평일
  08:50–16:00, KRX 동시호가 08:50 반영)에만 10초 주기로 돌고, 장외엔 마지막
  시세를 유지한 채 600초 하트비트 — 일일 폴링 ~69% 절감

### Changed
- **차트 핫패스 최적화**: 세션 위상 판정(sessionPhaseAt) 이진 탐색화 — 250일
  스크롤 기준 캔들당 세그먼트 비교 ~20배 절감 (틱 단위 재계산 시대의 전제조건)
- **KIS 레이트리밋 재시도 가시화**: 침묵으로 +1~7초 지연되던 EGW00201 재시도가
  로그로 표면화(첫 재시도 WARNING, 이후 DEBUG)
- CONTEXT.md의 WS 전환 이행 표기를 구현 완료 상태로 갱신 (Live Session 정의
  09:00–15:30 재작성, 반장일 조기 마감 미인지는 알려진 갭으로 명기)

### Fixed
- 코드리뷰 상위 4건: ① 캘린더 게이트의 동기 KIS HTTP가 이벤트 루프를 최대
  15초 동결시키던 회귀(to_thread 격리) ② 빈 관심종목 부팅 후 첫 종목을 추가해도
  캡처가 시작되지 않던 회귀(auto-start 폴백) ③ 체결강도 분봉 귀속 오류(flush
  윈도 벽시계 정렬 + 윈도 시작 라벨) ④ 구독 해제 직후 잔여 프레임이 유령
  데이터를 기록하던 버그(active-set 입구 필터)
- 일봉 워크백 조기 종료 — 범위 시작일 도달 후 1회씩 낭비되던 헛 KIS 콜 제거
- WS bytes 프레임 디코드 — binary 프레임이 무로그로 버려지던 침묵 캡처 정지
  경로 차단

### Removed
- **REST 폴러 은퇴**: `hoga/live/poller.py`와 전용 테스트 삭제 — 캡처 경로 WS
  일원화, 15콜/초 REST 쿼터 해방. 장후 시간외(15:30–16:00) 라이브 캡처는
  의도적 회귀(hogaplay 일배치가 post-hoc 보완)

## [0.6.5.3] - 2026-06-08

### Fixed
- **Ctrl+휠 줌아웃 시 커서 앵커 풀림 수정**: 차트를 깊게 줌아웃해 캔들 폭이
  라이브러리 하한(0.5px)에 닿으면, 이후의 Ctrl+휠 줌아웃이 줌 대신 차트를
  오른쪽으로 밀어내며 커서 아래 캔들이 화면에서 흘러가던 버그. 이제 줌아웃은
  하한에서 커서 앵커를 유지한 채 깨끗하게 멈춘다 (휠 줌·기본 줌 모두 적용).

## [0.6.5.2] - 2026-06-08

### Changed
- **관심종목 패널 종목 행 들여쓰기**: 종목명이 그룹명 첫 글자보다 오른쪽에서
  시작하도록 종목 행 왼쪽 여백을 확대(15→50px) — chevron 좌측 이동(v0.6.5.0)
  이후 종목이 부모 그룹보다 왼쪽에 있던 위계 역전을 교정. 그룹이 없는
  스크리너 목록은 기존 여백 그대로.

## [0.6.5.1] - 2026-06-08

### Changed
- **Shift+휠 오른쪽 벽에 기본 뷰 여백(+15칸) 적용**: 오른쪽으로 팬하면 이제
  마지막 캔들에 딱 붙는 대신 평소 기본 뷰와 같은 우측 여백(rightOffset 15칸)
  위치에서 멈춤 — 팬으로 라이브 엣지에 돌아왔을 때 차트가 처음 열었을 때와
  정확히 같은 화면이 됨. 첫 틱에 여백이 스냅으로 회수되던 동작도 사라짐
  (v0.6.4.0 필드 사용 후 개정).

## [0.6.5.0] - 2026-06-08

### Changed
- **관심종목 패널 그룹/종목 시각 구분 개선**: 그룹 헤더와 종목 행이 같은
  "좌측 텍스트 + 우측 숫자" 패턴이라 섞여 보이던 문제를 해소. 이제 그룹명이
  종목명보다 크고 굵게(그룹 sm/600 ↔ 종목명 xs) 표시되고, 종목 개수는 가격
  컬럼과 겹치던 우측 정렬에서 그룹명 옆 인라인으로 이동, 접기 chevron은
  좌측 폴더 관용구(펼침 ▼/접힘 ▶)로 바뀜. 가격 크기는 유지되어 시세 가독성
  영향 없음.
- **sticky 그룹 헤더**: 긴 관심종목 목록을 스크롤해도 현재 보고 있는 그룹명이
  패널 상단에 고정되어 어느 섹터를 보는 중인지 항상 보임.
- 그룹 접기 토글에 접근성 보강: 라벨 버튼에 명시적 이름("그룹명 개수")과
  `aria-expanded` 상태 노출 — 스크린리더가 접힘/펼침을 읽을 수 있음.
- 디자인 시스템 문서에 "Watchlist group header" 패턴 기록(크기 위계·인라인
  개수·sticky 배경 트릭) 및 Decisions Log 정리.

## [0.6.4.0] - 2026-06-08

### Added
- **/live 차트 마우스 휠 인터랙션**: TradingView 방식의 3가지 휠 동작 추가.
  - 휠: 화면 오른쪽 끝을 고정한 줌인/줌아웃 — 라이브 엣지에서는 최신 캔들이
    제자리에 머물고, 과거 구간을 보던 중에도 뷰가 "지금"으로 끌려가지 않음.
  - Ctrl(Cmd)+휠: 마우스 커서 아래 지점을 고정한 줌 — 커서 위치의 캔들이
    화면에서 움직이지 않음.
  - Shift+휠: 줌 없이 x축 좌우 이동 — 오른쪽으로는 마지막 캔들에서 멈춤
    (오른쪽 벽). 차트 위에서 휠을 굴려도 페이지는 스크롤되지 않음.
  - Firefox 같은 라인 단위 휠 브라우저를 위한 deltaMode 정규화 포함 — 모든
    브라우저에서 같은 줌 감도.
  - 트랙패드 가로 스와이프 팬·핀치 줌·드래그 팬은 기존 그대로 동작.
- 용어 정식화: **Live Edge**·**Right Wall**을 CONTEXT.md 용어집에 등재.

## [0.6.3.0] - 2026-06-08

### Fixed
- **관심종목·스크리너 패널이 차트 높이를 흔들던 레이아웃 버그 수정**: 패널
  콘텐츠가 화면보다 길어지면 /live 차트가 화면 밖까지 늘어나고(실측 최대
  4,600px+), 그룹을 접고 펼 때마다 차트 높이가 함께 출렁이던 문제를 앱 셸
  grid 행 계약(`minmax(0, 1fr)`)으로 근본 수정. 이제 차트는 항상 화면에
  맞고, 긴 관심종목/스크리너 목록은 패널 내부 스크롤로 끝까지 볼 수 있음
  (기존에는 화면 아래 항목이 스크롤 불가로 접근 불가였음).
- 실브라우저 레이아웃 회귀 테스트 2종 추가(관심종목 접기/펼치기 불변성,
  스크리너 긴 결과) — jsdom에는 레이아웃 시임이 없어 e2e가 유일한 가드.

## [0.6.2.0] - 2026-06-07

### Fixed
- **/live 차트 x축 날짜 라벨 오류**: 타임프레임 전환(D/W/M)이나 좌측 팬 과거
  데이터 로드 후, 과거 구간의 연도/날짜 라벨이 이전 화면의 날짜로 표시되던
  버그 수정 (예: 2021~2026 주봉에 '07/'08 표시, 작년 구간 날짜가 1년씩 밀림).
  가상 시간축을 첫 세션의 실제 개장 시각에 앵커하고, 종목·타임프레임 전환 시
  차트 인스턴스를 재생성해 차트 라이브러리의 시간값 기반 캐시(틱 가중치·라벨)
  잔존을 차단.
- 전환 직후 새 차트가 초기 뷰포트를 받지 못하던 문제 수정 — 분봉은 최근 300봉
  윈도우가, 일/주/월봉은 전체 맞춤이 새 차트에 정상 적용.

### Changed
- 차트 시간축 변환(`toVirtual`)을 이진 탐색으로 전환하고 틱 가중치 계산을
  단일 패스로 정리 — 분봉 ~5,000봉 갱신 경로의 비용 절감.
- SSE 갱신 시 세그먼트 배열 identity를 내용 기준으로 안정화 — 내용이 같은
  푸시는 축 객체와 라벨 캐시를 보존.

## [0.6.1.0] - 2026-06-05

### Added
- **관심종목 그룹 관리 UI** (로컬 0.5.7.0~0.5.10.1 통합): 그룹 생성/이름 변경/삭제,
  헤더 `⋯` 메뉴, 우측 chevron 접기(상태 localStorage 영속화), 그룹 순서 변경(패널 ▲▼ +
  편집 모달 ⠿ 드래그), 우클릭 → 그룹으로 이동. 체크 표시를 공용 `ui/CheckIcon`으로 통합.

### Fixed
- Escape 이중 닫힘(모달/메뉴 먼저 닫고 다음 Escape가 패널), hover 전용 버튼 키보드
  접근성(Tab opacity 계약), GroupNameModal 거부 시 unhandled rejection 없이 재시도.

### Tests
- 폴더 도입 이후 깨져 있던 watchlist e2e 복구·재편(컨텍스트 메뉴/그룹 메뉴/Escape 레이어링/
  편집 모달 드래그, 총 5스펙).

> 세부 변경 이력은 아래 [0.5.10.1]~[0.5.7.0] 항목 참조. v0.6.0.0(KRX→KIS) 위에 병합.

## [0.6.0.0] - 2026-06-05

### Added
- **ETF·ETN 종목 지원**: 종목 검색에 ETF와 ETN이 함께 나옵니다. KRX의 새 영숫자
  티커(`0000H0` 같은)와 7자리 ETN 코드(`Q500093`)가 관심종목 추가·캘린더·캡처
  전 구간에서 그대로 동작합니다 — 이전에는 검색에만 보이고 클릭하면 거부됐습니다.
- **자격증명 없는 종목 검색**: 종목 목록을 KIS의 무인증 정적 파일(.mst)에서
  받아오므로, 아무 키를 설정하지 않아도 검색이 동작합니다. 목록이 비어 있으면
  부팅 시 백그라운드로 자동 다운로드합니다.

### Changed
- **데이터 소스 KRX → KIS 전환**: 종목 목록과 거래일(휴장일) 조회가 모두
  KIS Open API로 옮겨갔습니다. `KRX_ID`/`KRX_PW`는 더 이상 필요 없고,
  거래일·실시간 기능에는 기존 `KIS_APP_KEY`/`KIS_APP_SECRET`만 사용합니다.
- **에러 안내가 원인을 구분합니다**: "자격증명 미설정"(키를 설정하세요)과
  "KIS 일시 오류"(잠시 후 재시도)를 다른 메시지로 안내합니다 — 멀쩡한 키를
  헛되이 점검하게 만들던 안내를 정리했습니다. `.env`에 키를 추가한 뒤
  재시도하면 서버 재시작 없이 바로 반영됩니다.

### Fixed
- **일부 종목이 검색에서 누락되던 문제**: 종목 마스터 파싱의 1바이트 오프셋
  오류로 이름이 긴 종목(40바이트 풀네임)이 통째로 빠졌습니다. 실제 데이터로
  검증해 수정했습니다.
- **토큰 만료·키 교체 후 멈춤**: KIS가 토큰을 거부하면 최대 24시간 동안
  실시간·시세 기능이 복구되지 않던 문제 — 이제 토큰을 자동 폐기하고 한 번
  재발급해 즉시 복구합니다. 키를 교체해도 옛 토큰을 재사용하지 않습니다.
- **간헐적 UI 멈춤**: 토큰 발급과 거래일 조회(차단형 네트워크 호출)가 서버
  이벤트 루프 위에서 돌아 모든 화면이 최대 10초씩 얼던 문제를 백그라운드
  스레드로 옮겨 해결했습니다. 장애 시에도 60초 간격으로만 재시도합니다.
- **KIS 일시 오류 한 번에 거래일 조회 전체가 실패하던 문제**: 호출당 1회
  재시도를 추가했습니다(실측 ~1/6 호출이 일시 500을 반환).
- **캘린더 장애 중 수동 수집이 "성공"으로 보이던 문제**: 거래일을 가져오지
  못하면 이제 항목별로 실패 사유가 표시됩니다 — 조용히 0건 수집으로 끝나지
  않습니다.
- **업그레이드 직후 종목 검색이 비던 문제**: 이전 버전의 종목 캐시 파일을
  그대로 읽어 쓰고, 백그라운드에서 새 형식으로 갱신합니다.

### Removed
- **pykrx 의존성 제거**: KRX 로그인 기반 조회와 `KRX_ID`/`KRX_PW` 환경변수가
  완전히 사라졌습니다(연쇄 의존성 15개 패키지 포함).

## [0.5.10.1] - 2026-06-05

### Fixed
- **그룹 추가/이름 변경 실패 처리**: 서버가 거부해도 unhandled rejection 없이
  다이얼로그가 열린 채로 남아 재시도할 수 있습니다.

### Internal
- 코드리뷰 후속 정리: 폴더 순서 스왑 로직을 `swapFolderOrder`(grouping.ts)로 승격해
  패널 ⋯ 메뉴와 편집 모달이 공유, 패널의 두 앵커드 메뉴 셸을 `AnchoredMenu`로 통합,
  접기 toggle을 함수형 업데이터 + 반응형 영속화(effect)로 재구성하고 기록 시점에
  삭제된 그룹 키를 정리, 드로어 테스트에 localStorage 격리(beforeEach clear) 추가,
  CheckIcon 기본 크기(18) 회귀 테스트 추가.

## [0.5.10.0] - 2026-06-05

### Added
- **우클릭 → 그룹으로 이동**: 관심종목 패널 종목 우클릭 메뉴에 `그룹으로 이동` 섹션이
  추가됐습니다 — 현재 그룹을 제외한 그룹들과(그룹 소속이면) **미분류**가 나열되고,
  누르면 편집 모달 없이 바로 이동합니다.
- **그룹 접기 상태 영속화**: 패널 그룹의 접힘/펼침이 localStorage에 저장되어 패널을
  닫았다 열어도 유지됩니다.

### Fixed
- **편집 모달 그룹 행 키보드 접근**: hover에서만 보이던 ▲▼✎🗑 버튼이 Tab 포커스로도
  도달·표시됩니다(패널 ⋯과 같은 opacity 계약).

### Tests
- **watchlist e2e 복구·재편**: 폴더 도입(0.5.5.0) 이후 mock 형태가 낡아 깨져 있던
  watchlist e2e를 복구하고(`watchlist-context-menu` + 공용 `liveMocks`), 제거된 패널
  드래그 기능의 `watchlist-reorder.spec.ts`는 폐기 후 **편집 모달 ⠿ 드래그**로
  포팅했습니다(`watchlist-edit-reorder.spec.ts`). 그룹 ⋯ 메뉴·Escape 레이어링·
  그룹으로 이동을 덮는 e2e도 추가됐습니다(총 5건 통과).

## [0.5.9.0] - 2026-06-05

### Added
- **패널에서 그룹 순서 변경**: 그룹 헤더 `⋯` 메뉴에 `▲ 위로 이동` / `▼ 아래로 이동`이
  추가됐습니다(맨 위/맨 아래에서는 비활성). 편집 모달과 같은 전체 순서 계약을 씁니다.

### Fixed
- **Escape 이중 닫힘**: 모달이나 메뉴가 열린 상태에서 Escape를 누르면 관심종목 패널까지
  한번에 닫히던 문제를 수정했습니다 — 이제 Escape는 열린 모달/메뉴를 먼저 닫고,
  다음 Escape가 패널을 닫습니다.
- **그룹 `⋯` 키보드 접근**: hover에서만 나타나던 `⋯` 버튼이 Tab 포커스로도 도달·표시
  됩니다(display 숨김 → opacity 숨김 전환).

### Changed
- **사전필터 체크 아이콘 통합**: 스크리너 사전필터 모달의 체크 표시를 공용 `ui/CheckIcon`
  으로 교체했습니다(미활성 링 안에 희미한 체크가 생기는 미세한 외관 변화).

## [0.5.8.0] - 2026-06-05

### Added
- **그룹 헤더 ⋯ 메뉴**: 관심종목 패널의 그룹 헤더에 마우스를 올리면 `⋯` 버튼이 나타나고,
  누르면 그룹명 헤더와 함께 `✎ 그룹 이름 변경` / `🗑 그룹 삭제` 메뉴가 열립니다.
  이름 변경은 기존 이름이 채워진 다이얼로그로, 삭제는 즉시 실행되며 소속 종목은
  **미분류**로 이동합니다(데이터 비손실). 미분류 헤더에는 메뉴가 없습니다.

### Changed
- **그룹 접기 표시를 우측 chevron으로**: 그룹 헤더 왼쪽의 `▸/▾` 글리프를 행 오른쪽 끝의
  `∧`(펼침)/`∨`(접힘) 화살표 버튼으로 옮겼습니다. 그룹명 클릭과 화살표 클릭 모두
  접기/펼치기를 토글합니다.

## [0.5.7.0] - 2026-06-05

### Added
- **새 그룹 만들기**: 관심종목 패널 `편집` 버튼이 이제 메뉴(`관심 편집` / `새 그룹 만들기`)를
  엽니다. `새 그룹 만들기`는 이름만 입력하는 `그룹 추가하기` 다이얼로그를 띄워 패널에 빈
  그룹을 바로 만듭니다. `관심 편집`은 기존 편집 모달을 엽니다.

### Changed
- **편집 모달 체크박스 통일**: 종목 다중선택 체크박스(전체 선택 + 각 행)를 보조지표 모달과
  같은 원형 체크 아이콘으로 교체했습니다(공용 `ui/CheckIcon`으로 추출해 양쪽이 공유).
- **편집 모달 종목 행 간소화**: 종목코드 컬럼을 숨기고 종목명만 표시합니다.
- **용어 통일**: 관심종목 UI의 `폴더`를 `그룹`으로 통일했습니다(`관심 그룹`, `＋ 그룹 추가`,
  `그룹 이름`). 도메인/API 식별자(folder)는 그대로입니다.

### Fixed
- `/live` 차트에서 **과거 캔들을 불러올 때 화면이 이동하던** 문제를 근본적으로
  고쳤습니다. 과거로 드래그한 뒤 일부만 되돌아와 데이터 중간을 보고 있으면,
  fetch가 끝나는 순간 보던 내용이 통째로 며칠 과거로 밀렸습니다(차트 라이브러리가
  이 위치에서는 화면을 보정하지 않는 것이 실측으로 확인됨). 이제 데이터가
  도착하는 바로 그 프레임에 "직전에 보던 화면"을 기록해 두었다가 같은 봉이
  같은 자리에 오도록 되돌립니다 — 기록과 적용 사이에 시간 차가 없어 어떤
  드래그·줌 조합에서도 낡은 위치로 튀지 않습니다. 최신봉을 보고 있을 때는
  라이브러리가 스스로 화면을 보존하므로 아무것도 하지 않고, 과거로 드래그해
  빈 영역을 보고 있을 때는 보이던 봉은 그대로 둔 채 빈 공간만 새 데이터로
  채워집니다. 줌 배율(봉 폭)은 어떤 경우에도 변하지 않습니다.

## [0.5.6.0] - 2026-06-05

### Changed
- **관심종목 편집 모달 외형 통일**: 차트의 보조지표(지표) 모달과 같은 형태로 정렬했습니다.
  공용 모달 외형(제목·✕·ESC·바깥 클릭 닫기), 하단 `닫기` 버튼, 좌측 `관심 폴더` 섹션 헤더를
  갖춥니다. 폴더 추가·이름변경·삭제·순서변경·이동·드래그 정렬 기능은 그대로입니다.
- **편집 모달 기본 화면 = 미분류**: 편집 모달은 이제 폴더와 **미분류**만 보여주며, 열 때
  기본으로 **미분류**를 표시합니다(기존 `모든 종목` 통합 보기를 대체).

### Removed
- **우측 패널 빠른 추가 제거**: 관심종목 우측 패널 헤더의 `종목 추가` 입력을 제거했습니다.
  종목 추가는 `편집` 모달로 일원화됩니다.
- **편집 모달 `모든 종목` 제거**: 폴더 구분 없이 전체를 보던 `모든 종목` 의사폴더를 제거하고,
  폴더/미분류 단위 관리로 정리했습니다.

## [0.5.5.0] - 2026-06-05

### Added
- **관심종목 폴더**: 오른쪽 관심종목 패널의 종목을 사용자가 만든 폴더로 묶을 수 있습니다.
  드로어는 폴더별로 그룹지어 보여주고(접기/펼치기 + 종목 수, **미분류**는 항상 맨 끝),
  각 행에는 기존처럼 라이브 시세(현재가·등락률·전일대비)가 그대로 표시됩니다.
- **관심종목 편집 모달**: 패널 헤더의 `편집` 버튼으로 2-pane 편집창을 엽니다. 왼쪽은
  폴더 목록(그룹 추가·이름변경·삭제·순서변경), 오른쪽은 선택한 폴더의 종목 목록
  (추가, 체크박스 다중선택, 다른 폴더로 이동, 삭제, 폴더 내 드래그 정렬). 모든 구조 편집은
  이 모달 한 곳으로 일원화됐습니다.
- `watchlist.json`이 폴더를 담는 v2 문서 형식(`{schema_version, folders, entries}`)으로
  확장됐습니다. 기존 v1 파일은 처음 열 때 자동으로 v2로 변환되며(절대 격리/폐기하지 않음),
  폴더는 수집 동작에 전혀 영향을 주지 않습니다(스케줄러는 폴더와 무관하게 전 종목을 수집).

### Changed
- 관심종목 드로어가 평면 목록에서 **폴더 그룹 + 편집 모달** 구조로 바뀌었습니다. 드로어
  자체는 읽기·차트 이동·빠른 해제(우클릭/Delete)만 담당하고, 정렬은 폴더 안에서 모달로 합니다.

### Removed
- 별도의 `/watchlist` 풀페이지를 제거했습니다(편집은 패널 + 편집 모달로 대체).
- 관심종목 평면 드래그 재정렬(`PUT /api/watchlist/order`)을 제거했습니다 — 폴더 내 정렬로 대체.

## [0.5.4.0] - 2026-06-05

### Fixed
- `/live` 차트에서 **과거로 드래그해 캔들을 더 불러온 직후 최근으로 되돌아오면,
  fetch가 끝나는 순간 화면이 과거 위치로 튀던** 문제를 고쳤습니다. 과거 드래그는
  "지금 보던 위치"를 기준점으로 캡처하고 150ms 뒤 데이터를 받아오는데, 그 사이
  사용자가 최근으로 되돌아와도 기준점이 과거 위치에 그대로 남아, 데이터가 도착해
  과거 봉이 앞에 붙는 순간 복원 로직이 그 낡은 기준점으로 화면을 되돌렸습니다.
  이제 사용자가 로드된 봉 영역으로 되돌아오는 즉시 낡은 기준점을 무효화합니다.
  데이터는 그대로 미리 받아오고(원하던 동작), 화면 이동만 사라집니다. 브라우저
  실측 결과 lightweight-charts의 `setData`가 과거 봉 추가 시 화면을 스스로
  보존하므로 복원 로직 없이도 보던 위치가 유지됩니다.

## [0.5.3.0] - 2026-06-05

### Fixed
- `/live` 차트에서 **관심종목을 처음 클릭할 때 캔들이 "두 번 그려지던"** 현상을
  고쳤습니다. 처음 보는 종목은 과거 캔들을 받아오는 데 ~3초가 걸리는데, 그동안
  보조지표가 먼저 도착해 차트가 약 60봉으로 좁게 잡혔다가, 캔들이 도착하면 약
  300봉으로 다시 줌아웃되며 한 프레임 깜빡였습니다(lightweight-charts가 줌 폭
  변경을 항상 한 프레임 늦게 그리는 특성 때문). 이제 줌이 최종 상태로 안정될 때까지
  반투명 덮개로 차트를 가렸다가 부드럽게 드러내, 캔들이 처음부터 올바른 줌으로
  **한 번에** 나타납니다. 종목을 전환할 때도 이전 종목의 캔들이 잠깐 비치지 않습니다.
  뷰포트 계산 로직(과거 데이터 복원·우측 끝 고정)은 그대로 두고 시각적으로만 가립니다.

## [0.5.2.0] - 2026-06-05

### Fixed
- `/live`의 **10호가가 장중 갑자기 사라지던** 문제를 고쳤습니다. KIS·파싱·프론트
  경로는 정상이었고, 라이브 캡처 **poller 태스크가 예외 한 번에 traceback 없이
  조용히 죽은** 뒤 상태는 거짓으로 `running:true`를 보고해 호가 버퍼가 빈 채로
  남았던 것이 원인입니다. (ADR-0064)

### Changed
- 거래일 게이트가 일별 OHLCV(장중엔 오늘 봉이 아직 발행 안 됨) 대신 KRX 거래일
  **달력**(`is_trading_session_today`)을 사용해, 살아있는 거래일이 장 초반에
  거짓으로 닫히지 않습니다. 주말은 KRX 호출 전에 단락 처리합니다. (ADR-0064)
- 라이브 poller가 자가 복원력을 갖습니다: `run_forever` 루프가 일시적 예외를
  로그 후 계속하고(today-promoter 패턴), `/api/live/status`의 `running`이 실제
  태스크 생사를 반영하며, 장중 죽거나 멈춘 poller를 **세션 개장 기준** staleness로
  감지해 자동 재시작하는 watchdog을 추가했습니다. (ADR-0064)

## [0.5.1.0] - 2026-06-05

### Fixed
- `/live` 차트의 **호가비·총잔량 보조지표**에서 장마감 **완전-동시호가 구간**
  (연속매매 호가가 하나도 없는 15:21–15:30 봉)이 이제 **0으로 제외**됩니다.
  예전엔 그 구간의 마지막 동시호가 3호가 값으로 폴백해 지표에 동시호가가
  새어들어갔습니다. 디스플레이의 Auction Mask 토글과 무관하게 계산 자체에서 빼며,
  점은 0으로 남겨 마스크·오버레이 밴드·일자경계 연결선 처리는 그대로 유지합니다.
  과거 날짜 조회와 오늘 라이브 양쪽에 적용했습니다. (ADR-0062)
- 호가비·총잔량 라인이 직전 연속매매 봉(예: 15:18)에서 동시호가 구간으로
  **내려가며 뻗던 연결선**이 사라졌습니다. (ADR-0029 갭)
- 우측 **10호가 사이드바**도 동시호가를 구조적으로 제외해 보조지표와 일치합니다.
  straddle 봉(예: 3분봉 15:18)에서 3호가 동시호가 책 대신 그날 마지막 연속매매
  호가창을 보여줍니다. (ADR-0062)

### Changed
- **1분봉 15:19**처럼 마감 직전 마지막 연속매매 봉에 마우스를 올리면 **총잔량**의
  데이터 점(호버 마커)이 다시 보입니다. 연결선 끊기 처리가 그 점의 마커 색까지
  투명하게 만들어 사라졌던 것을, 마커 색을 분리해 복원했습니다(호가비와 일치).

## [0.4.4.0] - 2026-06-03

### Fixed
- `/live` 차트의 **호가비·총잔량 보조지표**가 장마감 동시호가(15:20–15:30) 데이터를
  더 정확히 제외합니다. 예전엔 "15:20 정각" 고정 시각으로 동시호가를 잘라, 실제 진입이
  15:19:55나 15:20:05처럼 매일·종목마다 흔들리면 동시호가 호가가 봉에 새어들어가 값이
  튀었습니다. 이제 **호가창 구조**(동시호가에 들어가면 노출 호가가 10단계→3단계로 줄어듦)로
  경계를 잡아, 진입 시각과 무관하게 그날 마지막 연속매매 호가를 정확히 반영합니다.
  1분봉에서도 15:19/15:20 봉이 깨끗합니다. 과거 날짜 조회와 오늘 라이브 양쪽에 적용했고,
  반장(12:30 마감)도 과거 날짜는 자동 대응합니다. (ADR-0062)

## [0.4.3.0] - 2026-06-03

### Added
- `/live` **그리기 속성 패널**(수평선 등 도형을 선택하면 뜨는 색·두께·선스타일·삭제
  툴바)이 이제 **드래그한 마지막 위치를 유지**합니다. 이전에는 다른 도형을 클릭할 때마다
  패널이 초기 앵커(가로 중앙·선 위)로 되돌아갔지만, 한 번 그립으로 끌어 옮기면 그 위치를
  세션 동안 고수합니다. 첫 선택은 종전대로 도형 옆에 자동 배치되고, 새로고침하면 다시
  앵커로 리셋됩니다(세션 한정).

### Internal
- 패널은 항상 마운트되어 위치 state가 이미 세션 내내 보존되므로, 버그의 원인은 "위치를
  저장하지 않음"이 아니라 선택이 바뀔 때마다 위치를 앵커로 **덮어쓰던** re-anchor effect
  였습니다. `userMovedRef` 플래그(드래그 `onMove`에서 set)로 그 effect를 게이트 —
  사용자가 한 번 드래그하면 재앵커를 중단합니다. localStorage 영속화는 없습니다(세션 한정).
  설계·근거는 ADR-0062(ADR-0032의 *per-selection 재앵커* 조항을 부분 대체, *no-persistence*
  결정은 유지).

## [0.4.2.0] - 2026-06-03

### Added
- `/live` 캔들 차트에 **현재가 라인**을 추가했습니다. 마지막 캔들 종가(=현재가) 위치에
  **수평 점선**을 그리고 **y축에 현재가 가격 태그**(원화 ko-KR 포맷)를 표시합니다. 라인·태그
  색은 **전일 대비 등락 방향**(상승 빨강 / 하락 파랑 / 보합·장전 중립)으로, 차트 위 Live
  Status Bar의 등락률 색과 항상 일치합니다(색 기준 `change_won ?? change_pct`). 과거로
  스크롤해도 라인은 현재가에 고정되고, 모든 타임프레임(분/일/주/월)에서 표시됩니다.

### Internal
- 현재가 라인은 캔들 시리즈 옵션을 건드리지 않고 별도 `createPriceLine`을 거는 `/live`
  전용 오버레이(`LiveCurrentPriceLine`)로 구현 — 제네릭 candle projector 순수성과 전역
  `priceLineVisible/lastValueVisible=false` 컨벤션을 보존합니다. 가격·색 산출은 순수 함수
  (`deriveCurrentPriceLine`)로 분리해 단위 테스트. 설계·검증 근거는
  `docs/superpowers/specs/2026-06-03-live-current-price-line-design.md`.

## [0.4.1.0] - 2026-06-03

### Added
- `/live` 캔들 호버 툴팁의 **시·고·저·종 각 행에 등락률(%)** 을 가격 옆에 함께
  표시합니다. 각 %는 직전 봉(이전 캔들) 종가 대비이며 상승은 빨강·하락은 파랑으로
  색칠됩니다(분/일/주/월 모두 동일 기준). 직전대비 행은 금액(원)만 남기고, 미세
  변동이 반올림으로 `+0.00%`가 되면 색도 중립으로 맞춥니다.

## [0.4.0.0] - 2026-06-03

### Added
- 스크리너 일봉 수정주가가 이제 KIS 정확 계수로 정합화됩니다(ADR-0057). 수정주가 =
  원주가(SSOT, append-only) × KIS 계수 테이블(`factors.parquet`)로 파생되어, 액면분할
  종목의 과거 봉이 today-basis로 정확히 소급 보정됩니다(거래량은 ÷계수로 거래대금 보존).
- `hoga screener-backfill` CLI — 1회성 백필: KIS 수정주가로 `factors.parquet`를 구축하고
  (resumable), 원주가를 KIS와 대조·결측 보충하며(reconcile), 구·신 수정주가 차이를
  `impact-report.json`으로 요약합니다.

### Fixed
- 액면분할 종목의 약 64%가 미보정이던 수정주가 버그(로컬 ±3% 휴리스틱이 카카오·삼성전자우
  등을 통째로 놓침)를 KIS 정확 계수 적용으로 복구. 절대 가격 레벨을 쓰는
  신고가·신고거래량·이동평균·등락률 스크리너 조건이 이제 올바른 값으로 평가됩니다.
- 가격대별 거래량 프로파일에서 상단 경계 빈이 누락되던 off-by-one과 상한가(폭 0) 종목에서
  발생하던 0-나눗셈 500 오류 수정.

### Changed
- 거래량 프로파일·호가비율·체결강도 SQL을 `tables/{candles,trades,snapshots}` 모듈로
  추출(ADR-0001). `bundle`은 경로·결측 가드·시간 재기준만 담당하는 코디네이터로 축소.

## [0.3.10.0] - 2026-06-03

### Added
- `/live` 차트에서 **캔들에 마우스를 올리면 그 봉의 정보를 툴팁으로 표시**합니다 —
  시·고·저·종, 직전 봉 대비 변동(금액·%), 거래량, 직전봉 거래량비(같으면 100%). 캔들(가격)
  페인 위에서만 뜨고 차트를 벗어나면 사라지며, 라이브 갱신 중에도 호버한 봉의 값이 실시간으로
  바뀝니다. 분/일/주/월 전 구간 동작하고, 설정에서 켜고 끌 수 있습니다(기본 켜짐). 등락 기준은
  앱의 등락률(전일 종가)과 달리 **직전 봉 대비**로 통일했습니다(ADR-0059).

## [0.3.9.0] - 2026-06-03

### Internal
- 종목 검색 코드 정리(동작·결과 불변). 프론트 `filterSymbols()` 정렬이 비교마다
  `toLowerCase()`를 재계산하던 것을 종목명당 1회 사전계산으로 바꿔 백엔드 `search()`의
  `key=` 의미와 일치시켰습니다. 백엔드 `search()` docstring의 'code-prefix' 오기재를
  'name-prefix'로 정정(정렬은 종목명 접두사 기준).

## [0.3.8.0] - 2026-06-03

### Changed
- 종목 검색이 **영문 대소문자를 구분하지 않습니다.** 예전엔 `CJ`·`KTcs`·`S-Oil`처럼
  영문이 섞인 종목명을 찾으려면 케이스를 정확히 맞춰야 했지만(`cj`로는 `CJ`가 안 나옴),
  이제 `cj`/`ktcs`/`s-oil` 어떤 케이스로 입력해도 매칭됩니다. 한글 종목명 검색과 숫자
  코드 검색 동작은 그대로이며, 백엔드 `/api/symbols`와 프론트 클라이언트 필터에 동시
  적용됩니다.

## [0.3.7.0] - 2026-06-03

### Changed
- `/live` 분봉 차트를 **왼쪽으로 끌어 과거 데이터를 부를 때** 빠르고 부드러워졌습니다.
  예전엔 줌과 무관하게 항상 42일치(~28거래일)를 한 번에 새로 받아 **한 번 끌 때마다
  ~32초** 멈췄습니다. 이제 **고정 3거래일씩 점진적으로** 받아 화면이 찰 때까지 채웁니다:
  어떤 줌이든 **첫 그림이 ~3.4초 안에** 보이고(latency cap), 넓은 구간은 3거래일씩
  여러 번에 걸쳐 채워집니다. 한 번 본 범위 재방문은 디스크 캐시로 즉시. 일/주/월봉은
  기존 one-shot 유지. (ADR-0059)

### Internal
- `/live` 좌측 팬 backfill + viewport 보존(prepend-restore shift, 진행 settle-loop,
  lazy-fetch trigger)을 `LiveChartRoot`에서 headless `useViewportBackfill` 훅으로 추출.
  동작 불변, locality 향상. 종료 판정·스텝 크기는 순수 함수(`planFillStep`/`stepChunkDays`)로
  격리 단위 테스트.

## [0.3.6.0] - 2026-06-03

### Fixed
- 차트 데이터 무결성: parser가 archive한 **series-level invariant 위반**(예
  `series.candles_ts_monotonic` — 캔들 `ts_ms` 중복으로 lightweight-charts `setData`가
  터지는 직접 원인)이 read-path에서 무시되던 결함을 고쳤습니다. 이제
  `classify_from_meta`가 `meta.json`의 archived `series.*` error를 INVALID 판정에
  반영해, 해당 Stock-Date를 `build_range_bundle`이 차트에 내보내지 않습니다. meta
  invariant는 여전히 live 재평가, series는 archived만 union(double-count 방지),
  parquet 재로드 없음(ADR-0020 §4.6 amendment). 수정 이전 archive의 false-positive는
  `hoga validate --fix` 1회로 정리.

## [0.3.5.0] - 2026-06-03

### Changed
- (내부 리팩터, 동작 변화 없음) `/api/live/past-daily-candles`(일봉)와
  `/api/live/past-investor-net`(투자자 순매수)의 near-verbatim 중복 핸들러를
  `batched_daily_walkback` 공유 orchestrator로 통합했습니다. 두 핸들러는 fetch
  클로저 + output key만 제공하는 얇은 adapter가 되고, gap/cache/today/dedupe 조립은
  한 곳에서 격리 단위 테스트됩니다. KIS 일별 walk-back의 커서 감산은
  `_prev_day_yyyymmdd` 공유 헬퍼로 추출(ADR-0060).

### Notes
- ADR-0061: source resolver 4개는 서로 다른 질문(데이터 읽기·inventory 표시·완성도
  state·존재 여부)에 답하므로 통합 거부 — 통합은 shallow abstraction이 된다는 근거 기록.

## [0.3.4.0] - 2026-06-03

### Fixed
- `/live` 보조지표 중 **호가비·호가총합·체결강도**가 마감 직전 종가 동시호가
  (15:20~15:30) 데이터를 계산에 끌어들이던 문제를 고쳤습니다. 15:20이 버킷 경계가
  아닌 타임프레임(3·15·30분봉)에서, 15:20을 가로지르는 버킷(예: 3분봉 15:18 봉)이
  대표값으로 15:20 동시호가 호가창을 집어 마감 직전 값이 튀었습니다. 이제 그런
  버킷은 **15:20 직전 마지막 호가 스냅샷**으로 계산되어 정확한 값으로 표시됩니다.
  과거 날짜(`/api/range`)와 당일 실시간(SSE) 양쪽 모두 적용되며, 반장일은 백엔드가
  그날의 실제 마감 시각을 기준으로 처리합니다. (ADR-0029 개정)

## [0.3.3.0] - 2026-06-03

### Changed
- 인벤토리 상세 테이블의 `Captures`(평생 누적 캡처 횟수 `×N`) 컬럼을 `재시도`
  (`fail_streak`) 컬럼으로 교체했습니다. 이제 각 종목·날짜가 차단(5회 연속 실패)까지
  얼마나 남았는지 한눈에 보입니다 — 정상은 `—`, 1~4회는 `N/5`, 차단되면 `차단됨`.
  평생 누적 `×N` 표시는 캡처 큐 화면에 그대로 유지됩니다.

## [0.3.2.0] - 2026-06-03

### Changed
- 스크리너 결과의 현재가·등락률을 전 종목 실시간(라이브)으로 표시합니다. 이전에는
  우측 패널이 상위 30종목만 라이브였고 `/screener` 전체 페이지는 전부 어제 종가
  기준이었는데, 이제 관심종목과 동일하게 모든 행이 현재가 기준으로 갱신됩니다.

### Fixed
- 장 시작 전·시세 파싱 실패 시 스크리너 등락률이 "어제 종가 기준값"으로 잘못
  표시되던 문제를 고쳤습니다. 이제 관심종목과 동일하게 "—"로 표시됩니다.

## [0.3.1.0] - 2026-06-03

### Fixed
- 완성 불가능한 종목-날짜의 무한 재캡처를 차단합니다. hogaplay 데이터가 장중에
  끊겨 매번 불완전하게 끝나는 (종목, 날짜)는 이제 5회 연속 실패로 집계되어 차단되고,
  인벤토리에 "차단됨 (5/5)" 배지와 "잠금 해제" 버튼이 표시됩니다. 이전에는 이런
  캡처가 매번 "성공(done)"으로 처리돼 재시도 카운터(fail_streak)가 리셋됐고,
  "모두 재캡처" 버튼을 누를 때마다 외부 서버에 무한히 요청이 나갔습니다
  (한진칼 2026-06-01에서 ×16 관측). 판정 기준은 인벤토리의 ✓(완전) 여부와 동일합니다.
- 데일리/캐치업 스케줄러가 차단된 관심종목 날짜를 조용히 건너뛰지 않고 경고 로그로
  알립니다 — 무인 캡처에서 빠진 날짜를 운영자가 바로 인지할 수 있습니다.

## [0.3.0.0] - 2026-06-02

### Added
- 관심종목 패널 드래그 재정렬. 우측 레일의 관심종목을 마우스로 끌어 순서를 바꿀 수 있습니다.
  행을 8px 이상 끌면 재정렬, 그 미만은 기존처럼 클릭(차트 점프)으로 처리돼 두 동작이
  충돌하지 않습니다. 드롭 즉시 화면이 새 순서로 바뀌고(낙관적 갱신, 실패 시 롤백)
  `PUT /api/watchlist/order`로 서버에 영속됩니다 — 순서는 전역이라 전체 페이지 목록과
  `catchup_all` 순회에도 반영됩니다. 서버 재정렬은 stale 코드에 관용적입니다(모르는 코드는
  무시, 언급 안 된 항목은 기존 순서로 뒤에 보존). 공유 `QuoteRow`는 선택적 drag props만
  받아 스크리너 패널은 영향이 없으며, 실제 포인터 드래그는 Playwright e2e로 검증합니다
  (ADR-0057 · ADR-0058).

## [0.2.0.0] - 2026-05-31

### Added
- 외국인·기관 순매수량 일봉 지표. `/live`의 일봉(D) 차트에 외국인/기관 순매수 수량을
  별도 패널로 그립니다 — 순매수(양수)·순매도(음수)를 부호 색으로 구분하고, 장기 구간은
  KIS 종목별 일별동향(FHPTJ04160001)의 date-cursor walk-back으로 채웁니다 (ADR-0055).
- Pane Legend 오버레이. 각 패널(캔들 이동평균, 거래량, 투자자 순매수) 위에 커서 시점의
  값을 실시간으로 표시합니다. 행의 ✕ 버튼으로 해당 지표를 끄고, eye 버튼으로 선을 숨길
  수 있으며, 지표 팝오버에서 각 지표의 상세 패널로 바로 이동합니다.
- 거래량 패널 on/off 토글과 이동평균 숨김(hide) 기능. 끈 패널은 차트에서 제거되어
  세로 공간을 돌려줍니다.

### Fixed
- 일/주/월봉에서 캔들을 호버할 때 `/api/brokers/series`로 불필요한 조회가 나가던 문제.
  커서 기반 브로커 조회를 분봉에서만 동작하도록 게이트했습니다 (ADR-0044 — 분봉 외에는
  per-cursor parquet가 없음). 사이드바의 spot 표시 게이트는 화면 표시만 막았을 뿐
  조회 자체는 막지 못했습니다.
- 거래량을 끄면 패널 자체가 사라지도록 수정 (투자자 패널과 동작 일치).
- 패널 인덱스가 밀려 series가 재생성될 때 데이터가 다시 채워지지 않던 문제.

## [0.1.1.0] - 2026-05-31

### Removed
- The off-hours `/live` banner ("장 외 시간 — 09:00 KST에 폴링이 시작됩니다"). Live
  polling is gated server-side by the trading-hours window (`poller.py:_should_poll_now`),
  so the banner never affected capture — it was only an always-on row outside market
  hours. The chart reclaims that vertical space when the market is closed. The status
  bar `LIVE●` reflects socket liveness, not market phase, so it stays green off-hours.

### Fixed
- Capture queue detail rows rendered an invalid clock (e.g. "31:13:21") for timestamps
  in the KST 00:00–08:59 window. The detail formatter now reuses the shared
  `unixMsToKSTClock` helper, which wraps the hour correctly.

### Changed
- Retired the now-dead minute-tick machinery behind the live banner state (the
  per-minute re-render timer and the KST-hour computation); no remaining banner cause
  depends on the wall clock.

## [0.1.0.0] - 2026-05-31

First versioned release. Captures the `feat+frontend5` work since the previous
merge to `main` (120 commits): the real-time `/live` experience, the watchlist
and Right Rail shell, and a pass of architecture-review refactors.

### Added
- **Single multiplexed WebSocket** for the frontend (ADR-0053): one `/api/ws`
  endpoint fans out both events and live snapshots, code-filtered, with
  automatic reconnect and a liveness watchdog that force-reconnects a silently
  dead socket. Honest connection-state surface (LIVE / stale chip + status dot).
- **Live chart**: adaptive KST x-axis via `createChartEx`, and viewport scale +
  position preserved across historical-prepend (no jump when older bars load).
- **Watchlist + Right Rail**: global rail chrome and Watchlist Panel mounted in
  the shell grid; active-symbol heart toggle; the live poller re-syncs to the
  watchlist immediately on add/remove (stops on empty, preserves the buffer).
- **Symbol search**: header inline search (`/` to focus) and a headless
  `useSymbolCombobox` hook (keyboard nav, highlight, dismiss-on-outside-click).
- **Page shell**: thin `PageContainer` frame with tokenized page padding;
  `--tint-success-border` / `--tint-error-border` design tokens.

### Changed
- Typed the live SSE/WebSocket payload contract end-to-end and the poller's
  `LiveSnapshot` builders; narrowed chart `SeriesSpec`/projector return types off
  `any` to the lightweight-charts vocabulary.
- Single-sourced duplicated domain rules: the Unix-ms → YYYYMMDD KST calendar-day
  conversion (`util/time`), the `first_*.tsv` page-layout contract
  (`collector/orchestrator`), and the Closing Auction Window length.
- Lifted inventory grouping + default-to-first policy to the page (`selectGroup`);
  extracted a single `FullCaptureCountBadge`; replaced the Optional timing
  collector with a `NullTimingCollector`.
- Adopted `PageContainer` across the capture, inventory, and watchlist pages;
  consolidated the capture-queue push subscription to a single owner.

### Fixed
- `candles.write_parquet` now writes atomically like its sibling tables (closes a
  torn-write window on the hot read-path parquet).
- `disk_state.classify_stock_date` returns the full `Classification`, dropping a
  second `meta.json` read on the hot decide-capture path.
- Corrected the Daily Scheduler fire-time docs (18:00 → 17:00 KST) and the false
  "drift caught by TypeScript" claim on the by-hand BE↔FE wire mirror (added a
  schema-diff guard test instead).
