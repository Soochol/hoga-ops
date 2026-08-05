#!/usr/bin/env python
"""`kiwoom_live/*` → `kiwoom_live/KRX/*` 마이그레이션 (ADR-0140 §3, PR-D).

저장에 venue 축이 생기면서 `kiwoom_live` 아래에 venue 세그먼트가 붙는다. 기존
데이터는 **정의상 전부 KRX** 다 — 저장 게이트가 정규장(09:00–15:30)뿐이었고 그 창의
`target_ws_venue` 는 항상 KRX 였다.

    parquet/{date}/{code}/kiwoom_live/snapshots.parquet
 →  parquet/{date}/{code}/kiwoom_live/KRX/snapshots.parquet

**`kiwoom_live` 만 옮긴다.** hogaplay(전체의 78%)·kis_live·kis_api 는 venue 축이
없다(`SOURCE_HAS_VENUE`).

## 안전 규율

- **같은 파일시스템 rename** — 복사가 아니라 이동이라 디스크 여유가 필요 없고 원자적이다
- **멱등** — 이미 `KRX/` 가 있으면 건너뛴다. 중단 후 재실행이 안전하다
- **역방향 제공** (`--reverse`) — 되돌림이 필요한 유일한 작업이다(ADR-0140 §8: 그 밖엔
  킬스위치·토글을 만들지 않는다)
- **기본이 dry-run** — 실행은 `--apply` 를 명시해야 한다

## 실행

    uv run python scripts/migrate_kiwoom_live_venue_dir.py            # 점검
    uv run python scripts/migrate_kiwoom_live_venue_dir.py --apply    # 실행
    uv run python scripts/migrate_kiwoom_live_venue_dir.py --apply --reverse   # 되돌림

⚠ **앱을 멈추고 돌린다.** 캡처 중에 옮기면 진행 중 쓰기가 옛 경로에 남는다.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

SOURCE = "kiwoom_live"
VENUE = "KRX"
PREVIEW = 3  # dry-run 에 보여줄 예시 개수


def _plan(parquet_root: Path, *, reverse: bool) -> list[tuple[Path, Path]]:
    """옮길 (src, dst) 목록. 이미 목표 모양이면 비운다(멱등)."""
    moves: list[tuple[Path, Path]] = []
    if not parquet_root.is_dir():
        return moves
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir():
            continue
        for code_dir in sorted(date_dir.iterdir()):
            src_dir = code_dir / SOURCE
            if not src_dir.is_dir():
                continue
            venue_dir = src_dir / VENUE
            if reverse:
                if not venue_dir.is_dir():
                    continue
                for f in sorted(venue_dir.iterdir()):
                    if f.is_file():
                        moves.append((f, src_dir / f.name))
            else:
                # 이미 옮긴 디렉터리는 파일이 venue 아래에만 있다.
                loose = [f for f in sorted(src_dir.iterdir()) if f.is_file()]
                for f in loose:
                    moves.append((f, venue_dir / f.name))
    return moves


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, default=None,
                    help="기본: hoga.config.resolve_data_dir()")
    ap.add_argument("--apply", action="store_true", help="실제로 옮긴다(없으면 dry-run)")
    ap.add_argument("--reverse", action="store_true", help="KRX/ → 상위로 되돌린다")
    args = ap.parse_args(argv)

    if args.data_dir is None:
        from hoga.config import resolve_data_dir  # noqa: PLC0415 — CLI 진입점
        data_dir = resolve_data_dir()
    else:
        data_dir = args.data_dir
    parquet_root = data_dir / "parquet"

    moves = _plan(parquet_root, reverse=args.reverse)
    direction = "KRX/ → 상위(되돌림)" if args.reverse else "상위 → KRX/"
    print(f"데이터: {parquet_root}")
    print(f"방향  : {direction}")
    print(f"대상  : 파일 {len(moves):,}개")
    if not moves:
        print("옮길 것이 없다 — 이미 목표 모양이거나 데이터가 없다(멱등).")
        return 0

    for src, dst in moves[:PREVIEW]:
        print(f"  예) {src.relative_to(parquet_root)}  →  {dst.relative_to(parquet_root)}")
    if len(moves) > PREVIEW:
        print(f"  … 외 {len(moves) - PREVIEW:,}개")

    if not args.apply:
        print("\ndry-run 이다. 실제로 옮기려면 --apply 를 붙여라.")
        return 0

    moved = 0
    for src, dst in moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)  # 같은 파일시스템 — 원자적 이동
        moved += 1
    # 되돌림 후 빈 venue 디렉터리 청소(정방향은 상위가 안 비므로 불필요).
    if args.reverse:
        for date_dir in parquet_root.iterdir():
            if not date_dir.is_dir():
                continue
            for code_dir in date_dir.iterdir():
                venue_dir = code_dir / SOURCE / VENUE
                if venue_dir.is_dir() and not any(venue_dir.iterdir()):
                    venue_dir.rmdir()
    print(f"\n완료 — 파일 {moved:,}개 이동.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
