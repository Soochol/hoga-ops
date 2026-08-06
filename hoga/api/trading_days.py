"""거래일 달력 소스 — **정적 시드 + data_dir 오버레이** (PR-H · #1044).

KIS `chk-holiday`(`kis_holidays.py`) 대체. 근본적인 차이는 TR 이 아니라 **조회
경로에 벤더가 없다**는 것이다.

## 이 구조가 지우는 것

KIS 판은 조회 때마다 원격을 때렸고, 그래서 이런 것들이 필요했다:

    월 캐시 · 실패 음성 캐시(60s TTL) · TradingDayUnavailableError ·
    자격증명 결여 vs 일시 장애 갈래(#976) · 평일 폴백

**조회 경로에 벤더가 없으면 "일시 장애" 라는 사건 자체가 없다.** 파일은 읽히거나
없거나 둘 중 하나이고, 없으면 그건 배포 사고이지 재시도할 일이 아니다. 그래서
#976 이 세운 두 갈래("영구 결여는 평일 폴백 · 일시 장애는 fail-fast") 중 **일시
장애 쪽이 통째로 사라진다**.

그리고 **자격증명 없이도 달력이 정확하다.** dev 무자격 관례(ADR-0134)에서 지금까지
휴장일 정확도를 포기하고 평일 폴백을 쓰던 경로가 그냥 맞는 답을 낸다.

남는 불확실성은 하나뿐이다: **파일이 덮는 범위 밖**. 그건 진짜 모르는 것이라
`None` 으로 답한다.

## 두 층

    시드    hoga/api/trading_days_seed.txt   리포에 커밋. 2007년~생성일.
    오버레이 <data_dir>/calendar/trading_days.txt   스케줄러가 덧붙인다.

시드만으로는 커밋 시점 이후가 비고, 그 구간을 "거래일 아님" 으로 답하면 **조용히
틀린다**(빈 캔들이 진실처럼 그려진다). 그래서 커버리지 끝을 넘는 질의는 `None` 이다.
오버레이가 그 끝을 하루씩 밀어 준다.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

log = logging.getLogger(__name__)

SEED_PATH = Path(__file__).with_name("trading_days_seed.txt")

_lock = threading.Lock()
_seed: frozenset[str] | None = None
_overlay: dict[Path, tuple[float, frozenset[str]]] = {}

_DATE_LEN = 8


def parse_seed(text: str) -> frozenset[str]:
    """`#` 주석과 빈 줄을 걷어내고 YYYYMMDD 만 남긴다."""
    out: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if len(line) == _DATE_LEN and line.isdigit():
            out.add(line)
    return frozenset(out)


def _load_seed() -> frozenset[str]:
    global _seed  # noqa: PLW0603 — 문서화된 프로세스 싱글턴
    if _seed is not None:
        return _seed
    with _lock:
        if _seed is None:
            try:
                _seed = parse_seed(SEED_PATH.read_text(encoding="utf-8"))
            except OSError:
                # 배포 사고다 — 재시도할 일이 아니라 눈에 띄어야 한다.
                log.exception("거래일 시드를 읽지 못했다: %s", SEED_PATH)
                _seed = frozenset()
        return _seed


def overlay_path(data_dir: Path) -> Path:
    return data_dir / "calendar" / "trading_days.txt"


def _load_overlay(data_dir: Path | None) -> frozenset[str]:
    """오버레이는 스케줄러가 덧붙이므로 **mtime 으로 갱신을 본다**.

    프로세스가 하루를 넘겨 살아 있는 것이 정상 운영이라(systemd 상시), 한 번
    읽고 캐시해 버리면 그 프로세스는 새 거래일을 영원히 모른다.
    """
    if data_dir is None:
        return frozenset()
    path = overlay_path(data_dir)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return frozenset()
    with _lock:
        cached = _overlay.get(path)
        if cached is not None and cached[0] == mtime:
            return cached[1]
        try:
            days = parse_seed(path.read_text(encoding="utf-8"))
        except OSError:
            return frozenset()
        _overlay[path] = (mtime, days)
        return days


def trading_days(data_dir: Path | None = None) -> frozenset[str]:
    """시드 ∪ 오버레이."""
    return _load_seed() | _load_overlay(data_dir)


def coverage_end(data_dir: Path | None = None) -> str | None:
    """달력이 답할 수 있는 **마지막 날짜**. 그 뒤는 모른다.

    시드의 최대 거래일이 아니라 **생성 시점까지 덮었다**는 뜻이라, 마지막 거래일
    이후의 휴장일도 답할 수 있어야 한다. 그런데 시드 파일에는 거래일만 있으므로
    최대 거래일을 끝으로 삼는다 — 그 다음 날부터는 "아직 안 열렸을 수도, 휴장일
    수도" 라서 정직하게 모른다고 답하는 편이 낫다.
    """
    days = trading_days(data_dir)
    return max(days) if days else None


def is_trading_day(date_yyyymmdd: str, data_dir: Path | None = None) -> bool | None:
    """True/False, 커버리지 밖이면 None.

    **커버리지 밖을 False 로 답하면 조용히 틀린다** — 진짜 거래일이 "휴장" 으로
    읽혀 빈 캔들이 진실처럼 그려진다. 모르는 것은 모른다고 말한다.
    """
    days = trading_days(data_dir)
    if not days:
        return None
    if date_yyyymmdd in days:
        return True
    return False if date_yyyymmdd <= max(days) else None


def append_overlay(data_dir: Path, new_days: list[str]) -> int:
    """스케줄러가 새 거래일을 덧붙인다. 실제로 추가된 개수를 돌려준다.

    시드에 이미 있는 날짜는 쓰지 않는다 — 오버레이는 **시드 이후만** 담는다.
    """
    known = trading_days(data_dir)
    fresh = sorted({d for d in new_days if len(d) == _DATE_LEN and d.isdigit()} - known)
    if not fresh:
        return 0
    path = overlay_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for d in fresh:
            fh.write(d + "\n")
    with _lock:
        _overlay.pop(path, None)   # mtime 이 바뀌었으니 다음 읽기에서 다시 읽는다
    return len(fresh)


def reset_for_tests() -> None:
    global _seed  # noqa: PLW0603 — 문서화된 프로세스 싱글턴
    with _lock:
        _seed = None
        _overlay.clear()


async def refresh_overlay(data_dir: Path) -> int:
    """현재 달의 거래일을 키움 `ka20006` 에서 받아 오버레이에 덧붙인다.

    **조회 경로가 아니라 갱신 경로다.** 하루에 새 거래일이 하나 늘 뿐이라
    저빈도로 돌면 되고, 실패해도 조회는 시드까지 그대로 답한다 — 이게 KIS 판과
    가장 크게 다른 점이다(그쪽은 조회가 곧 원격 호출이라 장애가 곧 조회 실패였다).

    자격증명이 없으면 0 을 돌려준다. dev 무자격 프로필(ADR-0134)에서 정상 경로다.

    저빈도(일 1회 1콜)라 유량 이득은 없지만 **거버너를 통과한다** — 목적은 토큰
    revoke(8005) 자동복구다(복구가 거버너 소유, PR #1088). 우회하면 죽은 토큰으로
    실패하고도 재발급이 안 걸려 **오버레이가 조용히 멈춘다**: 조회는 시드로 계속
    답하므로 화면에는 아무 증상이 없다.
    """
    from datetime import datetime  # noqa: PLC0415 — 갱신 경로 전용

    from hoga.live import kiwoom_access, kiwoom_rest_runtime  # noqa: PLC0415 — 순환 절단
    from hoga.util.timeenc import KST  # noqa: PLC0415

    client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
    if client is None:
        return 0
    today = datetime.now(KST).strftime("%Y%m%d")
    body = {"inds_cd": "001", "base_dt": today}
    page = await kiwoom_access.run_with_capacity(
        kiwoom_rest_runtime.ensure_scheduler(data_dir),
        key=("trading-days-overlay", today),
        api_id="ka20006",
        priority="background",
        client=client,
        fetch_fn=lambda c: c.call("ka20006", body),
    )
    got = [str(r.get("dt") or "") for r in page.rows if r.get("dt")]
    if not got:
        return 0
    added = append_overlay(data_dir, got)
    if added:
        log.info("trading-calendar: 오버레이에 %d일 추가 (최신 %s)", added, max(got))
    return added
