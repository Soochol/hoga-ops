# 2026-09-07 조사용 harness

실제 실행한 스크립트를 변경 없이 `diagnostics.zip`에 보존했다. 정식 테스트나 범용 벤치마크 도구가 아니다.
워크트리 `c32ed4e2b`, Python 환경 `/home/dev/code/hoga-ops/.venv/bin/python`,
원본 데이터 `/home/dev/.local/share/hoga-ops/data`를 사용했다.
날짜·종목·경로·결과 출력 경로(`/tmp/minute-followup-5056-*.json`)가 고정되어 있다.

압축을 임시 디렉터리에 푼 뒤 저장소 루트에서 실행한다:

```bash
unzip docs/research/2026-09-07-live-minute-followup-evidence/harnesses/diagnostics.zip \
  -d /tmp/minute-followup-harnesses
PYTHONPATH="$PWD" /home/dev/code/hoga-ops/.venv/bin/python \
  /tmp/minute-followup-harnesses/split.py
```

| 파일 | 입력/범위 |
|---|---|
| transport.py | 실제 키움 API, 기존 캐시 토큰, 격리 scheduler 1 worker / rate 1/s. 수정계수·과거·오늘 수집 및 HTTP trace. |
| chunks.py | 실제 키움 분봉 API 4콜. body chunk 시각과 로컬 TCP_INFO 기록. |
| tcp-info-offsets.c | 로컬 Linux 헤더에서 TCP_INFO 필드 offset 확인. |
| today.py | vendor 응답과 오늘 봉을 모의 입력으로 제공. 실제 collect_minute의 응답 및 호출 수 비교. 외부 API 호출 없음. |
| split.py | 실제 과거 parquet, 임시 결과 캐시, 캔들 대기 1.4초 모의. 3종목 기존/분리 builder 비교. |
| split-edge.py | 오늘 parquet 고정 복사, 과거 결측, venue/가격 범위 조건 12개. 결과 동일성 전용. |
| compute.py | 실제 하루 parquet의 함수별 cold/warm 계산 계측. |
| unpivot.py | 실제 하루 parquet, SQL 변환 wrapper 후보 비교. 일부 순서 차이는 결과에 기록. |
| cache.py | 실제 과거 5일 parquet, 임시 결과 캐시를 유지한 새 엔진/같은 엔진 비교. |
| payload.py | 기존 localhost:8000 서버 조회. 응답 헤더·본문 읽기·Python JSON 파싱 시간. |

`transport.py`와 `chunks.py`는 재실행 시 실제 API 요청을 한다. 기존 캐시 토큰을 읽기만 하고
발급·갱신·무효화하지 않는다. 토큰이 만료되면 재발급하는 fallback도 없다.
기록은 시간·행 수·바이트 수·TCP 통계이며 토큰과 외부 API 응답 원문을 저장하지 않는다.

원본 live 데이터는 계속 바뀌므로 재실행 결과는 고정 fixture와 같지 않을 수 있다.
페이싱·샘플 수·캐시 조건과 해석 한계는 상위 후속 검증 보고서를 참조한다.
