"""Finite amendment cohorts on one event loop; no network or validation cache lives here."""

from __future__ import annotations

import asyncio
import time
from collections import Counter, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import Enum, auto

from hoga.trading.contracts import BrokerOrder, BrokerOrderState
from hoga.trading.toss import TradingError

MAX_CONCURRENT_KIWOOM_MODIFICATIONS = 4


class DispatchOutcome(Enum):
    UNSENT = auto()
    UNCERTAIN = auto()
    ACCEPTED = auto()
    REJECTED = auto()


class EpochAdmission(Enum):
    OPEN = auto()
    SEALED = auto()
    FROZEN_UNCERTAIN = auto()


@dataclass(frozen=True)
class _Identity:
    native: str
    date: str
    route: str
    related: frozenset[str]


def _identity(order: BrokerOrder) -> _Identity | None:
    family = order.root_order_id
    if family is None:
        # Missing ancestry on an operation is not evidence of an independent original.
        if order.operation or order.original_order_id:
            return None
        family = order.broker_order_id
    return _Identity(
        order.broker_order_id,
        order.trading_date,
        order.route,
        frozenset({order.broker_order_id, family, order.original_order_id} - {None}),
    )


@dataclass(eq=False)
class AmendmentLease:
    gate: KiwoomCodeGate
    order_ref: str
    parallel: bool
    follower: bool = False
    proof: _Identity | None = None

    def complete(self, outcome: DispatchOutcome) -> None:
        if outcome is DispatchOutcome.UNCERTAIN:
            self.gate.admission = EpochAdmission.FROZEN_UNCERTAIN
            self.gate.notify()

    def observe(self, snapshot: BrokerOrderState) -> None:
        if not self.parallel:
            return
        counts = Counter(o.order_ref for o in snapshot.orders)
        identities = {
            o.order_ref: identity for o in snapshot.orders
            if counts[o.order_ref] == 1 and o.editable and (identity := _identity(o)) is not None
        }
        current = identities.get(self.order_ref)
        if self.follower:
            if current != self.proof:
                raise TradingError(409, "order-state-syncing", "원주문 관계를 동기화 중입니다. 갱신 후 확인하세요.")
        else:
            self.proof = current
            self.gate.fence = identities if current is not None else {}
            self.gate.notify()


class KiwoomCodeGate:
    """FIFO exclusive writes or a finite cohort of proven independent modifiers.

    All mutations are synchronous between awaits on the service's single event loop.
    A ticket at the head that cannot join waits for drain; later tickets never pass it.
    """

    def __init__(self) -> None:
        self.queue: deque[AmendmentLease] = deque()
        self.active: set[AmendmentLease] = set()
        self.fence: dict[str, _Identity] | None = None
        self.granted = 0
        self.admission = EpochAdmission.OPEN
        self.changed = asyncio.Event()

    def notify(self) -> None:
        self.changed.set()
        self.changed = asyncio.Event()

    def _can_join(self, lease: AmendmentLease) -> bool:
        if not lease.parallel or self.admission is not EpochAdmission.OPEN or self.fence is None:
            return False
        proof = self.fence.get(lease.order_ref)
        return proof is not None and all(
            member.parallel and member.proof is not None and member.proof.related.isdisjoint(proof.related)
            for member in self.active
        )

    @asynccontextmanager
    async def enter(self, order_ref: str, *, parallel: bool, deadline: float):
        lease = AmendmentLease(self, order_ref, parallel)
        self.queue.append(lease)
        granted = False
        try:
            while True:
                if time.monotonic() >= deadline:
                    raise TimeoutError("admission-deadline")
                if self.queue[0] is lease and (not self.active or self._can_join(lease)):
                    self.queue.popleft()
                    if self.active:
                        lease.follower = True
                        lease.proof = self.fence[order_ref]
                    else:
                        self.granted = 0
                        self.fence = None
                    self.granted += 1
                    if self.granted == MAX_CONCURRENT_KIWOOM_MODIFICATIONS:
                        self.admission = EpochAdmission.SEALED
                    self.active.add(lease)
                    granted = True
                    self.notify()
                    break
                changed = self.changed
                async with asyncio.timeout_at(deadline):
                    await changed.wait()
            yield lease
        finally:
            if granted:
                self.active.remove(lease)
                if not self.active:
                    self.fence = None
                    self.granted = 0
                    self.admission = EpochAdmission.OPEN
            else:
                self.queue.remove(lease)
            self.notify()
