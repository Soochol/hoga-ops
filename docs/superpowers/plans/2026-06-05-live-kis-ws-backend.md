# Live KIS WebSocket 백엔드 전환 — 구현 계획 (Plan 1/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live Capture의 수집 전송을 REST poller(10~20초)에서 KIS WebSocket push(sub-second)로 전환 — 호가창·3지표·거래원이 sub-second가 되고, 저장은 10초 다운샘플(JSONL→Promotion)로 유지된다.

**Architecture:** 순수 파서(`ws_frames`) → WS 클라이언트(`ws_client`: approval_key·구독·PINGPONG·재연결) → 오케스트레이터(`stream`: Live Tick → LiveBuffer per-tick publish + 10초 다운샘플 → JSONL). 다운스트림(브라우저 WS ADR-0053, Promotion ADR-0038/0043)은 그대로 재사용하되 체결 저장만 `kind=fill` → `fills.parquet`으로 축소(그릴링 Q4). 구독 집합 = **Live Set**(watchlist 순서 상위 13, 3 TR/종목 = 39등록). poller는 완전 은퇴(§5.5), watchdog 교훈(ADR-0064)은 stream 감독으로 이식.

**Tech Stack:** Python 3.11+ / asyncio / `websockets` 라이브러리(신규 의존성) / httpx(기존) / pyarrow+duckdb(기존) / pytest(asyncio_mode=auto) / 프론트는 Task 12 한 곳만(TypeScript+vitest).

**관련 문서:** spec `docs/superpowers/specs/2026-06-05-live-kis-websocket-realtime-design.md` (§5.1, §5.5, §7, §8, §12), CONTEXT.md 용어 **Live Tick / Live Snapshot / Live Set**.

**검증된 프로토콜 사실** (공식 repo `koreainvestment/open-trading-api` 직접 확인, 2026-06-05):
- 실전 WS URL: `ws://ops.koreainvestment.com:21000`
- approval_key: `POST https://openapi.koreainvestment.com:9443/oauth2/Approval`, body `{"grant_type":"client_credentials","appkey":...,"secretkey":...}` (필드명이 `secretkey`임 — `appsecret` 아님)
- 구독 메시지: `{"header":{"approval_key":K,"custtype":"P","tr_type":"1"|"2","content-type":"utf-8"},"body":{"input":{"tr_id":T,"tr_key":code}}}` (tr_type 1=등록 2=해제)
- 데이터 프레임: `암호화플래그|tr_id|건수|필드1^필드2^...` (첫 글자 `0`=평문, `1`=암호문 — 시세 3종은 평문). 컨트롤은 JSON(`PINGPONG`은 받은 raw 그대로 echo).
- H0STASP0(호가): idx 0=종목코드, 1=영업시간(HHMMSS), 매도호가1~10=idx 3~12, 매수호가1~10=idx 13~22, 매도잔량=23~32, 매수잔량=33~42, 총매도호가잔량=43, 총매수호가잔량=44
- H0STCNT0(체결): 46필드, idx 0=종목코드, 1=체결시간(HHMMSS), 2=현재가, 12=체결거래량, 21=체결구분(`1`=매수, `5`=매도, `3`=장전)
- H0STMBC0(회원사): idx 0=종목코드, 매도회원사명1~5=idx 1~5, 매수회원사명1~5=idx 6~10, 총매도수량1~5=idx 11~15, 총매수수량1~5=idx 16~20. **시간 필드 없음** → t_ms는 수신 시각.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| Create `hoga/live/ws_fields.py` | TR별 필드 인덱스 상수 (공식 샘플에서 옮긴 단일 진실원) |
| Create `hoga/live/ws_frames.py` | 순수 프레임 파서: raw str → `WsTick`/컨트롤. I/O 없음 |
| Create `hoga/live/downsampler.py` | 10초 다운샘플러: 상태형 last-wins, 흐름형 sum(side=0 제외) |
| Create `hoga/live/ws_client.py` | KIS WS 연결·구독·PINGPONG·백오프 재연결 |
| Create `hoga/live/stream.py` | 오케스트레이터: tick→buffer publish + 10초 flush→JSONL |
| Create `hoga/live/session_gate.py` | `_market_phase`/`_should_poll_now`를 poller에서 이주(은퇴 전 분리) |
| Create `hoga/tables/fills.py` | Fill entity + fills.parquet writer + bucket 재집계 쿼리 |
| Create `scripts/record_kis_ws_frames.py` | 장중 실연결 프레임 녹화(fixture 생산) |
| Modify `hoga/live/snapshot.py` | `SnapshotKind.FILL` + `from_fill` |
| Modify `hoga/live/buffer.py` | 시간 기반 eviction(봉합 사이징 불변식) |
| Modify `hoga/live/kis_client.py` | `get_approval_key()` 추가 |
| Modify `hoga/live/promote.py` | `kind=="fill"` → fills.parquet |
| Modify `hoga/api/bundle.py` | fill_strength: fills.parquet 우선, trades 폴백 |
| Modify `hoga/live/lifecycle.py` | Live Set(상위 13)·start_live_stream·watchdog 이식 |
| Modify `hoga/api/app.py` | lifespan 배선 교체 |
| Modify `frontend/src/live/liveSnapshotBuffer.ts` | 브라우저 버퍼도 시간 기반 eviction |
| Delete (Task 13) `hoga/live/poller.py` 등 | poller 완전 은퇴 |

---

### Task 0: 장중 실연결 스파이크 — 프레임 fixture 녹화

**목적:** 3개 TR의 실제 프레임을 녹화해 파서 fixture로 영구 보존 + 3가지 실증: ① H0STMBC0 push 주기, ② 체결구분 값 분포(1/5/3), ③ 15:30–16:00 시간외에 H0STCNT0/H0STASP0가 계속 오는지(안 오면 장후 데이터는 kis_live에서 소실 — 결과를 spec §12에 기록).

**제약:** KRX 장중에만 의미 있음. `KIS_APP_KEY`/`KIS_APP_SECRET` 필요. **다른 태스크를 막지 않는다** — Task 1은 본 문서의 검증된 인덱스로 합성 fixture를 먼저 쓰고, 녹화본이 생기면 같은 테스트에 추가한다. 단 **Task 14(통합 스모크) 전엔 필수**.

**Files:**
- Create: `scripts/record_kis_ws_frames.py`
- Create: `tests/fixtures/kis_ws/README.md` (+ 녹화 산출물 `h0stasp0.txt`, `h0stcnt0.txt`, `h0stmbc0.txt`, `control.txt`)

- [ ] **Step 1: 녹화 스크립트 작성**

```python
"""장중 KIS WS 프레임 녹화 — 파서 fixture 생산용 (1회성 스파이크).

사용:  KIS_APP_KEY=.. KIS_APP_SECRET=.. uv run python scripts/record_kis_ws_frames.py 005930 60
출력:  tests/fixtures/kis_ws/{h0stasp0,h0stcnt0,h0stmbc0,control}.txt
"""
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
import websockets

REST = "https://openapi.koreainvestment.com:9443"
WS = "ws://ops.koreainvestment.com:21000"
TRS = ("H0STASP0", "H0STCNT0", "H0STMBC0")
OUT = Path("tests/fixtures/kis_ws")


async def main(code: str, seconds: int) -> None:
    key, secret = os.environ["KIS_APP_KEY"], os.environ["KIS_APP_SECRET"]
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{REST}/oauth2/Approval", json={
            "grant_type": "client_credentials", "appkey": key, "secretkey": secret,
        })
        r.raise_for_status()
        approval = r.json()["approval_key"]

    OUT.mkdir(parents=True, exist_ok=True)
    files = {tr: (OUT / f"{tr.lower()}.txt").open("a", encoding="utf-8") for tr in TRS}
    control = (OUT / "control.txt").open("a", encoding="utf-8")
    counts: dict[str, int] = {}

    async with websockets.connect(WS, ping_interval=None) as ws:
        for tr in TRS:
            await ws.send(json.dumps({
                "header": {"approval_key": approval, "custtype": "P",
                           "tr_type": "1", "content-type": "utf-8"},
                "body": {"input": {"tr_id": tr, "tr_key": code}},
            }))
        loop = asyncio.get_event_loop()
        deadline = loop.time() + seconds
        while loop.time() < deadline:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(1.0, deadline - loop.time()))
            if raw[0] in ("0", "1"):
                tr = raw.split("|", 3)[1]
                files.get(tr, control).write(raw + "\n")
                counts[tr] = counts.get(tr, 0) + 1
            else:
                control.write(raw + "\n")
                msg = json.loads(raw)
                if msg.get("header", {}).get("tr_id") == "PINGPONG":
                    await ws.send(raw)  # PINGPONG echo
    for f in [*files.values(), control]:
        f.close()
    print("recorded:", counts)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 60))
```

- [ ] **Step 2: 장중 실행 (정규장 1회 + 15:35경 1회)**

Run: `KIS_APP_KEY=... KIS_APP_SECRET=... uv run python scripts/record_kis_ws_frames.py 005930 60`
Expected: `recorded: {'H0STASP0': N, 'H0STCNT0': M, 'H0STMBC0': K}` (N,M > 0; K ≥ 0 — K=0이면 H0STMBC0 push 주기가 60초보다 길다는 뜻이니 300초로 재시도). 15:35 실행 결과(시간외 수신 여부)를 `tests/fixtures/kis_ws/README.md`에 기록. (녹화본에 cnt≥2 H0STCNT0 프레임이 포함되는지 확인 — 멀티레코드 stride의 유일한 실검증)

- [ ] **Step 3: README 작성**

`tests/fixtures/kis_ws/README.md`에 녹화 일시(`RECORD_DATE`)·종목·관찰 결과(체결구분 값 분포, MBC 주기, 시간외 수신 여부)를 기록.

- [ ] **Step 4: 녹화 재생 plausibility 테스트 작성 — 인덱스의 유일한 진실 검증**

⚠️ **(advisor A)** Task 1의 합성 테스트는 파서와 **같은 인덱스 상수로 fixture를 만들므로 레이아웃에 대해 동어반복** — green이어도 실제 KIS 레이아웃과 어긋날 수 있다. 실 레이아웃 검증은 이 재생 테스트가 유일하다. 녹화본 없으면 skip(다른 태스크 비차단), **Task 14 전 필수 통과**.

`tests/unit/live/test_ws_frames_recorded.py`:

```python
"""Task 0 녹화본 재생 — 합성 테스트가 못 잡는 '실제 필드 레이아웃' 검증."""
from pathlib import Path

import pytest

from hoga.live.ws_frames import parse_message

FIX = Path("tests/fixtures/kis_ws")
RECORD_DATE = "20260605"  # README.md의 녹화일과 일치시킬 것

requires_recording = pytest.mark.skipif(
    not (FIX / "h0stasp0.txt").exists(),
    reason="Task 0 녹화본 없음 — 장중 1회 실행 필요",
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
def test_recorded_member_plausible():
    seen = False
    for raw in (FIX / "h0stmbc0.txt").read_text().splitlines():
        for t in parse_message(raw, date=RECORD_DATE, now_ms=1):
            seen = True
            tops = t.payload["sell_top"] + t.payload["buy_top"]
            assert any(e["name"] for e in tops), "회원사명 전부 빈 문자열 — 인덱스 점검"
            assert all(e["qty"] >= 0 for e in tops)
    assert seen or True  # MBC 주기가 길어 0개일 수 있음 — README에 기록
```

Run: `uv run pytest tests/unit/live/test_ws_frames_recorded.py -v`
Expected: 녹화 전 SKIP ×3 / 녹화 후 3 passed

- [ ] **Step 5: 커밋**

```bash
git add scripts/record_kis_ws_frames.py tests/fixtures/kis_ws/ tests/unit/live/test_ws_frames_recorded.py
git commit -m "chore(live): record KIS WS frame fixtures + replay plausibility tests"
```

---

### Task 1: `ws_fields.py` + `ws_frames.py` — 순수 프레임 파서

> ⚠️ **인덱스 미검증 주의(advisor A):** 본 태스크의 합성 fixture는 파서와 같은 인덱스 상수로 생성되므로 **레이아웃에 대해 동어반복**이다 — green을 "파서 정확"으로 읽지 말 것. 실제 레이아웃의 진실 검증은 Task 0 Step 4의 녹화 재생 테스트가 유일하며 Task 14 전 필수.

**Files:**
- Create: `hoga/live/ws_fields.py`
- Create: `hoga/live/ws_frames.py`
- Test: `tests/unit/live/test_ws_frames.py`

- [ ] **Step 1: 필드 인덱스 상수 작성** (`hoga/live/ws_fields.py`)

```python
"""KIS WS TR별 필드 인덱스 — 공식 샘플(koreainvestment/open-trading-api
legacy/websocket/python/ws_domestic_stock.py · ws_domestic_overseas_all.py)에서
옮긴 단일 진실원. 인덱스가 KIS 쪽에서 바뀌면 여기 한 곳만 고친다."""

TR_ORDERBOOK = "H0STASP0"   # 호가
TR_TRADE = "H0STCNT0"       # 체결
TR_MEMBER = "H0STMBC0"      # 회원사(거래원)

# --- H0STASP0 (호가) — 위치 기반 ---
ASP_CODE = 0
ASP_TIME_HHMMSS = 1
ASP_ASK_P = range(3, 13)     # 매도호가 1~10
ASP_BID_P = range(13, 23)    # 매수호가 1~10
ASP_ASK_Q = range(23, 33)    # 매도잔량 1~10
ASP_BID_Q = range(33, 43)    # 매수잔량 1~10
ASP_TOT_ASK_Q = 43
ASP_TOT_BID_Q = 44
ASP_MIN_FIELDS = 45

# --- H0STCNT0 (체결) — 46필드(마지막 idx 45 = 정적VI발동기준가) ---
CNT_FIELDS = 46
CNT_CODE = 0
CNT_TIME_HHMMSS = 1
CNT_PRICE = 2
CNT_QTY = 12                 # 체결거래량
CNT_SIDE = 21                # 체결구분: '1'=매수, '5'=매도, '3'=장전

# --- H0STMBC0 (회원사) — 시간 필드 없음 ---
MBC_CODE = 0
MBC_SELL_NAMES = range(1, 6)
MBC_BUY_NAMES = range(6, 11)
MBC_SELL_QTYS = range(11, 16)
MBC_BUY_QTYS = range(16, 21)
MBC_MIN_FIELDS = 21
```

- [ ] **Step 2: 실패하는 파서 테스트 작성** (`tests/unit/live/test_ws_frames.py`)

합성 fixture는 본 문서 상단의 검증된 인덱스로 구성한다. Task 0 녹화본이 생기면 같은 테스트 클래스에 파일 로드 케이스를 추가.

```python
"""ws_frames 파서 단위 테스트 — 합성 프레임은 공식 샘플 인덱스 기준."""
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import parse_message


def _asp_frame(code: str = "005930", hhmmss: str = "093015") -> str:
    f = ["0"] * 59
    f[0], f[1], f[2] = code, hhmmss, "0"
    for i, idx in enumerate(range(3, 13)):
        f[idx] = str(75000 + i * 10)        # 매도호가 1~10
    for i, idx in enumerate(range(13, 23)):
        f[idx] = str(74990 - i * 10)        # 매수호가 1~10
    for i, idx in enumerate(range(23, 33)):
        f[idx] = str(100 + i)               # 매도잔량
    for i, idx in enumerate(range(33, 43)):
        f[idx] = str(200 + i)               # 매수잔량
    f[43], f[44] = "1500", "2500"
    return "0|H0STASP0|001|" + "^".join(f)


def _cnt_frame(n: int = 1) -> str:
    recs = []
    for k in range(n):
        f = ["0"] * 46
        f[0], f[1], f[2] = "005930", "093015", "75000"
        f[12] = str(5 + k)                  # 체결거래량
        f[21] = "1" if k % 2 == 0 else "5"  # 매수/매도 교대
        recs.append("^".join(f))
    return f"0|H0STCNT0|{n:03d}|" + "^".join(recs)


def _mbc_frame() -> str:
    f = ["0"] * 80
    f[0] = "005930"
    for i, idx in enumerate(range(1, 6)):
        f[idx] = f"매도사{i + 1}"
    for i, idx in enumerate(range(6, 11)):
        f[idx] = f"매수사{i + 1}"
    for i, idx in enumerate(range(11, 16)):
        f[idx] = str(1000 + i)
    for i, idx in enumerate(range(16, 21)):
        f[idx] = str(2000 + i)
    return "0|H0STMBC0|001|" + "^".join(f)


def test_parse_orderbook_frame():
    ticks = parse_message(_asp_frame(), date="20260605", now_ms=0)
    assert len(ticks) == 1
    t = ticks[0]
    assert t.code == "005930"
    assert t.kind is SnapshotKind.OB
    assert t.payload["asks"][0] == {"price": 75000, "qty": 100}
    assert t.payload["bids"][9] == {"price": 74900, "qty": 209}
    assert t.payload["total_ask_qty"] == 1500
    assert t.payload["total_bid_qty"] == 2500
    # 09:30:15 KST → t_ms 검증 (timeenc 왕복)
    from hoga.api.timeenc import hhmmssms_to_unix_ms
    assert t.t_ms == hhmmssms_to_unix_ms("20260605", 93015000)


def test_parse_trade_frame_side_mapping():
    ticks = parse_message(_cnt_frame(2), date="20260605", now_ms=0)
    assert len(ticks) == 2
    assert ticks[0].kind is SnapshotKind.TRADE
    assert ticks[0].payload["trades"][0]["side"] == 1     # 체결구분 '1' = 매수
    assert ticks[1].payload["trades"][0]["side"] == -1    # '5' = 매도
    assert ticks[0].payload["trades"][0]["qty"] == 5


def test_parse_trade_side3_is_auction_zero():
    raw = _cnt_frame(1).split("^")
    raw[21] = "3"  # 장전(단일가) → side 0
    ticks = parse_message("^".join(raw), date="20260605", now_ms=0)
    assert ticks[0].payload["trades"][0]["side"] == 0


def test_parse_member_frame_uses_now_ms():
    ticks = parse_message(_mbc_frame(), date="20260605", now_ms=1_770_000_000_000)
    t = ticks[0]
    assert t.kind is SnapshotKind.BROKER
    assert t.t_ms == 1_770_000_000_000          # MBC엔 시간 필드 없음
    assert t.payload["sell_top"][0] == {"name": "매도사1", "qty": 1000}
    assert t.payload["buy_top"][4] == {"name": "매수사5", "qty": 2004}


def test_parse_control_pingpong():
    raw = '{"header":{"tr_id":"PINGPONG","datetime":"20260605093000"}}'
    out = parse_message(raw, date="20260605", now_ms=0)
    assert out == []  # 컨트롤은 빈 리스트 — 클라이언트가 raw로 직접 echo 판단
```

- [ ] **Step 3: 실패 확인**

Run: `uv run pytest tests/unit/live/test_ws_frames.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.live.ws_frames'`

- [ ] **Step 4: 파서 구현** (`hoga/live/ws_frames.py`)

```python
"""KIS WS 프레임 → Live Tick 순수 파서. I/O 없음 — fixture로 완전 테스트 가능.

payload 형태는 poller 시절 JSONL payload와 동일 모양(byte-compat)을 유지해
promote._parse_jsonl_to_records 와 프론트 bucketHogaSeries 가 무변경으로 동작한다.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from hoga.api.timeenc import hhmmssms_to_unix_ms

from . import ws_fields as F
from .snapshot import SnapshotKind

_log = logging.getLogger(__name__)

_SIDE_MAP = {"1": 1, "5": -1}  # 그 외('3' 장전 등) → 0 (Auction Cross 규약과 동일)


@dataclass(frozen=True)
class WsTick:
    """Live Tick — WS 1메시지에서 나온 1개 도메인 이벤트 (CONTEXT.md 'Live Tick')."""

    code: str
    t_ms: int
    kind: SnapshotKind
    payload: dict[str, Any]


def _hhmmss_to_unix_ms(date: str, hhmmss: str) -> int:
    return hhmmssms_to_unix_ms(date, int(hhmmss) * 1000)


def parse_message(raw: str, *, date: str, now_ms: int) -> list[WsTick]:
    """raw 1수신 → WsTick 목록. 컨트롤(JSON)·미지원 TR·암호화 프레임은 [].

    호출자(ws_client)는 JSON 컨트롤의 PINGPONG echo를 raw 첫 글자로 직접 판단한다
    — 파서는 데이터 프레임만 책임진다.
    """
    if not raw or raw[0] not in ("0", "1"):
        return []
    if raw[0] == "1":
        # 시세 3종은 평문. 암호문이 오면 구독 구성 오류 — 버리고 경고.
        _log.warning("live.ws.unexpected_encrypted_frame head=%s", raw[:32])
        return []
    try:
        _, tr_id, cnt_s, body = raw.split("|", 3)
        cnt = int(cnt_s)
        fields = body.split("^")
    except ValueError:
        _log.warning("live.ws.malformed_frame head=%s", raw[:64])
        return []

    if tr_id == F.TR_ORDERBOOK:
        return _parse_orderbook(fields, date=date)
    if tr_id == F.TR_TRADE:
        return _parse_trades(fields, cnt=cnt, date=date)
    if tr_id == F.TR_MEMBER:
        return _parse_member(fields, now_ms=now_ms)
    return []


def _parse_orderbook(f: list[str], *, date: str) -> list[WsTick]:
    if len(f) < F.ASP_MIN_FIELDS:
        _log.warning("live.ws.asp_short_frame n=%d", len(f))
        return []
    t_ms = _hhmmss_to_unix_ms(date, f[F.ASP_TIME_HHMMSS])
    code = f[F.ASP_CODE]
    payload = {
        "code": code,
        "t_ms": t_ms,
        "asks": [
            {"price": int(f[p]), "qty": int(f[q])}
            for p, q in zip(F.ASP_ASK_P, F.ASP_ASK_Q)
        ],
        "bids": [
            {"price": int(f[p]), "qty": int(f[q])}
            for p, q in zip(F.ASP_BID_P, F.ASP_BID_Q)
        ],
        "total_ask_qty": int(f[F.ASP_TOT_ASK_Q]),
        "total_bid_qty": int(f[F.ASP_TOT_BID_Q]),
    }
    return [WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.OB, payload=payload)]


def _parse_trades(f: list[str], *, cnt: int, date: str) -> list[WsTick]:
    ticks: list[WsTick] = []
    for i in range(cnt):
        rec = f[i * F.CNT_FIELDS : (i + 1) * F.CNT_FIELDS]
        if len(rec) < F.CNT_FIELDS:
            _log.warning("live.ws.cnt_short_record i=%d n=%d", i, len(rec))
            break
        t_ms = _hhmmss_to_unix_ms(date, rec[F.CNT_TIME_HHMMSS])
        code = rec[F.CNT_CODE]
        trade = {
            "t_ms": t_ms,
            "price": int(rec[F.CNT_PRICE]),
            "qty": int(rec[F.CNT_QTY]),
            "side": _SIDE_MAP.get(rec[F.CNT_SIDE], 0),
            "side_source": "kis_ws",
        }
        ticks.append(WsTick(
            code=code, t_ms=t_ms, kind=SnapshotKind.TRADE,
            payload={"trades": [trade]},
        ))
    return ticks


def _parse_member(f: list[str], *, now_ms: int) -> list[WsTick]:
    if len(f) < F.MBC_MIN_FIELDS:
        _log.warning("live.ws.mbc_short_frame n=%d", len(f))
        return []
    code = f[F.MBC_CODE]
    payload = {
        "code": code,
        "t_ms": now_ms,  # H0STMBC0엔 시간 필드 없음(spec §12) — 수신 시각 사용
        "sell_top": [
            {"name": f[n].strip(), "qty": int(f[q])}
            for n, q in zip(F.MBC_SELL_NAMES, F.MBC_SELL_QTYS)
        ],
        "buy_top": [
            {"name": f[n].strip(), "qty": int(f[q])}
            for n, q in zip(F.MBC_BUY_NAMES, F.MBC_BUY_QTYS)
        ],
    }
    return [WsTick(code=code, t_ms=now_ms, kind=SnapshotKind.BROKER, payload=payload)]
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `uv run pytest tests/unit/live/test_ws_frames.py -v`
Expected: 5 passed

```bash
git add hoga/live/ws_fields.py hoga/live/ws_frames.py tests/unit/live/test_ws_frames.py
git commit -m "feat(live): KIS WS frame parser (H0STASP0/H0STCNT0/H0STMBC0)"
```

---

### Task 2: `SnapshotKind.FILL` + `LiveSnapshot.from_fill`

**Files:**
- Modify: `hoga/live/snapshot.py` (enum은 21-26행, 빌더들 아래에 추가)
- Test: `tests/unit/live/test_snapshot.py` (기존 파일에 추가)

- [ ] **Step 1: 실패하는 테스트 추가**

```python
def test_from_fill_payload_shape():
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    s = LiveSnapshot.from_fill(t_ms=1_770_000_000_000, buy_qty=120, sell_qty=80, phase="regular")
    assert s.kind is SnapshotKind.FILL
    assert s.t_ms == 1_770_000_000_000
    assert s.payload == {"buy_qty": 120, "sell_qty": 80, "phase": "regular"}
    assert '"kind": "fill"' in s.to_jsonl()
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_snapshot.py::test_from_fill_payload_shape -v`
Expected: FAIL — `AttributeError: FILL`

- [ ] **Step 3: 구현** (snapshot.py)

```python
class SnapshotKind(str, Enum):
    """The kinds of Live Snapshot. ob/broker/trade는 poller 시절부터,
    fill은 WS 전환(그릴링 Q4)의 10초 체결강도 구간합."""

    OB = "ob"
    TRADE = "trade"   # 저장 경로에선 fill로 대체; 메모리(buffer) 전용으로 존속
    BROKER = "broker"
    FILL = "fill"
```

```python
    @classmethod
    def from_fill(
        cls, *, t_ms: int, buy_qty: int, sell_qty: int, phase: str
    ) -> "LiveSnapshot":
        """10초 체결강도 구간합 — side==±1만 합산된 값을 받는다(분류는 다운샘플러 책임)."""
        return cls(
            t_ms=t_ms,
            kind=SnapshotKind.FILL,
            payload={"buy_qty": buy_qty, "sell_qty": sell_qty, "phase": phase},
        )
```

- [ ] **Step 4: 통과 확인 + 전체 스냅샷 테스트**

Run: `uv run pytest tests/unit/live/test_snapshot.py -v`
Expected: all passed (기존 빌더 byte-pin 테스트 포함)

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/snapshot.py tests/unit/live/test_snapshot.py
git commit -m "feat(live): SnapshotKind.FILL + from_fill builder"
```

---

### Task 3: `TickDownsampler` — 10초 다운샘플러

**핵심 규칙(spec §5.3·§10):** 상태형(ob/broker)=버킷 내 마지막 값, 없으면 직전값 carry(§9). 흐름형(fill)=`side==±1`만 합산, **`side==0`(Auction Cross·장전) 제외** — `trades.query_fill_strength`의 `WHERE side != 0`과 동일 분류(비가역적으로 구워지므로 여기서 검증).

**Files:**
- Create: `hoga/live/downsampler.py`
- Test: `tests/unit/live/test_downsampler.py`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
from hoga.live.downsampler import TickDownsampler
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import WsTick


def _ob(code, t_ms, tot_ask):
    return WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.OB, payload={
        "code": code, "t_ms": t_ms, "asks": [], "bids": [],
        "total_ask_qty": tot_ask, "total_bid_qty": 0,
    })


def _tr(code, t_ms, qty, side):
    return WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": t_ms, "price": 100, "qty": qty, "side": side,
                    "side_source": "kis_ws"}],
    })


def test_state_last_wins_and_flow_sums():
    ds = TickDownsampler()
    ds.ingest(_ob("005930", 1000, tot_ask=111))
    ds.ingest(_ob("005930", 2000, tot_ask=222))      # 마지막 ob가 이김
    ds.ingest(_tr("005930", 1500, qty=5, side=1))
    ds.ingest(_tr("005930", 1600, qty=3, side=-1))
    ds.ingest(_tr("005930", 1700, qty=4, side=1))
    out = ds.flush(now_ms=10_000, phase="regular")
    snaps = {s.kind: s for s in out["005930"]}
    assert snaps[SnapshotKind.OB].payload["total_ask_qty"] == 222
    assert snaps[SnapshotKind.FILL].payload == {
        "buy_qty": 9, "sell_qty": 3, "phase": "regular",
    }


def test_side_zero_excluded_from_fill():
    """§10 fills 분류 동등성 — side==0(단일가/장전)은 합산 금지."""
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=100, side=0))
    out = ds.flush(now_ms=10_000, phase="regular")
    fill = next(s for s in out["005930"] if s.kind is SnapshotKind.FILL)
    assert fill.payload["buy_qty"] == 0 and fill.payload["sell_qty"] == 0


def test_state_carry_when_no_new_tick():
    """§9: 빈 구간 상태형은 직전값 carry (t_ms는 flush 시각으로 갱신)."""
    ds = TickDownsampler()
    ds.ingest(_ob("005930", 1000, tot_ask=111))
    ds.flush(now_ms=10_000, phase="regular")
    out2 = ds.flush(now_ms=20_000, phase="regular")   # 새 tick 없음
    ob = next(s for s in out2["005930"] if s.kind is SnapshotKind.OB)
    assert ob.payload["total_ask_qty"] == 111
    assert ob.t_ms == 20_000


def test_flow_resets_each_window():
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=5, side=1))
    ds.flush(now_ms=10_000, phase="regular")
    out2 = ds.flush(now_ms=20_000, phase="regular")
    fill = next(s for s in out2["005930"] if s.kind is SnapshotKind.FILL)
    assert fill.payload["buy_qty"] == 0                # 합은 리셋(강수량계)


def test_evicted_code_stops_emitting():
    """advisor C: Live Set에서 밀려난 종목의 carry가 유령 스냅샷을 쓰면 안 됨."""
    ds = TickDownsampler()
    ds.ingest(_ob("005930", 1000, tot_ask=111))
    ds.set_active_codes({"000660"})                    # 005930 구독 해제됨
    assert ds.flush(now_ms=10_000, phase="regular") == {}
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_downsampler.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.live.downsampler'`

- [ ] **Step 3: 구현** (`hoga/live/downsampler.py`)

```python
"""Live Tick → 10초 Live Snapshot 다운샘플러 (spec §5.3 · §8).

상태형(ob/broker): 윈도 내 마지막 payload가 살아남고, 윈도가 비면 직전값을
flush 시각 t_ms로 carry(§9). 흐름형(fill): side==±1 qty 합 — side==0
(Auction Cross/장전)은 trades.query_fill_strength 의 ``WHERE side != 0``과
동일하게 제외한다. 집계 시점에 분류가 비가역적으로 구워지므로(그릴링 advisor
Finding 2) 이 모듈의 테스트가 분류 동등성의 단일 검증 지점이다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .snapshot import LiveSnapshot, SnapshotKind
from .ws_frames import WsTick


@dataclass
class _CodeState:
    last_ob: dict | None = None
    last_broker: dict | None = None
    buy_qty: int = 0
    sell_qty: int = 0


class TickDownsampler:
    def __init__(self) -> None:
        self._codes: dict[str, _CodeState] = {}

    def ingest(self, tick: WsTick) -> None:
        st = self._codes.setdefault(tick.code, _CodeState())
        if tick.kind is SnapshotKind.OB:
            st.last_ob = tick.payload
        elif tick.kind is SnapshotKind.BROKER:
            st.last_broker = tick.payload
        elif tick.kind is SnapshotKind.TRADE:
            for tr in tick.payload.get("trades", ()):
                side = tr.get("side", 0)
                if side == 1:
                    st.buy_qty += int(tr.get("qty", 0))
                elif side == -1:
                    st.sell_qty += int(tr.get("qty", 0))

    def set_active_codes(self, codes: set[str]) -> None:
        """Live Set 밖으로 밀려난 코드의 carry 상태 제거(advisor C) —
        구독 해제된 종목이 유령 10초 스냅샷을 계속 쓰는 사고 방지.
        carry(§9)는 '조용하지만 살아있는' 종목용이지 '떠난' 종목용이 아니다."""
        for code in list(self._codes):
            if code not in codes:
                del self._codes[code]

    def flush(self, *, now_ms: int, phase: str) -> dict[str, list[LiveSnapshot]]:
        """윈도 마감 — 코드별 [ob?, broker?, fill] 반환. 흐름 합은 리셋,
        상태(last_ob/last_broker)는 다음 윈도 carry를 위해 보존."""
        out: dict[str, list[LiveSnapshot]] = {}
        for code, st in self._codes.items():
            snaps: list[LiveSnapshot] = []
            if st.last_ob is not None:
                payload = {**st.last_ob, "phase": phase}
                snaps.append(LiveSnapshot(t_ms=now_ms, kind=SnapshotKind.OB, payload=payload))
            if st.last_broker is not None:
                payload = {**st.last_broker, "phase": phase}
                snaps.append(LiveSnapshot(t_ms=now_ms, kind=SnapshotKind.BROKER, payload=payload))
            snaps.append(LiveSnapshot.from_fill(
                t_ms=now_ms, buy_qty=st.buy_qty, sell_qty=st.sell_qty, phase=phase,
            ))
            st.buy_qty = 0
            st.sell_qty = 0
            out[code] = snaps
        return out
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/unit/live/test_downsampler.py -v`
Expected: 4 passed

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/downsampler.py tests/unit/live/test_downsampler.py
git commit -m "feat(live): 10s tick downsampler (state last-wins, flow sum, side=0 excluded)"
```

---

### Task 4: LiveBuffer 시간 기반 eviction

**근거(spec §8 봉합 사이징 불변식):** ring 보존 기간 > 2× Today Promotion 주기(300s) → 기본 900s(15분). 개수 maxlen은 폭주 안전핀으로만 상향(60,000).

**Files:**
- Modify: `hoga/live/buffer.py` (23행 `MAX_BUFFER_ENTRIES`, 60-88행 `publish`)
- Test: `tests/unit/live/test_buffer.py` (추가)

- [ ] **Step 1: 실패하는 테스트 추가**

```python
async def test_publish_evicts_by_time():
    from hoga.live.buffer import LiveBuffer
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    buf = LiveBuffer(retention_ms=900_000)
    old = LiveSnapshot(t_ms=1_000, kind=SnapshotKind.OB, payload={"code": "005930"})
    new = LiveSnapshot(t_ms=2_000_000, kind=SnapshotKind.OB, payload={"code": "005930"})
    await buf.publish("005930", [old])
    await buf.publish("005930", [new], now_ms=2_000_000)   # old(1초)는 컷오프 밖
    series = await buf.get_series("005930")
    t_list = [e["t_ms"] for e in series["snapshots"]]
    assert 1_000 not in t_list and 2_000_000 in t_list
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_buffer.py::test_publish_evicts_by_time -v`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'retention_ms'`

- [ ] **Step 3: 구현** — buffer.py 변경점

```python
# 상수 교체 (기존 MAX_BUFFER_ENTRIES = 2520):
# Eng C5 → WS 전환: 개수 캡은 폭주 안전핀으로만. 실 보존은 시간 기반
# (spec §8 봉합 사이징 불변식: 보존 > 2× HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S).
MAX_BUFFER_ENTRIES = 60_000
DEFAULT_RETENTION_MS = 900_000  # 15분


# __init__ 변경:
def __init__(self, *, retention_ms: int = DEFAULT_RETENTION_MS) -> None:
    self._retention_ms = retention_ms
    self._buf: dict[tuple[str, str], deque[dict]] = {}
    ...  # 기존 lock/subscribers 초기화 그대로


# publish 시그니처/본문 변경 (60-88행) — append 후 시간 eviction 추가:
async def publish(
    self, code: str, snapshots: Iterable[LiveSnapshot], *, now_ms: int | None = None
) -> None:
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    cutoff = now_ms - self._retention_ms
    entries: list[dict] = []
    async with self._lock:
        for s in snapshots:
            key = (code, s.kind.value)
            d = self._buf.get(key)
            if d is None:
                d = deque(maxlen=MAX_BUFFER_ENTRIES)
                self._buf[key] = d
            entry = {"t_ms": s.t_ms, "kind": s.kind.value, **s.payload}
            d.append(entry)
            entries.append(entry)
            while d and d[0]["t_ms"] < cutoff:   # 시간 기반 eviction
                d.popleft()
    # (이하 subscriber 통지 블록은 기존 그대로)
```

`import time`을 파일 상단에 추가. `LiveBuffer()` 생성 지점(lifecycle.py의 `_buffer` 모듈 전역)은 기본값이라 무변경.

- [ ] **Step 4: 통과 + 기존 버퍼 테스트 회귀 확인**

Run: `uv run pytest tests/unit/live/test_buffer.py -v`
Expected: all passed

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/buffer.py tests/unit/live/test_buffer.py
git commit -m "feat(live): time-based LiveBuffer eviction (stitch sizing invariant)"
```

---

### Task 5: `KisClient.get_approval_key()`

**Files:**
- Modify: `hoga/live/kis_client.py` (242-270행 생성자 아래 메서드 추가)
- Test: `tests/unit/live/test_kis_client.py` (추가)

- [ ] **Step 1: 실패하는 테스트 추가** (기존 MockTransport 패턴 재사용)

```python
async def test_get_approval_key(tmp_path):
    import httpx
    from hoga.live.kis_client import KisClient, KisCredentials

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/oauth2/Approval"
        body = json.loads(request.content)
        assert body == {"grant_type": "client_credentials",
                        "appkey": "AK", "secretkey": "AS"}  # 필드명 secretkey!
        return httpx.Response(200, json={"approval_key": "APPROVAL-123"})

    kis = KisClient(
        KisCredentials(app_key="AK", app_secret="AS"),
        tmp_path / "token.json",
        _transport=httpx.MockTransport(handler),
    )
    assert await kis.get_approval_key() == "APPROVAL-123"
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_kis_client.py::test_get_approval_key -v`
Expected: FAIL — `AttributeError: 'KisClient' object has no attribute 'get_approval_key'`

- [ ] **Step 3: 구현** (kis_client.py — `get_access_token` 아래)

```python
    async def get_approval_key(self) -> str:
        """WS 접속키 발급 (POST /oauth2/Approval). ADR-0050 단일 ingress —
        WS 클라이언트도 KIS HTTP는 이 클라이언트를 경유한다.

        연결할 때마다 1회 발급(공식 샘플과 동일). 데이터 호출이 아니므로
        15/s 토큰버킷은 통과하지 않는다(토큰 발급과 같은 취급).
        주의: KIS가 이 엔드포인트만 필드명을 ``secretkey``로 받는다.
        """
        resp = await self._client.post(
            "/oauth2/Approval",
            json={
                "grant_type": "client_credentials",
                "appkey": self._creds.app_key,
                "secretkey": self._creds.app_secret,
            },
            headers={"content-type": "application/json"},
        )
        resp.raise_for_status()
        key = resp.json().get("approval_key")
        if not key:
            raise KisAuthError("approval_key missing in /oauth2/Approval response")
        return str(key)
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/unit/live/test_kis_client.py -v`
Expected: all passed

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_client.py
git commit -m "feat(live): KisClient.get_approval_key for WS handshake"
```

---

### Task 6: `KisWsClient` — 연결·구독·PINGPONG·재연결

**Files:**
- Create: `hoga/live/ws_client.py`
- Test: `tests/unit/live/test_ws_client.py`
- Modify: `pyproject.toml` (의존성)

- [ ] **Step 1: 의존성 추가**

Run: `uv add websockets`
Expected: pyproject.toml `[project] dependencies`에 `websockets>=...` 추가됨. (`uv run python -c "import websockets"` 통과.)

- [ ] **Step 2: 실패하는 테스트 작성** — 가짜 ws 주입(덕 타이핑)

```python
import asyncio
import json

import pytest

from hoga.live.ws_client import KisWsClient, build_request


def test_build_request_shape():
    msg = json.loads(build_request("APPR", "1", "H0STASP0", "005930"))
    assert msg == {
        "header": {"approval_key": "APPR", "custtype": "P",
                   "tr_type": "1", "content-type": "utf-8"},
        "body": {"input": {"tr_id": "H0STASP0", "tr_key": "005930"}},
    }


class FakeWs:
    """recv 스크립트 재생 + send 기록. 스크립트 소진 시 ConnectionClosed 흉내."""

    def __init__(self, script: list[str]):
        self._script = list(script)
        self.sent: list[str] = []

    async def recv(self) -> str:
        if not self._script:
            raise ConnectionError("closed")
        await asyncio.sleep(0)
        return self._script.pop(0)

    async def send(self, data: str) -> None:
        self.sent.append(data)


async def test_recv_loop_dispatches_ticks_and_echoes_pingpong():
    asp = "0|H0STASP0|001|" + "^".join(
        ["005930", "093015", "0"] + ["1"] * 56
    )
    ping = '{"header":{"tr_id":"PINGPONG","datetime":"x"}}'
    fake = FakeWs([ping, asp])
    got: list = []

    async def on_tick(tick):
        got.append(tick)

    client = KisWsClient(approval_key_fn=None, on_tick=on_tick, date_fn=lambda: "20260605")
    with pytest.raises(ConnectionError):
        await client._recv_loop(fake)          # 스크립트 소진 → closed
    assert any('"tr_id":"PINGPONG"' in s or "PINGPONG" in s for s in fake.sent)  # echo
    assert len(got) == 1 and got[0].code == "005930"


async def test_subscribe_sends_three_trs_per_code():
    fake = FakeWs([])
    client = KisWsClient(approval_key_fn=None, on_tick=None, date_fn=lambda: "20260605")
    await client._send_subscriptions(fake, "APPR", ["005930", "000660"], tr_type="1")
    assert len(fake.sent) == 6                  # 2종목 × 3TR
    trs = {json.loads(s)["body"]["input"]["tr_id"] for s in fake.sent}
    assert trs == {"H0STASP0", "H0STCNT0", "H0STMBC0"}
```

- [ ] **Step 3: 실패 확인**

Run: `uv run pytest tests/unit/live/test_ws_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.live.ws_client'`

- [ ] **Step 4: 구현** (`hoga/live/ws_client.py`)

```python
"""KIS WebSocket 클라이언트 — 연결·구독·PINGPONG·백오프 재연결 (spec §7).

순수 파싱은 ws_frames에 위임. 이 모듈은 소켓 수명만 책임진다.
재연결: (1,2,4,8,16,32,60)s 백오프 + 성공 시 전 종목 재구독.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Awaitable, Callable, Optional

import websockets

from . import ws_fields as F
from .ws_frames import WsTick, parse_message

_log = logging.getLogger(__name__)

WS_URL_REAL = "ws://ops.koreainvestment.com:21000"
_TRS = (F.TR_ORDERBOOK, F.TR_TRADE, F.TR_MEMBER)
_BACKOFF_S = (1, 2, 4, 8, 16, 32, 60)


def build_request(approval_key: str, tr_type: str, tr_id: str, tr_key: str) -> str:
    return json.dumps({
        "header": {"approval_key": approval_key, "custtype": "P",
                   "tr_type": tr_type, "content-type": "utf-8"},
        "body": {"input": {"tr_id": tr_id, "tr_key": tr_key}},
    })


class KisWsClient:
    def __init__(
        self,
        *,
        approval_key_fn: Optional[Callable[[], Awaitable[str]]],
        on_tick: Optional[Callable[[WsTick], Awaitable[None]]],
        date_fn: Callable[[], str],
        url: str = WS_URL_REAL,
        gate_fn: Optional[Callable[[], bool]] = None,
    ) -> None:
        self._approval_key_fn = approval_key_fn
        self._on_tick = on_tick
        self._date_fn = date_fn
        self._url = url
        self._gate_fn = gate_fn   # advisor B: 게이트 밖에선 (재)연결 시도 안 함
        self._codes: list[str] = []
        self._ws: object | None = None
        self.last_tick_ms: int | None = None   # stream watchdog이 읽음
        self.connected: bool = False

    async def run(self, codes: list[str]) -> None:
        """끊겨도 살아남는 메인 루프 — 호출자(stream)가 task로 돌리고 cancel로 끝낸다."""
        self._codes = list(codes)
        attempt = 0
        while True:
            if self._gate_fn is not None and not self._gate_fn():
                self.connected = False
                await asyncio.sleep(30)   # 장외/15:30 이후 — 연결 시도 보류
                continue
            try:
                approval = await self._approval_key_fn()
                async with websockets.connect(self._url, ping_interval=None) as ws:
                    self._ws = ws
                    self.connected = True
                    attempt = 0
                    await self._send_subscriptions(ws, approval, self._codes, tr_type="1")
                    _log.info("live.ws.connected codes=%d regs=%d",
                              len(self._codes), len(self._codes) * len(_TRS))
                    await self._recv_loop(ws)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — 연결 오류는 전부 재시도 대상
                self.connected = False
                self._ws = None
                delay = _BACKOFF_S[min(attempt, len(_BACKOFF_S) - 1)]
                attempt += 1
                _log.warning("live.ws.reconnect attempt=%d delay=%ds err=%r",
                             attempt, delay, e)
                await asyncio.sleep(delay)

    async def update_codes(self, codes: list[str]) -> None:
        """Live Set 변경(watchlist reorder) — diff만 구독/해제."""
        new, old = set(codes), set(self._codes)
        self._codes = list(codes)
        ws = self._ws
        if ws is None:
            return  # 다음 (재)연결 때 전체 구독
        approval = await self._approval_key_fn()
        added = [c for c in codes if c not in old]
        removed = [c for c in old if c not in new]
        if removed:
            await self._send_subscriptions(ws, approval, removed, tr_type="2")
        if added:
            await self._send_subscriptions(ws, approval, added, tr_type="1")

    async def _send_subscriptions(
        self, ws, approval_key: str, codes: list[str], *, tr_type: str
    ) -> None:
        for code in codes:
            for tr in _TRS:
                await ws.send(build_request(approval_key, tr_type, tr, code))

    async def _recv_loop(self, ws) -> None:
        date = self._date_fn()
        while True:
            raw = await ws.recv()
            if raw and raw[0] in ("0", "1"):
                now_ms = int(time.time() * 1000)
                for tick in parse_message(raw, date=date, now_ms=now_ms):
                    self.last_tick_ms = now_ms
                    if self._on_tick is not None:
                        await self._on_tick(tick)
            else:
                try:
                    msg = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                tr_id = msg.get("header", {}).get("tr_id")
                if tr_id == "PINGPONG":
                    await ws.send(raw)  # 공식 규약: 받은 메시지 그대로 echo
                else:
                    _log.info("live.ws.control tr_id=%s msg=%s",
                              tr_id, str(msg.get("body", {}))[:200])
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `uv run pytest tests/unit/live/test_ws_client.py -v`
Expected: 3 passed

```bash
git add pyproject.toml uv.lock hoga/live/ws_client.py tests/unit/live/test_ws_client.py
git commit -m "feat(live): KIS WS client (subscribe/PINGPONG/backoff-reconnect)"
```

---

### Task 7: `session_gate.py` 분리 + `LiveStream` 오케스트레이터

**Files:**
- Create: `hoga/live/session_gate.py` (poller.py에서 `_market_phase`·`_should_poll_now` **이동** — poller는 import로 위임해 기존 테스트 그대로 통과)
- Create: `hoga/live/stream.py`
- Test: `tests/unit/live/test_stream.py`

- [ ] **Step 1: session_gate 이동(리팩터)**

`hoga/live/session_gate.py` 신설 — poller.py의 `_market_phase`(34-50행)와 `_should_poll_now` 본문을 **그대로 옮기고** 공개 이름 부여:

```python
"""KRX 세션 게이트 — poller에서 이주(은퇴 대비, 그릴링 Q2).
market_phase: 시계 기반 위상. should_run_now: 캘린더 게이트 포함(ADR-0064)."""
# (poller.py의 _market_phase / _should_poll_now 본문을 그대로 복사 —
#  이름만 market_phase / should_run_now 로 공개)


def ws_capture_window(now_ms: int) -> bool:
    """WS 수집 게이트(advisor B 결정 2026-06-05): 거래일 && 정규장(09:00–15:30)만.

    poller 시절의 장후 시간외(15:30–16:00, overtime TR) 캡처는 **의도적 회귀** —
    가격 고정 구간이라 정보가치 낮고 hogaplay 일배치가 post-hoc per-tick 보완
    (spec §11). 정규 TR만 구독하므로 15:30 이후엔 틱이 없어, 게이트를 열어두면
    다운샘플러 carry가 유령 스냅샷만 쓴다 — 그래서 15:30에 닫는다.
    """
    return should_run_now(now_ms) and market_phase(now_ms) == "regular"
```

poller.py에는 하위호환 alias를 남긴다:

```python
from .session_gate import market_phase as _market_phase
from .session_gate import should_run_now as _should_poll_now
```

Run: `uv run pytest tests/unit/live/test_poller.py -v` → all passed (이동 무손상 확인)

```bash
git add hoga/live/session_gate.py hoga/live/poller.py
git commit -m "refactor(live): extract session gate from poller (pre-retirement)"
```

- [ ] **Step 2: 실패하는 LiveStream 테스트 작성**

```python
import asyncio

from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream
from hoga.live.writer import LiveWriter
from hoga.live.ws_frames import WsTick


def _trade_tick(t_ms, qty, side):
    return WsTick(code="005930", t_ms=t_ms, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": t_ms, "price": 100, "qty": qty, "side": side,
                    "side_source": "kis_ws"}],
    })


async def test_on_tick_publishes_immediately_and_flush_writes_jsonl(tmp_path):
    buf = LiveBuffer()
    writer = LiveWriter(tmp_path / "live")
    stream = LiveStream(buffer=buf, writer=writer,
                        date_fn=lambda: "20260605", phase_fn=lambda: "regular")

    await stream.on_tick(_trade_tick(1_770_000_000_000, qty=5, side=1))
    series = await buf.get_series("005930")          # per-tick: 즉시 buffer에
    assert len(series["trades"]) == 1

    await stream.flush_once(now_ms=1_770_000_010_000)  # 10초 경계 flush
    jsonl = (tmp_path / "live" / "20260605" / "005930.jsonl").read_text()
    assert '"kind": "fill"' in jsonl
    assert '"buy_qty": 5' in jsonl
    assert '"kind": "trade"' not in jsonl            # 체결 raw는 JSONL에 안 감(Q4)
```

- [ ] **Step 3: 실패 확인**

Run: `uv run pytest tests/unit/live/test_stream.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.live.stream'`

- [ ] **Step 4: 구현** (`hoga/live/stream.py`)

```python
"""LiveStream — WS 수집 오케스트레이터 (spec §6·§7).

per-tick: LiveBuffer.publish (표시, sub-second / ADR-0053 다운스트림 무변경)
10초:    TickDownsampler.flush → LiveWriter.append (저장; ADR-0038 hot-path
         invariant — JSONL만 쓴다)
게이팅:  session_gate.ws_capture_window(09:00–15:30, advisor B) — 밖에선
         flush 안 함 + WS (재)연결 보류. 장후 시간외는 의도적 회귀(spec §11).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable

from .buffer import LiveBuffer
from .downsampler import TickDownsampler
from .session_gate import market_phase, ws_capture_window
from .snapshot import LiveSnapshot
from .writer import LiveWriter
from .ws_client import KisWsClient
from .ws_frames import WsTick

_log = logging.getLogger(__name__)

FLUSH_INTERVAL_S = 10.0


def _now_ms() -> int:
    return int(time.time() * 1000)


class LiveStream:
    def __init__(
        self,
        *,
        buffer: LiveBuffer,
        writer: LiveWriter,
        date_fn: Callable[[], str],
        phase_fn: Callable[[], str] | None = None,
    ) -> None:
        self._buffer = buffer
        self._writer = writer
        self._date_fn = date_fn
        self._phase_fn = phase_fn or (lambda: market_phase(_now_ms()))
        self._ds = TickDownsampler()
        self.ws: KisWsClient | None = None       # lifecycle이 주입
        self.last_flush_ms: int | None = None

    def set_active_codes(self, codes: set[str]) -> None:
        """Live Set 변경 위임 — refresh_live_stream이 호출(advisor C)."""
        self._ds.set_active_codes(codes)

    async def on_tick(self, tick: WsTick) -> None:
        """ws_client 콜백 — 표시 경로(즉시) + 저장 경로(누적)."""
        phase = self._phase_fn()
        snap = LiveSnapshot(t_ms=tick.t_ms, kind=tick.kind,
                            payload={**tick.payload, "phase": phase})
        await self._buffer.publish(tick.code, [snap], now_ms=_now_ms())
        self._ds.ingest(tick)

    async def flush_once(self, *, now_ms: int | None = None) -> None:
        now_ms = now_ms if now_ms is not None else _now_ms()
        date = self._date_fn()
        flushed = self._ds.flush(now_ms=now_ms, phase=self._phase_fn())
        for code, snaps in flushed.items():
            await self._writer.append(date, code, snaps)
        await self._writer.fsync_all()
        self.last_flush_ms = now_ms

    async def run_flush_loop(self) -> None:
        """10초 flush 루프 — lifecycle이 task로 돌린다. 게이트 밖(장외·15:30 이후)엔
        1초 idle — advisor B: 15:30 이후 쓰기를 막아 유령 carry를 차단한다."""
        while True:
            if ws_capture_window(_now_ms()):
                started = time.monotonic()
                try:
                    await self.flush_once()
                except Exception:  # noqa: BLE001 — 한 번의 flush 실패가 루프를 못 죽인다
                    _log.exception("live.stream.flush_failed")
                elapsed = time.monotonic() - started
                await asyncio.sleep(max(0.0, FLUSH_INTERVAL_S - elapsed))
            else:
                await asyncio.sleep(1.0)
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `uv run pytest tests/unit/live/test_stream.py -v`
Expected: 1 passed

```bash
git add hoga/live/stream.py tests/unit/live/test_stream.py
git commit -m "feat(live): LiveStream orchestrator (per-tick publish + 10s JSONL flush)"
```

---

### Task 8: `hoga/tables/fills.py` — Fill entity·writer·재집계 쿼리

**Files:**
- Create: `hoga/tables/fills.py` (`hoga/tables/trades.py`의 스키마/writer/query 패턴을 그대로 미러)
- Test: `tests/unit/tables/test_fills.py`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
from pathlib import Path

import duckdb

from hoga.tables.fills import Fill, query_fill_strength, write_fills_parquet


def test_roundtrip_and_bucket_reaggregation(tmp_path: Path):
    # 10초 구간합 3장: 09:00:00 / 09:00:10 / 09:01:00 (HHMMSSmmm 인코딩)
    rows = [
        Fill(ts_ms=90000000, seq=1, buy_qty=10, sell_qty=2),
        Fill(ts_ms=90010000, seq=2, buy_qty=5, sell_qty=3),
        Fill(ts_ms=90100000, seq=3, buy_qty=7, sell_qty=1),
    ]
    path = tmp_path / "fills.parquet"
    write_fills_parquet(rows, path)

    con = duckdb.connect()
    out = query_fill_strength(con, path=path, bucket_ms=60_000)
    # 09:00 버킷 = 두 장의 합(합의 합), 09:01 버킷 = 한 장
    assert [(r.bucket_intra_ms, r.buy_qty, r.sell_qty) for r in out] == [
        (32_400_000 // 1, 15, 5),   # 09:00 = 9h*3600*1000 ms-from-midnight
        (32_460_000, 7, 1),         # 09:01
    ]
```

(첫 어서션의 `32_400_000 // 1`은 09:00의 ms-from-midnight 값 — `trades.query_fill_strength`와 동일하게 `hhmmssms_to_intra_ms_sql`로 선형화 후 버킷.)

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/tables/test_fills.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.tables.fills'`

- [ ] **Step 3: 구현** (`hoga/tables/fills.py`)

```python
"""fills 테이블 — 10초 체결강도 구간합 (그릴링 Q4, spec §8).

trades.parquet(개별 체결) 저장 중단의 대체 artifact. side 분류(±1만,
Auction Cross 제외)는 다운샘플러가 write-time에 이미 적용했으므로 이 쿼리는
시간 재버킷(합의 합)만 한다 — 10초는 모든 Timeframe bucket_ms(60s~1800s)에
정확히 중첩된다.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from hoga.api.timeenc import hhmmssms_to_intra_ms_sql
from hoga.tables.trades import FillStrengthRow

PARQUET_SCHEMA = pa.schema([
    ("ts_ms", pa.int64()),    # HHMMSSmmm packed-decimal (ADR-0010/0049)
    ("seq", pa.int64()),
    ("buy_qty", pa.int64()),
    ("sell_qty", pa.int64()),
])


@dataclass(frozen=True)
class Fill:
    ts_ms: int
    seq: int
    buy_qty: int
    sell_qty: int


def write_fills_parquet(rows: list[Fill], path: Path) -> None:
    table = pa.Table.from_pylist(
        [{"ts_ms": r.ts_ms, "seq": r.seq,
          "buy_qty": r.buy_qty, "sell_qty": r.sell_qty} for r in rows],
        schema=PARQUET_SCHEMA,
    )
    pq.write_table(table, path)


def query_fill_strength(
    con: duckdb.DuckDBPyConnection, *, path: Path, bucket_ms: int
) -> list[FillStrengthRow]:
    """trades.query_fill_strength 와 동일 반환형 — bundle이 분기 없이 재사용."""
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    rows = con.execute(
        f"""
        SELECT (({intra_ms_expr} // {bucket_ms}) * {bucket_ms}) AS bucket,
               SUM(buy_qty) AS buy_qty,
               SUM(sell_qty) AS sell_qty
        FROM read_parquet(?)
        GROUP BY 1 ORDER BY 1
        """,
        [str(path)],
    ).fetchall()
    return [
        FillStrengthRow(bucket_intra_ms=int(r[0]), buy_qty=int(r[1]), sell_qty=int(r[2]))
        for r in rows
    ]
```

(`write_trades_parquet`가 별도 atomic 헬퍼/옵션을 쓰면 그 형식을 그대로 따른다 — Step 3 시작 전에 `hoga/tables/trades.py`의 writer를 열어 동일 패턴으로 맞출 것. 원자성은 promote의 `_atomic_write_table`이 책임지므로 이 함수는 단순 write여도 된다.)

- [ ] **Step 4: 통과 확인 + 커밋**

Run: `uv run pytest tests/unit/tables/test_fills.py -v`
Expected: 1 passed

```bash
git add hoga/tables/fills.py tests/unit/tables/test_fills.py
git commit -m "feat(tables): fills.parquet (10s fill-strength sums) + bucket reaggregation"
```

---

### Task 9: Promotion에 `kind=="fill"` 분기

**Files:**
- Modify: `hoga/live/promote.py` — `_parse_jsonl_to_records`(48-204행), `_build_meta`(207-223행), `promote_today`(231-299행)와 `promote_one`의 쓰기 블록
- Test: `tests/unit/live/test_promote.py` (추가)

- [ ] **Step 1: 실패하는 테스트 추가** (기존 `test_promote_one_writes_parquet_and_meta` 패턴)

```python
async def test_promote_writes_fills_parquet_only_when_fill_lines_exist(tmp_path: Path):
    from hoga.api.timeenc import hhmmssms_to_unix_ms
    from hoga.live.promote import promote_one

    live_root = tmp_path / "live"
    jsonl_path = live_root / "20260605" / "005930.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    base_t = hhmmssms_to_unix_ms("20260605", 90000000)
    lines = [
        json.dumps({"t_ms": base_t, "kind": "fill",
                    "payload": {"buy_qty": 12, "sell_qty": 8, "phase": "regular"}}),
        json.dumps({"t_ms": base_t + 10_000, "kind": "fill",
                    "payload": {"buy_qty": 0, "sell_qty": 4, "phase": "regular"}}),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n")

    parquet_root = tmp_path / "parquet"
    await promote_one(jsonl_path, parquet_root, code="005930", date="20260605")
    target = parquet_root / "20260605" / "005930" / "kis_live"
    assert (target / "fills.parquet").exists()
    meta = json.loads((target / "meta.json").read_text())
    assert meta["row_counts"]["fills"] == 2


async def test_promote_legacy_jsonl_without_fill_writes_no_fills_parquet(tmp_path: Path):
    """레거시(trade kind만 있는) JSONL 재프로모트 시 빈 fills.parquet이 생기면
    bundle의 fills-우선 분기가 진짜 trades 데이터를 가리게 됨 — 금지."""
    from hoga.api.timeenc import hhmmssms_to_unix_ms
    from hoga.live.promote import promote_one

    jsonl_path = tmp_path / "live" / "20260527" / "005930.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    base_t = hhmmssms_to_unix_ms("20260527", 90000000)
    jsonl_path.write_text(json.dumps({"t_ms": base_t, "kind": "trade", "payload": {
        "trades": [{"t_ms": base_t, "price": 100, "qty": 1, "side": 1,
                    "side_source": "inferred"}], "phase": "regular"}}) + "\n")

    parquet_root = tmp_path / "parquet"
    await promote_one(jsonl_path, parquet_root, code="005930", date="20260527")
    target = parquet_root / "20260527" / "005930" / "kis_live"
    assert not (target / "fills.parquet").exists()
    assert (target / "trades.parquet").exists()
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_promote.py -k fill -v`
Expected: 2 FAIL (`KeyError: 'fills'` / fills.parquet 미생성)

- [ ] **Step 3: 구현** — promote.py 변경점 4곳

```python
# (a) import 추가
from hoga.tables.fills import Fill, write_fills_parquet

# (b) _parse_jsonl_to_records: 반환 5-튜플로 확장
#     시그니처: -> tuple[list[Orderbook], list[Trade], list[BrokerRow], list[Fill], dict]
#     함수 머리에 누적자/카운터 추가:
fills: list[Fill] = []
fill_seq = 0
#     kind 분기에 추가 (elif kind == "broker": 블록 다음):
            elif kind == "fill":
                # 그릴링 Q4: 10초 체결강도 구간합 → fills.parquet.
                # side 분류는 다운샘플러가 write-time에 적용 완료(±1만, side=0 제외).
                fill_seq += 1
                fills.append(Fill(
                    ts_ms=ts_ms_encoded,
                    seq=fill_seq,
                    buy_qty=int(p.get("buy_qty") or 0),
                    sell_qty=int(p.get("sell_qty") or 0),
                ))
#     말미: meta = _build_meta(..., fill_count=len(fills)); return에 fills 포함

# (c) _build_meta: 파라미터 fill_count: int = 0 추가, row_counts에 "fills": fill_count

# (d) promote_today / promote_one 쓰기 블록 — 3종 _atomic_write_table 다음에:
        if fills:
            _atomic_write_table(write_fills_parquet, fills, target / "fills.parquet")
#     ※ fills가 비면 파일을 만들지 않는다 — 레거시 JSONL 재프로모트가
#       빈 fills.parquet으로 bundle의 fills-우선 분기를 가리는 사고 방지.
```

호출부( `_parse_jsonl_to_records`를 부르는 promote_one/promote_today의 언패킹)도 5-튜플로 맞춘다.

- [ ] **Step 4: 통과 + 기존 promote 테스트 회귀**

Run: `uv run pytest tests/unit/live/test_promote.py tests/unit/live/test_promote_today.py -v`
Expected: all passed (기존 테스트의 `row_counts` 어서션은 dict 전체 비교라면 `"fills": 0` 추가로 보정)

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/promote.py tests/unit/live/test_promote.py
git commit -m "feat(live): promote kind=fill -> fills.parquet (skip when absent)"
```

---

### Task 10: bundle의 fill_strength — fills 우선, trades 폴백

**Files:**
- Modify: `hoga/api/bundle.py` — `build_fill_strength_slice`(279-296행)
- Test: `tests/unit/api/test_bundle.py` (해당 테스트 파일 위치는 `grep -rn "build_fill_strength_slice" tests/`로 확인 후 같은 파일에 추가)

- [ ] **Step 1: 실패하는 테스트 추가**

```python
def test_fill_strength_prefers_fills_parquet(tmp_path, ...):
    # 준비: kis_live 디렉토리에 fills.parquet(buy 15/sell 5)와
    #       trades.parquet(전혀 다른 값)을 둘 다 둔다.
    # 검증: build_fill_strength_slice 결과가 fills 기준(15/5)인지.
    ...
```

(기존 `build_fill_strength_slice` 테스트의 fixture 헬퍼 — engine/parquet_dir 구성 — 를 그대로 재사용해 fills.parquet만 추가로 쓴다. `write_fills_parquet`로 `Fill(ts_ms=90000000, seq=1, buy_qty=15, sell_qty=5)` 1장.)

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/api/ -k fill_strength -v`
Expected: 신규 1 FAIL (trades 값이 반환됨)

- [ ] **Step 3: 구현** — bundle.py 292-296행 교체

```python
    # 그릴링 Q4: kis_live 신형은 fills.parquet(10초 구간합)이 체결강도 소스.
    # fills가 있으면 우선, 없으면(=hogaplay·레거시 kis_live) trades 폴백.
    from hoga.tables import fills as fills_tbl

    fills_path = engine.parquet_dir(date, code, source) / "fills.parquet"
    if fills_path.exists():
        rows = fills_tbl.query_fill_strength(
            engine.conn, path=fills_path, bucket_ms=bucket_ms
        )
    else:
        path_obj = engine.parquet_dir(date, code, source) / "trades.parquet"
        if not path_obj.exists():
            # ADR-0043: missing parquet is the valid "no trades yet" state.
            return []
        rows = trades_tbl.query_fill_strength(
            engine.conn, path=path_obj, bucket_ms=bucket_ms
        )
```

(이후 rows → wire 변환 코드는 기존 그대로 — `FillStrengthRow` 동일 타입.)

- [ ] **Step 4: 통과 + bundle 회귀**

Run: `uv run pytest tests/unit/api/ -v`
Expected: all passed

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/bundle.py tests/unit/api/
git commit -m "feat(api): fill_strength reads fills.parquet first, trades fallback"
```

---

### Task 11: lifecycle 전환 — Live Set·start_live_stream·watchdog·app 배선

**Files:**
- Modify: `hoga/live/lifecycle.py`
- Modify: `hoga/api/app.py` (lifespan)
- Modify: `hoga/api/watchlist.py` (reorder/add/remove 후크 — `grep -n "refresh_live_poller" hoga/`로 호출부 확인)
- Test: `tests/unit/live/test_lifecycle.py` (추가)

- [ ] **Step 1: 실패하는 Live Set 테스트 추가**

```python
def test_live_set_is_watchlist_order_prefix():
    from hoga.live.lifecycle import LIVE_SET_MAX_CODES, live_set_codes

    codes = [f"{i:06d}" for i in range(20)]
    assert LIVE_SET_MAX_CODES == 13            # 41 // 3 (spec §4·§5.1)
    assert live_set_codes(codes) == codes[:13]
    assert live_set_codes(codes[:5]) == codes[:5]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/unit/live/test_lifecycle.py::test_live_set_is_watchlist_order_prefix -v`
Expected: FAIL — ImportError

- [ ] **Step 3: lifecycle 구현** — 변경점

```python
# 상수 + 순수 함수 (모듈 상단)
KIS_WS_MAX_REGISTRATIONS = 41   # appkey당, (tr_id, code) 쌍 기준 — spec §4 검증 완료
TRS_PER_CODE = 3                # 호가 + 체결 + 회원사(H0STMBC0)
LIVE_SET_MAX_CODES = KIS_WS_MAX_REGISTRATIONS // TRS_PER_CODE  # = 13


def live_set_codes(watchlist_codes: list[str]) -> list[str]:
    """Live Set = watchlist 순서 상위 13 (CONTEXT.md 'Live Set', 그릴링 Q3)."""
    return list(watchlist_codes)[:LIVE_SET_MAX_CODES]


# _State 확장: poller_task/poller_obj 대신
#   stream_task: Optional[asyncio.Task]  /  stream_obj: Optional[LiveStream]
#   ws_task: Optional[asyncio.Task]      /  live_set: tuple[str, ...]


async def start_live_stream(*, data_dir: Path) -> bool:
    """start_live_poller의 WS 대체 — 구조 동일(creds/watchlist 가드 → 기동).

    poller와 같은 가드: KIS creds 없거나 watchlist 비면 False.
    symbol-master 필터도 동일 적용 후 live_set_codes로 상위 13 절단.
    """
    import os
    from hoga.api.watchlist import load_watchlist
    from .stream import LiveStream
    from .writer import LiveWriter
    from .ws_client import KisWsClient

    if not os.environ.get("KIS_APP_KEY") or not os.environ.get("KIS_APP_SECRET"):
        return False
    entries = load_watchlist(data_dir)
    codes = [e.code for e in entries]
    # (start_live_poller의 symbol-master 필터 블록을 그대로 재사용)
    ...
    codes = live_set_codes(codes)
    if not codes:
        return False

    await stop_live_stream()
    kis = ensure_kis_client_from_env(data_dir)
    if kis is None:
        return False

    def _today_kst() -> str:
        from datetime import datetime, timedelta, timezone
        return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")

    stream = LiveStream(buffer=_buffer, writer=LiveWriter(data_dir / "live"),
                        date_fn=_today_kst)
    from .session_gate import ws_capture_window

    ws = KisWsClient(approval_key_fn=kis.get_approval_key,
                     on_tick=stream.on_tick, date_fn=_today_kst,
                     gate_fn=lambda: ws_capture_window(_now_ms()))
    stream.ws = ws

    global _state
    _state = _State(
        started_at_ms=_now_ms(),
        watchlist_codes=tuple(codes),
        live_set=tuple(codes),
        stream_obj=stream,
        ws_task=asyncio.create_task(ws.run(codes), name="live-ws"),
        stream_task=asyncio.create_task(stream.run_flush_loop(), name="live-flush"),
    )
    return True


async def stop_live_stream() -> None:
    """stop_live_poller와 동일 패턴 — KisClient 싱글턴은 건드리지 않는다."""
    global _state
    for task in (_state.ws_task, _state.stream_task):
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
    _state = _State()


async def refresh_live_stream(*, data_dir: Path) -> None:
    """watchlist 변경(추가/삭제/reorder) 후크 — Live Set diff를 WS에 반영."""
    from hoga.api.watchlist import load_watchlist

    stream = _state.stream_obj
    if stream is None or stream.ws is None:
        return
    codes = live_set_codes([e.code for e in load_watchlist(data_dir)])
    await stream.ws.update_codes(codes)
    stream.set_active_codes(set(codes))   # advisor C: 밀려난 코드 carry 즉시 제거
    global _state
    _state = replace(_state, live_set=tuple(codes), watchlist_codes=tuple(codes))
```

**watchdog**(ADR-0064 이식): `_live_watchdog_check`(381-437행)를 `_ws_watchdog_check`로 복제·수정 — `dead = ws_task/stream_task 중 done()`, `last_tick = stream_obj.ws.last_tick_ms` + `stream_obj.last_flush_ms` 중 max, 재시작은 `start_live_stream`. 세션-open 기준 grace 로직(주석 포함)은 **그대로 유지**하되, 게이트 판정은 `_should_poll_now` 대신 **`ws_capture_window`**(advisor B — 15:30 이후엔 재시작 금지). `start_live_poller_watchdog`(440-461)도 동일 패턴으로 `start_live_stream_watchdog` 신설.

**get_status**: 기존 wire 키(`running`, `watchlist_count` 등)는 의미 유지(`running` = stream task alive), 추가 키 `transport: "ws"`, `ws_connected: bool`, `live_set: list[str]`.

- [ ] **Step 4: app.py·watchlist.py 배선 교체**

Run: `grep -rn "start_live_poller\|refresh_live_poller" hoga/api/ hoga/live/lifecycle.py`
각 호출부를 1:1 교체: `start_live_poller(` → `start_live_stream(`, `refresh_live_poller(` → `refresh_live_stream(`, `start_live_poller_watchdog(` → `start_live_stream_watchdog(`. (poller 함수 자체는 Task 13에서 삭제 — 이 시점엔 미사용으로만 남는다.)

- [ ] **Step 5: 테스트 + 서버 스모크 + 커밋**

Run: `uv run pytest tests/unit/live/ -v` → all passed
Run: `uv run uvicorn hoga.api.app:default_app --factory --port 8001 &` 후 `curl -s localhost:8001/api/live/status | python3 -m json.tool` → `"transport": "ws"` 포함 (장외라면 `ws_connected: false`가 정상 — 게이트 동작 확인). 서버 종료.

```bash
git add hoga/live/lifecycle.py hoga/api/app.py hoga/api/watchlist.py tests/unit/live/test_lifecycle.py
git commit -m "feat(live): Live Set(top-13) + start_live_stream + WS watchdog wiring"
```

---

### Task 12: 프론트 LiveSnapshotBuffer 시간 기반 eviction

**근거:** 백엔드 ring과 동일한 봉합 사이징 불변식(spec §8·§12) — per-tick 유량에서 개수 캡이 `pastMaxT`까지의 꼬리를 자르면 지표 봉합에 구멍.

**Files:**
- Modify: `frontend/src/live/liveSnapshotBuffer.ts`
- Test: `frontend/src/live/liveSnapshotBuffer.test.ts` (기존 파일에 추가; 없으면 신설)

- [ ] **Step 1: 실패하는 테스트 추가**

```ts
it('evicts entries older than retention window on push', () => {
  const buf = new LiveSnapshotBuffer();
  const old = { t_ms: 1_000, kind: 'ob' } as LiveSnapshotEntry;
  const fresh = { t_ms: 16 * 60_000 + 1_000, kind: 'ob' } as LiveSnapshotEntry;
  buf.push(old);
  buf.push(fresh); // fresh 기준 15분 컷오프 밖의 old는 제거
  expect(buf.ob.map((e) => e.t_ms)).toEqual([fresh.t_ms]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/liveSnapshotBuffer.test.ts`
Expected: FAIL (old가 남아 있음)

- [ ] **Step 3: 구현** — push/hydrate에 시간 eviction 추가

```ts
/** 봉합 사이징 불변식(spec §8): 보존 > 2× Today Promotion 주기(5분) → 15분. */
const RETENTION_MS = 15 * 60_000;

function evictOld(arr: Array<{ t_ms: number }>, nowMs: number): void {
  const cutoff = nowMs - RETENTION_MS;
  let drop = 0;
  while (drop < arr.length && arr[drop].t_ms < cutoff) drop += 1;
  if (drop > 0) arr.splice(0, drop);
}
```

`push(entry)` 말미에 해당 kind 배열에 `evictOld(arr, entry.t_ms)` 호출(배열은 t_ms 오름차순 append라 prefix-drop으로 충분). 기존 `MAX_BUFFER_PER_KIND` 개수 캡은 폭주 안전핀으로 유지하되 60_000으로 상향.

- [ ] **Step 4: 통과 + 프론트 전체 테스트**

Run: `cd frontend && npx vitest run src/live/` → all passed

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/liveSnapshotBuffer.ts frontend/src/live/liveSnapshotBuffer.test.ts
git commit -m "feat(frontend): time-based eviction for live snapshot buffer"
```

---

### Task 13: poller 완전 은퇴 (청소)

**Files:**
- Delete: `hoga/live/poller.py`, `tests/unit/live/test_poller.py`
- Modify: `hoga/live/kis_client.py` — `fetch_orderbook`/`fetch_trades`/`fetch_brokers`/`fetch_overtime_orderbook`/`fetch_overtime_trades` 메서드 삭제 (quote/candles/investor용 `fetch_multi_price`·`fetch_past_*`·investor는 **유지**)
- Modify: `hoga/live/snapshot.py` — poller 전용 빌더 `from_orderbook`/`from_trades`/`from_brokers` 및 `KisOrderbook` 등 import 삭제 (`from_fill`과 본체는 유지); `hoga/live/kis_models.py`에서 이로 인해 미사용이 된 모델 삭제
- Modify: `hoga/live/lifecycle.py` — `start_live_poller`/`stop_live_poller`/`refresh_live_poller`/`_live_watchdog_check`/`start_live_poller_watchdog` 삭제
- Test: 관련 테스트 파일에서 삭제 대상 케이스 제거 (`tests/unit/live/test_snapshot.py`의 빌더 byte-pin은 ws_frames payload-shape 테스트가 대체)

- [ ] **Step 1: 죽은 참조 전수 조사**

Run: `grep -rn "poller\|from_orderbook\|from_trades\|from_brokers\|fetch_orderbook\|fetch_trades\|fetch_brokers\|fetch_overtime" hoga/ tests/ --include='*.py' | grep -v session_gate`
Expected: 삭제 대상 정의·테스트만 출력 (다른 소비자가 나오면 **삭제 보류하고 그 소비자를 먼저 처리**)

- [ ] **Step 2: 삭제 실행 + import 정리**

위 Files 목록대로 삭제. `session_gate.py`는 이미 분리(Task 7)되어 무사.

- [ ] **Step 3: 전체 테스트**

Run: `uv run pytest tests/ -x -q`
Expected: all passed, 0 errors (ImportError 없음)

- [ ] **Step 4: ruff/pyright**

Run: `uv run ruff check hoga/ && uv run pyright`
Expected: clean (미사용 import 잔재 없음)

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "refactor(live)!: retire REST poller (WS replaces capture path)"
```

---

### Task 14: 장중 통합 스모크 + 문서 마감

**전제:** Task 0 녹화 완료(특히 시간외 수신 여부 기록), KRX 장중.

- [ ] **Step 1: 백엔드 기동 + WS 연결 확인**

Run: `uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga`
확인: `curl -s localhost:8000/api/live/status` → `"transport": "ws", "ws_connected": true, "live_set": [...]` (≤13개)

- [ ] **Step 2: sub-second 표시 확인 (브라우저)**

`cd frontend && npm run dev` 후 CLAUDE.md의 `/browse` 스킬로 `http://localhost:5173/live` 접속, watchlist 1번 종목 차트에서:
- 호가창(10호가)·총잔량·호가비·체결강도가 **1초 미만 간격으로 갱신**되는지 (`$B js` 로 `window.__liveAxisGet()` 또는 DOM 텍스트 2회 샘플 비교)
- `$B console --errors` 빈 출력

- [ ] **Step 3: 저장 경로 검증**

```bash
DATE=$(TZ=Asia/Seoul date +%Y%m%d); CODE=$(curl -s localhost:8000/api/live/status | python3 -c "import sys,json;print(json.load(sys.stdin)['live_set'][0])")
tail -3 ~/.local/share/hoga-ops/live/$DATE/$CODE.jsonl   # kind fill/ob/broker, 10초 간격
sleep 360  # Today Promotion 1주기 대기
python3 -c "import duckdb;print(duckdb.sql(\"select count(*) from read_parquet('$HOME/.local/share/hoga-ops/parquet/$DATE/$CODE/kis_live/fills.parquet')\"))"
curl -s "localhost:8000/api/range?code=$CODE&from=$DATE&to=$DATE&bucket_ms=60000&source_pref=kis_live" | python3 -c "import sys,json;d=json.load(sys.stdin);print('fill_strength points:',len(d['fill_strength']['points']))"
```
Expected: JSONL에 `"kind": "fill"` 포함·10초 간격 / fills.parquet count > 0 / fill_strength points > 0

- [ ] **Step 4: 재연결 복원 확인**

백엔드 프로세스 재시작 → `/live` 새로고침 → 지표 과거 구간(디스크 10초)과 꼬리(WS)가 이어지는지, `live.ws.reconnect` 로그에 백오프가 찍히는지.

- [ ] **Step 5: 문서·커밋**

- `CHANGELOG.md`에 항목 추가, spec §12의 시간외 수신 여부에 Task 0 관찰 결과 기록.
- CONTEXT.md의 **Live Capture/Live Tick/Live Set** 항목에서 "(구현 전)" 이행 표기 제거.

```bash
git add CHANGELOG.md CONTEXT.md docs/
git commit -m "docs: live KIS WS transition shipped (plan 1/3 complete)"
```

---

## Self-Review 결과 (작성자 점검)

- **Spec coverage:** §5.1(3TR·13종목)→T6/T11, §5.5(Live Set·poller 은퇴)→T11/T13, §7(핸드셰이크/구독/파싱/heartbeat/재연결/감독/게이팅)→T5/T6/T7/T11, §8(10초 저장·fills·시간 eviction·복원)→T3/T4/T8/T9/T12, §9(끊김·갭)→T6/T14, §10(파싱 fixture·다운샘플 경계·분류 동등성·저장 정합)→T1/T3/T8/T9, §12(필드 매핑·사이징·렌더 비용 측정)→T0/T1/T4/T12. **§5.4 캔들(옵션 A)·경계 분·경계선 UI는 Plan 2/3 범위** — 본 plan에서 캔들은 현행 REST 60초가 그대로 유지된다(무회귀).
- **Placeholder scan:** Task 10 Step 1과 Task 11 Step 3 일부가 기존 fixture 재사용을 지시하는 축약 코드(`...`)를 포함 — 해당 스텝에 "기존 패턴 grep 후 미러" 지시와 대상 위치를 명시했으므로 실행 가능으로 판단. 그 외 TBD 없음.
- **Type consistency:** `WsTick`(T1)을 T3/T6/T7이 동일 시그니처로 소비, `FillStrengthRow`(trades 기존)를 T8이 재사용해 T10 분기가 무캐스트, `LiveSnapshot.from_fill`(T2)→T3 flush→T9 promote의 payload 키(`buy_qty`/`sell_qty`) 일치 확인.
