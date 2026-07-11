"""파일 mtime/size 로 검증하는 프로세스-메모리 LRU (읽기 전용 소비자용).

디스크에 이미 영속된 아티팩트(parquet·JSON)를 요청마다 재파싱하는 read-through
경로에서, 파일이 안 바뀐 동안(과거일 = 불변)은 파싱 결과를 재사용한다. atomic write
로 파일이 교체되면 mtime/size 가 바뀌어 자연 무효화되므로 today/TTL 층이 필요 없다
(snapshots._query_at_cache 와 동일 관측 규약).

주의: 캐시 값은 참조 공유된다 — 읽기 전용 소비자만 쓸 것. 쓰기 경로(read-modify-write)는
반드시 캐시를 우회한 fresh load 를 써야 한다(mtime 검증이 stale write 를 막지 못한다).
"""
from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from threading import Lock
from typing import Generic, TypeVar

_T = TypeVar("_T")


class MtimeLruCache(Generic[_T]):
    def __init__(self, max_entries: int) -> None:
        self._max = max(0, int(max_entries))
        # key(str path) -> (mtime_ns, size, value)
        self._entries: OrderedDict[str, tuple[int, int, _T]] = OrderedDict()
        self._lock = Lock()

    def get_or_load(self, path: Path, load: Callable[[Path], _T]) -> _T:
        """path 가 (mtime_ns, size) 로 미변경이면 캐시 값을, 아니면 load(path) 를 실행해
        캐시 후 반환한다. path 부재(stat 실패)는 캐시하지 않고 load 에 위임한다 —
        TTL 창 안에 파일이 생겨도 stale 결과가 가리지 않도록."""
        key = str(path)
        try:
            stat = path.stat()
        except OSError:
            return load(path)  # 부재/접근불가 — 캐시 미개입(파일이 뒤늦게 생길 수 있음)
        with self._lock:
            cached = self._entries.get(key)
            if cached is not None and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
                self._entries.move_to_end(key)
                return cached[2]
        value = load(path)
        if self._max == 0:
            return value
        with self._lock:
            self._entries[key] = (stat.st_mtime_ns, stat.st_size, value)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max:
                self._entries.popitem(last=False)
        return value

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
