"""Tests for the shared atomic write helpers extracted per ADR-0015 + ADR-0019."""
from __future__ import annotations

import ast
import json
import os
from pathlib import Path

import pytest

from hoga.util.atomic_write import atomic_write_json, atomic_write_text


def test_writes_json_to_path(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    atomic_write_json(target, {"hello": "world"})
    assert json.loads(target.read_text(encoding="utf-8")) == {"hello": "world"}


def test_creates_parent_dir(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "deep" / "out.json"
    atomic_write_json(target, [1, 2, 3])
    assert target.exists()
    assert json.loads(target.read_text(encoding="utf-8")) == [1, 2, 3]


def test_overwrites_existing_atomically(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    target.write_text('{"old": true}', encoding="utf-8")
    atomic_write_json(target, {"new": True})
    assert json.loads(target.read_text(encoding="utf-8")) == {"new": True}


def test_no_tmp_files_left_on_success(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    atomic_write_json(target, {"a": 1})
    leftovers = [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_korean_utf8_preserved(tmp_path: Path) -> None:
    """Ensure ensure_ascii=False behavior carries over (symbols.py relies on it)."""
    target = tmp_path / "out.json"
    atomic_write_json(target, {"name": "삼성전자"})
    raw = target.read_text(encoding="utf-8")
    assert "삼성전자" in raw  # not escaped as \uXXXX


# ── atomic_write_text (raw TSV · resume 커서) ────────────────────────────────

def test_text_writes_and_creates_parent_dir(tmp_path: Path) -> None:
    target = tmp_path / "raw" / "page_001.tsv"
    atomic_write_text(target, "1\t2\t3\n")
    assert target.read_text(encoding="utf-8") == "1\t2\t3\n"


def test_text_leaves_target_untouched_when_replace_fails(
    tmp_path: Path, monkeypatch,
) -> None:
    """쓰기가 실패하면 이전 내용이 **온전히** 남아야 한다.

    ``Path.write_text`` 는 대상을 먼저 truncate 하므로 같은 실패에서 잘린 파일을
    남긴다 — raw TSV 는 재파싱의 유일한 소스(ADR-0019)라 그게 조용한 데이터 손실이다.
    tempfile 은 이미 다 쓰인 뒤 마지막 ``os.replace`` 에서 실패시켜, "새 내용이
    반영되지 않았다" 가 아니라 "옛 내용이 손상되지 않았다" 를 확인한다.
    """
    target = tmp_path / "chart.tsv"
    atomic_write_text(target, "원본")

    def boom(*_args: object, **_kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        atomic_write_text(target, "새 내용")

    assert target.read_text(encoding="utf-8") == "원본"


def test_text_no_tmp_files_left_on_success(tmp_path: Path) -> None:
    atomic_write_text(tmp_path / "info.tsv", "body")
    assert [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []


# ── 캡처 핫패스가 원자 쓰기를 쓰는지 (회귀 가드) ──────────────────────────────

_HOT_PATHS = (
    "hoga/parser/__init__.py",        # meta.json — 분류 SSOT + 완료 신호
    "hoga/collector/orchestrator.py",  # _progress.json(resume 커서) + raw TSV 3종
)


def test_capture_hot_paths_never_call_path_write_text() -> None:
    """캡처 핫패스에 ``Path.write_text`` 가 다시 들어오는 것을 막는다.

    ``write_text`` 는 대상을 먼저 truncate 하므로 디스크가 꽉 차면 잘린 파일이 남는다.
    ``meta.json`` 은 inotify watchdog 의 완료 트리거라(hoga/api/events.py) 반쪽 쓰기가
    곧 잘못된 ``inventory_added`` 이벤트이고, ``_progress.json`` 은 resume 커서다.
    AST 로 검사해 주석·문자열의 우연한 일치를 배제한다.
    """
    offenders: list[str] = []
    for rel in _HOT_PATHS:
        tree = ast.parse(Path(rel).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "write_text"
            ):
                offenders.append(f"{rel}:{node.lineno}")
    assert offenders == [], (
        "캡처 핫패스는 hoga.util.atomic_write 를 써야 한다: " + ", ".join(offenders)
    )
