from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"


@pytest.fixture(autouse=True)
def _reset_writer_ownership() -> None:
    """ADR-0094: 모든 writer 락을 테스트 사이에서 놓는다.

    락은 **프로세스 전역**이라 한 테스트가 잡으면 같은 프로세스의 다음 테스트가
    flock 재진입으로 통과해 버린다 — 소유권을 검증하는 테스트가 위양성으로 초록이
    되는 경로다.

    큐에는 그 위에 규약이 하나 더 있다: 해제 후의 "미시도" 상태가 곧 **쓰기 허용**
    이다(`captures.queue_owned()`). 그래서 이 픽스처가 예전 `_queue_owned = True`
    기본값을 대체한다 — `_data_dir` 를 직접 쓰는 테스트 DI 표면이 그 기본에 기대고
    있고, 뒤집히면 persistence 가 **에러 없이 no-op** 이 된다.
    """
    from hoga.api import ownership

    ownership.release_all()


@pytest.fixture(autouse=True)
def _no_real_mst_downloads(monkeypatch: pytest.MonkeyPatch) -> None:
    """부팅 자동 갱신이 **실제 네트워크를 때리지 않게** 막는 스위트 전역 가드.

    `app.py` 의 lifespan 은 `symbols.needs_boot_refresh()` 가 참일 때 마스터
    갱신을 예약하는데, 머신 전역 `symbol-master.json` 이 없는 CI/개발기에서는
    항상 참이다(`resolve_symbol_master_path` 가 의도적으로 HOGA_DATA_DIR 를
    무시하므로 tmp_path 로 격리되지 않는다).

    PR-J(#1046) 이후 소스가 KIS `.mst` 정적 다운로드에서 **키움 `ka10099`** 로
    바뀌었다. 그쪽은 자격증명이 없으면 스스로 실패하므로 다운로드 폭주는
    사라졌지만, 자격증명이 있는 로컬에서는 여전히 실제 호출이 나간다 — 그래서
    가드는 유지하고 막는 지점만 옮긴다.
    """
    from hoga.api import kiwoom_master, symbols

    async def _blocked():
        raise kiwoom_master.KiwoomMasterFetchError(
            "종목 마스터 갱신은 테스트에서 차단된다(autouse 가드)"
        )

    # **소비자 이음매에 건다.** 어댑터(`kiwoom_master.fetch_symbol_master`)에 걸면
    # 어댑터의 자기 테스트까지 막힌다 — 가드의 목적은 "앱 부팅이 네트워크를
    # 때리지 않게" 이지 "어댑터를 못 쓰게" 가 아니다.
    monkeypatch.setattr(symbols, "_fetch_symbol_master", _blocked)

    # 옵션 심리 패널(ADR-0135)의 지수선물옵션 .mst 도 같은 부류의 실 다운로드다.
    # 수집 런타임이 이걸 부르므로 같은 가드 아래 둔다.
    from hoga.api import kis_option_master

    def _blocked_option() -> bytes:
        raise kis_option_master.KisOptionMasterFetchError(
            "옵션 .mst download blocked in tests (autouse guard)"
        )

    monkeypatch.setattr(kis_option_master, "download_option_master", _blocked_option)


@pytest.fixture(autouse=True)
def _no_env_reload_on_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep creds isolation honest: the user-retry path (kis_runtime,
    reload_env=True) re-reads the repo's REAL .env on a creds
    miss. In tests that would silently restore KIS_APP_KEY/SECRET that a test
    delenv'ed — and background paths (poller gate) reach it too. No-op the
    dedicated hook; tests exercising the reload behavior re-patch it."""
    from hoga.live import kis_runtime

    monkeypatch.setattr(kis_runtime, "_reload_env_for_retry", lambda: None)


@pytest.fixture(autouse=True)
def _fresh_today_ttl(monkeypatch):
    """ADR-0090 TodayTtlCache 테스트 간 격리 — 전역 인스턴스를 매 테스트 교체."""
    import hoga.api.bundle as bundle_mod
    from hoga.api.today_ttl_cache import TodayTtlCache

    fresh = TodayTtlCache()
    monkeypatch.setattr("hoga.api.today_ttl_cache.TODAY_TTL", fresh)
    # bundle이 `from ... import TODAY_TTL`로 바인딩하므로 그 참조도 갈아끼운다.
    if hasattr(bundle_mod, "TODAY_TTL"):
        monkeypatch.setattr(bundle_mod, "TODAY_TTL", fresh)


@pytest.fixture
def tmp_data_dir(tmp_path: Path) -> Path:
    """A fresh per-test data directory."""
    d = tmp_path / "data"
    d.mkdir()
    return d


@pytest.fixture(scope="module")
def app_client(tmp_path_factory: pytest.TempPathFactory) -> TestClient:
    """Module-scoped TestClient backed by the tiny_tsv fixture for 003490/20260519.

    Module scope amortises the parse_stock_date cost across the file. The test
    suite is read-only (HTTP GETs against pre-parsed parquet); no test mutates
    the data dir, so sharing the app + parsed parquet across the file is safe.
    """
    tmp_path = tmp_path_factory.mktemp("api")
    raw = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw.mkdir(parents=True)
    for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
        shutil.copy(FIXTURE_DIR / name, raw / name)
    parse_stock_date(code="003490", date="20260519", data_dir=tmp_path / "data")
    app = create_app(data_dir=tmp_path / "data")
    return TestClient(app)
