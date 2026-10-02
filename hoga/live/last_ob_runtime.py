"""Serialized last-orderbook file writer, usable without loading API lifecycle."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from pathlib import Path

from . import last_ob_store

_log = logging.getLogger(__name__)

def start_flusher(
    data_dir: Path, *, buffer_fn: Callable, enabled_fn: Callable = lambda: True,
    interval_s: float = 60.0, error_fn: Callable = lambda failed: None,
) -> asyncio.Task:
    """`LiveBuffer._last_ob` 를 디스크에 내리는 태스크 — **벤더를 치지 않는다.**

    ## 왜 필요한가

    마지막 호가는 프로세스 메모리에만 있어서 재시작에 **전 종목이 함께 죽는다**
    (2026-08-27 실측: 장 마감 후 기동한 백엔드에서 005930 포함 전 종목 0 건, 10호가
    창이 통째로 빔). 장이 끝난 뒤라 다시 채울 소스도 없다. 이 루프가 그 구멍만 닫는다.

    수집 경로를 새로 만들지 않는 것이 요점이다 — WS 는 이미 흐르고 `_last_ob` 는 이미
    갱신된다(`LiveBuffer.publish`). 여기는 **디스크 왕복만** 한다.

    ## 바뀐 게 없으면 쓰지 않는다

    `changed_last_ob_snapshot()` 이 잠금 안에서 먼저 버전을 비교하므로 변경 없는
    주기는 dict/list 복원도 생략한다. 그래서:

        09:00–15:30  0D 흐름 → 버전 증가 → 매 주기 flush
        15:30 (KRX)  0D 끊김 → 버전 고정 → **쓰기 0**, 파일엔 15:30 값이 남는다
        20:00 (NXT)  같은 방식

    즉 **"지금이 마감이니 저장하자" 는 시계 판정이 어디에도 없다.** 벤더가 멈추는 것이
    곧 마지막이고, 세션 경계 시각(KRX 15:30 · NXT 20:00)을 코드가 알 필요가 없다.

    instance epoch와 버전을 함께 비교한다. 새 버퍼에서 숫자가 같아도 변경을 놓치지
    않으며, 종목 삭제도 버전을 올린다. 전체 파일 저장은 단일 thread 작업으로
    직렬 실행하고 종료 시 진행 중 저장을 기다린다. GC는 여전히 같은 인터프리터다.

    ## 실패는 다음 주기가 재시도한다

    쓰기가 실패하면 `last_version` 을 갱신하지 않으므로 같은 버전이 그대로 남아 다음
    주기에 다시 시도된다. 불리언 dirty 를 읽는 쪽에서 clear 하는 방식이었다면 그
    실패분이 영영 저장되지 않았을 것이다(`_last_ob_version` 선언부 주석).
    """
    last_version: tuple[object, int] | None = None

    async def loop() -> None:
        nonlocal last_version
        while True:
            try:
                # **매 주기 버퍼를 다시 읽는다** — 인스턴스를 캡처해 두면 교체된 뒤
                # 죽은 객체를 붙들고 있게 된다(`get_capture_worker_tasks` 와 같은 규율).
                snapshot = (await buffer_fn().changed_last_ob_snapshot(last_version)) if enabled_fn() else None
                if snapshot is not None:
                    entries, version = snapshot
                    # Serialize writes. Cancellation waits for the in-flight
                    # atomic save, preventing an old writer from racing restart.
                    kwargs = {"allow_empty": True} if not entries and version[1] > 0 else {}
                    save_task = asyncio.create_task(asyncio.to_thread(
                        last_ob_store.save, data_dir, entries, **kwargs,
                    ))
                    try:
                        await asyncio.shield(save_task)
                    except asyncio.CancelledError:
                        try:
                            await save_task
                        except Exception:  # noqa: BLE001 — log save failure, preserve shutdown cancellation
                            _log.exception("live.last_ob.shutdown_save_failed")
                        raise
                    last_version = version
                    error_fn(False)
            except Exception:  # noqa: BLE001 — flush 실패가 수집을 멈추면 안 된다
                error_fn(True)
                _log.exception("live.last_ob.flush_failed")
            await asyncio.sleep(interval_s)

    return asyncio.create_task(loop(), name="last-ob-flusher")
