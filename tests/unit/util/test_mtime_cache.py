"""MtimeLruCache — (path, mtime, size) 검증 read-through 캐시."""
from __future__ import annotations

import os
from pathlib import Path

from hoga.util.mtime_cache import MtimeLruCache


def _touch(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def test_hit_on_unchanged_file(tmp_path: Path) -> None:
    p = tmp_path / "a.txt"
    _touch(p, "x")
    cache: MtimeLruCache[int] = MtimeLruCache(max_entries=8)
    calls = {"n": 0}

    def load(path: Path) -> int:
        calls["n"] += 1
        return len(path.read_text(encoding="utf-8"))

    assert cache.get_or_load(p, load) == 1
    assert cache.get_or_load(p, load) == 1
    assert calls["n"] == 1, "미변경 파일 2회째는 캐시 히트"


def test_miss_on_mtime_change(tmp_path: Path) -> None:
    p = tmp_path / "a.txt"
    _touch(p, "x")
    cache: MtimeLruCache[str] = MtimeLruCache(max_entries=8)
    calls = {"n": 0}

    def load(path: Path) -> str:
        calls["n"] += 1
        return path.read_text(encoding="utf-8")

    assert cache.get_or_load(p, load) == "x"
    # 내용+mtime 변경 → 재로드. (mtime 해상도 회피 위해 mtime 명시 전진)
    _touch(p, "yy")
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    assert cache.get_or_load(p, load) == "yy"
    assert calls["n"] == 2


def test_missing_file_delegates_without_caching(tmp_path: Path) -> None:
    p = tmp_path / "missing.txt"
    cache: MtimeLruCache[str] = MtimeLruCache(max_entries=8)
    calls = {"n": 0}

    def load(path: Path) -> str:
        calls["n"] += 1
        return "default"

    assert cache.get_or_load(p, load) == "default"
    # 파일이 뒤늦게 생기면 그 결과를 반영해야 한다(부재 상태를 캐시하지 않음).
    _touch(p, "real")
    assert cache.get_or_load(p, lambda path: path.read_text(encoding="utf-8")) == "real"
    assert calls["n"] == 1


def test_lru_eviction(tmp_path: Path) -> None:
    cache: MtimeLruCache[str] = MtimeLruCache(max_entries=2)
    paths = []
    for i in range(3):
        p = tmp_path / f"{i}.txt"
        _touch(p, str(i))
        paths.append(p)
        cache.get_or_load(p, lambda path: path.read_text(encoding="utf-8"))
    # 0 축출됨 — 재로드 카운트로 확인.
    calls = {"n": 0}

    def load(path: Path) -> str:
        calls["n"] += 1
        return path.read_text(encoding="utf-8")

    cache.get_or_load(paths[0], load)  # 축출됐으면 재로드
    cache.get_or_load(paths[2], load)  # 최근이라 히트
    assert calls["n"] == 1
