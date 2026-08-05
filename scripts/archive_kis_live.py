#!/usr/bin/env python
"""`kis_live` 소스 데이터 아카이브 (사용자 결정 2026-08-05).

KIS WebSocket 계층은 ADR-0118 PR-G 에서 삭제됐다 — **쓰는 코드가 없다**. 남은 것은
그 시절 승격본뿐이고(실측 1,052 Stock-Date, 최신 20260716), 사용자가 그 구간을 복기할
계획이 없다고 확인했다. 그래서 소스 이름을 코드에서 지우는 대신 데이터를 옮긴다.

    parquet/{date}/{code}/kis_live/   →   _archive/kis_live/{date}/{code}/

**지우지 않는다.** 같은 파일시스템 rename 이라 디스크 여유가 필요 없고, `--reverse`
로 되돌릴 수 있다. 판단이 틀렸다고 밝혀지면 되돌린 뒤 소스 제거 커밋을 revert 하면 된다.

## 안전 규율

- **대상이 이미 있으면 멈춘다** — `rename` 은 POSIX 에서 조용히 덮어쓴다
- **멱등** — 이미 옮긴 것은 계획에서 빠진다
- **기본이 dry-run** — 실행은 `--apply` 를 명시해야 한다

## 실행

    uv run python scripts/archive_kis_live.py            # 점검
    uv run python scripts/archive_kis_live.py --apply    # 실행
    uv run python scripts/archive_kis_live.py --apply --reverse   # 되돌림

앱을 멈출 필요는 없다 — `kis_live` 를 쓰는 writer 가 없기 때문이다. 읽기가 순간
비껴갈 수는 있으나 그 소스는 이 커밋에서 사다리에서도 빠진다.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

SOURCE = "kis_live"
PREVIEW = 3


def _plan(data_dir: Path, *, reverse: bool) -> list[tuple[Path, Path]]:
    """(src, dst) 목록. 이미 목표 모양이면 비운다(멱등)."""
    parquet_root = data_dir / "parquet"
    archive_root = data_dir / "_archive" / SOURCE
    moves: list[tuple[Path, Path]] = []
    if reverse:
        if not archive_root.is_dir():
            return moves
        for date_dir in sorted(archive_root.iterdir()):
            if not date_dir.is_dir():
                continue
            for code_dir in sorted(date_dir.iterdir()):
                if code_dir.is_dir():
                    moves.append(
                        (code_dir, parquet_root / date_dir.name / code_dir.name / SOURCE)
                    )
        return moves
    if not parquet_root.is_dir():
        return moves
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir():
            continue
        for code_dir in sorted(date_dir.iterdir()):
            src = code_dir / SOURCE
            if src.is_dir():
                moves.append((src, archive_root / date_dir.name / code_dir.name))
    return moves


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, default=None,
                    help="기본: hoga.config.resolve_data_dir()")
    ap.add_argument("--apply", action="store_true", help="실제로 옮긴다(없으면 dry-run)")
    ap.add_argument("--reverse", action="store_true", help="_archive 에서 되돌린다")
    args = ap.parse_args(argv)

    if args.data_dir is None:
        from hoga.config import resolve_data_dir  # noqa: PLC0415 — CLI 진입점
        data_dir = resolve_data_dir()
    else:
        data_dir = args.data_dir

    moves = _plan(data_dir, reverse=args.reverse)
    direction = "_archive → parquet(되돌림)" if args.reverse else "parquet → _archive"
    print(f"데이터: {data_dir}")
    print(f"방향  : {direction}")
    print(f"대상  : {SOURCE} 디렉터리 {len(moves):,}개")
    if not moves:
        print("옮길 것이 없다 — 이미 목표 모양이거나 데이터가 없다(멱등).")
        return 0
    for src, dst in moves[:PREVIEW]:
        print(f"  예) {src.relative_to(data_dir)}  →  {dst.relative_to(data_dir)}")
    if len(moves) > PREVIEW:
        print(f"  … 외 {len(moves) - PREVIEW:,}개")
    if not args.apply:
        print("\ndry-run 이다. 실제로 옮기려면 --apply 를 붙여라.")
        return 0

    moved = 0
    for src, dst in moves:
        if dst.exists():
            # rename 은 조용히 덮어쓴다 — 데이터를 잃느니 사람이 보게 한다.
            print(f"\n중단 — 대상이 이미 있다: {dst.relative_to(data_dir)}")
            return 1
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        moved += 1
    print(f"\n완료 — {SOURCE} 디렉터리 {moved:,}개 이동.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
