from __future__ import annotations

from pathlib import Path

from hoga.api.models import ParquetStudySnapshot
from hoga.api.study_view_enrichment import enrich_snapshot_with_details


def prepare_restorable_snapshot(
    data_dir: Path, snapshot: ParquetStudySnapshot
) -> ParquetStudySnapshot:
    """Prepare a 저장 학습뷰 snapshot as a self-contained `/study` artifact.

    The saved snapshot keeps the source chosen at save time (`source_policy=
    "fixed"`) and best-effort enriches visible candle buckets with parquet
    detail. Detail failures stay non-fatal and surface through
    `bundle.detail_warnings`.
    """

    fixed_snapshot = snapshot.model_copy(update={"source_policy": "fixed"})
    return enrich_snapshot_with_details(data_dir, fixed_snapshot)
