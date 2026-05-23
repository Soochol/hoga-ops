# Capture Fetch Throughput — Page Step·Rate Limit·Drain 3-Lever 튜닝

**Status:** draft (2026-05-23)

## 1. Context

한 Stock-Date 캡처(`hoga.collector.orchestrator.collect_stock_date`)의 wall-clock이 5~10분에 달해 `/capture` 사용자가 답답함을 호소한다. 진단 결과 시간의 대부분은 **`first.php` Page Step 루프**가 차지하며, HTTP 인프라(httpx keep-alive)는 이미 효율적이다.

대한항공(003490) 15건의 실측 baseline:
- 페이지당 평균 ~0.27s (분포 0.246~0.382s) = HTTP fetch ~46~180ms + `rate_limit_s=0.2` sleep (72~81%)
- 정상 캡처 페이지 수 1271~1283 (저활성 종목은 cap-hit이 없어 `DEFAULT_PAGE_STEP_MS=60_000` 천장에 갇힘)
- Wall-clock 분포: 5:12 ~ 8:05 (1개 outlier), 평균 ~5:30
- 가장 최근 측정 (20260430, 토요일 야간 21:00 KST): 5:12 / 1271 pages / 50,917 seqs / 0.246s/page — hogaplay 부하 적은 시간대 측정이라 평일 RTT는 더 클 가능성. Phase 1 매트릭스는 **평일 시간대 실행**으로 외삽 가능성 보장.
- 20260518: 3931 pages, finished=False, 새 seqs/page = 0.4 — **drain 폭주 사례** (`TERMINATION_EMPTY_PAGES=3` 가드 실효 의심)

본 spec은 단일 캡처 wall-clock을 줄이는 3개의 직교 lever를 식별·실측으로 튜닝하고, ADR로 근거를 보존한다. **종목-날짜 워커 풀(Plan B)은 본 spec의 범위 밖** — 단일 캡처 latency 단축이 목표.

## 2. 합의된 결정

| 항목 | 결정 |
|---|---|
| 목표 KPI | 대한항공 1건 wall-clock 5분 → **2분 이내** |
| 보조 KPI | 005930 wall-clock 9분 → 5분 이내 (Phase 2 검증) |
| 안전 KPI | 실험 중 hogaplay 4xx/429/403 발생 0건 |
| 3-lever | (a) `rate_limit_s` 단축, (b) `DEFAULT_PAGE_STEP_MS` 천장 상향, (c) drain 조기 종료 |
| 측정 전략 | Phase 0 풀 baseline → Phase 1 time-boxed 매트릭스 → Phase 2 풀 검증 |
| 차단 감지 시 | 매트릭스 즉시 중단 + 직전 안전값 채택 |
| 채택값 보존 | ADR-00XX (sequence 다음 번호) + 코드 상수 변경 |
| 범위 밖 | 워커 풀, asyncio 리팩토링, chart.php/info.php 최적화, frontend fetch |

## 3. 진단 — 3-Lever 식별

### Lever A: `rate_limit_s` 단축

- 위치: `hoga/collector/orchestrator.py:305` 기본값 `0.2`
- 현재 페이지 시간의 72% 비중. 가장 큰 산술적 lever.
- 위험: hogaplay 차단 (4xx/429/403)
- 검증 필요: 안전 하한값 (현재 보수적 미검증)

### Lever B: `DEFAULT_PAGE_STEP_MS` 천장 상향

- 위치: `hoga/collector/page_step.py:15` 기본값 `60_000`
- CONTEXT.md:37에 "matching hogaplay's UI step"이라 명시되어 보수적으로 고정.
- `page_step.py:92` step doubling이 `initial_step_ms`를 상한으로 가져 cap-hit이 없는 저활성 종목은 60k에 갇힘.
- 천장을 올리면 **저활성 종목에만** 효과 (고활성은 즉시 cap-hit으로 halving). 비대칭 무료 lever.
- 위험: hogaplay 응답에 (a) 이벤트 개수 cap이 있는지, (b) HogaMs 오버플로우 값(예: `84_180_000`)을 너그럽게 처리하는지, (c) 큰 윈도우에서 응답 시간이 비선형으로 늘어나는지.

### Lever C: drain 조기 종료

- 위치: `hoga/collector/page_step.py:96-99` `t >= data_window_end AND empty_in_a_row >= 3`
- 20260518 폭주 사례: 1271 pages 정상 종료 예상 → 3931 pages + finished=False.
- 가설: `new_seqs > 0`이 산발적으로 들어와 empty counter가 reset되어 종료 조건 못 만남.
- 진단 자료: 20260518 raw 디렉토리(3931 first_*.tsv)가 그대로 보존되어 있어 사후 분석 가능.

## 4. 아키텍처 — 3-Phase 실험

```
Phase 0 (baseline + instrumentation, ~30분)
  ├─ 20260518 폭주 raw 사후 분석 (drain 메커니즘 결정적 식별)
  ├─ instrumentation 추가 (per-iteration timing JSONL, env-gated)
  └─ 풀 캡처 2건: 대한항공(저활성) + 005930(고활성)
                                ↓
Phase 1 (time-boxed 매트릭스, ~1시간)
  ├─ rate_limit × step 천장 9-셀 매트릭스
  ├─ 3개 시간대 (개장/장중/마감) × 90s/cell
  └─ 차단 감지 시 즉시 중단 + 직전 안전값 채택
                                ↓
Phase 2 (채택값 풀 검증, ~20분)
  ├─ 최적 1~2 셋팅으로 대한항공 + 005930 풀 캡처
  └─ 정상 종료 + drain 수 + 회귀 비교
                                ↓
Phase 3 (코드화 + ADR)
  ├─ 상수 변경 (orchestrator.py / page_step.py)
  ├─ 차단 감지 시 자동 백오프 (HogaplayHTTPError 분기)
  ├─ drain 조기 종료 가드 추가 (max iterations after window_end)
  └─ ADR-00XX 작성 (rate_limit/step 천장/drain 근거)
```

## 5. Phase 0 — 측정

### 5.1 20260518 폭주 사후 분석 (instrumentation 없이 즉시 가능)

- 입력: `~/.local/share/hoga-ops/data/raw/20260518/003490/first_*.tsv` 3931개
- 산출: 페이지별 (`page_idx`, `row_count`, `max_event_time`, `new_seqs_in_page`, `cumulative_seqs`) CSV
- 결정적 답:
  - 어느 page_idx에서 t가 `DATA_WINDOW_END_MS=160_000_000`를 처음 넘나
  - window-end 이후 페이지에서 `new_seqs > 0`이 몇 번 발생해 empty counter를 reset했나
  - empty_in_a_row가 0으로 reset되는 사이 평균 간격
- 산출물: `tools/analyze_drain.py` (휘발성, 분석 후 폐기)

### 5.2 Instrumentation

`_page_step_loop`에 환경변수 `HOGA_PROFILE=1` 활성 시 per-iteration JSONL 적재.

```python
# hoga/collector/orchestrator.py:_page_step_loop 내부
PROFILE_ENABLED = os.environ.get("HOGA_PROFILE") == "1"
profile_path = raw_dir / "_profile.jsonl" if PROFILE_ENABLED else None

# 각 iteration 시작 시 t0 = time.perf_counter()
# fetch 직후 http_ms = (time.perf_counter() - t0) * 1000
# observe 직후 JSONL append:
#   {iter, t_in, step_ms, http_ms, body_len, new_seqs, max_event_time,
#    cap_hit, empty_streak, post_window, page_idx}
```

평시(`HOGA_PROFILE` 미설정) 0 cost. 활성 시 페이지당 ~1KB JSONL.

### 5.3 풀 baseline

| 종목 | 날짜 | 예상 시간 |
|---|---|---|
| 003490 (대한항공) | 미캡처 평일 1건 | ~5분 |
| 005930 (삼성전자) | 미캡처 평일 1건 | ~9분 |

산출물: `_profile.jsonl` × 2

## 6. Phase 1 — Time-boxed 매트릭스

### 6.1 매트릭스

| step\rate | 0.2 (baseline) | 0.1 | 0.05 |
|---|---|---|---|
| 60k | 1.A | 1.B | 1.C |
| 120k | 1.D | 1.E | 1.F |
| 240k | 1.G | 1.H | 1.I |

### 6.2 실행 메커니즘

- 가짜 `_progress.json` 던져두기 → `_resume_state`가 임의 t에서 시작
- `CancelToken` (`orchestrator.py:69`)으로 90초 후 자동 중단
- 시작 시점 3개:
  - `t=090000000` (개장 직후, 가장 활성)
  - `t=120000000` (점심, 저활성)
  - `t=152000000` (마감 직전 Auction Window)
- 셀당 90초 + 셀 사이 60초 휴식 (cumulative req/sec 안정화)
- **실행 시점**: 외삽 가능성 보장을 위해 적어도 한 차례는 평일 장중(09:00~16:00 KST)에 재실행. 토/일·심야는 hogaplay 부하가 낮아 RTT가 과소평가됨 (20260430 토요일 야간 측정 0.246s/page가 평일 평균 0.27s보다 빠른 사례 참고).

### 6.3 평가 지표

- `pages/90s` (throughput)
- `cap_hit_rate` (cap-hit / total iter)
- `4xx_count` (HogaplayHTTPError where status_code in {400,403,429,503})
- `response_size_p50, p95` (응답 크기가 step에 비례하는지)
- `http_ms_p50, p95`

### 6.4 자동 중단 조건

매트릭스 셀 중 하나라도:
- `HogaplayHTTPError(status_code in {429, 403, 503})` 발생
- `CookieExpiredError` 발생 (차단의 위장 가능)
- 연속 5 페이지 응답 길이 0 (서버 throttle 위장)

→ 매트릭스 즉시 중단, 직전 셀까지의 값을 안전 상한으로 채택.

## 7. Phase 2 — 채택값 풀 검증

Phase 1 결과에서 throughput/안전 trade-off 기준으로 best 1~2 셋팅 선정.

- 대한항공 풀 캡처 (목표 ≤ 2분)
- 005930 풀 캡처 (목표 ≤ 5분)
- 정상 종료 확인 (`_progress.json.finished=true`)
- drain iteration 수 확인 (Phase 3의 조기 종료 가드 효과 검증)

## 8. Phase 3 — 채택 + ADR

### 8.1 상수 변경

```python
# hoga/collector/orchestrator.py
DEFAULT_RATE_LIMIT_S = <Phase 1+2에서 채택>  # was 0.2

# hoga/collector/page_step.py
DEFAULT_PAGE_STEP_MS = <Phase 1+2에서 채택>  # was 60_000
MAX_DRAIN_ITERATIONS_AFTER_WINDOW_END = <Phase 0.1 분석값 × 안전 마진>  # new
```

### 8.2 차단 감지 시 자동 백오프

```python
# orchestrator.py: rate_limit_s 런타임 적응
# HogaplayHTTPError 429/403/503 발생 시 rate_limit_s를 일회성 2배로 백오프,
# 직후 N=10 페이지 동안 4xx 없으면 원복.
```

### 8.3 drain 조기 종료 가드

`PageStepController`에 `iters_since_window_end` 카운터 추가, `MAX_DRAIN_ITERATIONS_AFTER_WINDOW_END` 초과 시 강제 종료 (warning log).

이 가드가 있었다면 20260518 폭주는 1271 + 마진(예: 50) ≈ 1321에서 멈췄을 것.

### 8.4 ADR-00XX

- 결정 근거: Phase 1+2 실측 데이터 (셀별 throughput, 4xx 발생, 정상 종료)
- 채택 안 한 대안: 워커 풀(범위 밖), asyncio 리팩토링(복잡도)
- 후속: 워커 풀 도입 시 본 spec의 단일-프로세스 안전값을 **req/sec for hogaplay**로 재표현 필요 (worker 수와 곱)

## 9. 테스트 변경

- `tests/test_collector_orchestrator.py`: `DEFAULT_RATE_LIMIT_S` / `DEFAULT_PAGE_STEP_MS` 변경에 따른 기대값 업데이트
- `tests/test_page_step.py`: drain 가드 동작 (`MAX_DRAIN_ITERATIONS_AFTER_WINDOW_END` 초과 시 종료) 신규 테스트
- `tests/test_collector_client.py`: 차단 백오프 동작 신규 테스트 (FakeTransport로 429 주입 후 rate_limit_s 적응 확인)
- 통과 기준: 기존 테스트 회귀 0건 + 신규 3건 통과

## 10. 안전 / 롤백

- `_profile.jsonl`은 `HOGA_PROFILE=1` 환경변수 없으면 생성되지 않음 (평시 비용 0)
- 채택값은 모듈 상수로 표현 (`DEFAULT_*`) — 문제 발견 시 git revert 한 번으로 원복
- `_progress.json` 형식 변경 없음 — 기존 resume 호환

## 11. 비목표 (Out of Scope)

- 종목-날짜 워커 풀 (Plan B) — 본 spec과 직교, 별도 PR
- chart.php / info.php 최적화 — 1회 호출이라 단축 효과 미미
- frontend fetch (`useCalendar`, `useCaptureQueue`, `useSymbols`) 튜닝
- SSE 이벤트 압축/throttling
- parquet 변환 단계 시간

## 12. Open Questions

1. hogaplay 응답에 시간 윈도우와 별개의 이벤트-개수 cap이 있는가? (Phase 1.D~I에서 결정)
2. HogaMs 오버플로우 값(예: `t=84_180_000`)을 서버가 너그럽게 처리하는가? (Phase 1.G~I에서 결정)
3. 차단 감지 후 백오프 회수 시점은 N=10 페이지가 적절한가? (Phase 2에서 검증, 미검증이면 conservative N=30)
4. drain 가드의 안전 마진은 +50 적절한가? (Phase 0.1 분석에서 결정)
