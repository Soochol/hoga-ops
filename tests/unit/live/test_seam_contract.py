"""봉합 사이징 불변식(spec §8) — backend side of the seam contract.

The live buffer must retain long enough to bridge the today-indicator seam:
retention > Today-Promotion period + range-refetch period. WS 푸시 승격 무효화
(PR-3) keeps the 5-min refetch fallback, so this bound is unchanged; the later
fallback demotion must retune retention *together* or this test goes red — which
is the point. Mirrors frontend src/api/seamContract.test.ts.
"""
from hoga.api.startup_runtime import today_promoter_interval_from_env
from hoga.live.buffer import DEFAULT_RETENTION_MS

# Frontend TODAY_RANGE_REFETCH_MS (range.ts) — the range-refetch fallback period.
FRONTEND_REFETCH_MS = 300_000


def test_buffer_retention_covers_promote_plus_refetch():
    promote_ms = int(today_promoter_interval_from_env({}) * 1000)
    assert promote_ms + FRONTEND_REFETCH_MS < DEFAULT_RETENTION_MS
