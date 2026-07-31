"""WebSocket port of the /api/events SSE e2e inventory test.

Previously, ``test_api_sse.py::test_sse_inventory_added`` spun up a real
uvicorn server because ``httpx.ASGITransport`` buffers SSE bodies.  WebSocket
has no such limitation, so we use Starlette's ``TestClient`` instead.

``TestClient.__enter__`` runs the full FastAPI lifespan, which:
 - starts the watchdog observer (``observer.start()``)
 - binds ``inv_handler.loop`` to the running asyncio event loop

so by the time ``websocket_connect`` returns the bus subscription is live and
the observer is already watching the parquet directory.

두 갈래로 나뉜다:

``test_ws_inventory_added``
    감시 콜백 → 이벤트 버스 → WS 프레임 배선을 **결정론적으로** 검증한다.
    watchdog 콜백을 직접 호출하므로 커널 inotify 가 언제 무장되는지에 의존하지
    않는다. 차단 게이트가 도는 것은 이쪽이다.

``test_ws_inventory_added_via_real_inotify``
    진짜 파일 쓰기 → 진짜 inotify 경로. 이 성질("observer 가 parquet 루트에
    실제로 걸려 있고 lifespan 이 그걸 start 한다")은 결정론화할 수 없다 — 무장
    시점이 커널·부하의 함수다. 그래서 ``wallclock`` 마커로 비차단 잡에 보낸다.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from watchdog.events import FileCreatedEvent

import hoga.api.app as app_module
from hoga.api.app import create_app
from hoga.api.events import _InventoryHandler

# 감시가 이미 무장돼 있어도 파일 쓰기가 이벤트로 관측되기까지의 지연은 커널과
# 머신 부하의 함수다. 넉넉하지만 무한은 아니다 — 감시가 아예 무장되지 않는
# 진짜 회귀라면 잡 타임아웃(15분)을 태우는 대신 여기서 분명한 메시지로 죽어야
# 한다. (real-inotify 갈래에서만 쓴다.)
_EVENT_DEADLINE_S = 20.0
# 재작성 간격. inotify 가 늦게 붙어도 그 이후의 쓰기 하나는 반드시 잡힌다.
_REWRITE_INTERVAL_S = 0.1
# 결정론 갈래의 상한. **성공 경로는 이 값과 경주하지 않는다** — 프레임은 수신을
# 걸기 전에 이미 발행돼 있고 스트림이 버퍼링하므로, 남는 일은 루프가 콜백 몇 개를
# 처리하는 것뿐이다(마이크로초). 이 숫자는 "끊겼을 때 15분 잡 타임아웃 대신
# 읽을 수 있는 메시지로 죽는다" 는 실패 검출기이지 타이밍 단언이 아니다.
_RECEIVE_DEADLINE_S = 10.0

_DATE = "20260521"
_CODE = "207940"
_EXPECTED_FRAME = {
    "ch": "event",
    "data": {"type": "inventory_added", "code": _CODE, "date": _DATE},
}


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    d = tmp_path / "data"
    (d / "parquet").mkdir(parents=True)
    return d


def _build_app(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch,
) -> tuple[FastAPI, _InventoryHandler]:
    """create_app + lifespan 이 소유하는 watchdog 핸들러를 함께 돌려준다.

    핸들러는 ``create_app`` 안의 지역 변수라 밖에서 잡을 방법이 없다.
    ``build_event_bus`` 를 감싸는 것이 그 이음매다 — 생성 자체는 진짜를 쓰고
    반환값만 들여다보므로, 테스트가 보는 핸들러는 lifespan 이 ``loop`` 를
    바인딩하고 observer 가 실제로 스케줄한 바로 그 객체다.
    """
    captured: list[_InventoryHandler] = []
    real_build_event_bus = app_module.build_event_bus

    def spy(parquet_root: Path):
        bus, observer, handler = real_build_event_bus(parquet_root)
        captured.append(handler)
        return bus, observer, handler

    monkeypatch.setattr(app_module, "build_event_bus", spy)
    app = create_app(data_dir)
    assert len(captured) == 1, "create_app 이 이벤트 버스를 정확히 한 번 만들어야 한다"
    return app, captured[0]


def test_ws_inventory_added(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """meta.json 감시 이벤트가 WS 의 inventory_added 프레임으로 나간다.

    벽시계 의존이 없다. watchdog 콜백을 감시 스레드 대신 이 스레드에서 직접
    부르는데, 그건 프로덕션과 같은 호출 규약이다 — ``_dispatch`` 는 어차피
    루프 밖 스레드에서 불린다고 가정하고 ``call_soon_threadsafe`` 로 넘긴다.
    커널 inotify 만 빠지고 검증 대상(핸들러 → 버스 → pump → 프레임 봉투)은
    그대로 남는다.

    lifespan 배선도 여기서 함께 걸린다: ``inv_handler.loop`` 가 바인딩되지
    않았다면 ``_dispatch`` 가 조용히 빠져나가 프레임이 영영 오지 않는다.
    """
    app, handler = _build_app(data_dir, monkeypatch)

    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        # 파일을 실제로 만들지 않는다 — classify_inventory_event 는 경로만 보는
        # 순수 함수라 디스크 상태를 읽지 않는다. 만들면 진짜 observer 까지 같이
        # 발화해 이 테스트에 비결정성을 도로 들여올 뿐이다.
        meta = data_dir / "parquet" / _DATE / _CODE / "meta.json"
        # 캡처 워커는 meta.json 을 마지막에 쓴다 — list_stock_dates 가 그 행을
        # 처음 보게 되는 시점이 곧 이 이벤트다.
        #
        # 발행을 **먼저** 하고 수신을 건다. TestClient 의 송신 스트림은 무한
        # 버퍼라 프레임이 먼저 도착해도 유실되지 않는다 — 덕분에 "이미 발행된
        # 것을 꺼내온다" 가 되어 대기가 경주에서 빠진다.
        handler.on_created(FileCreatedEvent(str(meta)))

        # receive_json 에는 timeout 인자가 없다. 메인 스레드가 여기서 블록하면
        # 배선이 끊겼을 때 실패를 보고할 방법이 사라지므로 워커 스레드에 맡긴다.
        pool = ThreadPoolExecutor(max_workers=1)
        try:
            pending = pool.submit(ws.receive_json)
            try:
                frame = pending.result(timeout=_RECEIVE_DEADLINE_S)
            except TimeoutError:
                pytest.fail(
                    "inventory_added 프레임이 오지 않았다 — 감시 콜백은 동기로 불렀으니 "
                    "핸들러→버스→pump→WS 배선 중 하나가 끊겼다"
                    "(lifespan 의 inv_handler.loop 바인딩부터 확인)",
                )
        finally:
            # wait=False: 프레임이 끝내 오지 않았다면 워커는 아직 블록돼 있다.
            # 바깥 with 가 소켓을 닫으면서 풀려나므로 여기서 기다리지 않는다.
            pool.shutdown(wait=False)

        assert frame == _EXPECTED_FRAME


@pytest.mark.wallclock
def test_ws_inventory_added_via_real_inotify(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """진짜 파일 쓰기 → 진짜 inotify → WS 프레임.

    위 테스트가 못 잡는 단 하나를 잡는다: observer 가 parquet 루트에 실제로
    스케줄됐고 lifespan 이 그걸 start 했는가. ``observer.start()`` 를 지워도
    결정론 갈래는 통과하므로 이 갈래가 필요하다.

    무장 시점은 알 수 없다. ``observer.start()`` 는 동기지만 inotify 디스크립터는
    커널 쪽에서 늦게 붙을 수 있고 그 지연은 머신 부하에 따라 달라진다. 원래는
    ``time.sleep(0.2)`` 로 그 지연을 이기려 했는데, 그건 "충분히 빠른 머신에서만
    통과하는 테스트" 라는 뜻이다 — 실제로 GitHub 러너에서 0.2초 가정이 깨졌다
    (PR #938 첫 CI 실행. 같은 커밋이 로컬에서는 20/20 통과).

    고정 대기 대신 재시도를 쓴다. inotify 는 create 뿐 아니라 modify 에도
    발화하므로 재작성이 곧 재시도이고, 감시가 언제 붙든 그 이후의 쓰기가 잡힌다.
    남는 것은 "얼마나 빨리 붙나" 가 아니라 "붙기는 하나" 다. 그래도 상한이
    벽시계인 이상 공유 러너에서 깨질 수 있어 ``wallclock`` 으로 분리한다.
    """
    app, _handler = _build_app(data_dir, monkeypatch)

    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        code_dir = data_dir / "parquet" / _DATE / _CODE
        code_dir.mkdir(parents=True)
        # 디렉터리 생성은 classify 가 None 으로 떨어뜨린다 — 무시된다.
        meta = code_dir / "meta.json"

        # 수신은 별도 스레드에 맡겨 상한을 건다 — receive_json 에는 timeout
        # 인자가 없어서, 메인 스레드가 여기서 블록하면 실패를 시간 안에 보고할
        # 방법이 사라진다.
        pool = ThreadPoolExecutor(max_workers=1)
        try:
            pending = pool.submit(ws.receive_json)
            frame = None
            deadline = time.monotonic() + _EVENT_DEADLINE_S
            while time.monotonic() < deadline:
                meta.write_text("{}", encoding="utf-8")
                try:
                    frame = pending.result(timeout=_REWRITE_INTERVAL_S)
                    break
                except TimeoutError:
                    continue
        finally:
            # wait=False: 이벤트가 끝내 오지 않았다면 워커는 아직 블록돼 있다.
            # 바깥 with 가 소켓을 닫으면서 풀려나므로 여기서 기다리지 않는다.
            pool.shutdown(wait=False)

        assert frame is not None, (
            f"inventory_added 이벤트가 {_EVENT_DEADLINE_S}초 안에 도착하지 않았다 — "
            "watchdog 감시가 아예 무장되지 않았거나 이벤트 버스가 끊겼다"
        )
        # Linux inotify may fire on_created + on_modified for a single write,
        # producing several identical frames.  Assert only the first.
        assert frame == _EXPECTED_FRAME
