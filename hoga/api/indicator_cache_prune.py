"""죽은 버전의 지표 캐시 파일을 지운다.

## 왜 필요한가 — 범프는 파일을 지우지 않는다

`KIND_VERSIONS` 범프는 **읽을 때 stale 로 판정**할 뿐이고 디스크의 옛 파일은 그대로
남는다. 그래서 범프를 거듭할수록 아무도 읽지 않는 파일이 쌓인다. 실측(2026-08-29,
`ask_peak` 1분 표본 4,000개): v12 954 · v11 1,982 · v7 541 · v8 169 · v2 104 · v6 78 ·
v3 95 · v9 77 — **표본의 4분의 3이 죽은 버전**이었고, 캐시 루트 전체는 24GB 다.

읽기 경로는 이들을 조용히 무시하므로 **정확성 문제가 아니라 순수 공간 문제**다.
그래서 이 정리는 언제 돌려도 안전하고, 안 돌려도 동작이 바뀌지 않는다.

## 안전 규약

- **기본이 dry-run 이다.** 지우기 전에 반드시 세는 단계를 먼저 보여 준다.
- **버전이 낮은 것만** 지운다(`<`, `!=` 가 아니다). 높은 버전은 더 새 코드가 쓴 것이라
  롤백하면 다시 유효해질 수 있다 — 미래를 지우지 않는다.
- **모르는 kind 는 건드리지 않는다.** `KIND_VERSIONS` 에 없는 파일명은 남긴다.
- 경로는 호출부가 `resolve_data_dir()` 에서 얻은 것을 넘긴다. 셸 변수로 조립한 경로에
  `-delete` 를 거는 것이 과거에 루트를 뒤진 적이 있다.
"""
from __future__ import annotations

import contextlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path

from hoga.api.past_indicators_cache import KIND_VERSIONS

log = logging.getLogger(__name__)

_DATE_LEN = 8

#: 파일명 접두 → `KIND_VERSIONS` 키. **둘이 항상 같지 않다** — `_poc_path` 는
#: `trade_volume_poc.…` 를, `vdist` 는 `volume_distribution.…` 를 파일명에 쓴다.
#: 이 표가 없으면 그 두 kind 의 죽은 파일이 "모르는 kind" 로 분류되어 영영 안 지워진다
#: (실측 2026-08-29: 그렇게 27,312개가 새어 나갔다).
_FILENAME_PREFIX_TO_KIND: dict[str, str] = {
    "trade_volume_poc": "poc",
    "volume_distribution": "vdist",
}

#: **지표째 제거된** kind — 버전이 아니라 존재가 죽었으므로 전량이 대상이다.
#: 근거는 `past_indicators_cache` 의 주석: "지표째 제거됐고(`depth_delta` 2026-08-25 ·
#: `wall_surge` 2026-08-26)". 어떤 읽기 경로도 이 파일들을 열지 않는다.
#: ⚠ 여기에 추가하기 전에 **그 kind 를 읽는 코드가 정말 0인지** 확인할 것 — 버전
#: 비교와 달리 이쪽은 "언젠가 다시 유효해질" 여지가 없다.
_RETIRED_KINDS: frozenset[str] = frozenset({"wall_surge", "depth_delta"})


@dataclass(frozen=True)
class PruneResult:
    scanned: int        # 훑은 .json 파일 수
    stale: int          # 현재 버전보다 낮아 대상이 된 수
    retired: int        # 지표째 제거된 kind — 전량이 대상이다
    deleted: int        # 실제로 지운 수(dry-run 이면 0)
    bytes_freed: int    # 대상 파일의 총 크기
    unreadable: int     # 파싱 실패 — **지우지 않는다**(모르는 것은 남긴다)
    unknown_kind: int   # KIND_VERSIONS 에도 은퇴 목록에도 없는 kind — 남긴다


def kind_of(filename: str) -> str | None:
    """`20260826.ask_peak.60000.json` → `ask_peak`.

    파일명 규약은 `{YYYYMMDD}.{kind}[.{params}].json` 이고 kind 에는 `.` 이 없다
    (`trade_volume_poc.10.2198000` 처럼 파라미터가 뒤에 더 붙는 kind 도 첫 토큰은
    하나다). 날짜 자리가 8자리 숫자가 아니면 이 규약 밖의 파일이므로 None 이다.
    """
    parts = filename.split(".")
    min_parts = 3  # date, kind, json
    if len(parts) < min_parts or len(parts[0]) != _DATE_LEN or not parts[0].isdigit():
        return None
    return _FILENAME_PREFIX_TO_KIND.get(parts[1], parts[1])


def prune(data_dir: Path, *, dry_run: bool = True) -> PruneResult:
    """죽은 버전 캐시 파일을 센다(그리고 `dry_run=False` 면 지운다). 멱등."""
    root = data_dir / "kis-past-indicators"
    scanned = stale = retired = deleted = unreadable = unknown = 0
    freed = 0
    if not root.exists():
        return PruneResult(0, 0, 0, 0, 0, 0, 0)

    def _drop(path: Path) -> None:
        nonlocal freed, deleted
        # 크기를 못 재도 삭제는 진행한다 — 보고 숫자가 조금 작아질 뿐이다.
        with contextlib.suppress(OSError):
            freed += path.stat().st_size
        if dry_run:
            return
        try:
            path.unlink()
        except OSError:
            # 다른 프로세스가 먼저 지웠거나 권한 문제 — 다음 실행이 다시 잡는다.
            log.warning("indicator cache prune: could not unlink %s", path)
            return
        deleted += 1

    for path in root.rglob("*.json"):
        scanned += 1
        kind = kind_of(path.name)
        if kind is None:
            unknown += 1
            continue
        if kind in _RETIRED_KINDS:
            # 은퇴 kind 는 **내용을 읽지 않는다** — 버전이 무엇이든 읽는 코드가 없다.
            retired += 1
            _drop(path)
            continue
        if kind not in KIND_VERSIONS:
            unknown += 1
            continue
        try:
            version = json.loads(path.read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError):
            unreadable += 1
            continue
        if not isinstance(version, int) or version >= KIND_VERSIONS[kind]:
            continue
        stale += 1
        _drop(path)

    log.info(
        "indicator_cache_prune scanned=%d stale=%d retired=%d deleted=%d freed=%.1fMB "
        "unreadable=%d unknown_kind=%d dry_run=%s",
        scanned, stale, retired, deleted, freed / 1e6, unreadable, unknown, dry_run,
    )
    return PruneResult(
        scanned=scanned, stale=stale, retired=retired, deleted=deleted,
        bytes_freed=freed, unreadable=unreadable, unknown_kind=unknown,
    )
