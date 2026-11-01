"""Only truly identical in-flight public pages share an observation."""

import asyncio

from hoga.api.screener_daily_requests import page_key
from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler
from hoga.live.kiwoom_rest import KiwoomRestClient, Page


class Client(KiwoomRestClient):
    def __init__(self):
        self.calls = []

    async def call(self, api_id, body, *, cont=False, next_key=""):
        self.calls.append((api_id, body, cont, next_key))
        await asyncio.sleep(0)
        return Page(rows=[{"dt": "20261030"}], cont=False, next_key="", raw={})


async def test_actual_walk_metadata_shares_first_page_across_two_consumers():
    client = Client()
    governor = KiwoomCapacityScheduler(rate_per_sec=10000)
    try:
        async def run(fetch_fn, index):
            return await governor.submit(key=page_key(fetch_fn, ("fallback", index)), api_id="ka10081",
                                         priority="background", call=lambda _: fetch_fn(client))

        body = {"stk_cd": "005930", "base_dt": "20261030", "upd_stkpc_tp": "0"}
        results = await asyncio.gather(*(client.walk("ka10081", body, max_pages=1, run_page=run) for _ in range(2)))
        assert results[0] == results[1]
        assert len(client.calls) == 1
    finally:
        await governor.aclose()


def test_cursor_basis_market_adjust_flag_and_independent_rounds_have_distinct_keys():
    async def fetch(_):
        pass

    base = ("ka10081", (("stk_cd", "005930"), ("base_dt", "20261030"), ("upd_stkpc_tp", "0")), False, "")
    identities = [base,
                  ("ka10081", base[1], True, "cursor-A"),
                  ("ka10081", base[1], True, "cursor-B"),
                  ("ka10081", (("stk_cd", "005930_NX"), *base[1][1:]), False, ""),
                  ("ka10081", (base[1][0], ("base_dt", "20261102"), base[1][2]), False, ""),
                  ("ka10081", (*base[1][:2], ("upd_stkpc_tp", "1")), False, "")]
    keys = []
    for identity in identities:
        fetch.request_identity = identity
        keys.append(page_key(fetch, "fallback"))
    assert len(set(keys)) == len(identities)
    fetch.request_identity = base
    assert page_key(fetch, "other caller") == keys[0]
    assert page_key(fetch, "fallback", observation=("recheck", "round-1")) not in keys


def test_callables_without_request_metadata_keep_the_callers_unique_key():
    assert page_key(lambda: None, ("test", "A")) != page_key(lambda: None, ("test", "B"))
