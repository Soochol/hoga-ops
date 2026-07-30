"""원자적 쓰기 헬퍼 4종(json · pyarrow Table · polars DataFrame · records).

패턴은 전부 동일하다: 대상 디렉터리에 tempfile → flush+fsync → ``os.replace``.
로컬 디스크가 이 앱의 유일한 DB 이므로, 부분 기록된 파일이 독자에게 보이는 순간이
없어야 한다. 특히 ``meta.json`` 은 캡처 완료 신호(inotify 트리거)라서 반쪽 쓰기가
곧 잘못된 완료 이벤트다.

**위치**: ``hoga/util/`` 이다(2026-07-30 이전에는 ``hoga/api/_atomic_write``). HTTP 와
무관한 순수 유틸인데 ``api`` 패키지에 살아서 ``live``·``tables``·``collector``·
``parser`` 가 모두 ``api`` 를 역방향 import 해야 했고, 그 역방향 엣지를 끊으려고
호출부마다 함수 안 지연 import(``noqa: PLC0415``)를 깔아야 했다. 위치를 옮기니
그 우회로가 전부 필요 없어졌다.

pyarrow·polars 는 함수 안에서 늦게 import 한다(heavy) — 이 모듈을 최상위에서
import 해도 비용이 없으니 호출부는 지연 import 할 이유가 없다.

ADR-0015 footer + ADR-0019.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_json(path: Path, payload: Any, *, indent: int = 2) -> None:
    """Write ``payload`` as JSON to ``path`` atomically.

    Pattern: tempfile in target's parent dir → flush + fsync → os.replace.
    The parent dir is created if missing. Korean text is preserved
    (ensure_ascii=False).

    Raises:
        OSError: if disk write fails. Callers decide whether to propagate.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=indent)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


def atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    """``text`` 를 ``path`` 에 원자적으로 쓴다 — ``Path.write_text`` 의 안전한 대체.

    ``write_text`` 는 대상 파일을 먼저 truncate 하고 쓰므로, 디스크가 꽉 차거나
    프로세스가 죽으면 **잘린 파일이 그 자리에 남는다.** 캡처 raw(page_*.tsv ·
    info.tsv · chart.tsv)는 재파싱의 유일한 소스이고(ADR-0019), ``_progress.json`` 은
    resume 커서다 — 둘 다 반쪽이 되면 조용히 잘못된 결과를 만든다.

    Raises:
        OSError: 쓰기 실패 시. 실패하면 대상은 **이전 상태 그대로**다.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding=encoding,
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp.write(text)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


def atomic_write_parquet_table(path: Path, table: Any) -> None:
    """Write a pyarrow ``Table`` to ``path`` atomically (tempfile + os.replace).

    Schema-strict counterpart of :func:`atomic_write_parquet` — caller has
    already constructed a ``pa.Table`` with the canonical ``PARQUET_SCHEMA``,
    so this just owns the durability/atomicity. Use from
    ``hoga.tables.*.write_parquet`` so today_promoter's overwrite during a
    polling cycle never leaves a partial file visible to readers.

    The parent dir is created if missing.

    Raises:
        OSError: if disk write fails. On failure the target is unchanged
            (the tempfile may linger; callers can ignore).
    """
    import pyarrow.parquet as pq  # local import — heavy  # noqa: PLC0415 — 지연 import(순환/heavy)

    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp_path = Path(tmp.name)
    try:
        pq.write_table(table, tmp_path)
        os.replace(tmp_path, path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def atomic_write_parquet_df(path: Path, df: Any, *, compression: str = "zstd") -> None:
    """Write a polars ``DataFrame`` to ``path`` atomically (tempfile → os.replace).

    The polars-DataFrame counterpart of :func:`atomic_write_parquet_table`,
    preserving the screener archive's ``zstd`` compression. Used by the screener
    store so an interrupted EOD write never leaves a partial
    ``daily_unadjusted``/``daily_adjusted`` parquet visible to readers (the
    archive is the no-backup SSOT). ``df`` is typed ``Any`` to keep polars a
    local/heavy import elsewhere.

    The parent dir is created if missing.

    Raises:
        OSError: if disk write fails. On failure the target is unchanged
            (the tempfile is removed).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp_path = Path(tmp.name)
    try:
        df.write_parquet(tmp_path, compression=compression)
        os.replace(tmp_path, path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def atomic_write_parquet(path: Path, records: list[dict[str, Any]]) -> None:
    """Write ``records`` as Parquet to ``path`` atomically.

    Empty ``records`` → unlink existing file. polars handles empty
    DataFrame poorly, and downstream DuckDB read_parquet errors on
    zero-row files in some configurations — so we represent "no data"
    as "no file" (callers must handle FileNotFoundError on the read
    side, which the standard try/except FileNotFoundError pattern does).

    Pattern: tempfile in target's parent dir → polars write → os.replace.
    The parent dir is created if missing.

    Raises:
        OSError: if disk write fails. On failure the target is unchanged
            (the tempfile may linger; callers can ignore).
    """
    import polars as pl  # local import — heavy module  # noqa: PLC0415 — 지연 import(순환/heavy)

    path.parent.mkdir(parents=True, exist_ok=True)

    if not records:
        path.unlink(missing_ok=True)
        return

    with tempfile.NamedTemporaryFile(
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp_path = Path(tmp.name)
    try:
        pl.DataFrame(records).write_parquet(tmp_path)
        os.replace(tmp_path, path)
    except Exception:
        # write_parquet raised — tempfile is partial/empty; clean up.
        tmp_path.unlink(missing_ok=True)
        raise
