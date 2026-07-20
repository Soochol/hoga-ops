"""키움 0D 직전대비(FID 81~100) 의미론 판별 — 가격 기준인가 단(slot) 기준인가.

이 구분이 결정적이다:
  - **단 기준**이면 호가 사다리가 밀릴 때 "1단 직전대비"가 서로 다른 가격을 비교한다
    → 프론트가 교집합 규칙으로 피하려던 관측창 이동 아티팩트가 그대로 남는다.
  - **가격 기준**이면 소스가 이미 올바른 증감을 준다 → 클라이언트 diff 불필요.

판별법: 연속 프레임 (prev, cur) 에서 사다리가 **이동한** 경우만 골라
  slot_hyp[i]  = cur.q[i] - prev.q[i]                    (같은 슬롯끼리)
  price_hyp[i] = cur.q[i] - prev.q[prev의 같은 가격]      (같은 가격끼리)
를 실제 수신값과 대조한다. 이동이 없는 프레임은 두 가설이 동일해 판별력이 없다.
"""
from __future__ import annotations

import argparse
import asyncio
import json

from hoga.config import resolve_data_dir
from hoga.env import load_env
from hoga.live.kiwoom_runtime import ensure_token_provider_for_account
from hoga.live.kiwoom_ws_client import WS_URL_REAL

IDLE_ACCOUNT = 2

ASK_P = [str(f) for f in range(41, 51)]
BID_P = [str(f) for f in range(51, 61)]
ASK_Q = [str(f) for f in range(61, 71)]
BID_Q = [str(f) for f in range(71, 81)]
ASK_D = [str(f) for f in range(81, 91)]
BID_D = [str(f) for f in range(91, 101)]


def num(v: str | None) -> int:
    if v is None or not str(v).strip():
        return 0
    return int(str(v).strip())


def side(values: dict, pf: list[str], qf: list[str], df: list[str]):
    return (
        [abs(num(values.get(f))) for f in pf],
        [abs(num(values.get(f))) for f in qf],
        [num(values.get(f)) for f in df],
    )


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=45)
    ap.add_argument("--code", default="005930_NX")
    args = ap.parse_args()

    load_env()
    prov = ensure_token_provider_for_account(IDLE_ACCOUNT, resolve_data_dir())
    if prov is None:
        print("자격증명 없음")
        return 2
    token = await asyncio.to_thread(prov.get_token)

    import websockets

    frames: list[dict] = []
    async with websockets.connect(WS_URL_REAL, ping_interval=None, max_size=None) as ws:
        await ws.send(json.dumps({"trnm": "LOGIN", "token": token}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("trnm") == "LOGIN":
                if m.get("return_code") != 0:
                    print("LOGIN 실패", m)
                    return 3
                break
        await ws.send(json.dumps({
            "trnm": "REG", "grp_no": "1", "refresh": "1",
            "data": [{"item": [args.code], "type": ["0D"]}],
        }))
        try:
            async with asyncio.timeout(args.seconds):
                while True:
                    m = json.loads(await ws.recv())
                    if m.get("trnm") == "PING":
                        await ws.send(json.dumps(m))
                        continue
                    if m.get("trnm") != "REAL":
                        continue
                    for row in m.get("data") or []:
                        if row.get("type") == "0D" and row.get("values"):
                            frames.append(row["values"])
        except TimeoutError:
            pass

    print(f"프레임 {len(frames)}건 수신")
    if len(frames) < 2:
        print("프레임 부족 — 장 시간/종목 확인")
        return 4

    stats = {"slot_ok": 0, "price_ok": 0, "both": 0, "neither": 0, "shifted_pairs": 0, "pairs": 0}
    examples: list[str] = []

    for prev, cur in zip(frames, frames[1:], strict=False):
        for label, pf, qf, df in (("ASK", ASK_P, ASK_Q, ASK_D), ("BID", BID_P, BID_Q, BID_D)):
            pp, pq, _ = side(prev, pf, qf, df)
            cp, cq, cd = side(cur, pf, qf, df)
            if not any(cd):
                continue
            stats["pairs"] += 1
            shifted = pp != cp
            if shifted:
                stats["shifted_pairs"] += 1
            prev_by_price = dict(zip(pp, pq, strict=False))
            slot = [cq[i] - pq[i] for i in range(10)]
            price = [cq[i] - prev_by_price.get(cp[i], 0) if cp[i] in prev_by_price else None for i in range(10)]

            slot_match = all(cd[i] == slot[i] for i in range(10))
            price_match = all(price[i] is None or cd[i] == price[i] for i in range(10))
            if slot_match and price_match:
                stats["both"] += 1
            elif slot_match:
                stats["slot_ok"] += 1
            elif price_match:
                stats["price_ok"] += 1
            else:
                stats["neither"] += 1
                if shifted and len(examples) < 3:
                    examples.append(
                        f"{label} 사다리이동={shifted}\n  prev_p={pp}\n  cur_p ={cp}\n"
                        f"  prev_q={pq}\n  cur_q ={cq}\n  수신증감={cd}\n"
                        f"  slot가설={slot}\n  price가설={price}"
                    )

    print(json.dumps(stats, ensure_ascii=False, indent=1))
    print()
    if stats["slot_ok"] and not stats["price_ok"]:
        print("판정: **단(slot) 기준** — 사다리 이동 시 다른 가격을 비교한다.")
    elif stats["price_ok"] and not stats["slot_ok"]:
        print("판정: **가격 기준** — 소스가 올바른 증감을 준다.")
    elif stats["both"] and not (stats["slot_ok"] or stats["price_ok"] or stats["neither"]):
        print("판정: 사다리 이동이 없어 두 가설이 구분 불가(판별력 없는 표본).")
    else:
        print("판정: 혼재/불일치 — 아래 예시 확인 필요.")
    for e in examples:
        print("\n" + e)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
