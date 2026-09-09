"""Typed historical job checkpoints; cancellation survives stale runner saves."""
import time
import uuid
from pathlib import Path

from hoga.api.models import HistoryJob, ScanRequest
from hoga.util.atomic_write import atomic_write_json

ACTIVE_STATUSES = frozenset({"queued", "collecting", "deriving"})


def create_job(request: ScanRequest, codes: list[str]) -> HistoryJob:
    return HistoryJob(id=uuid.uuid4().hex, status="queued", request=request.model_copy(deep=True),
                      codes=list(codes), total=0, done=0, written_rows=0, errors={},
                      started_at_ms=int(time.time() * 1000))


class JobCheckpoint:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "screener" / "history_job.json"

    def load(self) -> HistoryJob | None:
        if not self.path.exists():
            return None
        return HistoryJob.model_validate_json(self.path.read_text())

    def save(self, job: HistoryJob) -> None:
        existing = self.load()
        if existing is not None and existing.id == job.id and existing.cancel_requested:
            job.cancel_requested = True
        atomic_write_json(self.path, job.model_dump(mode="json"))
