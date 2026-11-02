from __future__ import annotations

from dataclasses import dataclass
from datetime import date

MAX_PENDING = 4
PRIORITY_BURST = 3


@dataclass(frozen=True)
class Preparation:
    history: object
    fetched_ms: int
    needed: int
    day: date
    recovering: bool


class PreparationQueue:
    def __init__(self):
        self.waiting: dict[str, Preparation] = {}
        self.priority_streak = 0

    def replace(self, jobs: dict[str, Preparation]):
        self.waiting = jobs

    def clear(self):
        self.waiting.clear()
        self.priority_streak = 0

    def take(self, preferred: set[str]) -> tuple[str, Preparation] | None:
        if not self.waiting:
            return None
        ordered = sorted(self.waiting, key=lambda code: (
            not self.waiting[code].recovering, bool(self.waiting[code].fetched_ms),
            self.waiting[code].fetched_ms, code))
        first = self.waiting[ordered[0]]
        if first.recovering:
            code = ordered[0]
        else:
            tier = [code for code in ordered if not self.waiting[code].recovering
                    and bool(self.waiting[code].fetched_ms) == bool(first.fetched_ms)]
            urgent = [code for code in tier if code in preferred]
            ordinary = [code for code in tier if code not in preferred]
            if urgent and (not ordinary or self.priority_streak < PRIORITY_BURST):
                code = urgent[0]
                self.priority_streak += 1
            else:
                code = ordinary[0]
                self.priority_streak = 0
        return code, self.waiting.pop(code)
