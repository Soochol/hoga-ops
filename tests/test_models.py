from hoga.api.models import SymbolMasterInfo
from hoga.api.error_codes import UpstreamCode


def test_symbol_master_info_minimal():
    info = SymbolMasterInfo(count=0, fetched_at_ms=None, status="unavailable", reason=None)
    assert info.count == 0
    assert info.fetched_at_ms is None
    assert info.status == "unavailable"
    assert info.reason is None


def test_symbol_master_info_with_reason():
    info = SymbolMasterInfo(
        count=0,
        fetched_at_ms=None,
        status="unavailable",
        reason=UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED,
    )
    assert info.reason == UpstreamCode.SYMBOL_MASTER_NOT_INITIALIZED


def test_symbol_master_info_populated():
    info = SymbolMasterInfo(count=6012, fetched_at_ms=1747900000000, status="fresh", reason=None)
    assert info.count == 6012
    assert info.status == "fresh"


def test_queue_item_attempt_defaults_to_1():
    from hoga.api.models import QueueItem
    item = QueueItem(
        item_id="x", code="005930", date="20260520",
        phase="queued", force_retry=False, pause_origin=False,
        enqueued_at_ms=1,
    )
    assert item.attempt == 1


def test_queue_item_attempt_accepts_explicit_value():
    from hoga.api.models import QueueItem
    item = QueueItem(
        item_id="x", code="005930", date="20260520",
        phase="queued", force_retry=False, pause_origin=False,
        enqueued_at_ms=1, attempt=3,
    )
    assert item.attempt == 3


def test_queue_manifest_item_attempt_defaults_to_1():
    """ADR-0031 manifest backward-compat: pre-existing manifest entries
    without `attempt` field must load with attempt=1, no version bump."""
    from hoga.api.models import QueueManifestItem
    legacy_json = (
        '{"item_id":"x","code":"005930","date":"20260520",'
        '"force_retry":false,"enqueued_at_ms":1,"pause_origin":false}'
    )
    item = QueueManifestItem.model_validate_json(legacy_json)
    assert item.attempt == 1
