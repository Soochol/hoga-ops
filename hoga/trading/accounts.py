"""Stable private account identity and durable native order references."""

from __future__ import annotations

import contextlib
import hashlib
import json
import sqlite3
from pathlib import Path

from hoga.trading.toss import TradingError


class AccountRegistry:
    def __init__(self, path: Path) -> None:
        self.path = path

    @contextlib.contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS bindings (credential TEXT PRIMARY KEY, account_ref TEXT NOT NULL)")
            db.execute(
                "CREATE TABLE IF NOT EXISTS orders (ref TEXT PRIMARY KEY, account_ref TEXT NOT NULL, "
                "native_id TEXT NOT NULL, trading_date TEXT NOT NULL, route TEXT NOT NULL)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS lineage (ref TEXT PRIMARY KEY, parent_ref TEXT, "
                "root_native TEXT NOT NULL, action TEXT NOT NULL)"
            )
            yield db

    def bind(self, credential: str, broker: str, environment: str, account_no: str) -> str:
        digest = hashlib.sha256(f"{broker}:{environment}:{account_no}".encode()).hexdigest()[:32]
        account_ref = f"acc_{digest}"
        with self.connect() as db:
            row = db.execute("SELECT account_ref FROM bindings WHERE credential=?", (credential,)).fetchone()
            if row and row[0] != account_ref:
                raise TradingError(
                    409, "account-binding-changed", "인증 정보의 연결 계좌가 변경되었습니다. 설정을 확인하세요."
                )
            db.execute("INSERT OR IGNORE INTO bindings VALUES (?, ?)", (credential, account_ref))
        return account_ref

    def order_ref(self, account_ref: str, native_id: str, trading_date: str, route: str) -> str:
        raw = json.dumps([account_ref, trading_date, native_id], separators=(",", ":"))
        ref = "ord_" + hashlib.sha256(raw.encode()).hexdigest()[:40]
        with self.connect() as db:
            db.execute(
                "INSERT OR IGNORE INTO orders VALUES (?, ?, ?, ?, ?)",
                (ref, account_ref, native_id, trading_date, route),
            )
            row = db.execute("SELECT route FROM orders WHERE ref=?", (ref,)).fetchone()
            if row and row[0] != route:
                raise TradingError(409, "order-route-conflict", "주문 거래소 정보를 동기화 중입니다.")
        return ref

    def resolve_order(self, ref: str, account_ref: str) -> tuple[str, str, str]:
        with self.connect() as db:
            row = db.execute(
                "SELECT account_ref, native_id, trading_date, route FROM orders WHERE ref=?", (ref,)
            ).fetchone()
        if not row or row[0] != account_ref:
            raise TradingError(409, "order-context-mismatch", "선택 계좌의 주문만 변경할 수 있습니다.")
        return row[1], row[2], row[3]

    def remember_lineage(self, ref: str, parent_ref: str | None, root_native: str, action: str) -> None:
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO lineage VALUES (?, ?, ?, ?)", (ref, parent_ref, root_native, action))

    def root(self, ref: str) -> str | None:
        with self.connect() as db:
            row = db.execute("SELECT root_native FROM lineage WHERE ref=?", (ref,)).fetchone()
        return row[0] if row else None
