"""WebSocket port of the /api/events SSE e2e inventory test.

Previously, ``test_api_sse.py::test_sse_inventory_added`` spun up a real
uvicorn server because ``httpx.ASGITransport`` buffers SSE bodies.  WebSocket
has no such limitation, so we use Starlette's ``TestClient`` instead.

``TestClient.__enter__`` runs the full FastAPI lifespan, which:
 - starts the watchdog observer (``observer.start()``)
 - binds ``inv_handler.loop`` to the running asyncio event loop

so by the time ``websocket_connect`` returns the bus subscription is live and
the observer is already watching the parquet directory.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from hoga.api.app import create_app

# 이벤트를 기다리는 상한. 넉넉하지만 무한은 아니다 — 감시가 아예 무장되지
# 않는 진짜 회귀라면 잡 타임아웃(15분)을 태우는 대신 여기서 분명한 메시지로
# 죽어야 한다.
_EVENT_DEADLINE_S = 20.0
# 재작성 간격. inotify 가 늦게 붙어도 그 이후의 쓰기 하나는 반드시 잡힌다.
_REWRITE_INTERVAL_S = 0.1


def test_ws_inventory_added(tmp_path: Path) -> None:
    """inventory_added event is delivered over WS when meta.json appears."""
    data_dir = tmp_path / "data"
    (data_dir / "parquet").mkdir(parents=True)
    app = create_app(data_dir)

    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        code_dir = data_dir / "parquet" / "20260521" / "207940"
        code_dir.mkdir(parents=True)
        # Per _InventoryHandler: inventory_added fires when meta.json appears
        # (the capture worker writes meta.json last, so that is when
        # list_stock_dates first sees the row).  Dir creation classifies to
        # None and is ignored.
        meta = code_dir / "meta.json"

        # 감시가 실제로 무장되는 시점은 알 수 없다. observer.start() 는 동기지만
        # inotify 디스크립터는 커널 쪽에서 늦게 붙을 수 있고 그 지연은 머신 부하에
        # 따라 달라진다. 이 테스트는 원래 `time.sleep(0.2)` 로 그 지연을 이기려
        # 했는데, 그건 "충분히 빠른 머신에서만 통과하는 테스트" 라는 뜻이다.
        # 실제로 GitHub 러너에서 0.2초 가정이 깨져 write 이벤트를 놓쳤고,
        # receive_json 이 영원히 블록하다 portal 취소로 CancelledError 가 났다
        # (PR #938 첫 CI 실행. 같은 커밋이 로컬에서는 20/20 통과).
        #
        # 고정 대기를 재시도로 바꾼다. inotify 는 create 뿐 아니라 modify 에도
        # 발화하므로 재작성이 곧 재시도이고, 감시가 언제 붙든 그 이후의 쓰기가
        # 잡힌다. 남는 것은 "얼마나 빨리 붙나" 가 아니라 "붙기는 하나" 다.
        #
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
        assert frame == {
            "ch": "event",
            "data": {"type": "inventory_added", "code": "207940", "date": "20260521"},
        }
