"""키움 WS 0D(주식호가잔량) 원본 FID 전수 채록 — "증감 필드가 실려 오는가" 확인용.

배경: 구 OpenAPI FID 표에는 호가 직전잔량 대비(81~100)·총잔량 직전대비(122/126)가
존재한다. 신 REST WS `0D`에 이게 실려 오면 프론트의 스냅샷 diff 엔진이 불필요해진다.
T2 채록(2026-07-20)은 0D를 "틱 폭주"로 제외해 미확정으로 남아 있었다.

⚠️ 앱키당 세션 1개 — 새 연결은 같은 키의 기존 세션을 킥한다. 운영(account 0·1)을
건드리지 않도록 **유휴 키(account 2 = KIWOOM_APP_KEY_3)** 를 쓴다(T2와 동일).

사용: uv run python scripts/probe_kiwoom_0d_fids.py [--seconds 20] [--codes 005930,000660]
"""
from __future__ import annotations

import argparse
import asyncio
import json
from collections import Counter
from pathlib import Path

from hoga.config import resolve_data_dir
from hoga.env import load_env
from hoga.live.kiwoom_runtime import ensure_token_provider_for_account
from hoga.live.kiwoom_ws_client import WS_URL_REAL

IDLE_ACCOUNT = 2  # = KIWOOM_APP_KEY_3

# 구 OpenAPI 표 기준 "증감" 후보 — 실제로 오는지 확인할 대상.
DELTA_CANDIDATES = {
    **{str(f): f"매도호가{f - 80}단 직전대비" for f in range(81, 91)},
    **{str(f): f"매수호가{f - 90}단 직전대비" for f in range(91, 101)},
    "122": "총매도잔량 직전대비",
    "126": "총매수잔량 직전대비",
}


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=20)
    ap.add_argument("--codes", default="005930,000660")
    args = ap.parse_args()

    load_env()
    data_dir = resolve_data_dir()
    prov = ensure_token_provider_for_account(IDLE_ACCOUNT, data_dir)
    if prov is None:
        print(f"account {IDLE_ACCOUNT} 자격증명 없음 — .env 의 KIWOOM_APP_KEY_3 확인")
        return 2
    token = await asyncio.to_thread(prov.get_token)

    import websockets

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    frames: list[dict] = []
    fid_counter: Counter[str] = Counter()

    async with websockets.connect(WS_URL_REAL, ping_interval=None, max_size=None) as ws:
        await ws.send(json.dumps({"trnm": "LOGIN", "token": token}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("trnm") == "LOGIN":
                print("LOGIN rc=", msg.get("return_code"), msg.get("return_msg"))
                if msg.get("return_code") != 0:
                    return 3
                break

        await ws.send(json.dumps({
            "trnm": "REG", "grp_no": "1", "refresh": "1",
            "data": [{"item": codes, "type": ["0D"]}],
        }))

        try:
            async with asyncio.timeout(args.seconds):
                while True:
                    msg = json.loads(await ws.recv())
                    trnm = msg.get("trnm")
                    if trnm == "PING":
                        await ws.send(json.dumps(msg))
                        continue
                    if trnm == "REG":
                        print("REG rc=", msg.get("return_code"))
                        continue
                    if trnm != "REAL":
                        continue
                    for row in msg.get("data") or []:
                        if row.get("type") != "0D":
                            continue
                        values = row.get("values") or {}
                        fid_counter.update(values.keys())
                        if len(frames) < 3:
                            frames.append(row)
        except TimeoutError:
            pass

    print(f"\n0D 프레임 수신: {sum(1 for _ in frames)} 대표 보관 / FID 종류 {len(fid_counter)}개")
    if not fid_counter:
        print("0D 프레임 0건 — 장 시간·종목·venue 확인 필요")
        return 4

    all_fids = sorted(fid_counter, key=lambda x: int(x) if x.isdigit() else 1 << 30)
    print("수신된 전체 FID:", ", ".join(all_fids))

    print("\n=== 증감 후보 필드 검사 ===")
    hits = [f for f in DELTA_CANDIDATES if f in fid_counter]
    if hits:
        print(f"실려 옴 ({len(hits)}개):")
        for f in sorted(hits, key=int):
            sample = frames[0].get("values", {}).get(f)
            print(f"  FID {f} = {DELTA_CANDIDATES[f]}  샘플={sample!r}")
    else:
        print("없음 — 81~100 / 122 / 126 중 어느 것도 오지 않는다.")
        print("→ 증감은 클라이언트가 스냅샷 diff 로 만들어야 한다(현재 구현이 유일한 경로).")

    out = Path(data_dir) / "research_capture" / "kiwoom_0d_fids.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(
        {"fid_counts": dict(fid_counter), "sample_frames": frames}, ensure_ascii=False, indent=1,
    ), encoding="utf-8")
    print(f"\n원본 저장: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
