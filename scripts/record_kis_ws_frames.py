"""장중 KIS WS 프레임 녹화 — 파서 fixture 생산용 (1회성 스파이크, plan Task 0).

사용:  KIS_APP_KEY=.. KIS_APP_SECRET=.. uv run python scripts/record_kis_ws_frames.py 005930 60
출력:  tests/fixtures/kis_ws/{h0stasp0,h0stcnt0,h0stmbc0,control}.txt

녹화 후 확인할 것(plan Task 0 Step 2 게이트):
- cnt≥2 H0STCNT0 프레임 포함 여부(멀티레코드 stride의 유일한 실검증)
- 각 H0STCNT0 프레임에서 len(body.split('^')) == cnt*46 정확 성립(trailing 원소 0)
- H0STASP0/H0STMBC0의 cnt가 1을 넘는 프레임 존재 여부(최종 리뷰 I3-a)
- PINGPONG 수신 간격(< 120s — watchdog 전제, Task 11)
- 15:35 재실행으로 시간외 수신 여부
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
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            if raw and raw[0] in ("0", "1"):
                tr = raw.split("|", 3)[1]
                files.get(tr, control).write(raw + "\n")
                counts[tr] = counts.get(tr, 0) + 1
            else:
                control.write(raw + "\n")
                msg = json.loads(raw)
                if msg.get("header", {}).get("tr_id") == "PINGPONG":
                    await ws.send(raw)  # PINGPONG echo (공식 규약)
    for f in [*files.values(), control]:
        f.close()
    print("recorded:", counts)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 60  # noqa: PLR2004 — argv 인덱스))
