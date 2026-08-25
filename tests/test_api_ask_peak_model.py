from hoga.api.models import AskPeak, AskPeakCandidate


def test_bid_peak_model_accepts_ranked_candidates():
    from hoga.api.models import BidPeak

    peak = BidPeak(
        date="20260613",
        price=24900,
        qty=9000,
        t_ms=1,
        max_price=24900,
        max_qty=9000,
        max_t_ms=1,
        traded_peaks=[AskPeakCandidate(price=24900, qty=9000, t_ms=1)],
        traded_max_peaks=[AskPeakCandidate(price=24900, qty=9000, t_ms=1)],
    )

    assert peak.traded_peaks[0].price == 24900
    assert peak.traded_max_peaks[0].qty == 9000


def test_peak_models_allow_nullable_post_touch_scalars() -> None:
    from hoga.api.models import BidPeak

    ask_peak = AskPeak(
        date="20260617",
        price=None,
        qty=None,
        t_ms=None,
        max_price=None,
        max_qty=None,
        max_t_ms=None,
        all_price=26000,
        all_qty=9000,
        all_t_ms=1781658000000,
        all_max_price=26100,
        all_max_qty=9100,
        all_max_t_ms=1781658060000,
    )
    bid_peak = BidPeak(
        date="20260619",
        price=None,
        qty=None,
        t_ms=None,
        max_price=None,
        max_qty=None,
        max_t_ms=None,
        all_price=69800,
        all_qty=9000,
        all_t_ms=1781827200000,
        all_max_price=69700,
        all_max_qty=9100,
        all_max_t_ms=1781827260000,
    )

    assert ask_peak.price is None
    assert ask_peak.max_t_ms is None
    assert bid_peak.price is None
    assert bid_peak.max_t_ms is None


def test_rep_outputs_keep_candidates_as_models_not_dicts():
    """`_peak_with_rep_outputs` 가 후보를 **모델로** 남겨야 한다.

    그 함수는 `model_copy(update=...)` 로 필드를 덮는데 **그 경로는 검증을 하지
    않는다.** 그래서 `_ask_candidate` 가 dict 를 돌려주던 시절에는 선언
    (`list[AskPeakCandidate]`)과 실제 값(dict)이 어긋난 채 남았고, 직렬화 때
    `PydanticSerializationUnexpectedValue` 가 경고로 흘렀다 — 값은 우연히 같게
    나갔지만 **검증을 건너뛴 채**였다(2026-08-24 사용자 로그에서 발견).

    ⚠ **이 경로는 그전까지 테스트가 하나도 없었다.** 그래서 경고 기반 전역 가드
    (`filterwarnings`)를 걸어도 원리적으로 못 잡았다 — 실행되지 않는 코드는 경고를
    내지 않는다. 커버리지가 먼저다.
    """
    import warnings

    from hoga.api.bundle import _peak_with_rep_outputs
    from hoga.tables import snapshots as snapshots_tbl

    base = AskPeak(
        date="20260613", price=1, qty=1, t_ms=1,
        max_price=1, max_qty=1, max_t_ms=1,
    )
    reduced = {
        "all_close": (24100, 300, 34_199_927),
        "traded_close": (24050, 200, 33_599_718),
        "traded_peaks": (snapshots_tbl.AskPeakCandidateRow(price=24100, qty=300, intra_ms=34_199_927),),
        # `reaggregate_peak_rep` 가 2026-08-25 부터 함께 낸다(굵은 봉의 all top-3).
        # 픽스처가 생산자 모양을 따라가야 이 테스트가 실제 경로를 재는 것이 된다.
        "all_peaks": (snapshots_tbl.AskPeakCandidateRow(price=24150, qty=500, intra_ms=34_100_000),),
    }

    out = _peak_with_rep_outputs(base, date="20260613", reduced=reduced)

    assert out is not None
    for field in ("traded_peaks", "all_peaks"):
        first = getattr(out, field)[0]
        assert isinstance(first, AskPeakCandidate), (
            f"{field} 에 dict 가 그대로 들어갔다: {type(first).__name__}"
        )

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        out.model_dump_json()
    offenders = [str(w.message) for w in caught if "Pydantic serializer warnings" in str(w.message)]
    assert not offenders, offenders
