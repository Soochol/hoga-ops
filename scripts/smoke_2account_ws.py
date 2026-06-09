"""출시2 선결 스모크 테스트 — 동일 IP에서 appkey 2개로 KIS WS 2소켓 동시 유지 가능?

ADR-0067 위험 #1 (BLOCKER) 확정용. 장외에도 검증 가능:
approval key는 별도 엔드포인트(토큰 쿨다운 무관)이고, 연결+구독 ACK는 시장시간 무관.
틱 수신은 장중에만 — 장외엔 ticks=0이 정상(연결 생존이 판정 기준).

판정:
- both approval keys mint (distinct) → 2 appkey 유효
- both ws.connected == True 동시 → 2소켓 공존 (★ BLOCKER 답)
- both sub_acked == sub_expected(=3) → 양쪽 구독 수락
- both last_recv → 양쪽 프레임 수신(최소 PINGPONG) = 소켓 생존
"""
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from hoga.config import resolve_data_dir
from hoga.env import load_env
from hoga.live.kis_client import KisClient, KisCredentials
from hoga.live.kis_token_provider import KisTokenProvider
from hoga.live.ws_client import KisWsClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
load_env()

LOCAL = resolve_data_dir() / ".local"
COUNTS = {"a0": 0, "a1": 0}


def make_client(key_env: str, sec_env: str, cache_name: str) -> KisClient:
    creds = KisCredentials(
        app_key=os.environ[key_env], app_secret=os.environ[sec_env], env="real"
    )
    provider = KisTokenProvider(creds, LOCAL / cache_name)
    return KisClient(creds, provider)


def mk_on_tick(tag: str):
    async def on_tick(_t) -> None:
        COUNTS[tag] += 1
    return on_tick


def today_kst() -> str:
    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")


async def main() -> None:
    c0 = make_client("KIS_APP_KEY", "KIS_APP_SECRET", "kis-token.json")
    c1 = make_client("KIS_APP_KEY_2", "KIS_APP_SECRET_2", "kis-token-1.json")

    # 1) approval key sanity — 두 appkey가 각각 키를 발급하는지 + 서로 다른지
    try:
        k0 = await c0.get_approval_key()
        k1 = await c1.get_approval_key()
        print(f"[approval] a0 ok len={len(k0)} | a1 ok len={len(k1)} | distinct={k0 != k1}")
    except Exception as e:  # noqa: BLE001
        print(f"[approval] FAILED: {e!r}")
        await c0.aclose()
        await c1.aclose()
        return

    # 2) 두 WS 동시 연결 (gate_fn=None → 장외에도 연결 시도)
    ws0 = KisWsClient(approval_key_fn=c0.get_approval_key, on_tick=mk_on_tick("a0"),
                      date_fn=today_kst, gate_fn=None)
    ws1 = KisWsClient(approval_key_fn=c1.get_approval_key, on_tick=mk_on_tick("a1"),
                      date_fn=today_kst, gate_fn=None)
    t0 = asyncio.create_task(ws0.run(["005930"]))   # 삼성전자
    t1 = asyncio.create_task(ws1.run(["000660"]))   # SK하이닉스

    both_connected_seen = False
    for i in range(6):
        await asyncio.sleep(5)
        if ws0.connected and ws1.connected:
            both_connected_seen = True
        print(
            f"[t+{(i+1)*5:2d}s] "
            f"a0 conn={ws0.connected} ack={ws0.sub_acked}/{ws0.sub_expected} "
            f"rej={ws0.sub_rejected} recv={ws0.last_recv_ms is not None} ticks={COUNTS['a0']} | "
            f"a1 conn={ws1.connected} ack={ws1.sub_acked}/{ws1.sub_expected} "
            f"rej={ws1.sub_rejected} recv={ws1.last_recv_ms is not None} ticks={COUNTS['a1']}"
        )

    # 판정 스냅샷 (cancel 전에 캡처 — cancel하면 connected=False가 됨)
    verdict = {
        "both_connected_seen": both_connected_seen,
        "a0_ack": (ws0.sub_acked, ws0.sub_expected, ws0.sub_rejected),
        "a1_ack": (ws1.sub_acked, ws1.sub_expected, ws1.sub_rejected),
        "a0_recv": ws0.last_recv_ms is not None,
        "a1_recv": ws1.last_recv_ms is not None,
    }

    t0.cancel()
    t1.cancel()
    for t in (t0, t1):
        try:
            await t
        except asyncio.CancelledError:
            pass
    await c0.aclose()
    await c1.aclose()

    print("\n===== VERDICT =====")
    print(f"both sockets connected simultaneously : {verdict['both_connected_seen']}")
    print(f"a0 sub ack/expected/rejected          : {verdict['a0_ack']}")
    print(f"a1 sub ack/expected/rejected          : {verdict['a1_ack']}")
    print(f"a0 received frames / a1 received frames: {verdict['a0_recv']} / {verdict['a1_recv']}")
    go = (
        verdict["both_connected_seen"]
        and verdict["a0_recv"] and verdict["a1_recv"]
        and verdict["a0_ack"][2] == 0 and verdict["a1_ack"][2] == 0
    )
    print(f"\n>>> {'GO — 2계좌 WS 26종목 출시2 진행 가능' if go else 'NO-GO — 아래 신호 확인 필요'}")


if __name__ == "__main__":
    asyncio.run(main())
