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


def test_capture_dismissed_event_carries_item_ids():
    from hoga.api.models import CaptureDismissedEvent
    e = CaptureDismissedEvent(item_ids=["a", "b"])
    assert e.type == "capture_dismissed"
    assert e.item_ids == ["a", "b"]


def test_retry_request_accepts_item_ids_list():
    from hoga.api.models import RetryRequest
    req = RetryRequest(item_ids=["x", "y"])
    assert req.item_ids == ["x", "y"]


def test_retry_request_rejects_empty_item_ids():
    """Per ADR-0031: empty retry call is a usage error, not a no-op."""
    import pytest
    from pydantic import ValidationError
    from hoga.api.models import RetryRequest
    with pytest.raises(ValidationError):
        RetryRequest(item_ids=[])


def test_retry_skipped_row_reasons_are_constrained():
    """Reason field is a Literal of the 4 documented skip reasons."""
    import pytest
    from pydantic import ValidationError
    from hoga.api.models import RetrySkippedRow
    for reason in ("not_found", "not_failed", "already_in_queue", "already_running"):
        RetrySkippedRow(item_id="x", reason=reason)
    with pytest.raises(ValidationError):
        RetrySkippedRow(item_id="x", reason="something_else")


def test_retry_response_shape():
    from hoga.api.models import QueueItem, RetryResponse, RetrySkippedRow
    item = QueueItem(
        item_id="new", code="005930", date="20260520",
        phase="queued", force_retry=False, pause_origin=False,
        enqueued_at_ms=1, attempt=2,
    )
    resp = RetryResponse(
        enqueued=[item],
        skipped=[RetrySkippedRow(item_id="old", reason="not_found")],
    )
    assert resp.enqueued[0].attempt == 2
    assert resp.skipped[0].reason == "not_found"


def test_enqueue_deduped_row_accepts_already_complete():
    from hoga.api.models import EnqueueDedupedRow
    row = EnqueueDedupedRow(code="005930", date="20260520", reason="already_complete")
    assert row.reason == "already_complete"


def test_enqueue_deduped_row_accepts_already_skipped():
    from hoga.api.models import EnqueueDedupedRow
    row = EnqueueDedupedRow(code="005930", date="20260520", reason="already_skipped")
    assert row.reason == "already_skipped"


def test_enqueue_deduped_row_rejects_unknown_reason():
    import pytest
    from pydantic import ValidationError
    from hoga.api.models import EnqueueDedupedRow
    with pytest.raises(ValidationError):
        EnqueueDedupedRow(code="005930", date="20260520", reason="bogus_reason")
