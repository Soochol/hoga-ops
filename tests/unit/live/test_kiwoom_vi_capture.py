"""kiwoom_vi_capture + ws client 1h 관측 경로.

FakeServer 는 test_kiwoom_ws_client 의 서버형 fake 를 재사용한다(동시 recv 거부
불변식 포함) — VI REG 추가가 단일 recv 루프 규율을 깨면 여기서도 잡힌다.
"""
import asyncio
import json

import pytest

from hoga.live import kiwoom_ws_client as M
from hoga.live.kiwoom_vi_capture import KiwoomViCapture

from .test_kiwoom_ws_client import FakeServer, _cancel, _client, _run_briefly


@pytest.fixture(autouse=True)
def _no_pacing(monkeypatch):
    # autouse 는 모듈 경계를 넘지 않는다 — 원 모듈과 동일하게 REG 페이싱 제거.
    monkeypatch.setattr(M, "_REG_PACING_S", 0.0)

# 공식 예제 구조의 1h row — 9068/9069/9075 는 legend 미해독이라 raw 문자열 그대로.
VI_ROW = {
    "type": "1h", "item": "005930",
    "values": {
        "9001": "005930", "1221": "72400", "1225": "정적",
        "9068": "1", "9069": "1", "9075": "1",
        "1223": "101512", "1224": "000000",
    },
}
REAL_1H = {"trnm": "REAL", "data": [VI_ROW]}


# --- KiwoomViCapture ---


def test_record_appends_raw_jsonl_per_kst_date(tmp_path):
    cap = KiwoomViCapture(tmp_path)
    # 2026-07-21 KST 10:00 = 1784941200000... 대신 KST 자정 경계로 날짜 분할을 본다.
    day1_ms = 1752994800000  # 2025-07-20 16:00 KST
    day2_ms = day1_ms + 24 * 3600 * 1000
    cap.record(VI_ROW, day1_ms)
    cap.record(VI_ROW, day1_ms + 1000)
    cap.record(VI_ROW, day2_ms)
    files = sorted((tmp_path / "research" / "kiwoom_vi_events").glob("*.jsonl"))
    assert len(files) == 2
    lines = files[0].read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    rec = json.loads(lines[0])
    assert rec["recv_ms"] == day1_ms
    assert rec["item"] == "005930"
    # raw 보존 — legend 미해독 필드가 그대로 남아야 해독 근거가 된다.
    assert rec["values"]["9069"] == "1"
    assert rec["values"]["1225"] == "정적"


def test_record_swallows_write_failure(tmp_path):
    # 디렉터리 자리에 파일을 만들어 mkdir 를 실패시킨다 — 예외가 밖으로 안 나와야 한다.
    (tmp_path / "research").write_text("not a dir")
    cap = KiwoomViCapture(tmp_path)
    cap.record(VI_ROW, 1752994800000)  # no raise


# --- ws client 1h 경로 ---


async def test_vi_reg_sent_and_rows_captured():
    seen: list[tuple[dict, int]] = []
    ws = FakeServer()
    client = _client(ws, on_vi_row=lambda row, ms: seen.append((row, ms)))
    task = await _run_briefly(client, ["005930"])
    # REG 2건: 종목 배치 + VI(item=[""], type=["1h"]).
    regs = [json.loads(s) for s in ws.sent if json.loads(s).get("trnm") == "REG"]
    assert len(regs) == 2
    vi_reg = regs[1]["data"][0]
    assert vi_reg["item"] == [""]
    assert vi_reg["type"] == ["1h"]
    ws.push(json.dumps(REAL_1H))
    await asyncio.sleep(0.02)
    assert len(seen) == 1
    row, recv_ms = seen[0]
    assert row["values"]["9001"] == "005930"
    assert recv_ms > 0
    await _cancel(task)


async def test_no_hook_means_no_vi_reg():
    ws = FakeServer()
    client = _client(ws)
    task = await _run_briefly(client, ["005930"])
    regs = [json.loads(s) for s in ws.sent if json.loads(s).get("trnm") == "REG"]
    assert len(regs) == 1  # 종목 배치뿐 — 훅 없으면 시장 전체 스트림을 안 끌어온다
    await _cancel(task)


async def test_vi_hook_exception_does_not_break_dispatch():
    ticks = []

    async def collect(t):
        ticks.append(t)

    def bad_hook(row, ms):
        raise RuntimeError("boom")

    from .test_kiwoom_ws_client import REAL_0D

    ws = FakeServer()
    client = _client(ws, on_tick=collect, on_vi_row=bad_hook)
    task = await _run_briefly(client, ["005930"])
    # 1h(훅 폭발) + 0D 를 한 수신 흐름에 — 0D 틱은 살아야 한다.
    ws.push(json.dumps(REAL_1H))
    ws.push(json.dumps(REAL_0D))
    await asyncio.sleep(0.02)
    assert len(ticks) == 1
    assert client.connected
    await _cancel(task)


async def test_vi_reg_rejection_keeps_session_alive():
    # 종목 REG rc=0, VI REG rc=거부 — 세션은 살아야 하고 종목 진단은 무오염.
    ws = FakeServer(reg_rc_seq=[0, 999999])
    client = _client(ws, on_vi_row=lambda row, ms: None)
    task = await _run_briefly(client, ["005930"])
    assert client.connected
    assert client.sub_acked == 1
    assert client.sub_rejected == 0  # VI 거부가 종목 구독 진단을 오염하지 않는다
    await _cancel(task)
