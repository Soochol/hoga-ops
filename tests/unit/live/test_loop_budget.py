import asyncio

from hoga.live.loop_budget import LoopWorkBudget


async def test_time_waiting_for_a_loop_turn_does_not_cause_an_extra_yield():
    clock = [0.0]
    with LoopWorkBudget(0.001, lambda: clock[0]) as budget:
        await asyncio.sleep(0)  # callback/queue yields before the next checkpoint
        clock[0] = 10.0
        await budget.checkpoint()
        assert budget.yields == 0
        assert budget.observed_resumes == 1
        clock[0] += 0.0005
        await budget.checkpoint()
        assert budget.yields == 0
        clock[0] += 0.0006
        await budget.checkpoint()
        assert budget.yields == 1  # synchronous work still has to give others a turn


async def test_explicit_yield_resets_on_return_and_does_not_repeat_for_wait_time():
    clock = [0.0]
    with LoopWorkBudget(0.001, lambda: clock[0]) as budget:
        clock[0] = 0.002
        asyncio.get_running_loop().call_soon(lambda: clock.__setitem__(0, 10.0))
        await budget.checkpoint()
        assert budget.yields == 1
        assert budget.yield_wait_ms == 9998.0
        await budget.checkpoint()
        assert budget.yields == 1


async def test_reader_and_consumer_do_not_reset_each_others_work_budget():
    clock = [0.0]
    with (LoopWorkBudget(0.001, lambda: clock[0]) as reader,
          LoopWorkBudget(0.001, lambda: clock[0]) as consumer):
        clock[0] = 0.0008
        await reader.checkpoint()
        clock[0] = 0.0012
        await consumer.checkpoint()
        assert consumer.yields == 1


async def test_close_leaves_no_pending_marker():
    budget = LoopWorkBudget(0.0)
    marker = budget._marker
    budget.close()
    assert marker.cancelled()
    assert budget._marker is None
    await asyncio.sleep(0)
