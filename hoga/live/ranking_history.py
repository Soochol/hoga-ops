"""Persist dated, unfiltered ranking observations, independently of the TTL cache."""
from __future__ import annotations

import json
import logging
from dataclasses import replace
from datetime import datetime, time
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from hoga.live.kiwoom_rankings import RankingSnapshot
from hoga.live.ranking_session import RankingBasis, RankingSession
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
_ADAPTER = TypeAdapter(RankingSnapshot)


def _prefix(kind, market, direction, venue):
    return f"{kind}-{market}-{direction if kind == 'change' else 'up'}-{venue}"


def save(data_dir: Path, snapshot: RankingSnapshot, limit: int) -> None:
    basis = snapshot.basis
    if basis is None or basis.source != "live" or basis.trading_date is None:
        return
    prefix = _prefix(snapshot.kind, snapshot.market, snapshot.direction, snapshot.venue or snapshot.quote_venue)
    path = data_dir / "rankings" / basis.trading_date / f"{prefix}-{limit}.json"
    atomic_write_json(path, {"schema_version": 1, "snapshot": _ADAPTER.dump_python(snapshot, mode="json")})


def load(data_dir: Path, session: RankingSession, kind, market, direction, venue, limit: int):
    if session.date is None:
        return None
    folder = data_dir / "rankings" / session.date.isoformat()
    candidates = []
    for path in folder.glob(f"{_prefix(kind, market, direction, venue)}-*.json"):
        try:
            value = json.loads(path.read_text())
            if value.get("schema_version") != 1:
                continue
            snap = _ADAPTER.validate_python(value["snapshot"])
            basis = snap.basis
            observed = datetime.fromtimestamp(snap.fetched_at_ms / 1000, KST)
            opening = time(9) if venue == "KRX" or kind in {"institution", "foreign"} else time(8)
            if (basis is None or basis.source != "live" or basis.trading_date != session.date.isoformat()
                    or basis.session not in {"open", "closed"} or observed.time() < opening
                    or basis.observed_at_ms != snap.fetched_at_ms
                    or observed.date() != session.date
                    or (snap.kind, snap.market, snap.direction, snap.venue or snap.quote_venue)
                    != (kind, market, direction, venue)):
                continue
            if snap.queried_count < limit and snap.has_more:
                continue
            candidates.append(snap)
        except (OSError, ValueError, KeyError, OverflowError, ValidationError):
            log.warning("저장 순위를 읽을 수 없습니다: %s", path, exc_info=True)
    if not candidates:
        return None
    snap = max(candidates, key=lambda item: item.fetched_at_ms)
    return replace(snap, rows=tuple(row for row in snap.rows if row.rank <= limit),
        queried_count=min(snap.queried_count, limit), has_more=snap.has_more or snap.queried_count > limit,
        market_open=False, basis=RankingBasis(session=session.state, source="stored",
            trading_date=session.date.isoformat(), observed_at_ms=snap.fetched_at_ms,
            message="최근 거래일의 저장된 순위를 사용합니다."))
