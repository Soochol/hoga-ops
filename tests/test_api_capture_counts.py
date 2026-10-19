from __future__ import annotations

import json

from fastapi.testclient import TestClient

from hoga.api.app import create_app


def test_visible_counts_preserve_source_priority_and_legacy_null(tmp_path):
    root = tmp_path / "parquet" / "20261019" / "005930"
    (root / "hogaplay").mkdir(parents=True)
    (root / "meta.json").write_text(json.dumps({"full_capture_count": 2}))
    (root / "hogaplay" / "meta.json").write_text(json.dumps({"full_capture_count": 7}))
    app = create_app(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/capture-counts", json={"items": [
            {"code": "005930", "date": "20261019"}, {"code": "000660", "date": "20261019"},
        ]})
        assert response.status_code == 200
        assert response.json() == {"items": [
            {"code": "005930", "date": "20261019", "full_capture_count": 7},
            {"code": "000660", "date": "20261019", "full_capture_count": None},
        ]}
        (root / "hogaplay" / "meta.json").write_text("{}")
        item = {"code": "005930", "date": "20261019"}
        response = client.post("/api/capture-counts", json={"items": [item]})
        assert response.json()["items"][0]["full_capture_count"] is None
        bad = {"code": "../etc", "date": "20261019"}
        assert client.post("/api/capture-counts", json={"items": [bad]}).status_code == 422
        assert client.post("/api/capture-counts", json={"items": [item] * 201}).status_code == 422
