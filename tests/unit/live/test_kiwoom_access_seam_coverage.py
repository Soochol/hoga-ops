"""키움 REST 호출이 전부 거버너 seam 을 통과하는지 — 우회 재발 방지.

**`kiwoom_access` 의 규범은 자동으로 보장되지 않는다.** 클라이언트는 아무 데서나
`ensure_rest_client` 로 얻을 수 있고 `client.call()` 은 그냥 불린다. 2026-08-07 감사에서
세 곳이 우회 중이었고, 각각 이런 대가를 치르고 있었다:

1. 유량 페이싱 — 그 콜이 TR 버킷을 안 거쳐 거버너 눈에 안 보인다.
2. **토큰 revoke(8005) 자동복구** — 복구가 거버너 소유다(PR #1088). 우회 경로는 죽은
   토큰으로 실패하고도 재발급이 안 걸려 **조용히 멈춘다**(시드·캐시가 답을 계속 주므로
   화면엔 증상이 없다). 이게 가장 나쁜 대가다.
3. 테스트 페이크 — seam 몽키패치가 안 먹어 실 벤더를 친다.

그래서 "seam 을 탔다" 를 **테스트로 고정**한다. 없으면 다음 호출 지점이 같은 실수를
반복하고, 증상이 조용해서 오래 안 드러난다.
"""
from pathlib import Path

import pytest

from hoga.api.symbols import _fetch_symbol_master as _ORIGINAL_FETCH_MASTER
from hoga.live import kiwoom_access

# conftest 의 autouse 가드가 `symbols._fetch_symbol_master` 를 덮는다(실 다운로드 차단).
# 위 import 는 **모듈 수집 시점**이라 그 패치보다 먼저 원본을 잡는다 — 여기서 검증할
# 것이 "그 함수가 러너를 주입하는가" 이므로 원본을 직접 불러야 한다.


class _FakePage:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.truncated = False


class _FakeClient:
    """직접 호출되면 즉시 실패한다 — 우회를 테스트가 잡게 만드는 장치."""

    def __init__(self, rows: list[dict] | None = None) -> None:
        self._rows = rows or []
        self.direct_calls: list[str] = []

    async def call(self, api_id: str, body: dict, **_kw) -> _FakePage:
        self.direct_calls.append(api_id)
        return _FakePage(self._rows)


@pytest.fixture
def seam_spy(monkeypatch):
    """`run_with_capacity` 호출을 기록하고 fetch_fn 은 그대로 실행한다."""
    seen: list[dict] = []

    async def _spy(scheduler, *, key, api_id, priority, fetch_fn, client):  # noqa: ANN001
        seen.append({"key": key, "api_id": api_id, "priority": priority})
        return await fetch_fn(client)

    monkeypatch.setattr(kiwoom_access, "run_with_capacity", _spy)
    return seen


def _stub_runtime(monkeypatch, client):
    from hoga.live import kiwoom_rest_runtime

    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: client)
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_a, **_k: object())


# ── ka10080: 저장뷰 캔들 복구 → **경로 삭제됨**(2026-08-07) ──────────────────
#
# `make_repair_minute_fetch` 를 검증하던 두 테스트가 여기 있었다. 그 경로는 ADR-0109
# 캔들 복구본(`kis_api`)을 만드는 유일한 생산자였고, 소스와 함께 기능을 접으면서
# 사라졌다 — 근거는 `sources.SourceName` 주석(복구본이 메우던 것은 캔들뿐이고
# 캔들은 벤더가 과거를 다시 준다).
#
# #1173 이 이 경로의 seam 우회를 막 고친 직후라 아깝지만, 고친 코드가 지워지는 것이
# 문제가 아니라 **그 경로가 필요 없어진 것**이다. 나머지 두 seam(ka10081·ka20006)은
# 그대로 남아 아래에서 계속 검증된다.


# ── ka20006: 거래일 오버레이 갱신 ──────────────────────────────────────────

async def test_trading_days_overlay_goes_through_the_seam(monkeypatch, seam_spy, tmp_path):
    """저빈도라 유량 이득은 없다 — 목적은 8005 자동복구다.

    우회하면 죽은 토큰으로 실패하고도 재발급이 안 걸려 오버레이가 조용히 멈춘다.
    조회는 커밋된 시드로 계속 답하므로 화면엔 아무 증상이 없다.
    """
    from hoga.api import trading_days

    client = _FakeClient(rows=[{"dt": "20260806"}])
    _stub_runtime(monkeypatch, client)
    monkeypatch.setattr(trading_days, "append_overlay", lambda *_a, **_k: 1)

    added = await trading_days.refresh_overlay(tmp_path)

    assert added == 1
    assert [s["api_id"] for s in seam_spy] == ["ka20006"]
    assert seam_spy[0]["priority"] == "background"


async def test_trading_days_overlay_dormant_without_credentials(monkeypatch, seam_spy, tmp_path):
    from hoga.api import trading_days
    from hoga.live import kiwoom_rest_runtime

    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: None)

    assert await trading_days.refresh_overlay(tmp_path) == 0
    assert seam_spy == []


# ── ka10099: 종목 마스터 (시장별 2콜) ──────────────────────────────────────

async def test_symbol_master_submits_once_per_market(monkeypatch, seam_spy, tmp_path):
    """**콜마다 1 submit** 이어야 버킷과 벤더가 같은 수를 센다(ADR-0137).

    함수 전체를 한 submit 으로 감싸면 버킷은 1 을 세고 벤더는 2 를 센다.
    """
    from hoga.api import symbols

    # `marketCode` 가 security_type 을 정한다("0"=거래소 주식) — 없으면 행이 버려진다
    row = {"code": "005930", "name": "삼성전자", "marketCode": "0", "nxtEnable": "Y"}
    client = _FakeClient(rows=[row])
    _stub_runtime(monkeypatch, client)
    monkeypatch.setattr(symbols, "_symbols_data_dir", lambda: tmp_path)

    await _ORIGINAL_FETCH_MASTER()

    assert [s["api_id"] for s in seam_spy] == ["ka10099", "ka10099"]
    # key 가 시장별로 달라야 중복제거가 두 콜을 하나로 접지 않는다
    assert len({s["key"] for s in seam_spy}) == 2


async def test_symbol_master_direct_path_still_works_without_runner() -> None:
    """`run_call=None` 이면 직접 호출 — seam 없는 자리(테스트·스크립트)를 위한 폴백."""
    from hoga.api.kiwoom_master import fetch_symbol_master

    row = {"code": "005930", "name": "삼성전자", "marketCode": "0", "nxtEnable": "Y"}
    client = _FakeClient(rows=[row])
    rows = await fetch_symbol_master(client)

    assert client.direct_calls == ["ka10099", "ka10099"]  # 시장 2개
    assert len(rows) == 2


# ── 정적 가드 ──────────────────────────────────────────────────────────────

def test_no_module_calls_client_directly_outside_the_seam() -> None:
    """`ensure_rest_client` 를 쓰는 모듈은 `run_with_capacity` 도 써야 한다.

    문자열 검사라 거칠지만, 우회의 **증상이 조용해서** 런타임 테스트로는 새 호출
    지점을 놓친다. 예외는 아래 화이트리스트에만 둔다.
    """
    root = Path(__file__).resolve().parents[3] / "hoga"
    # 클라이언트를 **반환만** 하는 seam 헬퍼 — 호출자가 거버너를 탄다.
    allowed = {"kiwoom_rest_runtime.py", "investor_flow_runtime.py"}

    offenders = []
    for path in root.rglob("*.py"):
        if path.name in allowed:
            continue
        src = path.read_text(encoding="utf-8")
        if "ensure_rest_client" in src and "run_with_capacity" not in src:
            offenders.append(str(path.relative_to(root)))

    assert offenders == [], f"거버너 seam 우회: {offenders}"
