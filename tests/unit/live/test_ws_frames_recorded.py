"""Task 0 녹화본 재생 — 합성 테스트가 못 잡는 '실제 필드 레이아웃' 검증.

⚠️ Task 1의 합성 fixture는 파서와 같은 인덱스 상수로 생성되어 레이아웃에 대해
동어반복이다(plan Task 1 헤더 경고; C1 46-stride 결함이 그 실증). 이 재생
테스트만이 인덱스의 진실을 검증한다 — 녹화 전엔 SKIP으로 가시화되고,
Task 14(장중 스모크) 전 필수 통과다.
"""
from pathlib import Path

import pytest

from hoga.live.ws_frames import parse_message

FIX = Path("tests/fixtures/kis_ws")
RECORD_DATE = "20260605"  # 녹화 후 tests/fixtures/kis_ws/README.md의 녹화일과 일치시킬 것

requires_recording = pytest.mark.skipif(
    not (FIX / "h0stasp0.txt").exists(),
    reason="Task 0 녹화본 없음 — 장중 1회 scripts/record_kis_ws_frames.py 실행 필요",
)


@requires_recording
def test_recorded_orderbook_plausible():
    best_asks = []
    for raw in (FIX / "h0stasp0.txt").read_text().splitlines():
        for t in parse_message(raw, date=RECORD_DATE, now_ms=0):
            p = t.payload
            asks = [lv["price"] for lv in p["asks"] if lv["price"] > 0]
            bids = [lv["price"] for lv in p["bids"] if lv["price"] > 0]
            assert asks == sorted(asks), "매도호가 1→10은 오름차순이어야"
            assert bids == sorted(bids, reverse=True), "매수호가 1→10은 내림차순"
            if asks and bids:
                assert bids[0] < asks[0], "최우선 매수 < 최우선 매도"
                best_asks.append(asks[0])
            assert p["total_ask_qty"] > 0 and p["total_bid_qty"] > 0
    assert best_asks, "유효 호가 프레임 0개 — 녹화/인덱스 점검"
    assert max(best_asks) / min(best_asks) < 1.3, "가격 산포 30%+ — 인덱스 어긋남 의심"


@requires_recording
def test_recorded_trades_plausible():
    sides: set[int] = set()
    for raw in (FIX / "h0stcnt0.txt").read_text().splitlines():
        for t in parse_message(raw, date=RECORD_DATE, now_ms=0):
            for tr in t.payload["trades"]:
                assert tr["price"] > 0 and tr["qty"] > 0
                sides.add(tr["side"])
    assert sides <= {-1, 0, 1}
    assert {1, -1} <= sides, "매수/매도 양쪽이 관찰돼야 — side 인덱스(21) 점검"


@requires_recording
def test_recorded_trades_stride_exact():
    """exact-equality stride 가드의 전제(trailing 구분자 0개)를 실프레임으로 검증
    (Task 1 재리뷰 잔여 조건)."""
    seen_multi = False
    for raw in (FIX / "h0stcnt0.txt").read_text().splitlines():
        _, _tr, cnt_s, body = raw.split("|", 3)
        cnt = int(cnt_s)
        assert len(body.split("^")) == cnt * 46, "stride 46×cnt 정확 성립 실패 — 가드 완화 필요"
        if cnt >= 2:
            seen_multi = True
    assert seen_multi, "cnt≥2 멀티레코드 미관찰 — 더 활발한 종목/시간대로 재녹화"


@requires_recording
def test_recorded_member_plausible():
    seen = False
    for raw in (FIX / "h0stmbc0.txt").read_text().splitlines():
        for t in parse_message(raw, date=RECORD_DATE, now_ms=1):
            seen = True
            tops = t.payload["sell_top"] + t.payload["buy_top"]
            assert any(e["name"] for e in tops), "회원사명 전부 빈 문자열 — 인덱스 점검"
            assert all(e["qty"] >= 0 for e in tops)
    # MBC 주기가 길어 0개일 수 있음 — README에 주기 기록 (plan Task 0 Step 2)
    if not seen:
        pytest.skip("H0STMBC0 프레임 0개 — 녹화 시간 연장 필요(주기 기록)")
