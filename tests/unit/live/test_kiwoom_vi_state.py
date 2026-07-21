"""kiwoom_vi_state — 1h row 파싱(실측 legend)·last-write-wins·해제 재발화·리플레이 웜스타트.

골든 row 는 2026-07-21 실채록(data/research/kiwoom_vi_events)에서 그대로 옮겼다.
legend 근거: docs/research/2026-07-21-kiwoom-vi-price-sources.md (60건 전건 무모순).
"""
import json

from hoga.live.kiwoom_vi_capture import capture_path, replay_today
from hoga.live.kiwoom_vi_state import KiwoomViState, parse_vi_row

# 정적 상승 VI 발동(씨싸이트) — 1224=000000(미해제).
TRIGGER_STATIC_UP = {
    "type": "1h", "item": "109670_AL",
    "values": {
        "9001": "109670", "302": "씨싸이트", "13": "5063", "14": "19",
        "9068": "1", "9008": "101", "9075": "1", "1221": "3860",
        "1223": "114359", "1224": "000000", "1225": "정적",
        "1236": "3490", "1237": "0", "1238": "+10.60", "1239": "0.00",
        "1489": "+10.60", "1490": "1", "9069": "1", "1279": "+정적",
    },
}
# 같은 이벤트의 해제 재발화 — 1224 채워짐.
RELEASE_STATIC_UP = {
    "type": "1h", "item": "109670",
    "values": {**TRIGGER_STATIC_UP["values"], "1224": "114611"},
}
# 동적 하락 VI(아이오케이) — 정적기준(1236)=0 은 "해당 없음".
TRIGGER_DYNAMIC_DOWN = {
    "type": "1h", "item": "078860",
    "values": {
        "9001": "078860", "9068": "2", "9075": "1", "1221": "2700",
        "1223": "114602", "1224": "000000", "1225": "동적",
        "1236": "0", "1237": "2875", "1238": "0.00", "1239": "-6.09",
        "1490": "1", "9069": "2", "1279": "-동적",
    },
}


def test_parse_trigger_static_up():
    s = parse_vi_row(TRIGGER_STATIC_UP, 1000)
    assert s is not None
    assert s["code"] == "109670"  # _AL 접미 제거
    assert s["direction"] == "up"
    assert s["kind"] == "static"
    assert s["trigger_price"] == 3860
    assert s["static_base"] == 3490
    assert s["dynamic_base"] is None  # 0 = 해당 없음
    assert s["triggered_at"] == "114359"
    assert s["released_at"] is None  # 000000 = 미해제
    assert s["active"] is True
    assert s["count"] == 1
    assert s["recv_ms"] == 1000


def test_parse_dynamic_down_and_release():
    s = parse_vi_row(TRIGGER_DYNAMIC_DOWN, 1000)
    assert s is not None
    assert (s["direction"], s["kind"]) == ("down", "dynamic")
    assert s["static_base"] is None
    assert s["dynamic_base"] == 2875
    r = parse_vi_row(RELEASE_STATIC_UP, 2000)
    assert r is not None
    assert r["released_at"] == "114611"
    assert r["active"] is False


def test_parse_unknown_legend_code_dropped():
    bad = {"item": "109670", "values": {**TRIGGER_STATIC_UP["values"], "9069": "9"}}
    assert parse_vi_row(bad, 1000) is None


def test_state_last_write_wins_and_release_updates():
    st = KiwoomViState()
    st.on_row(TRIGGER_STATIC_UP, 1000)   # _AL row
    st.on_row({**TRIGGER_STATIC_UP, "item": "109670"}, 1001)  # bare 중복 — 동일 상태
    got = st.get("109670")
    assert got is not None and got["active"] is True
    st.on_row(RELEASE_STATIC_UP, 2000)
    got = st.get("109670")
    assert got is not None and got["active"] is False and got["released_at"] == "114611"
    assert st.get("000000") is None


def test_state_swallows_bad_rows():
    st = KiwoomViState()
    st.on_row({"item": None, "values": "garbage"}, 1000)  # no raise
    st.on_row({}, 1000)
    assert st.get("109670") is None


def test_replay_today_warm_starts_state(tmp_path):
    """당일 채록 JSONL 리플레이 — 재시작 후에도 최신 1건(해제 재발화 포함)이 복원된다."""
    now_ms = 1_768_960_000_000  # 임의 고정 시각(KST 날짜 파일명은 capture_path가 결정)
    path = capture_path(tmp_path, now_ms)
    path.parent.mkdir(parents=True)
    lines = [
        json.dumps({"recv_ms": 1000, "item": t["item"], "values": t["values"]},
                   ensure_ascii=False)
        for t in (TRIGGER_STATIC_UP, TRIGGER_DYNAMIC_DOWN, RELEASE_STATIC_UP)
    ]
    lines.insert(1, "not-json{")                              # 비-JSON 행 스킵
    lines.insert(2, json.dumps({"item": "109670"}))           # values 결손 행 스킵
    lines.append(json.dumps({"recv_ms": "1000", "item": "078860",
                             "values": TRIGGER_DYNAMIC_DOWN["values"]}))  # recv_ms 비-int 스킵
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    st = KiwoomViState()
    assert replay_today(tmp_path, now_ms, st.on_row) == 3
    released = st.get("109670")
    assert released is not None and released["active"] is False  # 해제 재발화가 최신
    assert released["released_at"] == "114611"
    active = st.get("078860")
    assert active is not None and active["active"] is True
    assert (active["direction"], active["kind"]) == ("down", "dynamic")


def test_replay_today_missing_file_is_inert(tmp_path):
    st = KiwoomViState()
    assert replay_today(tmp_path, 1_768_960_000_000, st.on_row) == 0
    assert st.get("109670") is None
