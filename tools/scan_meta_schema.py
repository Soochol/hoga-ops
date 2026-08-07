"""디스크의 `meta.json` 이 `/api/meta` 를 500 으로 만들 수 있는지 전수 스캔한다.

`routes.py::meta` 는 `Meta(**{k: m[k] for k in Meta.model_fields})` 로 조립한다 —
필드가 **하나만** 빠져도 `KeyError` → 500 이고, 타입이 어긋나면 `ValidationError`
→ 500 이다. 파일 부재(#1176·#1178 이 다룬 축)와 **다른 축**이라 그 가드로는 안 잡힌다.

읽기 전용이다. 실행 예:

    uv run --extra dev python -m tools.scan_meta_schema
    uv run --extra dev python -m tools.scan_meta_schema --data-dir /path/to/data --json

⚠ **"결함 meta 개수" 를 그대로 위험으로 읽지 말 것.** 실측 2026-08-07 (22,175개
스캔)에서 `Meta` 검증에 실패한 5,442개는 전부 `kis_live`·`kiwoom_live` 였고
`/api/meta` 는 그중 **하나도 읽지 않았다** — 그 라우트는 `get_meta` 의 기본 source 가
`hogaplay` 로 고정이다. 그래서 이 스캐너는 두 수를 **따로** 낸다:

- `schema` 섹션 — 스키마상 `Meta` 로 조립 못 하는 meta.json 전수
- `reachable` 섹션 — `/api/meta` 의 해석 경로를 재현한 **Stock-Date 별 예상 응답**

판단은 뒤쪽으로 한다. 종료코드도 뒤쪽만 본다(500 예상이 1건이라도 있으면 1).

⚠ 두 번째 함정: `{code}/{source}/meta.json` 이 **항상 Stock-Date meta 인 것은
아니다.** venue 축이 있는 source(`kiwoom_live`)는 그 자리가 `expected_venues`·
`nxt_enabled` 만 든 **source 레벨 롤업**이고 완결성 meta 는 `{venue}/meta.json` 에
있다(ADR-0140 · `disk_state.source_meta_path` docstring). 이걸 안 가르면 롤업
721개가 "필드 누락" 으로 잡힌다 — 초안 스캔이 실제로 그렇게 셌다. 여기서는
`SOURCE_VENUES` 로 가른다.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from hoga.api.models import Meta
from hoga.api.sources import SOURCE_VENUES
from hoga.config import resolve_data_dir

# `Meta` 가 요구하는 필드와 타입. 라우트가 조립에 쓰는 그 목록이 곧 검사 대상이다 —
# 모델이 바뀌면 스캐너도 따라 바뀐다(하드코딩하면 조용히 갈린다).
_REQUIRED: dict[str, Any] = {name: f.annotation for name, f in Meta.model_fields.items()}


def is_source_rollup(meta_path: Path) -> bool:
    """`{code}/{source}/meta.json` 이 venue 롤업인가 — Stock-Date meta 가 아닌가.

    venue 를 여럿 덮는 source 만 그 자리에 롤업을 둔다. `hogaplay` 처럼 하나만
    덮는 source 는 세그먼트가 없어 같은 자리가 **진짜** Stock-Date meta 다.
    """
    parent = meta_path.parent
    covered = SOURCE_VENUES.get(parent.name)  # type: ignore[arg-type]  # 임의 디렉터리명을 조회한다
    return covered is not None and len(covered) > 1


def meta_defect(meta: object) -> str | None:
    """`Meta` 조립을 깨뜨리는 **첫** 사유. 조립 가능하면 ``None``."""
    if not isinstance(meta, dict):
        return "not-dict"
    for name, ann in _REQUIRED.items():
        if name not in meta:
            return f"missing:{name}"
        value = meta[name]
        # bool 은 int 의 하위형이라 isinstance 로는 안 갈린다 — 모델도 그렇게 받으므로
        # 여기서도 통과시킨다(스캐너가 라우트보다 엄격하면 위양성이 된다).
        if ann is str and not isinstance(value, str):
            return f"type:{name}"
        if ann is int and not isinstance(value, int):
            return f"type:{name}"
    return None


def predict_api_meta(code_dir: Path) -> tuple[str, str]:
    """이 Stock-Date 에 `/api/meta` 가 낼 응답 — `(status, detail)`.

    `queries.resolve_source_dir(sd, "hogaplay", "KRX")` 의 해석을 재현한다:
    `{code}/hogaplay` 가 있으면 그것, 없고 `{code}/meta.json` 이 있으면 평면,
    둘 다 없으면 `parquet_dir` 이 `StockDateNotFound` → 404.
    """
    hogaplay = code_dir / "hogaplay"
    if hogaplay.is_dir():
        target = hogaplay / "meta.json"
        if not target.exists():
            return "404", "hogaplay dir 있으나 meta.json 없음"
    elif (code_dir / "meta.json").exists():
        target = code_dir / "meta.json"
    else:
        return "404", "hogaplay·평면 meta 없음 → 라우트 미도달"

    try:
        meta = json.loads(target.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        return "500", f"unreadable:{type(exc).__name__}"
    defect = meta_defect(meta)
    return ("500", defect) if defect else ("200", "ok")


@dataclass
class ScanReport:
    scanned: int = 0
    rollups_skipped: int = 0
    unreadable: int = 0
    defects_by_reason: Counter[str] = field(default_factory=Counter)
    defects_by_source: Counter[str] = field(default_factory=Counter)
    reachable: Counter[str] = field(default_factory=Counter)
    five_hundred_examples: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": {
                "scanned": self.scanned,
                "rollups_skipped": self.rollups_skipped,
                "unreadable": self.unreadable,
                "defects_by_reason": dict(self.defects_by_reason),
                "defects_by_source": dict(self.defects_by_source),
            },
            "reachable": dict(self.reachable),
            "five_hundred_examples": self.five_hundred_examples,
        }


def scan(data_dir: Path) -> ScanReport:
    """`{data_dir}/parquet` 전체를 훑는다. 없으면 빈 리포트."""
    report = ScanReport()
    root = data_dir / "parquet"
    if not root.is_dir():
        return report

    for meta_path in root.rglob("meta.json"):
        if is_source_rollup(meta_path):
            report.rollups_skipped += 1
            continue
        report.scanned += 1
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            report.unreadable += 1
            continue
        defect = meta_defect(meta)
        if defect is None:
            continue
        report.defects_by_reason[defect] += 1
        # parquet/{date}/{code}/{source}[/{venue}]/meta.json — 평면은 세그먼트가 없다.
        parts = meta_path.relative_to(root).parts
        report.defects_by_source["/".join(parts[2:-1]) or "<flat>"] += 1

    for date_dir in sorted(root.iterdir()):
        if not date_dir.is_dir():
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            status, detail = predict_api_meta(code_dir)
            report.reachable[f"{status} ({detail})" if status != "200" else "200"] += 1
            if status == "500" and len(report.five_hundred_examples) < 10:  # noqa: PLR2004 — 예시 상한, 이름을 붙여도 의미가 안 는다
                report.five_hundred_examples.append(str(code_dir))
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Scan meta.json for schema drift that would make /api/meta 500."
    )
    parser.add_argument(
        "--data-dir", type=Path, default=None,
        help="기본값은 hoga.config.resolve_data_dir() (머신 전역 캡처 디렉터리).",
    )
    parser.add_argument("--json", action="store_true", help="사람용 표 대신 JSON 한 줄.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    report = scan(args.data_dir or resolve_data_dir())

    if args.json:
        print(json.dumps(report.to_dict(), ensure_ascii=False, sort_keys=True))
    else:
        print(f"스캔한 meta.json: {report.scanned:,} (venue 롤업 제외 {report.rollups_skipped:,})")
        print(f"읽기 실패: {report.unreadable:,}")
        print(f"스키마 결함(사유별): {dict(report.defects_by_reason) or '없음'}")
        print(f"결함 source 분포:    {dict(report.defects_by_source) or '없음'}")
        print("\n/api/meta 예상 응답 (Stock-Date 별):")
        for label, count in report.reachable.most_common():
            print(f"  {count:8,}  {label}")
        if report.five_hundred_examples:
            print("\n500 예시:")
            for path in report.five_hundred_examples:
                print(f"  {path}")

    # 스키마 결함이 아니라 **도달 가능한** 500 만 실패로 친다 — 위 docstring 의 이유다.
    return 1 if any(k.startswith("500") for k in report.reachable) else 0


if __name__ == "__main__":
    raise SystemExit(main())
