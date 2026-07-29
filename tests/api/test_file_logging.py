from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pytest

from hoga.api.app import _ensure_file_logging


def _restore(name: str):
    """Snapshot/restore one logger's handlers + level around a test."""
    logger = logging.getLogger(name)
    before = list(logger.handlers)
    before_level = logger.level

    def undo() -> None:
        for h in list(logger.handlers):
            if h not in before:
                logger.removeHandler(h)
                h.close()
        logger.setLevel(before_level)

    return logger, undo


@pytest.fixture
def _clean_hoga_logger():
    """hoga 로거를 원상복구 — 테스트가 붙인 파일 핸들러를 세션에 남기지 않는다.

    uvicorn.error 도 함께 되돌린다: _ensure_file_logging 이 두 네임스페이스에
    핸들러를 붙이므로, hoga 만 정리하면 uvicorn.error 에 tmp_path 를 가리키는
    죽은 핸들러가 세션 내내 남아 이후 테스트가 사라진 디렉터리에 쓰게 된다.
    """
    logger, undo_hoga = _restore("hoga")
    _, undo_uvicorn = _restore("uvicorn.error")
    yield logger
    undo_hoga()
    undo_uvicorn()


def test_ensure_file_logging_attaches_rotating_handler(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _clean_hoga_logger
) -> None:
    monkeypatch.setenv("HOGA_LOG_DIR", str(tmp_path / "logs"))
    _ensure_file_logging()
    logger = _clean_hoga_logger
    handlers = [h for h in logger.handlers if isinstance(h, RotatingFileHandler)]
    assert len(handlers) == 1
    assert handlers[0].baseFilename == str(tmp_path / "logs" / "hoga.log")


def test_ensure_file_logging_is_idempotent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _clean_hoga_logger
) -> None:
    """uvicorn --reload 재-import에도 핸들러가 쌓이지 않는다(같은 파일 1개만)."""
    monkeypatch.setenv("HOGA_LOG_DIR", str(tmp_path / "logs"))
    _ensure_file_logging()
    _ensure_file_logging()
    _ensure_file_logging()
    logger = _clean_hoga_logger
    handlers = [
        h for h in logger.handlers
        if isinstance(h, RotatingFileHandler)
        and h.baseFilename == str(tmp_path / "logs" / "hoga.log")
    ]
    assert len(handlers) == 1


def test_ensure_file_logging_writes_info_records(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _clean_hoga_logger
) -> None:
    monkeypatch.setenv("HOGA_LOG_DIR", str(tmp_path / "logs"))
    _ensure_file_logging()
    logging.getLogger("hoga.live.ws_client").info("live.ws.subscribed tr_key=005930")
    for h in logging.getLogger("hoga").handlers:
        h.flush()
    log_text = (tmp_path / "logs" / "hoga.log").read_text(encoding="utf-8")
    assert "live.ws.subscribed tr_key=005930" in log_text


def test_ensure_file_logging_attaches_to_uvicorn_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _clean_hoga_logger
) -> None:
    """uvicorn.error 에도 같은 파일 싱크가 붙어야 한다.

    uvicorn 은 이 로거를 propagate=False 로 구성하므로 root 로 올라가지 않는다.
    라우트를 빠져나간 예외의 "Exception in ASGI application" 트레이스백이 여기로
    가는데, hoga 네임스페이스에만 핸들러를 붙였던 이전 구현에서는 그 한 줄이
    stderr 에서 끝났다 — 재시작 한 번이면 영구 소실.
    """
    monkeypatch.setenv("HOGA_LOG_DIR", str(tmp_path / "logs"))
    _ensure_file_logging()
    target = str(tmp_path / "logs" / "hoga.log")
    handlers = [
        h for h in logging.getLogger("uvicorn.error").handlers
        if isinstance(h, RotatingFileHandler) and h.baseFilename == target
    ]
    assert len(handlers) == 1


def test_uvicorn_error_traceback_reaches_the_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _clean_hoga_logger
) -> None:
    """uvicorn 이 찍는 형태 그대로 — exc_info 포함 — 파일에 남는지 확인."""
    monkeypatch.setenv("HOGA_LOG_DIR", str(tmp_path / "logs"))
    _ensure_file_logging()
    try:
        raise RuntimeError("kaboom-from-asgi")
    except RuntimeError:
        logging.getLogger("uvicorn.error").exception("Exception in ASGI application")
    for h in logging.getLogger("uvicorn.error").handlers:
        h.flush()
    log_text = (tmp_path / "logs" / "hoga.log").read_text(encoding="utf-8")
    assert "Exception in ASGI application" in log_text
    assert "kaboom-from-asgi" in log_text
    assert "Traceback (most recent call last)" in log_text


def test_ensure_file_logging_idempotent_across_both_namespaces(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _clean_hoga_logger
) -> None:
    monkeypatch.setenv("HOGA_LOG_DIR", str(tmp_path / "logs"))
    _ensure_file_logging()
    _ensure_file_logging()
    _ensure_file_logging()
    target = str(tmp_path / "logs" / "hoga.log")
    for name in ("hoga", "uvicorn.error"):
        handlers = [
            h for h in logging.getLogger(name).handlers
            if isinstance(h, RotatingFileHandler) and h.baseFilename == target
        ]
        assert len(handlers) == 1, name
