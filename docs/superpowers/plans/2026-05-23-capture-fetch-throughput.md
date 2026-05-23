# Capture Fetch Throughput Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 Stock-Date 캡처 wall-clock을 대한항공 기준 5분 → 2분 이내로 단축한다 (3-lever 측정·실험·튜닝).

**Architecture:** Phase 0 (측정 + instrumentation + 사후 분석) → Phase 1 (step×rate 매트릭스 실험) → Phase 2 (채택값 풀 검증) → Phase 3 (코드화 + 안전 가드 + ADR). 실험 결과가 코드 상수를 결정하므로 task 사이 데이터 의존성이 명시적.

**Tech Stack:** Python 3.11+, httpx, pytest, FastAPI, hogaplay.com (외부 의존)

**Spec:** `docs/superpowers/specs/2026-05-23-capture-fetch-throughput-design.md`

---

## File Structure

생성:
- `tools/analyze_drain.py` — 20260518 폭주 raw 사후 분석 (휘발성, Phase 0.1)
- `tools/run_matrix_experiment.py` — Phase 1 매트릭스 실행 도구 (휘발성)
- `tools/analyze_matrix_results.py` — Phase 1 결과 집계 (휘발성)
- `docs/adr/0017-capture-fetch-throughput.md` — 채택값 근거
- `docs/superpowers/measurements/2026-05-23-throughput/` — 측정 산출물 보관 (jsonl, csv)

수정:
- `hoga/collector/orchestrator.py` — instrumentation, step_ms 노출, 차단 백오프, DEFAULT_RATE_LIMIT_S
- `hoga/collector/page_step.py` — drain 가드, DEFAULT_PAGE_STEP_MS
- `tests/test_collector_orchestrator.py` — 회귀 + 신규 (instrumentation, 백오프, step_ms 인자)
- `tests/test_page_step.py` — drain 가드 신규

수정 없음:
- `hoga/collector/client.py` — 백오프는 orchestrator 책임이라 client는 그대로

---

## Phase 0 — 측정 (Tasks 1-3)

### Task 1: 20260518 폭주 사후 분석 도구

**Files:**
- Create: `tools/analyze_drain.py`
- Create: `docs/superpowers/measurements/2026-05-23-throughput/drain-analysis-20260518.md`

**목적:** spec Open Question #4 (drain 가드 안전 마진) 결정에 필요한 결정적 답을 raw 데이터에서 도출. 이 task의 산출물 (해당 페이지 번호, empty reset 발생 횟수, 평균 reset 간격)이 Task 9의 `MAX_DRAIN_ITERATIONS_AFTER_WINDOW_END` 값을 정한다.

- [ ] **Step 1: tools 디렉토리 생성 + analyze_drain.py 작성**

```bash
mkdir -p tools docs/superpowers/measurements/2026-05-23-throughput
```

```python
# tools/analyze_drain.py
"""Post-hoc analysis of the 20260518 drain-runaway capture.

Reads ~/.local/share/hoga-ops/data/raw/20260518/003490/first_*.tsv,
prints per-page (page_idx, row_count, max_event_time, new_seqs, cumulative_seqs)
and summary statistics needed to size the drain guard threshold.
"""

from __future__ import annotations

import sys
from pathlib import Path

from hoga.collector.orchestrator import page_sort_key

DATA_WINDOW_END_MS = 160_000_000

# Field index constants from orchestrator.py
IDX_GLOBAL_SEQ = 3
IDX_EVENT_TIME = 4
MIN_FIELDS_EVENT_TIME = 5


def _parse_page(body: str) -> tuple[set[int], int | None, int]:
    seqs: set[int] = set()
    max_t: int | None = None
    row_count = 0
    for line in body.splitlines():
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < MIN_FIELDS_EVENT_TIME:
            continue
        row_count += 1
        try:
            seqs.add(int(parts[IDX_GLOBAL_SEQ]))
            t = int(parts[IDX_EVENT_TIME])
        except ValueError:
            continue
        if max_t is None or t > max_t:
            max_t = t
    return seqs, max_t, row_count


def main(raw_dir: Path) -> None:
    pages = sorted(raw_dir.glob("first_*.tsv"), key=page_sort_key)
    seen: set[int] = set()
    post_window_first_idx: int | None = None
    post_window_resets = 0
    post_window_empty_streak_max = 0
    cur_empty_streak = 0
    last_reset_idx: int | None = None
    reset_gaps: list[int] = []

    print(f"page_idx\trows\tmax_event_time\tnew_seqs\tcum_seqs\tempty_streak")
    for i, p in enumerate(pages, start=1):
        body = p.read_text(encoding="utf-8")
        seqs, max_t, rows = _parse_page(body)
        new = len(seqs - seen)
        seen |= seqs
        if max_t is not None and max_t >= DATA_WINDOW_END_MS and post_window_first_idx is None:
            post_window_first_idx = i
        post_window = post_window_first_idx is not None and i >= post_window_first_idx
        if new == 0:
            cur_empty_streak += 1
        else:
            if post_window and cur_empty_streak > 0:
                post_window_resets += 1
                if last_reset_idx is not None:
                    reset_gaps.append(i - last_reset_idx)
                last_reset_idx = i
            cur_empty_streak = 0
        if post_window:
            post_window_empty_streak_max = max(post_window_empty_streak_max, cur_empty_streak)
        print(f"{i}\t{rows}\t{max_t}\t{new}\t{len(seen)}\t{cur_empty_streak}")

    total = len(pages)
    drain_iters = (total - post_window_first_idx + 1) if post_window_first_idx else 0
    avg_gap = sum(reset_gaps) / len(reset_gaps) if reset_gaps else 0
    print("---SUMMARY---", file=sys.stderr)
    print(f"total_pages={total}", file=sys.stderr)
    print(f"post_window_first_idx={post_window_first_idx}", file=sys.stderr)
    print(f"drain_iterations={drain_iters}", file=sys.stderr)
    print(f"post_window_empty_resets={post_window_resets}", file=sys.stderr)
    print(f"max_empty_streak_post_window={post_window_empty_streak_max}", file=sys.stderr)
    print(f"avg_reset_gap_pages={avg_gap:.1f}", file=sys.stderr)


if __name__ == "__main__":
    raw_dir = Path.home() / ".local/share/hoga-ops/data/raw/20260518/003490"
    main(raw_dir)
```

- [ ] **Step 2: 실행 + 결과 저장**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
uv run python tools/analyze_drain.py > docs/superpowers/measurements/2026-05-23-throughput/drain-pages-20260518.tsv 2> docs/superpowers/measurements/2026-05-23-throughput/drain-summary-20260518.txt
```

Expected: pages.tsv에 3931 줄 + summary.txt에 6줄 메트릭

- [ ] **Step 3: 결정적 답을 markdown으로 정리**

`docs/superpowers/measurements/2026-05-23-throughput/drain-analysis-20260518.md` 작성:

```markdown
# 20260518 Drain Runaway — Root Cause

**원본:** ~/.local/share/hoga-ops/data/raw/20260518/003490/ (3931 pages, finished=False)

**Summary** (from drain-summary-20260518.txt):
- total_pages: 3931
- post_window_first_idx: <측정값>
- drain_iterations: <측정값>
- post_window_empty_resets: <측정값>  ← 0이면 가드가 정상 작동했어야 함
- max_empty_streak_post_window: <측정값>  ← 3 미만이면 종료 못 한 원인
- avg_reset_gap_pages: <측정값>

**결론:**
- (a) post_window 이후 new_seqs > 0이 평균 N 페이지마다 발생해 empty counter가 reset됨
- (b) max_empty_streak가 3 미만에 머물러 종료 조건 미충족
- (c) 따라서 spec §8.3의 `MAX_DRAIN_ITERATIONS_AFTER_WINDOW_END` 값은
      max(정상 캡처의 drain_iterations) × 1.5 안전 마진 = 약 **<값>** 로 설정 권장
```

- [ ] **Step 4: commit**

```bash
git add tools/analyze_drain.py docs/superpowers/measurements/
git commit -m "$(cat <<'EOF'
chore(measurements): drain runaway post-hoc analysis (20260518/003490)

Read 3931 first_*.tsv pages and emit per-page (rows, max_event_time,
new_seqs, cum_seqs, empty_streak) + summary stats. Confirms that
TERMINATION_EMPTY_PAGES=3 was reset by sporadic new seqs post-window,
sizing the MAX_DRAIN_ITERATIONS_AFTER_WINDOW_END guard for Task 9.

Spec: docs/superpowers/specs/2026-05-23-capture-fetch-throughput-design.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: per-iteration timing instrumentation

**Files:**
- Modify: `hoga/collector/orchestrator.py` (around `_page_step_loop` definition at line 240)
- Modify: `tests/test_collector_orchestrator.py` (append after line 216)

- [ ] **Step 1: 실패 테스트 작성 — HOGA_PROFILE 미설정 시 파일 생성 안 됨**

Append to `tests/test_collector_orchestrator.py`:

```python
def test_profile_jsonl_not_created_when_env_unset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Default behaviour: no _profile.jsonl created (zero-cost when disabled)."""
    monkeypatch.delenv("HOGA_PROFILE", raising=False)
    fake = FakeClient(
        info_body="info\n",
        first_pages={84000000: _row(1, 1, 1, 1001, 84001000)},
        chart_body="chart\n",
    )
    collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0,
    )
    profile = tmp_path / "raw" / "20260519" / "003490" / "_profile.jsonl"
    assert not profile.exists()


def test_profile_jsonl_created_and_line_format_when_env_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """HOGA_PROFILE=1: one JSONL line per fetch iteration with required fields."""
    monkeypatch.setenv("HOGA_PROFILE", "1")
    fake = FakeClient(
        info_body="info\n",
        first_pages={84000000: _row(1, 1, 1, 1001, 84001000)},
        chart_body="chart\n",
    )
    collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0,
    )
    profile = tmp_path / "raw" / "20260519" / "003490" / "_profile.jsonl"
    assert profile.exists()
    lines = [json.loads(line) for line in profile.read_text().splitlines() if line]
    assert len(lines) >= 1
    required = {"iter", "t_in", "step_ms", "http_ms", "body_len",
               "new_seqs", "max_event_time", "cap_hit", "empty_streak",
               "post_window", "page_idx"}
    assert required.issubset(lines[0].keys())
```

Add `import json` near other imports (top of test file) if not present.

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
uv run pytest tests/test_collector_orchestrator.py::test_profile_jsonl_not_created_when_env_unset tests/test_collector_orchestrator.py::test_profile_jsonl_created_and_line_format_when_env_set -v
```

Expected: 첫 테스트 PASS (파일 안 만들어지므로 우연히 통과), 두 번째 FAIL (파일 없음 → assert profile.exists() 실패)

- [ ] **Step 3: instrumentation 구현**

`hoga/collector/orchestrator.py`의 상단 imports에 추가:

```python
import os
import time as _time
```

(`_time`은 이미 import 되어 있으면 생략; `os`만 추가)

`_page_step_loop` 함수 (line 240) 본문을 다음으로 교체:

```python
def _page_step_loop(
    raw_dir: Path,
    client: HogaplayClientProto,
    code: str,
    date: str,
    started_at: str,
    rate_limit_s: float,
    seen_seqs: set[int],
    page_idx: int,
    t: int,
    on_progress: Callable[[ProgressEvent], None] | None = None,
    cancel_token: CancelToken | None = None,
    initial_step_ms: int = 60000,  # exposed for Phase 1 matrix experiments
) -> tuple[set[int], int, int]:
    progress_path = raw_dir / "_progress.json"
    controller = PageStepController(initial_t=t, initial_step_ms=initial_step_ms)
    profile_enabled = os.environ.get("HOGA_PROFILE") == "1"
    profile_path = raw_dir / "_profile.jsonl" if profile_enabled else None

    last_emitted_t = -1
    last_emitted_pages = -1
    iter_idx = 0
    while True:
        if cancel_token is not None and cancel_token.cancelled:
            raise CaptureCancelled(f"capture cancelled at page {page_idx}")
        iter_idx += 1
        t_in = controller.next_t
        step_before = controller.step_ms
        http_t0 = _time.perf_counter()
        body, page_idx, new_seqs = _fetch_and_store_page(
            raw_dir, client, code, date, t_in, page_idx, seen_seqs
        )
        http_ms = (_time.perf_counter() - http_t0) * 1000
        max_t = _max_event_time(body)
        decision = controller.observe(max_event_time=max_t, new_seqs=len(new_seqs))
        _write_progress(
            progress_path,
            last_time_ms=decision.progress_t,
            pages_done=page_idx,
            seq_count=len(seen_seqs),
            started_at=started_at,
            finished_at=None,
        )
        if profile_path is not None:
            cap_hit = max_t is not None and max_t < (t_in + step_before)
            post_window = t_in >= 160_000_000
            line = json.dumps({
                "iter": iter_idx, "t_in": t_in, "step_ms": step_before,
                "http_ms": round(http_ms, 2), "body_len": len(body),
                "new_seqs": len(new_seqs), "max_event_time": max_t,
                "cap_hit": cap_hit, "empty_streak": controller._empty_in_a_row,
                "post_window": post_window, "page_idx": page_idx,
            })
            with profile_path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        if on_progress is not None and (
            decision.progress_t != last_emitted_t or page_idx != last_emitted_pages
        ):
            on_progress(ProgressEvent(
                code=code, date=date, pages_done=page_idx,
                events_seen=len(seen_seqs), frontier=HogaMs(decision.progress_t),
            ))
            last_emitted_t = decision.progress_t
            last_emitted_pages = page_idx
        if decision.should_stop:
            break
        if rate_limit_s > 0:
            _time.sleep(rate_limit_s)

    return seen_seqs, page_idx, controller.next_t
```

Add `import json` to the imports section at the top of `orchestrator.py` if not present (it already is at line 4 — verify).

- [ ] **Step 4: 테스트 실행 — 둘 다 통과 확인**

```bash
uv run pytest tests/test_collector_orchestrator.py::test_profile_jsonl_not_created_when_env_unset tests/test_collector_orchestrator.py::test_profile_jsonl_created_and_line_format_when_env_set -v
```

Expected: PASSED 2

- [ ] **Step 5: 기존 회귀 확인**

```bash
uv run pytest tests/test_collector_orchestrator.py tests/test_page_step.py -v
```

Expected: 모든 기존 테스트 PASS (회귀 0)

- [ ] **Step 6: commit**

```bash
git add hoga/collector/orchestrator.py tests/test_collector_orchestrator.py
git commit -m "$(cat <<'EOF'
feat(collector): HOGA_PROFILE per-iteration timing JSONL

Adds opt-in (env var HOGA_PROFILE=1) per-iteration profiling that writes
_profile.jsonl alongside _progress.json. Each line carries the inputs
needed to attribute wall-clock to (http_ms vs sleep), determine cap-hit
patterns by activity period, and size the drain guard threshold.

Zero cost when HOGA_PROFILE is unset (default). Field set:
iter, t_in, step_ms, http_ms, body_len, new_seqs, max_event_time,
cap_hit, empty_streak, post_window, page_idx.

Also exposes initial_step_ms on _page_step_loop for Task 4's
collect_stock_date signature change.

Spec: docs/superpowers/specs/2026-05-23-capture-fetch-throughput-design.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 풀 baseline 캡처 2건 실행 (실험)

**Files:**
- Create: `docs/superpowers/measurements/2026-05-23-throughput/baseline-003490.json`
- Create: `docs/superpowers/measurements/2026-05-23-throughput/baseline-005930.json`
- Copy: `_profile.jsonl` 2개를 measurements/ 디렉토리로

**전제:** API 서버 (`hoga serve`)가 떠있고 cookie가 환경에 갖춰져 있음. 평일 시간대 또는 평일이 아니어도 가능 (단 외삽 가능성 확보 위해 Phase 1은 평일).

- [ ] **Step 1: 미캡처 평일 날짜 두 개 선정**

```bash
python3 - <<'PY'
import datetime as dt, glob, os
captured = {os.path.basename(os.path.dirname(p)).split('/')[-1] for p in glob.glob('/home/dev/.local/share/hoga-ops/data/raw/*/003490')}
captured5 = {os.path.basename(os.path.dirname(p)).split('/')[-1] for p in glob.glob('/home/dev/.local/share/hoga-ops/data/raw/*/005930')}
print('003490 미캡처 후보:', sorted([d for d in [(dt.date(2026,5,23)-dt.timedelta(days=k)).strftime('%Y%m%d') for k in range(1,40)] if (dt.datetime.strptime(d,'%Y%m%d').weekday()<5 and d not in captured)])[:5])
print('005930 미캡처 후보:', sorted([d for d in [(dt.date(2026,5,23)-dt.timedelta(days=k)).strftime('%Y%m%d') for k in range(1,40)] if (dt.datetime.strptime(d,'%Y%m%d').weekday()<5 and d not in captured5)])[:5])
PY
```

Expected: 후보 리스트 출력. 가장 최근 평일 한 개씩 선택 (예: 003490 → 20260429, 005930 → 20260420). 휴장일(5/1, 5/5)은 제외.

- [ ] **Step 2: HOGA_PROFILE 활성으로 백엔드 재시작**

```bash
# 기존 서버 PID 확인
ss -tlnp 2>/dev/null | grep ':8000'
# 서버 재시작 (사용자가 직접 실행 — Claude가 죽이지 않음)
# 예: kill <pid> && HOGA_PROFILE=1 uv run hoga serve --port 8000
```

⚠ 이 단계는 사용자 환경에 영향이 큰 작업이라 사용자가 직접 수행. Claude는 명령어만 제시.

- [ ] **Step 3: 003490 baseline 캡처 적재 + 모니터링**

```bash
# 적재
curl -sS -X POST http://127.0.0.1:8000/api/captures/items \
  -H 'Content-Type: application/json' \
  -d '{"code":"003490","dates":["<선정한 003490 날짜>"],"force_retry":false}' | python3 -m json.tool

# 모니터링 (별도 터미널 또는 background)
DATE=<선정한 003490 날짜>
PROG=~/.local/share/hoga-ops/data/raw/$DATE/003490/_progress.json
T0=$(date +%s)
while true; do
  if [ -f "$PROG" ]; then
    FIN=$(python3 -c "import json;print(json.load(open('$PROG')).get('finished',False))")
    PAGES=$(python3 -c "import json;print(json.load(open('$PROG')).get('pages_done',0))")
    NOW=$(date +%s); echo "[+$((NOW-T0))s] pages=$PAGES finished=$FIN"
    [ "$FIN" = "True" ] && break
  fi
  sleep 30
done
```

Expected: ~5분 후 finished=True, pages ~1271

- [ ] **Step 4: 005930 baseline 캡처 적재 + 모니터링**

Task 3 Step 3와 동일하지만 code/date만 005930과 선정한 날짜로 교체. Expected: ~9분 후 finished=True, pages ~1700~1800.

- [ ] **Step 5: 결과 산출물 정리**

```bash
mkdir -p docs/superpowers/measurements/2026-05-23-throughput/baseline
cp ~/.local/share/hoga-ops/data/raw/<003490_date>/003490/_progress.json docs/superpowers/measurements/2026-05-23-throughput/baseline/003490-progress.json
cp ~/.local/share/hoga-ops/data/raw/<003490_date>/003490/_profile.jsonl docs/superpowers/measurements/2026-05-23-throughput/baseline/003490-profile.jsonl
cp ~/.local/share/hoga-ops/data/raw/<005930_date>/005930/_progress.json docs/superpowers/measurements/2026-05-23-throughput/baseline/005930-progress.json
cp ~/.local/share/hoga-ops/data/raw/<005930_date>/005930/_profile.jsonl docs/superpowers/measurements/2026-05-23-throughput/baseline/005930-profile.jsonl
```

- [ ] **Step 6: 핵심 메트릭 추출 + summary 작성**

```bash
python3 - <<'PY' > docs/superpowers/measurements/2026-05-23-throughput/baseline/SUMMARY.md
import json, glob
for kind in ['003490', '005930']:
    p = json.load(open(f'docs/superpowers/measurements/2026-05-23-throughput/baseline/{kind}-progress.json'))
    lines = [json.loads(l) for l in open(f'docs/superpowers/measurements/2026-05-23-throughput/baseline/{kind}-profile.jsonl')]
    http_ms = sorted(l['http_ms'] for l in lines)
    p50 = http_ms[len(http_ms)//2]
    p95 = http_ms[int(len(http_ms)*0.95)]
    cap_hits = sum(1 for l in lines if l['cap_hit'])
    post_window = sum(1 for l in lines if l['post_window'])
    print(f"## {kind}")
    print(f"- pages: {p['pages_done']}")
    print(f"- seqs: {p['global_seqs_seen']}")
    print(f"- http_ms p50/p95: {p50:.1f} / {p95:.1f}")
    print(f"- cap_hits: {cap_hits} / {len(lines)} ({100*cap_hits/len(lines):.1f}%)")
    print(f"- post_window iters: {post_window}")
    print()
PY
```

- [ ] **Step 7: commit**

```bash
git add docs/superpowers/measurements/2026-05-23-throughput/baseline/
git commit -m "$(cat <<'EOF'
chore(measurements): Phase 0 baseline captures (003490 + 005930)

Full-capture baseline with HOGA_PROFILE=1 instrumentation. SUMMARY.md
records pages, seqs, http_ms p50/p95, cap-hit rate, and post-window
iteration count for both stocks. These are the reference numbers
against which Phase 1 matrix cells and Phase 2 adoption are compared.
EOF
)"
```

---

## Phase 1 — 매트릭스 실험 (Tasks 4-7)

### Task 4: `collect_stock_date`에 `step_ms` 파라미터 노출

**Files:**
- Modify: `hoga/collector/orchestrator.py` (around line 299, `collect_stock_date` definition)
- Modify: `tests/test_collector_orchestrator.py` (new test)

- [ ] **Step 1: 실패 테스트 작성**

Append to `tests/test_collector_orchestrator.py`:

```python
def test_collect_stock_date_accepts_initial_step_ms(tmp_path: Path) -> None:
    """initial_step_ms parameter threads through to PageStepController."""
    # With step_ms=120000, the first fetch is at t=84000000, the second at
    # t=84120000 (if no cap-hit). We confirm via the recorded calls.
    fake = FakeClient(
        info_body="info\n",
        first_pages={
            84000000: _row(1, 1, 1, 1001, 84001000),
            84120000: _row(1, 1, 1, 1002, 84121000),
        },
        chart_body="chart\n",
    )
    collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0, initial_step_ms=120000,
    )
    first_times = [c.time_ms for c in fake.calls if c.endpoint == "first"]
    assert first_times[:2] == [84000000, 84120000]
```

- [ ] **Step 2: 실패 확인**

```bash
uv run pytest tests/test_collector_orchestrator.py::test_collect_stock_date_accepts_initial_step_ms -v
```

Expected: FAIL with `TypeError: collect_stock_date() got an unexpected keyword argument 'initial_step_ms'`

- [ ] **Step 3: 구현 — `collect_stock_date` 시그니처에 `initial_step_ms` 추가**

`hoga/collector/orchestrator.py` 의 `collect_stock_date` (line 299):

```python
def collect_stock_date(
    *,
    client: HogaplayClientProto,
    code: str,
    date: str,
    data_dir: Path,
    rate_limit_s: float = 0.2,
    resume: bool = False,
    on_progress: Callable[[ProgressEvent], None] | None = None,
    cancel_token: CancelToken | None = None,
    initial_step_ms: int = 60000,  # NEW
) -> CollectResult:
```

그리고 `_page_step_loop` 호출 (line 348)에 인자 전달:

```python
seen_seqs, page_idx, t = _page_step_loop(
    raw_dir, client, code, date, started_at, rate_limit_s,
    seen_seqs, page_idx, t,
    on_progress=on_progress,
    cancel_token=cancel_token,
    initial_step_ms=initial_step_ms,  # NEW
)
```

- [ ] **Step 4: 테스트 + 회귀 확인**

```bash
uv run pytest tests/test_collector_orchestrator.py tests/test_page_step.py -v
```

Expected: 신규 테스트 + 기존 모두 PASS

- [ ] **Step 5: commit**

```bash
git add hoga/collector/orchestrator.py tests/test_collector_orchestrator.py
git commit -m "$(cat <<'EOF'
feat(collector): expose initial_step_ms on collect_stock_date

Threads PageStepController.initial_step_ms through collect_stock_date's
public signature so Phase 1 matrix experiments can vary the step
ceiling per cell. Defaults remain 60000 — no behaviour change for
existing callers.
EOF
)"
```

---

### Task 5: 매트릭스 실행 도구

**Files:**
- Create: `tools/run_matrix_experiment.py`

**Background:** Phase 1은 한 셀당 90초만 캡처하기 위해 가짜 `_progress.json`을 던져두고 `CancelToken`으로 자동 중단한다. `collect_stock_date`를 직접 호출 (큐 우회). 9 셀 × 3 시간대 = 27 실행.

- [ ] **Step 1: tools/run_matrix_experiment.py 작성**

```python
"""Phase 1 matrix experiment driver.

For each (rate_limit_s, initial_step_ms, start_t) cell:
  1. Set up a sandbox raw_dir under /tmp/matrix-experiment/
  2. Plant a fake _progress.json with last_time_ms=start_t to drive
     _resume_state past the data-window start.
  3. Call collect_stock_date with resume=True, cancel_token=<90s timer>.
  4. Capture exceptions (HogaplayHTTPError, CookieExpiredError) as the
     cell's outcome.
  5. Read the resulting _profile.jsonl and compute throughput,
     cap_hit_rate, http_ms_p50/p95.
  6. Sleep 60s between cells (req/sec smoothing).
  7. Abort the entire matrix on the first 429/403/503.

Output: matrix-results.json with one entry per cell.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import threading
from datetime import datetime
from pathlib import Path

from hoga.collector.client import (
    CookieExpiredError,
    HogaplayClient,
    HogaplayHTTPError,
)
from hoga.collector.orchestrator import CancelToken, collect_stock_date
from hoga.config import Config

CELL_DURATION_S = 90
COOLDOWN_S = 60
SANDBOX = Path("/tmp/matrix-experiment")
OUT = Path("docs/superpowers/measurements/2026-05-23-throughput/matrix-results.json")

# (rate_limit_s, initial_step_ms) cells
CELLS = [
    (0.2, 60000), (0.2, 120000), (0.2, 240000),
    (0.1, 60000), (0.1, 120000), (0.1, 240000),
    (0.05, 60000), (0.05, 120000), (0.05, 240000),
]
# start times in HogaMs (HHMMSSmmm): open / lunch / close
START_TIMES = [
    ("open", 90000000),     # 09:00:00.000
    ("lunch", 120000000),   # 12:00:00.000
    ("close", 152000000),   # 15:20:00.000
]
CODE = "003490"  # use 대한항공 to isolate step-ceiling effect (low activity)
DATE = "20260423"  # CHANGE to an uncaptured weekday at run time


def _plant_fake_progress(raw_dir: Path, start_t: int) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / "_progress.json").write_text(json.dumps({
        "last_time_ms": start_t, "pages_done": 0, "global_seqs_seen": 0,
        "started_at": datetime.now().isoformat(), "finished_at": None,
    }))
    # Empty info.tsv so collect_stock_date's resume branch skips info.php fetch
    (raw_dir / "info.tsv").write_text("")


def _cancel_after(token: CancelToken, seconds: float) -> None:
    threading.Timer(seconds, token.cancel).start()


def _summarize_profile(profile_path: Path) -> dict:
    if not profile_path.exists():
        return {"iters": 0}
    lines = [json.loads(l) for l in profile_path.read_text().splitlines() if l]
    if not lines:
        return {"iters": 0}
    http = sorted(l["http_ms"] for l in lines)
    return {
        "iters": len(lines),
        "pages": lines[-1]["page_idx"],
        "cap_hits": sum(1 for l in lines if l["cap_hit"]),
        "cap_hit_rate": sum(1 for l in lines if l["cap_hit"]) / len(lines),
        "http_ms_p50": http[len(http) // 2],
        "http_ms_p95": http[int(len(http) * 0.95)],
        "body_len_p50": sorted(l["body_len"] for l in lines)[len(lines) // 2],
    }


def run_cell(
    client: HogaplayClient, rate_s: float, step_ms: int, start_label: str, start_t: int
) -> dict:
    cell_id = f"r{rate_s}_s{step_ms}_{start_label}"
    sandbox = SANDBOX / cell_id
    if sandbox.exists():
        shutil.rmtree(sandbox)
    raw_dir = sandbox / "raw" / DATE / CODE
    _plant_fake_progress(raw_dir, start_t)
    token = CancelToken()
    _cancel_after(token, CELL_DURATION_S)
    os.environ["HOGA_PROFILE"] = "1"
    t0 = time.perf_counter()
    outcome = "ok"
    err_msg = None
    try:
        collect_stock_date(
            client=client, code=CODE, date=DATE, data_dir=sandbox,
            rate_limit_s=rate_s, resume=True, cancel_token=token,
            initial_step_ms=step_ms,
        )
    except HogaplayHTTPError as e:
        outcome = f"http_{e.status_code}"
        err_msg = str(e)
    except CookieExpiredError as e:
        outcome = "cookie_expired"
        err_msg = str(e)
    except Exception as e:  # noqa: BLE001
        outcome = type(e).__name__
        err_msg = str(e)
    elapsed = time.perf_counter() - t0
    summary = _summarize_profile(raw_dir / "_profile.jsonl")
    return {
        "cell_id": cell_id, "rate_s": rate_s, "step_ms": step_ms,
        "start_label": start_label, "start_t": start_t,
        "elapsed_s": round(elapsed, 1), "outcome": outcome, "err": err_msg,
        **summary,
    }


def main() -> None:
    cfg = Config.from_cwd()
    cookie = cfg.cookie()
    results: list[dict] = []
    SANDBOX.mkdir(exist_ok=True)
    with HogaplayClient(cookie=cookie) as client:
        for start_label, start_t in START_TIMES:
            for rate_s, step_ms in CELLS:
                print(f"--> cell r={rate_s} s={step_ms} start={start_label}")
                r = run_cell(client, rate_s, step_ms, start_label, start_t)
                print(json.dumps(r, indent=2))
                results.append(r)
                OUT.parent.mkdir(parents=True, exist_ok=True)
                OUT.write_text(json.dumps(results, indent=2))
                if r["outcome"].startswith("http_4") or r["outcome"].startswith("http_5") or r["outcome"] == "cookie_expired":
                    print("ABORT: throttle/block signal detected")
                    return
                time.sleep(COOLDOWN_S)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 도구 자체의 sanity check (no real fetch)**

```bash
uv run python -c "from tools.run_matrix_experiment import _summarize_profile, CELLS, START_TIMES; print(len(CELLS) * len(START_TIMES), 'cells total')"
```

Expected: `27 cells total`

- [ ] **Step 3: commit (실행 전)**

```bash
git add tools/run_matrix_experiment.py
git commit -m "$(cat <<'EOF'
chore(tools): Phase 1 matrix experiment driver

Sweeps (rate_limit_s × initial_step_ms × start_time) for 003490 with
90s/cell cancel-token bound and 60s cooldown between cells. Aborts on
the first 4xx/5xx/cookie_expired (treated as throttle signal). Writes
matrix-results.json after each cell so partial runs are preserved.

Spec §6 Time-boxed Matrix.
EOF
)"
```

---

### Task 6: 매트릭스 실험 실행 (실험)

**Files:**
- Output: `docs/superpowers/measurements/2026-05-23-throughput/matrix-results.json`

⚠ 이 task는 hogaplay에 실 트래픽을 발생시킵니다 (셀당 ~300~1800 req, 27 셀 = ~10000~50000 req). **반드시 평일 09:00~16:00 KST 안에 실행** (외삽 가능성).

- [ ] **Step 1: 실행 가능 날짜 정하기**

평일 (월~금) 09:00 이후 어느 시점에 시작. 매트릭스 1회 = (90s + 60s) × 27 = 약 67분. 시간대 3개를 한 번에 다 도는 게 깔끔 (open 부근 시작이 베스트).

`tools/run_matrix_experiment.py`의 `DATE` 상수를 실행 당일에 캡처되지 않은 평일로 변경:

```python
DATE = "<예: 20260423>"  # uncaptured weekday
```

- [ ] **Step 2: 실행 (foreground 또는 background)**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
uv run python tools/run_matrix_experiment.py 2>&1 | tee docs/superpowers/measurements/2026-05-23-throughput/matrix-run.log
```

Expected: 셀별 결과가 stdout으로 흐르며 `matrix-results.json`이 셀마다 갱신됨. 약 67분 후 종료 (정상 완료 또는 abort).

- [ ] **Step 3: 중단된 경우 — 부분 결과로 진행**

abort signal(4xx/5xx/cookie_expired)이 발생했다면 그게 곧 **안전 상한 신호**. matrix-results.json의 마지막 직전 셀까지가 안전 구간이다. spec §6.4 참조.

- [ ] **Step 4: commit**

```bash
git add docs/superpowers/measurements/2026-05-23-throughput/matrix-results.json docs/superpowers/measurements/2026-05-23-throughput/matrix-run.log
git commit -m "$(cat <<'EOF'
chore(measurements): Phase 1 matrix sweep results

27 cells (3 rate × 3 step × 3 time-of-day) for 003490 captured with
90s/cell time-box. Stdout log preserved for cell-by-cell context.
Aborted on <abort_reason_or_completed_normally>.
EOF
)"
```

---

### Task 7: 매트릭스 결과 분석 + 채택값 결정

**Files:**
- Create: `tools/analyze_matrix_results.py`
- Create: `docs/superpowers/measurements/2026-05-23-throughput/adoption-decision.md`

- [ ] **Step 1: 결과 집계 도구 작성**

```python
# tools/analyze_matrix_results.py
"""Aggregate Phase 1 matrix results into a decision table.

For each (rate_s, step_ms) cell, averages across 3 start_labels:
  pages_per_90s, cap_hit_rate, http_ms_p95, body_len_p50, outcome_count

Outputs a markdown table sorted by pages_per_90s descending, filtered
to outcome=="ok" only. The top safe cell is the adoption candidate.
"""

from __future__ import annotations

import json
from pathlib import Path
from collections import defaultdict

IN = Path("docs/superpowers/measurements/2026-05-23-throughput/matrix-results.json")


def main() -> None:
    results = json.loads(IN.read_text())
    by_cell: dict[tuple, list[dict]] = defaultdict(list)
    for r in results:
        by_cell[(r["rate_s"], r["step_ms"])].append(r)
    rows = []
    for (rate, step), runs in by_cell.items():
        ok_runs = [r for r in runs if r["outcome"] == "ok"]
        if not ok_runs:
            continue
        avg_pages = sum(r.get("pages", 0) for r in ok_runs) / len(ok_runs)
        avg_caphit = sum(r.get("cap_hit_rate", 0) for r in ok_runs) / len(ok_runs)
        avg_p95 = sum(r.get("http_ms_p95", 0) for r in ok_runs) / len(ok_runs)
        avg_body = sum(r.get("body_len_p50", 0) for r in ok_runs) / len(ok_runs)
        rows.append({
            "rate_s": rate, "step_ms": step,
            "avg_pages_per_90s": round(avg_pages, 1),
            "avg_cap_hit_rate": round(avg_caphit, 3),
            "avg_http_ms_p95": round(avg_p95, 1),
            "avg_body_len_p50": round(avg_body, 0),
            "safe_runs": len(ok_runs),
        })
    rows.sort(key=lambda r: r["avg_pages_per_90s"], reverse=True)
    print("| rate | step | pages/90s | cap_hit | http_p95 | body_p50 | safe |")
    print("|---|---|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['rate_s']} | {r['step_ms']} | {r['avg_pages_per_90s']} | {r['avg_cap_hit_rate']} | {r['avg_http_ms_p95']} | {r['avg_body_len_p50']} | {r['safe_runs']}/3 |")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 분석 실행 + 결정 markdown 작성**

```bash
uv run python tools/analyze_matrix_results.py > /tmp/matrix-table.md
```

`docs/superpowers/measurements/2026-05-23-throughput/adoption-decision.md` 작성:

```markdown
# Phase 1 Matrix Adoption Decision

## Aggregated table (3 start-times averaged)

<paste /tmp/matrix-table.md here>

## Decision

**Adopted values:**
- `DEFAULT_RATE_LIMIT_S` = <rate from top safe cell>
- `DEFAULT_PAGE_STEP_MS` = <step from top safe cell>

**Rejected cells and why:**
- (예) rate=0.05 + step=240k → cap_hit_rate 0.6 (응답이 step 못 채움, 효과 없음)
- (예) rate=0.02 → abort (HTTP 429)

**Open Question #1 (event-count cap) answer:**
- body_len_p50가 step에 비례하면 (예: 60k=12KB, 120k=24KB, 240k=48KB) → 이벤트-개수 cap 없음, step lever 유효
- body_len_p50가 step와 무관하게 plateau → 이벤트-개수 cap 있음, step lever 무효

**Open Question #2 (HogaMs overflow) answer:**
- step=120k/240k 셀이 정상 응답 → 서버가 오버플로우 너그러움
- 그 셀들이 HTTP 400 → 서버가 엄격, step 천장은 60k에 묶임
```

- [ ] **Step 3: commit**

```bash
git add tools/analyze_matrix_results.py docs/superpowers/measurements/2026-05-23-throughput/adoption-decision.md
git commit -m "$(cat <<'EOF'
chore(measurements): Phase 1 matrix aggregation + adoption decision

analyze_matrix_results.py groups cells by (rate, step), averages
across 3 start-times, filters to outcome=ok, sorts by throughput.
adoption-decision.md records the chosen DEFAULT_RATE_LIMIT_S and
DEFAULT_PAGE_STEP_MS values + rationale for rejected cells +
answers to spec Open Questions #1 (event cap) and #2 (HogaMs overflow).
EOF
)"
```

---

## Phase 2 — 채택값 풀 검증 (Task 8)

### Task 8: 풀 검증 캡처 + 회귀 비교

**Files:**
- Output: `docs/superpowers/measurements/2026-05-23-throughput/verify/*-progress.json`, `*-profile.jsonl`
- Create: `docs/superpowers/measurements/2026-05-23-throughput/verify/VERIFY.md`

**전제:** Task 7에서 결정된 채택값 `<RATE>`, `<STEP>` 확보.

- [ ] **Step 1: 환경변수로 채택값 주입한 풀 캡처 — 003490**

`hoga serve`를 직접 띄우지 않고 CLI로 (인자 직접 제어):

```bash
HOGA_PROFILE=1 uv run python -c "
from hoga.collector.client import HogaplayClient
from hoga.collector.orchestrator import collect_stock_date
from hoga.config import Config, resolve_data_dir
cfg = Config.from_cwd()
with HogaplayClient(cookie=cfg.cookie()) as c:
    r = collect_stock_date(
        client=c, code='003490', date='<uncaptured weekday>',
        data_dir=resolve_data_dir(),
        rate_limit_s=<RATE>, initial_step_ms=<STEP>,
    )
    print(r)
"
```

Expected: ≤ 2분 wall-clock, `finished=True`, pages 감소 확인.

- [ ] **Step 2: 동일 셋팅으로 005930 풀 캡처**

Step 1 명령에서 `code='003490'` → `'005930'`로만 교체. Expected: ≤ 5분.

- [ ] **Step 3: VERIFY.md 작성**

```markdown
# Phase 2 — Adopted Settings Verification

Adopted: rate_limit_s=<RATE>, initial_step_ms=<STEP>

## 003490 (대한항공)
- baseline (Phase 0): 5:12, 1271 pages
- verify: <m:ss>, <pages> pages, finished=<true|false>
- 목표 ≤ 2분: <PASS|FAIL>

## 005930 (삼성전자)
- baseline (Phase 0): 9:08, 1756 pages
- verify: <m:ss>, <pages> pages, finished=<true|false>
- 목표 ≤ 5분: <PASS|FAIL>

## post_window iteration 비교
- baseline 003490 post_window: <baseline value>
- verify 003490 post_window: <verify value>
  → drain 가드(Task 9) 도입 전 baseline 수치. 가드 도입 시 더 감소 예상.
```

- [ ] **Step 4: commit**

```bash
cp ~/.local/share/hoga-ops/data/raw/<003490_date>/003490/_progress.json docs/superpowers/measurements/2026-05-23-throughput/verify/003490-progress.json
cp ~/.local/share/hoga-ops/data/raw/<003490_date>/003490/_profile.jsonl docs/superpowers/measurements/2026-05-23-throughput/verify/003490-profile.jsonl
cp ~/.local/share/hoga-ops/data/raw/<005930_date>/005930/_progress.json docs/superpowers/measurements/2026-05-23-throughput/verify/005930-progress.json
cp ~/.local/share/hoga-ops/data/raw/<005930_date>/005930/_profile.jsonl docs/superpowers/measurements/2026-05-23-throughput/verify/005930-profile.jsonl
git add docs/superpowers/measurements/2026-05-23-throughput/verify/
git commit -m "$(cat <<'EOF'
chore(measurements): Phase 2 adopted-settings verification

Full captures of 003490 + 005930 with the Phase 1 adoption values.
Compares against baseline (Phase 0) and confirms wall-clock targets
(003490 <= 2min, 005930 <= 5min).
EOF
)"
```

---

## Phase 3 — 코드화 + 안전 가드 + ADR (Tasks 9-13)

### Task 9: stagnation 종료 가드 (v2 — Task 1 발견 반영)

**Files:**
- Modify: `hoga/collector/page_step.py` (top constants + `PageStepController.__init__` + `observe`)
- Modify: `tests/test_page_step.py` (new test)

**Background:** Task 1 분석이 spec v1의 가정을 뒤집었습니다 (`docs/superpowers/measurements/2026-05-23-throughput/drain-analysis-20260518.md` 참조). 폭주는 "post-window drain"이 아니라 hogaplay가 응답을 동결시켰을 때 `observe()`의 cap-hit 분기가 매 페이지 empty counter를 리셋해 정상 종료가 영원히 미충족되는 현상. spec §8.3 v2의 stagnation 감지 가드로 구현.

가드 동작:
- `observe()` 매 호출에서 `max_event_time`이 직전 값과 동일(또는 None) AND `new_seqs == 0`이면 `_stagnant_pages += 1`
- 둘 중 하나라도 advance했으면 `_stagnant_pages = 0`
- `_stagnant_pages >= MAX_STAGNANT_PAGES`(기본 100)이면 `should_stop = True`

- [ ] **Step 1: 실패 테스트 작성**

Append to `tests/test_page_step.py`:

```python
def test_stagnation_guard_forces_stop_when_max_frozen_and_no_new_seqs() -> None:
    """When hogaplay freezes max_event_time and returns no new seqs for
    MAX_STAGNANT_PAGES iterations, the controller forces should_stop=True."""
    from hoga.collector.page_step import PageStepController

    ctrl = PageStepController(
        initial_t=84000000,
        initial_step_ms=60000,
        max_stagnant_pages=5,  # NEW kwarg, small value for fast test
    )
    # First call: max=84050000, new_seqs=1 — establishes baseline (not stagnant)
    d0 = ctrl.observe(max_event_time=84050000, new_seqs=1)
    assert not d0.should_stop

    # Subsequent calls: same max, no new seqs → stagnant counter grows
    decisions = [d0]
    for _ in range(10):
        d = ctrl.observe(max_event_time=84050000, new_seqs=0)
        decisions.append(d)
        if d.should_stop:
            break

    assert decisions[-1].should_stop
    # 5 stagnant calls after the baseline → 6 total (baseline + 5)
    assert len(decisions) == 6


def test_stagnation_guard_resets_when_max_advances() -> None:
    """If max_event_time advances at any point, stagnant counter resets."""
    from hoga.collector.page_step import PageStepController

    ctrl = PageStepController(
        initial_t=84000000,
        initial_step_ms=60000,
        max_stagnant_pages=3,
    )
    ctrl.observe(max_event_time=84050000, new_seqs=1)
    # 2 stagnant pages (under threshold)
    ctrl.observe(max_event_time=84050000, new_seqs=0)
    ctrl.observe(max_event_time=84050000, new_seqs=0)
    # Advance: max moves forward → reset
    ctrl.observe(max_event_time=84100000, new_seqs=2)
    # Now 3 more stagnant — should still NOT stop (counter was reset)
    d1 = ctrl.observe(max_event_time=84100000, new_seqs=0)
    d2 = ctrl.observe(max_event_time=84100000, new_seqs=0)
    d3 = ctrl.observe(max_event_time=84100000, new_seqs=0)
    # Should stop on the 4th post-reset stagnant call (threshold=3 → exceeds after 3)
    # Actually with threshold=3, the 3rd stagnant call hits should_stop:
    assert not d1.should_stop  # 1 stagnant
    assert not d2.should_stop  # 2 stagnant
    assert d3.should_stop      # 3 stagnant → stop
```

- [ ] **Step 2: 실패 확인**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
uv run pytest tests/test_page_step.py::test_stagnation_guard_forces_stop_when_max_frozen_and_no_new_seqs tests/test_page_step.py::test_stagnation_guard_resets_when_max_advances -v
```

Expected: FAIL (`TypeError: __init__() got an unexpected keyword argument 'max_stagnant_pages'`).

- [ ] **Step 3: 구현 — page_step.py 수정**

상단 상수 추가:

```python
# hoga/collector/page_step.py 상단
MAX_STAGNANT_PAGES = 200  # see spec §8.3 v2 — guards against hogaplay response freeze (raised from initial 100 after Phase 0 baseline showed normal captures reach stagnant streaks up to 130; ×1.5 margin)
```

`PageStepController.__init__` 시그니처 + 본문 수정:

```python
def __init__(
    self,
    *,
    initial_t: int,
    initial_step_ms: int = DEFAULT_PAGE_STEP_MS,
    min_step_ms: int = MIN_PAGE_STEP_MS,
    data_window_end_ms: int = DATA_WINDOW_END_MS,
    termination_empty_pages: int = TERMINATION_EMPTY_PAGES,
    max_stagnant_pages: int = MAX_STAGNANT_PAGES,
) -> None:
    self._t = initial_t
    self._step_ms = initial_step_ms
    self._initial_step_ms = initial_step_ms
    self._min_step_ms = min_step_ms
    self._data_window_end_ms = data_window_end_ms
    self._termination_empty_pages = termination_empty_pages
    self._max_stagnant = max_stagnant_pages
    self._empty_in_a_row = 0
    self._stagnant_pages = 0
    self._last_max_event_time: int | None = None
```

`observe` 의 본문 — 진입 시 stagnation 업데이트 + `should_stop`에 OR 조건 추가:

```python
def observe(self, *, max_event_time: int | None, new_seqs: int) -> StepDecision:
    # Update stagnation counter (must run BEFORE cap-hit branch which may not return early changes)
    if max_event_time == self._last_max_event_time and new_seqs == 0:
        self._stagnant_pages += 1
    else:
        self._stagnant_pages = 0
    self._last_max_event_time = max_event_time

    target = self._t + self._step_ms
    cap_hit = (
        max_event_time is not None
        and max_event_time < target
        and self._step_ms > self._min_step_ms
        and self._t < self._data_window_end_ms
    )
    if cap_hit:
        self._step_ms = max(self._step_ms // 2, self._min_step_ms)
        self._t = self._t + self._step_ms
        self._empty_in_a_row = 0
        # NEW: even in cap-hit branch, stagnation guard can fire
        if self._stagnant_pages >= self._max_stagnant:
            return StepDecision(progress_t=self._t, should_stop=True)
        return StepDecision(progress_t=self._t, should_stop=False)

    # Normal advance (unchanged from existing code)
    if new_seqs == 0:
        self._empty_in_a_row += 1
    else:
        self._empty_in_a_row = 0
        if self._step_ms < self._initial_step_ms:
            self._step_ms = min(self._step_ms * 2, self._initial_step_ms)
    progress_t = self._t
    self._t += self._step_ms
    should_stop = (
        self._t >= self._data_window_end_ms
        and self._empty_in_a_row >= self._termination_empty_pages
    ) or self._stagnant_pages >= self._max_stagnant
    return StepDecision(progress_t=progress_t, should_stop=should_stop)
```

- [ ] **Step 4: 테스트 + 회귀 확인**

```bash
uv run pytest tests/test_page_step.py tests/test_collector_orchestrator.py -v
```

Expected: 신규 2 테스트 + 기존 모두 PASS. 만약 기존 cap-detection 테스트가 stagnation 가드와 상호작용하면 (예: `_CAP_RETRY_LOW`/`_CAP_RETRY_HIGH` 시나리오에서 max가 정지된 채 cap-hit 반복) → 해당 테스트의 fake first_pages를 max가 advance하도록 조정 또는 `max_stagnant_pages=999999`로 충분히 크게 우회.

- [ ] **Step 5: commit**

```bash
git add hoga/collector/page_step.py tests/test_page_step.py
git commit -m "$(cat <<'EOF'
feat(page_step): stagnation termination guard (max_event_time freeze)

Adds MAX_STAGNANT_PAGES=100 guard. Task 1's post-hoc analysis of the
20260518/003490 runaway capture (drain-analysis-20260518.md) showed
that spec v1's "post-window iteration cap" was based on a wrong
assumption — hogaplay froze its response at t≈09:03:45, max_event_time
never advanced, observe()'s cap-hit branch reset empty_in_a_row every
page, and t never reached data_window_end. Result: 3829 wasted pages
before the capture was killed externally.

The v2 stagnation guard fires when max_event_time stays equal to its
previous value AND new_seqs==0 for MAX_STAGNANT_PAGES consecutive calls,
regardless of whether the cap-hit branch is active. Counter resets the
moment either signal advances.

Spec §8.3 (v2).
Measurement: docs/superpowers/measurements/2026-05-23-throughput/drain-analysis-20260518.md
EOF
)"
```

---

### Task 10: 차단 감지 시 자동 백오프

**Files:**
- Modify: `hoga/collector/orchestrator.py` (`_page_step_loop`의 fetch try/except)
- Modify: `tests/test_collector_orchestrator.py` (new test using FakeClient)

- [ ] **Step 1: 실패 테스트 작성**

Append to `tests/test_collector_orchestrator.py`:

```python
def test_collect_backs_off_rate_limit_on_429(tmp_path: Path) -> None:
    """When hogaplay returns 429, rate_limit_s doubles for the next N pages,
    then restores to the configured value if no further 4xx occurs."""
    from hoga.collector.client import HogaplayHTTPError

    class ThrottlingFake(FakeClient):
        def __init__(self) -> None:
            super().__init__(
                info_body="info\n",
                first_pages={
                    84000000: _row(1, 1, 1, 1001, 84001000),
                    84060000: _row(1, 1, 1, 1002, 84061000),
                    84120000: _row(1, 1, 1, 1003, 84121000),
                },
                chart_body="chart\n",
            )
            self.throttle_at_iter = 2
            self._iter = 0

        def fetch_first(self, code: str, date: str, time_ms: int) -> str:
            self._iter += 1
            if self._iter == self.throttle_at_iter:
                raise HogaplayHTTPError("throttled", status_code=429)
            return super().fetch_first(code, date, time_ms)

    fake = ThrottlingFake()
    # rate_limit_s starts at 0 so timing is dominated by backoff.
    result = collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0,
    )
    # The capture should complete (not crash), and the 429 must have been
    # absorbed by backoff (retry of the same time_ms).
    first_calls = [c.time_ms for c in fake.calls if c.endpoint == "first"]
    # The throttled time_ms should appear twice (retry after backoff).
    from collections import Counter
    counts = Counter(first_calls)
    assert any(c == 2 for c in counts.values()), "throttled page should be retried after backoff"
```

- [ ] **Step 2: 실패 확인**

```bash
uv run pytest tests/test_collector_orchestrator.py::test_collect_backs_off_rate_limit_on_429 -v
```

Expected: FAIL — 현재 HogaplayHTTPError가 그대로 전파되어 캡처가 죽음.

- [ ] **Step 3: 구현 — `_page_step_loop`의 fetch try/except 추가**

`hoga/collector/orchestrator.py`의 상단에 import 추가 (이미 있으면 생략):

```python
from hoga.collector.client import HogaplayHTTPError
```

상단 상수 추가:

```python
THROTTLE_BACKOFF_FACTOR = 2.0
THROTTLE_BACKOFF_HOLD_PAGES = 10  # Open Question #3: revisit if Phase 2 says otherwise
THROTTLED_STATUSES = frozenset({429, 503})
```

`_page_step_loop` 본문을 다음과 같이 수정 — 루프 진입 전에 `backoff_remaining = 0` 로컬 변수 선언, fetch 호출을 try/except로 감싸 throttle 분기, effective_rate를 backoff 여부로 결정해 sleep:

```python
def _page_step_loop(
    raw_dir: Path,
    client: HogaplayClientProto,
    code: str,
    date: str,
    started_at: str,
    rate_limit_s: float,
    seen_seqs: set[int],
    page_idx: int,
    t: int,
    on_progress: Callable[[ProgressEvent], None] | None = None,
    cancel_token: CancelToken | None = None,
    initial_step_ms: int = 60000,
) -> tuple[set[int], int, int]:
    progress_path = raw_dir / "_progress.json"
    controller = PageStepController(initial_t=t, initial_step_ms=initial_step_ms)
    profile_enabled = os.environ.get("HOGA_PROFILE") == "1"
    profile_path = raw_dir / "_profile.jsonl" if profile_enabled else None

    last_emitted_t = -1
    last_emitted_pages = -1
    iter_idx = 0
    backoff_remaining = 0  # NEW: countdown of pages held at doubled rate after a 429/503
    while True:
        if cancel_token is not None and cancel_token.cancelled:
            raise CaptureCancelled(f"capture cancelled at page {page_idx}")
        iter_idx += 1
        t_in = controller.next_t
        step_before = controller.step_ms
        try:
            http_t0 = _time.perf_counter()
            body, page_idx, new_seqs = _fetch_and_store_page(
                raw_dir, client, code, date, t_in, page_idx, seen_seqs
            )
            http_ms = (_time.perf_counter() - http_t0) * 1000
        except HogaplayHTTPError as e:
            if e.status_code in THROTTLED_STATUSES:
                _time.sleep(max(rate_limit_s * THROTTLE_BACKOFF_FACTOR, 1.0))
                backoff_remaining = THROTTLE_BACKOFF_HOLD_PAGES
                iter_idx -= 1
                continue  # retry same t_in, do not advance controller
            raise
        max_t = _max_event_time(body)
        decision = controller.observe(max_event_time=max_t, new_seqs=len(new_seqs))
        # ... (existing _write_progress + profile-write + on_progress logic from Task 2) ...
        effective_rate = (rate_limit_s * THROTTLE_BACKOFF_FACTOR) if backoff_remaining > 0 else rate_limit_s
        if backoff_remaining > 0:
            backoff_remaining -= 1
        if decision.should_stop:
            break
        if effective_rate > 0:
            _time.sleep(effective_rate)

    return seen_seqs, page_idx, controller.next_t
```

- [ ] **Step 4: 테스트 + 회귀 확인**

```bash
uv run pytest tests/test_collector_orchestrator.py tests/test_page_step.py -v
```

Expected: 신규 테스트 + 기존 모두 PASS

- [ ] **Step 5: commit**

```bash
git add hoga/collector/orchestrator.py tests/test_collector_orchestrator.py
git commit -m "$(cat <<'EOF'
feat(collector): throttle-aware rate_limit backoff on 429/503

On HogaplayHTTPError with status_code in {429, 503}, double rate_limit_s
for the next 10 pages then restore. Throttled iteration is retried (same
t_in, no controller advance). Prevents a single transient throttle from
killing a long-running capture and gives hogaplay breathing room without
abandoning the entire Stock-Date.

Spec §8.2.
EOF
)"
```

---

### Task 11: DEFAULT_RATE_LIMIT_S / DEFAULT_PAGE_STEP_MS 상수 변경

**Files:**
- Modify: `hoga/collector/orchestrator.py` (default of `rate_limit_s`)
- Modify: `hoga/collector/page_step.py` (`DEFAULT_PAGE_STEP_MS`)
- Modify: `tests/test_collector_orchestrator.py` (회귀 갱신)

**Background:** Task 7 (adoption-decision.md)에서 결정된 `<RATE>`와 `<STEP>` 값을 사용.

- [ ] **Step 1: 상수 변경**

`hoga/collector/orchestrator.py`:

```python
def collect_stock_date(
    *,
    ...,
    rate_limit_s: float = <RATE>,  # was 0.2
    ...,
    initial_step_ms: int = <STEP>,  # was 60000
) -> CollectResult:
```

`hoga/collector/page_step.py`:

```python
DEFAULT_PAGE_STEP_MS = <STEP>  # was 60000
```

- [ ] **Step 2: 테스트 회귀 확인**

```bash
uv run pytest tests/ -v 2>&1 | tail -30
```

Expected: 모든 테스트 PASS. 만약 cap-detection 테스트가 새 step에서 의도된 cap-hit 시나리오를 잃으면 (예: `_CAP_RETRY_LOW = 84015001`이 새 step 기준으로 cap-hit을 트리거 안 함) → 해당 테스트의 magic 값을 새 step에 맞춰 갱신.

- [ ] **Step 3: commit**

```bash
git add hoga/collector/orchestrator.py hoga/collector/page_step.py tests/test_collector_orchestrator.py
git commit -m "$(cat <<'EOF'
feat(collector): adopt tuned rate_limit_s=<RATE> + page_step_ms=<STEP>

Phase 1 matrix sweep (003490, 3 time-of-day × 9 cells) + Phase 2 full
verification (003490 <m:ss>, 005930 <m:ss>) established these as the
fastest safe values — no 4xx/429/503 observed across 27 sweep cells +
2 full-verify captures.

Wall-clock impact (003490): baseline 5:12 → verify <m:ss> (XX%).

See:
- adoption-decision.md (Phase 1 rationale)
- verify/VERIFY.md (Phase 2 confirmation)
EOF
)"
```

---

### Task 12: ADR-0017 작성

**Files:**
- Create: `docs/adr/0017-capture-fetch-throughput.md`

- [ ] **Step 1: ADR 작성**

`docs/adr/0017-capture-fetch-throughput.md`:

```markdown
# ADR-0017 — Capture fetch throughput tuning

## Status
Accepted (2026-05-XX)

## Context
한 Stock-Date 캡처(`collect_stock_date`)의 wall-clock이 5~10분에 달해
`/capture` 사용자에게 답답함을 유발. 진단 결과 페이지당 ~0.27s 중
rate_limit sleep이 72~81%, HTTP 자체는 ~46~80ms로 인프라는 이미 효율적.
3개의 직교 lever(rate_limit, step 천장, drain 가드)를 식별하여 측정·실험·튜닝.

## Decision

### 채택값
- `DEFAULT_RATE_LIMIT_S` = `<RATE>` (was 0.2)
- `DEFAULT_PAGE_STEP_MS` = `<STEP>` (was 60000)
- `MAX_DRAIN_ITERATIONS_AFTER_WINDOW_END` = `<MAX_DRAIN>` (new)

### 근거
- Phase 1 매트릭스: 003490, 3 시간대 × 9 셀 (rate ∈ {0.2,0.1,0.05} × step ∈ {60k,120k,240k}). 채택값은 outcome=ok 셀 중 throughput 최상.
- Phase 2 풀 검증: 003490 5:12 → `<verify_time>` / 005930 9:08 → `<verify_time>`
- 4xx/429/503 발생 0건

### 안전 가드
1. 차단(429/503) 발생 시 자동 백오프: rate_limit ×2, 10페이지 동안 holding, 이후 복귀.
2. drain 가드: window-end 이후 `<MAX_DRAIN>` iteration 초과 시 강제 종료.

## Alternatives considered
- **종목-날짜 워커 풀(Plan B)**: 단일 캡처 latency 미단축. 본 spec의 단일-프로세스 안전 한계를 worker 수로 곱하면 req/sec 한계를 초과하므로 본 ADR과 함께 적용 시 rate_limit 재산정 필요. 별도 ADR로 미룸.
- **낙관적 page pipelining**: PageStep cap-hit의 의존성으로 구현 복잡도가 높고, 위 채택값이 이미 목표 달성. YAGNI.
- **HTTP 인프라 (HTTP/2, gzip)**: httpx keep-alive는 이미 적용되어 있고 HTTP 비중이 작음. ROI 낮음.

## Consequences
- 평시 captures 시간 ~60% 단축 (목표 KPI 충족).
- 차단 자동 백오프 도입으로 transient 4xx 발생 시 capture 생존성 ↑ (단 누적 발생 시 동일 페이지 무한 retry 위험 — Open Question #3 후속에서 회수 정책 검토).
- 워커 풀 도입(Plan B) 시 본 ADR의 `<RATE>`를 **req/sec** 단위로 환산하여 풀 크기와 곱해야 안전.

## References
- Spec: `docs/superpowers/specs/2026-05-23-capture-fetch-throughput-design.md`
- Plan: `docs/superpowers/plans/2026-05-23-capture-fetch-throughput.md`
- Measurements: `docs/superpowers/measurements/2026-05-23-throughput/`
- Predecessor: CONTEXT.md "Page Step" entry (line 36-37)
```

- [ ] **Step 2: commit**

```bash
git add docs/adr/0017-capture-fetch-throughput.md
git commit -m "$(cat <<'EOF'
docs(adr): ADR-0017 capture fetch throughput tuning

Records rate_limit/page_step/drain-guard adoption values + rationale
(Phase 1 matrix + Phase 2 verify), alternatives considered (worker
pool, pipelining, HTTP/2), and forward-compatibility note for Plan B
(rate must be re-expressed as req/sec when worker pool lands).
EOF
)"
```

---

### Task 13: 최종 정리

**Files:**
- Update: `CONTEXT.md` (Page Step 항목의 default 값 갱신)
- Decide: `tools/*.py`의 보존 여부

- [ ] **Step 1: CONTEXT.md의 Page Step 항목 갱신**

`CONTEXT.md` line 36-37:

```markdown
**Page Step**:
The increment applied to the `time` query parameter between successive collector calls. Variable, not fixed. Default <STEP>ms (set by ADR-0017 from Phase 1 matrix sweep, raised from the original 60000 = hogaplay's UI step); collector halves the step on cap-hit and doubles back up to the default.
```

- [ ] **Step 2: tools/ 보존 결정**

세 도구의 운명:
- `tools/analyze_drain.py` — 일회성, raw 20260518 분석. **삭제** (분석 결과는 measurements/에 보존됨).
- `tools/run_matrix_experiment.py` — 재현 가능성을 위해 **보존** (rate_limit/step 재튜닝 시 재사용).
- `tools/analyze_matrix_results.py` — 동일하게 **보존**.

```bash
git rm tools/analyze_drain.py
```

- [ ] **Step 3: commit**

```bash
git add CONTEXT.md tools/
git commit -m "$(cat <<'EOF'
docs(context): Page Step default updated to <STEP>ms per ADR-0017

CONTEXT.md glossary now reflects the tuned default. analyze_drain.py
deleted (one-shot post-hoc analysis preserved in measurements/);
run_matrix_experiment.py + analyze_matrix_results.py retained for
future re-tuning runs.
EOF
)"
```

- [ ] **Step 4: 전체 회귀 확인**

```bash
uv run pytest tests/ -v 2>&1 | tail -10
```

Expected: 모든 테스트 PASS.

- [ ] **Step 5: 최종 git log 확인**

```bash
git log --oneline -15
```

Expected: 13 + spec 커밋 + (사용자 unrelated 변경 제외) 총 14개 커밋.

---

## Acceptance Criteria

- [ ] 003490 wall-clock ≤ 2분 (Phase 2 VERIFY.md에서 PASS)
- [ ] 005930 wall-clock ≤ 5분 (Phase 2 VERIFY.md에서 PASS)
- [ ] 실험 중 4xx/429/403/503 발생 0건 (matrix-results.json 전수)
- [ ] 모든 기존 테스트 PASS + 신규 3건 PASS (drain 가드, instrumentation 2건, step_ms 인자, 백오프)
- [ ] ADR-0017 작성 완료
- [ ] CONTEXT.md Page Step 갱신
- [ ] 차단 자동 백오프 동작 (Task 10 테스트)
- [ ] drain 가드 동작 (Task 9 테스트, 20260518류 폭주 재현 시 가드 작동)
