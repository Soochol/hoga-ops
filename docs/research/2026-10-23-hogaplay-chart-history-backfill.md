# 호가플레이 분봉 500행 제한 수정과 히트맵 과거 데이터 보충

## 문제와 수정

장후 `chart.php`를 한 번 요청하면 최근 최대 500개 분봉만 반환된다. 삼성전자
2026-10-22의 20:01 요청은 11:17~20:00의 500행이었으나, 11:17을 기준으로 다시
요청하면 오전 원본이 나온다. 이전 수집기는 한 번만 조회해 오전을 누락했다.

`hoga/collector/chart.py::fetch_full_chart`는 500행 응답이면 가장 이른 분봉의
시작 시각으로 추가 조회한다. 짧은 응답 또는 빈 응답까지 역방향으로 조회하고,
동일 타임스탬프는 최초 요청의 원문 행을 보존해 중복 제거한다. 원본 컬럼 0의
자정 기준 선형 ms를 요청의 HHMMSSmmm로 변환하며 원시 정수끼리 빼지 않는다.
정체 응답·잘못된 날짜 내 시각·8페이지 초과는 실패로 처리한다.

수집기는 전체 분봉을 받은 뒤에만 `chart.tsv`와 완료 표식을 기록한다. 추가 조회도
기존 수집 취소·요청 간 대기·HTTP 타이밍 집계를 따른다. 이전 시간대 요청이 실패하면
기존 `chart.tsv`를 덮어쓰지 않는다. 짧은 단일 응답의 기존 파서 계약은 유지한다.

## 운영 보충 결과

사용자가 요청한 현재 히트맵 **331개 고유 종목**, 날짜 **20261021·20261022**를
기준으로 조사했다. 기존 hogaplay 저장본 636건 중 500행이던 320건이 대상이었다.

| 날짜 | 보충한 Stock-Date | 추가 분봉 | 변경 불필요 |
| --- | ---: | ---: | ---: |
| 2026-10-21 | 142 | 10,300 | 1 |
| 2026-10-22 | 176 | 14,361 | 1 |
| 합계 | 318 | 24,661 | 2 |

변경 불필요한 두 건은 `047810/20261021`, `039030/20261022`다. 둘 다 09:00부터
시작하는 정확히 500행의 전체 응답이고 추가로 받을 이전 분봉은 없었다.
오류는 0건이다.

그 밖의 316건은 500행 미만이었다. 그중 09:00 이후 시작하는 4건과 빈 분봉 4건도
직접 재조회했으며, 업스트림 시작 시각·행 수가 저장본과 같아 추가 원본이 없었다.
기존 hogaplay 저장본 자체가 없는 **13종목 × 2일 = 26건**은 캡처를 새로 만든 것처럼
표시하지 않고 보충 대상에서 제외했다. 이번 작업은 기존 분봉의 선행 누락 보충이다.

삼성전자 저장 결과:

- 10월 21일: 500 → **635행**, **09:00~19:59**.
- 10월 22일: 500 → **639행**, **08:30~20:00**.

운영 서버 `127.0.0.1:8000`의 `/api/range`를 `mode=candles`,
`source_pref=hogaplay`, `venue=KRX`, `bucket_ms=60000`으로 각각 조회해 위 행 수와
시각 범위를 확인했다(둘 다 HTTP 200). 서버 재시작은 하지 않았다.

## 데이터 보존과 검증

`hoga/collector/chart_backfill.py::repair_chart`는 기존 분봉보다 이른 행만 추가한다.
원본 TSV와 Parquet를 함께 갱신하고 마지막에 메타 mtime을 갱신해 인벤토리 캐시를
무효화한다. 기존 원본이 prune된 날은 새 응답이 기존 Parquet OHLCV를 정확히
재현하는지 확인한다. 기존 분봉 값·수집 완료/부분 여부·캡처 횟수는 보존한다.

갱신 전 원본 TSV·Parquet·meta를 백업하고, 병행 변경을 검사한다. 저장 실패 시
원본 파일로 복원한다. 큐에 대상 날짜가 대기 중이면 작업을 진행하지 않는다.

운영 반영 후 318건 전체에서 다음을 확인했다.

- 기존 모든 분봉 값이 동일하며 추가 행은 기존 시작보다 앞이다.
- 타임스탬프 중복이 없고 raw TSV와 Parquet의 분봉 값이 일치한다.
- 수집 완료·부분 여부·Full Capture Count·Identical Capture Count와 DiskState가 같다.
- 호가·체결·거래원 Parquet와 남아 있던 `info.tsv`, `_progress.json`의 SHA-256이 같다.

백업·응답 원문·종목별 결과·전수 검증·검사 입력 지문은 다음 디렉터리에 보존했다.

`/home/dev/.local/share/hoga-ops/backups/chart-history-20261023-da44/`

- `plan.json`, `results.json`, `verification.json`, `validation-inputs.json`
- `files/<date>/<code>/`: 변경 전 파일과 체크섬 명세
- `downloads/<date>/<code>.tsv`: 조회한 전체 분봉 원문
- `uncapped-checks.json`, `uncapped-probes/`: 짧은 응답 8건의 추가 확인

재사용 가능한 실행기는 `scripts/backfill_hogaplay_chart_history.py`다. 기본은
네트워크 호출·변경 없는 계획 확인이며 `--apply`일 때만 조회하고 보충한다.
이번 운영 실행 명령:

```sh
uv run --frozen python scripts/backfill_hogaplay_chart_history.py --dates 20261021 20261022 --env-file /home/dev/code/hoga-ops/.env --output-dir /home/dev/.local/share/hoga-ops/backups/chart-history-20261023-da44 --apply
```

## 코드 검증과 적용 범위

HEAD/base/origin/main: `745fbd5d223890008c2ac81c79e9bfb3d1ac0bdd`.
Python 3.14.7, 워크트리 전용 `.venv`, 빈 `.env`, frozen `uv.lock` 환경이다.
검사 시 소스·테스트·의존성 및 설정의 SHA-256과 도구 버전은 `validation-inputs.json`에 있다.

```sh
uv run --frozen --extra dev ruff check .
uv run --frozen --extra dev pytest -q tests/collector tests/test_collector_orchestrator.py tests/test_collector_client.py tests/test_collector_progress_callback.py tests/test_collector_progress_finished.py tests/test_parser_e2e.py tests/test_parser_completeness.py tests/test_parser_frames_oracle.py tests/test_tables_candles.py tests/unit/live/test_krx_aftermarket.py tests/unit/live/test_meta_backfill.py tests/test_api_eligibility.py tests/hoga/api/test_invariants.py tests/hoga/api/test_series_invariants.py tests/test_api_disk_state.py -m 'not wallclock'
git diff --check
```

결과: **379 passed, 1 skipped**, Ruff 위반 0건, diff 공백 검사 통과.
신규 17개 테스트는 전체 분봉 수집·중복 제거·시간 인코딩·정체/잘못된 응답 실패·
수집기 연결·추가 조회 실패 시 보존·부분 데이터 상태 보존·멱등·쓰기 실패 복원을 다룬다.

**과거 데이터 보충은 운영 저장소에 반영됐다.** 위 보충은 작업 워크트리의 실행기로
수행했으며 서버를 재시작하지 않았다. 향후 자동 수집에는 이 수집기 변경이 반영된
코드를 사용해야 한다.
