from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pytest

from hoga.api.app import _ensure_file_logging


@pytest.fixture
def _clean_hoga_logger():
    """hoga 로거를 원상복구 — 테스트가 붙인 파일 핸들러를 세션에 남기지 않는다."""
    logger = logging.getLogger("hoga")
    before = list(logger.handlers)
    before_level = logger.level
    yield logger
    for h in list(logger.handlers):
        if h not in before:
            logger.removeHandler(h)
            h.close()
    logger.setLevel(before_level)


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
