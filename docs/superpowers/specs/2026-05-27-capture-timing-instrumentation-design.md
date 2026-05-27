# Capture Timing Instrumentation — Phase-별 Wall-Time 측정 인프라

**Status:** draft (2026-05-27)

## 1. Context

`/capture` 사용자가 hogaplay capture를 가속하고 싶다는 요구로 시작됨. 원래 가설은 **"10s/60s spot 샘플링으로 capture를 빠르게 할 수 있을까"** 였으나, brainstorming 과정에서 다음이 확정되어 가설이 폐기됨:

- 호가(type 2)·거래원(type 4) 데이터는 `first.php` tick 스트림 **안의 이벤트**이며 ([snapshots.py:43-69](../../../hoga/tables/snapshots.py#L43-L69), [brokers.py:43-82](../../../hoga/tables/brokers.py#L43-L82)), hogaplay에는 시점 spot 엔드포인트가 없음.
- 따라서 spot만 원해도 `first.php` 페이지 루프는 그대로 돌아야 함 → **upstream 호출량을 줄일 길이 없음**.
- 샘플링이 줄이는 것은 디스크 write + parquet 크기 + 다운스트림 쿼리 비용. **Wall time 영향은 미미**.

사용자는 "wall time을 줄이고 싶다"(A)를 우선순위로 확정했고, wall time을 진짜 공격하려면 **현재 capture의 phase 분포를 먼저 측정**해야 함을 합의함. ADR-0017 ([capture-fetch-throughput](2026-05-23-capture-fetch-throughput-design.md))이 한 차례 throttle 튜닝을 했지만, 이후 추가 튜닝(A2)·"호가-only 모드"(A3)·resume 정밀화(A4) 중 어디가 ROI가 큰지 데이터로 판단할 수단이 없는 상태.

본 spec은 capture 경로에 phase-별 wall-time 측정 인프라를 한 번 깔고, 그 데이터로 후속 결정을 내릴 수 있는 상태에 도달하는 것이 목표.

**핵심 결정:**

| 항목 | 결정 |
|---|---|
| 목표 | capture wall-time의 phase 분포를 측정 가능하게 만든다 |
| 측정 대상 phase (7개) | `http_fetch`, `parse`, `disk_write`, `rate_limit`, `backoff`, `cookie_pause`, `other` |
| 출력 | (1) `/capture` UI의 TimingPanel + (2) `data_dir/timing/<date>/<code>.json` |
| 측정 방식 | Context-manager 기반 `CaptureTimingCollector` per (code, date) |
| 측정 끄는 스위치 | `HOGA_CAPTURE_TIMING=0` (기본 1) |
| 범위 밖 | A2/A3/A4 본 작업, sampling 구현, history view, 자동 알림, DB 저장 |

## 2. Architecture

각 (code, date) 작업마다 `CaptureTimingCollector` 인스턴스를 만들어 호출 스택을 따라 전달하고, phase별로 시간을 누적한 뒤 작업 완료 시 (a) SSE로 요약을 보내고 (b) JSON 파일에 상세를 저장한다.

**구성요소:**

1. **`CaptureTimingCollector`** (`hoga/collector/timing.py`, 신규) — phase context manager + page accumulator. 순수 in-memory, side effect 없음.
2. **Orchestrator wiring** (`hoga/collector/orchestrator.py`, `hoga/api/captures.py`) — worker가 (code, date) 시작할 때 collector 생성 → 호출 스택으로 전달 → 완료 시 회수.
3. **Persistence layer** (`hoga/collector/timing_writer.py`, 신규) — collector → `data_dir/timing/<date>/<code>.json` 직렬화. atomic write.
4. **SSE event** — 신규 이벤트 타입 `capture.timing`. payload = collector.summary(). 기존 `CaptureProgress` 흐름과 직교.
5. **Frontend `TimingPanel`** (`frontend/src/capture/TimingPanel.tsx`, 신규) — SSE 구독, 완료된 (code, date)마다 카드 1개. 접힌 상태가 기본.

**데이터 흐름:**

```
worker start (code, date)
  └─ collector = CaptureTimingCollector(code, date)
     └─ collect_stock_date(..., collector=collector)
        └─ for page in pages:
              with collector.phase("http_fetch"): fetch_first(...)
              with collector.phase("parse"):      parse_page(...)
              with collector.phase("disk_write"): write_tsv(...)
              with collector.phase("rate_limit"): time.sleep(0.05)
           on 429:
              with collector.phase("backoff"):    time.sleep(5/10/30)
worker end (code, date)
  ├─ write_timing_json(data_dir, collector)
  └─ emit_sse("capture.timing", collector.summary())
```

**왜 인스턴스 per (code, date) 인가:** worker 3개가 병렬로 다른 (code, date)를 돈다. 글로벌 collector면 phase 시간이 섞임.

**왜 SSE는 완료 시 1회인가:** 페이지마다 timing event를 흘리면 ~390 페이지 × N 종목 = 클라이언트 부담. 진행 상황은 기존 `CaptureProgress`로 충분.

## 3. Backend Wiring

### 3.1 `CaptureTimingCollector` API

`hoga/collector/timing.py`:

```python
class CaptureTimingCollector:
    def __init__(
        self,
        code: str,
        date: str,
        *,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None: ...

    # 핵심 측정 API
    @contextmanager
    def phase(self, name: PhaseName) -> Iterator[None]: ...

    def mark_page_boundary(self) -> None:
        """다음 phase들이 새 페이지에 속한다고 표시. page-level 집계용."""

    def record_event_count(self, n: int) -> None: ...
    def record_error(self, kind: str) -> None:  # "429", "cookie_expired", ...

    # 회수 API
    def summary(self) -> TimingSummary: ...      # SSE/UI용 phase 합계
    def to_dict(self) -> dict:                   # JSON 파일용 (페이지 detail 포함)
```

**Phase 이름 (고정 enum):** 이 7개 label은 CONTEXT.md의 **Timing Phase** 도메인 용어. 이 spec 전반에서 "phase"는 **Timing Phase**를 가리키며, **Capture Queue** 라이프사이클 `phase` (`queued`/`active`/`done`/...) 와 다른 개념임을 유의.

| Phase | 측정 대상 |
|---|---|
| `http_fetch` | first.php / chart.php / info.php 요청 왕복 |
| `parse` | `parse_stock_date` 호출 (page loop 종료 후 TSV 전체 → parquet, 1회) |
| `disk_write` | TSV/parquet write |
| `rate_limit` | 페이지당 `time.sleep(rate_limit_s)` 누적. **ADR-0017의 throttle auto-backoff 더블링은 이 phase에 흡수됨** — 더블링되는 게 `rate_limit_s` 자체이므로 |
| `backoff` | `_run_capture_and_parse`의 **상위 레벨 retry sleep**(5/10/30s 등) 누적. ADR-0017의 rate_limit 더블링과 구별 |
| `cookie_pause` | cookie 만료 pool 일시정지 |
| `other` | 위 어디에도 안 잡힌 잔여 (sanity check용) |

**불변식:** `total_ms ≥ sum(phase_totals_ms.values())`. 차이는 `unaccounted_ms`로 summary에 노출. 5% 이상이면 측정 누락 신호.

**Context manager 동작:** `__exit__`에서 무조건 perf_counter 차이를 phase_totals에 더한다(예외 전파는 그대로). 이 불변식이 깨지면 429 같은 실패 시간이 통계에서 누락됨.

**중첩 정책:** Phase 중첩 **금지**. 이미 active phase가 있는 상태에서 다시 `phase()`에 진입하면 `RuntimeError`. 현재 wiring(3.2)은 순차이며, 중첩 허용 시 시간 이중 가산 위험이 있음.

**`record_event_count` 호출 위치:** 페이지의 parse 직후, 그 페이지에서 추출한 모든 type(0/1/2/3/4)의 행 수 합. 페이지 detail의 `events` 필드와 summary의 `event_count` 양쪽에 누적.

### 3.2 Orchestrator touch points

| 위치 | 변경 | phase |
|---|---|---|
| `hoga/collector/orchestrator.py` `collect_stock_date` 시그니처 | `collector: CaptureTimingCollector \| None = None` 추가 | — |
| 페이지 루프 진입 | `collector.mark_page_boundary()` | — |
| `fetch_first(...)` / `fetch_chart(...)` / `fetch_info(...)` | `with collector.phase("http_fetch"):` | `http_fetch` |
| 페이지 TSV write (`first_NNNNN.tsv`, orchestrator.py:~299) | `with collector.phase("disk_write"):` | `disk_write` |
| `hoga/api/captures.py` 의 `parse_stock_date` executor 호출 (~L595, page loop 종료 후) | `with collector.phase("parse"):` | `parse` |
| `time.sleep(rate_limit_s)` | `with collector.phase("rate_limit"):` | `rate_limit` |
| `hoga/api/captures.py` 상위 레벨 429 retry (~L518; 5/10/30s sleep) | `with collector.phase("backoff"):` + `record_error("429")` | `backoff` |
| `hoga/api/captures.py` cookie expired (~L710) | `with collector.phase("cookie_pause"):` + `record_error("cookie_expired")` | `cookie_pause` |

### 3.3 Collector lifecycle

- **생성:** `_run_item` 진입 시점에 생성 (cookie_pause 같은 외곽 phase까지 포함하기 위함).
- **전달:** keyword 인자 `collector=...`로 명시 전달. global/contextvar 안 씀.
- **완료:** `_run_item` finally 블록에서 `timing_writer.write(collector)` + SSE emit. 예외 시에도 항상 회수.

### 3.4 측정 자체의 오버헤드

`time.perf_counter()` 호출은 Linux에서 ~30-40ns. 페이지당 7번 wrap → 250ns. 페이지 ~390개/(code, date) → 100µs 총. **측정 가능 수준 아님.** ADR-0017 throttle 동작에 영향 0.

## 4. JSON Schema + 디스크 레이아웃

### 4.1 파일 경로

```
<data_dir>/timing/<date>/<code>.json
```

예: `~/.local/share/hoga-ops/timing/20250520/005930.json`

작성 방식: 부모 디렉터리(`<data_dir>/timing/<date>/`)를 `mkdir(parents=True, exist_ok=True)`로 자동 생성. 그 후 `tempfile + os.replace` 패턴 (atomic write). 같은 (code, date) 재캡처 시 덮어쓰기.

### 4.2 Pydantic 모델

`hoga/api/models.py` 에 추가:

```python
class TimingPhaseTotals(BaseModel):
    http_fetch_ms: float
    parse_ms: float
    disk_write_ms: float
    rate_limit_ms: float
    backoff_ms: float
    cookie_pause_ms: float
    other_ms: float

class TimingPageDetail(BaseModel):
    idx: int                  # 0-based page index within the (code, date)
    http_ms: float
    parse_ms: float
    write_ms: float
    events: int
    errors: list[str]

class TimingEnv(BaseModel):
    rate_limit_s: float
    max_concurrent: int
    page_step_ms_initial: int
    hoga_version: str
    git_sha: str | None

class TimingSummary(BaseModel):
    code: str
    date: str                  # YYYYMMDD
    started_at_kst: str        # ISO 8601
    ended_at_kst: str
    total_ms: float            # 단조시간
    phase_totals_ms: TimingPhaseTotals
    phase_percentages: dict[str, float]   # 합 = 100.0 (반올림 오차 허용)
    unaccounted_ms: float
    page_count: int
    event_count: int
    error_counts: dict[str, int]
    env: TimingEnv

class TimingReport(BaseModel):
    """디스크 JSON 전체 = summary + per-page detail."""
    summary: TimingSummary
    pages: list[TimingPageDetail]
```

### 4.3 샘플 파일

```json
{
  "summary": {
    "code": "005930",
    "date": "20250520",
    "started_at_kst": "2026-05-27T14:32:18+09:00",
    "ended_at_kst": "2026-05-27T14:33:02+09:00",
    "total_ms": 43821.4,
    "phase_totals_ms": {
      "http_fetch_ms": 31204.8,
      "parse_ms": 4102.1,
      "disk_write_ms": 1843.7,
      "rate_limit_ms": 5021.0,
      "backoff_ms": 0.0,
      "cookie_pause_ms": 0.0,
      "other_ms": 0.0
    },
    "phase_percentages": {
      "http_fetch": 71.2, "parse": 9.4, "disk_write": 4.2,
      "rate_limit": 11.5, "backoff": 0.0, "cookie_pause": 0.0, "other": 0.0
    },
    "unaccounted_ms": 1649.8,
    "page_count": 387,
    "event_count": 184231,
    "error_counts": {"429": 0, "cookie_expired": 0},
    "env": {
      "rate_limit_s": 0.05,
      "max_concurrent": 3,
      "page_step_ms_initial": 60000,
      "hoga_version": "0.42.0",
      "git_sha": "9aef504"
    }
  },
  "pages": [
    {"idx": 0, "http_ms": 142.3, "parse_ms": 11.2, "write_ms": 5.7, "events": 412, "errors": []},
    {"idx": 1, "http_ms": 138.9, "parse_ms": 9.8,  "write_ms": 4.2, "events": 387, "errors": []}
  ]
}
```

### 4.4 분석 워크플로우

이 스키마가 지원해야 하는 use case:

- `jq '.summary.phase_percentages' data_dir/timing/*/005930.json` — 한 종목 전 기간 phase % 추이
- `jq -s 'map(.summary.total_ms) | add/length' …` — 평균 capture 시간
- `jq '.pages | map(.http_ms) | sort | .[0,length/2,length-1]' …` — http p50/p99
- `jq 'select(.summary.error_counts."429" > 0)' …` — 429 발생 작업만

ADR-0017 튜닝 전후 회귀 비교도 `env` 메타 비교만으로 가능.

## 5. SSE Event

### 5.1 신규 이벤트 타입

```
event: capture.timing
id: 005930:20250520
data: { ...TimingSummary JSON... }
```

- **payload = `TimingSummary`** (per-page detail은 포함 X — JSON 파일에만)
- **id = `{code}:{date}`** — 클라이언트 dedup 키
- **emit 시점**: `_run_item` finally에서 단 1회

### 5.2 기존 SSE 흐름과의 관계

| event type | 빈도 | 용도 |
|---|---|---|
| `capture.progress` (기존) | 페이지마다 | 진행률 바 |
| `capture.queue` (기존) | 큐 변경 시 | 큐 상태 UI |
| `capture.timing` (신규) | (code, date) 완료 시 1회 | TimingPanel |

### 5.3 백엔드 발행 순서

`_run_item` finally 블록:

```python
finally:
    if collector is not None:
        timing_writer.write(data_dir, collector)        # JSON 먼저
        await event_bus.publish(
            SSEEvent(
                type="capture.timing",
                id=f"{code}:{date}",
                data=collector.summary().model_dump(),
            )
        )                                                # SSE 다음
```

**JSON 먼저 → SSE 다음** 이유: UI가 SSE 받고 곧바로 (추후 history view에서) JSON 파일을 읽으러 가더라도 파일이 이미 있음을 보장.

### 5.4 실패 시 동작

- JSON write 실패 → 로그만 남기고 SSE는 계속 발행. 측정은 best-effort, capture 본업 방해 X.
- `HOGA_CAPTURE_TIMING=0` → collector 생성 안 함, 발행 자체 skip. 기존 동작 그대로 (escape hatch).

## 6. Frontend TimingPanel

### 6.1 컴포넌트 구조

```
frontend/src/capture/
  TimingPanel.tsx         (신규) 단일 카드
  useCaptureTiming.ts     (신규) SSE 구독 hook
  phaseColors.ts          (신규) phase 이름 → DESIGN.md 토큰 매핑
```

### 6.2 위치

`/capture` 페이지의 **기존 큐/잡 리스트 항목 각각의 하단**. 작업이 완료되면 해당 잡 카드의 일부로 렌더. 별도 섹션 아님.

### 6.3 데이터 흐름

```
SSE "capture.timing"
  → useCaptureTiming() hook (앱 root에서 1회 마운트)
     → zustand store: timings: Map<id, TimingSummary>
        → TimingPanel({ id }) 가 store에서 조회
```

### 6.4 Collapsed view (default)

```
┌─────────────────────────────────────────────────┐
│ 005930 · 20250520            43.8 s        [⌄]  │
│ ███████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│ http_fetch 71% · rate_limit 12% · parse 9% …    │
└─────────────────────────────────────────────────┘
```

- 좌측: `code · date`
- 우측: 총 wall time (`<1000ms → "234 ms"`, `≥1000ms → "12.4 s"`)
- horizontal stacked bar (phase 색상별 % 비율)
- 한 줄 텍스트: phase % 내림차순 top 3, 나머지는 "…"
- `[⌄]` 클릭으로 expanded view 토글

### 6.5 Expanded view

```
┌─────────────────────────────────────────────────┐
│ 005930 · 20250520            43.8 s        [⌃]  │
│ ███████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│                                                 │
│  http_fetch    31.2 s   71.2 %                  │
│  rate_limit     5.0 s   11.5 %                  │
│  parse          4.1 s    9.4 %                  │
│  disk_write     1.8 s    4.2 %                  │
│  backoff        0   s    0.0 %                  │
│  cookie_pause   0   s    0.0 %                  │
│  ── pages: 387 · events: 184,231                │
│  ── 429 errors: 0 · cookie expired: 0           │
│  ── env: rate_limit 0.05s · workers 3           │
│  ── unaccounted: 1.6 s (3.8 %)  ⚠ if >5%        │
└─────────────────────────────────────────────────┘
```

### 6.6 시각 규칙

- 색상: `phaseColors.ts`에서 **DESIGN.md 토큰에 매핑**. 7개 phase 각각 고유 색.
  - 의미적 그룹: `http_fetch`/`rate_limit`/`backoff`/`cookie_pause` = "기다림", `parse`/`disk_write` = "처리", `other` = 회색
  - 정확한 토큰 매핑은 plan 단계에서 DESIGN.md 보고 확정
- 타이포/spacing: **DESIGN.md 토큰만 사용**. 하드코딩 px 금지.
- 모션: expand/collapse는 DESIGN.md 정의 transition만.
- `unaccounted_ms / total_ms > 5%` → 해당 줄에만 warning 토큰 색.
- `error_counts` 0 아닌 값 있으면 해당 줄 강조.

### 6.7 접근성

- expand/collapse는 button 요소, `aria-expanded` 토글
- stacked bar에 `role="img" aria-label="…"` 로 phase breakdown 텍스트 노출
- 숫자 포맷 ko-KR locale (천 단위 구분)

### 6.8 비기능

- 히스토리(과거 JSON 열람): 비목표 — `jq`로 충분
- 정렬/필터/검색: 비목표
- 튜닝 전후 비교 뷰: 비목표 — 데이터 누적 후 별 spec

## 7. 테스트 전략

### 7.1 유닛 (collector)

`tests/collector/test_timing.py` 신규.

- **시간 소스 주입**: `clock` 인자로 fake clock 주입 (flaky 회피)
- 케이스:
  - `phase` 단순 누적 정확
  - 중첩 phase 금지 검증: 이미 active phase 안에서 `phase()` 재진입 → `RuntimeError`
  - **예외 경로**: `with collector.phase(): raise` → 예외 전파 + phase 시간 정상 누적 (회귀 가드)
  - `mark_page_boundary` 후 새 페이지 분리
  - `record_error("429")` → page.errors + summary.error_counts 둘 다 반영
  - `unaccounted_ms` 계산
  - `to_dict()` ↔ `TimingReport` 모델 round-trip

### 7.2 유닛 (writer)

`tests/collector/test_timing_writer.py` 신규.

- `tmp_path`로 임시 data_dir
- 파일 존재, JSON parse 가능, schema 매치
- 같은 (code, date) 두 번 write → atomic 덮어쓰기
- 디렉터리 자동 생성

### 7.3 통합 (orchestrator → SSE)

`tests/api/test_captures_timing.py` 신규.

- hogaplay HTTP mock (5-페이지 가짜 응답)
- `enqueue_items_core` 호출 → 작업 완료 대기 → 파일 존재 검증
- in-memory event_bus 캡처 → `capture.timing` 1회 발행 + payload schema 검증
- 정확 ms 값 assert X. **구조와 비율의 sanity만:**
  - `page_count == 5`
  - `total_ms > 0`
  - `sum(phase_totals_ms.values()) ≤ total_ms` 단조성
  - `phase_percentages` 합 = 100 ± 0.5
  - `http_fetch_ms > 0` (mock에 미세 지연 주입)

### 7.4 통합 (실패 경로)

- 429 1회 → backoff phase에 시간 + error_counts["429"] == 1
- cookie 만료 시뮬레이션 → cookie_pause phase에 시간
- `HOGA_CAPTURE_TIMING=0` → collector 생성 X, JSON 미생성, SSE 미발행, 기존 capture 정상 완료

### 7.5 프론트엔드 유닛

`frontend/src/capture/TimingPanel.test.tsx` (Vitest + RTL):

- 가짜 `TimingSummary` props
- collapsed default 렌더, stacked bar 비율
- expand 클릭 → phase 표 7행
- `unaccounted_ms > 5%` → warning 톤
- ko-KR locale 포맷

`useCaptureTiming.test.ts`:

- mock EventSource로 `capture.timing` dispatch → store에 id 키로 들어감
- 같은 id 재발행 → dedup (덮어쓰기)

### 7.6 명시적 비테스트

- 실제 hogaplay e2e — 안 함
- 정확한 wall time 회귀 — 안 함
- 측정 오버헤드 회귀 — 안 함 (3.4에서 무시 가능 수준)

### 7.7 CI 통합

- `uv run pytest` + `npm run test` 기존 setup에 합류. 별도 마커 없음.

## 8. 비목표 (Out of Scope)

이 spec에서 **하지 않는** 것:

- **A2 튜닝** — `HOGA_MAX_CONCURRENT`, `rate_limit_s`, `page_step` 변경 일절 안 함.
- **A3 "호가/거래원 없이 모드"** — UI 체크박스/다른 capture 모드 추가 안 함.
- **A4 resume/skip 정밀화** — 기존 dedup 로직 안 건드림.
- **샘플링 (원 가설)** — 10s/60s 다운샘플링 안 함. Q2에서 폐기됨.
- **History view** — 과거 timing JSON을 UI에서 열람.
- **튜닝 전후 비교 UI** — 두 timing report 나란히 비교.
- **자동 알림** — phase % threshold 경고.
- **DuckDB/DB 저장** — JSON 파일 트리만.
- **Timing JSON 조회 GET endpoint** — 현재 세션 SSE로 충분.
- **measurement-overhead 회귀 테스트.**

## 9. 성공기준

### 9.1 DoD (Definition of Done)

1. `HOGA_CAPTURE_TIMING` 활성(기본) 상태에서 임의의 (code, date) 캡처가 완료되면 `data_dir/timing/<date>/<code>.json`이 생성되고 `TimingReport` 스키마와 정확히 일치.
2. `/capture`에서 캡처 완료 시 해당 잡 카드에 TimingPanel이 렌더(접힘 default).
3. `unaccounted_ms / total_ms ≤ 5%` — 측정 누락이 작음.
4. `HOGA_CAPTURE_TIMING=0` → 기존 capture 동작 완전 동일 (파일 미생성, SSE 미발행, 회귀 0).
5. `uv run pytest` + `cd frontend && npm run build` 통과.

### 9.2 해석 가능성 기준 (이 작업의 진짜 목적)

6. 실제 1 종목 × 1 영업일 캡처 보고서로 다음 모두 답할 수 있어야 함:
   - `http_fetch`가 wall time의 몇 %인가?
   - `rate_limit` + `backoff`가 합쳐 몇 %인가?
   - `parse` + `disk_write`가 합쳐 10% 미만인가?
   - 페이지 p99 `http_ms`는 얼마인가?
   - 이 데이터로 A2/A3/A4 중 어느 ROI가 가장 큰지 판단 가능한가?

(6)에 "예" → 완료. "아니오" → phase 분할 부족 신호, 추가 phase follow-up.

## 10. 리스크 & 미해결

- **R1: 기존 SSE 컨슈머의 unknown `type` 처리.** plan 초기에 코드 확인 필수. throw하면 `default: ignore` 안전망부터.
- **R2: collector 전달 경로의 깊이.** `_run_item → _run_capture_and_parse → _run_capture_inner → collect_stock_date` 4-5단. plan에서 시그니처 변경 목록 확정.
- **R3: disk_write 측정 비대칭.** parquet writer가 별도 프로세스/스레드면 disk_write phase 측정 부정확. plan에서 재확인.
- **R4: 측정 on/off 비교 smoke check.** 섹션 3.4에서 무시 가능으로 결론. DoD엔 안 넣되 plan에 "smoke check 1회" 작업으로.
- **R5: TimingPanel 위치(잡 카드 어디).** 잡 리스트 컴포넌트 파일 미확인. plan 초반에 확정.

## 11. 후속 작업 (별 spec)

이 spec 데이터로 결정될 후속:

- **A2 튜닝 spec** — phase 데이터가 "`http_fetch` ≥ 70%"를 가리키면 우선
- **A3 호가-only 모드 spec** — 캔들만 필요한 워크플로우가 자주임이 확인되면
- **A4 resume 정밀화 spec** — 재캡처 비용이 측정상 크게 잡히면
- **Timing history view spec** — 운영 모니터링 가치가 누적 데이터로 명확해지면

## 12. 참고

- Brainstorming 결과 (이 spec) — `/full-flow` 1단계 산출물
- 관련 기존 spec: [2026-05-23-capture-fetch-throughput-design.md](2026-05-23-capture-fetch-throughput-design.md) (ADR-0017 근거)
- 호가/거래원 데이터 원천: [hoga/tables/snapshots.py:43-69](../../../hoga/tables/snapshots.py#L43-L69), [hoga/tables/brokers.py:43-82](../../../hoga/tables/brokers.py#L43-L82)
- hogaplay 엔드포인트: [hoga/collector/client.py](../../../hoga/collector/client.py)
