# past-candles 미캐시 날짜 병렬 fetch 설계

- **Date**: 2026-06-08
- **Status**: Implemented (2026-06-08) — 성능 목표(3.3s→~0.7s)는 실서버 콜드 캐시 1회 실측 후 PR 본문에 기록
- **Scope**: `backend` — `hoga/live/api.py`의 `/api/live/past-candles` 핸들러 단일 변경
- **Topic slug**: `past-candles-parallel-fetch`
- **관련 ADR**: [ADR-0040](../../adr/0040-live-candle-backfill-separate-cache.md) (캔들=별도 REST 캐시), [ADR-0050](../../adr/0050-kis-rate-limit-retry-in-client.md) (EGW00201 백오프는 `KisClient._get` 중앙화), [ADR-0038](../../adr/0038-live-jsonl-then-promote.md) (단일 uvicorn 워커 불변식 — 싱글플라이트의 전제)

---

## 1. 문제 / 배경

`/api/live/past-candles`는 미캐시 날짜를 `_date_iter` 순회로 **하나씩 순차** KIS에 다녀온다
(`api.py` 핸들러: 날짜 루프 내 `await kis.fetch_past_minute_candles(code, date_s)`).
콜드 캐시 로드 실측 **3.3초** ≈ 16날짜 × RTT ~200ms — 지연의 지배 요인은 순차 RTT 누적이다.

검토된 대안과 기각 사유:
- **프리워밍(관심종목 추가/장마감 후 백그라운드 캐시 적재)**: 콜드 경로 자체를 없애지만 사용자 결정으로 제외 (2026-06-08).
- **점진 응답(스트리밍/청크)**: API 계약 변경 + 프론트 수정 필요. 한 덩어리 응답 수용.

## 2. 목표 / 비목표

### 목표
- 콜드 캐시 응답 3.3초 → **~0.7초** (16날짜, 동시 5 기준). 250일 풀 백필은 토큰버킷이
  바닥(15콜/초 → ~11.5초)이므로 동시수와 무관 — 작은 범위의 개선이 목적.
- **API 계약·프론트 무변경** — 응답 shape(`code/from/to/candles/cached_dates/fresh_dates/data_warnings`)
  과 필드 의미 동일, 날짜 오름차순 보존.
- 동일 (code, date)의 동시 중복 KIS 콜 제거 (싱글플라이트).

### 비목표
- `/past-daily-candles`·`/past-investor-net` (일봉 계열): 별도 캐시(`PastDailyCandlesCache`,
  date-cursor walk-back) 구조라 형태가 다름 — 필요가 측정되면 별도 설계.
- 프리워밍, 점진 응답 (§1 기각).
- `KisClient`/토큰버킷 변경 — 아래 §3 근거로 변경 불필요.

## 3. 현재 시스템 (코드로 확인된 사실, 2026-06-08)

| 사실 | 근거 |
|---|---|
| 미캐시 날짜 순차 fetch | 핸들러의 `for date_s in _date_iter(frm, too)` 내 `await` |
| 토큰버킷은 동시 호출용으로 설계됨 | `_TokenBucket`(kis_client.py): 용량 15토큰 가득 시작, 15/초 리필, `_lock` 하 토큰 회계 + lock 밖 sleep — "concurrent acquirers see consistent state" |
| EGW00201 재시도는 클라이언트 중앙화 | ADR-0050: `_get` 내부 4시도(1/2/4초). `KisRateLimitError`는 소진 후에만 표면화 |
| 캐시 쓰기 atomic | `store_past` → `atomic_write_json` (temp+rename) — 동시 같은-날짜 쓰기 안전 |
| `kis_blocked` 방어 | 레이트리밋 소진 시 잔여 날짜 KIS 콜 중단(`rate_limit_aborted` warning), **캐시 히트는 계속 서빙** — 과거 차트 빈 화면 장애의 수정분 |
| today는 별도 의미론 | tri-state TTL 메모리 캐시(`get_today_tri`) — hit/negative/miss |
| 버킷 잔여 사용자 (poller 은퇴 후) | quote 오버레이(30종목/콜, 10초당 1~2콜) + 캔들 60초 폴링 — 합계 ~0.2콜/초, 여유 큼 |
| 단일 uvicorn 워커 | ADR-0038 — in-process 싱글플라이트로 충분 |

## 4. 설계 결정

### 4.1 동시수 = 5 (`_PAST_CANDLES_CONCURRENCY`)

산식: RTT ~200ms → 슬롯당 ~5콜/초 → **3슬롯이 15콜/초 버킷 포화점**, RTT 변동 흡수 여유 +2.
6 이상은 처리량 무이득(버킷이 천장)이고 EGW00201 시 동시 재시도 증폭만 커진다(최악 동시수×4시도,
버킷이 페이싱하므로 치명적이진 않음). 운용 규칙: 로그에 `kis_rate_limit`/`rate_limit_aborted`가
보이면 3으로 하향. **8 초과 금지** — 버킷 가득 시작이라 첫 순간 15콜 버스트 가능, KIS 통상
한도(인용 기준 20/초) 대비 여유 25%를 보존한다.

### 4.2 핸들러 2-패스 구조

```
1차 패스(동기): _date_iter 순회
   ├─ 과거 날짜 캐시 히트 → 즉시 수집 (cached_dates)
   ├─ 과거 날짜 캐시 미스 → fetch 대기열 적재
   └─ today               → 기존 tri-state 경로 그대로 (병렬화 제외)
2차 패스(병렬): 대기열을 asyncio.Semaphore(5) + gather
   └─ 날짜별 task: 싱글플라이트 → kis_blocked 확인 → fetch → store_past
3차: 날짜 오름차순 재조립 — candles/fresh_dates/warnings 모두 날짜순
     (gather는 입력 순서를 보존하므로 입력을 날짜순으로 만들면 자연 성립)
```

today를 병렬화에서 제외하는 이유: 과거 날짜와 캐시 의미론(영속 vs TTL·negative)이 달라
경로를 섞으면 분기가 복잡해지고, today는 최대 1콜이라 병렬화 이득이 없다.

### 4.3 싱글플라이트 — 프로세스 수준 단일 `dict[(code, date), asyncio.Future]` (배치는 §7)

- 목적: 두 브라우저 탭·60초 refetch 경합 시 같은 날짜 중복 KIS 콜 방지 (**쿼터 절약**이 목적 —
  파일 안전성은 atomic write가 이미 보장).
- 후발 요청은 기존 Future를 await. task 완료/실패 시 dict에서 반드시 제거(finally).
  실패는 공유자 전원에게 동일 예외 전파 — 각 요청의 기존 except 분기가 각자 warning을 만든다.
- ADR-0038 단일 워커라 프로세스 간 조정 불필요.

### 4.4 `kis_blocked` 의미론 번역 (기존 방어 보존 — 이 설계의 유일한 실수 포인트)

| | 기존 (순차) | 병렬 번역 |
|---|---|---|
| `KisRateLimitError` 발생 | 해당 날짜 `kis_rate_limit` warning + 이후 날짜 전부 스킵(`rate_limit_aborted`) | 동일 warning + `asyncio.Event` set → **미시작** task는 세마포어 획득 전에 Event 확인 후 스킵+`rate_limit_aborted`; **in-flight는 완주**(이미 나간 요청은 회수 불가, 결과는 사용) |
| 캐시 히트 서빙 | 유지 (차트 빈 화면 방지) | 1차 패스에서 이미 수집 — 구조적으로 동일 보장 |

### 4.5 에러 의미론 (기존 분기 보존)

- `KisRateLimitError` → §4.4. ADR-0050에 따라 4시도 소진 후에만 도달.
- `KisApiError` → 해당 날짜 `kis_api_error` warning(msg_cd), 다른 날짜는 계속 — 병렬 task의
  예외를 날짜별로 격리해 동일 분기로 라우팅.
- `OSError`(캐시 쓰기 실패) → `cache_write_failed` warning, 받은 bars는 메모리로 서빙 (기존 동일).
- `KisAuthError` 등 그 외 → 기존처럼 핸들러 밖으로 전파 (변경 없음). gather 사용 시
  `return_exceptions` 처리에서 이 클래스만 재-raise 되도록 주의.

## 5. 테스트 전략 (TDD — 각각 RED 먼저)

1. **동시성 상한**: fake `fetch_past_minute_candles`가 in-flight 카운터 기록 → 최대 ≤ 5.
2. **싱글플라이트**: 같은 (code, date) 동시 요청 2건 → fetch 1회, 두 응답 모두 동일 bars.
3. **`kis_blocked` 번역**: 중간 날짜 `KisRateLimitError` → 미시작분 `rate_limit_aborted`
   warning + 캐시 히트 날짜는 정상 서빙 (기존 장애 방어 회귀 테스트).
4. **응답 순서**: 완료 순서를 의도적으로 뒤섞는 fake(빠른 날짜를 늦게 응답) → `candles`
   날짜 오름차순 + `fresh_dates`/`data_warnings` 날짜순.
5. **불변 경로**: today tri-state·캐시-히트-only — 기존 테스트 그린 유지.

타이밍(sleep 측정) 기반 테스트는 flaky라 배제 — 동시 카운터 단언으로 대체. 성능 수치(3.3→0.7초)는
구현 후 실서버에서 1회 실측해 PR 본문에 기록한다.

## 6. 수용한 트레이드오프

- **한 덩어리 응답 유지**: 점진 표시 없음 — 콜드 로드가 ~0.7초로 줄어 수용.
- **in-flight 완주**: 레이트리밋 순간 이미 나간 ≤5건은 중단하지 않음 — 회수 불가한 요청이고,
  결과를 버리는 것이 오히려 낭비.
- **250일 풀 백필 ~11.5초**: 토큰버킷 바닥 — 본 설계 범위에서 개선 불가(설계상 한계로 명시).

## 7. plan 단계에서 확정할 것

- 싱글플라이트 dict의 모듈 배치(`api.py` 모듈 수준 vs `past_candles_cache.py`) — 핸들러 팩토리
  (`build_router`) 구조상 클로저/모듈 중 어느 쪽이 테스트 주입에 유리한지 확인 후 결정.
- 기존 api 테스트 파일 위치·픽스처 파악 (`tests/unit/live/test_api.py` 외 past-candles 전용
  테스트 존재 여부) — 신규 테스트의 거처 결정.
