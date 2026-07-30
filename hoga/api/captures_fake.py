"""FakeHogaplayClient — used only when HOGA_ENABLE_TEST_ENDPOINTS=1.

Implements HogaplayClientProto by **replaying the real fixture**
(`tests/fixtures/tiny_tsv_multi/<code>/`) with rewritten timestamps, so a fake
capture走 the same parser and invariant path a real one does.

Why replay instead of synthesizing (2026-07-31): the previous fake invented its
own wire shapes and **no capture could ever succeed**.

* `fetch_info` returned a 4-line ``key\\tvalue`` block; the parser wants a single
  **22-field** row → ``FieldCountError: info row expects >=22 fields, got 5``.
* `fetch_first` emitted 7-field rows with ``event_type=1``; that type wants
  **18 fields** → ``ParserError: event_type=1 expects 18 fields, got 7``.
* Only 5 pages were emitted, all with event times near 09:00. The page-step
  loop's normal exit is EMPTY_STREAK — *the collector's own cursor* ``t`` past
  the Data Window end, **plus** N empty pages. ``t`` starts at 08:40 and
  advances by ``DEFAULT_PAGE_STEP_MS`` (60000) **per page**, so crossing 16:00
  takes ~1,267 pages no matter what the payload says. 5 pages then empties =
  a flat frontier well inside the window = the stagnation guard, and the run
  ended ``finished=false, abort_reason="stagnation_abort"`` → CLIENT_INCOMPLETE.

Fixing only one of the three keeps the capture broken, which is why
`range-capture` / `cookie-pause` sat behind `test.fixme` for a day. The fixture
is the single source of truth for all three at once — it is the same data
`/api/test/add-stockdate` already parses successfully.
"""
from __future__ import annotations

import time
from functools import lru_cache
from pathlib import Path

from hoga.collector.client import CookieExpiredError
from hoga.collector.page_step import DATA_WINDOW_END_MS, DEFAULT_PAGE_STEP_MS
from hoga.util.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms

_WINDOW_START_MS = 84000000  # 08:40:00.000 — DATA_WINDOW_START_MS 와 동일

# 비어 있지 않은 페이지 수 — **윈도우에서 계산한다**(매직넘버 금지).
# 수집기 커서 t 는 페이지마다 DEFAULT_PAGE_STEP_MS 씩만 전진하므로, 윈도우를 건너려면
# 그만큼의 페이지가 필요하다(실측 ~1,267). 여유 20% 를 얹어 커서가 끝을 확실히 넘긴 뒤
# 빈 페이지로 넘어가게 한다. 실측: 수집 0.6s + 파싱 0.3s (rate limit 0).
_VISIBLE_PAGES = int(
    (DATA_WINDOW_END_MS - _WINDOW_START_MS) / DEFAULT_PAGE_STEP_MS * 1.2
)

# 첫 몇 페이지만 페이싱한다 — 진행률이 눈에 보이게 하되, 1,200여 페이지 전부에 sleep 을
# 걸면 e2e 예산을 통째로 날린다.
_PAGE_SLEEP_S = 0.025
_PACED_PAGES = 5

# 열 인덱스는 orchestrator 와 같은 계약이다(_IDX_GLOBAL_SEQ / _IDX_EVENT_TIME).
_IDX_GLOBAL_SEQ = 3
_IDX_EVENT_TIME = 4

# 시각 재작성은 HHMMSSmmm 산술이 아니라 실제 시각으로 변환해서 한다 — 원시 덧셈은
# 90000000+60000=90060000("09:00:60.000") 같은 불가능한 값을 만든다. 날짜는 변환에만
# 쓰이고 결과(HHMMSSmmm)에는 남지 않으므로 고정값이면 충분하다.
_ENCODE_DATE = "20260601"

# 마지막 페이지의 이벤트 시각이 윈도우 끝(16:00)을 **넘도록** 5분 여유를 둔다.
_SPAN_MS = (
    hhmmssms_to_unix_ms(_ENCODE_DATE, DATA_WINDOW_END_MS)
    - hhmmssms_to_unix_ms(_ENCODE_DATE, _WINDOW_START_MS)
    + 5 * 60_000
)

# Cross-instance counter and trigger for cookie-expiry injection.
# Used by /api/test/cookie_expire_at so a Playwright spec can deterministically
# exercise the cookie-pause path. None disables injection.
_global_first_calls = 0
_raise_on_request_index: int | None = None


def configure_fake_to_raise_on(request_index: int | None) -> None:
    """Cause the fake to raise CookieExpiredError on its Nth global
    fetch_first call. Pass None (or a negative value) to disable.
    """
    global _raise_on_request_index, _global_first_calls  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
    _raise_on_request_index = request_index if (request_index is not None and request_index > 0) else None
    _global_first_calls = 0


def _fixtures_root() -> Path:
    """`tests/fixtures/tiny_tsv_multi` — test_routes 와 같은 방식으로 위로 걸어 찾는다."""
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        candidate = parent / "tests" / "fixtures" / "tiny_tsv_multi"
        if candidate.is_dir():
            return candidate
    raise RuntimeError(
        "tiny_tsv_multi fixtures not found — FakeHogaplayClient replays them. "
        "(설치된 휠에는 테스트 픽스처가 없다; 이 fake 는 저장소 체크아웃 전용이다.)"
    )


@lru_cache(maxsize=8)
def _fixture(code: str, name: str) -> str:
    """픽스처 파일 본문. 해당 code 가 없으면 005930 으로 폴백한다 —
    스펙이 고르는 종목과 픽스처 보유 종목을 따로 관리하지 않기 위해서."""
    root = _fixtures_root()
    path = root / code / name
    if not path.exists():
        path = root / "005930" / name
    return path.read_text(encoding="utf-8")


@lru_cache(maxsize=8)
def _page_rows(code: str) -> tuple[tuple[list[str], int], ...]:
    """(필드들, 원본 이벤트시각 unix_ms) 목록. 페이지마다 이걸 시프트해 재생한다."""
    out: list[tuple[list[str], int]] = []
    for line in _fixture(code, "first_001.tsv").splitlines():
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) <= _IDX_EVENT_TIME:
            continue
        try:
            t = hhmmssms_to_unix_ms(_ENCODE_DATE, int(parts[_IDX_EVENT_TIME]))
        except ValueError:
            continue
        out.append((parts, t))
    if not out:
        raise RuntimeError("fixture first_001.tsv has no usable rows")
    return tuple(out)


class FakeHogaplayClient:
    """Fixture-replaying hogaplay stub. Single-instance reuse fine."""

    def __init__(self) -> None:
        self._first_call = 0

    def fetch_info(self, code: str, date: str) -> str:
        del date
        return _fixture(code, "info.tsv")

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        global _global_first_calls  # noqa: PLW0603 — 문서화된 프로세스 싱글턴 재바인딩
        del date, time_ms
        self._first_call += 1
        _global_first_calls += 1
        if _raise_on_request_index is not None and _global_first_calls == _raise_on_request_index:
            raise CookieExpiredError("fake cookie expiry (test injection)")
        if self._first_call > _VISIBLE_PAGES:
            # Empty page → collector's drain loop. 앞선 페이지들이 이미 윈도우 끝을
            # 넘겼으므로 여기서의 빈 페이지는 EMPTY_STREAK(정상 종료)로 읽힌다.
            return ""
        if self._first_call <= _PACED_PAGES:
            time.sleep(_PAGE_SLEEP_S)

        rows = _page_rows(code)
        base = rows[0][1]
        # n번째 페이지를 윈도우 위에 균등 배치. 이벤트 시각을 이렇게 전진시키는 이유는
        # 두 가지다 — ① 프론티어가 멈추면(같은 시각 반복) 정체 가드에 걸린다
        # ② max_event_time 이 t+step 에 못 미치면 cap-hit 로 step 이 절반이 되어 커서가
        #    더 느리게 가고 필요한 페이지 수가 폭증한다.
        page_start = hhmmssms_to_unix_ms(_ENCODE_DATE, _WINDOW_START_MS) + (
            _SPAN_MS * (self._first_call - 1) // max(1, _VISIBLE_PAGES - 1)
        )
        # 페이지마다 seq 를 새로 준다 — 같은 seq 가 다시 오면 수집기는 "새 이벤트 없음"
        # 으로 보고 정체로 판정한다(중복 제거가 seq 기준이다).
        seq_base = self._first_call * 10_000
        out: list[str] = []
        for i, (parts, t) in enumerate(rows):
            fields = list(parts)
            fields[_IDX_EVENT_TIME] = str(
                unix_ms_to_hhmmssms(_ENCODE_DATE, page_start + (t - base))
            )
            fields[_IDX_GLOBAL_SEQ] = str(seq_base + i)
            out.append("\t".join(fields))
        return "\n".join(out) + "\n"

    def fetch_chart(
        self,
        code: str,
        date: str,
        time_ms: int,
        bong: int = 1,
        gap: int = 60000,
    ) -> str:
        del time_ms, bong, gap, date
        return _fixture(code, "chart.tsv")
