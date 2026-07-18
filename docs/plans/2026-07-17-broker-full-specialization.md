# 브로커 완전 특화 실행 플랜 — PR 분할·게이트 (ADR-0118)

웨이파인더 맵 [#679](https://github.com/Soochol/hoga-ops/issues/679)의 종착 산출물.
결정 전문은 ADR-0118, 삭제 표면 상세는
`docs/research/2026-07-17-kis-ws-deletion-surface.md`(+#682 코멘트의 rest_poller 증보).
실행 세션은 이 문서를 위에서 아래로 진행한다. **판정은 운영자 재량**(참고 지표: 정규장
저장 구멍 0 = analyze_gaps 1분+ 갭 없음 · 완결성 COMPLETE율 100% · 킥 자동복구 성공 ·
08:50 술어 경고 0). **되돌림 장치 없음 — fix-forward.**

## 선행 태스크 (코드 밖)

- [ ] **T1. 키움 앱키 5키 확보** — 현 4키 + 1(#680: 5키×200=1,000슬롯). `.env`에
  `KIWOOM_APP_KEY_5/SECRET_5` 추가(kiwoom_runtime 접미 관례).
- [ ] **T2. 정규장 스모크** (기존 키움 TODO 트랙에 편승, 장중 1회):
  0B/0D FID 레이아웃 확정 · `_NX` 0D 정규장 10호가 · cntr_tm=시작 라벨 ·
  **0F(거래원)/0w(프로그램) 페이로드 채록**. `_AL`은 미사용 확정이라 검증 불요.
  → cntr_tm·`_NX` 가정이 뒤집히면 해당 결정 재개봉(맵 Notes), 0F/0w가 뒤집히면
  PR-F 스킵(KIS REST 공급 영구).

## 단계 1 — 히트맵 키움 도그푸딩 (기존 TODO)

- [ ] `kiwoom_enabled` ON(4키로 가능) → kiwoom_live 승격·완결성·킥 복구를 실전 검증.
  이 단계가 관심종목 칼 컷오버의 **사전 검증**을 담당한다(#683).
- 게이트: 운영자 판정(참고 지표 상단).

## 단계 2 — 인프라 PR (관심종목 이관 전 코드 준비; KIS 경로 무변경)

### PR-A. `WsTick` 이주 (기계적, 독립 선행 가능)

- 신규 `hoga/live/ticks.py`(또는 `tick.py`)에 `WsTick` 이동, `ws_frames.py`는 re-export
  경유로 두거나 임포트 직치환. 임포트 치환 13곳: 프로덕션 7(`kiwoom_frames`·
  `kiwoom_ws_client`·`kiwoom_ondemand`·`broker_rest_poller`·`downsampler`·`stream`·
  `lifecycle`(TYPE_CHECKING)) + 테스트 6.
- 테스트: `test_adr_invariants._HOT_PATH_MODULES`에 신규 모듈 등재. 전체 스위트 그린.

### PR-B. 키움 워치독 루프 + 시간대 venue 스왑 (ADR-0118 §2·§5)

- `KiwoomSessionManager`에 30s 루프 신설(lifespan 태스크, `startup_runtime` 배선):
  ① `_conn_dead` 재빌드(현행 sync 내 로직을 루프로 승격) ② 스왑 실행 ③ 08:50 술어
  ④ 표적 재구독.
- 스왑: 기대 등록 집합 = `저장셋 × venue(target_ws_venue(now))`. 실행은
  unregister-before-register(키당 200 상한·온디맨드 점유 고려), `update_codes` diff.
- **08:50 술어**: KRX 복귀 스왑 후 저장셋 등록 ACK 완결 확인 — 09:00 전 미완이면
  재시도 + 경고 로그·진단 표기. (배치 REG ~1초/키 실측, 10분 완충.)
- `KiwoomWsClient`에 (tr/type, code) 단위 ACK 유예·`sub_missing` 파생 재구독이 없다면
  KIS `resubscribe_missing` 패턴 이식.
- 테스트: 스왑 경계(08:50/15:31) 시계 주입 · 스왑 중 킥 → 재파생 재등록 · 09:00 전
  미완 경고 발화. `test_kiwoom_session.py` 확장.

### PR-C. 참조 카운트 장부 + 온디맨드 매니저 통합 (#685)

- `KiwoomOnDemandSession` 삭제(미배선), 매니저에 표시 셋 API:
  `on_view_subscribe(code, venues, ref)` / `on_view_unsubscribe(...)` — 장부 항목
  (code, venue) → 참조 집합 {storage, display refs}. 전역 1회 등록 불변식.
- 해제 = 참조 0 후 30~60s 유예(만석 임계 근처는 즉시 회수). 키 선택 = 잔여 슬롯
  최다 연결. 킥 복구 = 장부 재파생 재등록(PR-B 루프에 합류).
- on_tick 라우팅 = 연결별 래퍼: 저장셋 멤버(bare code) → `stream.on_tick`, 그 외 →
  `buffer.publish`(phase/venue 키 동일 — 구 `KiwoomOnDemandSession._on_tick` 형태).
  `stream.py` 무변경.
- 뷰 와이어: `hoga/api/ws.py` subscribe 액션에 venue 전달(프론트 옵션), lifecycle
  `on_view_subscribe`를 키움 매니저로 위임(rest_poller 위임과 병존 — 삭제는 PR-G).
- 만석: 신규 실시간 거부 + WS 이벤트로 프론트 알림(토스트/배지).
- 테스트: 참조 카운트(두 탭 동일 종목 → 1등록, 한 탭 닫아도 유지 — 현행 버그 회귀
  가드) · 유예 타이머 · 만석 차단 · UN 열람 슬롯 산술(+1/+2). `test_kiwoom_ondemand.py`
  대체 재작성.

### PR-D. 거래원 합성 틱 재배선 (#683)

- `lifecycle._dispatch_broker_tick`의 브로드캐스트 대상을 KIS `_state.session.streams`
  → 키움 매니저의 관심종목 소유 스트림으로 교체(멤버십은 스트림 활성 셋이 흡수).
- 프로그램 콜렉터 무변경 확인(전용 저장소 — 접점 없음).
- CONTEXT.md provenance 노트: kiwoom_live/brokers는 KIS REST산(ADR-0111 승계),
  0F 전환 시 갱신.
- 테스트: `test_lifecycle_broker_poller.py`의 디스패치 대상 교체.

## 단계 3 — 관심종목 칼 컷오버 (PR-E, 비장중 배포·전환)

- `coverage.plan_storage_targets`: 관심종목을 `kiwoom_targets`에 편입(히트맵과 dedup
  합집합 = 저장셋 876), KIS `ws_targets`는 빈 튜플 → KIS conn은 dynamic-N에 의해
  자연 소멸(빈 파티션 = 연결 없음; KIS WS 스택은 코드로 잔존하나 무가동).
- `partition_kiwoom` 입력이 히트맵-only → 저장셋 전체로. 승격 루프
  `get_kiwoom_capture_codes`가 관심종목 포함(자동). 시그널 모니터 타깃 재소싱 확인.
- 프론트 소스 배지·화질 도트는 kiwoom status 표면으로 자동 추종(별도 PR 불요 확인).
- 게이트: 단계 1 판정 통과 + PR-B 08:50 술어 가동 확인. 전환은 비장중.
- 테스트: `test_storage_runtime.py`·`test_coverage_plan.py` 타깃 재편,
  promote가 kiwoom_live로 관심종목 승격하는 E2E 픽스처.

## 단계 4 — 안정화 도그푸딩

- 운영자 판정(참고 지표). 문제 발생 시 fix-forward.

## 단계 5 — 거래원 0F·프로그램 0w 공급자 교체 (PR-F, 조건부 — T2 스모크 통과 시)

- `kiwoom_frames`에 0F/0w 파서(스모크 채록 기반, `kiwoom_fields` FID 상수 확정) —
  0F → BROKER 합성 틱과 동일 payload 형태(파서 출력이 `_parse_member` shape-compat),
  0w → `program_trade_store` 공급 어댑터.
- 저장셋 구독에 타입 추가(슬롯 불변 — 종목 단위), BrokerRestPoller·프로그램 REST
  폴러 정지·삭제. KIS REST 유량 여유분은 캔들·지수로 자연 환원.
- 단계 6과 독립 — 스모크 일정에 따라 순서 교환 가능.
- 스모크 반전 시: 이 PR 스킵, KIS REST 공급 영구(착지는 이미 kiwoom_live — 재개봉 불요).

## 단계 6 — 최종 삭제 (PR-G, 필요시 분할 G1/G2)

전수조사 문서의 3분류를 그대로 집행 + #684 증보(rest_poller):

- **G1 (KIS WS 계층)**: `ws_client.py`·`ws_fields.py`·`live_session.py` 삭제,
  `ws_frames.py` 파서 제거(또는 모듈 삭제 — WsTick은 PR-A에서 기이주),
  `lifecycle` 대수술(_build_conn·watchdog·사다리·_State.session 해체·`get_status`
  재소싱 — kiwoom status 기반), `kis_client.get_approval_key`, `coverage`의 KIS 상수·
  `plan_live_coverage` 계열, `account_health` WS probe 항, 스크립트 2종·
  `tests/fixtures/kis_ws/`, `startup_runtime`의 watchdog 배선.
- **G2 (rest_poller)**: `rest_poller.py`·lifecycle 배선(`_ensure_poller`·
  `_sync_exclusion`·rest_poller 위임)·`LiveStatus.rest_poller_*` 5필드·
  `kis_rest_bypass`의 rest_poller 분기.
- 테스트: 삭제 ~76개(ws_client 25·ws_frames 14·recorded 4·partition 7·
  live_session_characterization 10·rest_poller·lifecycle_rest_poller 16) + 대수정
  (test_lifecycle 45·dynamic_n 10·start 6·coverage_plan 12·account_health 9·
  storage_runtime) + 소수정(kiwoom_frames 패리티 기대값 하드코딩·rest_buffer_build/
  broker_rest_poller 픽스처를 WsTick 직접 생성으로·adr_invariants 목록).
- 문서: CONTEXT.md 'Live Capture'/'Live Tick' 정의를 키움 전담으로 개정,
  `LiveStatus` wire 필드 재소싱(`ws_connected`·`live_set`·`degraded_accounts`·
  `capture_*` → kiwoom 유도, additive 과도기 허용).
- 게이트: 단계 4 판정 통과. 이후 되돌림 = git revert뿐(장치 없음 — 의도).

## 프론트 PR (단계 2~3과 병행 가능)

- **F1. UN 상시 병합 표시**: 체결 KRX∪NXT 시각순 병합(시간외단일가 제외 필터 —
  `liveVenueAllowsKrxTradeOverlay` 후계) · 호가 가격대 합산 병합 뷰 + "합성" 배지 ·
  렌더 스로틀(0D ×2 빈도 코얼레싱). 3옵션 직결(시분할 UI 개념 제거).
- **F2. 상태 표면**: 만석 알림 토스트/배지 · 전면 장애/계정락/토큰 실패 배너 ·
  커버리지 칩 kiwoom 표면 일원화 · 진단 패널 카운터(킥·재연결·미확인 구독).
- 컴포넌트 단위 상세 목록은 맵의 잔여 안개("프론트 표면 변경 범위") — 실행 세션이
  F1/F2 착수 시 구체화한다.

## 잔여 관찰 항목 (실행 중 확인)

- 틱 볼륨·버퍼: 구독 1,000종목± 규모에서 `buffer.py` 사이징 불변식(보존 > 2×promote
  300s) 실측 — 문제 시 별도 노력으로 재개봉(맵 안개 항목 승계).
- REG 유량: 온디맨드 churn + 스왑이 연결당 ~5/s 안에서 동작하는지 진단 카운터로 관찰.
