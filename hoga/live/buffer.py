"""In-memory ring buffer for live snapshots (Stage 7-β).

The poller publishes per-cycle snapshots here; the /api/live/snapshot and
/api/live/series endpoints read from it. ADR-0038: buffer.py is hot-path,
no Parquet imports.

Capacity: time-based eviction (DEFAULT_RETENTION_MS = 15 min) with a
MAX_BUFFER_ENTRIES hard cap as a flood safety pin.

Concurrency: a single asyncio.Lock guards all mutations and reads.
Readers grab a frozen tuple snapshot of the deque under the lock, then
release before processing — keeps the critical section short.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Iterable

from .snapshot import LiveSnapshot, SnapshotKind

# Eng C5 → WS 전환: 개수 캡은 폭주 안전핀으로만. 실 보존은 시간 기반
# (spec §8 봉합 사이징 불변식: 보존 > 2× HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S).
MAX_BUFFER_ENTRIES = 60_000
DEFAULT_RETENTION_MS = 900_000  # 15분


class LiveBuffer:
    """Per-code, per-kind ring buffer.

    Stores LiveSnapshot.payload dicts (not the dataclass itself) so the
    API layer can serialize directly without an extra conversion step.
    """

    def __init__(self, *, retention_ms: int = DEFAULT_RETENTION_MS) -> None:
        self._retention_ms = retention_ms
        self._lock = asyncio.Lock()
        # Keyed by (code, kind.value) → deque[dict]. deque(maxlen=...) handles
        # FIFO drop automatically when the cap is exceeded.
        self._buf: dict[tuple[str, str], deque[dict]] = {}
        # SSE push: per-code set of subscriber queues.
        self._subscribers: dict[str, set[asyncio.Queue[dict]]] = {}

    def subscribe(self, code: str) -> asyncio.Queue[dict]:
        """Subscribe to publishes for `code`. Returns a queue.

        Each entry pushed to the queue is a dict with at minimum
        ``t_ms`` and ``kind`` keys plus whatever payload fields the
        snapshot carries.
        """
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=1024)
        self._subscribers.setdefault(code, set()).add(q)
        return q

    def unsubscribe(self, code: str, q: asyncio.Queue[dict]) -> None:
        """Remove a previously subscribed queue. Safe to call if already removed."""
        subs = self._subscribers.get(code)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._subscribers.pop(code, None)

    async def publish(
        self,
        code: str,
        snapshots: Iterable[LiveSnapshot],
        *,
        now_ms: int | None = None,
    ) -> None:
        if now_ms is None:
            now_ms = int(time.time() * 1000)
        cutoff = now_ms - self._retention_ms
        entries: list[dict] = []
        async with self._lock:
            for s in snapshots:
                key = (code, s.kind.value)
                d = self._buf.get(key)
                if d is None:
                    d = deque(maxlen=MAX_BUFFER_ENTRIES)
                    self._buf[key] = d
                # Store payload + t_ms + kind together so subscribers know
                # which kind they received. Existing get_latest / get_series
                # helpers strip the `kind` field when building their responses.
                entry = {"t_ms": s.t_ms, "kind": s.kind.value, **s.payload}
                d.append(entry)
                entries.append(entry)
                while d and d[0]["t_ms"] < cutoff:  # 시간 기반 eviction
                    d.popleft()

        # Notify subscribers AFTER releasing the lock so slow consumers don't
        # block the publisher. Bounded queues drop on overflow.
        subs = self._subscribers.get(code)
        if subs:
            for entry in entries:
                for q in list(subs):
                    try:
                        q.put_nowait(entry)
                    except asyncio.QueueFull:
                        # Subscriber is too slow — drop this entry rather than
                        # blocking. Subscribers can recover via get_series() if
                        # they need the missing data.
                        pass

    async def get_latest(self, code: str) -> dict | None:
        """Latest snapshot across all three kinds, as a flat response dict.

        Returns None if no snapshots have ever been published for `code`.
        """
        async with self._lock:
            ob_buf = self._buf.get((code, SnapshotKind.OB.value))
            tr_buf = self._buf.get((code, SnapshotKind.TRADE.value))
            br_buf = self._buf.get((code, SnapshotKind.BROKER.value))
            if not ob_buf and not tr_buf and not br_buf:
                return None
            latest_ob = ob_buf[-1] if ob_buf else None
            latest_tr = tr_buf[-1] if tr_buf else None
            latest_br = br_buf[-1] if br_buf else None

        # Choose the most recent t_ms across kinds for the response anchor.
        candidates = [e for e in (latest_ob, latest_tr, latest_br) if e is not None]
        if not candidates:
            return None
        t_ms = max(e["t_ms"] for e in candidates)
        return {
            "code": code,
            "t_ms": t_ms,
            "phase": _phase_of(latest_ob or latest_tr or latest_br),
            "orderbook": _strip_meta(latest_ob),
            "recent_trades": _trades_list(latest_tr),
            "brokers": _strip_meta(latest_br),
        }

    async def get_series(self, code: str) -> dict:
        """All buffered snapshots for `code` as parallel arrays."""
        async with self._lock:
            ob_buf = self._buf.get((code, SnapshotKind.OB.value))
            tr_buf = self._buf.get((code, SnapshotKind.TRADE.value))
            br_buf = self._buf.get((code, SnapshotKind.BROKER.value))
            snapshots = tuple(ob_buf) if ob_buf else ()
            trades = tuple(tr_buf) if tr_buf else ()
            brokers = tuple(br_buf) if br_buf else ()

        return {
            "code": code,
            "snapshots": [_strip_t_only(e) for e in snapshots],
            "trades": [_strip_t_only(e) for e in trades],
            "brokers": [_strip_t_only(e) for e in brokers],
        }


def _phase_of(entry: dict | None) -> str:
    if entry is None:
        return "regular"
    return entry.get("phase", "regular")


def _strip_meta(entry: dict | None) -> dict | None:
    """Drop t_ms / phase / kind from a payload-merged entry for the spot response."""
    if entry is None:
        return None
    return {k: v for k, v in entry.items() if k not in ("t_ms", "phase", "kind")}


def _trades_list(entry: dict | None) -> list[dict]:
    if entry is None:
        return []
    return list(entry.get("trades", []))


def _strip_t_only(entry: dict) -> dict:
    """Return the entry as-is (t_ms is part of the shape consumers expect)."""
    return dict(entry)
