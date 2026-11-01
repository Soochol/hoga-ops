# 일봉 스냅샷 재사용 검증

2026-11-02 KST. 기준 main `1f80f553801c6d39f16867efab82e94606a263da`.

## 성능

`tools/measure_screener_snapshot_reuse.py`에 운영의 같은 고정 스냅샷·350종목·장전 시각을
전달했다. 실제 분봉 REST/WS나 전체 HTTP 응답을 재생한 수치가 아니라 세 일봉 공통
준비 함수만 읽기 전용으로 측정했다. 벤더 호출 0회, 사용자 저장 자료 변경 없음.

```sh
.venv/bin/python tools/measure_screener_snapshot_reuse.py \
  --data-dir /home/dev/.local/share/hoga-ops/data \
  --snapshot 1d82b20eecd2645de7a869730b3beacf6a42a1c1a48716c9389deaa46f3bf307 \
  --as-of 2026-11-02T02:30:00+09:00 --output measurements.json
```

최종 코드의 첫 준비 **119.431초 / 객체 읽기 1,402회**에서, 동일 입력 3회 재조회 중앙값
**0.01236초 / 객체 읽기 0회**로 줄었다. 모든 반환 일봉 자료·확정 시각·메타데이터는
동일했다. 캐시 3항목의 직렬화/예약 바이트는 524,499이다. [측정 원본](measurements.json).
변경 전 API 미사용 프로파일링의 108.242초는 계측 조건이 다르므로 위 수치와 별도로 본다.
재조회 비교는 같은 최종 코드에서 처음 준비한 경우와 캐시가 있는 경우의 비교다.
실제 전체 검색 API 왕복 시간은 배포 후 별도로 확인한다.

## 정확성

- 수정 전 HTTP 재조회 검사 2개가 독립 확인 표본 재검증 4회 → 8회 증가로 실패했다.
- 같은 HTTP 요청의 재조회는 추가 일봉 확인 표본 검증 없이 동일 응답을 반환한다.
- 준비된 캐시를 둔 채 실제 VolumeSource 체결 → IPC 프레임 → replica에 새 체결을
  넣으면 HTTP 결과가 0종목 → 양성 종목으로 바뀌고 거래량 310이 반영된다.
  이때 일봉 검증과 분봉 API 준비를 추가 호출하지 않는다.
- 새 일봉 observation 공개 후에는 새 가격을 읽는다. 코드·날짜·data_dir·manifest
  변경 격리, 행/set/수량 이력의 복사 격리, 동시 요청 준비 합류를 확인했다.
- 파일 교체·삭제·mtime 복원 변조·symlink 변경·준비 중 변경을 검사했다. baseline
  변조도 체크섬 오류로 거부하며 실패는 캐시하지 않는다. LRU/바이트 상한·과대 항목
  우회·초기화 도중 이전 준비의 재삽입 방지도 확인했다.

## 검사 결과와 재사용

- `.venv/bin/ruff check .`, `git diff --check`: 통과.
- `.venv/bin/pytest -q -m 'not wallclock'`: 1차 전체 검사 **8,212 passed, 2 failed,
  2 skipped, 13 deselected**, 345.79초. 주문 테스트
  `test_preopen_exact_wire_dedup_terms_modify_rejection_and_cancel[BUY/SELL]`의
  `test_broker_trading.py:845` StopIteration이다. 원본 main을 임시 경로에 git archive로
  풀고 같은 venv·빈 .env로 검사한 결과도 **동일 2개 실패**, 0.33초였다.
  이 변경은 주문 코드/테스트를 바꾸지 않는다.
- 전체 검사 이후 캐시의 파일 교체 감지와 동시 준비 재확인을 보강했다. 이에 영향을
  받는 스크리너 전체와 wire 계약을 최종 입력으로 다시 실행했다:
  `.venv/bin/pytest -q tests/api/test_screener*.py tests/unit/api/test_rest_wire_schema_contract.py -m 'not wallclock'`:
  **1,581 passed**, 65.90초, 기존 Polars 경고 66개. 캐시를 사용하지 않는 나머지
  백엔드 경로는 위 전체 검사 결과를 재사용한다.

wire 모델·프런트 소스·의존성·검증 설정 변경 없음. Python 3.14.7, pytest 9.0.3,
Ruff 0.15.13, 워크트리 전용 .venv와 빈 .env를 사용했다.
최종 main fetch는 위 base와 동일했다. 최종 소스·테스트·픽스처·pyproject.toml·uv.lock·
측정 도구 888개 입력을 경로순 `경로\0내용\0`으로 연결한 SHA-256:
`a5b45a24d06513fe46febda24c2115772232952e4873a4039c2d7f6c789c278a`.
이후 추가하는 문서와 측정 JSON은 검사 입력을 바꾸지 않는다.
