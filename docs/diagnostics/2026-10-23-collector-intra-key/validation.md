# 단일 종목 8MiB 초과 이력의 무절삭 전송 — 2026-10-23

종목 하나의 누적 최대벽 이력이 커져도 정기 상태와 최초 seed RPC 모두 나눠 전송하도록
구현했다. `all_record_peaks`의 점을 자르거나 근사하지 않는다. 기존 전체 snapshot이
계속 정본이며 native journal을 운영 응답에 사용하는 변경은 아니다.

## 변경 내용

`collector_transfer.py`는 immutable snapshot의 dict와 list를 순회한다. 배열은 256개
항목씩 변환하고 frame당 256KiB 이하로 묶으며, 수신기는 결과 배열을 직접 확장한다.
전체 JSON 문자열·전체 encoded 조각 큐·조각 문자열의 최종 join/reparse를 만들지 않는다.
작은 scalar/point와 깊이 16 이하인 현재 최대벽 스키마를 대상으로 한다.

정기 상태의 `state_frames/read_state`와 최초 `peaks` RPC 응답이 같은 전송기를 쓴다.
수신은 epoch/sequence/설정 버전 또는 reply ID, 부분 번호, 중복 경로, 배열 선언 길이와
append offset, 마지막 end marker를 확인한 뒤에만 완성된 결과를 공개한다. 끝 표시를
배열 중간 또는 배열 경계에서 앞당겨도 부분 성공이 되지 않는다. EOF/누락/중복/혼합은
실패하며, 실패한 새 상태로 기존 최대벽 캐시나 health 신선도를 갱신하지 않는다.

RPC write lock은 한 transaction 전체를 보호한다. 취소된 RPC는 복원 중인 prefix를
놓고 남은 조각을 배출해 다음 응답과 분리한다. 일반 RPC/공개 HTTP 모델은 그대로다.
양쪽은 매 frame 사이 실행을 양보한다. reader의 read-ahead 임계값도 8MiB에서 256KiB로
낮췄지만 일반 RPC의 8MiB frame과 `readexactly`는 계속 지원한다.

## 동일 데이터와 실제 수집 경로 검증

단위 검증은 실제 native `Peak` 객체로 양쪽 90,000개 이상의 이력을 만들고 후속
`LiveStream.on_tick` 변이를 적용했다. 8MiB 제한을 재현한 뒤 실제 `CollectorWorker`
최대벽 조회/명령 루프, `RpcPeer`, `CaptureProcessSession.ensure_today_peaks_seeded`와
정기 `_states`에서 전수 일치와 worker 생존을 확인했다. 잘못된 순서/길이/세대/설정,
중복 append/경로, 중간 EOF, early last/end 누락, 취소 후 다음 RPC, RPC writer 경합,
`drain()`이 즉시 반환하는 경우의 실행 양보도 검사한다.

[capture.json](capture.json)은 모든 큰 기록을 **실제 on_tick으로 생성한 별도 재생**이다.
연속호가 필터를 통과하는 합성 OB 90,000건으로 한 종목 이력을 8MiB 초과로 만들었다.
이후 이전에 실제 API에서 관측한 고정 표본 7,106건(호가 3,450·체결 3,322·프로그램
296·거래원 38)을 변경 전 `97b3ffe03` 구현과 새 구현의 독립 stream/store에 넣었다.
최초 합성 시험은 얕은 호가여서 연속호가 필터에서 제외됐고, 크기 초과 재현 guard가
실패했다. 유효한 깊이의 입력과 실제 기록 개수 guard를 추가한 최종 실행만 결과로 센다.

실제 socketpair의 수신 transport를 정지하고 송신 high watermark 초과를 확인했다.
그 상태에서도 두 stream의 수집과 flush/fsync를 계속 수행했다. 중간 대기 snapshot을
다음 것으로 덮어쓴 뒤 전체 복구를 확인했고, 부모의 최종 캐시가 원본/기존 구현과 모두
같았다. 양쪽 durable JSONL **44개가 모두 바이트 단위로 일치**했다. 전송은 72 frame,
총 약 16.95MiB(초기+복구 합)였고 최대 frame은 260,355B였다.

동일 시점의 실행 순서를 교차한 콜백 CPU는 기존 p99 76.543μs/합 3290.44ms,
새 p99 76.643μs/합 3310.33ms였다. 이 표본의 차이는 p99 +0.100μs/합 약 +0.60%다.
수집 알고리즘은 수정하지 않았고, 짧은 표본·호스트 부하·자연 GC 편차를 포함하므로
보편적인 0.6% 오버헤드나 실장중 종단간 지연 보증으로 해석하지 않는다.

[capture-with-latency.json](capture-with-latency.json)은 같은 경로를 재실행해 원본 snapshot
생성과 부모 복구까지도 측정했다. 실제 큰 snapshot 생성은 초기 58.03ms/최종 50.24ms였고,
수신 재개부터 전송 중인 초기 상태와 최신 전체 복구가 부모에 반영되어 원본 비교까지
끝나는 데 286.05ms였다. 원본 전체 snapshot 생성은 여전히 한 번에 실행되는 비용이다.
해당 재실행에서도 상태/44개 파일이 일치했고, 콜백 CPU 합은 기존 2915.90ms/새 2922.24ms,
p99는 62.767μs/63.108μs였다. 앞 실행과의 편차도 보존하며 한 번의 수치로 일반화하지 않는다.

## 전송 성능과 작은 이력의 비용

[transport.json](transport.json)은 각 사례/전략을 새 프로세스에서 CPU 3회, 별도
tracemalloc 1회씩 실행한다. 실제 socketpair를 쓰지만 이 표본에서는 송수신 이벤트
루프가 한 프로세스 안에 있다. CPU/시간에는 socket 조립·직렬화·복원·종료가 포함되며
원본 snapshot 생성은 제외한다. tracer를 켠 실행의 시간은 성능 중앙값에서 제외했다.

비교 기준은 **측정에 한해 8MiB 제한을 풀어 둔 기존 단일 JSON encoder**다. 실제 변경
전 운영 코드는 큰 두 사례에서 예외가 나므로 처리 시간만으로 운영 성공으로 세지 않는다.

| 한 side 기록 수(매수/매도 각각) | 기존 단일 JSON 왕복 CPU | 새 분할 왕복 CPU | 새 frame 수 |
|---|---:|---:|---:|
| 390 | 0.748ms | 0.975ms | 1 |
| 90,000 | 117.00ms | 105.20ms | 36 |
| 200,000 | 258.17ms | 215.83ms | 79 |

작은 이력은 tree 연산/검증 비용으로 약 0.23ms(약 30%) 늘었다. 절대 시간은 이 표본에서
1ms 이하지만 비용이 없는 변경은 아니다. 큰 두 사례는 각각 약 10.1%/16.4% 적은 CPU였다.
200,000개 사례의 논리 JSON은 19,601,299B(약 18.69MiB)였고 새 전송 총량은
19,641,552B로 약 0.21% 늘었다. 큰 이력도 프레임을 늘려 전수 복원했다.

tracer 없는 200,000개 시험의 최대 이벤트 루프 관측 공백은 기존 154.7~175.8ms,
새 6.85~7.92ms였다. 별도 소켓만으로 CPU가 격리된다고 가정하지 않고 bounded batch
사이 실제 양보를 넣은 효과다. 이는 로컬 시험의 loop gap이며 벤더 수신 p99는 아니다.

큰 200,000개 시험의 자연 GC 0세대 수집은 비교 기준 1회/새 방식 7회였다(각 3번의
CPU 시험에서 동일). 분할 복원은 Python 작업을 사이에 두므로 GC 실행 빈도가 늘어나는
부작용이 있다. 측정 CPU와 loop gap에는 그 비용도 포함한다. 이 짧은 전송 구간에서는
양쪽 모두 gen1/gen2 수집이 없었으므로 장기간 상위 세대 비용이 검증됐다는 뜻은 아니다.

## 송수신 프로세스별 메모리와 반복 회수

[processes-monolithic.json](processes-monolithic.json)과
[processes-chunked.json](processes-chunked.json)은 **spawn된 별도 송신 프로세스와 부모**의
실제 private socket 전송이다. 매수/매도 각각 200,000개를 비교했고 각 실행에서 원본과
복원본의 canonical JSON SHA256 및 기록 수가 일치했다. 전체 source tree 생성 뒤에
tracer를 켰으므로 아래 수치는 원본 native/snapshot을 포함한 전체 RSS가 아니다.

| 전송 중 추가 traced peak | 기존 단일 JSON | 새 분할 |
|---|---:|---:|
| 송신 프로세스 | 39,203,084B (37.39MiB) | 1,039,750B (0.99MiB) |
| 수신 프로세스 | 120,451,754B (114.87MiB) | 101,253,948B (96.56MiB) |

수신 완료 후의 실제 결과 캐시 자체는 약 96.3MiB를 보유한다. 모든 기록을 복원하므로
이 메모리는 없애지 않는다. 새 송신 transport buffer의 관측 최대는 356,572B로,
비교 기준의 19,382,039B보다 작았다. source tree와 allocator/import를 포함한 RSS도
두 JSON에 남겼고, traced peak와 RSS를 서로 바꿔 부르지 않는다.

[lifecycle.json](lifecycle.json)은 side당 2,000개를 100회 소켓 전송/복원/해제했다.
모든 결과가 일치했고 강제 GC·GC disable/freeze 없이 traced 보유량은 10회 24,031B에서
100회 26,925B였다(샘플 통계 자체 포함). 현재 RSS는 51,314,688B→50,405,376B였다.
큰 한 번의 객체를 놓은 뒤의 traced 보유량도 transport 측정에 별도로 남겼다.
RSS는 allocator arena 때문에 객체 해제량만큼 즉시 내려간다고 보장하지 않는다.

## 재현과 적용 경계

```bash
uv run --extra dev python -m scripts.probe_collector_large_transfer --output /tmp/transport.json
uv run --extra dev python -m scripts.probe_collector_large_transfer --trial capture --points 90000 --output /tmp/capture.json
uv run --extra dev python -m scripts.probe_collector_large_transfer --trial lifecycle --output /tmp/lifecycle.json
uv run --extra dev python -m scripts.probe_collector_large_transfer --trial processes --points 200000 --strategy chunked --output /tmp/processes.json
```

원시 시장 데이터는 기존 `/tmp/hoga-peak-shadow-20261023/live.jsonl`에 있고 SHA256을
capture 결과에 기록했다. 저장소에는 원본 시장 데이터를 추가하지 않았다. 운영 서버,
벤더 연결, 계정과 환경은 건드리지 않았다. 현재 시점의 벤더 실시간 관측을 새로 수행한
검증이 아니며, API에 전달되기 전의 무손실까지 주장하지 않는다.

키 개수 512와 최신 미전송 snapshot 1개/전송 중 snapshot 규칙은 유지한다. health
10초·RPC 30초도 유지하므로 장기 수신 정체는 비준비/조회 실패로 표시된다. 결과 캐시와
원본 snapshot 생성/비교는 여전히 O(전체 이력)이고, 256KiB는 frame/read-ahead 단위다.
전체 종목의 장기간 합산 RSS, 디스크/벤더 종단간 p99까지 검증한 결과는 아니다.

최종 검증 전 main `f06ba91d4`를 반영했다(추가 main 변경은 프론트엔드 주문 기능).
백엔드 전체 **6,847 passed, 2 skipped, 13 deselected**였고 Ruff와 diff whitespace도
통과했다. 핵심 전송/worker/parent/shadow 범위는 마지막 주석 보완 뒤 다시 **112 passed**였다.
소스/테스트/의존성/설정 지문과 명령·환경·검증 결과는 `verification.json`에 기록한다.
