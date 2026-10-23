# 2026-10-23 호가플레이 수집 정체와 close=0 파서 오류

## 확인한 원인

이수페타시스(`007660`, Stock-Date `20261023`)의 원본을 격리된 디렉터리로 복사해
파싱하면 사용자 화면의 오류가 숫자까지 동일하게 재현된다.

```text
parse_stock_date → _build_meta → krx_continuous_windows → unix_ms_to_hhmmssms
ValueError: Unix ms 1792680600000 is not within Stock-Date 20261023
```

원본 `info.tsv`의 `regular_session_open_ms`는 `90000000`,
`regular_session_close_ms`는 `0`이다. 파서가 메타데이터를 구성하면서 정규장 종료
시각에서 동시호가 10분을 빼므로, 당일 자정에서 10분 전인 **10월 22일 23:50 KST**가
만들어진다. 날짜 검증이 이 값을 거절하면서 `meta.json` 기록 전에 실패한다.
이 전날 시각은 앱의 계산 결과다.

## 원본과 실행 기록

운영 데이터 기준 경로: `/home/dev/.local/share/hoga-ops/data`.

- `raw/20261023/007660/_progress.json`: 시작 `22:06:21.070087+09:00`, 종료
  `22:07:22.244796+09:00`, 313 Pages, 3,228 unique events,
  `finished=false`, `abort_reason=stagnation_abort`.
- 113번째 Page의 최대 이벤트 시각은 `90843215`(09:08:43.215)다. 이후 200 Pages에서
  새 이벤트가 없고 최대 시각도 진행하지 않아 기존 정체 가드가 수집을 중단했다.
  312·313번째 Page는 SHA-256이 동일하다.
- `chart.tsv`는 09:00~09:08의 분봉 9개뿐이다.
- `timing/20261023/007660.json`: 실행 코드 `745fbd5d2`, 총 61,565.81ms,
  HTTP 8,702.22ms, 파싱 374.81ms. 페이지 오류 집계는 비어 있다.
- `~/.local/share/hoga-ops/logs/hoga.log`와 서버 관리자
  `~/.config/ticklane-server/logs/server.log`에는
  해당 ValueError 원문이 기록돼 있지 않았다. 당시 워커의 일반 예외 처리는
  화면으로 오류를 전달하지만 스택을 로그로 남기지 않는다. 원본 재실행으로
  실패 스택을 확보했다.
- 조사 시점의 `raw/20261023/*/info.tsv` 84건 모두 종료 시각 `0`이고,
  마지막 이벤트 시각이 09:08:04.045~09:08:51.165에 몰려 있다.

이는 호가플레이가 오전 중 수집을 멈춘 상태와 부합한다. **서버가 2~3일 중단됐는지,
서버 내부의 어떤 장애였는지는 로컬 자료로 확정할 수 없다.** 저장된 10월 22일
337건은 종료 시각이 0인 건이 없으며, 마지막 이벤트 시각은 16:00~20:00대다.

원본 SHA-256:

| 파일 (`raw/20261023/007660/`) | SHA-256 |
| --- | --- |
| `info.tsv` | `7881a9a5c32b9836b17999f63ca970bf2e7dc5645329a7bfc577048e13d975f2` |
| `_progress.json` | `ceb52447d2fd7fff2368d6f703193e7a1110f5c6eb69b0cf693647039aed8488` |
| `chart.tsv` | `2d266d7bb4c37508b5a7d3cffca802becbdf52bf98e5a555a1e9a6cefd0b85ee` |
| `first_00312.tsv`, `first_00313.tsv` | `b8b7ce5dbe480c897227609ebe23d44f6b227889500f08966845a578d9f4c6d8` |

## 수정과 검증

`krx_continuous_windows`는 동시호가 시작이 조회 시작보다 뒤일 때만 정규장
연속거래 구간을 인코딩한다. 종료 시각을 알 수 없는 원본에는 정규장 구간을
만들지 않는다. 독립적으로 확정된 저녁 구간은 기존 규칙대로 유지한다.
원본 종료 시각을 15:30으로 대체하지 않는다(ADR-0130).

- 신규 회귀 테스트 5개는 수정 전 동일 ValueError로 실패하고 수정 후 통과했다.
  장후 대상·비대상·미확인 세 경우의 파서 메타 저장과 `INVALID` 분류를 검증한다.
- 이수페타시스의 실제 313 Pages 전체를 복사해 strict 파싱에 성공했다.
- 영향 원본 84건 전체를 임시 디렉터리에 복사해 strict 파싱한 결과 예외 0건,
  `INVALID` 84건이다. 모든 건에서 종료 시각 `0`, `collection_complete=false`,
  `is_partial=true`가 보존됐다. 각 원본 파일은 전후 SHA-256 일치도 확인했다.
- 실제 운영 데이터와 실행 중인 서버는 변경하지 않았다. 수정은 이 워크트리에 있다.

검증 기준: HEAD/base/origin/main 모두 `745fbd5d223890008c2ac81c79e9bfb3d1ac0bdd`
(`git fetch origin main` 확인). Python 3.14.7, pytest 9.0.3, Ruff 0.15.13,
워크트리 전용 `.venv`, 빈 `.env`, `uv sync --frozen --extra dev` 환경.

```sh
uv run --frozen --extra dev ruff check .
uv run --frozen --extra dev pytest -q tests/unit/live/test_krx_aftermarket.py tests/test_parser_completeness.py tests/test_parser_e2e.py tests/test_parser_info_row.py tests/test_parser_frames_oracle.py tests/unit/live/test_meta_backfill.py tests/unit/live/test_meta_backfill_recovery.py tests/test_api_eligibility.py tests/test_collector_orchestrator.py tests/test_page_step.py tests/hoga/api/test_invariants.py tests/test_api_disk_state.py -m 'not wallclock'
```

결과: Ruff 위반 0건, **330 passed, 1 skipped**(기존 parser oracle 선택 테스트).
검증 입력 SHA-256:

| 입력 | SHA-256 |
| --- | --- |
| `hoga/live/stock_sessions.py` | `77e053090aa11dbbf1c994f6bd9a3a563a9403b99751120411c21468a078a4c8` |
| `tests/test_parser_completeness.py` | `991dabf434dd56495f3e7eaf4cf97ad92d1508856b94e4c30fcdafa732d38a50` |
| `tests/unit/live/test_krx_aftermarket.py` | `ce33fee121d6a7d753ddcd37e5582b4a48cf1f9d9e643a7abe1400803bf882a8` |
| `pyproject.toml` | `9ebb8f119bb60eca2cb968c978802b6c8ad3238d13827dd0929e697660c24dd2` |
| `uv.lock` | `b6704bb6abd785df4c1898f776d837a9e5defd547a99d2c8dede66d758ed3893` |
| `ruff.toml` | `422277b5742ea124f25690201cb540117de803f74719052a6dbdc3bfa8aa7d07` |

변경 영향이 같은 범위인 이후 작업에서만 이 결과를 재사용할 수 있다.

## 후속 확인: 삼성전자 2026-10-22

사용자 요청으로 삼성전자(`005930`)의 전일 저장본과 호가플레이의 현재 응답을
직접 대조했다. 수집 큐를 재실행하거나 운영 저장본을 덮어쓰지 않았다.

- 저장본: 10월 22일 22:01:26~22:08:55 수집, 2,070 Pages, unique events 318,499건,
  `finished=true`, `collection_complete=true`, `is_partial=false`, `gap_ranges=[]`.
  메타 분류는 `COMPLETE`, invariant 위반은 없다.
- 호가 157,510행(08:50:00.635~20:00:00.621), 체결 158,921행
  (08:30:01.101~20:00:00.016)이 저장돼 있다.
- 현재 `info.php` 재조회는 저장 원문과 SHA-256이 같다
  (`a243e3882e3652cb24f7a0cfa39a50298ca4412f69a222e8dc374937c3484818`).
  정규장 종료 시각은 `153000000`, 원본 마지막 이벤트 시각은 `200003282`다.
- `first.php`를 09:00, 15:00, 19:50으로 각각 직접 조회해 해당 시각의 이벤트를
  받았다. 오늘 원본의 09:08 중단/종료 시각 0 현상은 전일 삼성전자에서 관측되지 않았다.

별도로 **분봉 한 번 조회의 범위 제한**을 발견했다. 20:01로 요청한 `chart.php`는
500행(11:17~20:00)만 반환하고, 운영 저장본 `chart.tsv`와 바이트가 같다.
15:31로 요청하면 383행(08:30~15:30), 09:30으로 요청하면 32행(08:30~09:29)을
반환하므로 오전 분봉 원본도 서버에 남아 있다. 현재 수집기는 장후에 `chart.php`를
한 번만 호출하므로, 전일 저장 분봉의 오전 부분은 별도 누락이다. 위 `COMPLETE`는
기존 호가 기반 판정이며 분봉 전 시간대 보유를 보증하지 않는다. 이 후속 조회에서는
이 별도 수집기 문제를 수정하거나 운영 분봉을 재작성하지 않았다.

이후 사용자의 추가 요청으로 분봉 수집기를 수정하고 운영 데이터를 보충했다.
결과는 [분봉 보충 기록](2026-10-23-hogaplay-chart-history-backfill.md)에 있다.
