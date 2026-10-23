# ADR-0174: Python Live Capture를 API와 별도 프로세스로 분리한다

**Status:** Accepted
**Date:** 2026-10-03

사용자가 P0–P2 구현 뒤 P3도 지금 구현하도록 요청했다. API의 표시 이력·조회 객체에
의한 GC와 이벤트 루프 정지가 기존 키움 WS 수신·저장까지 함께 막는 경계를 분리한다.
API는 Uvicorn worker 하나를 유지하고 전용 `spawn` 수집 프로세스 하나가 모든 키움
계정 세션, 파싱·집계·LiveWriter, 초봉 journal, 프로그램매매 latch/store, VI journal,
시그널 감지·기록, 마지막 호가 저장을 소유한다. 과거 파일 형식·venue 격리·등록 ACK·
세션 retirement 계약을 유지한다. API GC가 수집 자식의 인터프리터를 멈추지는 않지만,
자식 자신의 GC·CPU/디스크 경합은 남고 화면 갱신은 API 정지의 영향을 받는다.

토큰 발급·무효화와 REST capacity는 기존 API 소유자를 유지한다. 자식은 private RPC로
토큰을 요청하고 별도 provider/REST scheduler를 만들지 않는다. 따라서 API가 멈춘
동안 이미 연결된 WS 수신·저장은 독립적으로 진행하지만 인증 갱신·제어는 기다릴 수
있다. 종목 master와 거래일 판정·watchlist 이름도 부모가 전달한다. 현재 날짜의
unknown-lenient 판정은 유지하고 날짜가 바뀌면 다음 parent sync까지 연결을 보류한다.
자식은 FastAPI assembly/lifecycle을 import하지 않는다. 공유 GC 튜닝은 유지하며
강제 GC나 gc.disable/freeze를 추가하지 않는다.

## 통신과 표시 손실

공개 포트를 만들지 않고 spawn handle transfer로 전달하는 socketpair 세 개를 쓴다.
제어/토큰 RPC, 화면 데이터, 최신 상태를 나눈다. 각 frame의 epoch·sequence와
제어 request ID, desired/ACK version으로 이전 자식·취소된 요청·과거 설정의 답을
거른다. 현재 보는 종목의 ref×venue를 부모가 보관하고 새 자식에 재전달한다.

표시 참조 장부는 서로 다른 종목 최대 512개, 종목당 탭 참조 최대 64개로 제한한다.
같은 종목을 여러 탭에서 보는 것은 키움 등록을 추가로 소모하지 않으므로, 전체
`(종목, 탭)` 수를 512개로 제한하지 않는다. 앱 장부 한도는 별도
`live_subscription_limit` 이벤트로 알리고, 실제 키움 등록 부족만
`kiwoom_full_house`로 알린다. 키움 만석으로 보류된 참조도 부모·자식의 desired
장부에 유지해 정합화·재시작 후 자동 배정 대상에서 빠지지 않게 한다.
장외 게이트·연결 복구 대기는 참조를 보존하되 만석으로 알리지 않는다. 연결의
일시적 가용성 대신 저장·표시 등록을 차감한 예산으로 슬롯 소진을 판정한다.

만석을 통지한 WS 연결은 보류 종목의 요청 venue 전체가 `ready_registrations`에
포함되는지 1초마다 확인한다. 슬롯 배정만으로 복구를 판정하지 않는다. 등록 ACK가
확인되거나 해당 화면 구독이 해제되면 그 연결에 `kiwoom_full_house_resolved`를
보내 해당 종목만 경고에서 제거한다. 마지막 보류 종목이 해결되면 경고가 자동으로
사라지고 확인 루프는 대기한다. 앱 참조 한도 경고는 이 이벤트로 지우지 않는다.

- 화면 outbox: 1,024개 / encoded 8MiB, 단일 frame 256KiB. sender만 drain을 기다린다.
  가득 차면 오래된 frame부터 축출한다. 체결을 하나의 최신 값으로 합치지 않는다.
- 상태 outbox: 최신 미전송 스냅샷 1개, frame당 8MiB(아래 2026-10-23 개정). 1초마다 계정 수신·완료/등록·큐, 저장 오류,
  자식 GC, PID·시작·epoch, 표시 축출 수를 전달한다.
- RPC: pending 및 inbound command 각각 32개, frame 8MiB, 요청 timeout 30초.
  초과/timeout/끊김은 명시적으로 실패한다. 초봉 응답을 조용히 잘라 거래량을 바꾸지 않는다.
- 위 수치는 outbox/frame의 상한이다. 각 lane의 진행 중 frame, StreamReader/transport,
  OS socket buffer, 조회 응답 생성과 부모·자식의 전체 RSS까지 포함한 상한은 아니다.

필수 저장 입력은 화면 outbox를 거치지 않는다. 화면 gap은 별도 sequence 카운터와
차트의 이력 축소 표시로 드러낸다. API의 초봉 조회는 자식의 진행 중 봉·미저장 late
correction을 RPC로 받고 disk revision과 기존 규칙으로 병합한다. 과거 날짜는 자식
장애와 무관하게 disk에서 읽는다. 당일 최대벽은 자식에서 replay/merge하고 새 stream
소유자가 생기면 다시 seed한다. VI도 자식의 상태를 조회한다.

## 단일 소유와 종료

부모는 기존 `.ws_writers.lock`으로 자격을 판정하며 Today Promoter를 계속 소유한다.
수집 자식은 `.live-capture.lock`을 잡은 뒤에만 WS/프로그램·호가 writer를 시작한다.
inprocess 롤백도 이 capture lock을 잡아야 한다. 이전 자식의 종료가 확인되기 전에
replacement를 띄우지 않는다. lock 파일의 PID 내용은 진단용이고 flock이 판단 근거다.

EOF·부모 PID 변경·IPC/필수 task 종료는 자식 종료를 시작한다. 세션을 닫고 진행 중
flush/이미 drain한 프로그램 batch를 완료한 후 남은 부분 봉·마지막 호가를 저장한다.
thread write가 끝나기 전에 잠금을 풀지 않는다. 부모는 join 30초 후 terminate하고
추가 join 5초에도 살아 있으면 replacement를 금지한다. 부모가 죽은 orphan도 30초
상한 후 강제 종료한다. 강제 종료 시 아직 저장되지 않은 부분 데이터의 손실 가능성은
남으며 forced_terminations/epoch 변화와 로그로 표시한다. 무손실을 보장하지 않는다.

`LiveWriter.fsync_all`은 venue 파일을 놓치던 date-root scan 대신 실제 append한
경로/version을 추적하여 fsync한다. 이미 fsync한 과거 파일을 매 cycle 재탐색하지
않고 fsync 도중 추가 write는 dirty 상태로 남긴다.

## health·전환·검증

`/api/live/status.kiwoom.collector`와 deep health의 `collector`가 자식 상태를 노출한다.
상태가 10초 이상 오래됐거나 제어 ACK 불일치·죽은 자식·저장 오류이면 정상으로
판정하지 않는다. 저장 오류에서도 최근 실제 계정 연결 증거는 보존한다. deep health는
collector 비준비를 503으로 표시하고 queue readiness와 분리한다. 계정 수신이 실제
진행하는지는 기존 last_recv/last_tick/완료 카운터로 계속 평가해야 한다.

`default_app`의 기본은 process, `HOGA_LIVE_COLLECTOR=inprocess`로 이전 조립을 고를
수 있다. 주입형 `create_app`의 기본은 inprocess로 테스트 조립을 유지한다. 전환은
프로세스 종료 뒤에만 한다. 운영 서버를 재시작하거나 배포하지 않았다.

오프라인 검증은 fake manager를 실제 spawn 자식에 넣고 burst 표본의 필수 JSONL을
기존 LiveStream의 결과와 전수 비교한다. 화면 큐 포화, 부모 루프 정지 중 자식 저장,
자식 종료/restart·세대 변경·view ref 복원, 취소된 RPC의 late reply, frame 상한,
종료 flush/batch 완료, 초봉 HTTP와 degraded health 직렬화를 검증한다. 실자격증명,
벤더 연결/토큰 발급, 운영 포트, 강제 GC는 사용하지 않는다. 장중 수신→완료 p99,
자연 gen2, 합산 RSS·CPU/디스크 비용은 별도 운영 검증이 필요하다.

이 결정은 ADR-0116의 API 내부 WS 조립과 ADR-0094의 program/promoter 공동 writer
소유 설명을 확장한다. ADR-0168 Today Promoter와 ADR-0169 compute pool 분리는 유지한다.
세 종류의 process를 같은 worker pool로 섞지 않는다.

## 2026년 10월 12일 개정 수집 연결 증거와 설정 준비의 분리

최근 현재 epoch의 연결 증거와 설정 준비 완료를 별도로 판정한다. 설정 버전과 ACK,
상태 버전의 불일치만으로 실제 계정 연결 수·수신 시각을 지우지 않는다. 이때
`capture_reason=syncing`, `collector.ready=false`이며 구독 준비와 데이터 조회의
엄격한 조건은 유지한다. 실제 연결 0은 offline, 수집 상태 유실은
collector_unavailable, 필수 저장 실패는 storage_error로 표시한다.

신선도 10초·자식 생존·필수 IPC 작업·epoch 검증은 그대로 적용한다. ACK 대기는
기존 RPC 30초, ACK 뒤 해당 버전 상태 대기는 10초로 제한한다. deep health는
비준비 상태에서 503을 유지한다. 외부 워치독만 다른 실패가 없는 제한 시간 안의
syncing에 한해 1초 뒤 한 번 재조회한다. 지속 실패와 복합 실패의 재시작은 유지한다.

[개선 계획과 근거](../plans/2026-10-12-realtime-unavailable-status.md)를 함께 본다.

## 2026년 10월 16일 개정 초봉 일반 저장 주기의 단일 소유

모든 계정의 `LiveStream`은 같은 `SecondTradeStore`를 공유한다. 일반 초봉 flush는
수집 프로세스 내 `KiwoomSessionManager`가 소유한 태스크 하나가 10초 경계마다 수행한다.
계정별 10초 호가·분봉 writer와 ingest 게이트는 유지하고, 일반 초봉 flush만 중복 제거한다.
이 태스크는 계정 0의 연결 수명에 의존하지 않으며 watchdog이 종료된 소유자를 복구한다.

각 거래소의 장 마감 drain과 계정 연결 종료는 초봉 강제 저장을 유지한다. 전체 정지는
계정의 수신·강제 저장을 마친 뒤 공유 주기 태스크를 취소·join하고 마지막 강제 저장을
완료한다. 취소된 flush도 native 디스크 쓰기가 끝나기 전 잠금을 놓지 않는다.
추가 프로세스나 스레드에 mutable 봉 상태를 이관하지 않으며 기존 10초 저장 주기와
fsync를 늘리거나 제거하지 않는다. 강제 종료 전 미저장 체결의 기존 복구 한계는 동일하다.

## 2026년 10월 23일 개정 최대벽 상태의 분할 전송

최대벽 차분은 변경된 종목·venue의 당일 분별 이력 전체를 포함한다. 여러 조회 종목의
갱신 또는 전체 복구 스냅샷이 8MiB를 넘으면 상태 생성 태스크의 encode가 실패하고
필수 태스크 종료 규칙에 따라 수집 프로세스까지 종료되는 경로를 합성 이력으로 재현했다.
운영 로그는 해당 encode 예외와 이후 당일 조회 503을 보여 주며, 당시 페이로드의
필드별 실제 크기는 기록되지 않았다.

상태 outbox는 최신 미전송 **직렬화 전 스냅샷 참조 1개**를 보존한다. sender가
종목·venue 사이에서 나눠 frame당 8MiB 이하로 직렬화하고, 현재 스냅샷의 마지막
부분까지 보낸 뒤 다음 스냅샷을 꺼낸다. 대기 슬롯을 덮어쓰면 기존 차분 규칙대로
전체 복구 스냅샷을 넣는다. 전송 중인 스냅샷의 일부만 새 상태로 교체하지 않는다.

부모는 epoch·sequence·설정 버전과 부분 순서를 확인하고 마지막 부분이 도착한 뒤에만
최대벽·health 신선도를 갱신한다. 중간 EOF·세대 혼합·중복 키는 실패로 처리한다.
종목·venue 추적 상한 512개, 단일 키 및 frame의 8MiB 제한은 유지하고 분 이력을
잘라내지 않는다. seed RPC는 요청한 종목·venue 하나만 반환하며 부모는 키별 sequence
floor로 상태 전송과의 경합을 조정한다. 다른 종목의 이력이나 최신 RPC를 되감지 않는다.

종전의 상태 outbox **전체 encoded 8MiB 상한**은 위 규칙으로 대체한다. 현재 상태와
최신 대기 상태는 각각 최대 512키의 당일 이력 참조를 보유할 수 있고, 부모도 완성 전
스냅샷을 조립하므로 전체 RSS 8MiB 상한을 뜻하지 않는다. 다중 frame 전체를 미리
직렬화해 쌓지 않으며 sender만 drain을 기다린다. 화면 outbox와 일반 RPC의 기존
상한·저장 입력 경로·수집 단일 소유·10초 신선도 판정은 유지한다.

후속 경계 시험에서는 개수 제한이 없는 `all_record_peaks` 때문에 단일 종목·venue도
8MiB를 넘을 수 있음을 재현했다. 위 분할은 키 사이에서만 나누므로 그 경우는 아직
해결하지 못한다. 독립 상태 채널, 원본 변경 표시와 기록 splice, 키 내부 분할 복구의
[비교 실험과 제안](../diagnostics/2026-10-23-collector-ipc-design/design.md)을 남겼다.
해당 프로토타입을 운영 조립에 반영한 것은 아니며 이력 절삭은 하지 않는다.

## 2026년 10월 23일 개정 실제 수집 경로의 병행 비교

사용자의 병행 검증 요청으로 process 수집의 선택적 `HOGA_PEAK_SHADOW=1` 모드를
추가했다. 기존 응답·저장은 유지하고 native 최대벽 변이 지점에 분별 변경/기록 splice를
표시해 별도 복원본과 전체 snapshot을 대조한다. 기본은 비활성이며 Code 필터와
표본 side/point/staging/time 예산을 둔다. 초당 한 side를 검사하고 30회 상태 주기마다
결과·오류·예산 제외·표본 범위를 로그로 남긴다. 날짜/종목/stream 교체와 weak 소유로
수명을 제한하며, 진단 오류나 불일치가 수집·저장을 중단하지 않도록 진단만 닫는다.

이는 최대벽 운영 IPC의 교체나 readiness 완화를 뜻하지 않는다. 실제 Live Tick 표본과
저장 파일을 변경 전 구현과 독립 조립에 넣어 대조하고, 초기 수신 순번·봉인 시점은
재생기에서만 고정한다. 실제 저장 결과·메모리·자연 GC·콜백 비용과 한계는
[병행 검증 기록](../diagnostics/2026-10-23-peak-shadow/validation.md)을 따른다.
