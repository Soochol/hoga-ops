# 0050 — KIS rate-limit retry는 KisClient._get에 내장한다

**Status:** accepted (2026-05-29)

**Related:**
- ADR-0038 (Live Capture JSONL append + 17:00 Promotion — KIS REST polling 선택)
- ADR-0040 (Live Candle Backfill 별도 cache + 별도 wire)
- ADR-0048 (Live D-direct daily backfill — `_get_past_daily_candles` 의 직접 호출 경로)
- Diagnostic session 2026-05-29 (SKC 클릭 시 "신뢰도 낮은 날짜" 46건 wall 의 진단 및 fix)

## Decision

KIS Open API 의 EGW00201 ("초당 거래건수 초과") 에 대한 지수 backoff 재시도는
**`KisClient._get` 내부**에서 처리한다. backoff 시퀀스는 `(1.0, 2.0, 4.0)` 초,
총 4회 시도 (1 즉시 + 3 retry, 시도 사이에만 sleep). 호출자별 retry wrapper 는
모두 제거한다.

세 가지 invariant 가 ADR 과 함께 새로 생긴다:

1. **Single ingress**: KIS Open API endpoint 를 직접 hit 하는 모든 production
   코드는 `KisClient` 의 메서드를 통과한다. `httpx` 로 KIS endpoint 를 직접
   호출하는 코드는 추가하지 않는다 — convention violation 은 본 ADR 위반.
2. **Centralised retry**: `_get` 은 `KisRateLimitError` 에 대해서만 retry 하고
   `KisAuthError` / `KisApiError` 는 즉시 propagate 한다.
3. **Opt-out via kwarg, not opt-in**: 기본값은 retry on. 진단/probe 호출자가
   raw single-shot 동작이 필요하면 `_get(..., retry=False)` 를 명시.

## Why

### 사고가 만든 결정

2026-05-29 SKC 클릭 시 "신뢰도 낮은 날짜" 46건 wall 이 표면화. 진단 결과:

- KIS server 가 한 번 EGW00201 을 반환 → `_get_past_candles` 가 `kis_blocked=True`
  로 후속 ~45 일 모두 abort, `rate_limit_aborted` warning 누적.
- 같은 KIS client 를 쓰는 `LivePoller._fetch_with_backoff` 는 (1, 2, 4) backoff
  로 자동 복구 — 같은 EGW00201 에 두 caller 가 **정반대로 대응**.

원인은 *코드 비대칭*이지 KIS quota 부족이 아님 — fix 후 동일 75 일 범위가 한 호출에
warning 0 으로 완료됨이 실측됨. 비대칭이 가능했던 이유는 "retry 정책이 호출자별
약속" 이라는 묵시적 구조였기 때문.

### 대안 비교

세 가지 옵션을 검토:

**A. 공유 helper 모듈로 retry 추출, 세 호출자가 import**
- 장점: 동작 변화 zero, 코드 변경 작음.
- 단점: helper 를 import 하지 않는 새 호출자가 추가되면 비대칭 재출현. 사고의
  근본 원인 ("호출자 잊기") 이 그대로 가능.

**B. `KisClient` 메서드 시그니처에 `retry_policy=` 인자**
- 장점: 호출자가 정책을 명시적으로 선택, 합리적 default 제공 가능.
- 단점: discoverable 하지만 enforce 되지 않음 — caller 가 `retry_policy=None` 을
  주면 비대칭 가능. 보일러플레이트.

**C. `KisClient._get` 자체에 retry 내장 (채택)**
- 장점: 단일 진실 원천. 모든 호출이 `_get` 을 통과하므로 호출자가 "잊을 수 있는"
  표면 자체가 없음. 미래 KIS 메서드도 자동 보호.
- 단점: poller 의 hot-path 동작이 미세하게 변함 (gather 전체 retry → per-task
  retry). 토큰 버킷이 acquire 를 직렬화하므로 throughput 영향 없음 — 같거나 더
  나음 (실패한 task 만 retry; 이전엔 성공한 sibling 도 함께 재시도되어 KIS 호출
  3개 낭비).

C 가 사고의 근본 원인을 코드 구조로 제거 — A 는 *convention* 으로만 해결.

## Trade-off accepted

- **호출 latency**: 한 호출이 최악 1+2+4=7s 까지 sleep 추가. Poller 의 한 cycle 이
  `gather(ob, trades, brokers)` 셋 다 rate-limited 면 7s × 1 = 7s (gather 는 가장
  느린 task 기다림). `cycle_seconds=20` 안에 흡수.
- **테스트 contract 이동**: poller 의 retry test 가 client-level test 로 이동.
  poller test 의 의미는 "rate limit 만나면 코드 skip" 으로 단순화 — 의도된 동작.
- **새 module symbol 두 개 (`_RATE_LIMIT_BACKOFF`, `_do_get_once`)**: 후자는
  비공개 헬퍼라 외부 의존 없음. 전자는 테스트가 `_rate_limit_backoff=()` kwarg
  로 주입 — module-level monkeypatch 불필요.

## Why not opt-in (`retry=True` per-call)

옵션 B 와 표면적으로 비슷하지만 실제로는 다름. **default=ON + opt-out=False** 가
**default=OFF + opt-in=True** 보다 사고 방지에 강한 이유:

- 새 KIS 메서드를 추가하는 reviewer 는 retry 옵션을 *적극적으로 제거*하지 않는 한
  retry 를 받는다. 옵션 B 의 default=OFF 는 reviewer 가 *적극적으로 켜야* retry
  를 받음 — 잊을 가능성이 있는 표면.
- 진단/probe 같은 합법적 opt-out 케이스는 명시적으로 표기되어 review 가 의도
  확인 가능 (`retry=False` 가 보이면 "왜 retry off?"가 묻기 쉬움).

## Invariant introduced

- (Invariant-50.1) KIS Open API 의 모든 production 호출은 `KisClient` 메서드를
  통과한다. `httpx.AsyncClient` / `requests` / `httpx.Client` 로 KIS endpoint 를
  직접 호출하는 코드는 추가하지 않는다.
- (Invariant-50.2) `KisClient._get` 은 `KisRateLimitError` 에만 retry 한다.
  `KisAuthError`, `KisApiError`, 그 외 예외는 첫 시도에서 propagate.
- (Invariant-50.3) 각 retry 시도는 `_rate_limiter.acquire` 를 재호출한다 — retry
  burst 가 token 버킷 budget 을 우회하지 않는다.

## Implementation reference

- 코드 상수: [hoga/live/kis_client.py](../../hoga/live/kis_client.py) `_RATE_LIMIT_BACKOFF`
- 코드 구조: `_get` (얇은 retry loop) → `_do_get_once` (실제 acquire+send+unwrap)
- 호출자 정리: [poller.py](../../hoga/live/poller.py) `_fetch_with_backoff`,
  [api.py](../../hoga/live/api.py) `_get_past_candles` / `_get_past_daily_candles`
- 테스트: [test_kis_client.py](../../tests/unit/live/test_kis_client.py) 의
  `test_get_retries_on_*` / `test_get_does_not_retry_on_*` / `test_get_retry_false_*` /
  `test_get_retry_re_acquires_*` 6개 — 본 ADR 의 3개 invariant 를 lock-in.

## Future signal to revisit

다음 신호 중 어느 하나라도 발생하면 본 ADR 재검토:

- KIS 가 새 rate-limit error code 를 추가 (EGW00201 외) — retry 분기 매핑 확장.
- KIS quota 가 크게 변동하여 `_RATE_LIMIT_CALLS_PER_SEC` 가 무의미해짐 — 토큰
  버킷 구조 자체 재검토 (본 ADR 보다는 ADR-0038 영역).
- 한 호출자가 7s 이상의 latency 를 견딜 수 없는 use case 등장 (예: WebSocket
  bridge) — `retry=False` opt-out 으로 시작해보고, 필요시 backoff 시퀀스
  per-method 화.
- KIS 의 EGW00201 이 short-window quota 가 아니라 *penalty box* 로 동작하는
  증거 (60s 대기로도 풀리지 않음) — backoff 만으로 부족, circuit breaker 도입.
