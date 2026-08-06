"""`/api/range` 호가 파생 지표의 venue 격리 (#1133).

**이 파일이 막는 것**: venue 선택이 지표 계산에 도달하지 않는 것. 2026-08-06 실측으로
`/api/range?venue=NXT` 가 KRX 파케이를 그대로 돌려주고 있었다 — 287840 의 12:08 버킷에서
디스크 NXT 총잔량은 ask 701 / bid 825 인데 응답은 KRX 의 154 / 141 이었고, 세 venue 응답이
포인트 배열 단위로 **완전히 동일**했다.

원인은 두 겹이었다:

1. `build_range_bundle` 이 `resolve_source_result` 에 venue 를 안 넘겨, `source_covers_venue`
   가 걸러 냈어야 할 KRX 전용 소스(hogaplay)가 NXT 요청을 이겼다.
2. 슬라이스 빌더가 `engine.parquet_dir(date, code, source)` 로 경로를 **재계산**했고, 그
   시그니처에 venue 가 없어 `resolve_source_dir` 의 기본값 "KRX" 로 떨어졌다.

기존 픽스처엔 **한 Stock-Date 에 두 venue 파케이가 공존하는 케이스가 없어서** 두 결함 모두
테스트를 통과했다. 그래서 이 파일의 요점은 단언이 아니라 **픽스처 모양**이다 — 같은
(date, code) 아래 KRX·NXT 를 서로 다른 잔량으로 깔고, 값이 갈리는지 본다.
"""
from __future__ import annotations

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from hoga.api.bundle import build_quote_ratio_slice, build_range_bundle
from hoga.api.queries import QueryEngine

CODE = "005930"
DATE = "20260625"  # 확정 과거일 — 디스크 캐시 경로(ADR-0043 게이트)까지 함께 탄다
OPEN_MS = 90_000_000   # 09:00:00.000 HHMMSSmmm
CLOSE_MS = 153_000_000  # 15:30:00.000

# venue 별 호가 1단 수량. 총잔량은 10단 합이므로 KRX=10*1=10... 이 아니라 아래 헬퍼 참조.
KRX_ASK_Q, KRX_BID_Q = 1, 2
NXT_ASK_Q, NXT_BID_Q = 30, 40


def _hms_native(h: int, m: int, s: int) -> int:
    return h * 10_000_000 + m * 100_000 + s * 1000


def _write_snapshots(path: Path, ts_list: list[int], *, ask_q: int, bid_q: int) -> None:
    """10단 전부 채운 연속거래 호가창 — 3단 붕괴 감지(ADR-0062)에 걸리지 않게."""
    n = len(ts_list)
    cols: dict = {"ts_ms": ts_list, "seq": list(range(1, n + 1))}
    for i in range(1, 11):
        cols[f"ask_p{i}"] = [100 + i] * n
        cols[f"ask_q{i}"] = [ask_q] * n
        cols[f"ask_d{i}"] = [0] * n
        cols[f"bid_p{i}"] = [100 - i] * n
        cols[f"bid_q{i}"] = [bid_q] * n
        cols[f"bid_d{i}"] = [0] * n
    cols["tot_ask"] = [ask_q * 10] * n
    cols["tot_ask_d"] = [0] * n
    cols["tot_bid"] = [bid_q * 10] * n
    cols["tot_bid_d"] = [0] * n
    pq.write_table(pa.table(cols), path)


def _write_venue(tmp_path: Path, venue: str, *, ask_q: int, bid_q: int) -> None:
    d = tmp_path / "parquet" / DATE / CODE / "kiwoom_live" / venue
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps({
        "regular_session_open_ms": OPEN_MS,
        "regular_session_close_ms": CLOSE_MS,
        "collection_complete": True,
        "is_partial": False,
    }))
    _write_snapshots(
        d / "snapshots.parquet",
        [_hms_native(9, 0, 10), _hms_native(9, 1, 10)],
        ask_q=ask_q, bid_q=bid_q,
    )


def _engine_with_both_venues(tmp_path: Path) -> QueryEngine:
    _write_venue(tmp_path, "KRX", ask_q=KRX_ASK_Q, bid_q=KRX_BID_Q)
    _write_venue(tmp_path, "NXT", ask_q=NXT_ASK_Q, bid_q=NXT_BID_Q)
    return QueryEngine(tmp_path)


def _totals(slice_) -> set[tuple[int, int]]:
    return {(p.bid_total, p.ask_total) for p in slice_.points if p.bid_total or p.ask_total}


def test_quote_ratio_slice_reads_the_requested_venue(tmp_path: Path) -> None:
    """빌더가 요청 venue 의 파케이를 읽는다 — 두 venue 가 공존해야 드러나는 성질."""
    eng = _engine_with_both_venues(tmp_path)
    common = {"code": CODE, "date": DATE, "bucket_ms": 60_000, "source": "kiwoom_live",
              "session_open_ms": OPEN_MS, "session_close_ms": CLOSE_MS}

    krx = build_quote_ratio_slice(eng, venue="KRX", **common)
    nxt = build_quote_ratio_slice(eng, venue="NXT", **common)

    assert _totals(krx) == {(KRX_BID_Q * 10, KRX_ASK_Q * 10)}
    assert _totals(nxt) == {(NXT_BID_Q * 10, NXT_ASK_Q * 10)}


def test_range_bundle_quote_ratio_differs_by_venue(tmp_path: Path) -> None:
    """엔드투엔드 — `/api/range` 가 부르는 조립점에서도 venue 가 갈린다.

    빌더 단위 테스트와 따로 두는 이유: 결함 ①(사다리에 venue 미전달)은 **조립점에만**
    있었고 빌더는 그 아래였다. 한 층만 보면 절반을 놓친다.
    """
    eng = _engine_with_both_venues(tmp_path)
    common = {"code": CODE, "from_date": DATE, "to_date": DATE, "bucket_ms": 60_000,
              "source_pref": "hogaplay", "mode": "hoga"}

    krx = build_range_bundle(eng, venue="KRX", **common)
    nxt = build_range_bundle(eng, venue="NXT", **common)

    assert _totals(krx.quote_ratio) == {(KRX_BID_Q * 10, KRX_ASK_Q * 10)}
    assert _totals(nxt.quote_ratio) == {(NXT_BID_Q * 10, NXT_ASK_Q * 10)}
    assert krx.quote_ratio.points != nxt.quote_ratio.points


def test_past_indicator_cache_does_not_leak_across_venues(tmp_path: Path) -> None:
    """한 venue 의 디스크 캐시가 다른 venue 요청에 서빙되지 않는다.

    캐시 키가 (code, date, source) 뿐이던 동안엔 경로 수정만으로는 부족했다 — 먼저 계산된
    venue 의 1분 정본이 뒤 요청에 그대로 나갔다. **먼저 KRX 를 계산해 캐시를 채운 뒤** NXT
    를 묻는 순서가 이 테스트의 요점이다.
    """
    eng = _engine_with_both_venues(tmp_path)
    common = {"code": CODE, "date": DATE, "bucket_ms": 60_000, "source": "kiwoom_live",
              "session_open_ms": OPEN_MS, "session_close_ms": CLOSE_MS}

    build_quote_ratio_slice(eng, venue="KRX", **common)          # 캐시 채우기
    nxt = build_quote_ratio_slice(eng, venue="NXT", **common)    # 콜드여야 한다

    assert _totals(nxt) == {(NXT_BID_Q * 10, NXT_ASK_Q * 10)}
    # 캐시 아티팩트도 venue 별로 갈려 있어야 한다(경로 규율 = parquet 트리와 동일).
    store = tmp_path / "kis-past-indicators" / CODE / "kiwoom_live"
    assert (store / "KRX" / f"{DATE}.ratio.json").exists()
    assert (store / "NXT" / f"{DATE}.ratio.json").exists()


def test_trade_indicator_source_stays_inside_the_requested_venue(tmp_path: Path) -> None:
    """⚠ 체결 지표 소스 재선택은 **사다리를 안 탄다** — 실측 2026-08-07 로 뚫린 구멍.

    `_resolve_trade_indicator_source` 는 `resolve_source_result` 가 아니라
    `ordered_sources` 를 직접 순회한다. 그래서 사다리의 venue 필터가 적용되지 않아
    venue=NXT 요청이 hogaplay(KRX 전용)를 골랐고, 매물대·거래량 POC 가 KRX 데이터로
    계산됐다. `source_venue_dir` 이 venue 축 없는 source 엔 세그먼트를 안 붙여
    `{code}/hogaplay` 가 그대로 존재했기 때문에 존재 검사도 통과했다.

    "사다리가 미리 거른다" 는 방어가 **사다리를 안 쓰는 경로**에서 무너지는 형태라,
    같은 모양의 재선택 코드가 또 생기면 다시 뚫린다 — 그래서 `source_venue_dir` 에도
    구조적 가드를 뒀고 이 테스트는 호출부 쪽 절반을 고정한다.
    """
    from hoga.api.bundle import _resolve_trade_indicator_source

    for rel in ("hogaplay", "kiwoom_live/KRX"):  # NXT 는 일부러 만들지 않는다
        d = tmp_path / "parquet" / DATE / CODE / rel
        d.mkdir(parents=True)
        (d / "meta.json").write_text(json.dumps({
            "regular_session_open_ms": OPEN_MS,
            "regular_session_close_ms": CLOSE_MS,
            "collection_complete": True,
            "is_partial": False,
        }))
        pq.write_table(
            pa.table({"ts_ms": [_hms_native(9, 0, 10)], "seq": [1],
                      "price": [100], "qty": [1], "side": [1]}),
            d / "trades.parquet",
        )
    eng = QueryEngine(tmp_path)
    common = {"date": DATE, "code": CODE, "source_pref": "hogaplay",
              "selected_source": "kiwoom_live"}

    # KRX 는 그대로. NXT 에서 hogaplay 로 넘어가면 **다른 시장 체결**을 쓰는 것이다.
    assert _resolve_trade_indicator_source(eng, venue="KRX", **common) == "kiwoom_live"
    assert _resolve_trade_indicator_source(eng, venue="NXT", **common) == "kiwoom_live"


def test_krx_only_source_does_not_win_an_nxt_request(tmp_path: Path) -> None:
    """hogaplay 는 NXT 를 원리적으로 못 준다 — 사다리에서 빠져야 한다(빈 응답이 정답).

    2026-08-05 실측: 이 필터가 없던 동안 최근 6일 720건 중 494건(69%)이 hogaplay 로
    해소되며 **KRX 데이터를 NXT 라고** 돌려줬다. `source_covers_venue` 가 그걸 막는데,
    조립점이 venue 를 안 넘기면 그 필터가 아예 실행되지 않는다.
    """
    d = tmp_path / "parquet" / DATE / CODE / "hogaplay"
    d.mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps({
        "regular_session_open_ms": OPEN_MS,
        "regular_session_close_ms": CLOSE_MS,
        "collection_complete": True,
        "is_partial": False,
    }))
    _write_snapshots(
        d / "snapshots.parquet",
        [_hms_native(9, 0, 10), _hms_native(9, 1, 10)],
        ask_q=KRX_ASK_Q, bid_q=KRX_BID_Q,
    )
    eng = QueryEngine(tmp_path)
    common = {"code": CODE, "from_date": DATE, "to_date": DATE, "bucket_ms": 60_000,
              "source_pref": "hogaplay", "mode": "hoga"}

    krx = build_range_bundle(eng, venue="KRX", **common)
    nxt = build_range_bundle(eng, venue="NXT", **common)
    assert _totals(krx.quote_ratio) == {(KRX_BID_Q * 10, KRX_ASK_Q * 10)}
    assert _totals(nxt.quote_ratio) == set()
