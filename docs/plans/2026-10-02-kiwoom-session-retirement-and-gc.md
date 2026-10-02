# 키움 정규장 연결 복구·GC 개선 계획

작성: 2026-10-02, 관측 범위: 09:28–09:39 KST 및 동일 프로세스의 전날 야간 GC 기록.
범위: 원인 조사와 구현·검증 계획. 이번 조사에서는 운영 코드 변경, 배포, 재기동을 하지 않았다.

## 판단

**구독 응답 시간 초과 이후 복구가 수 분 지연되는 코드 결함을 재현했다. 최초 응답 시간 초과의 원인과 반복되는 1006 종료의 원인은 미확정이다. 긴 GC도 별도 미해결 문제다.** PR #1915가 모든 문제를 해결했다고 판단할 근거는 없다.

포트 8000 API 프로세스는 PID `1556062`, 커밋 `beef04d6e67f91f91120f0848be4b1aac76f2f88`, Live 시작 `1790850474483`이다. PID `3364457`은 reload supervisor다. 이전 PR·프로세스의 누적 수치를 합치지 않았다. 다음 수치는 각각 순간 표본이며, 연결 숫자가 증가한 것만으로 안정적 복구를 인정하지 않는다.

| KST | 연결 / 설정 계정 | 등록 완료 계정 | 준비 종목 / Live Set | 수집 상태 |
|---|---:|---:|---:|---|
| 09:29:31 | 1/6 | 1/6 | 38/320 | registration_incomplete |
| 09:30:58 | 1/6 | 1/6 | 38/320 | registration_incomplete |
| 09:31:59 | 3/6 | 2/6 | 137/320 | registration_incomplete |
| 09:39:41 | 5/6 | 3/6 | 237/320 | registration_incomplete |

마지막 표본의 계정별 연결 세대는 `[9, 8, 7, 7, 7, 6]`이다. REG 시간 초과·1006 종료·일부 opening handshake 시간 초과가 반복된다. 모든 계정의 큐 초과와 폐기 누적은 0이다. 큐 무손실과 HTTP health=ok는 구독·수집 정상의 충분조건이 아니다. 종목 320개와 venue를 포함한 계정별 `sub_expected/sub_acked`는 다른 단위다.

증거: [관측 표본](../diagnostics/2026-10-02-kiwoom-session-recovery/observations.json), [이벤트](../diagnostics/2026-10-02-kiwoom-session-recovery/events.log), [재현 방법과 한계](../diagnostics/2026-10-02-kiwoom-session-recovery/README.md).

## 확인된 복구 결함

1. 09:28:35 계정 0·1·3·4, 09:29:05 계정 2에서 Live Set 변경의 REMOVE ACK 대기가 약 10초 뒤 실패했다. `_apply_subscriptions → update_codes → _reg_batch(REMOVE) → _send_and_wait` 경로다.
2. `hoga/live/kiwoom_ws_client.py:723`은 `_ws=None`, `connected=False`, `_retiring_failure=exc`로 표시하고 `_safe_close()`를 호출한다. 실행 중인 세션을 종료시키는 신호는 없다.
3. `_session_once()`는 line 380에서 여전히 `recv_task`를 기다린다. `_retiring_failure`는 수신 태스크가 나중에 실패할 때 원인을 바꾸는 용도다. 그 자체로 reader/consumer를 종료하지 않는다.
4. 실제 `websockets.connect()`의 `close_timeout`과 앱 `_safe_close()`의 바깥 timeout이 모두 2초다. 바깥 타이머가 먼저 시작하여 라이브러리의 자체 타임아웃 정리 전에 `close()`를 취소할 수 있다. `_safe_close()`는 이를 숨기고 반환한다.
5. 실행 중인 `run()`이 끝나지 않아 재연결로 넘어가지 않는다. manager의 `_conn_dead()`도 태스크 종료 또는 kick만 확인한다. `_ws=None`이므로 PING echo와 재구독도 진행할 수 없다.

09:29:31→09:30:58 동안 미연결로 표시된 계정 0–4의 dispatch 완료 카운터는 각각 `+334/+356/+263/+348/+334` 증가했다. 표시만 꺼지고 이전 수신 처리가 남는 상태와 일치한다. 계정 2의 최초 실패→재연결 루프 진입은 약 144초, 계정 3은 약 199초 지연됐다. 이는 소켓 자체 상태를 직접 측정한 결과는 아니므로 TCP 종료 시점을 단정하지 않는다.

오프라인 재현은 Python 3.14.7/websockets 16.0에서 3회 동일하게 성공했다. 실제 앱 client와 가짜 peer를 사용하면 `connected=false`지만 `run()`이 계속 살아 있고 실패 후 REAL 3건을 처리한다. 실제 설치된 라이브러리 `Connection`과 가짜 transport를 사용하면 같은 종료 제한에서 앱 경로는 `abort=0/CLOSING`, 라이브러리 자체 종료 경로는 `abort=1/CLOSED`다. 네트워크·공급사에 연결한 실험은 아니다.

라이브러리 문서상 `close_timeout`은 연결 종료 제한이다. 구현을 설치 소스와 함께 확인했으며, 앱의 외부 취소가 같은 보장을 제공한다고 가정해서는 안 된다. [websockets 16.0 문서](https://websockets.readthedocs.io/en/16.0/reference/asyncio/client.html).

## 아직 확정할 수 없는 원인

- 최초 REMOVE ACK가 공급사에서 미송신됐는지, 요청 형식·구독 상태 문제인지, 수신·제어 라우팅 문제인지 현재 로그만으로 구분할 수 없다. `_reg_batch()`의 REMOVE 형식과 공식 응답 계약을 대조해야 한다.
- 후속 REG 실패·1006·handshake 시간 초과는 서로 다른 실패 단계다. 1006만으로 공급사 거부, 인터넷 속도, 동일 앱키 충돌을 판정할 수 없다. `kicked_by_peer=false`이며 조사 표본에 105110/105115/105118 거부 근거는 없다.
- 동시간대 REST 지연은 보이지만 이것이 REMOVE ACK 실패를 발생시켰다는 인과 증거는 없다. 알려진 09:11 GC와 09:28 실패도 같은 사건으로 묶지 않는다.

## GC 판단

같은 API PID·커밋에서 운영 중 기록된 gen2 정지는 다음과 같다. 10월 1일 21시 관측 종료 뒤 발생했으므로 당시 보고와 구분한다.

| KST | 세대 | 정지 ms | 회수 객체 수 |
|---|---:|---:|---:|
| 10-01 22:09:19 | 2 | 5515.6 | 1625 |
| 10-01 22:16:36 | 2 | 6390.4 | 912 |
| 10-01 22:25:56 | 2 | 7193.1 | 2023 |
| 10-02 00:48:27 | 2 | 1686.0 | 33709 |
| 10-02 09:11:52 | 1 | 1029.9 | 23560 |

정규장에 7.19초 정지를 관측했다는 뜻은 아니다. 정규장에서 확인한 위 1초 이상 정지는 gen1이다. `gc.by_generation`의 운영 gen2는 4회이며 interpreter gen2=5에는 프로브 설치 전 시작 과정도 포함된다. 이번 조사에서 강제 GC는 실행하지 않았다.

긴 정지와 적은 회수 객체 수는 큰 상주 객체 그래프 순회를 의심하게 하지만, `collected`는 전체 순회 객체 수가 아니다. 어느 저장소가 원인인지, 메모리 누수인지, CPU 경합 영향이 얼마나 큰지는 확정되지 않았다. Packed orderbook의 합성 벤치마크 개선을 전체 운영 프로세스의 GC 개선으로 확대 해석하지 않는다. [Python GC 통계 의미](https://docs.python.org/3.14/library/gc.html).

## 개선 순서와 구현 범위

### 1. P0: 세션 종료·복구를 하나의 소유자가 책임지게 한다

대상: `hoga/live/kiwoom_ws_client.py`, 필요 시 `hoga/live/kiwoom_session.py`, `hoga/live/provider_errors.py`.

- 세션별 generation과 idempotent 종료 신호를 둔다. 외부 `update_codes()`에서 시간 초과가 나도 세션 소유자가 즉시 종료 절차에 진입한다. 연결 상태를 지우는 것만으로 종료를 대신하지 않는다.
- 소유자가 reader/consumer 종료·join, ACK waiter 해제, 큐 정리, 소켓 종료를 완료한 뒤 기존 backoff를 거쳐 새 세션을 만든다. 종료되지 않은 이전 소켓과 동일 앱키 새 소켓을 겹쳐 만들지 않는다.
- 종료 제한을 앱과 라이브러리에 같은 값으로 중복 적용하지 않는다. 라이브러리 자체 제한이 실행될 여유를 주고, 앱의 최종 제한을 넘으면 transport abort까지 보장하는 명시적 adapter 계약을 마련한다. 실제 설치 버전에서 보장되는 경로를 테스트한다. 가짜 소켓의 `close()` 반환만 확인해서는 부족하다.
- `_sub_lock`을 가진 호출자가 종료를 요청해도 소유자의 정리가 같은 lock을 기다리는 교착을 만들지 않는다. 종료 완료 대기가 필요하면 lock 바깥에서 수행한다.
- 이전 generation의 늦은 ACK·수신·finally가 새 세션의 waiter·상태를 바꾸지 못하게 한다. retiring 이후 새 REAL 전달을 차단하고 중단·폐기 수치를 명시적으로 집계한다. 큐에서 꺼낸 처리 중 프레임도 집계 범위에 포함한다.
- 최초 실패 시각·phase·계정·generation을 바로 기록한다. 수 분 뒤 수신 종료 시점까지 실패 관측을 미루지 않으며, 늦은 정리가 새 관측을 덮어쓰지 못하게 한다.
- manager의 watchdog은 보조 수단이다. `connected=false`만 보고 별도 소켓을 만들지 않고 세션 소유자의 retiring/closed 상태와 종료 진행을 확인한다.

이 변경은 ADR-0116의 연결 세대별 ACK 격리·단일 소유 원칙을 강화한다. ACK 제한 증가나 큐 확장으로 복구 결함을 가리지 않는다.

### 2. P1: REMOVE/REG의 최초 실패를 구분할 관측을 추가한다

- 공식 REMOVE 요청/응답 계약과 `grp_no`, `refresh`, `item`, `type` 사용을 대조한다. 확인 결과에 따라 요청 수정 여부를 결정한다. 응답이 없는 요청을 무조건 반복하지 않는다.
- 연결 세대별 제어 요청의 송신/ACK 시각, trnm, 단계, 항목 수, return_code, 정상 매칭·고아 ACK·늦은 ACK 카운터를 제한된 크기로 보존한다. 토큰, 계좌 정보, 원문 payload, 자유 형식 return_msg는 저장하지 않는다.
- desired/applied/confirmed 구독 상태를 구분한다. 실패한 diff 이후 다음 세션이 최신 desired를 재등록하고, 실제 확인된 범위만 ready로 표시하게 한다.
- REG/REMOVE timeout, transport 1006, handshake timeout, 앱 종료 요청을 개별 원인으로 출력한다. 소켓 lifecycle·수신 카운터·loop/GC 정지와 시간창을 맞추어 평가한다.

P0와 P1을 첫 PR로 묶되, 최초 실패 원인까지 해결했다고 설명하지 않는다. 빠른 안전 복구와 다음 실패의 진단 가능성을 완료 범위로 한다.

### 3. P2: GC 발생원에 맞춰 저장·할당 구조를 줄인다

- `hoga/api/gc_probe.py`에 저비용 wall/process CPU 측정과 필요한 출처 구분을 설계한다. GC callback에서 객체 순회·대형 snapshot·I/O를 하지 않는다. 프로세스 CPU를 계정별 CPU로 표현하지 않는다.
- `hoga/live/buffer.py`, `hoga/live/second_trade_store.py` 및 연관 초봉·쿼리 캐시의 소유 객체 수, cell/bar 수, 보유 종목·날짜 수, 큐 bytes, subscriber 수, 활성 요청·작업 수를 기존 카운터 기반으로 수집한다. RSS와 함께 GC 전후 시간창을 맞춘다.
- 별도 실험 프로세스에서 실제와 같은 종목 수·거래량·이력 길이에 REST/화면 조회를 더하고, 비거래 시간·날짜 변경도 재현한다. 할당 프로파일과 보유 경로를 확인해 우선순위를 정한다. 운영 전체 힙 스캔은 하지 않는다.
- 원인에 따라 dict/tuple/sidecar의 수명·캐시 상한·날짜 전환 정리·반복 materialization을 개선한다. trade/초봉/quote 등 orderbook 외 객체도 포함한다. 유효 데이터와 쓰기 완료 전 레코드를 삭제해 성능만 높이지 않는다.
- GC threshold 확대·disable/freeze·큐 증설을 선행 처방으로 쓰지 않는다. 프로파일 근거와 자연 GC 결과를 가진 별도 PR로 낸다.

### 4. 조건부 P3: 수집 프로세스 분리

보유 구조 최적화 후에도 자연 GC가 API/제어 처리를 1초 이상 막으면, vendor 연결과 Live Capture를 전용 프로세스가 단독 소유하는 설계를 검토한다. bounded IPC, 순서·유실 집계, generation, 종료·재시작 복구, 수집 건강 표시를 포함하는 새 ADR이 필요하다. Python thread 이동만으로 같은 인터프리터의 GC를 격리할 수 없으며, uvicorn worker 증가는 동일 앱키의 중복 연결 위험을 만든다. 이 단계는 지금 즉시 적용할 변경이 아니다.

## 검증과 완료 기준

첫 PR은 `tests/unit/live/test_kiwoom_ws_client.py`, `test_kiwoom_control_isolation.py`, `test_kiwoom_session.py`를 확장한다.

1. 실행 중인 `run()`에 외부 REMOVE timeout과 응답 없는 close를 주입한다. 소유자의 종료 신호가 도착하고 이전 reader/consumer가 join되며, 소켓 종료/abort 완료 후 정확히 한 새 연결이 시작해야 한다. 테스트는 event·scheduler turn을 중심으로 작성한다.
2. 실제 websockets와 loopback peer로 close 미응답을 재현한다. 라이브러리 내부 transport 종료를 확인하고 동률 timeout 회귀를 잡는다. 공급사 연결은 사용하지 않는다.
3. 늦은 ACK, 늦은 이전 reader 실패, 정상 종료, shutdown 중 timeout, 초기 LOGIN/REG 실패를 검증한다. `_sub_lock` 교착·waiter 잔류·미회수 태스크가 없어야 한다.
4. 여러 계정 중 하나의 실패가 나머지 계정의 등록·수신을 중단시키지 않아야 한다. retiring 입력의 완료/폐기 집계를 확인하고, 종료된 generation이 새 generation 데이터를 전달하거나 지우지 못하게 한다.
5. 로컬 필수 lint·backend 테스트를 통과시킨다. 기존 테스트가 close coroutine 취소만 검증하던 부분을 실제 세션 종료 결과까지 검증하도록 보강한다.

운영 검증은 구현·리뷰·병합·적용 뒤 별도 수행한다. 같은 commit·PID·Live 시작 시각으로 구간을 나누고, 정규장 실제 수신을 최소 60분 및 보유 이력 상한 도달 후 관측한다. 절전·재기동 구간은 연속 운영으로 합치지 않는다.

- 연결 6/6뿐 아니라 계정별 expected=acked, 전체 ready, capture_healthy와 수신 진행을 함께 확인한다. 구독 변경 뒤 실패 세션이 복구 예산 내 종료됐는지 로그로 확인한다. 종료 예산은 구현에서 하나로 정의하고, 공급사 connect/LOGIN/REG 대기·backoff와 구분해 측정한다.
- 정상 구간의 큐 초과·폐기 증가가 없어야 한다. 불가피한 세션 폐기는 원인·세대별 집계해 무손실과 구분한다. rolling 최대를 전 구간 최대로 쓰지 않는다.
- 1초 이상 GC/loop 정지를 회귀 실패 기준으로 두고 자연 운영 gen2까지 확인한다. gen2가 없으면 GC 개선 검증은 미완료로 남긴다. 장중 최고 부하를 관측하지 못했으면 그 한계를 기록한다.
- 최초 ACK 실패가 지속되면 P1 자료로 공급사 응답·요청 계약·앱 라우팅을 구분한다. 빠른 재연결만으로 최초 원인 해결을 선언하지 않는다.

배포 후 악화되면 리뷰된 이전 버전으로 되돌리는 절차와 로그를 준비한다. 종료되지 않은 세션 위에 추가 연결을 만드는 임시 조치는 하지 않는다. 새 프로세스의 카운터 0을 개선 증거로 삼지 않는다.

## 이번 조사에서 완료한 일

운영 상태·기존 로그 읽기, 코드·기존 테스트 대조, 네트워크 없는 재현 3회, 증거 저장, 개선 계획 작성. 제품 코드는 수정하지 않았다. 기존 자동 관측 `gc`는 PAUSED 상태를 유지하며, 다음 날 관측이나 다른 커밋 관측을 자동 예약하지 않았다.
