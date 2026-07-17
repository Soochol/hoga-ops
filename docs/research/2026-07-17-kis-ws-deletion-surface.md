# KIS WS 삭제 표면 전수조사 (2026-07-17)

웨이파인더 맵 [#679](https://github.com/Soochol/hoga-ops/issues/679) · 티켓
[#682](https://github.com/Soochol/hoga-ops/issues/682)의 산출물. KIS WebSocket
계층 완전 삭제(브로커 완전 특화: 실시간 WS=키움 전담)의 터치 포인트를
**삭제 / 보존 / 수정** 3분류로 전수 나열한다. 조사 기준 커밋: `00edad23`.

전제(맵 Notes): KIS REST 전 계층은 존치. `stream.on_tick` 포트와 `WsTick` 계약은
키움 + ADR-0111 합성 틱 주입이 의존하므로 보존.

---

## 0. 요약 — 플랜 작성자가 먼저 알아야 할 함정 4건

1. **`WsTick`이 삭제 대상 파일 안에 산다.** `ws_frames.py`는 "KIS 프레임 파서 +
   `WsTick` dataclass"의 동거 모듈이다. 파서(`parse_message` 이하)는 삭제,
   `WsTick`은 공유 포트 계약이라 보존 — 임포트 지점이 프로덕션 7곳·테스트 6곳이라
   **이주(신규 모듈) 또는 모듈 존치(파서만 제거)** 결정이 필요하다(§4.1).
2. **`session_gate`의 `ws_*` 함수들은 이름만 KIS WS다.** `ws_connection_window`는
   키움 세션 게이트(`storage_runtime.py:73`)가, `target_ws_venue`는 KIS REST 표시
   폴러(`rest_poller.py:98`)와 거래원 폴러(`broker_rest_poller.py:145`)가 소비한다.
   삭제 금지 — 의미가 "KIS WS 구독 venue"에서 "REST 폴링 venue 스케줄 + 키움 연결
   게이트"로 이전된다(개명은 선택, §4.2).
3. **거래원 합성 틱의 주입처가 소멸한다.** `lifecycle._dispatch_broker_tick`은
   BrokerRestPoller(존치)의 합성 BROKER 틱을 `_state.session.streams`(KIS conn)의
   `stream.on_tick`에 브로드캐스트한다. KIS conn이 사라지면 거래원 데이터의 저장
   경로가 끊긴다 — 관심종목 키움 이관(#683) 시 키움 스트림으로 재배선하는 설계
   결정이 선행돼야 삭제 PR이 성립한다(§4.3).
4. **`test_kiwoom_frames.py`가 KIS 파서와 패리티 대조한다.** 키움 파서의 정답
   기준이 `ws_frames.parse_message` 출력이다(138·151행). 파서 삭제 시 기대값을
   하드코딩으로 독립화해야 한다(§5).

---

## 1. 삭제 — 파일 통째

| 파일 | 규모 | 내용 |
|---|---|---|
| `hoga/live/ws_client.py` | 328줄 | `KisWsClient`(연결·구독·PINGPONG·백오프·ACK 추적·`ensure_venue` 스왑·`resubscribe_missing` 표적 재구독), `DuplicateAppKeyInUse`, `build_request`, `WS_URL_REAL`, `_SUB_ACK_GRACE_MS` |
| `hoga/live/ws_fields.py` | 73줄 | TR 상수(`H0STASP0`/`H0STCNT0`/`H0STMBC0`/`H0NXASP0`/`H0NXCNT0`), `TRS`/`TRS_KRX`/`TRS_NXT`, `tr_venue`, `trs_for_venue`, `ASP_*`/`CNT_*`/`MBC_*` 필드 인덱스 |
| `hoga/live/live_session.py` | 318줄 | `LiveSession`(KIS WS 연결집합 dynamic-N 상태기계: start/refresh/restart/stop), `_StreamConn`, `_capture_health`(WS 헬스 술어), `degraded_set`/`status_fields` — **단, status 표면(capture_healthy/reason 등)의 후계는 #684 관할**(§4.4) |
| `scripts/smoke_2account_ws.py` | — | 2계정 WS 스모크 |
| `scripts/record_kis_ws_frames.py` | — | WS 프레임 녹화(픽스처 생성기) |
| `tests/fixtures/kis_ws/` | 5파일 | `h0stasp0.txt`·`h0stcnt0.txt`·`h0stmbc0.txt`·`control.txt`·`README.md` — `test_ws_frames_recorded.py` 전용 |

## 2. 삭제 — 파일 내 심볼

| 파일 | 삭제 심볼 | 비고 |
|---|---|---|
| `hoga/live/ws_frames.py` | `parse_message`, `_dispatch`, `_parse_orderbook`, `_parse_trades`, `_parse_member`, `_SIDE_MAP`, `_hhmmss_to_unix_ms`, `ws_fields` 임포트 | `WsTick`은 보존·이주(§4.1) |
| `hoga/live/coverage.py` | `KIS_WS_MAX_REGISTRATIONS`(39), `TRS_PER_CODE`, `_PER_ACCOUNT_MAX`(19), `LIVE_SET_MAX_CODES`, `partition_live_set`, `plan_live_coverage`, `LiveCoveragePlan`, `select_live_set`, `_compute_ws_targets`, `_compute_live_set`, `live_set_codes`, `ws_fields.TRS` 임포트 | `KIWOOM_*`·`partition_kiwoom`·`plan_storage_targets`(수정)·`_compute_capture_candidates`·`_compute_heatmap_codes`는 보존 |
| `hoga/live/lifecycle.py` | `_build_conn`, `_teardown_conn`, `_restart_conn`, `_ws_watchdog_check`, `_plan_sub_failed_action`, `_run_resubscribes`, `start_live_stream_watchdog`, `_ensure_conn_venues`, `_ws_degraded_probe`(+ 모듈 로드 시 `account_health.register_ws_probe` 등록), `_WATCHDOG_*`·`_SUB_FAILED_*`·`_RESUB_*` 상수·카운터, `live_session` 재수출(`KIS_WS_MAX_REGISTRATIONS` 등 F401 블록) | watchdog 태스크는 `hoga/api/startup_runtime.py:125`(+`app.py:143` DI)가 스폰 — 배선점도 함께 제거. `start_today_promoter`·`promote` 루프는 보존 |
| `hoga/live/kis_client.py` | `get_approval_key`(POST `/oauth2/Approval`) | 나머지 REST 전부 보존. `KisAuthError`는 `kis_errors.py` 소유라 무관 |
| `hoga/live/stream.py` | `from .ws_client import KisWsClient` 임포트, `self.ws: KisWsClient | None` 타입(속성 자체는 §4.5 참조) | `LiveStream` 본체·`on_tick`·flush 루프는 보존 |
| `hoga/live/account_health.py` | `register_ws_probe`/`_ws_probe`/`_ws_degraded` 및 `degraded_account_ids`·`is_degraded`의 WS 항 | REST auth latch(`mark_rest_auth_degraded`)는 보존. 키움 장애 신호로의 대체 여부는 #684 |

## 3. 보존 — 명시 확인 목록

- **`WsTick` dataclass + `stream.on_tick` 포트** — 키움(`kiwoom_frames`/`kiwoom_ws_client`/
  `kiwoom_ondemand`)과 ADR-0111 합성 틱(`broker_rest_poller`), `downsampler`가 의존.
- **KIS REST 전 계층**: `kis_client.py`(get_approval_key 외 전부), `kis_runtime.py`,
  `kis_access.py`, `kis_account_pool.py`, `kis_capacity_runtime/scheduler.py`,
  `kis_endpoints.py`, `kis_errors.py`, `kis_models.py`, `kis_token_provider.py`,
  `error_policy.py`, `live/api.py`, `live_rest_capture_access.py`.
- **`kis_venue.py`** — REST 캔들/시세 venue 라우팅(`J`/`NX`/`UN` div). WS와 무관.
- **REST 폴러들**: `rest_poller.py`(2s 표시 — 온디맨드 강등 경로로 #685에서 지위 상승),
  `broker_rest_poller.py`(거래원), `program_trade_collector.py`(프로그램).
- **`session_gate.py` 전 함수** — `market_phase`, `is_trading_day_now`, `should_run_now`,
  `ws_capture_window(_async)`, `ws_connection_window(_async)`, `target_ws_venue`(§4.2).
- **저장 파이프라인**: `downsampler.py`, `buffer.py`, `writer.py`, `snapshot.py`,
  `promote.py`(kis_live promote는 과거일 서빙에 계속 필요), `ask_peak_state.py`.
- **KIS 계정 env** (`KIS_APP_KEY[_k]`/`KIS_APP_SECRET[_k]`) — REST capacity 풀이 계속
  사용. WS 삭제로 지워지는 env 없음.
- **`hoga/api/ws.py`** — 프론트 푸시용 WebSocket(EventBus). 이름만 겹침, KIS WS 아님.

## 4. 수정 — 심볼·설계 결정 수반

### 4.1 `WsTick` 이주 (임포트 13곳)

프로덕션: `kiwoom_frames.py`, `kiwoom_ws_client.py`, `kiwoom_ondemand.py`,
`broker_rest_poller.py`, `downsampler.py`, `stream.py`, `lifecycle.py`(TYPE_CHECKING).
테스트: `test_downsampler.py`, `test_stream.py`, `test_kiwoom_ondemand.py`,
`test_broker_rest_poller.py`, `test_kiwoom_frames.py`, (`test_rest_buffer_build.py`).

선택지: **(A)** 신규 `hoga/live/ticks.py`(또는 `tick.py`)로 이동 + 임포트 13곳 일괄
치환 — 이름이 정직해짐, 권장. **(B)** `ws_frames.py`를 존치하고 파서만 제거 —
diff 최소지만 "kis ws" 어감의 모듈이 키움 세계에 남는다. `SnapshotKind`는 이미
`snapshot.py`에 분리돼 있어 무관.

### 4.2 `session_gate.py` — 삭제 불가, 의미 이전

- `ws_connection_window`: 키움 세션 게이트(`storage_runtime.py:73` `gate_fn`)가 소비.
- `target_ws_venue`(08:50/15:31 KRX·NXT 시분할): `rest_poller._venue_fn` 기본값,
  `broker_rest_poller` KRX-창 게이트가 소비. KIS WS 스왑(`_ensure_conn_venues`)이
  사라져도 REST 쪽 스케줄 SSOT로 잔존.
- `ws_capture_window`: `stream.run_flush_loop` 저장 게이트 — 키움 스트림도 동일 사용.
- 조치: 함수 보존 + KIS WS 언급 docstring 정리. `ws_` 접두 개명은 선택(치환 표면:
  lifecycle·stream·rest_poller·broker_rest_poller·program_trade_collector·
  storage_runtime·test_session_gate 26행·test_lifecycle 26행).

### 4.3 `lifecycle.py` — 대수술 (삭제 §2 + 아래 수정)

- `_State`/`LiveSession` 의존 해체: `streams`·`live_set`·`watchlist_codes` 표면의
  후계(키움 세션이 관심종목을 흡수 — #683·#685 결정 의존).
- `_dispatch_broker_tick`: 새 싱크 필요(함정 3). 거래원·프로그램 데이터는 KIS REST
  유지가 절단선이므로 이 폴러들은 살아남는데, 주입 대상 스트림이 키움 소유로 바뀐다.
- `_sync_exclusion`: `rest_poller.set_excluded_codes(live_set)`의 배제 집합이
  "KIS WS 수집 종목" → "키움 저장 코드셋"으로 재정의(#685 온디맨드 강등 경로와 정합).
- `get_status`: `session.status_fields` 소멸 → `LiveStatus` 필드 재소싱.
  `ws_connected`·`live_set`·`degraded_accounts`·`capture_healthy/reason/missing_codes`를
  키움 상태(`kiwoom_session.status()`)에서 유도할지, wire 필드를 개편할지 — #684
  (장애·관측성)와 프론트 표면 fog의 결정 사항. `transport: "ws"` 기본값은 유지 가능.
- `start/refresh/stop/_start_live_stream_locked`: conn 빌드 경로 제거 후 폴러+키움
  sync 오케스트레이션만 남김. `reset_for_tests`의 WS 카운터 정리도 삭제.

### 4.4 status·헬스 표면 (#684 인터페이스)

`_capture_health`(recv 신선도 + sub ACK 결합 술어)와 watchdog 사다리(표적 재구독
3회 → 제한 재시작 2회 → 로그)는 KIS WS 전용 로직으로 삭제되지만, **동등물이 키움
쪽에 없으면 관측성이 후퇴**한다. 키움 클라이언트의 킥 카운터·틱0 워치독·재연결
정책이 그 후계 — #684가 잠근다. 삭제 PR은 #684 결정 없이 착수 불가.

### 4.5 `stream.py`

`self.ws` 속성은 KIS conn에서만 채워졌고 키움은 `.ws=None`으로 둔다
(`kiwoom_session` docstring). `status_fields`/`_capture_health`가 사라지면 `.ws`를
읽는 곳이 없어져 속성 자체 제거 가능 — 단 `lifecycle.get_today_ask_peak` 등은
`stream_obj` 경유라 무관. `on_tick`의 KRX 성역 가드(`tick.venue != "KRX"` 리턴)는
키움 venue 태깅 규칙(#681)이 정해져야 재검토된다.

### 4.6 `coverage.py` / `storage_runtime.py`

`plan_storage_targets`: `ws_targets`(KIS 19×N 절단) 항이 관심종목 키움 배분으로
대체(#680 5키 풀형·#683 시맨틱 의존). `storage_runtime.sync_storage_runtime`의
`snapshot.ws_targets` 소비(2곳)와 `lifecycle._sync_storage_targets`의 시그널 모니터
타깃 합성도 같은 PR에서 이동.

### 4.7 문서

- `CONTEXT.md`: **Live Capture**·**Live Tick** 정의가 "KIS WebSocket push" 명시(437·
  445행 부근) — 키움 전담으로 개정. ADR-0111 provenance 노트는 역사 기록이라 유지.
- ADR: 0101(WS 39)·0102(500종목)·0096/#524(venue 시분할)·0111(거래원 REST 대체) 등은
  개정하지 않고 successor ADR(이 맵의 종착 산출물)이 supersede를 선언.
- `docs/agents/`·`.env.example`: KIS WS 관련 서술 없음(확인) — 수정 불요.

## 5. 테스트 영향

### 삭제 (약 60 테스트 + 픽스처 1묶음)

| 파일 | 테스트 수 | 비고 |
|---|---|---|
| `test_ws_client.py` | 25 | 전부 KisWsClient 대상 |
| `test_ws_frames.py` | 14 | KIS 파서 합성 픽스처 |
| `test_ws_frames_recorded.py` | 4 | `tests/fixtures/kis_ws/` 5파일 동반 삭제 |
| `test_partition.py` | 7 | KIS 19-파티션·`ws_client._TRS` 직접 참조 |
| `test_live_session_characterization.py` | 10 | LiveSession 상태기계 특성화 |

### 대수정 (WS 결합 해체 후 재작성 수준)

| 파일 | 테스트 수 | WS 결합도 |
|---|---|---|
| `test_lifecycle.py` | 45 | 관련 라인 232 — watchdog·venue 스왑·sub_failed 사다리·FakeWs 다수 |
| `test_lifecycle_dynamic_n.py` | 10 | conn dynamic-N |
| `test_lifecycle_start.py` | 6 | `_build_conn` 경로 |
| `test_coverage_plan.py` | 12 | `plan_live_coverage`/KIS 상수 — 키움 배분 테스트로 대체 |
| `test_account_health.py` | 9 | ws probe 항 제거 |
| `test_storage_runtime.py` | — | `ws_targets` 소비 1곳 |

### 소수정 (픽스처 소스 교체·목록 갱신)

- `test_kiwoom_frames.py`: KIS 파서 패리티 대조 2곳(138·151행) → 기대값 하드코딩.
- `test_rest_buffer_build.py`(32)·`test_broker_rest_poller.py`: `parse_message`로
  WsTick 픽스처를 만드는 4곳 → `WsTick` 직접 생성으로 교체.
- `test_adr_invariants.py`: `_HOT_PATH_MODULES`에서 `ws_client.py`·`ws_frames.py`
  제거(이주 시 신규 tick 모듈 등재).
- `test_stream.py`(28): FakeWs·venue 참조 소수 — 본체는 보존.
- `test_session_gate.py`(8): 게이트 함수 보존이므로 무변경(개명 시에만 치환).
- `test_lifecycle_rest_poller.py`(16): rest_poller 존치라 대부분 보존, `_state.session`
  접점만 수정.

### 무관 확인

`test_seam_contract.py`(버퍼 보존 불변식), `test_downsampler.py`(WsTick 임포트 경로만),
`test_kis_client.py`(get_approval_key 테스트 1~2건 삭제 외 보존), kiwoom 테스트 6종.

## 6. 삭제 PR의 선행 의존 (이 조사에서 확정된 순서 제약)

1. **#681/#683/#685** — 관심종목 키움 이관이 먼저 안착해야 `_build_conn`·`ws_targets`
   경로를 비울 수 있다(그 전 삭제는 관심종목 실시간 캡처 정지).
2. **#683(또는 후속)** — 거래원 합성 틱 재배선(§4.3) 결정.
3. **#684** — status·헬스 표면 후계(§4.4) 결정.
4. 프론트 표면(fog) — `LiveStatus` wire 필드 재정의는 백엔드 삭제 PR과 원자적일
   필요는 없음(additive/유지 필드로 과도기 가능).
