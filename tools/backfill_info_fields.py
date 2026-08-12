"""디스크의 `meta.json` 에 박힌 info 행 파생 7필드를 고친 매핑으로 재계산한다.

`parse_info_row` 의 위치 인덱스가 어긋나 있었다 — `today_open`/`today_high`/
`today_low`/`today_close` 는 물론 `prev_close`/`upper_limit`/`lower_limit` 까지
같은 표의 7필드 전부가 다른 필드를 읽고 있었다(실측: OHLC 불변식이 raw 1,869건
중 **1,838건**에서 깨졌다). 파서만 고치면 **이미 쓰인 meta 는 영원히 틀린 채**
남는다 — hogaplay 업스트림 보유가 ~18h 라 옛 날짜는 재캡처 경로가 없고, 옛 raw 는
이미 프루닝돼 있다.

재계산 소스는 meta 자신이 보존한 ``raw_info_tsv`` 다. raw 디렉터리는 필요 없다.
매핑을 여기 다시 적지 않고 **고친 `parse_info_row` 를 그대로 부른다** — 두 벌이
되면 다음 수정 때 갈린다.

읽기 전용이 기본이다. 실행 예::

    uv run --extra dev python -m tools.backfill_info_fields
    uv run --extra dev python -m tools.backfill_info_fields --apply

⚠ **백엔드를 세우고 실행할 것.** 두 가지 이유가 있다:

1. ``hoga/api/events.py`` 의 inotify watchdog 이 `meta.json` 등장을 inventory
   트리거로 쓴다 — 수만 건 재작성은 그만큼의 가짜 완료 이벤트다.
2. `QueryEngine` 의 Stock-Date 캐시는 `meta.json` 의 **mtime 으로만** 무효화된다
   (`hoga/api/queries.py`). 이 도구는 아래 이유로 mtime 을 복원하므로 캐시가
   스스로 갱신되지 않는다. **끝난 뒤 서버를 재시작할 것.**

mtime 을 복원하는 이유: 인벤토리의 ``captured_at`` 이 Stock-Date 디렉터리 파일들의
**최대 mtime** 이라(`queries.py`), 그냥 재작성하면 전 종목의 캡처 시각이 오늘로
바뀐다. 그건 고치려던 것보다 더 눈에 띄는 오염이다.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hoga.config import resolve_data_dir
from hoga.parser import PARSER_VERSION, parse_info_row
from hoga.util.atomic_write import atomic_write_json

#: `parse_info_row` 로 재계산하는 키. 이 목록 밖(카운터·gap_ranges·warnings 등)은
#: 손대지 않는다 — 이 도구는 매핑 결함만 되돌린다.
DERIVED_KEYS = (
    "prev_close",
    "upper_limit",
    "lower_limit",
    "today_open",
    "today_high",
    "today_low",
    "today_close",
)


@dataclass
class Report:
    scanned: int = 0
    changed: int = 0
    unchanged: int = 0
    skipped: Counter = None  # type: ignore[assignment]
    samples: list[dict[str, Any]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.skipped is None:
            self.skipped = Counter()
        if self.samples is None:
            self.samples = []


def corrected_fields(meta: dict[str, Any]) -> dict[str, Any] | None:
    """``raw_info_tsv`` 를 고친 매핑으로 다시 읽어 갱신할 키만 돌려준다.

    ``raw_info_tsv`` 가 없거나 파싱이 실패하면 ``None``. 호출부가 사유를 센다.
    """
    raw = meta.get("raw_info_tsv")
    if not isinstance(raw, str) or not raw:
        return None
    info = parse_info_row(raw)
    return {
        "prev_close": info.prev_close,
        "upper_limit": info.upper_limit,
        "lower_limit": info.lower_limit,
        "today_open": info.today_open,
        "today_high": info.today_high,
        "today_low": info.today_low,
        "today_close": info.today_close,
        "info_unknowns": info.unknowns,
        "parser_version": PARSER_VERSION,
    }


def backfill(data_dir: Path, *, apply: bool, max_samples: int = 5) -> Report:
    report = Report()
    parquet_root = data_dir / "parquet"
    if not parquet_root.is_dir():
        return report

    for meta_path in sorted(parquet_root.rglob("meta.json")):
        report.scanned += 1
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # ValueError 가 JSONDecodeError 와 UnicodeDecodeError 를 모두 덮는다.
            report.skipped["unreadable"] += 1
            continue
        if not isinstance(meta, dict):
            report.skipped["not-dict"] += 1
            continue

        # venue 롤업(`kiwoom_live/meta.json`)·라이브 승격 meta 에는 info 행이
        # 없다. 결함이 아니라 **다른 종류의 파일**이라 사유를 따로 센다.
        try:
            updates = corrected_fields(meta)
        except (ValueError, IndexError) as exc:
            # FieldCountError 는 ValueError 하위다. 잘린 info 행 — 고칠 근거가 없다.
            report.skipped[f"unparsable:{type(exc).__name__}"] += 1
            continue
        if updates is None:
            report.skipped["no-raw_info_tsv"] += 1
            continue

        if all(meta.get(k) == v for k, v in updates.items()):
            report.unchanged += 1
            continue

        report.changed += 1
        if len(report.samples) < max_samples:
            report.samples.append({
                "path": str(meta_path),
                "before": {k: meta.get(k) for k in DERIVED_KEYS},
                "after": {k: updates[k] for k in DERIVED_KEYS},
            })
        if not apply:
            continue

        # mtime 은 **쓰기 전에** 읽는다. atomic_write_json 은 os.replace 라
        # 새 inode 가 들어오므로 그 뒤엔 원래 값을 알 수 없다.
        st = meta_path.stat()
        atomic_write_json(meta_path, {**meta, **updates})
        os.utime(meta_path, ns=(st.st_atime_ns, st.st_mtime_ns))

    return report


def _print_report(report: Report, *, apply: bool) -> None:
    verb = "고침" if apply else "고칠 대상"
    print(f"scanned={report.scanned}  {verb}={report.changed}  unchanged={report.unchanged}")
    for reason, count in sorted(report.skipped.items()):
        print(f"  skipped[{reason}]={count}")
    for s in report.samples:
        print(f"\n  {s['path']}")
        for k in DERIVED_KEYS:
            before, after = s["before"][k], s["after"][k]
            mark = " " if before == after else "*"
            print(f"   {mark} {k:<12} {before!r:>12} → {after!r}")
    if not apply and report.changed:
        print("\ndry-run 이다. 실제로 쓰려면 --apply 를 붙인다(백엔드를 세운 뒤).")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--data-dir", type=Path, default=None,
        help="기본값은 hoga.config.resolve_data_dir() (머신 전역 캡처 디렉터리).",
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="실제로 meta.json 을 다시 쓴다. 기본은 dry-run.",
    )
    ap.add_argument("--json", action="store_true", help="집계를 JSON 으로 출력한다.")
    args = ap.parse_args(argv)

    data_dir = args.data_dir or resolve_data_dir()
    report = backfill(data_dir, apply=args.apply)

    if args.json:
        print(json.dumps({
            "data_dir": str(data_dir),
            "applied": args.apply,
            "scanned": report.scanned,
            "changed": report.changed,
            "unchanged": report.unchanged,
            "skipped": dict(report.skipped),
        }, ensure_ascii=False, indent=2))
    else:
        print(f"data_dir={data_dir}")
        _print_report(report, apply=args.apply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
