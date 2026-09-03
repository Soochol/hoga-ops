"""봉 패턴 검색 저장 (ADR-0166).

이 파일이 닫는 방향:
* 저장은 **질문만** 담는다 — 결과(매치)가 실리면 파일이 커지고 재현이 스냅샷이 된다.
* 기준의 **두 종류**가 모양으로 강제된다(`recent` 는 봉수, `fixed` 는 날짜).
  이 값이 불러오기의 갈림길이라, 반쪽만 채운 저장은 만들 수 없어야 한다.
* 파일이 스크리너 저장과 **다른 경로**다 — 같은 파일을 쓰면 두 기능의 격리가 엉킨다.

못 보는 것: 프론트가 불러온 뒤 조건을 실제로 복원하는지는 여기서 안 잰다(드로어 몫).
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import pattern_saves
from hoga.api.models import PatternSaveWriteRequest
from hoga.api.screener import build_router

RECENT = {
    "name": "삼성전자 · 최근 7봉",
    "code": "005930",
    "stock_name": "삼성전자",
    "window": {"kind": "recent", "bars": 7},
    "conditions": {"mode": "history", "count": 40, "sim_floor": 0.9},
}
FIXED = {
    "name": "삼성전자 · 2018-03-07~15",
    "code": "005930",
    "stock_name": "삼성전자",
    "window": {"kind": "fixed", "from_date": "20180307", "to_date": "20180315"},
    "conditions": {"mode": "history", "since": "20230101", "count": 100},
}


@pytest.fixture
def client(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return TestClient(app)


def test_crud_round_trip_keeps_created_at(client):
    r = client.post("/api/screener/pattern-saves", json=RECENT)
    assert r.status_code == 201
    save = r.json()

    listed = client.get("/api/screener/pattern-saves").json()
    assert listed["schema_version"] == 1
    assert [s["id"] for s in listed["saves"]] == [save["id"]]

    r2 = client.put(f"/api/screener/pattern-saves/{save['id']}",
                    json={**RECENT, "name": "이름 바꿈"})
    assert r2.status_code == 200
    assert r2.json()["name"] == "이름 바꿈"
    # 수정이 생성 시각을 갈아엎으면 "언제 만든 저장인가" 를 잃는다.
    assert r2.json()["created_at_ms"] == save["created_at_ms"]
    assert r2.json()["updated_at_ms"] >= save["updated_at_ms"]

    assert client.delete(f"/api/screener/pattern-saves/{save['id']}").status_code == 204
    assert client.get("/api/screener/pattern-saves").json()["saves"] == []


def test_missing_id_is_404_not_500(client):
    assert client.delete("/api/screener/pattern-saves/nope").status_code == 404
    assert client.put("/api/screener/pattern-saves/nope", json=RECENT).status_code == 404


def test_newest_first(client):
    ids = [client.post("/api/screener/pattern-saves",
                       json={**RECENT, "name": f"n{i}"}).json()["id"] for i in range(3)]
    listed = [s["id"] for s in client.get("/api/screener/pattern-saves").json()["saves"]]
    assert listed == list(reversed(ids))


@pytest.mark.parametrize("window, ok", [
    ({"kind": "recent", "bars": 7}, True),
    ({"kind": "fixed", "from_date": "20180307", "to_date": "20180315"}, True),
    # 종류와 모양이 어긋나면 **불러오기가 무엇을 할지 정해지지 않는다** — 거부한다.
    ({"kind": "recent"}, False),
    ({"kind": "fixed", "bars": 7}, False),
    ({"kind": "fixed", "from_date": "20180315", "to_date": "20180307"}, False),
    ({"kind": "recent", "bars": 4}, False),      # PATTERN_MIN_BARS 미만
    ({"kind": "recent", "bars": 31}, False),     # PATTERN_MAX_BARS 초과
])
def test_window_shape_must_match_its_kind(client, window, ok):
    r = client.post("/api/screener/pattern-saves", json={**RECENT, "window": window})
    assert (r.status_code == 201) is ok


def test_blank_name_is_rejected(client):
    r = client.post("/api/screener/pattern-saves", json={**RECENT, "name": "   "})
    assert r.status_code == 422


def test_saves_live_in_their_own_file(tmp_path):
    """스크리너 저장과 **다른 파일**이다 — 같은 파일이면 격리·백업 단위가 엉킨다."""
    assert pattern_saves._path(tmp_path).name == "saves.json"
    assert pattern_saves._path(tmp_path).parent.name == "pattern"


def test_missing_file_reads_as_empty(tmp_path):
    """아직 한 번도 저장하지 않은 환경이 정상 경로다 — 없으면 빈 목록이다."""
    assert pattern_saves.load_saves(tmp_path).saves == []


def test_conditions_carry_the_whole_question_not_the_answer():
    """조건에 **결과가 없다** — 저장되는 것은 질문이지 답이 아니다."""
    req = PatternSaveWriteRequest.model_validate(FIXED)
    fields = set(req.conditions.model_fields)
    assert {"mode", "since", "count", "sim_floor", "per_code", "volume_weight"} <= fields
    assert not fields & {"matches", "results", "rows"}


def test_absent_timeframe_means_daily_not_a_missing_axis():
    """봉 단위의 **부재는 「주봉이 없던 시절의 저장」**이지 「고르지 않았다」가 아니다.

    `ma_preset` 과 같은 규칙이다(#1711) — 화면이 `None` 을 공장값(일봉)으로 읽는다.
    이 계약이 깨지면 주봉 이전의 저장이 전부 **불러올 수 없는 상태**가 된다.

    못 보는 것: 화면이 실제로 공장값으로 읽는지는 프론트의 몫이다. 여기서는 모델이
    부재를 **허용하고 값을 지어내지 않는** 것만 잰다.
    """
    without = {k: v for k, v in FIXED["conditions"].items() if k != "timeframe"}
    req = PatternSaveWriteRequest.model_validate({**FIXED, "conditions": without})
    assert req.conditions.timeframe is None, "부재를 기본값으로 채우면 두 의미가 뭉개진다"

    weekly = PatternSaveWriteRequest.model_validate(
        {**FIXED, "conditions": {**without, "timeframe": "W"}})
    assert weekly.conditions.timeframe == "W"
