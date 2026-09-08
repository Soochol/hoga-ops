from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder, WatchlistMemoItem, code_items
from hoga.api.watchlist import load_document, save_document
from hoga.api.watchlist_routes import build_router

A, B = "f_0000000a", "f_0000000b"


def refs(*codes):
    return [{"kind": "code", "code": c} for c in codes]


@pytest.fixture
def client(tmp_path: Path):
    save_document(
        tmp_path,
        WatchlistDocument(
            folders=[
                WatchlistFolder(
                    id=A,
                    name="A",
                    order=0,
                    items=[*code_items(["005930", "000660"]), WatchlistMemoItem(id="m_00000001", text="keep")],
                ),
                WatchlistFolder(id=B, name="B", order=1, items=code_items(["035420", "005930"])),
            ],
            entries=[
                WatchlistEntry(code=c, name=c, registered_at_kst_date="20260908")
                for c in ["005930", "000660", "035420"]
            ],
        ),
    )
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    with TestClient(app) as c:
        yield c


def transaction():
    memo = {"kind": "memo", "id": "m_00000001"}
    return {
        "changes": [
            {"folder_id": A, "before": [*refs("005930", "000660"), memo], "after": [memo]},
            {"folder_id": B, "before": refs("035420", "005930"), "after": refs("005930", "000660", "035420")},
        ]
    }


def test_move_and_inverse_preserve_duplicate_membership_memo_and_metadata(client, tmp_path):
    before = load_document(tmp_path).model_dump()
    request = transaction()
    assert client.put("/api/watchlist/items/transaction", json=request).status_code == 204
    body = client.get("/api/watchlist").json()
    assert [(e["folder_id"], e["code"]) for e in body["entries"]] == [(B, c) for c in ["005930", "000660", "035420"]]
    assert body["memos"][0]["text"] == "keep"
    inverse = {
        "changes": [
            {"folder_id": c["folder_id"], "before": c["after"], "after": c["before"]} for c in request["changes"]
        ]
    }
    assert client.put("/api/watchlist/items/transaction", json=inverse).status_code == 204
    assert load_document(tmp_path).model_dump() == before


@pytest.mark.parametrize("fault", ["stale", "duplicate", "delete", "unknown", "memo_move", "folder"])
def test_invalid_transaction_never_partially_writes(client, tmp_path, fault):
    before = load_document(tmp_path).model_dump()
    request = transaction()
    a, b = request["changes"]
    if fault == "stale":
        b["before"].reverse()
    elif fault == "duplicate":
        b["after"].append(b["after"][0])
    elif fault == "delete":
        b["after"] = refs("035420")
    elif fault == "unknown":
        b["after"].extend(refs("123456"))
    elif fault == "memo_move":
        b["after"].extend(a["after"])
        a["after"] = []
    else:
        b["folder_id"] = "f_99999999"
    assert client.put("/api/watchlist/items/transaction", json=request).status_code in (404, 409)
    assert load_document(tmp_path).model_dump() == before


def test_undo_conflict_preserves_later_edit(client, tmp_path):
    request = transaction()
    assert client.put("/api/watchlist/items/transaction", json=request).status_code == 204
    client.put(f"/api/watchlist/folders/{B}/items/order", json={"ordered_items": refs("035420", "000660", "005930")})
    before = load_document(tmp_path).model_dump()
    inverse = {
        "changes": [
            {"folder_id": c["folder_id"], "before": c["after"], "after": c["before"]} for c in request["changes"]
        ]
    }
    assert client.put("/api/watchlist/items/transaction", json=inverse).status_code == 409
    assert load_document(tmp_path).model_dump() == before
