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
