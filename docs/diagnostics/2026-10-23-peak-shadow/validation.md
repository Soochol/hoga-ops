# 실제 수집 경로의 최대벽 병행 검증 — 2026-10-23

`LiveStream.on_tick`과 seed 설치·병합에서 실제로 바뀐 분/기록 구간을 표시하도록
구현했다. 새 증분 복원본은 진단에만 사용하고 기존 snapshot/API/저장은 계속 정본이다.
수집 데이터의 의미나 공개 wire 모델을 바꾸지 않았다.

## 운영에 연결되는 코드

- `hoga/live/ask_peak_state.py`: 유효 체결의 극값, 미도달 후보, 순위, 분별 최대,
  누적 기록 시퀀스가 실제 바뀌는 자리에서 표시한다. 이벤트 하나의 revision은 한 번만
  올리고, 분별 변경은 set으로 합치며 기록 시퀀스는 최소 변경 인덱스 하나로 합친다.
- `hoga/live/peak_changes.py`: native 상태에서 차분을 생성하고 generation/base revision을
  검사하는 복원본을 제공한다. 종목 내부를 나눠 JSON 왕복하며 단일 부분은 256KiB 이하,
  조립은 기본 8MiB byte 예산으로 제한한다. 수신 틱에서는 직렬화하지 않는다.
- `hoga/live/peak_shadow.py`: 기존 전체 snapshot과 새 복원본을 대조한다. 불일치 필드명,
  검사·복구·오류·예산 거절 수, 비교 시간, 보유 포인트, 실제 표본 범위를 기록한다.
  검사 대상은 weak reference로 소유하며 종목 해제·날짜 변경·stream 교체에서 회수한다.
- `hoga/live/collector_worker.py`: process 모드에서 선택적으로 공유 검증기를 주입한다.
  초당 한 side를 검사하고 30회 상태 주기마다 `collector.peak_shadow` 로그를 남긴다.
  비교·통계·로깅 중 진단 예외가 발생하면 검증기만 닫고 기존 상태 송신·저장은 유지한다.

기본은 비활성이다. 배포 후 수집 프로세스를 시작할 때 다음 환경변수로 좁은 표본을
지정할 수 있다. 이 작업에서 운영 서버의 실행 환경이나 설치 경로를 바꾸지 않았다.

```bash
HOGA_PEAK_SHADOW=1
HOGA_PEAK_SHADOW_CODES=003160,031980
```

기본 표본은 최대 16 side(8개의 Code×venue 쌍), 전체 cache 100,000 history points,
side당 10,000 points, 비교 한 번의 사후 시간 예산 25ms다. 시간 예산은 선점 중단이
아니며 넘친 해당 표본의 후속 검사를 막는다. 거절 상태도 최대 64개까지만 기억하고
초과하면 진단을 닫는다. 이 수치들은 **전체 프로세스 RSS 상한이 아니다**.
과거 표본/예산 거절은 `sampled`, `blocked_sides`, `*_rejected`로 구분한다.

진단의 exception, mismatch, cap 초과를 수집 데이터 손실로 처리하지 않는다. `errors`
또는 `mismatches`가 있으면 새 방식의 통과로 간주해서는 안 된다. 실제 IPC EOF·저장
오류·죽은 수집 태스크의 기존 fail-closed 처리는 그대로다. 새 최대벽 소켓으로 운영
응답을 교체하는 단계는 아직 포함하지 않았다.

## 실제 데이터와 독립 기준

운영 앱이 이미 등록한 종목만 기존 `/api/ws`로 관찰했다. 새 벤더 인증·연결은 만들지
않았다. 첫 표본은 8종목/60초/7,106개 API Live Tick이다. 오늘 저장된 8개 Code×venue
파일에서는 완성된 줄까지 읽은 고정 prefix 76,468행을 별도 임시 파일로 복사했다.
원본은 읽기만 했으며 원본 prefix와 입력의 SHA256을 보존했다.

기준은 `56ce0b5722b9d76112eb06c072cd7f6d45eba396`의 변경 전 peak 상태 클래스와
변경 전 LiveStream을 별도 모듈로 불러온 것이다. 같은 입력을 다음 네 조립에 넣었다.

| 모드 | 의미 |
|---|---|
| old | 변경 전 구현 |
| off | 현재 구현, 검증 비활성 |
| track | 실제 native 변경 표시 활성, 처리 루프 중 비교 안 함 |
| shadow | 변경 표시 + 128개 입력마다 한 side를 JSON 왕복·전체 대조 |

각 조립은 fresh process와 임시 데이터 폴더를 사용했고 3회씩 반복했다. 같은 입력에
대한 최종 최대벽 snapshot 해시와 호가·분봉 JSONL, 초봉 journal의 파일별 전체 바이트
해시가 **모든 조립에서 같았다**. 실시간 표본은 매 콜백 직후의 side를 추가로 엄격히
검사해 14,252회 일치했고 오류·불일치는 0이었다.

초봉 journal은 실제 생성자에서 wall time으로 receive sequence/봉 봉인 시점을 잡으므로,
처음 재생에서는 실행 간 파일 해시가 달랐다. 필드를 삭제하거나 비교를 느슨하게 하지
않고, 재생의 초기 sequence를 0, 봉인 시점을 첫 입력 이전으로 고정해 전량 재검증했다.
운영 생성자·저장 코드에는 이 고정을 적용하지 않았다.

## 현재 들어오는 입력의 병행 대조

고정 표본 재생과 별도로 15:40 KST 이후 기존 앱의 `003160`, `000660` 데이터를
60초 동안 두 구현에 동시에 넣었다. 동일한 고정 파일 prefix에서 양쪽 seed를 만들고,
실제 시간의 수집 창·임시 초봉 저장·10초 flush/fsync도 함께 실행했다. 운영 수집
worker에 코드를 hot patch하거나 재시작하지 않았으며, 두 검증 조립은 별도 소비자다.

실시간 입력 1,258건(KRX 9/NXT 636/UN 613)에서 직접 old/new 전체 상태 대조
2,516회, 새 증분 복원 대조 2,528회가 모두 일치했다. 초기 full 12개 이후 **실제
delta 94개**를 적용했고 errors/mismatches/admission/point/time 제외가 모두 0이었다.
최대 check는 9.01ms였다. 양쪽 임시 저장의 JSONL 8개도 바이트 해시가 같았다.
관찰 전후 실제 수집은 healthy였고 연결 계정은 6→6으로 유지됐다.
[live-parallel.json](live-parallel.json)에 기록했다.

그 전 10초 표본에는 입력 171개가 있었지만 유효한 최대벽 변경이 없어 delta가 0이었다.
이 표본은 성공으로 세지 않고 `live-idle-sample.json`에 inconclusive로 남겼다. 초기
seed와 WS 관측 시작 사이를 무손실 handoff로 보장하지 않으며, 이 대조는 동일하게
관측한 입력에 대한 변이/복원/저장 동등성 검사다.

## 처리 시간

분리 프로세스의 짧은 표본은 시스템 부하에 따른 편차가 컸다. 같은 입력 콜백마다
old/off/track 실행 순서를 순환하고 `process_time_ns()`로 같은 순간의 CPU 비용도
비교했다. [paired.json](paired.json)에 원시 측정값을 보존했다. p99는 **관측 입력을
재생한 콜백 비용**이며 벤더→디스크 장중 전체 지연을 뜻하지 않는다.

| 모드 | p99 CPU | 전체 콜백 CPU 합 |
|---|---:|---:|
| old | 101.79μs | 358.54ms |
| off | 102.28μs | 358.72ms |
| track | 107.44μs | 364.57ms |

이 교차 표본에서 변경 표시 활성의 p99 증가는 약 5.65μs, 전체 콜백 CPU 증가는 약
1.68%였다. 비활성의 CPU 합 차이는 약 0.05%였으나 보편적 0비용 보증은 아니다.

표본별 wall time·p50/p95/p99·RSS·자연 GC는 [replay.json](replay.json)에 있다. 콜백
지표는 flush/비교 시간을 제외하고, 전체 재생 시간에는 둘을 포함한다. 무부하라고
가정하거나 짧은 표본의 작은 차이를 통계적 무회귀로 단정하지 않는다.

## 메모리와 발견해 고친 부작용

메모리 측정은 tracemalloc을 켠 별도 실행이며 그 실행 시간으로 성능을 판단하지 않았다.
`VmRSS`의 현재값과 `ru_maxrss` 최고값을 분리했고 강제 GC·GC 비활성·freeze는 쓰지 않았다.

저장 데이터 표본에서 비교 캐시까지 채운 뒤의 traced 보유량은 old 7.07MiB, off 7.10MiB,
shadow 11.33MiB였다. 검증 복원본 약 15,180 points를 추가 보관하므로 off보다 약
4.23MiB 증가했다. 종목 해제 뒤에는 shadow cache/marker 수가 0으로 돌아왔다. RSS는
할당자 arena 때문에 이와 같은 양만큼 즉시 내려가지 않을 수 있다.

처음의 `JSONEncoder.iterencode()` 구현에서는 검증을 반복할 때 재귀 encoder closure의
임시 순환 객체가 자연 GC까지 남았다. 실제 콜백/검사/해제를 2,000회 반복한 시험에서
traced peak가 4,757,573B였고 자연 gen0 GC가 2회 발생했다. 강제 GC로 숨기지 않고,
컨테이너 깊이만 유지하는 반복형 token encoder로 바꿨다.

같은 시험의 최종 traced peak는 250,287B로 약 94.7% 감소했다. 4,000회 대조가 모두
일치했고 매 회 검증 cache·marker·native peak 슬롯이 0으로 회수됐다. 100→2,000회
구간 현재 RSS는 4KiB 차이였으며 traced 보유량의 약 9KiB 증가는 측정 sample 목록
자체를 포함한다. [lifecycle.json](lifecycle.json)과 수정 전 기록을 함께 남겼다.

## 검증 경계

- 코드 시험에는 seed 설치·중복 병합, 지연 도착에 의한 기록 꼬리 소급 교체, 분 누적,
  종목 해제, 날짜 변경, 살아 있는 이전 stream의 교체, 잘못된 base/generation,
  누락된 변경 표시 주입, 비교/통계 예외 주입, point/time/staging 예산을 포함한다.
- 운영 worker가 오래된 stream을 아직 join 중이어도 현재 capture stream으로 표본을
  정합화한다. 예산으로 제외한 상태를 매 상태 주기마다 다시 붙여 비용이 반복되지 않게 했다.
- 벤더 원본 전체나 API 전달 이전의 무손실을 보증하는 시험이 아니다. 동일한 관측
  입력에 대해 새 변경 표시/복원 및 실제 저장 결과가 기존 구현과 같은지를 검증했다.
- 제한된 종목·기간의 실제 표본이며 전체 348개 ready 종목, 긴 자연 gen2, 합산 RSS와
  실운영 장기 p99를 검증했다고 주장하지 않는다. 비교 cache 비용 때문에 기본 비활성을 유지한다.

## 재현 도구

`scripts/probe_peak_capture_shadow.py`는 고정 API 표본/저장 prefix를 실제 on_tick,
LiveWriter, SecondTradeStore로 재생한다. `scripts/probe_peak_shadow_paired.py`는 같은
콜백에서 순서를 바꾼 CPU 비교를 수행한다. `scripts/probe_peak_shadow_lifecycle.py`는
실제 OB 표본으로 2,000회 수명 검사를 수행한다. `scripts/probe_peak_shadow_live.py`는
운영 앱의 이미 준비된 등록만 관찰하며 old/new 임시 저장을 실시간으로 대조한다.

원시 입력은 `/tmp/hoga-peak-shadow-20261023/`에 보존했고 소스 prefix/입력 해시는
`capture.json`, `stored-input.json`에 있다. 시장 데이터 원본을 저장소에 추가하지 않았다.
시험의 commit/base·입력 지문·명령·결과는 `verification.json`에 기록한다.
