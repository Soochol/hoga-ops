# 0089 — 라이브 테스트 싱글턴 리셋은 conftest 하나로, 단 test-specific fixture는 통합하지 않는다

**Status:** accepted (2026-07-07)

**Related:**
- ADR-0064 — 정직 health 패턴(리셋의 태스크 취소 규율과 동형)
- ADR-0082 — KIS Capacity Scheduler(자체 autouse 정리 소유)

## Context

`tests/unit/live/`의 14개 파일이 각자 싱글턴 리셋을 관리하고 있었다 — 7개는
autouse fixture, 나머지는 인라인 수동 호출(`test_lifecycle.py` 34회,
`test_lifecycle_rest_poller.py` 14회). "리셋을 잊으면 테스트 오염"이라는 test-
hostility 클래스가 잠재했다.

조사로 두 가지가 드러났다:

1. **리셋 표면은 이미 잘 팩터되어 있다.** `lifecycle.reset_for_tests()`는 포괄적
   캐스케이드다: in-flight WS/flush/recorder/collector 태스크 취소 → `_state`/
   `_buffer` 리셋 → `_today_promote_last_ms` 클리어 → `kis_runtime.reset_for_tests()`
   (→ `account_health.reset_for_tests()`). `kis_capacity_runtime._schedulers`는
   `test_kis_capacity_runtime.py`의 autouse `_close_schedulers`가 이미 정리한다.

2. **"중복"의 대부분은 중복이 아니다.** autouse fixture 7개 중 순수 리셋 중복은
   **3개**(`lifecycle.reset_for_tests()`를 동일 복제한 kis_singleton /
   lifecycle_dynamic_n / live_session_characterization)뿐이다. 나머지는 test-
   specific setup이다: `_hermetic_kis_env`(KIS env 격리 — 스케줄러가 ambient env로
   계좌 수를 읽으므로 필수), `_ranking_cache` 클리어(도메인 캐시), `account_health.
   _ws_probe` monkeypatch(probe 미등록 시작).

## Decision

1. **`tests/unit/live/conftest.py`에 단일 autouse fixture `_reset_live_singletons`**
   를 신설해 `lifecycle.reset_for_tests()`를 각 테스트 전후로 호출한다. 이는
   현재·미래의 모든 라이브 테스트에 baseline 격리를 보장해 "리셋 잊음" 클래스를
   구조적으로 닫는다.

2. **정확히 중복인 3개 per-file `_reset` fixture만 제거**한다(conftest가 대체).

3. **test-specific fixture는 통합하지 않는다.** `_hermetic_kis_env` /
   `_ranking_cache` / `_ws_probe` monkeypatch는 리셋 보일러플레이트가 아니라 각
   파일 고유 setup이므로 그 자리에 남긴다. 인라인 수동 리셋(특히 mid-test 리셋)도
   건드리지 않는다 — conftest가 setup-time 리셋을 대체하므로 redundant하지만 무해
   하고, mid-test 리셋은 여전히 필요하다.

## Why 전면 통합을 하지 않나

- **test-specific fixture를 conftest로 끌어올리면 잘못된다.** env 격리는 계좌
   기반 테스트에만, 캐시 클리어는 rankings 테스트에만, `_ws_probe` 미등록은
   account_health 테스트에만 옳다. 전역화하면 무관한 테스트에 부작용을 주거나
   어느 테스트가 무엇을 필요로 하는지 가려진다.
- **인라인 수동 리셋 34+14건을 일괄 삭제하면 위험하다.** 그중 일부는 mid-test
   phase 리셋이라 setup-time conftest로 대체 불가다. 순수 setup 리셋과 구별하려면
   파일별 정독이 필요한데, 그 churn/위험 대비 이득(무해한 redundant 호출 제거)이
   낮다.
- **전면 DI 재설계는 범위 밖.** 모듈 전역 싱글턴을 조립 루트로 옮기는 것은 단일
   프로세스·단일 사용자 로컬 도구에서 blast radius 대비 이득이 제한적이라 보류한다.

## Consequences

- 새 라이브 테스트는 리셋을 잊어도 오염되지 않는다(conftest가 보장).
- test-specific setup의 소유권이 명확해진다(그 자리에 남음).
- 미래 리뷰가 "이 리셋 fixture들 다 conftest로 합쳐라"를 재제안하면 본 ADR이
   답변이다 — 3개만 순수 중복이었고 나머지는 의도된 test-specific이다.
