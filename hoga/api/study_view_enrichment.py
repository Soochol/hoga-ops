from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from hoga.api.models import (
    ParquetStudySnapshot,
    StudyBrokerBucket,
    StudyBrokerDetail,
    StudyDetailWarning,
    StudyOrderbookBucket,
)
from hoga.api.queries import QueryEngine
from hoga.api.sources import SourceName
from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms
from hoga.tables import brokers as brokers_tbl
from hoga.tables import snapshots as snapshots_tbl


@dataclass(frozen=True)
class _Bucket:
    t: int
    date: str
    source: SourceName
    lo_native: int
    hi_native: int


def enrich_snapshot_with_details(
    data_dir: Path, snapshot: ParquetStudySnapshot
) -> ParquetStudySnapshot:
    engine = QueryEngine(data_dir)
    try:
        bucket_ms = _bucket_ms(snapshot.timeframe)
        buckets, warnings = _resolve_buckets(snapshot, bucket_ms)

        orderbook_by_t: dict[int, StudyOrderbookBucket] = {}
        broker_by_t: dict[int, StudyBrokerBucket] = {}

        grouped: dict[tuple[str, SourceName], list[_Bucket]] = {}
        for bucket in buckets:
            grouped.setdefault((bucket.date, bucket.source), []).append(bucket)

        for (date, source), group in grouped.items():
            try:
                code_dir = engine.parquet_dir(date, snapshot.code, source)
            except Exception:
                for bucket in group:
                    warnings.append(
                        StudyDetailWarning(
                            kind="orderbook",
                            t=bucket.t,
                            code=snapshot.code,
                            date=date,
                            message=f"parquet source missing: {source}",
                        )
                    )
                    warnings.append(
                        StudyDetailWarning(
                            kind="broker",
                            t=bucket.t,
                            code=snapshot.code,
                            date=date,
                            message=f"parquet source missing: {source}",
                        )
                    )
                continue
            orderbook_by_t.update(
                _load_orderbooks(
                    engine, code_dir, snapshot.code, date, source, group, warnings
                )
            )
            broker_by_t.update(
                _load_brokers(engine, code_dir, snapshot.code, date, group, warnings)
            )

        orderbook_buckets = [
            orderbook_by_t.get(
                candle.t,
                StudyOrderbookBucket(t=candle.t, snapshot=None, available=False),
            )
            for candle in snapshot.bundle.candles
        ]
        broker_buckets = [
            broker_by_t.get(
                candle.t,
                StudyBrokerBucket(t=candle.t, brokers=[], available=False),
            )
            for candle in snapshot.bundle.candles
        ]
        enriched_bundle = snapshot.bundle.model_copy(
            update={
                "orderbook_buckets": orderbook_buckets,
                "broker_buckets": broker_buckets,
                "detail_warnings": [*snapshot.bundle.detail_warnings, *warnings],
            }
        )
        return snapshot.model_copy(update={"bundle": enriched_bundle})
    finally:
        engine.close()


def _bucket_ms(timeframe: str) -> int:
    mapping = {
        "1m": 60_000,
        "3m": 180_000,
        "5m": 300_000,
        "10m": 600_000,
        "15m": 900_000,
        "30m": 1_800_000,
        "D": 86_400_000,
        "W": 7 * 86_400_000,
        "M": 31 * 86_400_000,
    }
    return mapping.get(timeframe, 60_000)


def _resolve_buckets(
    snapshot: ParquetStudySnapshot, bucket_ms: int
) -> tuple[list[_Bucket], list[StudyDetailWarning]]:
    warnings: list[StudyDetailWarning] = []
    out: list[_Bucket] = []
    for candle in snapshot.bundle.candles:
        segment = next(
            (
                seg
                for seg in snapshot.bundle.segments
                if seg.session_open_ms <= candle.t <= seg.session_close_ms
            ),
            None,
        )
        if segment is None:
            warnings.append(
                StudyDetailWarning(
                    kind="orderbook",
                    t=candle.t,
                    code=snapshot.code,
                    date=None,
                    message="saved candle has no matching segment",
                )
            )
            warnings.append(
                StudyDetailWarning(
                    kind="broker",
                    t=candle.t,
                    code=snapshot.code,
                    date=None,
                    message="saved candle has no matching segment",
                )
            )
            continue
        date = segment.date
        try:
            lo_native = unix_ms_to_hhmmssms(date, candle.t)
            hi_native = unix_ms_to_hhmmssms(date, candle.t + bucket_ms - 1)
        except ValueError:
            warnings.append(
                StudyDetailWarning(
                    kind="orderbook",
                    t=candle.t,
                    code=snapshot.code,
                    date=date,
                    message="could not convert saved candle time to native time",
                )
            )
            warnings.append(
                StudyDetailWarning(
                    kind="broker",
                    t=candle.t,
                    code=snapshot.code,
                    date=date,
                    message="could not convert saved candle time to native time",
                )
            )
            continue
        out.append(
            _Bucket(
                t=candle.t,
                date=date,
                source=segment.source,
                lo_native=lo_native,
                hi_native=hi_native,
            )
        )
    return out, warnings


def _load_orderbooks(
    engine: QueryEngine,
    code_dir: Path,
    code: str,
    date: str,
    source: SourceName,
    buckets: list[_Bucket],
    warnings: list[StudyDetailWarning],
) -> dict[int, StudyOrderbookBucket]:
    path = code_dir / "snapshots.parquet"
    if not path.exists():
        for bucket in buckets:
            warnings.append(
                StudyDetailWarning(
                    kind="orderbook",
                    t=bucket.t,
                    code=code,
                    date=date,
                    message="snapshots.parquet missing",
                )
            )
        return {}
    try:
        meta = engine.get_meta(date, code, source)
        representatives = snapshots_tbl.query_bucket_representatives(
            engine.conn,
            path=path,
            buckets=[(bucket.lo_native, bucket.hi_native) for bucket in buckets],
            session_close_ms=meta.get("regular_session_close_ms"),
        )
    except Exception as exc:
        for bucket in buckets:
            warnings.append(
                StudyDetailWarning(
                    kind="orderbook",
                    t=bucket.t,
                    code=code,
                    date=date,
                    message=f"orderbook enrichment failed: {exc}",
                )
            )
        return {}

    out: dict[int, StudyOrderbookBucket] = {}
    by_lo = {bucket.lo_native: bucket for bucket in buckets}
    for lo_native, snap in representatives.items():
        bucket = by_lo.get(lo_native)
        if bucket is None:
            continue
        out[bucket.t] = StudyOrderbookBucket(
            t=bucket.t,
            snapshot=snap.model_copy(
                update={"ts_ms": hhmmssms_to_unix_ms(date, snap.ts_ms)}
            ),
            available=True,
        )
    for bucket in buckets:
        if bucket.t not in out:
            warnings.append(
                StudyDetailWarning(
                    kind="orderbook",
                    t=bucket.t,
                    code=code,
                    date=date,
                    message="no continuous representative for saved candle bucket",
                )
            )
    return out


def _load_brokers(
    engine: QueryEngine,
    code_dir: Path,
    code: str,
    date: str,
    buckets: list[_Bucket],
    warnings: list[StudyDetailWarning],
) -> dict[int, StudyBrokerBucket]:
    path = code_dir / "brokers.parquet"
    if not path.exists():
        for bucket in buckets:
            warnings.append(
                StudyDetailWarning(
                    kind="broker",
                    t=bucket.t,
                    code=code,
                    date=date,
                    message="brokers.parquet missing",
                )
            )
        return {}
    try:
        details = brokers_tbl.query_cumulative_details_at(
            engine.conn,
            path=path,
            t_values=[bucket.hi_native for bucket in buckets],
        )
    except Exception as exc:
        for bucket in buckets:
            warnings.append(
                StudyDetailWarning(
                    kind="broker",
                    t=bucket.t,
                    code=code,
                    date=date,
                    message=f"broker enrichment failed: {exc}",
                )
            )
        return {}

    out: dict[int, StudyBrokerBucket] = {}
    by_hi = {bucket.hi_native: bucket for bucket in buckets}
    for hi_native, rows in details.items():
        bucket = by_hi.get(hi_native)
        if bucket is None or not rows:
            continue
        out[bucket.t] = StudyBrokerBucket(
            t=bucket.t,
            available=True,
            brokers=[
                StudyBrokerDetail(
                    broker=row.broker, net=row.net, dominant_side=row.dominant_side
                )
                for row in rows
            ],
        )
    return out
