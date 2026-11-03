# 2026-09-28 서버 OOM 조사

조사일: 2026-09-29. 체크아웃: `3858bd28d`. Python 3.14.4, CPU 32개, RAM 약 91GiB.

## 보관 맥락

2026-11-03에 기존 로컬 조사 자료를 문서로 보관했다. 아래 측정·프로세스 상태·코드
설명은 원래 조사 시점의 기록이다. 이번 보관 작업에서는 실험을 재실행하거나 현재
제품 동작을 검증하지 않았다. OOM의 객체·할당 경로는 이 자료에서 미확정으로 남는다.

`evidence/`의 원본 출력과 `harnesses/`의 보관 스크립트는 변경하지 않았다.
`candles.jsonl`은 JSON 레코드만 포함하지만, `range.jsonl`과 `client_long.jsonl`은
JSON 레코드에 경고·traceback이 섞인 원본 콘솔 출력이다. 두 파일 전체를 JSONL
파서에 바로 넣을 수는 없다. 아래 로그 경로와 traceback의 `/tmp/` 경로는 당시
머신의 출처이며 저장소에 포함된 파일 링크가 아니다. harness는 당시 로컬 데이터와
코드에 의존하므로, 아래 재실행 절은 현재 환경에서 검증한 실행 안내가 아니다.

## 결론과 확신의 범위

백엔드 본체의 과도한 메모리 사용으로 시스템 OOM이 발생한 것은 확인됐다.
**69.3GiB를 보유한 객체/할당 경로는 아직 특정하지 못했다.** 아래 보조지표의 높은
메모리 사용을 이 사고의 원인으로 동일시하면 안 된다. 사고 때 크게 증가한 것은
본체 PID 20499이고, 보조지표는 별도 계산 워커에서 실행된다.

- 9월 28일 23:11:13 커널은 PID 20499의 anonymous RSS 72,693,168kB(69.33GiB)를
  기록하고 해당 Python 프로세스를 종료했다. `evidence/oom.txt`.
- `~/.local/share/hoga-ops/logs/hoga.log`의 `pid=20499 port=8000` 기록과 대조해
  이 프로젝트의 서버임을 확인했다. 같은 시각 VS Code shared-process/extensionHost도
  종료됐다(`~/.config/Code/logs/20260928T203956/main.log`).
- 당시 커널 표에서 가장 큰 계산 워커는 약 6.64GiB였다. 따라서 현재 워커의 높은
  메모리만으로 당시 본체의 69.3GiB를 설명할 수 없다.
- 사용자 동작: 1~2시간 여러 종목을 선택하며 차트 조회. 로그에는 22:00 일일 배치의
  자동 수집 시작, 이후 GC 지연과 WebSocket 전송 지연도 있다. 이는 동시 발생 기록이며
  자동 수집이 OOM의 원인이라는 증명은 아니다.

## 실행한 측정

| 측정 | 결과 | 해석 |
| --- | --- | --- |
| 실제 저장 캔들 1,001회 조회 | 첫 조회 201.6MiB, 종료 약 203MiB | 이 입력·경로에서는 지속 증가를 재현하지 못함 |
| 삼성전자·SK하이닉스·KODEX200의 25일 자료, candles/hoga/sidecar 순회 | sidecar 전 약 345MiB → 삼성전자 후 2,987MiB → SK하이닉스 후 3,848MiB | 첫 보조지표 계산의 높은 RSS는 재현됨 |
| 삼성전자 25일 sidecar 동일 요청 3회 | 3,138 → 3,130 → 3,130MiB | 같은 요청의 반복 누적은 아님 |
| 위 요청 뒤 GC | 약 3,130MiB 유지 | Python 순환 참조 회수만으로 감소하지 않음 |
| 위 요청 뒤 malloc trim 및 Arrow 반환, 지표 캐시 제거 | 약 2,809MiB 잔류 | 조사한 Python 캐시만으로 전체 RSS를 설명할 수 없음. 구체적인 native 할당 주체는 미확정 |
| 별도 프로세스에서 Polars 스레드만 32→4 | 반복 후 약 2,348MiB | 단일 A/B 탐색 결과. 사고 해결이나 최적 설정으로 검증한 것은 아님 |
| HogaplayClient에 114KB 모의 응답 40,000회 | 샘플 약 67~697MiB 사이 순환, 끝 612MiB → 명시적 GC 후 45MiB | 임시 응답의 회수 지연은 있으나 이 실험에서 69GiB 증가나 무한 누적은 미재현 |

보조지표 실험은 20260820~20260923 중 실제 저장된 25일 자료를 사용했다.
DuckDB는 512MiB/2스레드로 고정했다. 이 한도보다 RSS가 훨씬 컸다는 사실은
**DuckDB 한도가 서버 전체의 메모리 상한은 아니라는 것**을 보여준다.
진단 프로세스는 임시 폴더에 원본 parquet을 링크하고 파생 캐시는 그 임시 폴더에 썼다.
실제 서버나 원본 수집 데이터는 수정하지 않았다.

모의 응답 실험은 실제 네트워크·TLS·10개 수집기의 동시 실행·파일 저장·WebSocket을
포함하지 않으므로 수집 경로 전체가 무해하다고 결론낼 수 없다.
첫 탐색 스크립트의 512MiB 예산 assertion 실패는 OOM 재현 테스트 실패가 아니다.
`evidence/range.jsonl`, `evidence/client_long.jsonl`에 원래 탐색 결과를 그대로 보존했다.
반복 가능한 harness에서는 그 임의 예산 assertion을 제거했다.

## 현재 서버와 코드상 확인점

재시작한 서버 PID 149355의 조사 초기 RSS는 약 2.5GiB였다. 계산 자식 3개는 각각
약 6.7/9.7/10.9GiB였다. 조사 후 스냅샷은 `evidence/current_processes.json`에 있다.
이 서버는 사용자의 기존 서버이고, 조사 중 재시작·종료하지 않았다.

- `hoga/api/compute_pools.py`: 기본 wide 3개/narrow 2개, 워커 DuckDB 상한 2GiB.
- `hoga/compute_executor.py`: 풀 워커는 재사용되며, RSS 기반 재시작/프로세스 전체의
  메모리 한도는 이 실행기에 없다. 이것 자체가 누수 증거는 아니다.
- `hoga/gc_tuning.py`: GC 임계를 50,000/50/50으로 높인다. 모의 수집 응답 실험에서
  회수 지연을 관측했지만, 이 설정이 실제 사고의 원인인지는 미확정이다.
- `hoga/api/scheduler.py`: 22시에 유지보수 뒤 일일 수집을 시작한다.

## 재실행

저장소 루트에서, 실제 저장 데이터가 있는 이 머신의 가상환경으로 실행한다.
각 harness는 별도 프로세스에서 끝나며 서버를 띄우거나 외부 벤더에 요청하지 않는다.
range 실험은 추가 RAM 수GiB를 사용하므로 여유 메모리가 있을 때 실행한다.

```sh
.venv/bin/python docs/diagnostics/2026-09-29-memory/harnesses/probe_candles.py
.venv/bin/python docs/diagnostics/2026-09-29-memory/harnesses/probe_range_retention.py
POLARS_MAX_THREADS=4 .venv/bin/python docs/diagnostics/2026-09-29-memory/harnesses/probe_range_retention.py
.venv/bin/python docs/diagnostics/2026-09-29-memory/harnesses/probe_client_long.py
```

## 아직 필요한 증거

기존 로그에는 사고 직전의 힙/할당 스택 또는 시계열 RSS가 없다. 종료된 프로세스의
메모리를 사후 복원할 수 없고, 현재 프로세스에 대한 py-spy 읽기도 OS ptrace 정책으로
거부됐다. 설정을 변경하거나 권한을 올려 우회하지 않았다.

정확한 원인 확정에는 별도 재현 서버에서 종목 전환과 일일 수집을 각각 실행하고,
본체/워커별 RSS와 Python/native 할당을 동시에 기록해 69GiB 증가 경로를 잡아야 한다.
실사용 서버의 재시작·수집 작업 재실행·설정 변경은 이번 조사에서 수행하지 않았다.
원인이 확정되지 않았으므로 동작 코드 수정과 수정 완료 주장을 하지 않는다.
