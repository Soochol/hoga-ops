"""Pinned-account Kiwoom REST adapter. No account selection or write retry lives here."""

from __future__ import annotations

import asyncio
import contextlib
import re
import time
from collections.abc import Callable
from datetime import datetime
from decimal import ROUND_DOWN, Decimal, InvalidOperation, localcontext
from http import HTTPStatus
from pathlib import Path
from typing import Any

import httpx

from hoga.live.kiwoom_budget import KiwoomBudget, bind_budget, budget_for
from hoga.trading.accounts import AccountRegistry
from hoga.trading.contracts import BrokerAccount, BrokerBalances, BrokerOrder, BrokerOrderState
from hoga.trading.toss import TradingError
from hoga.util.timeenc import KST

READS = {"ka00001", "ka10075", "kt00007", "kt00009", "kt00015", "kt00018", "kt00011", "ka10081"}
WRITES = {"kt10000", "kt10001", "kt10002", "kt10003"}
HOSTS = {"real": "https://api.kiwoom.com", "mock": "https://mockapi.kiwoom.com"}
PREFIXED_CODE_LENGTH = 7
ACCOUNT_CACHE_SECONDS = 60
SNAPSHOT_CACHE_SECONDS = 3


def integer(value: Any, *, optional: bool = False) -> str | None:
    if value in (None, "") and optional:
        return None
    try:
        number = Decimal(str(value).strip())
        if not number.is_finite() or number < 0 or number != number.to_integral_value():
            raise ValueError("invalid quantity")
        return str(int(number))
    except (ValueError, InvalidOperation) as exc:
        raise TradingError(503, "invalid-broker-response", "키움증권 수량·금액을 확인할 수 없습니다.") from exc


def code_of(value: Any) -> str:
    code = str(value).strip()
    if len(code) == PREFIXED_CODE_LENGTH and code[0] in "AJQ":
        code = code[1:]
    if not re.fullmatch(r"[A-Za-z0-9]{6}", code):
        raise TradingError(503, "invalid-broker-response", "키움증권 종목 정보를 확인할 수 없습니다.")
    return code


class KiwoomAccountGateway:
    def __init__(
        self,
        provider: Any,
        *,
        environment: str = "real",
        account_index: int = 0,
        transport: httpx.AsyncBaseTransport | None = None,
        budget: KiwoomBudget | None = None,
    ) -> None:
        if environment not in HOSTS:
            raise ValueError("unknown Kiwoom environment")
        provider_environment = getattr(getattr(provider, "_creds", None), "environment", environment)
        if provider_environment != environment:
            raise ValueError("token environment mismatch")
        self.provider, self.environment, self.account_index = provider, environment, account_index
        self.budget = budget or budget_for(provider)
        self.shared_budget = budget is None
        self.http = httpx.AsyncClient(
            base_url=HOSTS[environment],
            timeout=12,
            follow_redirects=False,
            trust_env=False,
            transport=transport or httpx.AsyncHTTPTransport(retries=0),
        )

    async def close(self) -> None:
        await self.http.aclose()  # The runtime owns the shared token provider.

    async def call(  # noqa: PLR0912 — explicit transport and vendor outcome classification
        self,
        api_id: str,
        body: dict,
        *,
        cursor: str = "",
        before_send: Callable[[], None] | None = None,
        deadline: float | None = None,
        write_authorized: bool = False,
    ) -> tuple[dict, str | None]:
        if api_id not in READS | WRITES:
            raise TradingError(422, "unsupported-trading-api", "지원하지 않는 주문 API입니다.")
        write = api_id in WRITES
        if write and (not write_authorized or before_send is None):
            raise TradingError(409, "kiwoom-orders-disabled", "주문 전송은 계좌가 확인된 명령 경로에서만 가능합니다.")
        try:
            token = await asyncio.to_thread(self.provider.get_token)
        except Exception as exc:
            raise TradingError(503, "kiwoom-auth-unavailable", "키움증권 인증 연결을 확인하세요.") from exc
        try:
            await self.budget.acquire(api_id, write=write, deadline=deadline)
        except TimeoutError as exc:
            raise TradingError(
                409, "order-queue-expired", "주문 전송 대기가 만료되었습니다. 새 주문 조건을 확인하세요."
            ) from exc
        if before_send:
            before_send()  # Persist SENDING only after auth/admission, before the HTTP side effect.
        try:
            response = await self.http.post(
                "/api/dostk/ordr" if write else "/api/dostk/chart" if api_id == "ka10081" else "/api/dostk/acnt",
                json=body,
                headers={
                    "authorization": f"Bearer {token}",
                    "api-id": api_id,
                    "Content-Type": "application/json;charset=UTF-8",
                    "cont-yn": "Y" if cursor else "N",
                    "next-key": cursor,
                },
            )
        except httpx.HTTPError as exc:
            raise self.failure(write) from exc
        if response.status_code >= HTTPStatus.INTERNAL_SERVER_ERROR or response.is_redirect:
            raise self.failure(write)
        try:
            result = response.json()
        except ValueError as exc:
            raise self.failure(write) from exc
        if not isinstance(result, dict) or "return_code" not in result:
            raise self.failure(write)
        vendor_code = result["return_code"]
        if type(vendor_code) not in {int, str} or not re.fullmatch(r"-?\d{1,6}", str(vendor_code)):
            raise self.failure(write)
        if int(vendor_code) == 0 and not response.is_success:
            raise self.failure(write)
        if response.status_code == HTTPStatus.UNAUTHORIZED:
            # Invalidate for the NEXT request; never replay this write.
            with contextlib.suppress(Exception):
                await asyncio.to_thread(self.provider.invalidate)
        if not response.is_success or int(vendor_code) != 0:
            # Vendor prose can include account/credential data. Publish only a numeric code.
            raw_code = str(result["return_code"])
            code = raw_code if re.fullmatch(r"-?\d{1,6}", raw_code) else "unknown"
            status = HTTPStatus.TOO_MANY_REQUESTS if response.status_code == HTTPStatus.TOO_MANY_REQUESTS else 422
            raise TradingError(
                status,
                f"kiwoom-rejected-{code}",
                "키움증권이 요청을 거절했습니다. 계좌·거래시간·주문 조건을 확인하세요.",
            )
        if write and (not isinstance(result.get("ord_no"), str) or not re.fullmatch(r"\d{7}", result["ord_no"])):
            raise self.failure(True)
        if write:
            return result, None  # Order acknowledgements are never paginated.
        if response.headers.get("cont-yn") == "Y":
            next_key = response.headers.get("next-key")
            if not next_key:
                raise self.failure(False)
            return result, next_key
        return result, None

    @staticmethod
    def failure(write: bool) -> TradingError:
        return TradingError(
            503,
            "order-outcome-unknown" if write else "kiwoom-read-unavailable",
            "주문 결과를 확인할 수 없습니다. 키움 주문 내역을 확인하세요."
            if write
            else "키움증권 조회를 완료하지 못했습니다.",
        )

    async def rows(self, api_id: str, body: dict, key: str) -> list[dict]:
        result, cursor, seen = [], "", set()
        for _ in range(100):
            page, next_key = await self.call(api_id, body, cursor=cursor)
            rows = page.get(key)
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise self.failure(False)
            result.extend(rows)
            if next_key is None:
                return result
            if next_key in seen:
                raise self.failure(False)
            seen.add(next_key)
            cursor = next_key
        raise self.failure(False)


class KiwoomTradingAdapter:
    def __init__(
        self,
        gateway: KiwoomAccountGateway,
        registry: AccountRegistry,
        data_dir: Path,
    ) -> None:
        self.gateway, self.registry, self.data_dir = gateway, registry, data_dir
        self.account_ref = ""
        self._account_no = ""
        self._verified_at = 0.0
        self._verify_lock = asyncio.Lock()
        self._snapshot_lock = asyncio.Lock()
        self._snapshots: dict[str, tuple[float, BrokerOrderState]] = {}
        self.revision = 0
        self.events_connected = False
        self._observed_orders: dict[tuple[str, str], tuple[int, str]] = {}
        self._generation = -1
        self.on_change: Callable[[], None] | None = None

    @property
    def credential(self) -> str:
        return f"kiwoom:{self.gateway.environment}:{self.gateway.account_index}"

    async def account(self, *, fresh: bool = False) -> BrokerAccount:
        async with self._verify_lock:
            if fresh or not self.account_ref or time.monotonic() - self._verified_at > ACCOUNT_CACHE_SECONDS:
                result, _ = await self.gateway.call("ka00001", {})
                number = result.get("acctNo")
                if not isinstance(number, str) or not re.fullmatch(r"\d{10}", number):
                    raise self.gateway.failure(False)
                self.account_ref = self.registry.bind(self.credential, "kiwoom", self.gateway.environment, number)
                if self.gateway.shared_budget:
                    self.gateway.budget = bind_budget(self.gateway.provider, self.account_ref)
                self._account_no = number
                self._verified_at = time.monotonic()
        routes = self.routes()
        return BrokerAccount(
            account_ref=self.account_ref,
            broker="kiwoom",
            environment=self.gateway.environment,
            label=(
                f"키움증권 · {'실전' if self.gateway.environment == 'real' else '모의'} · ****{self._account_no[-4:]}"
            ),
            supported_routes=routes,
            routes=routes,
            order_enabled=bool(routes),
            blocked_reason=None,
        )

    def routes(self) -> list[str]:
        # Account verification authorizes the supported routes; no acceptance file is required.
        return ["KRX"] if self.gateway.environment == "mock" else ["KRX", "NXT", "SOR"]

    def changed(self) -> None:
        self._snapshots.clear()
        self.revision += 1
        if self.on_change:
            self.on_change()

    def parse_order(  # noqa: PLR0912, PLR0915 — pinned OPEN/history wire formats have distinct status rules
        self, row: dict, date: str, *, history: bool = False
    ) -> BrokerOrder:
        if row.get("acnt_no") and row["acnt_no"] != self._account_no:
            raise self.gateway.failure(False)
        native = str(row.get("ord_no", "")).strip()
        if not re.fullmatch(r"\d{7}", native):
            raise self.gateway.failure(False)
        code = code_of(row.get("stk_cd", ""))
        kind = str(row.get("io_tp_nm", ""))
        trade = str(row.get("trde_tp", ""))
        if "매도" in kind + trade or trade == "1":
            side = "SELL"
        elif "매수" in kind + trade or trade == "2":
            side = "BUY"
        else:
            raise self.gateway.failure(False)
        venue = str(row.get("dmst_stex_tp", row.get("stex_tp_txt", row.get("stex_tp", "")))).strip()
        route = "SOR" if row.get("sor_yn") == "Y" else {"0": "SOR", "1": "KRX", "2": "NXT"}.get(venue, venue)
        if route not in {"KRX", "NXT", "SOR"}:
            raise self.gateway.failure(False)
        qty = integer(row.get("ord_qty"))
        remainder = integer(row.get("ord_remnq") if history else row.get("oso_qty"))
        if int(remainder) > int(qty):
            raise self.gateway.failure(False)
        original = str(row.get("orig_ord_no", row.get("ori_ord", ""))).strip()
        original = original if original and original != "0000000" else None
        if original and not re.fullmatch(r"\d{7}", original):
            raise self.gateway.failure(False)
        operation_text = kind + trade + str(row.get("mdfy_cncl", ""))
        operation = "cancel" if "취소" in operation_text else "modify" if "정정" in operation_text else None
        raw_status = str(row.get("ord_stt", row.get("acpt_tp", "")))
        confirmed = integer(row.get("cnfm_qty"), optional=True)
        fill = integer(row.get("cntr_qty"), optional=True)
        total = integer(row.get("cntr_tot_amt"), optional=True)
        has_fill = any(v is not None and int(v) > 0 for v in (fill, total))
        working = not operation or (operation == "modify" and not history and raw_status in {"확인", "체결"})
        if "거부" in raw_status:
            status = "CANCEL_REJECTED" if operation == "cancel" else "REPLACE_REJECTED" if operation else "REJECTED"
        elif operation and not working:
            status = (
                ("CANCELED" if operation == "cancel" else "REPLACED")
                if ("확인" in raw_status and confirmed is not None and int(confirmed) > 0)
                else "PENDING_CANCEL"
                if operation == "cancel"
                else "PENDING_REPLACE"
            )
        elif int(remainder) > 0 and raw_status in {"접수", "체결", "확인"}:
            status = "PARTIAL_FILLED" if has_fill else "PENDING"
        elif history and int(remainder) == 0 and fill == qty and int(qty) > 0 and not operation:
            status = "FILLED"
        else:
            # An absent OPEN row/zero remainder alone never proves completion.
            status = "UNKNOWN"
        price = integer(row.get("ord_uv") if history else row.get("ord_pric"), optional=True)
        clock = str(row.get("ord_tm", row.get("tm", ""))).replace(":", "")
        ordered_at = None
        if re.fullmatch(r"\d{6}", clock):
            with contextlib.suppress(ValueError):
                ordered_at = datetime.strptime(date + clock, "%Y%m%d%H%M%S").replace(tzinfo=KST).isoformat()
        ref = self.registry.order_ref(self.account_ref, native, date, route)
        return BrokerOrder(
            order_ref=ref,
            account_ref=self.account_ref,
            broker_order_id=native,
            trading_date=date,
            original_order_id=original,
            root_order_id=self.registry.root(ref),
            code=code,
            side=side,
            route=route,
            quantity=qty,
            remaining_quantity=remainder,
            filled_quantity=qty if status == "FILLED" else None,
            price=price,
            status=status,
            broker_status=raw_status,
            ordered_at=ordered_at,
            operation=operation,
            order_type="MARKET" if "시장가" in trade else "LIMIT",
            editable=working
            and status in {"PENDING", "PARTIAL_FILLED"}
            and int(remainder) > 0
            and str(row.get("crd_tp", "")) in {"", "0", "00", "보통매매"}
            and not any(tag in kind for tag in ("신용", "융자", "대주")),
        )

    async def order_state(self, code: str = "", *, fresh: bool = False, date: str | None = None) -> BrokerOrderState:
        await self.account()
        date = date or datetime.now(KST).strftime("%Y%m%d")
        async with self._snapshot_lock:
            cached = self._snapshots.get(date)
            if not fresh and cached and time.monotonic() - cached[0] < SNAPSHOT_CACHE_SECONDS:
                result = cached[1]
            else:
                revision = self.revision
                opens, history = await asyncio.gather(
                    self.gateway.rows(
                        "ka10075", {"all_stk_tp": "0", "trde_tp": "0", "stk_cd": "", "stex_tp": "0"}, "oso"
                    ),
                    self.gateway.rows(
                        "kt00007",
                        {
                            "ord_dt": date,
                            "qry_tp": "1",
                            "stk_bond_tp": "1",
                            "sell_tp": "0",
                            "stk_cd": "",
                            "fr_ord_no": "",
                            "dmst_stex_tp": "%",
                        },
                        "acnt_ord_cntr_prps_dtl",
                    ),
                )
                open_orders = [self.parse_order(r, date) for r in opens]
                open_ids = {o.order_ref for o in open_orders}
                recent = [self.parse_order(r, date, history=True) for r in history]
                result = BrokerOrderState(
                    account_ref=self.account_ref,
                    code="",
                    orders=open_orders,
                    recent_orders=[o for o in recent if o.order_ref not in open_ids],
                    fetched_at_ms=int(time.time() * 1000),
                    events_connected=self.events_connected,
                    revision=revision,
                )
                if revision == self.revision:
                    self._snapshots[date] = time.monotonic(), result
            return result.model_copy(
                update={
                    "code": code,
                    "orders": [o for o in result.orders if not code or o.code == code],
                    "recent_orders": [o for o in result.recent_orders if not code or o.code == code],
                    "events_connected": self.events_connected,
                }
            )

    async def holdings(self) -> list[dict]:
        await self.account()
        # Never add KRX and NXT balances together: their overlap is unverified.
        rows = await self.gateway.rows("kt00018", {"qry_tp": "2", "dmst_stex_tp": "KRX"}, "acnt_evlt_remn_indv_tot")
        result = {}
        for row in rows:
            if str(row.get("crd_tp", "")) not in {"", "0", "00"}:
                continue
            quantity = integer(row.get("rmnd_qty"))
            if int(quantity) > 0:
                code = code_of(row.get("stk_cd"))
                price = integer(row.get("pur_pric"))
                cost = integer(row.get("pur_amt"), optional=True)
                cost = int(cost) if cost is not None else int(price) * int(quantity)
                sellable = integer(row.get("trde_able_qty"), optional=True)
                if sellable is not None and int(sellable) > int(quantity):
                    raise self.gateway.failure(False)
                item = result.setdefault(
                    code,
                    {
                        "code": code,
                        "name": str(row.get("stk_nm", "")),
                        "quantity": 0,
                        "sellable_quantity": 0,
                        "cost": 0,
                    },
                )
                item["quantity"] += int(quantity)
                item["cost"] += cost
                item["sellable_quantity"] = (
                    None
                    if item["sellable_quantity"] is None or sellable is None
                    else item["sellable_quantity"] + int(sellable)
                )
        for item in result.values():
            with localcontext() as ctx:
                ctx.prec = 60
                # Truncate sub-won fractions so the UI's whole-won ceiling preserves total cost.
                average = (Decimal(item.pop("cost")) / item["quantity"]).quantize(
                    Decimal("0.000000000001"), rounding=ROUND_DOWN
                )
            item["average_purchase_price"] = format(average, "f").rstrip("0").rstrip(".") or "0"
            item["quantity"] = str(item["quantity"])
            if item["sellable_quantity"] is not None:
                item["sellable_quantity"] = str(item["sellable_quantity"])
        return list(result.values())

    async def balances(self, code: str, price: int | None = None) -> BrokerBalances:
        holdings = await self.holdings()
        item = next((h for h in holdings if h["code"] == code), None)
        result = BrokerBalances(
            account_ref=self.account_ref,
            code=code,
            fetched_at_ms=int(time.time() * 1000),
            holding_quantity=item["quantity"] if item else "0",
            average_purchase_price=item["average_purchase_price"] if item else None,
            sellable_quantity=item["sellable_quantity"] if item else "0",
        )
        try:
            body = {"stk_cd": code, **({"uv": str(price)} if price else {})}
            capacity, _ = await self.gateway.call("kt00011", body)
            result.buying_power = integer(capacity.get("min_ord_alow_amt"), optional=True)
            result.buyable_quantity = integer(capacity.get("min_ord_alowq"), optional=True)
            if result.buying_power is not None and result.buyable_quantity is not None:
                result.capacity_status = "available"
        except TradingError:
            pass  # Unavailable is distinct from zero; never fall back to a margin field.
        return result

    def account_event(self, row: dict, generation: int) -> None:
        values = row.get("values", {})
        if values.get("9201") != self._account_no:
            return
        if generation < self._generation:
            return
        self._generation = generation
        if row.get("type") == "00":
            native = values.get("9203", "")
            try:
                remainder = integer(values.get("902"))
            except TradingError:
                self.changed()
                return
            if re.fullmatch(r"\d{7}", native):
                today = datetime.now(KST).strftime("%Y%m%d")
                self._observed_orders = {k: v for k, v in self._observed_orders.items() if k[0] == today}
                key = (today, native)
                old = self._observed_orders.get(key)
                status = str(values.get("913", ""))
                if old is None or (int(remainder) <= old[0] and old[1] not in {"취소", "거부"}):
                    self._observed_orders[key] = (int(remainder), status)
        # Invalidations trigger canonical reconciliation; a raw event is not a full order snapshot.
        self.changed()

    def validate_current(self, order: BrokerOrder) -> None:
        observed = self._observed_orders.get((order.trading_date, order.broker_order_id))
        if observed and (int(order.remaining_quantity) > observed[0] or observed[1] in {"취소", "거부"}):
            raise TradingError(409, "order-state-syncing", "최신 체결·취소 상태를 동기화 중입니다. 갱신 후 확인하세요.")
