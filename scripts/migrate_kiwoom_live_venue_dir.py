#!/usr/bin/env python
"""`kiwoom_live/*` → `kiwoom_live/KRX/*` 마이그레이션 (ADR-0140 §3, PR-D).

저장에 venue 축이 생기면서 `kiwoom_live` 아래에 venue 세그먼트가 붙는다. 기존
데이터는 **정의상 전부 KRX** 다 — 저장 게이트가 정규장(09:00–15:30)뿐이었고 그 창의
`target_ws_venue` 는 항상 KRX 였다.

    parquet/{date}/{code}/kiwoom_live/snapshots.parquet
 →  parquet/{date}/{code}/kiwoom_live/KRX/snapshots.parquet

**`kiwoom_live` 만 옮긴다.** hogaplay(전체의 78%)·kis_live·kis_api 는 venue 축이
없다(`SOURCE_VENUES` — 각 소스가 덮는 venue 집합).

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
from dataclasses import dataclass, field
from pathlib import Path

SOURCE = "kiwoom_live"
VENUE = "KRX"
PREVIEW = 3  # dry-run 에 보여줄 예시 개수


@dataclass
class _Plan:
    """옮길 것과 **못 옮기는 것**. 후자를 조용히 버리지 않는 것이 이 구조의 요점이다."""

    moves: list[tuple[Path, Path]] = field(default_factory=list)
    #: 이미 마이그레이션된 디렉터리에 남은 평면 parquet — venue 쪽이 정본이라 겹친다.
    stale: list[Path] = field(default_factory=list)
    #: 마이그레이션된 디렉터리의 평면 `meta.json` — **source 레벨 meta 다**(ADR-0140 §4).
    source_meta: list[Path] = field(default_factory=list)


def _plan_jsonl(live_root: Path, *, reverse: bool) -> list[tuple[Path, Path]]:
    """`live_kiwoom/{date}/{code}.jsonl` → `live_kiwoom/{date}/KRX/{code}.jsonl`.

    ADR-0140 §3 은 JSONL 을 *"보유 2일짜리 과도 트리라 날짜 경계 컷오버면 충분"* 으로
    보고 마이그레이션 대상에서 뺐다. 실제로는 **PR-D2 를 당일에 하려면 옮겨야 한다** —
    당일 JSONL 은 D1 배포 전에 평면으로 쓰인 것이 그대로 남아 있고, 폴백을 지우면
    승격·아카이브 경로가 그걸 못 본다(실측 2026-08-05: 273 파일).

    parquet 쪽과 같은 규율: venue 디렉터리가 이미 있으면 **안 건드린다**.
    """
    moves: list[tuple[Path, Path]] = []
    if not live_root.is_dir():
        return moves
    for date_dir in sorted(live_root.iterdir()):
        if not date_dir.is_dir() or not date_dir.name.isdigit():
            continue  # `_archive` 등 날짜가 아닌 디렉터리는 건너뛴다
        venue_dir = date_dir / VENUE
        if reverse:
            if venue_dir.is_dir():
                moves.extend(
                    (f, date_dir / f.name)
                    for f in sorted(venue_dir.iterdir())
                    if f.suffix == ".jsonl" and f.is_file()
                )
            continue
        if any(d.is_dir() for d in date_dir.iterdir()):
            continue  # 이미 마이그레이션됨
        moves.extend(
            (f, venue_dir / f.name)
            for f in sorted(date_dir.iterdir())
            if f.suffix == ".jsonl" and f.is_file()
        )
    return moves


def _plan(parquet_root: Path, *, reverse: bool) -> _Plan:
    """옮길 목록. 이미 목표 모양이면 안 옮긴다(멱등 — docstring 이 약속한 그것).

    ⚠ **이 함수가 한 번 틀렸다.** 예전 판은 *"이미 옮긴 디렉터리는 파일이 venue 아래에만
    있다"* 고 **가정**하고 평면 파일을 전부 옮겼다. D1 이 머지돼 앱이 새 레이아웃으로
    쓰기 시작하자 그 가정이 깨졌다 — 실측 2026-08-05 기준 **273 Stock-Date 가 두 모양을
    같은 파일명으로** 갖고 있었다. `Path.rename` 은 POSIX 에서 대상을 **조용히 덮어쓰므로**
    그대로 돌렸다면:

    - 새 승격이 쓴 `KRX/*.parquet` **1,365 개**가 옛 평면본으로 되돌아가고
    - 평면 `meta.json` 이 `KRX/meta.json` 위로 옮겨져 **source 레벨 meta 와 venue 레벨
      meta 를 한 번에 파괴**한다(PR-E 가 `kiwoom_live/meta.json` 에 `expected_venues` ·
      `nxt_enabled` 를 둔다 — 그건 잔재가 아니라 정본이다)

    판별은 **venue 디렉터리 존재 여부** 하나로 충분하다:

    - `KRX/` 가 있다 → 이미 마이그레이션됨. 평면 parquet 는 잔재(`stale`), 평면
      `meta.json` 은 source 레벨 정본(`source_meta`) — **둘 다 안 건드린다**
    - `KRX/` 가 없다 → 미마이그레이션. 평면 `meta.json` 은 그 시절의 venue meta 이므로
      함께 옮긴다
    """
    plan = _Plan()
    if not parquet_root.is_dir():
        return plan
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
                        plan.moves.append((f, src_dir / f.name))
                continue
            loose = [f for f in sorted(src_dir.iterdir()) if f.is_file()]
            if any(d.is_dir() for d in src_dir.iterdir()):
                # 이미 마이그레이션됨 — 평면에 남은 것은 옮길 대상이 아니다.
                for f in loose:
                    (plan.source_meta if f.name == "meta.json" else plan.stale).append(f)
                continue
            plan.moves.extend((f, venue_dir / f.name) for f in loose)
    return plan


def _print_plan(
    plan: _Plan, parquet_root: Path, *, reverse: bool, prune_stale: bool,
) -> None:
    """계획 요약. **못 옮기는 것도 반드시 찍는다** — 조용한 스킵은 조용한 결손이 된다."""
    print(f"데이터: {parquet_root}")
    print(f"방향  : {'KRX/ → 상위(되돌림)' if reverse else '상위 → KRX/'}")
    print(f"대상  : 파일 {len(plan.moves):,}개")
    if plan.source_meta:
        print(f"보존  : source 레벨 meta.json {len(plan.source_meta):,}개 — "
              f"venue 밖 정본이라 안 옮긴다(ADR-0140 §4)")
    if plan.stale:
        action = "삭제한다(--prune-stale)" if prune_stale else "삭제하려면 --prune-stale"
        print(f"잔재  : 평면 parquet {len(plan.stale):,}개 — "
              f"이미 venue 쪽이 정본이다. {action}")


def _apply_moves(moves: list[tuple[Path, Path]], data_dir: Path) -> int | None:
    """이동 실행. 대상이 이미 있으면 **멈춘다**(None) — 데이터를 잃느니 사람이 보게 한다.

    `Path.rename` 은 POSIX 에서 대상을 조용히 덮어쓴다. `_plan` 이 이미 걸러내지만,
    그 판별이 뚫렸을 때 조용히 지나가면 안 되는 종류의 실수라 여기서 한 번 더 막는다.
    """
    moved = 0
    for src, dst in moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            print(f"\n중단 — 대상이 이미 있다: {dst.relative_to(data_dir)}")
            return None
        src.rename(dst)  # 같은 파일시스템 — 원자적 이동
        moved += 1
    return moved


def _cleanup_empty_venue_dirs(parquet_root: Path) -> None:
    """되돌림 후 빈 venue 디렉터리 청소(정방향은 상위가 안 비므로 불필요)."""
    for date_dir in parquet_root.iterdir():
        if not date_dir.is_dir():
            continue
        for code_dir in date_dir.iterdir():
            venue_dir = code_dir / SOURCE / VENUE
            if venue_dir.is_dir() and not any(venue_dir.iterdir()):
                venue_dir.rmdir()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, default=None,
                    help="기본: hoga.config.resolve_data_dir()")
    ap.add_argument("--apply", action="store_true", help="실제로 옮긴다(없으면 dry-run)")
    ap.add_argument("--reverse", action="store_true", help="KRX/ → 상위로 되돌린다")
    ap.add_argument("--prune-stale", action="store_true",
                    help="이미 마이그레이션된 디렉터리에 남은 평면 parquet 삭제(되돌릴 수 없다)")
    args = ap.parse_args(argv)

    if args.data_dir is None:
        from hoga.config import resolve_data_dir  # noqa: PLC0415 — CLI 진입점
        data_dir = resolve_data_dir()
    else:
        data_dir = args.data_dir
    parquet_root = data_dir / "parquet"

    plan = _plan(parquet_root, reverse=args.reverse)
    # JSONL 도 같은 축으로 옮긴다 — 폴백을 지우려면 당일 평면 JSONL 이 남아 있으면
    # 안 된다(ADR-0140 §3 의 "날짜 경계 컷오버" 는 당일 실행을 못 덮는다).
    jsonl_moves = _plan_jsonl(data_dir / "live_kiwoom", reverse=args.reverse)
    moves = plan.moves + jsonl_moves
    _print_plan(plan, parquet_root, reverse=args.reverse, prune_stale=args.prune_stale)
    if jsonl_moves:
        print(f"JSONL : 파일 {len(jsonl_moves):,}개 (live_kiwoom/)")
    if not moves and not (args.prune_stale and plan.stale):
        print("옮길 것이 없다 — 이미 목표 모양이거나 데이터가 없다(멱등).")
        return 0

    for src, dst in moves[:PREVIEW]:
        print(f"  예) {src.relative_to(data_dir)}  →  {dst.relative_to(data_dir)}")
    if len(moves) > PREVIEW:
        print(f"  … 외 {len(moves) - PREVIEW:,}개")

    if not args.apply:
        print("\ndry-run 이다. 실제로 옮기려면 --apply 를 붙여라.")
        return 0

    moved = _apply_moves(moves, data_dir)
    if moved is None:
        return 1
    pruned = 0
    if args.prune_stale:
        for f in plan.stale:
            f.unlink()
            pruned += 1
    if args.reverse:
        _cleanup_empty_venue_dirs(parquet_root)
    print(f"\n완료 — 파일 {moved:,}개 이동"
          + (f" · 잔재 {pruned:,}개 삭제." if pruned else "."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
