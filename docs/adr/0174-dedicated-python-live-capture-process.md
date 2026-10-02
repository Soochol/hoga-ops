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

- 화면 outbox: 1,024개 / encoded 8MiB, 단일 frame 256KiB. sender만 drain을 기다린다.
  가득 차면 오래된 frame부터 축출한다. 체결을 하나의 최신 값으로 합치지 않는다.
- 상태 outbox: 최신 미전송 1개 / 8MiB. 1초마다 계정 수신·완료/등록·큐, 저장 오류,
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
